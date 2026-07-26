import { describe, expect, it } from "vitest";
import { createEmptyThreadState, reduceAgentEvent, reduceAgentEvents } from "./reducer";
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
});
