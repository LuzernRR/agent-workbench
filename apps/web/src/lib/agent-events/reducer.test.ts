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
    expect(state.items["tool:search-1"]).toMatchObject({ status: "completed", summary: "24 sources", durationMs: 12000 });
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
    expect(state.items["assistant-1"]).toMatchObject({ text: "已核验答复", status: "streaming" });
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
      event(2, "plan.updated", { steps: [
        { id: "one", title: "读取项目", status: "done" },
        { id: "two", title: "完成测试", status: "in_progress" },
        { id: "three", title: "等待授权", status: "blocked", notes: "需要确认数据权限" }
      ] }),
      event(3, "run.completed", {})
    ]);
    expect(state.plan).toEqual([
      { id: "one", title: "读取项目", status: "done", notes: undefined },
      { id: "two", title: "完成测试", status: "in_progress", notes: undefined },
      { id: "three", title: "等待授权", status: "blocked", notes: "需要确认数据权限" }
    ]);
    expect(state.runTimings.run).toEqual({ startedAt: base.createdAt, completedAt: base.createdAt });
    expect(state.runStatuses.run).toBe("completed");
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
});
