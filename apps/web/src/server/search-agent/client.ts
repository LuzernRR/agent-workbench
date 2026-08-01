import type { ReasoningEffort } from "@/lib/agent-events/types";
import type { ImageInputReference } from "@/server/media/image-input";
import { z } from "zod";
import { loadSearchAgentServiceConfig } from "./config";
import { decodeSearchAgentNdjson, SearchAgentEventProtocolError, type SearchAgentEvent } from "./events";

export type SearchAgentRunRequest = {
  runId: string;
  tenantId: string;
  visitorId: string;
  projectId: string | null;
  threadId: string;
  question: string;
  modelId: string;
  reasoningEffort: ReasoningEffort;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  projectMemoryContext: string;
  /** 仅包含不可逆摘要；不包含 bytes、base64、附件 URL 或任意 Provider URL。 */
  imageInputs?: ImageInputReference[];
  depth?: "quick" | "balanced" | "deep";
  resume?: boolean;
};

export class SearchAgentRequestError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "SearchAgentRequestError";
  }
}

const verificationStatusSchema = z.object({
  version: z.literal(1),
  runId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/u),
  challengeId: z.string().length(43).regex(/^[A-Za-z0-9_-]+$/u),
  status: z.enum(["pending", "succeeded", "expired", "account_mismatch", "failed", "cancelled"]),
  expiresAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  retryAfterMs: z.number().int().min(100).max(10_000),
  reasonCode: z.string().min(1).max(80).regex(/^[A-Z0-9_]+$/u).nullable(),
  message: z.string().min(1).max(300)
}).strict();

const verificationCancelSchema = z.object({
  version: z.literal(1),
  runId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/u),
  challengeId: z.string().length(43).regex(/^[A-Za-z0-9_-]+$/u),
  status: z.literal("cancelled")
}).strict();

export type XiaohongshuVerificationStatus = z.infer<typeof verificationStatusSchema>;

export class SearchAgentVerificationError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
    this.name = "SearchAgentVerificationError";
  }
}

function internalHeaders(accept = "application/x-ndjson") {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8", accept });
  const token = process.env.WORKBENCH_INTERNAL_TOKEN;
  if (token) headers.set("X-Workbench-Token", token);
  return headers;
}

function verificationPath(runId: string, challengeId: string) {
  return `/v1/runs/${encodeURIComponent(runId)}/xiaohongshu-verifications/${encodeURIComponent(challengeId)}`;
}

async function verificationFailure(response: Response): Promise<SearchAgentVerificationError> {
  let code = `SEARCH_AGENT_HTTP_${response.status}`;
  let message = "小红书工具账号验证请求失败";
  try {
    const payload = await response.json() as { detail?: unknown };
    if (typeof payload.detail === "string" && payload.detail.trim()) message = payload.detail.trim().slice(0, 300);
    if (payload.detail && typeof payload.detail === "object") {
      const detail = payload.detail as { reasonCode?: unknown; message?: unknown };
      if (typeof detail.reasonCode === "string" && /^[A-Z0-9_]{1,80}$/u.test(detail.reasonCode)) code = detail.reasonCode;
      if (typeof detail.message === "string" && detail.message.trim()) message = detail.message.trim().slice(0, 300);
    }
  } catch {
    // 非 JSON 错误只保留稳定 HTTP 状态，不透传上游正文。
  }
  return new SearchAgentVerificationError(message, code, response.status);
}

export async function requestXiaohongshuVerificationStatus(runId: string, challengeId: string): Promise<XiaohongshuVerificationStatus> {
  const config = await loadSearchAgentServiceConfig();
  const response = await fetch(`${config.origin}${verificationPath(runId, challengeId)}`, {
    headers: internalHeaders("application/json"),
    cache: "no-store",
    signal: AbortSignal.timeout(Math.min(config.requestTimeoutMs, 15_000))
  });
  if (!response.ok) throw await verificationFailure(response);
  try {
    return verificationStatusSchema.parse(await response.json());
  } catch {
    throw new SearchAgentVerificationError("小红书工具账号验证状态无效", "SEARCH_AGENT_INVALID_EVENT", 502);
  }
}

export async function requestXiaohongshuVerificationQrcode(runId: string, challengeId: string): Promise<Uint8Array> {
  const config = await loadSearchAgentServiceConfig();
  const response = await fetch(`${config.origin}${verificationPath(runId, challengeId)}/qrcode`, {
    headers: internalHeaders("image/png"),
    cache: "no-store",
    signal: AbortSignal.timeout(Math.min(config.requestTimeoutMs, 20_000))
  });
  if (!response.ok) throw await verificationFailure(response);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  const png = bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
  if (contentType !== "image/png" || !png || bytes.byteLength > 4 * 1024 * 1024) {
    throw new SearchAgentVerificationError("小红书工具账号验证二维码无效", "SEARCH_AGENT_INVALID_EVENT", 502);
  }
  return bytes;
}

export async function cancelXiaohongshuVerification(runId: string, challengeId: string): Promise<void> {
  const config = await loadSearchAgentServiceConfig();
  const response = await fetch(`${config.origin}${verificationPath(runId, challengeId)}`, {
    method: "DELETE",
    headers: internalHeaders("application/json"),
    cache: "no-store",
    signal: AbortSignal.timeout(Math.min(config.requestTimeoutMs, 15_000))
  });
  if (!response.ok) throw await verificationFailure(response);
  try {
    verificationCancelSchema.parse(await response.json());
  } catch {
    throw new SearchAgentVerificationError("小红书工具账号验证取消结果无效", "SEARCH_AGENT_INVALID_EVENT", 502);
  }
}

export async function* streamSearchAgentRun(input: SearchAgentRunRequest, signal: AbortSignal): AsyncGenerator<SearchAgentEvent> {
  const config = await loadSearchAgentServiceConfig();
  const timeout = AbortSignal.timeout(config.requestTimeoutMs);
  const combinedSignal = AbortSignal.any([signal, timeout]);
  let response: Response;
  try {
    response = await fetch(`${config.origin}/v1/runs/stream`, {
      method: "POST",
      headers: internalHeaders(),
      body: JSON.stringify({ version: 1, ...input, depth: input.depth || "balanced", resume: Boolean(input.resume) }),
      cache: "no-store",
      signal: combinedSignal
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new SearchAgentRequestError(timeout.aborted ? "Search Agent 请求超时" : "Search Agent 无法连接", timeout.aborted ? "SEARCH_AGENT_TIMEOUT" : "SEARCH_AGENT_UNAVAILABLE");
  }
  if (!response.ok) throw new SearchAgentRequestError("Search Agent 拒绝了运行请求", `SEARCH_AGENT_HTTP_${response.status}`);
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/x-ndjson") || !response.body) {
    throw new SearchAgentRequestError("Search Agent 返回了无效事件流", "SEARCH_AGENT_BAD_CONTENT_TYPE");
  }
  try {
    yield* decodeSearchAgentNdjson(response.body);
  } catch (error) {
    if (signal.aborted) throw error;
    if (timeout.aborted) throw new SearchAgentRequestError("Search Agent 请求超时", "SEARCH_AGENT_TIMEOUT");
    if (error instanceof SearchAgentRequestError) throw error;
    if (error instanceof SearchAgentEventProtocolError) {
      throw new SearchAgentRequestError("Search Agent 事件流校验失败", "SEARCH_AGENT_INVALID_EVENT");
    }
    throw new SearchAgentRequestError("Search Agent 事件流中断", "SEARCH_AGENT_STREAM_ENDED");
  }
}

export async function requestSearchAgentStop(runId: string): Promise<"requested" | "unsupported" | "unavailable"> {
  try {
    const config = await loadSearchAgentServiceConfig();
    const response = await fetch(`${config.origin}/v1/runs/${encodeURIComponent(runId)}/stop`, {
      method: "POST",
      headers: internalHeaders(),
      body: "{}",
      cache: "no-store",
      signal: AbortSignal.timeout(Math.min(config.requestTimeoutMs, 5_000))
    });
    if ([404, 405, 501].includes(response.status)) return "unsupported";
    return response.ok ? "requested" : "unavailable";
  } catch {
    return "unavailable";
  }
}
