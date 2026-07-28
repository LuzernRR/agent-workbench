import { z } from "zod";

const createdAt = z.string().min(20).max(40).refine((value) => Number.isFinite(Date.parse(value)), "createdAt 无效");
const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/u);
const reasonCode = z.string().min(1).max(80).regex(/^[A-Z0-9_]+$/u);
// JSON Schema/Python 按 Unicode 码点计数，而 JavaScript String.length 按
// UTF-16 code unit 计数。直接使用 Zod .max() 会把一个 emoji 算成两个字符，
// 从而拒绝 Python 已按 500 个码点截断的合法搜索结果。
const unicodeText = (max: number, min = 0) => z.string().refine((value) => {
  const length = Array.from(value).length;
  return length >= min && length <= max;
}, `文本长度必须在 ${min} 到 ${max} 个 Unicode 字符之间`);
const compactText = (max: number) => unicodeText(max, 1).refine((value) => !/[\r\n\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value));
const optionalSummary = compactText(500).nullable();
const httpUrl = unicodeText(2_048, 1).refine((value) => {
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}, "只允许无凭据的 HTTP(S) URL");

const base = {
  version: z.literal(1),
  eventId: identifier,
  streamId: identifier,
  streamSeq: z.number().int().positive().max(1_000_000),
  seq: z.number().int().positive().max(1_000_000),
  createdAt,
  type: z.string()
};
const node = z.enum(["load_context", "classify_intent", "plan_research", "research", "reflect", "compose", "verify", "finalize"]);
const agent = z.enum(["supervisor", "planner", "researcher", "reflector", "writer", "verifier"]);
const publicToolName = z.enum(["web_search", "unknown_tool"]);

const resultSchema = z.object({
  title: compactText(300),
  url: httpUrl,
  snippet: unicodeText(500),
  verified: z.boolean()
}).strict();

const usageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
  cost_usd: z.number().nonnegative()
}).strict();

export const searchAgentEventSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("node.started"), node, nodeRunId: identifier, agent, iteration: z.number().int().nonnegative() }).strict(),
  z.object({ ...base, type: z.literal("node.completed"), node, nodeRunId: identifier, agent, iteration: z.number().int().nonnegative(), durationMs: z.number().nonnegative(), publicSummary: optionalSummary }).strict(),
  z.object({ ...base, type: z.literal("node.failed"), node, nodeRunId: identifier, agent, iteration: z.number().int().nonnegative(), reasonCode }).strict(),
  z.object({ ...base, type: z.literal("plan.updated"), iteration: z.number().int().nonnegative(), queries: z.array(compactText(300)).min(1).max(4) }).strict(),
  z.object({ ...base, type: z.literal("tool.started"), toolCallId: identifier, toolName: publicToolName, query: compactText(300), cached: z.boolean() }).strict(),
  z.object({ ...base, type: z.literal("tool.completed"), toolCallId: identifier, toolName: z.literal("web_search"), query: compactText(300), provider: compactText(80), summary: compactText(500), resultCount: z.number().int().nonnegative().max(50), evidenceCount: z.number().int().nonnegative().max(50), results: z.array(resultSchema).max(10), cached: z.boolean() }).strict(),
  z.object({ ...base, type: z.literal("tool.failed"), toolCallId: identifier, toolName: publicToolName, query: unicodeText(300), provider: compactText(80), reasonCode, message: compactText(500), retryable: z.boolean() }).strict(),
  z.object({ ...base, type: z.literal("tool.unknown"), toolCallId: identifier, toolName: publicToolName, query: compactText(300), reasonCode }).strict(),
  z.object({ ...base, type: z.literal("memory.status"), status: z.enum(["available", "stored", "degraded"]), recalledCount: z.number().int().nonnegative().max(100).optional(), storedCount: z.number().int().nonnegative().max(100).optional(), embeddingVersion: compactText(120).optional(), reasonCode: reasonCode.optional() }).strict(),
  z.object({ ...base, type: z.literal("verification.completed"), nodeRunId: identifier, passed: z.boolean(), action: z.enum(["pass", "rewrite", "research_more"]), publicSummary: optionalSummary }).strict(),
  z.object({ ...base, type: z.literal("run.completed"), answerMarkdown: unicodeText(100_000, 1), promptVersion: compactText(120), responseStatus: z.enum(["completed", "partial"]), citations: z.array(z.object({ label: compactText(300), url: httpUrl }).strict()).max(60), verificationPassed: z.boolean(), stopReason: reasonCode, usage: usageSchema, modelCalls: z.number().int().nonnegative().max(100), toolCalls: z.number().int().nonnegative().max(100), evidenceCount: z.number().int().nonnegative().max(1_000) }).strict(),
  z.object({ ...base, type: z.literal("run.stopped"), runId: identifier, responseStatus: z.literal("partial"), reasonCode }).strict(),
  z.object({ ...base, type: z.literal("run.failed"), reasonCode, message: compactText(500) }).strict()
]);

export type SearchAgentEvent = z.infer<typeof searchAgentEventSchema>;

export class SearchAgentEventProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchAgentEventProtocolError";
  }
}

const forbiddenKeys = new Set([
  "reasoningcontent", "authorization", "apikey", "cookie", "systemprompt", "messages",
  "providerbody", "rawprovider", "rawproviderbody", "rawresponse", "providerresponse",
  "requestheaders", "responseheaders", "prompt", "toolarguments"
]);

function assertNoForbiddenFields(value: unknown, path = "event") {
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNoForbiddenFields(child, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replace(/[^A-Za-z0-9]/gu, "").toLowerCase();
    if (forbiddenKeys.has(normalized)) throw new Error(`Search Agent 公开事件包含禁止字段：${path}.${key}`);
    assertNoForbiddenFields(child, `${path}.${key}`);
  }
}

export function parseSearchAgentEvent(input: unknown): SearchAgentEvent {
  try {
    assertNoForbiddenFields(input);
    const parsed = searchAgentEventSchema.parse(input);
    if (parsed.seq !== parsed.streamSeq) throw new SearchAgentEventProtocolError("Search Agent 流内序号不一致");
    return parsed;
  } catch (error) {
    if (error instanceof SearchAgentEventProtocolError) throw error;
    throw new SearchAgentEventProtocolError(error instanceof Error ? error.message : "Search Agent 事件格式无效");
  }
}

const MAX_LINE_BYTES = 1_048_576;

export async function* decodeSearchAgentNdjson(stream: ReadableStream<Uint8Array>): AsyncGenerator<SearchAgentEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let exhausted = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      try {
        buffer += decoder.decode(value, { stream: true });
      } catch {
        throw new SearchAgentEventProtocolError("Search Agent NDJSON 不是有效 UTF-8");
      }
      if (new TextEncoder().encode(buffer).byteLength > MAX_LINE_BYTES && !buffer.includes("\n")) {
        throw new SearchAgentEventProtocolError("Search Agent NDJSON 单行超过限制");
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/u, "");
        buffer = buffer.slice(newline + 1);
        if (new TextEncoder().encode(line).byteLength > MAX_LINE_BYTES) throw new SearchAgentEventProtocolError("Search Agent NDJSON 单行超过限制");
        if (line.trim()) {
          let decoded: unknown;
          try { decoded = JSON.parse(line) as unknown; } catch { throw new SearchAgentEventProtocolError("Search Agent NDJSON 包含无效 JSON"); }
          yield parseSearchAgentEvent(decoded);
        }
        newline = buffer.indexOf("\n");
      }
      if (new TextEncoder().encode(buffer).byteLength > MAX_LINE_BYTES) throw new SearchAgentEventProtocolError("Search Agent NDJSON 单行超过限制");
    }
    try { buffer += decoder.decode(); } catch { throw new SearchAgentEventProtocolError("Search Agent NDJSON 不是有效 UTF-8"); }
    const finalLine = buffer.replace(/\r$/u, "");
    if (new TextEncoder().encode(finalLine).byteLength > MAX_LINE_BYTES) throw new SearchAgentEventProtocolError("Search Agent NDJSON 单行超过限制");
    if (finalLine.trim()) {
      let decoded: unknown;
      try { decoded = JSON.parse(finalLine) as unknown; } catch { throw new SearchAgentEventProtocolError("Search Agent NDJSON 包含无效 JSON"); }
      yield parseSearchAgentEvent(decoded);
    }
    exhausted = true;
  } finally {
    if (!exhausted) {
      try { await reader.cancel(); } catch { /* Transport is already closed. */ }
    }
    reader.releaseLock();
  }
}
