import { describe, expect, it, vi } from "vitest";
import { decodeSearchAgentNdjson, parseSearchAgentEvent } from "./events";

const encoder = new TextEncoder();
const sourceEnvelope = {
  version: 1,
  eventId: "stream_test_000001",
  streamId: "stream_test",
  streamSeq: 1,
  seq: 1,
  createdAt: "2026-07-28T00:00:00Z"
};

function stream(chunks: string[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
      controller.close();
    }
  });
}

async function collect(chunks: string[]) {
  const events = [];
  for await (const event of decodeSearchAgentNdjson(stream(chunks))) events.push(event);
  return events;
}

const nodeStarted = {
  ...sourceEnvelope,
  type: "node.started",
  node: "research",
  nodeRunId: "research_0123456789abcdef0123456789abcdef",
  agent: "researcher",
  iteration: 1
};

describe("Search Agent 严格 NDJSON 边界", () => {
  it("跨 chunk 解码 UTF-8 NDJSON，并接受结尾无换行", async () => {
    const line = JSON.stringify(nodeStarted);
    const events = await collect([line.slice(0, 17), line.slice(17)]);
    expect(events).toEqual([nodeStarted]);
  });

  it("拒绝未知事件与任何额外字段", () => {
    expect(() => parseSearchAgentEvent({ ...nodeStarted, type: "provider.raw" })).toThrow();
    expect(() => parseSearchAgentEvent({ ...nodeStarted, rawProviderBody: {} })).toThrow(/禁止字段/u);
  });

  it("递归拒绝 reasoning_content、Provider body 与内部 Prompt", () => {
    const completed = {
      ...sourceEnvelope,
      type: "tool.completed",
      toolCallId: "call_one",
      toolName: "web_search",
      query: "LangGraph 最新文档",
      provider: "tavily",
      summary: "找到 1 条结果",
      resultCount: 1,
      evidenceCount: 1,
      results: [{ title: "官方", url: "https://example.com/", snippet: "摘要", verified: true, reasoning_content: "secret" }],
      cached: false
    };
    expect(() => parseSearchAgentEvent(completed)).toThrow(/禁止字段/u);
    expect(() => parseSearchAgentEvent({ ...nodeStarted, prompt: "private" })).toThrow(/禁止字段/u);
  });

  it("拒绝 javascript、带凭据 URL 与危险候选来源", () => {
    const base = {
      ...sourceEnvelope,
      type: "run.completed",
      answerMarkdown: "回答",
      promptVersion: "2026-07-28.v2",
      responseStatus: "completed",
      verificationPassed: true,
      stopReason: "VERIFIED",
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, cost_usd: 0 },
      modelCalls: 1,
      toolCalls: 1,
      evidenceCount: 1
    };
    expect(() => parseSearchAgentEvent({ ...base, citations: [{ label: "危险", url: "javascript:alert(1)" }] })).toThrow();
    expect(() => parseSearchAgentEvent({ ...base, citations: [{ label: "危险", url: "https://user:pass@example.com/" }] })).toThrow();
  });

  it("拒绝坏 JSON、无效 UTF-8 与超过 1 MiB 的单行", async () => {
    await expect(collect(["{bad json}\n"])).rejects.toThrow();
    const invalidUtf8 = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([0xff])); controller.close(); } });
    const consumeInvalid = async () => { for await (const _event of decodeSearchAgentNdjson(invalidUtf8)) void _event; };
    await expect(consumeInvalid()).rejects.toThrow();
    await expect(collect(["x".repeat(1_048_577)])).rejects.toThrow(/超过限制/u);
    await expect(collect([`${"x".repeat(1_048_577)}\n${JSON.stringify(nodeStarted)}\n`])).rejects.toThrow(/超过限制/u);
  });

  it("严格接受 completed/partial 与 stopped 终态", () => {
    const completed = parseSearchAgentEvent({
      ...sourceEnvelope,
      type: "run.completed",
      answerMarkdown: "带来源回答",
      promptVersion: "2026-07-28.v2",
      responseStatus: "partial",
      citations: [],
      verificationPassed: false,
      stopReason: "SEARCH_UNAVAILABLE",
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, cost_usd: 0.001 },
      modelCalls: 2,
      toolCalls: 1,
      evidenceCount: 0
    });
    expect(completed.type).toBe("run.completed");
    if (completed.type !== "run.completed") throw new Error("run.completed 解析失败");
    expect(completed.responseStatus).toBe("partial");
    expect(parseSearchAgentEvent({ ...sourceEnvelope, type: "run.stopped", runId: "run_one", responseStatus: "partial", reasonCode: "USER_STOPPED" }).type).toBe("run.stopped");
  });

  it("允许上限内 60 条安全引用和固定 unknown_tool 防御事件", () => {
    const citations = Array.from({ length: 60 }, (_, index) => ({ label: `来源 ${index + 1}`, url: `https://example.com/${index + 1}` }));
    expect(parseSearchAgentEvent({ ...sourceEnvelope, type: "run.completed", answerMarkdown: "回答", promptVersion: "2026-07-28.v2", responseStatus: "completed", citations, verificationPassed: true, stopReason: "VERIFIED", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, cost_usd: 0 }, modelCalls: 1, toolCalls: 1, evidenceCount: 60 }).type).toBe("run.completed");
    expect(parseSearchAgentEvent({ ...sourceEnvelope, type: "tool.failed", toolCallId: "call_unknown", toolName: "unknown_tool", query: "原计划查询", provider: "none", reasonCode: "UNKNOWN_TOOL", message: "Researcher 请求了未注册工具", retryable: false }).type).toBe("tool.failed");
  });

  it("按 Unicode 码点校验搜索摘要长度，不把 emoji 误算为两个字符", () => {
    const snippet = `🔗${"中".repeat(499)}`;
    expect(Array.from(snippet)).toHaveLength(500);
    expect(snippet.length).toBe(501);
    const completed = {
      ...sourceEnvelope,
      type: "tool.completed",
      toolCallId: "call_unicode",
      toolName: "web_search",
      query: "LangGraph 条件边",
      provider: "tavily",
      summary: "找到 1 条结果",
      resultCount: 1,
      evidenceCount: 0,
      results: [{ title: "官方文档", url: "https://docs.langchain.com/oss/python/langgraph/graph-api", snippet, verified: false }],
      cached: false
    };
    expect(parseSearchAgentEvent(completed).type).toBe("tool.completed");
    expect(() => parseSearchAgentEvent({
      ...completed,
      results: [{ ...completed.results[0], snippet: `${snippet}中` }]
    })).toThrow();
  });

  it("成功记忆省略 reasonCode，并按 Unicode 码点校验 URL", () => {
    expect(parseSearchAgentEvent({
      ...sourceEnvelope,
      type: "memory.status",
      status: "stored",
      storedCount: 1,
      embeddingVersion: "hashing-v1"
    }).type).toBe("memory.status");
    expect(() => parseSearchAgentEvent({
      ...sourceEnvelope,
      type: "memory.status",
      status: "stored",
      storedCount: 1,
      reasonCode: null
    })).toThrow();

    const prefix = "https://example.com/";
    const url = `${prefix}${"a".repeat(2_048 - Array.from(prefix).length - 1)}🔗`;
    expect(Array.from(url)).toHaveLength(2_048);
    expect(url.length).toBe(2_049);
    expect(parseSearchAgentEvent({
      ...sourceEnvelope,
      type: "tool.completed",
      toolCallId: "call_unicode_url",
      toolName: "web_search",
      query: "Unicode URL",
      provider: "tavily",
      summary: "找到 1 条结果",
      resultCount: 1,
      evidenceCount: 0,
      results: [{ title: "来源", url, snippet: "摘要", verified: false }],
      cached: false
    }).type).toBe("tool.completed");
  });

  it("拒绝 streamSeq/seq 不一致，但不把流内序号当跨恢复 cursor", () => {
    expect(() => parseSearchAgentEvent({ ...nodeStarted, streamSeq: 2 })).toThrow(/序号不一致/u);
    expect(parseSearchAgentEvent({ ...nodeStarted, eventId: "stream_resume_000001", streamId: "stream_resume", streamSeq: 1, seq: 1 }).seq).toBe(1);
  });

  it("消费者在终态后提前 return 时取消底层 reader", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(`${JSON.stringify(nodeStarted)}\n`)); },
      cancel
    });
    const iterator = decodeSearchAgentNdjson(body);
    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { type: "node.started" } });
    await iterator.return(undefined);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
