import { describe, expect, it } from "vitest";
import { parseSearchAgentEvent } from "./events";
import { mapSearchAgentEvent } from "./mapper";

const createdAt = "2026-07-28T00:00:00Z";
const source = (payload: Record<string, unknown>) => parseSearchAgentEvent({
  version: 1,
  eventId: "stream_test_000001",
  streamId: "stream_test",
  streamSeq: 1,
  seq: 1,
  createdAt,
  ...payload
});
const provenance = {
  discovery_provider: "tavily",
  detail_provider: "trafilatura",
  source_kind: "public_page",
  observed_at: createdAt,
  confidence: "high"
};

describe("Search Agent v1 白名单投影", () => {
  it("node.started 不提前创建稍后会被回填的思考项", () => {
    const first = mapSearchAgentEvent(source({ type: "node.started", node: "compose", nodeRunId: "compose_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", agent: "writer", iteration: 1 }), "run_one");
    const second = mapSearchAgentEvent(source({ type: "node.started", node: "verify", nodeRunId: "verify_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", agent: "verifier", iteration: 1 }), "run_one");
    expect(first.events).toEqual([]);
    expect(second.events).toEqual([]);
  });

  it("每个 node.completed 按发生时间创建独立思考原子，交给前端仅合并相邻原子", () => {
    const planned = mapSearchAgentEvent(source({ type: "node.completed", node: "plan_research", nodeRunId: "plan_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", agent: "planner", iteration: 1, durationMs: 10, publicSummary: "将搜索官方规范与当前示例" }), "run_one");
    const replanned = mapSearchAgentEvent(source({ type: "node.completed", node: "plan_research", nodeRunId: "plan_cccccccccccccccccccccccccccccccc", agent: "planner", iteration: 2, durationMs: 12, publicSummary: "补充检索安装与兼容信息" }), "run_one");
    const reflected = mapSearchAgentEvent(source({ type: "node.completed", node: "reflect", nodeRunId: "reflect_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", agent: "reflector", iteration: 1, durationMs: 20, publicSummary: "官方来源已覆盖核心用法" }), "run_one");
    expect(planned.events).toHaveLength(3);
    expect(planned.events[0].payload).toMatchObject({ thinkingId: "thinking:run_one:plan_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", activityKind: "thinking" });
    expect(planned.events[1].payload).toMatchObject({ thinkingId: "thinking:run_one:plan_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", text: "将搜索官方规范与当前示例", agent: "planner" });
    expect(replanned.events[1].payload).toMatchObject({ thinkingId: "thinking:run_one:plan_cccccccccccccccccccccccccccccccc", text: "补充检索安装与兼容信息", agent: "planner" });
    expect(reflected.events[1].payload).toMatchObject({ thinkingId: "thinking:run_one:reflect_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", text: "官方来源已覆盖核心用法", agent: "reflector" });
    expect(planned.events[1].payload.thinkingId).not.toBe(replanned.events[1].payload.thinkingId);
    expect(JSON.stringify([planned, replanned, reflected])).not.toContain("【");
  });

  it("搜索查询只由真实工具卡展示，不创建运行结束后会陈旧的重复计划栏", () => {
    const projection = mapSearchAgentEvent(source({ type: "plan.updated", iteration: 1, queries: ["CC Switch 定义", "CC Switch 原理"] }), "run_one");
    expect(projection.events).toEqual([]);
  });

  it("只持久化安全搜索字段，保留可点击来源且丢弃 snippet", () => {
    const projection = mapSearchAgentEvent(source({
      type: "tool.completed",
      toolCallId: "call_one",
      toolName: "web_search",
      query: "LangGraph 官方文档",
      channel: "web",
      provider: "tavily",
      summary: "找到 1 条结果，读取 1 个来源",
      resultCount: 1,
      evidenceCount: 1,
      results: [{ channel: "web", provider: "tavily", query: "LangGraph 官方文档", title: "LangGraph", url: "https://docs.langchain.com/oss/python/langgraph", snippet: "不进入持久事件的候选摘要", verified: true, author: "LangChain", published_at: null, metrics: {}, limitation: null, provenance }],
      cached: false
    }));
    expect(projection.events).toEqual([{ type: "tool.completed", payload: expect.objectContaining({
      query: "LangGraph 官方文档",
      resultCount: 1,
      evidenceCount: 1,
      sources: [{ title: "LangGraph", url: "https://docs.langchain.com/oss/python/langgraph", verified: true, channel: "web", author: "LangChain", publishedAt: undefined, limitation: undefined }],
      sourceEventId: "stream_test_000001",
      sourceStreamId: "stream_test",
      sourceStreamSeq: 1,
      sourceSeq: 1
    }) }]);
    expect(JSON.stringify(projection)).not.toContain("不进入持久事件");
    expect(JSON.stringify(projection)).not.toMatch(/raw|reasoning_content|providerBody/u);
  });

  it("把 Reflector 的结构化来源说明映射到原工具行", () => {
    const projection = mapSearchAgentEvent(source({
      type: "tool.presented",
      toolCallId: "call_one",
      sources: [{ url: "https://example.com/source", text: "该来源聚焦状态图中的工具循环。" }]
    }));
    expect(projection.events).toEqual([{ type: "tool.updated", payload: expect.objectContaining({
      toolCallId: "call_one",
      sourcePresentations: [{
        url: "https://example.com/source",
        text: "该来源聚焦状态图中的工具循环。"
      }]
    }) }]);
  });

  it("诚实映射 partial、failed、unknown 与 stopped", () => {
    const partial = mapSearchAgentEvent(source({ type: "run.completed", answerMarkdown: "证据不足的回答", promptVersion: "2026-07-28.v2", responseStatus: "partial", citations: [], verificationPassed: false, stopReason: "SEARCH_UNAVAILABLE", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, cost_usd: 0 }, modelCalls: 2, toolCalls: 1, evidenceCount: 0 }));
    expect(partial.terminal).toEqual(expect.objectContaining({ kind: "completed", remember: false, payload: expect.objectContaining({ promptVersion: "2026-07-28.v2", partial: true, responseStatus: "partial" }) }));

    const unknown = mapSearchAgentEvent(source({ type: "tool.unknown", toolCallId: "call_unknown", toolName: "web_search", query: "查询", channel: "web", reasonCode: "OUTCOME_UNKNOWN" }));
    expect(unknown.events[0]).toEqual(expect.objectContaining({ type: "tool.updated", payload: expect.objectContaining({ status: "unknown" }) }));

    const stopped = mapSearchAgentEvent(source({ type: "run.stopped", runId: "run_one", responseStatus: "partial", reasonCode: "USER_STOPPED" }));
    expect(stopped.terminal).toEqual(expect.objectContaining({ kind: "stopped", payload: expect.objectContaining({ reasonCode: "USER_STOPPED", partial: true, sourceEventId: "stream_test_000001" }) }));
  });

  it("direct completed 不误报外部证据核验", () => {
    const direct = mapSearchAgentEvent(source({ type: "run.completed", answerMarkdown: "直接回答", promptVersion: "2026-07-28.v2", responseStatus: "completed", citations: [], verificationPassed: false, stopReason: "DIRECT_COMPLETED", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, cost_usd: 0 }, modelCalls: 2, toolCalls: 0, evidenceCount: 0 }));
    expect(direct.terminal).toEqual(expect.objectContaining({
      kind: "completed",
      remember: false,
      payload: expect.objectContaining({ partial: false, verificationPassed: false, summary: "回答已完成，本任务未使用外部证据核验" })
    }));
  });

  it("verification.completed 创建独立核验活动，不混入思考", () => {
    const projection = mapSearchAgentEvent(source({ type: "verification.completed", nodeRunId: "verify_cccccccccccccccccccccccccccccccc", passed: false, action: "rewrite", publicSummary: "引用格式需要修正" }));
    expect(projection.events).toHaveLength(3);
    expect(projection.events[0]).toEqual(expect.objectContaining({
      type: "thinking.started",
      payload: expect.objectContaining({
        thinkingId: "verification:stream_test:verify_cccccccccccccccccccccccccccccccc",
        activityKind: "verification"
      })
    }));
    expect(projection.events[1]).toEqual(expect.objectContaining({
      type: "thinking.paragraph",
      payload: expect.objectContaining({ text: "引用格式需要修正", agent: "verifier", node: "verify" })
    }));
  });

  it("node.completed 的 verify 摘要由 verification.completed 唯一投影", () => {
    const projection = mapSearchAgentEvent(source({ type: "node.completed", node: "verify", nodeRunId: "verify_cccccccccccccccccccccccccccccccc", agent: "verifier", iteration: 1, durationMs: 20, publicSummary: "引用格式需要修正" }));
    expect(projection.events).toEqual([]);
  });

  it("缺少 Agent 公开摘要时不制造固定核验文案", () => {
    const projection = mapSearchAgentEvent(source({
      type: "verification.completed",
      nodeRunId: "verify_direct_dddddddddddddddddddddddddddddddd",
      passed: false,
      action: "pass",
      publicSummary: null
    }));
    expect(projection.events).toEqual([]);
  });

  it("把 unknown_tool 显示为被阻止的固定安全工具行", () => {
    const started = mapSearchAgentEvent(source({ type: "tool.started", toolCallId: "call_unknown", toolName: "unknown_tool", query: "原计划查询", channel: "web", cached: false }));
    const failed = mapSearchAgentEvent(source({ type: "tool.failed", toolCallId: "call_unknown", toolName: "unknown_tool", query: "原计划查询", channel: "web", provider: "none", reasonCode: "UNKNOWN_TOOL", message: "Researcher 请求了未注册工具", retryable: false }));
    expect(started.events[0].payload).toMatchObject({ name: "未知工具请求", summary: "正在拦截未注册工具请求" });
    expect(failed.events[0].payload).toMatchObject({ summary: "未知工具请求已被阻止", error: "UNKNOWN_TOOL" });
  });

  it("node.failed 不生成固定思考文案，交给 run.failed 统一结算 error", () => {
    const projection = mapSearchAgentEvent(source({ type: "node.failed", node: "research", nodeRunId: "research_dddddddddddddddddddddddddddddddd", agent: "researcher", iteration: 0, reasonCode: "PROVIDER_UNAVAILABLE" }));
    expect(projection.events).toEqual([]);
  });
});
