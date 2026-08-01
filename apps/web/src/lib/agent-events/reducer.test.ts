import { describe, expect, it } from "vitest";
import { createEmptyThreadState, reduceAgentEvent, reduceAgentEvents, truncateThreadStateForEdit } from "./reducer";
import type { AgentEvent } from "./types";

const base = { projectId: "project", threadId: "thread", runId: "run", createdAt: "2026-07-22T00:00:00.000Z" };
const event = (seq: number, type: AgentEvent["type"], payload: Record<string, unknown>): AgentEvent => ({ ...base, id: `event-${seq}`, seq, type, payload });

describe("reduceAgentEvent", () => {
  it("updates one tool row for every event sharing a toolCallId", () => {
    const state = reduceAgentEvents(createEmptyThreadState("project", "thread"), [
      event(1, "tool.started", { toolCallId: "search-1", name: "Search", summary: "Preparing" }),
      event(2, "tool.updated", { toolCallId: "search-1", summary: "8 / 24", progress: { current: 8, total: 24 } }),
      event(3, "tool.completed", { toolCallId: "search-1", summary: "24 sources", durationMs: 12000 })
    ]);
    expect(state.itemOrder).toEqual(["tool:search-1"]);
    expect(state.items["tool:search-1"]).toMatchObject({
      status: "completed",
      summary: "Preparing",
      settlementSummary: "24 sources",
      durationMs: 12000
    });
  });

  it("保留完整安全工具账本字段并把 unknown 作为唯一工具行终态", () => {
    const usage = {
      toolId: "web_search",
      toolVersion: "1",
      provider: "tavily",
      pricingVersion: "unpriced-v1",
      currency: "USD",
      calls: 1,
      attempts: 1,
      units: 0,
      bytes: 0,
      resultCount: 0,
      searchQueries: 1,
      pageReads: 0,
      estimatedCostUsd: "0",
      actualCostUsd: null,
      possibleDuplicateCostUsd: "0"
    };
    const state = reduceAgentEvents(createEmptyThreadState("project", "thread"), [
      event(1, "tool.started", {
        toolCallId: "search-ledger",
        planStepId: "step_one",
        researchBatchId: "research_batch_one",
        researchResultId: "research_result_one",
        operationRef: "operation_1234567890abcdef",
        attempt: 1,
        inputHash: "a".repeat(64),
        name: "网页搜索",
        summary: "搜索中"
      }),
      event(2, "tool.unknown", {
        toolCallId: "search-ledger",
        operationRef: "operation_1234567890abcdef",
        attempt: 1,
        inputHash: "a".repeat(64),
        status: "unknown",
        reasonCode: "LEDGER_SETTLEMENT_UNKNOWN",
        nextAction: "check_operation",
        usage,
        durationMs: 321
      })
    ]);

    expect(state.itemOrder).toEqual(["tool:search-ledger"]);
    expect(state.items["tool:search-ledger"]).toMatchObject({
      status: "unknown",
      planStepId: "step_one",
      researchBatchId: "research_batch_one",
      researchResultId: "research_result_one",
      operationRef: "operation_1234567890abcdef",
      attempt: 1,
      inputHash: "a".repeat(64),
      nextAction: "check_operation",
      usage,
      durationMs: 321
    });
  });

  it("安全验证等待与成功状态保留同一工具调用和受控链接", () => {
    const challengeId = "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789";
    const state = reduceAgentEvents(createEmptyThreadState("project", "thread"), [
      event(1, "run.started", {}),
      event(2, "tool.started", { toolCallId: "xhs-1", name: "小红书搜索", summary: "搜索：油敏皮通勤防晒", channel: "xiaohongshu" }),
      event(3, "tool.updated", {
        toolCallId: "xhs-1",
        status: "waiting",
        reasonCode: "CAPTCHA_REQUIRED",
        verificationStatus: "pending",
        verificationHref: `/workbench/verify/xiaohongshu/run/${challengeId}`,
        verificationExpiresAt: "2026-07-22T00:04:00.000Z",
        verificationMessage: "等待扫码"
      }),
      event(4, "run.status", { status: "waiting" }),
      event(5, "tool.updated", {
        toolCallId: "xhs-1",
        status: "running",
        clearReasonCode: true,
        verificationStatus: "succeeded",
        verificationMessage: "验证成功"
      }),
      event(6, "run.status", { status: "running" })
    ]);

    expect(state.itemOrder).toEqual(["tool:xhs-1"]);
    expect(state.items["tool:xhs-1"]).toMatchObject({
      status: "running",
      reasonCode: undefined,
      verificationStatus: "succeeded",
      verificationHref: `/workbench/verify/xiaohongshu/run/${challengeId}`,
      verificationMessage: "验证成功"
    });
    expect(state.runStatus).toBe("running");
  });

  it("从 started/completed 事件时间推导真实工具耗时，不把终态显示为执行中", () => {
    const started = event(1, "tool.started", { toolCallId: "search-duration", name: "网页搜索", summary: "搜索中" });
    const completed = {
      ...event(2, "tool.completed", { toolCallId: "search-duration", summary: "找到来源" }),
      createdAt: "2026-07-22T00:00:01.250Z"
    };
    const state = reduceAgentEvents(createEmptyThreadState("project", "thread"), [started, completed]);
    expect(state.items["tool:search-duration"]).toMatchObject({ status: "completed", durationMs: 1250 });
  });

  it("ignores duplicate or out-of-order events", () => {
    const first = reduceAgentEvent(createEmptyThreadState("project", "thread"), event(2, "run.created", {}));
    expect(reduceAgentEvent(first, event(2, "run.failed", { error: "duplicate" }))).toBe(first);
    expect(reduceAgentEvent(first, event(1, "run.failed", { error: "older" }))).toBe(first);
  });

  it("resets an invalidated streamed draft before appending the retry", () => {
    const state = reduceAgentEvents(createEmptyThreadState("project", "thread"), [
      event(1, "message.started", { messageId: "assistant-1", role: "assistant" }),
      event(2, "text.delta", { messageId: "assistant-1", delta: "未通过门禁的草稿" }),
      event(3, "message.reset", { messageId: "assistant-1", text: "正在重新生成" }),
      event(4, "message.reset", { messageId: "assistant-1", text: "" }),
      event(5, "text.delta", { messageId: "assistant-1", delta: "已核验答复" })
    ]);
    expect(state.items["assistant-1"]).toMatchObject({ text: "未通过门禁的草稿已核验答复", status: "streaming" });
  });

  it("message.completed cannot replace an already visible streamed prefix", () => {
    const state = reduceAgentEvents(createEmptyThreadState("project", "thread"), [
      event(1, "message.started", { messageId: "assistant-append-only", role: "assistant" }),
      event(2, "text.delta", { messageId: "assistant-append-only", delta: "已经显示的前缀" }),
      event(3, "message.completed", { messageId: "assistant-append-only", text: "另一份终态全文" })
    ]);

    expect(state.items["assistant-append-only"]).toMatchObject({
      text: "已经显示的前缀",
      status: "completed"
    });
  });

  it("只保存模型生成的自然段思考结果并在停止时收口", () => {
    const running = reduceAgentEvents(createEmptyThreadState("project", "thread"), [
      event(1, "run.started", {}),
      event(2, "thinking.started", { thinkingId: "thinking-1" }),
      event(3, "thinking.paragraph", { thinkingId: "thinking-1", paragraphId: "paragraph-1", text: "两个方案需要使用同一组标准进行比较。" }),
      event(4, "thinking.paragraph", { thinkingId: "thinking-1", paragraphId: "paragraph-2", text: "现有信息适合先列出取舍条件，再给出适用场景。" })
    ]);
    expect(running.itemOrder).toEqual(["thinking-1"]);
    expect(running.items["thinking-1"]).toMatchObject({
      kind: "thinking",
      status: "streaming",
      paragraphs: [
        { id: "paragraph-1", text: "两个方案需要使用同一组标准进行比较。" },
        { id: "paragraph-2", text: "现有信息适合先列出取舍条件，再给出适用场景。" }
      ]
    });
    expect(JSON.stringify(running)).not.toContain("reasoning_content");

    const stopped = reduceAgentEvent(running, event(5, "run.cancelled", {}));
    expect(stopped.items["thinking-1"]).toMatchObject({ status: "stopped" });
  });

  it("摘要失败或思考期间停止时删除没有模型内容的空块", () => {
    const started = reduceAgentEvents(createEmptyThreadState("project", "thread"), [
      event(1, "run.started", {}),
      event(2, "thinking.started", { thinkingId: "thinking-empty" })
    ]);
    const failedSummary = reduceAgentEvent(started, event(3, "thinking.completed", { thinkingId: "thinking-empty", paragraphCount: 0 }));
    expect(failedSummary.items["thinking-empty"]).toBeUndefined();
    expect(failedSummary.itemOrder).not.toContain("thinking-empty");

    const stopped = reduceAgentEvent(started, event(3, "run.cancelled", {}));
    expect(stopped.items["thinking-empty"]).toBeUndefined();
    expect(stopped.itemOrder).not.toContain("thinking-empty");
  });

  it("节点失败摘要由 run.failed 统一结算为 error 状态", () => {
    const state = reduceAgentEvents(createEmptyThreadState("project", "thread"), [
      event(1, "run.started", {}),
      event(2, "thinking.started", { thinkingId: "thinking:research_failed" }),
      event(3, "thinking.paragraph", { thinkingId: "thinking:research_failed", paragraphId: "failed", text: "【搜索 Agent】该步骤未能完成" }),
      event(4, "run.failed", { message: "Search Agent 运行失败" })
    ]);
    expect(state.items["thinking:research_failed"]).toMatchObject({ status: "error", paragraphs: [{ text: "【搜索 Agent】该步骤未能完成" }] });
  });

  it("resolves an inline approval and adds server-created artifacts", () => {
    const artifact = { id: "artifact-1", name: "Report", kind: "report" as const, mimeType: "text/markdown", content: "# Report", version: 1, createdAt: base.createdAt };
    const state = reduceAgentEvents(createEmptyThreadState("project", "thread"), [
      event(1, "approval.required", { approvalId: "approval-1", title: "Write file?", description: "artifacts/report.md" }),
      event(2, "approval.resolved", { approvalId: "approval-1", decision: "allow_once" }),
      event(3, "artifact.created", { artifact })
    ]);
    expect(state.items["approval:approval-1"]).toMatchObject({ status: "approved" });
    expect(state.artifacts).toEqual([artifact]);
    expect(state.runStatus).toBe("running");
  });

  it("uses the latest event-driven plan and records run timing", () => {
    const state = reduceAgentEvents(createEmptyThreadState("project", "thread"), [
      event(1, "run.created", {}),
      event(2, "plan.updated", { planId: "plan-one", revision: 2, steps: [
        { id: "one", title: "读取项目", status: "done" },
        { id: "two", title: "完成测试", status: "in_progress" },
        { id: "three", title: "等待授权", status: "blocked", notes: "需要确认数据权限" }
      ] }),
      event(3, "run.completed", {})
    ]);
    expect(state.plan).toEqual([
      { id: "one", planId: "plan-one", revision: 2, title: "读取项目", status: "done", notes: undefined },
      { id: "two", planId: "plan-one", revision: 2, title: "完成测试", status: "in_progress", notes: undefined },
      { id: "three", planId: "plan-one", revision: 2, title: "等待授权", status: "blocked", notes: "需要确认数据权限" }
    ]);
    expect(state.planId).toBe("plan-one");
    expect(state.planRevision).toBe(2);
    expect(state.runTimings.run).toEqual({ startedAt: base.createdAt, completedAt: base.createdAt });
    expect(state.runStatuses.run).toBe("completed");
  });

  it("拒绝较旧计划修订覆盖已持久化快照", () => {
    const state = reduceAgentEvents(createEmptyThreadState("project", "thread"), [
      event(1, "plan.updated", { planId: "plan-new", revision: 3, steps: [{ id: "new", title: "新计划", status: "running" }] }),
      event(2, "plan.updated", { planId: "plan-old", revision: 2, steps: [{ id: "old", title: "旧计划", status: "done" }] })
    ]);

    expect(state.planId).toBe("plan-new");
    expect(state.planRevision).toBe(3);
    expect(state.plan[0]).toMatchObject({ id: "new", status: "in_progress" });
  });

  it.each(["run.completed", "run.failed", "run.cancelled"] as const)("在 %s 终态把悬空工具诚实结算为 unknown", (terminalType) => {
    const state = reduceAgentEvents(createEmptyThreadState("project", "thread"), [
      event(1, "run.started", {}),
      event(2, "tool.started", { toolCallId: "search-recovery", name: "网页搜索", summary: "搜索中", query: "恢复测试" }),
      event(3, terminalType, terminalType === "run.failed" ? { message: "恢复失败" } : {})
    ]);
    expect(state.items["tool:search-recovery"]).toMatchObject({
      status: "unknown",
      summary: "工具结果状态未知",
      error: "OUTCOME_UNKNOWN"
    });
  });

  it("direct completed 显示未使用外部证据核验的中性说明", () => {
    const state = reduceAgentEvents(createEmptyThreadState("project", "thread"), [
      event(1, "run.started", {}),
      event(2, "run.completed", { partial: false, verificationPassed: false, summary: "回答已完成，本任务未使用外部证据核验" })
    ]);
    expect(state.items["status:event-2"]).toMatchObject({ tone: "neutral", label: "回答已完成，本任务未使用外部证据核验" });
  });

  it("只接收无凭据 HTTP(S) 工具来源", () => {
    const state = reduceAgentEvents(createEmptyThreadState("project", "thread"), [
      event(1, "tool.started", { toolCallId: "search-safe", name: "网页搜索", summary: "搜索中" }),
      event(2, "tool.completed", { toolCallId: "search-safe", sources: [
        { title: "安全来源", url: "https://example.com/source", verified: true },
        { title: "脚本", url: "javascript:alert(1)", verified: false },
        { title: "凭据", url: "https://user:pass@example.com/", verified: false }
      ] })
    ]);
    expect(state.items["tool:search-safe"]).toMatchObject({ sources: [{ title: "安全来源", url: "https://example.com/source", verified: true }] });
  });

  it("只按 URL 把 Agent 逐行说明更新到对应真实来源", () => {
    const state = reduceAgentEvents(createEmptyThreadState("project", "thread"), [
      event(1, "tool.started", { toolCallId: "search-presented", name: "X 搜索", summary: "搜索中", channel: "x" }),
      event(2, "tool.completed", { toolCallId: "search-presented", sources: [
        { title: "原始标题", url: "https://x.com/example/status/1", verified: true, channel: "x", author: "example" }
      ] }),
      event(3, "tool.updated", { toolCallId: "search-presented", sourcePresentations: [
        { url: "https://x.com/example/status/1", text: "这条公开帖子讨论了状态图的工具循环。" },
        { url: "https://invented.example/item", text: "不能写入" }
      ] })
    ]);
    expect(state.items["tool:search-presented"]).toMatchObject({
      channel: "x",
      sources: [{
        url: "https://x.com/example/status/1",
        displayText: "这条公开帖子讨论了状态图的工具循环。"
      }]
    });
  });

  it("工具进度计数只单调增加，并逐个合并已读来源", () => {
    const state = reduceAgentEvents(createEmptyThreadState("project", "thread"), [
      event(1, "tool.started", { toolCallId: "search-progress", name: "网页搜索", summary: "搜索中" }),
      event(2, "tool.progress", { toolCallId: "search-progress", resultCount: 1, evidenceCount: 0, sources: [] }),
      event(3, "tool.progress", { toolCallId: "search-progress", resultCount: 2, evidenceCount: 1, sources: [
        { title: "来源一", url: "https://example.com/one", verified: true }
      ] }),
      event(4, "tool.progress", { toolCallId: "search-progress", resultCount: 1, evidenceCount: 0, sources: [
        { title: "来源二", url: "https://example.com/two", verified: true }
      ] })
    ]);
    expect(state.items["tool:search-progress"]).toMatchObject({
      resultCount: 2,
      evidenceCount: 1,
      sources: [
        { url: "https://example.com/one", verified: true },
        { url: "https://example.com/two", verified: true }
      ]
    });
  });

  it("流式追加公开思考文段，并拒绝无效来源说明", () => {
    const state = reduceAgentEvents(createEmptyThreadState("project", "thread"), [
      event(1, "thinking.started", { thinkingId: "thinking-stream", activityKind: "thinking" }),
      event(2, "thinking.delta", { thinkingId: "thinking-stream", paragraphId: "paragraph", delta: "先核对" }),
      event(3, "thinking.delta", { thinkingId: "thinking-stream", paragraphId: "paragraph", delta: "来源。" }),
      event(4, "tool.started", { toolCallId: "search-invalid", name: "网页搜索", summary: "搜索中" }),
      event(5, "tool.completed", { toolCallId: "search-invalid", sources: [
        { title: "来源", url: "https://example.com/source", verified: true }
      ] }),
      event(6, "tool.updated", { toolCallId: "search-invalid", sourcePresentations: [
        { url: "https://example.com/source", text: "但帖子详情/正文内容未读取。" },
        { url: "https://example.com/source", text: "正文仅包含标签，无有效对比内容。" },
        { url: "https://example.com/source", text: "该教程未涉及 LangChain 与 LangSmith 的区别。" }
      ] })
    ]);
    expect(state.items["thinking-stream"]).toMatchObject({
      paragraphs: [{ id: "paragraph", text: "先核对来源。" }]
    });
    expect(state.items["tool:search-invalid"]).toMatchObject({
      sources: [{ url: "https://example.com/source", displayText: undefined }]
    });
  });

  it("只向已核验来源逐字追加展示文字，并在完成后结束展示态", () => {
    const state = reduceAgentEvents(createEmptyThreadState("project", "thread"), [
      event(1, "tool.started", { toolCallId: "search-source-stream", name: "小红书搜索", summary: "搜索中" }),
      event(2, "tool.completed", { toolCallId: "search-source-stream", sources: [
        { title: "已读取来源", url: "https://example.com/read", verified: true },
        { title: "候选来源", url: "https://example.com/candidate", verified: false }
      ] }),
      event(3, "tool.updated", { toolCallId: "search-source-stream", sourcePresentationActive: true, sourcePresentationUrls: ["https://example.com/read"] }),
      event(4, "tool.source.delta", { toolCallId: "search-source-stream", url: "https://example.com/read", delta: "这条" }),
      event(5, "tool.source.delta", { toolCallId: "search-source-stream", url: "https://example.com/read", delta: "笔记有实质内容。" }),
      event(6, "tool.source.delta", { toolCallId: "search-source-stream", url: "https://example.com/candidate", delta: "不得展示" }),
      event(7, "tool.updated", { toolCallId: "search-source-stream", sourcePresentationActive: true, sourcePresentationUrls: ["https://example.com/read"] }),
      event(8, "tool.source.delta", { toolCallId: "search-source-stream", url: "https://example.com/read", delta: "重新润色后的有效说明。" }),
      event(9, "tool.updated", { toolCallId: "search-source-stream", sourcePresentationActive: false })
    ]);
    expect(state.items["tool:search-source-stream"]).toMatchObject({
      status: "completed",
      sourcePresentationActive: false,
      sources: [
        { url: "https://example.com/read", verified: true, displayText: "这条笔记有实质内容。重新润色后的有效说明。" },
        { url: "https://example.com/candidate", verified: false, displayText: undefined }
      ]
    });
  });

  it("把正文规范 URL 的末尾斜杠说明挂回同一条搜索来源", () => {
    const state = reduceAgentEvents(createEmptyThreadState("project", "thread"), [
      event(1, "tool.started", { toolCallId: "search-canonical", name: "网页搜索", summary: "搜索中" }),
      event(2, "tool.completed", { toolCallId: "search-canonical", resultCount: 1, evidenceCount: 1, sources: [
        { title: "AWS LangChain", url: "https://aws.amazon.com/cn/what-is/langchain", verified: true, channel: "web" }
      ] }),
      event(3, "tool.updated", {
        toolCallId: "search-canonical",
        sourcePresentationActive: true,
        sourcePresentationUrls: ["https://aws.amazon.com/cn/what-is/langchain/"]
      }),
      event(4, "tool.source.delta", {
        toolCallId: "search-canonical",
        url: "https://aws.amazon.com/cn/what-is/langchain/",
        delta: "该来源解释了 LangChain 的组件与应用边界。"
      }),
      event(5, "tool.updated", { toolCallId: "search-canonical", sourcePresentationActive: false })
    ]);

    expect(state.items["tool:search-canonical"]).toMatchObject({
      evidenceCount: 1,
      sources: [{
        url: "https://aws.amazon.com/cn/what-is/langchain",
        verified: true,
        displayText: "该来源解释了 LangChain 的组件与应用边界。"
      }]
    });
  });

  it("编辑用户消息时立即截断目标运行和全部下游内容", () => {
    const state = reduceAgentEvents(createEmptyThreadState("project", "thread"), [
      event(1, "run.created", {}),
      event(2, "message.started", { messageId: "user-1", role: "user", text: "旧问题" }),
      event(3, "message.completed", { messageId: "user-1", text: "旧问题" }),
      event(4, "message.started", { messageId: "assistant-1", role: "assistant" }),
      event(5, "message.completed", { messageId: "assistant-1", text: "旧回复" }),
      { ...event(6, "run.created", {}), runId: "run-2" },
      { ...event(7, "message.started", { messageId: "user-2", role: "user", text: "下游问题" }), runId: "run-2" },
      { ...event(8, "message.completed", { messageId: "user-2", text: "下游问题" }), runId: "run-2" }
    ]);
    const populated = {
      ...state,
      artifacts: [{ id: "artifact-1", name: "旧成果", kind: "report" as const, mimeType: "text/markdown", content: "旧内容", version: 1, createdAt: base.createdAt }],
      files: [{ id: "file-1", path: "old.md", name: "old.md", status: "created" as const, language: "markdown", content: "旧内容", version: 1 }],
      logs: [{ id: "log-1", level: "info" as const, actor: "助手", content: "旧日志", createdAt: base.createdAt }],
      plan: [{ id: "step-1", title: "旧计划", status: "done" as const }],
      planUpdatedAt: base.createdAt
    };

    const next = truncateThreadStateForEdit(populated, "user-1", "新问题");

    expect(next.itemOrder).toEqual(["user-1"]);
    expect(next.items["user-1"]).toMatchObject({ text: "新问题", status: "completed" });
    expect(next.items["assistant-1"]).toBeUndefined();
    expect(next.items["user-2"]).toBeUndefined();
    expect(next.artifacts).toEqual([]);
    expect(next.files).toEqual([]);
    expect(next.logs).toEqual([]);
    expect(next.plan).toEqual([]);
    expect(next.runStatuses).toEqual({});
    expect(next.runTimings).toEqual({});
    expect(next.runStatus).toBe("queued");
  });

  it("Evidence 状态单调归并并拒绝重放倒退与身份漂移", () => {
    const identity = {
      evidenceId: "evidence_0123456789abcdef0123456789abcdef01234567",
      sourceId: "source_0123456789abcdef0123456789abcdef01234567",
      contentHash: "c".repeat(64)
    };
    const metadata = (evidenceStatus: string, evidenceReasonCode: string) => ({
      ...identity,
      evidenceStatus,
      evidenceReasonCode,
      evidenceUpdatedAt: "2026-08-01T00:00:01Z"
    });
    const lifecycleEvents = [
      event(1, "tool.started", { toolCallId: "search-evidence", name: "网页搜索", summary: "搜索中" }),
      event(2, "tool.completed", { toolCallId: "search-evidence", sources: [{ title: "来源", url: "https://example.com/source", verified: true }] }),
      event(3, "tool.updated", { toolCallId: "search-evidence", sources: [{ title: "来源", url: "https://example.com/source", verified: true, ...metadata("read", "BODY_READ") }] }),
      event(4, "tool.updated", { toolCallId: "search-evidence", sources: [{ title: "来源", url: "https://example.com/source", verified: true, ...metadata("accepted", "SOURCE_PRESENTED") }] }),
      event(5, "tool.updated", { toolCallId: "search-evidence", sources: [{ title: "来源", url: "https://example.com/source", verified: true, ...metadata("cited", "ANSWER_CITED") }] }),
      event(6, "tool.updated", { toolCallId: "search-evidence", sources: [{ title: "来源", url: "https://example.com/source", verified: true, ...metadata("read", "BODY_READ") }] }),
      event(7, "tool.updated", { toolCallId: "search-evidence", sources: [{ title: "来源", url: "https://example.com/source", verified: true, ...metadata("cited", "ANSWER_CITED"), evidenceId: "evidence_conflict" }] })
    ];
    const state = reduceAgentEvents(
      createEmptyThreadState("project", "thread"),
      lifecycleEvents
    );

    expect(state.items["tool:search-evidence"]).toMatchObject({
      sources: [{ ...identity, evidenceStatus: "cited", evidenceReasonCode: "ANSWER_CITED" }]
    });
    expect(reduceAgentEvents(
      createEmptyThreadState("project", "thread"),
      lifecycleEvents
    )).toEqual(state);
  });
});
