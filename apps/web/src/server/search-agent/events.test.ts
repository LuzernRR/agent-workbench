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
const zeroUsage = { input_tokens: 0, output_tokens: 0, total_tokens: 0, cost_usd: 0 };
const provenance = {
  discovery_provider: "tavily",
  detail_provider: null,
  source_kind: "public_index",
  observed_at: "2026-07-28T00:00:00Z",
  confidence: "low"
};
const webResult = (overrides: Record<string, unknown> = {}) => ({
  channel: "web",
  provider: "tavily",
  query: "LangGraph 最新文档",
  title: "官方",
  url: "https://example.com/",
  snippet: "摘要",
  verified: false,
  author: null,
  published_at: null,
  metrics: {},
  limitation: "仅发现候选",
  provenance,
  ...overrides
});

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

  it("接受图级 fan-in 的 merge_research 节点事件", () => {
    const event = {
      ...nodeStarted,
      node: "merge_research",
      nodeRunId: "merge_research_0123456789abcdef0123456789abcdef"
    };
    expect(parseSearchAgentEvent(event)).toEqual(event);
  });

  it("接受 Python 生产图发出的全部节点名称与 Agent 归属", () => {
    const productionNodes = {
      load_context: "supervisor",
      classify_intent: "supervisor",
      plan_research: "planner",
      plan_fast_search: "planner",
      mark_plan_running: "planner",
      research: "researcher",
      merge_research: "researcher",
      accept_fast_evidence: "reflector",
      reflect: "reflector",
      compose: "writer",
      verify: "verifier",
      finalize: "supervisor"
    } as const;

    for (const [node, agent] of Object.entries(productionNodes)) {
      const event = {
        ...nodeStarted,
        node,
        nodeRunId: `${node}_run`,
        agent
      };
      expect(parseSearchAgentEvent(event)).toEqual(event);
    }

    expect(() => parseSearchAgentEvent({
      ...nodeStarted,
      node: "plan_fast_search",
      nodeRunId: "plan_fast_search_wrong_agent",
      agent: "verifier"
    })).toThrow(/Agent 归属/u);
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
      channel: "web",
      provider: "tavily",
      summary: "找到 1 条结果",
      resultCount: 1,
      evidenceCount: 1,
      results: [webResult({ verified: true, reasoning_content: "secret" })],
      cached: false,
      durationMs: 125
    };
    expect(() => parseSearchAgentEvent(completed)).toThrow(/禁止字段/u);
    expect(() => parseSearchAgentEvent({ ...nodeStarted, prompt: "private" })).toThrow(/禁止字段/u);
  });

  it("checkpoint 边界只接受可恢复元数据，不接受 State 正文", () => {
    const boundary = {
      ...sourceEnvelope,
      type: "checkpoint.committed",
      checkpointId: "1f1912ee-73b4-6fe6-8001-36fa8d23b2fd",
      parentCheckpointId: "1f1912ee-73b4-6fe5-8000-72e1dd315f35",
      checkpointNs: "",
      checkpointSessionId: "checkpoint_session_1",
      step: 1
    };

    expect(parseSearchAgentEvent(boundary)).toEqual(boundary);
    expect(() => parseSearchAgentEvent({ ...boundary, values: { answer: "private" } })).toThrow();
    expect(() => parseSearchAgentEvent({ ...boundary, state: { messages: [] } })).toThrow();
    expect(() => parseSearchAgentEvent({ ...boundary, tasks: [] })).toThrow();
    expect(() => parseSearchAgentEvent({ ...boundary, parentCheckpointId: undefined })).toThrow();
    expect(() => parseSearchAgentEvent({ ...boundary, checkpointId: "bad:checkpoint" })).toThrow();
    expect(() => parseSearchAgentEvent({ ...boundary, step: -2 })).toThrow();
  });

  it("拒绝 javascript、带凭据 URL 与危险候选来源", () => {
    const base = {
      ...sourceEnvelope,
      type: "run.completed",
      answerMarkdown: "回答",
      answerSource: "model",
      answerModelCalls: 1,
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
      answerSource: "model",
      answerModelCalls: 1,
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
    expect(parseSearchAgentEvent({ ...sourceEnvelope, type: "run.stopped", runId: "run_one", responseStatus: "partial", reasonCode: "USER_STOPPED", usage: zeroUsage }).type).toBe("run.stopped");
    expect(parseSearchAgentEvent({ ...sourceEnvelope, type: "run.failed", reasonCode: "SEARCH_UNAVAILABLE", message: "搜索不可用", usage: zeroUsage }).type).toBe("run.failed");
  });

  it("所有运行终态都要求严格的四字段 usage", () => {
    const stopped = { ...sourceEnvelope, type: "run.stopped", runId: "run_one", responseStatus: "partial", reasonCode: "USER_STOPPED" };
    const failed = { ...sourceEnvelope, type: "run.failed", reasonCode: "SEARCH_UNAVAILABLE", message: "搜索不可用" };

    expect(() => parseSearchAgentEvent(stopped)).toThrow();
    expect(() => parseSearchAgentEvent(failed)).toThrow();
    expect(() => parseSearchAgentEvent({ ...failed, usage: { ...zeroUsage, requests: 1 } })).toThrow();
    expect(() => parseSearchAgentEvent({ ...failed, usage: { ...zeroUsage, input_tokens: -1 } })).toThrow();
    expect(() => parseSearchAgentEvent({ ...failed, usage: { ...zeroUsage, output_tokens: 0.5 } })).toThrow();
  });

  it("允许上限内 60 条安全引用和固定 unknown_tool 防御事件", () => {
    const citations = Array.from({ length: 60 }, (_, index) => ({ label: `来源 ${index + 1}`, url: `https://example.com/${index + 1}` }));
    expect(parseSearchAgentEvent({ ...sourceEnvelope, type: "run.completed", answerMarkdown: "回答", answerSource: "model", answerModelCalls: 1, promptVersion: "2026-07-28.v2", responseStatus: "completed", citations, verificationPassed: true, stopReason: "VERIFIED", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, cost_usd: 0 }, modelCalls: 1, toolCalls: 1, evidenceCount: 60 }).type).toBe("run.completed");
    expect(parseSearchAgentEvent({ ...sourceEnvelope, type: "tool.failed", toolCallId: "call_unknown", toolName: "unknown_tool", query: "原计划查询", channel: "web", provider: "none", reasonCode: "UNKNOWN_TOOL", message: "Researcher 请求了未注册工具", retryable: false, durationMs: 0 }).type).toBe("tool.failed");
    expect(parseSearchAgentEvent({ ...sourceEnvelope, type: "tool.failed", toolCallId: "call_partial", toolName: "web_search", query: "LangGraph", channel: "xiaohongshu", provider: "xiaohongshu-mcp", reasonCode: "RUN_TIME_RESERVE", message: "为核验保留时间", retryable: false, resultCount: 5, evidenceCount: 1, durationMs: 18001 }).type).toBe("tool.failed");
  });

  it("接受由 Reflector 生成且只绑定真实 URL 的逐行来源说明", () => {
    const event = parseSearchAgentEvent({
      ...sourceEnvelope,
      type: "tool.presented",
      toolCallId: "call_one",
      presentationSource: "model",
      sources: [{ url: "https://example.com/source", text: "该来源说明了 LangGraph 的状态图用法。" }]
    });
    expect(event.type).toBe("tool.presented");
    expect(() => parseSearchAgentEvent({
      ...sourceEnvelope,
      type: "tool.presented",
      toolCallId: "call_one",
      presentationSource: "model",
      sources: [{ url: "javascript:alert(1)", text: "危险来源" }]
    })).toThrow();
  });

  it("拒绝缺少真实模型来源凭据或来源字段不一致的生成性内容", () => {
    const completed = {
      ...sourceEnvelope,
      type: "run.completed",
      answerMarkdown: "模型回答",
      answerSource: "model",
      answerModelCalls: 1,
      promptVersion: "2026-08-01.v25-model-origin-public-output",
      responseStatus: "completed",
      citations: [],
      verificationPassed: true,
      stopReason: "VERIFIED",
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, cost_usd: 0 },
      modelCalls: 1,
      toolCalls: 0,
      evidenceCount: 0
    };
    expect(() => parseSearchAgentEvent({ ...completed, answerSource: undefined })).toThrow();
    expect(() => parseSearchAgentEvent({ ...completed, answerSource: "template" })).toThrow();
    expect(() => parseSearchAgentEvent({ ...completed, answerModelCalls: 0 })).toThrow();
    expect(() => parseSearchAgentEvent({ ...completed, answerModelCalls: 2 })).toThrow(/Writer 模型调用数/u);

    const nodeCompleted = {
      ...sourceEnvelope,
      type: "node.completed",
      node: "plan_research",
      nodeRunId: "plan_model_origin",
      agent: "planner",
      iteration: 1,
      durationMs: 12,
      publicSummary: "由模型生成的计划摘要",
      publicSummarySource: "model"
    };
    expect(parseSearchAgentEvent(nodeCompleted).type).toBe("node.completed");
    expect(() => parseSearchAgentEvent({ ...nodeCompleted, publicSummarySource: null })).toThrow(/同时存在/u);
    expect(() => parseSearchAgentEvent({ ...nodeCompleted, publicSummary: null })).toThrow(/同时存在/u);
    const plan = {
      planId: "plan_runtime_one",
      revision: 1,
      iteration: 1,
      steps: [{
        stepId: "step_runtime_one",
        facet: "定义",
        objective: "读取真实模型规划的官方定义",
        query: "Agent Workbench 官方定义",
        channel: "web",
        dependsOn: [],
        priority: 100,
        evidenceNeeded: 1,
        canParallelize: true,
        status: "todo",
        reasonCode: null
      }]
    } as const;
    expect(() => parseSearchAgentEvent({
      ...sourceEnvelope,
      type: "plan.updated",
      ...plan
    })).toThrow();
    expect(parseSearchAgentEvent({
      ...sourceEnvelope,
      type: "plan.updated",
      ...plan,
      planSource: "model"
    }).type).toBe("plan.updated");
    expect(parseSearchAgentEvent({
      ...sourceEnvelope,
      type: "plan.rejected",
      iteration: 1,
      reasonCode: "PLAN_CHANNEL_NOT_ALLOWED",
      planSource: "model"
    }).type).toBe("plan.rejected");
    expect(() => parseSearchAgentEvent({
      ...sourceEnvelope,
      type: "plan.updated",
      ...plan,
      steps: [
        { ...plan.steps[0], dependsOn: ["step_runtime_two"] },
        { ...plan.steps[0], stepId: "step_runtime_two", query: "第二个查询", dependsOn: ["step_runtime_one"] }
      ],
      planSource: "model"
    })).toThrow(/依赖图/u);
    expect(() => parseSearchAgentEvent({
      ...sourceEnvelope,
      type: "tool.presented",
      toolCallId: "call_one",
      sources: [{ url: "https://example.com/source", text: "正文支持这一结论。" }]
    })).toThrow();
  });

  it("严格接受逐步累加的工具进度与可选已读来源", () => {
    expect(parseSearchAgentEvent({
      ...sourceEnvelope,
      type: "tool.progress",
      toolCallId: "call_one",
      planStepId: "step_runtime_one",
      toolName: "web_search",
      query: "LangGraph 最新文档",
      channel: "web",
      provider: "tavily",
      resultCount: 1,
      evidenceCount: 0,
      source: null
    }).type).toBe("tool.progress");
    expect(parseSearchAgentEvent({
      ...sourceEnvelope,
      type: "tool.progress",
      toolCallId: "call_one",
      toolName: "web_search",
      query: "LangGraph 最新文档",
      channel: "web",
      provider: "tavily",
      resultCount: 2,
      evidenceCount: 1,
      source: webResult({ verified: true, limitation: null })
    }).type).toBe("tool.progress");
  });

  it("接受安全工具账本引用并拒绝伪造哈希或私有调用参数", () => {
    const started = {
      ...sourceEnvelope,
      type: "tool.started",
      toolCallId: "call_ledger",
      planStepId: "step_one",
      operationRef: "operation_1234567890abcdef",
      attempt: 1,
      inputHash: "a".repeat(64),
      researchBatchId: "research_batch_one",
      researchResultId: "research_result_one",
      toolName: "web_search",
      query: "LangGraph tracing",
      channel: "web",
      cached: false
    };
    expect(parseSearchAgentEvent(started).type).toBe("tool.started");
    expect(() => parseSearchAgentEvent({ ...started, inputHash: "not-a-hash" })).toThrow();
    expect(() => parseSearchAgentEvent({ ...started, toolArguments: { query: "private" } })).toThrow(/禁止字段/u);
  });

  it("只接受不含二维码和内部地址的工具账号验证事件", () => {
    const required = {
      ...sourceEnvelope,
      type: "tool.verification.required",
      toolCallId: "call_xhs",
      challengeId: "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789",
      status: "pending",
      expiresAt: "2026-07-28T00:04:00Z",
      retryAfterMs: 2000,
      reasonCode: null,
      message: "等待使用小红书 App 扫码验证工具账号"
    };
    expect(parseSearchAgentEvent(required).type).toBe("tool.verification.required");
    expect(parseSearchAgentEvent({ ...required, type: "tool.verification.heartbeat" }).type).toBe("tool.verification.heartbeat");
    expect(parseSearchAgentEvent({
      ...required,
      type: "tool.verification.resolved",
      status: "succeeded",
      reasonCode: null,
      message: "小红书工具账号验证成功"
    }).type).toBe("tool.verification.resolved");
    expect(() => parseSearchAgentEvent({ ...required, qrcode: "data:image/png;base64,secret" })).toThrow();
    expect(() => parseSearchAgentEvent({ ...required, internalUrl: "http://xiaohongshu-mcp:18060" })).toThrow();
    expect(() => parseSearchAgentEvent({ ...required, challengeId: "short" })).toThrow();
  });

  it("接受隔离登录态读取的来源类型，但公开事件仍不允许凭据字段", () => {
    const completed = {
      ...sourceEnvelope,
      type: "tool.completed",
      toolCallId: "call_xhs",
      toolName: "web_search",
      query: "小红书 LangGraph",
      channel: "xiaohongshu",
      provider: "xiaohongshu-mcp",
      summary: "找到 1 条结果，读取 1 个来源",
      resultCount: 1,
      evidenceCount: 1,
      results: [webResult({
        channel: "xiaohongshu",
        provider: "xiaohongshu-mcp",
        query: "小红书 LangGraph",
        url: "https://www.xiaohongshu.com/explore/feed_123",
        verified: true,
        provenance: {
          discovery_provider: "xiaohongshu-mcp",
          detail_provider: "xiaohongshu-mcp",
          source_kind: "authenticated_page",
          observed_at: "2026-07-28T00:00:00Z",
          confidence: "high"
        }
      })],
      cached: false,
      durationMs: 432
    };
    expect(parseSearchAgentEvent(completed).type).toBe("tool.completed");
    expect(() => parseSearchAgentEvent({
      ...completed,
      results: [{ ...completed.results[0], cookie: "secret" }]
    })).toThrow(/禁止字段/u);
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
      channel: "web",
      provider: "tavily",
      summary: "找到 1 条结果",
      resultCount: 1,
      evidenceCount: 0,
      results: [webResult({ title: "官方文档", url: "https://docs.langchain.com/oss/python/langgraph/graph-api", query: "LangGraph 条件边", snippet })],
      cached: false,
      durationMs: 87
    };
    expect(parseSearchAgentEvent(completed).type).toBe("tool.completed");
    expect(() => parseSearchAgentEvent({
      ...completed,
      results: [{ ...completed.results[0], snippet: `${snippet}中` }]
    })).toThrow();
  });

  it("严格校验可审计记忆事件，并按 Unicode 码点校验 URL", () => {
    const memory = {
      ...sourceEnvelope,
      type: "memory.updated",
      operation: "store",
      status: "completed",
      count: 1,
      memoryRefs: ["memory_one"],
      evidenceIds: ["evidence_one"],
      embeddingVersion: "hashing-v1"
    };
    expect(parseSearchAgentEvent(memory).type).toBe("memory.updated");
    expect(() => parseSearchAgentEvent({
      ...memory,
      reasonCode: "MEMORY_UNAVAILABLE"
    })).toThrow();
    expect(parseSearchAgentEvent({
      ...memory,
      operation: "recall",
      status: "degraded",
      count: 0,
      memoryRefs: [],
      evidenceIds: [],
      reasonCode: "MEMORY_UNAVAILABLE"
    }).type).toBe("memory.updated");
    expect(() => parseSearchAgentEvent({ ...memory, count: 2 })).toThrow();
    expect(() => parseSearchAgentEvent({ ...memory, text: "禁止公开记忆正文" })).toThrow();

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
      channel: "web",
      provider: "tavily",
      summary: "找到 1 条结果",
      resultCount: 1,
      evidenceCount: 0,
      results: [webResult({ title: "来源", url, query: "Unicode URL" })],
      cached: false,
      durationMs: 9
    }).type).toBe("tool.completed");
  });

  it("工具终态必须携带非负整数真实耗时", () => {
    const completed = {
      ...sourceEnvelope,
      type: "tool.completed",
      toolCallId: "call_duration",
      toolName: "web_search",
      query: "LangGraph",
      channel: "web",
      provider: "tavily",
      summary: "找到 0 条结果",
      resultCount: 0,
      evidenceCount: 0,
      results: [],
      cached: false
    };
    const failed = {
      ...sourceEnvelope,
      type: "tool.failed",
      toolCallId: "call_failed_duration",
      toolName: "web_search",
      query: "LangGraph",
      channel: "web",
      provider: "tavily",
      reasonCode: "PROVIDER_UNAVAILABLE",
      message: "搜索服务暂不可用",
      retryable: true
    };

    expect(() => parseSearchAgentEvent(completed)).toThrow();
    expect(() => parseSearchAgentEvent({ ...completed, durationMs: -1 })).toThrow();
    expect(() => parseSearchAgentEvent({ ...completed, durationMs: 1.5 })).toThrow();
    expect(parseSearchAgentEvent({ ...completed, durationMs: 0 }).type).toBe("tool.completed");
    expect(() => parseSearchAgentEvent(failed)).toThrow();
    expect(() => parseSearchAgentEvent({ ...failed, durationMs: -1 })).toThrow();
    expect(() => parseSearchAgentEvent({ ...failed, durationMs: 1.5 })).toThrow();
    expect(parseSearchAgentEvent({ ...failed, durationMs: 321 }).type).toBe("tool.failed");
  });

  it("拒绝 streamSeq/seq 不一致，但不把流内序号当跨恢复 cursor", () => {
    expect(() => parseSearchAgentEvent({ ...nodeStarted, streamSeq: 2 })).toThrow(/序号不一致/u);
    expect(parseSearchAgentEvent({ ...nodeStarted, eventId: "stream_resume_000001", streamId: "stream_resume", streamSeq: 1, seq: 1 }).seq).toBe(1);
  });

  it("只接受正文无关的 Evidence 生命周期白名单", () => {
    const evidence = {
      ...sourceEnvelope,
      type: "evidence.updated",
      evidenceId: "evidence_0123456789abcdef0123456789abcdef01234567",
      sourceId: "source_0123456789abcdef0123456789abcdef01234567",
      contentHash: "a".repeat(64),
      toolCallId: "call_one",
      url: "https://example.com/source",
      title: "公开标题",
      channel: "web",
      status: "accepted",
      reasonCode: "SOURCE_PRESENTED",
      updatedAt: "2026-07-28T00:00:01Z"
    };
    expect(parseSearchAgentEvent(evidence)).toEqual(evidence);
    expect(() => parseSearchAgentEvent({ ...evidence, text: "不得进入事件的正文" })).toThrow();
    expect(() => parseSearchAgentEvent({ ...evidence, status: "draft" })).toThrow();
    expect(() => parseSearchAgentEvent({ ...evidence, contentHash: "short" })).toThrow();
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
