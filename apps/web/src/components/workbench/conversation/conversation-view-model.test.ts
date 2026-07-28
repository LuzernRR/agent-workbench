import { describe, expect, it } from "vitest";
import { createEmptyThreadState, reduceAgentEvents } from "@/lib/agent-events/reducer";
import type { AgentEvent } from "@/lib/agent-events/types";
import { selectConversationTimelineItems, selectSearchSegmentTools } from "./conversation-view-model";

const base = {
  projectId: null,
  threadId: "thread-one",
  runId: "run-one",
  createdAt: "2026-07-28T00:00:00.000Z"
};

const event = (seq: number, type: AgentEvent["type"], payload: Record<string, unknown>): AgentEvent => ({
  ...base,
  id: `event-${seq}`,
  seq,
  type,
  payload
});

describe("conversation search projection", () => {
  it("projects three real toolCallIds as one search line while preserving the ledger", () => {
    const state = reduceAgentEvents(createEmptyThreadState(null, base.threadId), [
      event(1, "tool.started", { toolCallId: "search-1", name: "网页搜索", summary: "搜索：第一个查询", query: "第一个查询" }),
      event(2, "tool.completed", { toolCallId: "search-1", summary: "找到 5 条结果", resultCount: 5, evidenceCount: 1 }),
      event(3, "tool.started", { toolCallId: "search-2", name: "网页搜索", summary: "搜索：第二个查询", query: "第二个查询" }),
      event(4, "tool.completed", { toolCallId: "search-2", summary: "找到 5 条结果", resultCount: 5, evidenceCount: 2 }),
      event(5, "tool.started", { toolCallId: "search-3", name: "网页搜索", summary: "搜索：第三个查询", query: "第三个查询" })
    ]);

    expect(selectConversationTimelineItems(state).filter((item) => item.kind === "tool")).toHaveLength(1);
    expect(selectSearchSegmentTools(state, "tool:search-1").map((item) => item.toolCallId)).toEqual([
      "search-1",
      "search-2",
      "search-3"
    ]);
    expect(Object.keys(state.items).filter((id) => id.startsWith("tool:"))).toHaveLength(3);
  });

  it("does not collapse non-search tool activity", () => {
    const state = reduceAgentEvents(createEmptyThreadState(null, base.threadId), [
      event(1, "tool.started", { toolCallId: "context-1", name: "上下文读取", summary: "读取项目" }),
      event(2, "tool.started", { toolCallId: "command-1", name: "终端命令", summary: "运行测试" })
    ]);

    expect(selectConversationTimelineItems(state).filter((item) => item.kind === "tool")).toHaveLength(2);
  });

  it("只合并相邻的同类活动，保留思考-搜索-思考-核验-搜索-思考时序", () => {
    const state = reduceAgentEvents(createEmptyThreadState(null, base.threadId), [
      event(1, "thinking.started", { thinkingId: "thinking-1", activityKind: "thinking" }),
      event(2, "thinking.paragraph", { thinkingId: "thinking-1", paragraphId: "thinking-1:detail", text: "先明确问题边界" }),
      event(3, "thinking.completed", { thinkingId: "thinking-1" }),
      event(4, "thinking.started", { thinkingId: "thinking-2", activityKind: "thinking" }),
      event(5, "thinking.paragraph", { thinkingId: "thinking-2", paragraphId: "thinking-2:detail", text: "再形成首轮检索计划" }),
      event(6, "thinking.completed", { thinkingId: "thinking-2" }),
      event(7, "tool.started", { toolCallId: "search-1", name: "网页搜索", query: "首轮查询" }),
      event(8, "tool.completed", { toolCallId: "search-1", resultCount: 5, evidenceCount: 1 }),
      event(9, "tool.started", { toolCallId: "search-2", name: "网页搜索", query: "首轮补充" }),
      event(10, "tool.completed", { toolCallId: "search-2", resultCount: 5, evidenceCount: 2 }),
      event(11, "thinking.started", { thinkingId: "thinking-3", activityKind: "thinking" }),
      event(12, "thinking.paragraph", { thinkingId: "thinking-3", paragraphId: "thinking-3:detail", text: "搜索后重新评估证据" }),
      event(13, "thinking.completed", { thinkingId: "thinking-3" }),
      event(14, "thinking.started", { thinkingId: "verification-1", activityKind: "verification" }),
      event(15, "thinking.paragraph", { thinkingId: "verification-1", paragraphId: "verification-1:detail", text: "发现一处证据缺口" }),
      event(16, "thinking.completed", { thinkingId: "verification-1" }),
      event(17, "thinking.started", { thinkingId: "verification-2", activityKind: "verification" }),
      event(18, "thinking.paragraph", { thinkingId: "verification-2", paragraphId: "verification-2:detail", text: "决定补充来源" }),
      event(19, "thinking.completed", { thinkingId: "verification-2" }),
      event(20, "tool.started", { toolCallId: "search-3", name: "网页搜索", query: "核验后补查" }),
      event(21, "tool.completed", { toolCallId: "search-3", resultCount: 5, evidenceCount: 1 }),
      event(22, "thinking.started", { thinkingId: "thinking-4", activityKind: "thinking" }),
      event(23, "thinking.paragraph", { thinkingId: "thinking-4", paragraphId: "thinking-4:detail", text: "结合补查结果形成答案" }),
      event(24, "thinking.completed", { thinkingId: "thinking-4" })
    ]);

    const timeline = selectConversationTimelineItems(state);
    expect(timeline.map((item) => item.kind === "thinking" ? item.activityKind : item.kind)).toEqual([
      "thinking",
      "tool",
      "thinking",
      "verification",
      "tool",
      "thinking"
    ]);
    expect(timeline[0]).toMatchObject({ kind: "thinking", paragraphs: [{ text: "先明确问题边界" }, { text: "再形成首轮检索计划" }] });
    expect(timeline[3]).toMatchObject({ kind: "thinking", activityKind: "verification", paragraphs: [{ text: "发现一处证据缺口" }, { text: "决定补充来源" }] });
    expect(selectSearchSegmentTools(state, "tool:search-1").map((item) => item.toolCallId)).toEqual(["search-1", "search-2"]);
    expect(selectSearchSegmentTools(state, "tool:search-3").map((item) => item.toolCallId)).toEqual(["search-3"]);
  });
});
