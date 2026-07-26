import { NextResponse } from "next/server";
import { reduceAgentEvents } from "@/lib/agent-events/reducer";
import { createEmptyThreadState } from "@/lib/agent-events/reducer";
import type { AgentThreadState, ReasoningEffort, ThreadSnapshot } from "@/lib/agent-events/types";
import { AGENTS, MOCK_MODELS, TOOLS } from "./catalog";
import { resolveApproval, startRun, stopRun } from "./engine";
import { db, listProjects, listThreads, newId, touchThread, type MockAttachment, type MockThread } from "./store";
import { loadRuntimeConfig, publicModelDefinitions } from "@/server/config/runtime-config";

const json = (data: unknown, status = 200) => NextResponse.json(data, { status });
const fail = (message: string, status: number, code = "MOCK_ERROR") => json({ success: false, code, message }, status);

/** 回放该会话所有运行的事件，得到与前端 reducer 一致的读模型。 */
function threadState(thread: MockThread): AgentThreadState {
  const runs = thread.runIds.map((runId) => db().runs.get(runId)).filter((run): run is NonNullable<typeof run> => Boolean(run));
  const events = runs.flatMap((run) => run.events).sort((left, right) => left.seq - right.seq);
  const base = createEmptyThreadState(thread.projectId, thread.id);
  const state = reduceAgentEvents(base, events);
  const active = runs.find((run) => run.status === "running" || run.status === "waiting");
  return {
    ...state,
    activeRunId: active?.id ?? null,
    runStatus: active ? (active.status === "waiting" ? "waiting" : "running") : state.runStatus === "running" ? "completed" : state.runStatus
  };
}

function snapshot(thread: MockThread): ThreadSnapshot {
  const project = thread.projectId ? listProjects().find((item) => item.id === thread.projectId) ?? null : null;
  return {
    project,
    thread: {
      id: thread.id,
      projectId: thread.projectId,
      title: thread.title,
      updatedAt: thread.updatedAt,
      lastUserMessageAt: thread.lastUserMessageAt,
      status: thread.status
    },
    state: threadState(thread),
    context: project?.context
  };
}

function createThread(projectId: string | null, title?: string): MockThread {
  const now = new Date().toISOString();
  const thread: MockThread = {
    id: newId("thread"),
    projectId,
    title: title?.trim() || "新的研究任务",
    createdAt: now,
    updatedAt: now,
    status: "idle",
    runIds: [],
    attachments: new Map()
  };
  db().threads.set(thread.id, thread);
  return thread;
}

function threadSummary(thread: MockThread) {
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    updatedAt: thread.updatedAt,
    lastUserMessageAt: thread.lastUserMessageAt,
    status: thread.status
  };
}

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    const text = await request.text();
    return text ? JSON.parse(text) as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** SSE：先补发 after 之后的历史事件，再订阅后续事件。 */
function eventStream(runId: string, after: number): Response {
  const run = db().runs.get(runId);
  if (!run) return fail("run not found", 404);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (event: { type: string; seq: number }) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event.type}\nid: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      };

      for (const event of run.events) if (event.seq > after) send(event);

      const terminal = ["completed", "failed", "stopped"];
      if (terminal.includes(run.status)) {
        controller.close();
        return;
      }

      const subscriber = (event: Parameters<typeof send>[0]) => {
        send(event);
        if (["run.completed", "run.failed", "run.cancelled"].includes(event.type)) {
          run.subscribers.delete(subscriber);
          closed = true;
          try {
            controller.close();
          } catch {
            // 客户端可能已断开。
          }
        }
      };
      run.subscribers.add(subscriber);

      // 心跳保持连接，避免代理层因空闲断流。
      const heartbeat = setInterval(() => {
        if (closed) return clearInterval(heartbeat);
        try {
          controller.enqueue(encoder.encode(": keep-alive\n\n"));
        } catch {
          clearInterval(heartbeat);
        }
      }, 15000);
    },
    cancel() {
      run.subscribers.clear();
    }
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    }
  });
}

/**
 * 按 path + method 分发到内存实现。
 * 与真实后端契约一致，因此接上真实后端时前端无需改动。
 */
export async function handleMock(request: Request, rawPath: string): Promise<Response> {
  const [path, search] = rawPath.split("?");
  const method = request.method.toUpperCase();
  const segments = path.replace(/^\/api\/v1\/?/, "").split("/").filter(Boolean);
  const database = db();

  // /agents /models /tools
  if (segments.length === 1 && method === "GET") {
    if (segments[0] === "agents") return json(AGENTS);
    if (segments[0] === "models") {
      if (process.env.WORKBENCH_LLM_MODE === "mock") return json(MOCK_MODELS);
      try {
        return json(publicModelDefinitions(await loadRuntimeConfig()));
      } catch {
        return fail("模型配置不可用", 500, "CONFIG_ERROR");
      }
    }
    if (segments[0] === "tools") return json(TOOLS);
    if (segments[0] === "projects") return json(listProjects());
    if (segments[0] === "threads") return json(listThreads());
  }

  if (segments[0] === "projects") {
    if (segments.length === 1 && method === "POST") {
      const payload = await body(request);
      const name = String(payload.name || "").trim();
      if (!name) return fail("项目名称不能为空", 400);
      const sortOrder = Math.max(-1, ...[...database.projects.values()].map((project) => project.sortOrder)) + 1;
      const project = { id: newId("proj"), name, path: String(payload.path || "") || `E:/workspace/${newId("ws")}`, status: "idle" as const, sortOrder, createdAt: new Date().toISOString() };
      database.projects.set(project.id, project);
      const { createdAt: _createdAt, sortOrder: _sortOrder, ...summary } = project;
      return json(summary);
    }
    if (segments.length === 2 && segments[1] === "reorder" && method === "PATCH") {
      const payload = await body(request);
      const projectIds = Array.isArray(payload.projectIds) ? payload.projectIds.map(String) : [];
      if (projectIds.length !== database.projects.size || projectIds.some((id) => !database.projects.has(id))) return fail("项目顺序无效", 400);
      projectIds.forEach((id, index) => {
        const project = database.projects.get(id)!;
        project.sortOrder = index;
      });
      return json({ status: "reordered" });
    }
    const projectId = segments[1];
    const project = projectId ? database.projects.get(projectId) : undefined;
    if (segments.length === 2) {
      if (!project) return fail("project not found", 404);
      if (method === "PATCH") {
        const payload = await body(request);
        if (typeof payload.name === "string" && payload.name.trim()) project.name = payload.name.trim();
        if (typeof payload.path === "string") project.path = payload.path;
        const { createdAt: _createdAt, sortOrder: _sortOrder, ...summary } = project;
        return json(summary);
      }
      if (method === "DELETE") {
        for (const thread of [...database.threads.values()]) {
          if (thread.projectId === projectId) database.threads.delete(thread.id);
        }
        database.projects.delete(projectId);
        return json({ status: "deleted" });
      }
    }
    if (segments.length === 3 && segments[2] === "threads") {
      if (!project) return fail("project not found", 404);
      if (method === "GET") return json(listThreads().filter((thread) => thread.projectId === projectId));
      if (method === "POST") {
        const payload = await body(request);
        return json(threadSummary(createThread(projectId, typeof payload.title === "string" ? payload.title : undefined)));
      }
    }
  }

  if (segments[0] === "threads") {
    if (segments.length === 1 && method === "POST") {
      const payload = await body(request);
      const projectId = payload.projectId === null || payload.projectId === undefined ? null : String(payload.projectId);
      return json(threadSummary(createThread(projectId, typeof payload.title === "string" ? payload.title : undefined)));
    }
    const thread = segments[1] ? database.threads.get(segments[1]) : undefined;
    if (segments.length === 2) {
      if (!thread) return fail("thread not found", 404);
      if (method === "GET") return json(snapshot(thread));
      if (method === "PATCH") {
        const payload = await body(request);
        if (typeof payload.title === "string" && payload.title.trim()) touchThread(thread, { title: payload.title.trim() });
        if ("projectId" in payload) {
          const target = payload.projectId === null ? null : String(payload.projectId);
          if (target && !database.projects.has(target)) return fail("project not found", 404);
          touchThread(thread, { projectId: target });
          thread.runIds.forEach((runId) => {
            const run = database.runs.get(runId);
            if (!run) return;
            run.projectId = target;
            run.events = run.events.map((event) => ({ ...event, projectId: target }));
          });
        }
        return json(threadSummary(thread));
      }
      if (method === "DELETE") {
        thread.runIds.forEach((runId) => database.runs.delete(runId));
        database.threads.delete(thread.id);
        return json({ status: "deleted" });
      }
    }
    if (segments.length === 3 && thread) {
      if (segments[2] === "runs" && method === "POST") {
        const payload = await body(request);
        const message = String(payload.message || "").trim();
        if (!message) return fail("消息不能为空", 400);
        const reasoningEffort = ["medium", "high", "xhigh", "max"].includes(String(payload.reasoningEffort))
          ? String(payload.reasoningEffort) as ReasoningEffort
          : "medium";
        const { runId } = startRun({
          thread,
          message,
          modelId: typeof payload.modelId === "string" ? payload.modelId : "",
          reasoningEffort,
          attachmentIds: Array.isArray(payload.attachmentIds) ? payload.attachmentIds.map(String) : [],
          replaceMessageId: typeof payload.replaceMessageId === "string" ? payload.replaceMessageId : null
        });
        return json({ runId });
      }
      if (segments[2] === "attachments" && method === "POST") {
        const form = await request.formData();
        const uploaded: MockAttachment[] = [];
        for (const entry of form.getAll("files")) {
          if (!(entry instanceof File)) continue;
          const attachment: MockAttachment = {
            id: newId("att"),
            name: entry.name,
            mimeType: entry.type || "application/octet-stream",
            sizeBytes: entry.size,
            kind: entry.type.startsWith("image/") ? "image" : "document",
            url: "",
            bytes: new Uint8Array(await entry.arrayBuffer())
          };
          attachment.url = `/api/v1/attachments/${attachment.id}`;
          thread.attachments.set(attachment.id, attachment);
          uploaded.push(attachment);
        }
        return json(uploaded.map(({ bytes: _bytes, ...attachment }) => attachment));
      }
    }
    if (!thread && segments.length >= 2) return fail("thread not found", 404);
  }

  if (segments[0] === "runs" && segments[1]) {
    if (segments[2] === "events" && method === "GET") {
      const after = Number(new URLSearchParams(search || "").get("after") || 0);
      return eventStream(segments[1], Number.isFinite(after) ? after : 0);
    }
    if (segments[2] === "stop" && method === "POST") {
      const status = stopRun(segments[1]);
      return status ? json({ status }) : fail("run not found", 404);
    }
  }

  if (segments[0] === "approvals" && segments[1] && method === "POST") {
    const payload = await body(request);
    const decision = String(payload.decision || "");
    if (!["allow_once", "always_allow", "deny"].includes(decision)) return fail("无效的决定", 400);
    return resolveApproval(segments[1], decision as "allow_once" | "always_allow" | "deny")
      ? json({ status: "resolved" })
      : fail("审批已失效", 404);
  }

  if ((segments[0] === "artifacts" || segments[0] === "files") && segments[1] && method === "GET") {
    const artifact = database.artifacts.get(segments[1]);
    if (!artifact) return fail("artifact not found", 404);
    return new Response(artifact.content, {
      headers: {
        "content-type": `${artifact.mimeType}; charset=utf-8`,
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(artifact.name)}`
      }
    });
  }

  if (segments[0] === "attachments" && segments[1] && method === "GET") {
    for (const thread of database.threads.values()) {
      const attachment = thread.attachments.get(segments[1]);
      if (attachment) {
        return new Response(attachment.bytes as unknown as BodyInit, {
          headers: {
            "content-type": attachment.mimeType,
            "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(attachment.name)}`
          }
        });
      }
    }
    return fail("attachment not found", 404);
  }

  return fail(`未实现的接口 ${method} ${path}`, 404, "MOCK_NOT_IMPLEMENTED");
}
