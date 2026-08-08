import { describe, expect, it } from "vitest";
import type { SearchAgentEvent } from "@/server/search-agent/events";
import { mapSearchAgentEvent } from "@/server/search-agent/mapper";
import {
  canonicalDirectTerminalSettlementHash,
  TerminalSettlementConflictError,
  validateDirectTerminalSettlement,
  type DirectTerminalSettlement
} from "./terminal-settlements";

const envelope = {
  version: 1 as const,
  streamId: "stream_direct",
  createdAt: "2026-08-08T00:00:00Z"
};

const processEvent = {
  ...envelope,
  eventId: "stream_direct_000001",
  streamSeq: 1,
  seq: 1,
  type: "tool.started" as const,
  toolCallId: "tool_call_real",
  toolName: "web_search" as const,
  query: "durable terminal settlement",
  channel: "web" as const,
  cached: false
};

const stoppedEvent = {
  ...envelope,
  eventId: "stream_direct_000002",
  streamSeq: 2,
  seq: 2,
  type: "run.stopped" as const,
  runId: "run_direct",
  responseStatus: "partial" as const,
  reasonCode: "USER_STOPPED",
  usage: { input_tokens: 17, output_tokens: 6, total_tokens: 23, cost_usd: 0.042 }
};

const failedEvent = {
  ...envelope,
  eventId: "stream_direct_000002",
  streamSeq: 2,
  seq: 2,
  type: "run.failed" as const,
  reasonCode: "SEARCH_UNAVAILABLE",
  message: "搜索服务不可用",
  usage: { input_tokens: 19, output_tokens: 5, total_tokens: 24, cost_usd: 0.051 }
};

function settlement(
  sourceEvents: SearchAgentEvent[] = [processEvent, stoppedEvent],
  runId = "run_direct"
): DirectTerminalSettlement {
  const events = sourceEvents.slice(0, -1).flatMap((event) => mapSearchAgentEvent(event, runId).events);
  const terminal = mapSearchAgentEvent(sourceEvents.at(-1)!, runId).terminal;
  if (terminal?.kind !== "failed" && terminal?.kind !== "stopped") throw new Error("测试终态无效");
  return { terminalStatus: terminal.kind, sourceEvents, events, terminalPayload: terminal.payload };
}

describe("direct stopped durable settlement", () => {
  it("接受无 boundary run.failed，并把 status、payload 与 usage 纳入 canonical hash", () => {
    const value = settlement([processEvent, failedEvent]);
    expect(validateDirectTerminalSettlement("run_direct", value)).toEqual({
      terminal: failedEvent,
      terminalStatus: "failed"
    });
    expect(value).toMatchObject({
      terminalStatus: "failed",
      terminalPayload: expect.objectContaining({ reasonCode: "SEARCH_UNAVAILABLE", usage: failedEvent.usage })
    });
    expect(canonicalDirectTerminalSettlementHash("run_direct", value))
      .not.toBe(canonicalDirectTerminalSettlementHash("run_direct", settlement()));
    expect(() => validateDirectTerminalSettlement("run_direct", {
      ...value,
      terminalStatus: "stopped"
    })).toThrow("终态类型与权威 source 不一致");
  });

  it("canonical hash 覆盖真实 source、公开 toolCallId、stopped payload 与 usage", () => {
    const value = settlement();
    expect(validateDirectTerminalSettlement("run_direct", value)).toEqual({
      terminal: stoppedEvent,
      terminalStatus: "stopped"
    });
    expect(value.events).toEqual([
      expect.objectContaining({
        type: "tool.started",
        payload: expect.objectContaining({ toolCallId: "tool_call_real", sourceEventId: processEvent.eventId })
      })
    ]);
    expect(canonicalDirectTerminalSettlementHash("run_direct", value)).toMatch(/^[a-f0-9]{64}$/u);
    const changed = settlement([processEvent, {
      ...stoppedEvent,
      usage: { ...stoppedEvent.usage, total_tokens: 24 }
    }]);
    expect(canonicalDirectTerminalSettlementHash("run_direct", changed))
      .not.toBe(canonicalDirectTerminalSettlementHash("run_direct", value));
  });

  it.each([
    ["不同 stream", [{ ...processEvent, streamId: "stream_foreign" }, stoppedEvent]],
    ["重复 eventId", [processEvent, { ...stoppedEvent, eventId: processEvent.eventId }]],
    ["非递增 streamSeq", [{ ...processEvent, streamSeq: 2, seq: 2 }, stoppedEvent]],
    ["错误 terminal runId", [processEvent, { ...stoppedEvent, runId: "run_foreign" }]],
    ["末尾不是唯一终态", [
      {
        ...processEvent,
        type: "run.failed" as const,
        reasonCode: "SEARCH_FAILED",
        message: "failed",
        usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1, cost_usd: 0 }
      },
      stoppedEvent
    ]]
  ] as const)("拒绝%s", (_label, sourceEvents) => {
    const invalid = {
      sourceEvents: sourceEvents as unknown as SearchAgentEvent[],
      events: [],
      terminalStatus: "stopped",
      terminalPayload: mapSearchAgentEvent(stoppedEvent, "run_direct").terminal!.payload
    } satisfies DirectTerminalSettlement;
    expect(() => validateDirectTerminalSettlement("run_direct", invalid)).toThrow(TerminalSettlementConflictError);
  });

  it("拒绝伪造或额外的公开投影事件，包括替换真实 toolCallId", () => {
    const value = settlement();
    expect(() => validateDirectTerminalSettlement("run_direct", {
      ...value,
      events: value.events.map((event) => ({
        ...event,
        payload: { ...event.payload, toolCallId: "tool_call_forged" }
      }))
    })).toThrow("公开投影必须由权威 source 逐条生成");
  });

  it("拒绝改写 stopped reason、partial 或 source 引用", () => {
    const value = settlement();
    expect(() => validateDirectTerminalSettlement("run_direct", {
      ...value,
      terminalPayload: { ...value.terminalPayload, reasonCode: "FORGED_STOP", partial: false }
    })).toThrow("终态载荷与权威 source 不一致");
    expect(() => validateDirectTerminalSettlement("run_direct", {
      ...value,
      terminalPayload: {
        ...value.terminalPayload,
        sourceEventId: "source_forged",
        usage: { ...stoppedEvent.usage, total_tokens: 99 }
      }
    })).toThrow("终态载荷与权威 source 不一致");
  });

  it("允许同 stream 的非连续严格递增序号", () => {
    const nonContiguous = settlement([
      processEvent,
      { ...stoppedEvent, eventId: "stream_direct_000003", streamSeq: 3, seq: 3 }
    ]);
    expect(() => validateDirectTerminalSettlement("run_direct", nonContiguous)).not.toThrow();
  });

  it.each([
    ["checkpoint boundary", [
      {
        ...processEvent,
        type: "checkpoint.committed" as const,
        checkpointId: "checkpoint_direct",
        parentCheckpointId: null,
        checkpointNs: "",
        checkpointSessionId: "session_direct",
        step: -1
      },
      stoppedEvent
    ]],
    ["seq 与 streamSeq 不一致", [{ ...processEvent, seq: 2 }, stoppedEvent]],
    ["重复 streamSeq", [processEvent, { ...stoppedEvent, eventId: "stream_direct_000009", streamSeq: 1, seq: 1 }]],
    ["terminal 不在末尾", [
      { ...stoppedEvent, eventId: "stream_direct_000001", streamSeq: 1, seq: 1 },
      { ...processEvent, eventId: "stream_direct_000002", streamSeq: 2, seq: 2 }
    ]]
  ] as const)("拒绝%s", (_label, sourceEvents) => {
    expect(() => validateDirectTerminalSettlement("run_direct", {
      terminalStatus: "stopped",
      sourceEvents: sourceEvents as unknown as SearchAgentEvent[],
      events: [],
      terminalPayload: mapSearchAgentEvent(stoppedEvent, "run_direct").terminal!.payload
    })).toThrow(TerminalSettlementConflictError);
  });

  it("canonical hash 对对象 key 重排稳定，并覆盖 source 顺序、toolCallId 与 runId", () => {
    const value = settlement();
    const reorderedPayload = {
      ...value,
      terminalPayload: {
        sourceSeq: value.terminalPayload.sourceSeq,
        usage: {
          cost_usd: stoppedEvent.usage.cost_usd,
          total_tokens: stoppedEvent.usage.total_tokens,
          output_tokens: stoppedEvent.usage.output_tokens,
          input_tokens: stoppedEvent.usage.input_tokens
        },
        partial: true,
        reasonCode: "USER_STOPPED",
        sourceStreamSeq: value.terminalPayload.sourceStreamSeq,
        sourceStreamId: value.terminalPayload.sourceStreamId,
        sourceEventId: value.terminalPayload.sourceEventId
      }
    };
    expect(canonicalDirectTerminalSettlementHash("run_direct", reorderedPayload))
      .toBe(canonicalDirectTerminalSettlementHash("run_direct", value));

    const changedTool = settlement([{ ...processEvent, toolCallId: "tool_call_changed" }, stoppedEvent]);
    expect(canonicalDirectTerminalSettlementHash("run_direct", changedTool))
      .not.toBe(canonicalDirectTerminalSettlementHash("run_direct", value));

    const secondProcess = {
      ...processEvent,
      eventId: "stream_direct_000002",
      streamSeq: 2,
      seq: 2,
      toolCallId: "tool_call_second"
    };
    const terminalThird = { ...stoppedEvent, eventId: "stream_direct_000003", streamSeq: 3, seq: 3 };
    const orderOne = settlement([processEvent, secondProcess, terminalThird]);
    const orderTwo = settlement([
      { ...secondProcess, eventId: processEvent.eventId, streamSeq: 1, seq: 1 },
      { ...processEvent, eventId: secondProcess.eventId, streamSeq: 2, seq: 2 },
      terminalThird
    ]);
    expect(canonicalDirectTerminalSettlementHash("run_direct", orderTwo))
      .not.toBe(canonicalDirectTerminalSettlementHash("run_direct", orderOne));

    const foreignTerminal = { ...stoppedEvent, runId: "run_other" };
    const otherRun = settlement([processEvent, foreignTerminal], "run_other");
    expect(canonicalDirectTerminalSettlementHash("run_other", otherRun))
      .not.toBe(canonicalDirectTerminalSettlementHash("run_direct", value));
  });
});
