import { parseV2ThreadQueueEvent } from "./adapter";
import type {
  V2AdapterErrorCode,
  V2EventSource,
  V2RunQueueEntry,
  V2Scope,
  V2ThreadQueueEvent
} from "./types";

export type V2QueueMergeErrorCode =
  | V2AdapterErrorCode
  | "THREAD_ID_MISMATCH"
  | "SCOPE_MISMATCH"
  | "SOURCE_MISMATCH"
  | "QUEUE_EVENT_ID_DUPLICATE"
  | "QUEUE_CURSOR_INVALID"
  | "QUEUE_REVISION_CONFLICT"
  | "QUEUE_ORDER_INVALID"
  | "QUEUE_ACTIVE_RUN_CONFLICT"
  | "QUEUE_PAUSE_INVALID";

export interface V2QueueState {
  readonly threadId: string;
  readonly scope: V2Scope;
  readonly source: V2EventSource | null;
  readonly cursor: number;
  readonly revision: number;
  readonly eventIds: Readonly<Record<string, true>>;
  readonly entries: readonly V2RunQueueEntry[];
  readonly activeRunIds: readonly string[];
  readonly autoStartNext: boolean;
  readonly paused: boolean;
  readonly pauseReason: V2ThreadQueueEvent["payload"]["pauseReason"];
  readonly lastTransition: V2ThreadQueueEvent["payload"]["transition"] | null;
}

export type V2QueueMergeResult =
  | { readonly accepted: true; readonly state: V2QueueState; readonly event: V2ThreadQueueEvent }
  | { readonly accepted: false; readonly state: V2QueueState; readonly errorCode: V2QueueMergeErrorCode };

export interface V2RejectedQueueInput {
  readonly index: number;
  readonly errorCode: V2QueueMergeErrorCode;
}

export function createV2QueueState(threadId: string, scope: V2Scope): V2QueueState {
  return {
    threadId,
    scope,
    source: null,
    cursor: 0,
    revision: 0,
    eventIds: {},
    entries: [],
    activeRunIds: [],
    autoStartNext: false,
    paused: false,
    pauseReason: null,
    lastTransition: null
  };
}

function sameScope(left: V2Scope, right: V2Scope) {
  return left.tenantId === right.tenantId
    && left.actorId === right.actorId
    && left.visitorId === right.visitorId
    && left.projectId === right.projectId
    && left.threadId === right.threadId;
}

function validQueueReadModel(state: V2QueueState, event: V2ThreadQueueEvent) {
  if (event.payload.activeRunIds.length > 1) return "QUEUE_ACTIVE_RUN_CONFLICT" as const;
  const activeEntries = event.payload.entries.filter((entry) => entry.status === "starting" || entry.status === "running");
  if (activeEntries.length > 1) return "QUEUE_ACTIVE_RUN_CONFLICT" as const;
  if (activeEntries.some((entry) => !entry.runId || !event.payload.activeRunIds.includes(entry.runId))) {
    return "QUEUE_ACTIVE_RUN_CONFLICT" as const;
  }
  if (event.payload.activeRunIds.some((runId) => !activeEntries.some((entry) => entry.runId === runId))) {
    return "QUEUE_ACTIVE_RUN_CONFLICT" as const;
  }

  const queued = event.payload.entries
    .filter((entry) => entry.status === "queued")
    .sort((left, right) => left.position - right.position);
  if (queued.some((entry, index) => entry.position !== index)) return "QUEUE_ORDER_INVALID" as const;
  if (queued.some((entry, index) =>
    index > 0 && Date.parse(queued[index - 1].createdAt) > Date.parse(entry.createdAt)
  )) return "QUEUE_ORDER_INVALID" as const;
  const entryIds = event.payload.entries.map((entry) => entry.queueEntryId);
  const idempotencyKeys = event.payload.entries.map((entry) => entry.idempotencyKey);
  if (new Set(entryIds).size !== entryIds.length || new Set(idempotencyKeys).size !== idempotencyKeys.length) {
    return "QUEUE_ORDER_INVALID" as const;
  }
  if (event.payload.entries.some((entry) =>
    entry.threadId !== event.threadId
    || entry.queueRevision !== event.queueRevision
    || !sameScope(entry.scope, event.scope)
  )) return "QUEUE_REVISION_CONFLICT" as const;

  const trigger = event.payload.trigger;
  if (trigger) {
    if (event.payload.transition !== "dequeued") return "QUEUE_ORDER_INVALID" as const;
    if (state.cursor > 0 && !state.activeRunIds.includes(trigger.runId)) {
      return "QUEUE_ACTIVE_RUN_CONFLICT" as const;
    }
    if (
      trigger.terminalStatus === "cancelled"
      && (!event.payload.paused || event.payload.pauseReason !== "stopped")
    ) return "QUEUE_PAUSE_INVALID" as const;
    if (
      trigger.terminalStatus === "failed"
      && (!event.payload.paused || event.payload.pauseReason !== "failed")
    ) return "QUEUE_PAUSE_INVALID" as const;
    if (
      trigger.terminalStatus === "completed"
      && event.payload.autoStartNext
      && queued.length > 0
      && activeEntries.length === 0
    ) return "QUEUE_ORDER_INVALID" as const;
  }
  return null;
}

export function mergeV2QueueInput(state: V2QueueState, input: unknown): V2QueueMergeResult {
  const parsed = parseV2ThreadQueueEvent(input);
  if (!parsed.ok) return { accepted: false, state, errorCode: parsed.errorCode };
  const event = parsed.value;

  if (event.threadId !== state.threadId) return { accepted: false, state, errorCode: "THREAD_ID_MISMATCH" };
  if (!sameScope(event.scope, state.scope)) return { accepted: false, state, errorCode: "SCOPE_MISMATCH" };
  if (state.source && event.source !== state.source) return { accepted: false, state, errorCode: "SOURCE_MISMATCH" };
  if (state.eventIds[event.eventId]) return { accepted: false, state, errorCode: "QUEUE_EVENT_ID_DUPLICATE" };
  if (event.queueCursor !== state.cursor + 1) return { accepted: false, state, errorCode: "QUEUE_CURSOR_INVALID" };
  if (
    event.payload.expectedPreviousRevision !== state.revision
    || event.queueRevision !== state.revision + 1
  ) return { accepted: false, state, errorCode: "QUEUE_REVISION_CONFLICT" };

  const readModelError = validQueueReadModel(state, event);
  if (readModelError) return { accepted: false, state, errorCode: readModelError };

  return {
    accepted: true,
    event,
    state: {
      ...state,
      source: state.source ?? event.source,
      cursor: event.queueCursor,
      revision: event.queueRevision,
      eventIds: { ...state.eventIds, [event.eventId]: true },
      entries: event.payload.entries,
      activeRunIds: event.payload.activeRunIds,
      autoStartNext: event.payload.autoStartNext,
      paused: event.payload.paused,
      pauseReason: event.payload.pauseReason,
      lastTransition: event.payload.transition
    }
  };
}

export function mergeV2QueueInputs(state: V2QueueState, inputs: readonly unknown[]) {
  const rejected: V2RejectedQueueInput[] = [];
  let current = state;
  inputs.forEach((input, index) => {
    const result = mergeV2QueueInput(current, input);
    if (result.accepted) current = result.state;
    else rejected.push({ index, errorCode: result.errorCode });
  });
  return { state: current, rejected };
}
