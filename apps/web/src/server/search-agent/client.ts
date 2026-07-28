import type { ReasoningEffort } from "@/lib/agent-events/types";
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
  depth?: "quick" | "balanced" | "deep";
  resume?: boolean;
};

export class SearchAgentRequestError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "SearchAgentRequestError";
  }
}

function internalHeaders() {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8", accept: "application/x-ndjson" });
  const token = process.env.WORKBENCH_INTERNAL_TOKEN;
  if (token) headers.set("X-Workbench-Token", token);
  return headers;
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
