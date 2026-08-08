import { createHash } from "node:crypto";
import { AGENT_EVENT_TYPES, type AgentEventType } from "@/lib/agent-events/types";
import type { SearchAgentEvent } from "@/server/search-agent/events";
import { mapSearchAgentEvent } from "@/server/search-agent/mapper";

export type PersistableTerminalSettlementEvent = {
  type: AgentEventType;
  payload: Record<string, unknown>;
};

export type DirectTerminalStatus = "failed" | "stopped";

export type DirectTerminalSettlement = {
  terminalStatus: DirectTerminalStatus;
  sourceEvents: SearchAgentEvent[];
  events: PersistableTerminalSettlementEvent[];
  terminalPayload: Record<string, unknown>;
};

export class TerminalSettlementConflictError extends Error {
  readonly code = "TERMINAL_SETTLEMENT_CONFLICT";

  constructor(message = "无 checkpoint 终态结算内容冲突") {
    super(message);
    this.name = "TerminalSettlementConflictError";
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TerminalSettlementConflictError("终态结算包含非有限数值");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  throw new TerminalSettlementConflictError("终态结算包含不可序列化值");
}

function canonicalEquals(left: unknown, right: unknown) {
  return canonicalJson(left) === canonicalJson(right);
}

export function terminalSettlementValuesEqual(left: unknown, right: unknown) {
  return canonicalEquals(left, right);
}

const publicEventTypes = new Set<string>(AGENT_EVENT_TYPES);
const sourceTerminalTypes = new Set<SearchAgentEvent["type"]>(["run.completed", "run.failed", "run.stopped"]);
const publicTerminalTypes = new Set<AgentEventType>(["run.completed", "run.failed", "run.cancelled"]);

export function validateDirectTerminalSettlement(runId: string, settlement: DirectTerminalSettlement) {
  if (!runId || settlement.sourceEvents.length < 1 || settlement.sourceEvents.length > 10_000) {
    throw new TerminalSettlementConflictError("无 checkpoint 终态 source 数量无效");
  }
  if (settlement.events.length > 10_000) {
    throw new TerminalSettlementConflictError("无 checkpoint 终态投影事件超过上限");
  }

  const terminal = settlement.sourceEvents.at(-1);
  if (
    !terminal
    || (terminal.type !== "run.failed" && terminal.type !== "run.stopped")
    || (terminal.type === "run.stopped" && terminal.runId !== runId)
  ) {
    throw new TerminalSettlementConflictError("唯一末尾终态必须是当前 Run 的 run.failed 或 run.stopped");
  }
  const terminalStatus: DirectTerminalStatus = terminal.type === "run.failed" ? "failed" : "stopped";
  if (settlement.terminalStatus !== terminalStatus) {
    throw new TerminalSettlementConflictError("终态类型与权威 source 不一致");
  }
  const streamId = terminal.streamId;
  const eventIds = new Set<string>();
  const streamSequences = new Set<number>();
  let previousSequence = 0;
  let terminalCount = 0;
  for (const event of settlement.sourceEvents) {
    if (event.type === "checkpoint.committed") {
      throw new TerminalSettlementConflictError("无 checkpoint 终态不能包含 checkpoint boundary");
    }
    if (
      event.streamId !== streamId
      || ("runId" in event && event.runId !== runId)
      || event.seq !== event.streamSeq
      || event.streamSeq <= previousSequence
      || eventIds.has(event.eventId)
      || streamSequences.has(event.streamSeq)
    ) {
      throw new TerminalSettlementConflictError("无 checkpoint 终态 source stream、eventId 或序号冲突");
    }
    if (sourceTerminalTypes.has(event.type)) terminalCount += 1;
    eventIds.add(event.eventId);
    streamSequences.add(event.streamSeq);
    previousSequence = event.streamSeq;
  }
  if (terminalCount !== 1) {
    throw new TerminalSettlementConflictError("无 checkpoint 终态必须唯一且位于 source 末尾");
  }

  for (const event of settlement.events) {
    if (
      !publicEventTypes.has(event.type)
      || publicTerminalTypes.has(event.type)
      || !event.payload
      || typeof event.payload !== "object"
      || Array.isArray(event.payload)
    ) {
      throw new TerminalSettlementConflictError("无 checkpoint 终态包含非法公开投影事件");
    }
  }

  const expectedEvents: PersistableTerminalSettlementEvent[] = [];
  for (const sourceEvent of settlement.sourceEvents.slice(0, -1)) {
    const projection = mapSearchAgentEvent(sourceEvent, runId);
    if (projection.terminal) {
      throw new TerminalSettlementConflictError("无 checkpoint 终态前不能出现其他终态投影");
    }
    expectedEvents.push(...projection.events);
  }
  if (!canonicalEquals(settlement.events, expectedEvents)) {
    throw new TerminalSettlementConflictError("公开投影必须由权威 source 逐条生成");
  }

  const terminalProjection = mapSearchAgentEvent(terminal, runId);
  const payload = settlement.terminalPayload;
  if (
    terminalProjection.terminal?.kind !== terminalStatus
    || !payload
    || typeof payload !== "object"
    || Array.isArray(payload)
    || !canonicalEquals(payload, terminalProjection.terminal.payload)
  ) {
    throw new TerminalSettlementConflictError("终态载荷与权威 source 不一致");
  }
  canonicalJson(settlement);
  return { terminal, terminalStatus };
}

export function canonicalDirectTerminalSettlementHash(runId: string, settlement: DirectTerminalSettlement) {
  const { terminal, terminalStatus } = validateDirectTerminalSettlement(runId, settlement);
  return createHash("sha256")
    .update(canonicalJson({ version: 2, runId, terminalStatus, usage: terminal.usage, settlement }), "utf8")
    .digest("hex");
}
