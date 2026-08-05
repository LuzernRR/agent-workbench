import { NextResponse } from "next/server";
import type { ReasoningEffort } from "@/lib/agent-events/types";
import { loadRuntimeConfig, publicModelDefinitions } from "@/server/config/runtime-config";
import { ImageInputError } from "@/server/media/image-input";
import {
  cancelXiaohongshuVerification,
  requestXiaohongshuVerificationQrcode,
  requestXiaohongshuVerificationStatus,
  SearchAgentVerificationError
} from "@/server/search-agent/client";
import { resolveVisitor, VisitorSessionError } from "@/server/session/visitor";
import { startLiveRun, stopLiveRun } from "./engine";
import {
  activeEventsForRun,
  createLiveProject,
  createLiveThread,
  deleteLiveProject,
  deleteLiveThread,
  getLiveSnapshot,
  listLiveProjects,
  listLiveThreads,
  liveAttachment,
  liveRun,
  reorderLiveProjects,
  updateLiveProject,
  updateLiveThread,
  uploadLiveAttachments
} from "./store";

const LIVE_AGENTS = [{ id: "search-agent", name: "搜索研究", description: "通过多 Agent 规划、搜索、反思与核验回答问题。", toolIds: ["web_search"] }];
const LIVE_TOOLS = [{ id: "web_search", name: "网页搜索", description: "搜索公开网页并读取候选来源。", group: "搜索", requiresApproval: false }];
const json = (data: unknown, status = 200) => NextResponse.json(data, { status });
const fail = (message: string, status: number, code = "WORKBENCH_ERROR") => json({ success: false, code, message }, status);

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    const text = await request.text();
    return text ? JSON.parse(text) as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function liveEventStream(request: Request, visitorId: string, runId: string, after: number) {
  const record = await liveRun(visitorId, runId);
  if (!record) return fail("运行不存在", 404);
  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let catchupTimer: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let lastSeq = after;
      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        if (catchupTimer) clearInterval(catchupTimer);
      };
      const close = () => {
        cleanup();
        try { controller.close(); } catch { /* Client already disconnected. */ }
      };
      const send = (event: Awaited<ReturnType<typeof activeEventsForRun>>[number]) => {
        if (closed || event.seq <= lastSeq) return false;
        lastSeq = event.seq;
        try {
          controller.enqueue(encoder.encode(`event: ${event.type}\nid: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`));
        } catch {
          cleanup();
        }
        return ["run.completed", "run.failed", "run.cancelled"].includes(event.type);
      };
      let catchingUp = false;
      const catchup = async () => {
        if (closed || catchingUp) return;
        catchingUp = true;
        try {
          // Read status before events. A terminal transition commits its event
          // in the same transaction, so either this pass sees both or the next
          // pass observes them; it can never close between the two writes.
          const latest = await liveRun(visitorId, runId);
          const events = await activeEventsForRun(visitorId, runId, lastSeq);
          for (const event of events) if (send(event)) return close();
          if (!latest || ["completed", "failed", "stopped"].includes(latest.status)) close();
        } catch {
          // A transient database read failure should let EventSource reconnect
          // from its persisted cursor instead of terminating the server run.
          close();
        } finally {
          catchingUp = false;
        }
      };
      await catchup();
      if (closed) return;
      // SSE is deliberately backed only by the durable event ledger. It can
      // reconnect to any Web instance without sharing Worker process memory.
      catchupTimer = setInterval(() => { void catchup(); }, 1_000);
      heartbeat = setInterval(() => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(": keep-alive\n\n")); } catch { cleanup(); }
      }, 15_000);
      request.signal.addEventListener("abort", cleanup, { once: true });
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
      if (catchupTimer) clearInterval(catchupTimer);
    }
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" } });
}

export async function handleLive(request: Request, rawPath: string): Promise<Response> {
  try {
    const visitor = await resolveVisitor(request);
    const [path, search] = rawPath.split("?");
    const method = request.method.toUpperCase();
    const segments = path.replace(/^\/api\/v1\/?/u, "").split("/").filter(Boolean);

    if (segments.length === 1 && method === "GET") {
      if (segments[0] === "agents") return json(LIVE_AGENTS);
      if (segments[0] === "models") return json(publicModelDefinitions(await loadRuntimeConfig()));
      if (segments[0] === "tools") return json(LIVE_TOOLS);
      if (segments[0] === "projects") return json(await listLiveProjects(visitor.id));
      if (segments[0] === "threads") return json(await listLiveThreads(visitor.id));
    }

    if (segments[0] === "projects") {
      if (segments.length === 1 && method === "POST") {
        const payload = await body(request);
        const name = String(payload.name || "").trim();
        if (!name) return fail("项目名称不能为空", 400);
        return json(await createLiveProject(visitor.id, name));
      }
      if (segments.length === 2 && segments[1] === "reorder" && method === "PATCH") {
        const payload = await body(request);
        const projectIds = Array.isArray(payload.projectIds) ? payload.projectIds.map(String) : [];
        return await reorderLiveProjects(visitor.id, projectIds) ? json({ status: "reordered" }) : fail("项目顺序无效", 400);
      }
      const projectId = segments[1];
      if (segments.length === 2 && projectId) {
        if (method === "PATCH") {
          const payload = await body(request);
          const project = await updateLiveProject(visitor.id, projectId, {
            name: typeof payload.name === "string" && payload.name.trim() ? payload.name.trim() : undefined,
            path: typeof payload.path === "string" ? payload.path : undefined
          });
          return project ? json(project) : fail("项目不存在", 404);
        }
        if (method === "DELETE") return await deleteLiveProject(visitor.id, projectId) ? json({ status: "deleted" }) : fail("项目不存在", 404);
      }
      if (segments.length === 3 && segments[2] === "threads" && projectId) {
        if (method === "GET") return json(await listLiveThreads(visitor.id, projectId));
        if (method === "POST") {
          const payload = await body(request);
          const thread = await createLiveThread(visitor.id, projectId, typeof payload.title === "string" ? payload.title : undefined);
          return thread ? json(thread) : fail("项目不存在", 404);
        }
      }
    }

    if (segments[0] === "threads") {
      if (segments.length === 1 && method === "POST") {
        const payload = await body(request);
        const projectId = payload.projectId === null || payload.projectId === undefined ? null : String(payload.projectId);
        const thread = await createLiveThread(visitor.id, projectId, typeof payload.title === "string" ? payload.title : undefined);
        return thread ? json(thread) : fail("项目不存在", 404);
      }
      const threadId = segments[1];
      if (segments.length === 2 && threadId) {
        if (method === "GET") {
          const snapshot = await getLiveSnapshot(visitor.id, threadId);
          return snapshot ? json(snapshot) : fail("会话不存在", 404);
        }
        if (method === "PATCH") {
          const payload = await body(request);
          const patch: { title?: string; projectId?: string | null } = {};
          if (typeof payload.title === "string" && payload.title.trim()) patch.title = payload.title.trim();
          if ("projectId" in payload) patch.projectId = payload.projectId === null ? null : String(payload.projectId);
          const thread = await updateLiveThread(visitor.id, threadId, patch);
          return thread ? json(thread) : fail("会话或目标项目不存在", 404);
        }
        if (method === "DELETE") return await deleteLiveThread(visitor.id, threadId) ? json({ status: "deleted" }) : fail("会话不存在", 404);
      }
      if (segments.length === 3 && threadId) {
        if (segments[2] === "runs" && method === "POST") {
          const payload = await body(request);
          const message = String(payload.message || "").trim();
          if (!message) return fail("消息不能为空", 400);
          const reasoningEffort = ["medium", "high", "xhigh", "max"].includes(String(payload.reasoningEffort)) ? String(payload.reasoningEffort) as ReasoningEffort : "medium";
          const started = await startLiveRun({
            visitorId: visitor.id,
            threadId,
            message,
            modelId: typeof payload.modelId === "string" ? payload.modelId : "",
            reasoningEffort,
            attachmentIds: Array.isArray(payload.attachmentIds) ? payload.attachmentIds.map(String) : [],
            replaceMessageId: typeof payload.replaceMessageId === "string" ? payload.replaceMessageId : null
          });
          return started ? json(started) : fail("会话正在运行或编辑目标不存在", 409);
        }
        if (segments[2] === "attachments" && method === "POST") {
          const form = await request.formData();
          const files = form.getAll("files").filter((entry): entry is File => entry instanceof File && entry.size > 0 && entry.size <= 20 * 1024 * 1024);
          const uploaded = await uploadLiveAttachments(visitor.id, threadId, files);
          return uploaded ? json(uploaded) : fail("会话不存在", 404);
        }
      }
    }

    if (segments[0] === "runs" && segments[1]) {
      if (segments[2] === "xiaohongshu-verifications" && segments[3]) {
        const runId = segments[1];
        const challengeId = segments[3];
        const owned = await liveRun(visitor.id, runId);
        if (!owned || owned.run.agentId !== "search-agent") return fail("验证会话不存在", 404, "VERIFICATION_NOT_FOUND");
        try {
          if (segments.length === 4 && method === "GET") {
            return json(await requestXiaohongshuVerificationStatus(runId, challengeId));
          }
          if (segments.length === 5 && segments[4] === "qrcode" && method === "GET") {
            const image = await requestXiaohongshuVerificationQrcode(runId, challengeId);
            return new Response(image, {
              headers: {
                "content-type": "image/png",
                "cache-control": "no-store",
                "content-disposition": "inline",
                "x-content-type-options": "nosniff"
              }
            });
          }
          if (segments.length === 4 && method === "DELETE") {
            await cancelXiaohongshuVerification(runId, challengeId);
            return json({ version: 1, runId, challengeId, status: "cancelled" });
          }
        } catch (error) {
          if (error instanceof SearchAgentVerificationError) {
            return fail(error.message, error.status, error.code);
          }
          throw error;
        }
      }
      if (segments[2] === "events" && method === "GET") {
        const queryAfter = Number(new URLSearchParams(search || "").get("after") || 0);
        const headerAfter = Number(request.headers.get("last-event-id") || 0);
        const after = Math.max(Number.isFinite(queryAfter) ? queryAfter : 0, Number.isFinite(headerAfter) ? headerAfter : 0);
        return liveEventStream(request, visitor.id, segments[1], after);
      }
      if (segments[2] === "stop" && method === "POST") {
        const status = await stopLiveRun(visitor.id, segments[1]);
        return status ? json({ status }) : fail("运行不存在", 404);
      }
    }

    if (segments[0] === "attachments" && segments[1] && method === "GET") {
      const attachment = await liveAttachment(visitor.id, segments[1]);
      if (!attachment) return fail("附件不存在", 404);
      return new Response(attachment.bytes, { headers: { "content-type": attachment.mime_type, "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(attachment.name)}`, "cache-control": "private, max-age=31536000, immutable" } });
    }

    return fail(`未实现的接口 ${method} ${path}`, 404, "NOT_IMPLEMENTED");
  } catch (error) {
    if (error instanceof VisitorSessionError) return fail(error.message, 401, "VISITOR_SESSION_INVALID");
    if (error instanceof ImageInputError) return fail(error.message, 400, error.code);
    console.error("Live workbench request failed", error instanceof Error ? error.message : error);
    return fail("真实工作台服务暂不可用", 503, "LIVE_SERVICE_UNAVAILABLE");
  }
}
