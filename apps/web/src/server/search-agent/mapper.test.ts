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
    const planned = mapSearchAgentEvent(source({ type: "node.completed", node: "plan_research", nodeRunId: "plan_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", agent: "planner", iteration: 1, durationMs: 10, publicSummary: "将搜索官方规范与当前示例", publicSummarySource: "model" }), "run_one");
    const replanned = mapSearchAgentEvent(source({ type: "node.completed", node: "plan_research", nodeRunId: "plan_cccccccccccccccccccccccccccccccc", agent: "planner", iteration: 2, durationMs: 12, publicSummary: "补充检索安装与兼容信息", publicSummarySource: "model" }), "run_one");
    const reflected = mapSearchAgentEvent(source({ type: "node.completed", node: "reflect", nodeRunId: "reflect_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", agent: "reflector", iteration: 1, durationMs: 20, publicSummary: "官方来源已覆盖核心用法", publicSummarySource: "model" }), "run_one");
    expect(planned.events).toHaveLength(3);
    expect(planned.events[0].payload).toMatchObject({ thinkingId: "thinking:run_one:plan_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", activityKind: "thinking" });
    expect(planned.events[1]).toMatchObject({ type: "thinking.delta", payload: { thinkingId: "thinking:run_one:plan_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", delta: "将搜索官方规范与当前示例", publicSummarySource: "model", agent: "planner" } });
    expect(replanned.events[1].payload).toMatchObject({ thinkingId: "thinking:run_one:plan_cccccccccccccccccccccccccccccccc", delta: "补充检索安装与兼容信息", agent: "planner" });
    expect(reflected.events[1].payload).toMatchObject({ thinkingId: "thinking:run_one:reflect_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", delta: "官方来源已覆盖核心用法", agent: "reflector" });
    expect(planned.events[1].payload.thinkingId).not.toBe(replanned.events[1].payload.thinkingId);
    expect(JSON.stringify([planned, replanned, reflected])).not.toContain("【");
  });

  it("持久化完整结构化计划快照，供刷新与回放一致重建", () => {
    const projection = mapSearchAgentEvent(source({
      type: "plan.updated",
      planId: "plan_runtime_one",
      revision: 1,
      iteration: 1,
      planSource: "model",
      steps: [{
        stepId: "step_runtime_one",
        facet: "定义",
        objective: "读取 CC Switch 官方定义",
        query: "CC Switch 定义",
        channel: "web",
        dependsOn: [],
        priority: 100,
        evidenceNeeded: 1,
        canParallelize: true,
        status: "todo",
        reasonCode: null
      }]
    }), "run_one");
    expect(projection.events).toEqual([{
      type: "plan.updated",
      payload: expect.objectContaining({
        planId: "plan_runtime_one",
        revision: 1,
        steps: [expect.objectContaining({
          id: "step_runtime_one",
          query: "CC Switch 定义",
          status: "todo",
          canParallelize: true
        })]
      })
    }]);
  });

  it("把计划拒绝保留为纯结构化日志码，不生成推理文案", () => {
    const projection = mapSearchAgentEvent(source({
      type: "plan.rejected",
      iteration: 1,
      reasonCode: "PLAN_CHANNEL_NOT_ALLOWED",
      planSource: "model"
    }), "run_one");

    expect(projection.events).toMatchObject([{
      type: "log.appended",
      payload: {
        log: expect.objectContaining({
          actor: "planner",
          level: "warn",
          content: "PLAN_CHANNEL_NOT_ALLOWED"
        })
      }
    }]);
    expect(JSON.stringify(projection)).not.toContain("思考");
  });

  it("保留真实工具调用与结构计划步骤的关联", () => {
    const projection = mapSearchAgentEvent(source({
      type: "tool.started",
      toolCallId: "call_one",
      planStepId: "step_runtime_one",
      operationRef: "operation_1234567890abcdef",
      attempt: 1,
      inputHash: "a".repeat(64),
      researchBatchId: "research_batch_one",
      researchResultId: "research_result_one",
      toolName: "web_search",
      query: "LangGraph 官方文档",
      channel: "web",
      cached: false
    }), "run_one");

    expect(projection.events[0].payload).toMatchObject({
      toolCallId: "call_one",
      planStepId: "step_runtime_one",
      operationRef: "operation_1234567890abcdef",
      attempt: 1,
      inputHash: "a".repeat(64),
      researchBatchId: "research_batch_one",
      researchResultId: "research_result_one"
    });
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
      cached: false,
      durationMs: 347
    }));
    expect(projection.events).toEqual([{ type: "tool.completed", payload: expect.objectContaining({
      query: "LangGraph 官方文档",
      resultCount: 1,
      evidenceCount: 1,
      durationMs: 347,
      sources: [{ title: "LangGraph", url: "https://docs.langchain.com/oss/python/langgraph", verified: true, channel: "web", author: "LangChain", publishedAt: undefined }],
      sourceEventId: "stream_test_000001",
      sourceStreamId: "stream_test",
      sourceStreamSeq: 1,
      sourceSeq: 1
    }) }]);
    expect(JSON.stringify(projection)).not.toContain("不进入持久事件");
    expect(JSON.stringify(projection)).not.toMatch(/raw|reasoning_content|providerBody/u);
  });

  it("把真实工具进度投影为单调计数，并只流入已读来源", () => {
    const candidate = mapSearchAgentEvent(source({
      type: "tool.progress",
      toolCallId: "call_one",
      toolName: "web_search",
      query: "LangGraph 官方文档",
      channel: "web",
      provider: "tavily",
      resultCount: 1,
      evidenceCount: 0,
      source: null
    }));
    const evidence = mapSearchAgentEvent(source({
      type: "tool.progress",
      toolCallId: "call_one",
      toolName: "web_search",
      query: "LangGraph 官方文档",
      channel: "web",
      provider: "tavily",
      resultCount: 1,
      evidenceCount: 1,
      source: { channel: "web", provider: "tavily", query: "LangGraph 官方文档", title: "LangGraph", url: "https://docs.langchain.com/oss/python/langgraph", snippet: "不进入持久事件", verified: true, author: null, published_at: null, metrics: {}, limitation: null, provenance }
    }));
    expect(candidate.events[0]).toEqual(expect.objectContaining({
      type: "tool.progress",
      payload: expect.objectContaining({ resultCount: 1, evidenceCount: 0, sources: [] })
    }));
    expect(evidence.events[0]).toEqual(expect.objectContaining({
      type: "tool.progress",
      payload: expect.objectContaining({
        resultCount: 1,
        evidenceCount: 1,
        sources: [expect.objectContaining({ url: "https://docs.langchain.com/oss/python/langgraph", verified: true })]
      })
    }));
    expect(JSON.stringify(evidence)).not.toContain("不进入持久事件");
  });

  it("把工具账号挑战投影为可点击验证链接，并忽略轮询心跳", () => {
    const challengeId = "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789";
    const required = mapSearchAgentEvent(source({
      type: "tool.verification.required",
      toolCallId: "call_xhs",
      challengeId,
      status: "pending",
      expiresAt: "2026-07-28T00:04:00Z",
      retryAfterMs: 2000,
      reasonCode: null,
      message: "等待使用小红书 App 扫码验证工具账号"
    }), "run_one");
    expect(required.events).toEqual([
      {
        type: "tool.updated",
        payload: expect.objectContaining({
          toolCallId: "call_xhs",
          status: "waiting",
          reasonCode: "CAPTCHA_REQUIRED",
          verificationStatus: "pending",
          verificationHref: `/workbench/verify/xiaohongshu/run_one/${challengeId}`
        })
      },
      {
        type: "run.status",
        payload: expect.objectContaining({ status: "waiting", reasonCode: "CAPTCHA_REQUIRED" })
      }
    ]);

    const heartbeat = mapSearchAgentEvent(source({
      type: "tool.verification.heartbeat",
      toolCallId: "call_xhs",
      challengeId,
      status: "pending",
      expiresAt: "2026-07-28T00:04:00Z",
      retryAfterMs: 2000,
      reasonCode: null,
      message: "等待使用小红书 App 扫码验证工具账号"
    }), "run_one");
    expect(heartbeat.events).toEqual([]);

    const resolved = mapSearchAgentEvent(source({
      type: "tool.verification.resolved",
      toolCallId: "call_xhs",
      challengeId,
      status: "succeeded",
      expiresAt: "2026-07-28T00:04:00Z",
      retryAfterMs: 2000,
      reasonCode: null,
      message: "小红书工具账号验证成功"
    }), "run_one");
    expect(resolved.events[0]).toEqual(expect.objectContaining({
      type: "tool.updated",
      payload: expect.objectContaining({
        status: "running",
        clearReasonCode: true,
        verificationStatus: "succeeded"
      })
    }));
    expect(resolved.events[1]).toEqual(expect.objectContaining({
      type: "run.status",
      payload: expect.objectContaining({ status: "running" })
    }));
    expect(JSON.stringify(required)).not.toMatch(/base64|xiaohongshu-mcp:18060|cookie/iu);
  });

  it("把 Reflector 的结构化来源说明映射到原工具行", () => {
    const projection = mapSearchAgentEvent(source({
      type: "tool.presented",
      toolCallId: "call_one",
      presentationSource: "model",
      sources: [{ url: "https://example.com/source", text: "该来源聚焦状态图中的工具循环。" }]
    }));
    expect(projection.events).toEqual([
      {
        type: "tool.updated",
        payload: expect.objectContaining({
          toolCallId: "call_one",
          sourcePresentationActive: true,
          sourcePresentationUrls: ["https://example.com/source"]
        })
      },
      {
        type: "tool.source.delta",
        payload: expect.objectContaining({
          toolCallId: "call_one",
          url: "https://example.com/source",
          delta: "该来源聚焦状态图中的工具循环。",
          presentationSource: "model"
        })
      },
      {
        type: "tool.updated",
        payload: expect.objectContaining({
          toolCallId: "call_one",
          sourcePresentationActive: false
        })
      }
    ]);
  });

  it("丢弃未读取、未核验等无效来源说明", () => {
    for (const text of [
      "但帖子详情/正文内容未读取。",
      "仅发现公开候选，尚未核验。",
      "受详情读取上限限制，未加载正文。",
      "正文仅包含标签，无有效对比内容。",
      "该笔记介绍了 LangGraph，但未展开具体对比说明。",
      "该教程未涉及 LangChain 与 LangSmith 的区别。"
    ]) {
      const projection = mapSearchAgentEvent(source({
        type: "tool.presented",
        toolCallId: "call_one",
        presentationSource: "model",
        sources: [{ url: "https://example.com/source", text }]
      }));
      expect(projection.events).toEqual([]);
    }
  });

  it("诚实映射 partial、failed、unknown 与 stopped", () => {
    const partial = mapSearchAgentEvent(source({ type: "run.completed", answerMarkdown: "证据不足的回答", answerSource: "model", answerModelCalls: 1, promptVersion: "2026-07-28.v2", responseStatus: "partial", citations: [], verificationPassed: false, stopReason: "SEARCH_UNAVAILABLE", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, cost_usd: 0 }, modelCalls: 2, toolCalls: 1, evidenceCount: 0 }));
    expect(partial.terminal).toEqual(expect.objectContaining({ kind: "completed", remember: false, payload: expect.objectContaining({ promptVersion: "2026-07-28.v2", partial: true, responseStatus: "partial", answerSource: "model", answerModelCalls: 1 }) }));

    const unknown = mapSearchAgentEvent(source({ type: "tool.unknown", toolCallId: "call_unknown", toolName: "web_search", query: "查询", channel: "web", reasonCode: "OUTCOME_UNKNOWN" }));
    expect(unknown.events[0]).toEqual(expect.objectContaining({ type: "tool.unknown", payload: expect.objectContaining({ status: "unknown", nextAction: "check_operation" }) }));

    const stopped = mapSearchAgentEvent(source({ type: "run.stopped", runId: "run_one", responseStatus: "partial", reasonCode: "USER_STOPPED" }));
    expect(stopped.terminal).toEqual(expect.objectContaining({ kind: "stopped", payload: expect.objectContaining({ reasonCode: "USER_STOPPED", partial: true, sourceEventId: "stream_test_000001" }) }));
  });

  it("direct completed 不误报外部证据核验", () => {
    const direct = mapSearchAgentEvent(source({ type: "run.completed", answerMarkdown: "直接回答", answerSource: "model", answerModelCalls: 1, promptVersion: "2026-07-28.v2", responseStatus: "completed", citations: [], verificationPassed: false, stopReason: "DIRECT_COMPLETED", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, cost_usd: 0 }, modelCalls: 2, toolCalls: 0, evidenceCount: 0 }));
    expect(direct.terminal).toEqual(expect.objectContaining({
      kind: "completed",
      remember: false,
      payload: expect.objectContaining({ partial: false, verificationPassed: false, summary: "回答已完成，本任务未使用外部证据核验" })
    }));
  });

  it("verification.completed 创建独立核验活动，不混入思考", () => {
    const projection = mapSearchAgentEvent(source({ type: "verification.completed", nodeRunId: "verify_cccccccccccccccccccccccccccccccc", passed: false, action: "rewrite", publicSummary: "引用格式需要修正", publicSummarySource: "model" }));
    expect(projection.events).toHaveLength(3);
    expect(projection.events[0]).toEqual(expect.objectContaining({
      type: "thinking.started",
      payload: expect.objectContaining({
        thinkingId: "verification:stream_test:verify_cccccccccccccccccccccccccccccccc",
        activityKind: "verification"
      })
    }));
    expect(projection.events[1]).toEqual(expect.objectContaining({
      type: "thinking.delta",
      payload: expect.objectContaining({ delta: "引用格式需要修正", publicSummarySource: "model", agent: "verifier", node: "verify" })
    }));
  });

  it("node.completed 的 verify 摘要由 verification.completed 唯一投影", () => {
    const projection = mapSearchAgentEvent(source({ type: "node.completed", node: "verify", nodeRunId: "verify_cccccccccccccccccccccccccccccccc", agent: "verifier", iteration: 1, durationMs: 20, publicSummary: "引用格式需要修正", publicSummarySource: "model" }));
    expect(projection.events).toEqual([]);
  });

  it("缺少 Agent 公开摘要时不制造固定核验文案", () => {
    const projection = mapSearchAgentEvent(source({
      type: "verification.completed",
      nodeRunId: "verify_direct_dddddddddddddddddddddddddddddddd",
      passed: false,
      action: "pass",
      publicSummary: null,
      publicSummarySource: null
    }));
    expect(projection.events).toEqual([]);
  });

  it("把 unknown_tool 显示为被阻止的固定安全工具行", () => {
    const started = mapSearchAgentEvent(source({ type: "tool.started", toolCallId: "call_unknown", toolName: "unknown_tool", query: "原计划查询", channel: "web", cached: false }));
    const failed = mapSearchAgentEvent(source({ type: "tool.failed", toolCallId: "call_unknown", toolName: "unknown_tool", query: "原计划查询", channel: "web", provider: "none", reasonCode: "UNKNOWN_TOOL", message: "Researcher 请求了未注册工具", retryable: false, durationMs: 0 }));
    expect(started.events[0].payload).toMatchObject({ name: "未知工具请求", summary: "正在拦截未注册工具请求" });
    expect(failed.events[0].payload).toMatchObject({ settlementSummary: "未知工具请求已被阻止", error: "UNKNOWN_TOOL", resultCount: 0, evidenceCount: 0 });
  });

  it("失败工具仍结算已经真实观察到的累计数量", () => {
    const projection = mapSearchAgentEvent(source({
      type: "tool.failed",
      toolCallId: "call_partial",
      toolName: "web_search",
      query: "LangGraph",
      channel: "xiaohongshu",
      provider: "xiaohongshu-mcp",
      reasonCode: "RUN_TIME_RESERVE",
      message: "为最终核验保留时间",
      retryable: false,
      resultCount: 5,
      evidenceCount: 1,
      durationMs: 18004
    }));

    expect(projection.events[0].payload).toMatchObject({
      toolCallId: "call_partial",
      resultCount: 5,
      evidenceCount: 1,
      durationMs: 18004,
      error: "RUN_TIME_RESERVE"
    });
  });

  it("node.failed 不生成固定思考文案，交给 run.failed 统一结算 error", () => {
    const projection = mapSearchAgentEvent(source({ type: "node.failed", node: "research", nodeRunId: "research_dddddddddddddddddddddddddddddddd", agent: "researcher", iteration: 0, reasonCode: "PROVIDER_UNAVAILABLE" }));
    expect(projection.events).toEqual([]);
  });

  it("把 Evidence 状态投影到原始 toolCallId 的公开来源", () => {
    const projection = mapSearchAgentEvent(source({
      type: "evidence.updated",
      evidenceId: "evidence_0123456789abcdef0123456789abcdef01234567",
      sourceId: "source_0123456789abcdef0123456789abcdef01234567",
      contentHash: "b".repeat(64),
      toolCallId: "call_one",
      url: "https://example.com/source",
      title: "公开标题",
      channel: "web",
      status: "cited",
      reasonCode: "ANSWER_CITED",
      updatedAt: "2026-07-28T00:00:01Z"
    }), "run_one");

    expect(projection.events).toEqual([{
      type: "tool.updated",
      payload: expect.objectContaining({
        toolCallId: "call_one",
        sources: [expect.objectContaining({
          url: "https://example.com/source",
          evidenceStatus: "cited",
          evidenceReasonCode: "ANSWER_CITED"
        })]
      })
    }]);
    expect(JSON.stringify(projection)).not.toContain("text");
  });
});
