import { parseV2AgentEvent } from "./adapter";
import type {
  V2AdapterErrorCode,
  V2AgentEvent,
  V2AgentEventType,
  V2EventRefs,
  V2EventSource,
  V2ReasonCode,
  V2Scope,
  V2SourceType,
  V2ToolDisplay,
  V2ToolUsage
} from "./types";

export type V2RunTerminal = "completed" | "cancelled" | "failed";
export type V2RunMergeErrorCode =
  | V2AdapterErrorCode
  | "RUN_ID_MISMATCH"
  | "SCOPE_MISMATCH"
  | "SOURCE_MISMATCH"
  | "EVENT_ID_DUPLICATE"
  | "RUN_SEQ_INVALID"
  | "EVENT_AFTER_TERMINAL"
  | "INPUT_REVISION_STALE"
  | "NODE_LIFECYCLE_INVALID"
  | "TOOL_LIFECYCLE_INVALID"
  | "APPROVAL_LIFECYCLE_INVALID"
  | "GUIDANCE_LIFECYCLE_INVALID"
  | "MESSAGE_LIFECYCLE_INVALID"
  | "CLARIFICATION_LIFECYCLE_INVALID"
  | "PLAN_REVISION_INVALID"
  | "CONTEXT_REVISION_INVALID"
  | "BUDGET_REVISION_INVALID"
  | "BUDGET_EXHAUSTED"
  | "TERMINAL_PREREQUISITE_INVALID"
  | "MEMORY_WRITE_INVALID";

export interface V2ProcessItem {
  readonly id: string;
  readonly eventId: string;
  readonly seq: number;
  readonly type: V2AgentEventType;
  readonly kind: V2AgentEvent["kind"];
  readonly status: V2AgentEvent["status"];
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly inputRevision: number;
  readonly refs: V2EventRefs;
  readonly publicText: string | null;
  readonly reasonCodes: readonly V2ReasonCode[];
  readonly durationMs: number | null;
}

export interface V2PlanState {
  readonly planRef: string;
  readonly revision: number;
  readonly publicText: string | null;
  readonly reasonCodes: readonly V2ReasonCode[];
  readonly seq: number;
  readonly inputRevision: number;
  readonly updatedAt: string;
}

export type V2ToolActivityStatus =
  | "running"
  | "waiting_approval"
  | "denied"
  | "completed"
  | "failed"
  | "unknown";

export type V2ToolActivityPhase =
  | "running"
  | "progress"
  | "retrying"
  | "waiting_approval"
  | "approval_decided"
  | "completed"
  | "failed"
  | "unknown";

export type V2ToolUsageSummary = Omit<V2ToolUsage, "toolId">;

export interface V2ToolActivityState {
  readonly toolCallId: string;
  readonly toolId: string;
  readonly registryTitle: string;
  readonly category: V2ToolDisplay["category"];
  readonly planStepId: string;
  readonly attempt: number;
  readonly phase: V2ToolActivityPhase;
  readonly status: V2ToolActivityStatus;
  readonly approvalStatus: V2ToolDisplay["approvalStatus"];
  readonly approvalId: string | null;
  readonly approvalDecision: "allow_once" | "deny" | "edit" | null;
  readonly actionSummary: string | null;
  readonly permissionSummary: string | null;
  readonly approvalExpiresAt: string | null;
  readonly parameterSummary: string | null;
  readonly resultSummary: string | null;
  readonly errorMessage: string | null;
  readonly resultCount: number | null;
  readonly resultType: V2ToolDisplay["resultType"];
  readonly sourceTypes: readonly V2SourceType[];
  readonly durationMs: number | null;
  readonly costUsd: string | null;
  readonly errorCode: string | null;
  readonly retryable: boolean | null;
  readonly operationRef: string | null;
  readonly nextAction: "check_operation" | null;
  readonly usage: V2ToolUsageSummary | null;
  readonly firstSeq: number;
  readonly lastSeq: number;
  readonly inputRevision: number;
  readonly startedAt: string;
  readonly completedAt: string | null;
}

export type V2GuidanceStatus =
  | "accepted_pending"
  | "applied"
  | "superseded"
  | "rejected"
  | "failed";

export interface V2GuidanceState {
  readonly commandId: string;
  readonly commandSeq: number;
  readonly status: V2GuidanceStatus;
  readonly expectedSteeringRevision: number | null;
  readonly currentSteeringRevision: number | null;
  readonly newSteeringRevision: number | null;
  readonly appliedAtNode: string | null;
  readonly impact: "format_only" | "replan" | "permission_change" | "cancel_requested" | null;
  readonly supersededByCommandId: string | null;
  readonly errorCode: string | null;
  readonly retryable: boolean | null;
  readonly firstSeq: number;
  readonly lastSeq: number;
  readonly inputRevision: number;
}

export interface V2RunState {
  readonly runId: string;
  readonly scope: V2Scope;
  readonly source: V2EventSource | null;
  readonly cursor: number;
  readonly runStatus: V2AgentEvent["status"] | "idle";
  readonly terminal: V2RunTerminal | null;
  readonly terminalResponseId: string | null;
  readonly terminalResponseStatus: "completed" | "partial" | null;
  readonly latestInputRevision: number;
  readonly contextRevision: number;
  readonly contextRevisionWasEstimate: boolean | null;
  readonly budgetRevision: number;
  readonly budgetExhausted: boolean;
  readonly eventIds: Readonly<Record<string, true>>;
  readonly processById: Readonly<Record<string, V2ProcessItem>>;
  readonly processOrder: readonly string[];
  readonly nodeExecutions: Readonly<Record<string, {
    readonly node: string;
    readonly executionKind: "model" | "deterministic";
    readonly ordinal: number;
    readonly attemptNumber: number;
    readonly inputRevision: number;
    readonly status: "running" | "completed" | "failed";
  }>>;
  readonly toolCalls: Readonly<Record<string, V2ToolActivityState>>;
  readonly toolOrder: readonly string[];
  readonly guidanceCommands: Readonly<Record<string, V2GuidanceState>>;
  readonly guidanceOrder: readonly string[];
  readonly messages: Readonly<Record<string, {
    readonly role: "user" | "assistant";
    readonly inputRevision: number;
    readonly status: "running" | "completed";
    readonly responseId: string | null;
    readonly verified: boolean;
    readonly seq: number;
  }>>;
  readonly clarifications: Readonly<Record<string, {
    readonly checkpointRef: string;
    readonly question: string;
    readonly stateRevision: number;
    readonly expiresAt: string;
    readonly inputRevision: number;
    readonly seq: number;
    readonly status: "waiting" | "resumed";
    readonly responseMessageRef: string | null;
    readonly idempotencyKey: string | null;
  }>>;
  readonly verificationsByRevision: Readonly<Record<number, {
    readonly passed: boolean;
    readonly seq: number;
    readonly draftRevision: number;
  }>>;
  readonly verifiedResponses: Readonly<Record<string, {
    readonly messageId: string;
    readonly inputRevision: number;
    readonly seq: number;
  }>>;
  readonly memoryResponseIds: Readonly<Record<string, {
    readonly inputRevision: number;
    readonly seq: number;
  }>>;
  readonly latestPlanRevision: number;
  readonly plan: V2PlanState | null;
}

export type V2RunMergeResult =
  | { readonly accepted: true; readonly state: V2RunState; readonly event: V2AgentEvent }
  | { readonly accepted: false; readonly state: V2RunState; readonly errorCode: V2RunMergeErrorCode };

export interface V2RejectedRunInput {
  readonly index: number;
  readonly errorCode: V2RunMergeErrorCode;
}

export function createV2RunState(runId: string, scope: V2Scope): V2RunState {
  return {
    runId,
    scope,
    source: null,
    cursor: 0,
    runStatus: "idle",
    terminal: null,
    terminalResponseId: null,
    terminalResponseStatus: null,
    latestInputRevision: 0,
    contextRevision: -1,
    contextRevisionWasEstimate: null,
    budgetRevision: -1,
    budgetExhausted: false,
    eventIds: {},
    processById: {},
    processOrder: [],
    nodeExecutions: {},
    toolCalls: {},
    toolOrder: [],
    guidanceCommands: {},
    guidanceOrder: [],
    messages: {},
    clarifications: {},
    verificationsByRevision: {},
    verifiedResponses: {},
    memoryResponseIds: {},
    latestPlanRevision: -1,
    plan: null
  };
}

function sameScope(left: V2Scope, right: V2Scope) {
  return left.tenantId === right.tenantId
    && left.actorId === right.actorId
    && left.visitorId === right.visitorId
    && left.projectId === right.projectId
    && left.threadId === right.threadId;
}

function payloadPublicText(event: V2AgentEvent): string | null {
  const payload = event.payload as object & { readonly publicText?: string | null };
  return typeof payload.publicText === "string" ? payload.publicText : null;
}

function payloadReasonCodes(event: V2AgentEvent): readonly V2ReasonCode[] {
  const payload = event.payload as object & { readonly reasonCodes?: readonly V2ReasonCode[] };
  return Array.isArray(payload.reasonCodes) ? payload.reasonCodes : [];
}

function payloadDuration(event: V2AgentEvent): number | null {
  const payload = event.payload as object & { readonly durationMs?: number };
  return typeof payload.durationMs === "number" ? payload.durationMs : null;
}

function toolDisplayState(display: V2ToolDisplay) {
  return {
    registryTitle: display.registryTitle,
    category: display.category,
    approvalStatus: display.approvalStatus,
    parameterSummary: display.parameterSummary,
    resultSummary: display.resultSummary,
    errorMessage: display.errorMessage,
    resultCount: display.resultCount,
    resultType: display.resultType,
    sourceTypes: display.sourceTypes,
    durationMs: display.durationMs,
    costUsd: display.costUsd,
    errorCode: display.errorCode
  } as const;
}

function toolUsageSummary(usage: V2ToolUsage): V2ToolUsageSummary {
  return {
    toolVersion: usage.toolVersion,
    provider: usage.provider,
    pricingVersion: usage.pricingVersion,
    currency: usage.currency,
    calls: usage.calls,
    attempts: usage.attempts,
    units: usage.units,
    bytes: usage.bytes,
    resultCount: usage.resultCount,
    searchQueries: usage.searchQueries,
    pageReads: usage.pageReads,
    estimatedCostUsd: usage.estimatedCostUsd,
    actualCostUsd: usage.actualCostUsd,
    possibleDuplicateCostUsd: usage.possibleDuplicateCostUsd
  };
}

function processIdentity(event: V2AgentEvent): string {
  switch (event.type) {
    case "node.started":
    case "node.completed":
    case "node.failed":
      return `node:${event.payload.nodeExecutionId}`;
    case "plan.updated":
      return `plan:${event.payload.planRef}`;
    case "tool.started":
    case "tool.updated":
    case "tool.completed":
    case "tool.failed":
    case "tool.unknown":
      return `tool:${event.payload.toolCallId}`;
    case "approval.required":
    case "approval.decided":
      return `approval:${event.payload.approvalId}`;
    case "clarification.required":
    case "clarification.resumed":
      return `clarification:${event.payload.clarificationId}`;
    case "guidance.accepted":
    case "guidance.applied":
    case "guidance.superseded":
    case "guidance.rejected":
    case "guidance.failed":
      return `guidance:${event.payload.commandId}`;
    case "message.started":
    case "message.completed":
      return `message:${event.payload.messageId}`;
    case "context.usage.updated":
      return `context:${event.payload.contextRevision}`;
    case "budget.updated":
      return `budget:${event.payload.budgetRevision}`;
    case "verification.completed":
      return `verification:${event.payload.draftRevision}`;
    case "citation.created":
      return `citation:${event.payload.citationId}`;
    case "memory.updated":
      return `memory:${event.payload.memoryRef}`;
    default:
      return `event:${event.eventId}`;
  }
}

function nextRunStatus(state: V2RunState, event: V2AgentEvent): V2RunState["runStatus"] {
  switch (event.type) {
    case "run.created":
      return event.status;
    case "run.status":
      return event.status;
    case "run.completed":
      return "completed";
    case "run.cancelled":
      return "cancelled";
    case "run.failed":
      return "failed";
    default:
      return state.runStatus;
  }
}

function terminalFor(event: V2AgentEvent): V2RunTerminal | null {
  if (event.type === "run.completed") return "completed";
  if (event.type === "run.cancelled") return "cancelled";
  if (event.type === "run.failed") return "failed";
  return null;
}

function lifecycleError(state: V2RunState, event: V2AgentEvent): V2RunMergeErrorCode | null {
  if (event.type === "node.started") {
    return state.nodeExecutions[event.payload.nodeExecutionId] ? "NODE_LIFECYCLE_INVALID" : null;
  }
  if (event.type === "node.completed" || event.type === "node.failed") {
    const started = state.nodeExecutions[event.payload.nodeExecutionId];
    return started?.status === "running"
      && started.node === event.payload.node
      && started.executionKind === event.payload.executionKind
      && started.ordinal === event.payload.ordinal
      && started.attemptNumber === event.payload.attemptNumber
      && started.inputRevision === event.inputRevision
      ? null
      : "NODE_LIFECYCLE_INVALID";
  }
  if (event.type === "tool.started") {
    return state.toolCalls[event.payload.toolCallId] ? "TOOL_LIFECYCLE_INVALID" : null;
  }
  if (event.type === "tool.updated") {
    const started = state.toolCalls[event.payload.toolCallId];
    const attemptMatches = event.payload.phase === "retrying"
      ? event.payload.attempt === started?.attempt
        || event.payload.attempt === (started?.attempt ?? 0) + 1
      : event.payload.attempt === started?.attempt;
    return (started?.status === "running" || started?.status === "waiting_approval")
      && started.approvalDecision !== "deny"
      && started.approvalDecision !== "edit"
      && started.toolId === event.payload.toolId
      && attemptMatches
      && started.inputRevision === event.inputRevision
      ? null
      : "TOOL_LIFECYCLE_INVALID";
  }
  if (event.type === "tool.completed" || event.type === "tool.failed" || event.type === "tool.unknown") {
    const started = state.toolCalls[event.payload.toolCallId];
    if (
      !started
      || started.toolId !== event.payload.toolId
      || started.attempt !== event.payload.attempt
      || started.inputRevision !== event.inputRevision
      || started.approvalDecision === "edit"
    ) return "TOOL_LIFECYCLE_INVALID";
    if (started.approvalDecision === "deny") {
      return event.type === "tool.failed" && event.payload.display.approvalStatus === "denied"
        ? null
        : "TOOL_LIFECYCLE_INVALID";
    }
    if (started.status !== "running") return "TOOL_LIFECYCLE_INVALID";
    if (
      started.approvalDecision === "allow_once"
      && event.payload.display.approvalStatus !== "approved"
    ) return "TOOL_LIFECYCLE_INVALID";
    if (
      started.approvalDecision === null
      && started.approvalStatus === "required"
    ) return "TOOL_LIFECYCLE_INVALID";
    if (
      started.approvalDecision === null
      && event.payload.display.approvalStatus !== started.approvalStatus
    ) return "TOOL_LIFECYCLE_INVALID";
    return null;
  }
  if (event.type === "approval.required") {
    const started = state.toolCalls[event.payload.toolCallId];
    return started
      && (started.status === "running" || started.status === "waiting_approval")
      && started.inputRevision === event.inputRevision
      && started.approvalId === null
      && event.refs.toolCallId === event.payload.toolCallId
      ? null
      : "APPROVAL_LIFECYCLE_INVALID";
  }
  if (event.type === "approval.decided") {
    const started = state.toolCalls[event.payload.toolCallId];
    return started
      && started.status === "waiting_approval"
      && started.inputRevision === event.inputRevision
      && started.approvalId === event.payload.approvalId
      && started.approvalStatus === "required"
      && event.refs.toolCallId === event.payload.toolCallId
      ? null
      : "APPROVAL_LIFECYCLE_INVALID";
  }
  if (event.type === "guidance.accepted") {
    const duplicateSeq = Object.values(state.guidanceCommands).some(
      (guidance) => guidance.commandSeq === event.payload.commandSeq
    );
    return state.guidanceCommands[event.payload.commandId] || duplicateSeq
      ? "GUIDANCE_LIFECYCLE_INVALID"
      : null;
  }
  if (event.type === "guidance.applied" || event.type === "guidance.superseded") {
    const accepted = state.guidanceCommands[event.payload.commandId];
    return accepted?.status === "accepted_pending"
      && accepted.commandSeq === event.payload.commandSeq
      ? null
      : "GUIDANCE_LIFECYCLE_INVALID";
  }
  if (event.type === "guidance.failed") {
    const accepted = state.guidanceCommands[event.payload.commandId];
    return accepted?.status === "accepted_pending"
      && accepted.commandSeq === event.payload.commandSeq
      ? null
      : "GUIDANCE_LIFECYCLE_INVALID";
  }
  if (event.type === "guidance.rejected") {
    const current = state.guidanceCommands[event.payload.commandId];
    const duplicateSeq = Object.values(state.guidanceCommands).some(
      (guidance) =>
        guidance.commandId !== event.payload.commandId
        && guidance.commandSeq === event.payload.commandSeq
    );
    return duplicateSeq
      || (current && (
        current.status !== "accepted_pending"
        || current.commandSeq !== event.payload.commandSeq
      ))
      ? "GUIDANCE_LIFECYCLE_INVALID"
      : null;
  }
  if (event.type === "message.started") {
    return state.messages[event.payload.messageId] ? "MESSAGE_LIFECYCLE_INVALID" : null;
  }
  if (event.type === "message.completed") {
    const started = state.messages[event.payload.messageId];
    return started?.status === "running"
      && started.role === event.payload.role
      && started.inputRevision === event.inputRevision
      && event.refs.messageId === event.payload.messageId
      && (event.payload.role !== "assistant"
        || event.refs.responseId === event.payload.responseId)
      ? null
      : "MESSAGE_LIFECYCLE_INVALID";
  }
  if (event.type === "clarification.required") {
    return state.clarifications[event.payload.clarificationId]
      ? "CLARIFICATION_LIFECYCLE_INVALID"
      : null;
  }
  if (event.type === "clarification.resumed") {
    const required = state.clarifications[event.payload.clarificationId];
    return required?.status === "waiting"
      && required.checkpointRef === event.payload.checkpointRef
      && event.refs.checkpointRef === event.payload.checkpointRef
      ? null
      : "CLARIFICATION_LIFECYCLE_INVALID";
  }
  if (event.type === "plan.updated") {
    if (event.payload.revision <= state.latestPlanRevision) return "PLAN_REVISION_INVALID";
  }
  if (event.type === "context.usage.updated") {
    if (
      event.payload.contextRevision < state.contextRevision
      || (
        event.payload.contextRevision === state.contextRevision
        && (state.contextRevisionWasEstimate !== true || event.payload.isEstimate)
      )
    ) return "CONTEXT_REVISION_INVALID";
  }
  if (event.type === "budget.updated" && event.payload.budgetRevision <= state.budgetRevision) {
    return "BUDGET_REVISION_INVALID";
  }
  return null;
}

function updateLifecycles(state: V2RunState, event: V2AgentEvent) {
  let nodeExecutions = state.nodeExecutions;
  let toolCalls = state.toolCalls;
  let toolOrder = state.toolOrder;
  let guidanceCommands = state.guidanceCommands;
  let guidanceOrder = state.guidanceOrder;
  let messages = state.messages;
  let clarifications = state.clarifications;
  let verificationsByRevision = state.verificationsByRevision;
  let verifiedResponses = state.verifiedResponses;
  let memoryResponseIds = state.memoryResponseIds;
  if (event.type === "node.started") {
    nodeExecutions = {
      ...nodeExecutions,
      [event.payload.nodeExecutionId]: {
        node: event.payload.node,
        executionKind: event.payload.executionKind,
        ordinal: event.payload.ordinal,
        attemptNumber: event.payload.attemptNumber,
        inputRevision: event.inputRevision,
        status: "running"
      }
    };
  } else if (event.type === "node.completed" || event.type === "node.failed") {
    const started = nodeExecutions[event.payload.nodeExecutionId];
    nodeExecutions = {
      ...nodeExecutions,
      [event.payload.nodeExecutionId]: {
        ...started,
        status: event.type === "node.completed" ? "completed" : "failed"
      }
    };
  } else if (event.type === "tool.started") {
    toolCalls = {
      ...toolCalls,
      [event.payload.toolCallId]: {
        toolCallId: event.payload.toolCallId,
        toolId: event.payload.toolId,
        ...toolDisplayState(event.payload.display),
        planStepId: event.payload.planStepId,
        attempt: event.payload.attempt,
        phase: "running",
        status: "running",
        approvalId: null,
        approvalDecision: null,
        actionSummary: null,
        permissionSummary: null,
        approvalExpiresAt: null,
        retryable: null,
        operationRef: null,
        nextAction: null,
        usage: null,
        firstSeq: event.seq,
        lastSeq: event.seq,
        inputRevision: event.inputRevision,
        startedAt: event.startedAt ?? event.occurredAt,
        completedAt: null
      }
    };
    toolOrder = [...toolOrder, event.payload.toolCallId];
  } else if (event.type === "tool.updated") {
    const started = toolCalls[event.payload.toolCallId];
    toolCalls = {
      ...toolCalls,
      [event.payload.toolCallId]: {
        ...started,
        ...toolDisplayState(event.payload.display),
        attempt: event.payload.attempt,
        phase: event.payload.phase,
        status: event.payload.phase === "waiting_approval" ? "waiting_approval" : "running",
        lastSeq: event.seq
      }
    };
  } else if (event.type === "tool.completed" || event.type === "tool.failed" || event.type === "tool.unknown") {
    const started = toolCalls[event.payload.toolCallId];
    toolCalls = {
      ...toolCalls,
      [event.payload.toolCallId]: {
        ...started,
        ...toolDisplayState(event.payload.display),
        attempt: event.payload.attempt,
        phase: event.type === "tool.completed"
          ? "completed"
          : event.type === "tool.failed"
            ? "failed"
            : "unknown",
        status: event.type === "tool.completed"
          ? "completed"
          : event.type === "tool.failed"
            ? "failed"
            : "unknown",
        retryable: event.type === "tool.failed" ? event.payload.retryable : null,
        operationRef: event.type === "tool.unknown" ? event.payload.operationRef : null,
        nextAction: event.type === "tool.unknown" ? event.payload.nextAction : null,
        usage: toolUsageSummary(event.payload.usage),
        lastSeq: event.seq,
        completedAt: event.completedAt
      }
    };
  } else if (event.type === "approval.required") {
    const started = toolCalls[event.payload.toolCallId];
    toolCalls = {
      ...toolCalls,
      [event.payload.toolCallId]: {
        ...started,
        phase: "waiting_approval",
        status: "waiting_approval",
        approvalStatus: "required",
        approvalId: event.payload.approvalId,
        approvalDecision: null,
        actionSummary: event.payload.actionSummary,
        permissionSummary: event.payload.permissionSummary,
        approvalExpiresAt: event.payload.expiresAt,
        lastSeq: event.seq
      }
    };
  } else if (event.type === "approval.decided") {
    const started = toolCalls[event.payload.toolCallId];
    toolCalls = {
      ...toolCalls,
      [event.payload.toolCallId]: {
        ...started,
        phase: "approval_decided",
        status: event.payload.decision === "deny"
          ? "denied"
          : event.payload.decision === "edit"
            ? "waiting_approval"
            : "running",
        approvalStatus: event.payload.decision === "allow_once"
          ? "approved"
          : event.payload.decision === "deny"
            ? "denied"
            : started.approvalStatus,
        approvalId: started.approvalId,
        approvalDecision: event.payload.decision,
        lastSeq: event.seq
      }
    };
  } else if (event.type === "guidance.accepted") {
    guidanceCommands = {
      ...guidanceCommands,
      [event.payload.commandId]: {
        commandId: event.payload.commandId,
        commandSeq: event.payload.commandSeq,
        status: "accepted_pending",
        expectedSteeringRevision: event.payload.expectedSteeringRevision,
        currentSteeringRevision: event.payload.currentSteeringRevision,
        newSteeringRevision: null,
        appliedAtNode: null,
        impact: null,
        supersededByCommandId: null,
        errorCode: null,
        retryable: null,
        firstSeq: event.seq,
        lastSeq: event.seq,
        inputRevision: event.inputRevision
      }
    };
    guidanceOrder = [...guidanceOrder, event.payload.commandId];
  } else if (
    event.type === "guidance.applied"
    || event.type === "guidance.superseded"
    || event.type === "guidance.rejected"
    || event.type === "guidance.failed"
  ) {
    const current = guidanceCommands[event.payload.commandId];
    const status = event.type === "guidance.applied"
      ? "applied"
      : event.type === "guidance.superseded"
        ? "superseded"
        : event.type === "guidance.rejected"
          ? "rejected"
          : "failed";
    guidanceCommands = {
      ...guidanceCommands,
      [event.payload.commandId]: {
        commandId: event.payload.commandId,
        commandSeq: event.payload.commandSeq,
        status,
        expectedSteeringRevision: current?.expectedSteeringRevision ?? null,
        currentSteeringRevision: current?.currentSteeringRevision ?? null,
        newSteeringRevision: event.type === "guidance.applied"
          || event.type === "guidance.superseded"
          ? event.payload.newSteeringRevision
          : null,
        appliedAtNode: event.type === "guidance.applied"
          ? event.payload.appliedAtNode
          : null,
        impact: event.type === "guidance.applied" ? event.payload.impact : null,
        supersededByCommandId: event.type === "guidance.superseded"
          ? event.payload.supersededByCommandId
          : null,
        errorCode: event.type === "guidance.rejected"
          ? event.payload.code
          : event.type === "guidance.failed"
            ? event.payload.errorCode
            : null,
        retryable: event.type === "guidance.failed" ? event.payload.retryable : false,
        firstSeq: current?.firstSeq ?? event.seq,
        lastSeq: event.seq,
        inputRevision: event.inputRevision
      }
    };
    if (!current) guidanceOrder = [...guidanceOrder, event.payload.commandId];
  } else if (event.type === "message.started") {
    messages = {
      ...messages,
      [event.payload.messageId]: {
        role: event.payload.role,
        inputRevision: event.inputRevision,
        status: "running",
        responseId: null,
        verified: false,
        seq: event.seq
      }
    };
  } else if (event.type === "message.completed") {
    messages = {
      ...messages,
      [event.payload.messageId]: {
        role: event.payload.role,
        inputRevision: event.inputRevision,
        status: "completed",
        responseId: event.payload.responseId,
        verified: event.payload.verified,
        seq: event.seq
      }
    };
    if (event.payload.role === "assistant" && event.payload.responseId && event.payload.verified) {
      verifiedResponses = {
        ...verifiedResponses,
        [event.payload.responseId]: {
          messageId: event.payload.messageId,
          inputRevision: event.inputRevision,
          seq: event.seq
        }
      };
    }
  } else if (event.type === "clarification.required") {
    clarifications = {
      ...clarifications,
      [event.payload.clarificationId]: {
        checkpointRef: event.payload.checkpointRef,
        question: event.payload.question,
        stateRevision: event.payload.stateRevision,
        expiresAt: event.payload.expiresAt,
        inputRevision: event.inputRevision,
        seq: event.seq,
        status: "waiting",
        responseMessageRef: null,
        idempotencyKey: null
      }
    };
  } else if (event.type === "clarification.resumed") {
    clarifications = {
      ...clarifications,
      [event.payload.clarificationId]: {
        checkpointRef: event.payload.checkpointRef,
        question: clarifications[event.payload.clarificationId].question,
        stateRevision: event.payload.resumedAtStateRevision,
        expiresAt: clarifications[event.payload.clarificationId].expiresAt,
        inputRevision: event.inputRevision,
        seq: event.seq,
        status: "resumed",
        responseMessageRef: event.payload.responseMessageRef,
        idempotencyKey: event.payload.idempotencyKey
      }
    };
  } else if (event.type === "verification.completed") {
    verificationsByRevision = {
      ...verificationsByRevision,
      [event.inputRevision]: {
        passed: event.payload.passed,
        seq: event.seq,
        draftRevision: event.payload.draftRevision
      }
    };
  } else if (event.type === "memory.updated") {
    memoryResponseIds = {
      ...memoryResponseIds,
      [event.payload.sourceResponseId]: {
        inputRevision: event.inputRevision,
        seq: event.seq
      }
    };
  }
  return {
    nodeExecutions,
    toolCalls,
    toolOrder,
    guidanceCommands,
    guidanceOrder,
    messages,
    clarifications,
    verificationsByRevision,
    verifiedResponses,
    memoryResponseIds
  };
}

const revisionBoundTypes = new Set<V2AgentEventType>([
  "node.started",
  "node.completed",
  "node.failed",
  "plan.updated",
  "tool.started",
  "tool.updated",
  "tool.completed",
  "tool.failed",
  "tool.unknown",
  "approval.required",
  "approval.decided",
  "context.usage.updated",
  "artifact.created",
  "citation.created",
  "verification.completed",
  "message.started",
  "message.completed",
  "memory.updated",
  "run.completed"
]);

function terminalPrerequisiteError(state: V2RunState, event: V2AgentEvent): V2RunMergeErrorCode | null {
  if (event.type !== "run.completed" && event.type !== "run.cancelled" && event.type !== "run.failed") {
    return null;
  }
  if (
    Object.values(state.nodeExecutions).some((execution) => execution.status === "running")
    || Object.values(state.toolCalls).some((call) =>
      call.status !== "completed" && call.status !== "failed" && call.status !== "unknown"
    )
  ) return "TERMINAL_PREREQUISITE_INVALID";

  if (state.budgetExhausted && event.payload.stopReason !== "budget_exhausted") {
    return "BUDGET_EXHAUSTED";
  }
  if (event.type === "run.cancelled" || event.type === "run.failed") {
    return Object.keys(state.memoryResponseIds).length > 0 ? "MEMORY_WRITE_INVALID" : null;
  }

  const verification = state.verificationsByRevision[event.inputRevision];
  const response = state.verifiedResponses[event.payload.responseId];
  if (
    !verification
    || !response
    || response.inputRevision !== event.inputRevision
    || verification.seq >= response.seq
    || response.seq >= event.seq
    || event.refs.responseId !== event.payload.responseId
    || (event.payload.responseStatus === "completed" && !verification.passed)
  ) return "TERMINAL_PREREQUISITE_INVALID";
  if (Object.entries(state.memoryResponseIds).some(([responseId, memory]) =>
    responseId !== event.payload.responseId
    || memory.inputRevision !== event.inputRevision
    || memory.seq <= response.seq
    || memory.seq >= event.seq
  )) return "MEMORY_WRITE_INVALID";
  return null;
}

function memoryWriteError(state: V2RunState, event: V2AgentEvent): V2RunMergeErrorCode | null {
  if (event.type !== "memory.updated") return null;
  const verification = state.verificationsByRevision[event.inputRevision];
  const response = state.verifiedResponses[event.payload.sourceResponseId];
  return verification?.passed
    && response?.inputRevision === event.inputRevision
    && verification.seq < response.seq
    && response.seq < event.seq
    ? null
    : "MEMORY_WRITE_INVALID";
}

export function mergeV2RunInput(state: V2RunState, input: unknown): V2RunMergeResult {
  const parsed = parseV2AgentEvent(input);
  if (!parsed.ok) return { accepted: false, state, errorCode: parsed.errorCode };
  const event = parsed.value;

  if (event.runId !== state.runId) return { accepted: false, state, errorCode: "RUN_ID_MISMATCH" };
  if (!sameScope(event.scope, state.scope)) return { accepted: false, state, errorCode: "SCOPE_MISMATCH" };
  if (state.source && event.source !== state.source) return { accepted: false, state, errorCode: "SOURCE_MISMATCH" };
  if (state.eventIds[event.eventId]) return { accepted: false, state, errorCode: "EVENT_ID_DUPLICATE" };
  if (event.seq !== state.cursor + 1) return { accepted: false, state, errorCode: "RUN_SEQ_INVALID" };
  if (state.terminal) return { accepted: false, state, errorCode: "EVENT_AFTER_TERMINAL" };
  if (state.budgetExhausted && event.type !== "run.completed" && event.type !== "run.cancelled" && event.type !== "run.failed") {
    return { accepted: false, state, errorCode: "BUDGET_EXHAUSTED" };
  }
  if (revisionBoundTypes.has(event.type) && event.inputRevision < state.latestInputRevision) {
    return { accepted: false, state, errorCode: "INPUT_REVISION_STALE" };
  }

  const invalidLifecycle = lifecycleError(state, event);
  if (invalidLifecycle) return { accepted: false, state, errorCode: invalidLifecycle };
  const invalidMemory = memoryWriteError(state, event);
  if (invalidMemory) return { accepted: false, state, errorCode: invalidMemory };
  const invalidTerminal = terminalPrerequisiteError(state, event);
  if (invalidTerminal) return { accepted: false, state, errorCode: invalidTerminal };

  const id = processIdentity(event);
  const item: V2ProcessItem = {
    id,
    eventId: event.eventId,
    seq: event.seq,
    type: event.type,
    kind: event.kind,
    status: event.status,
    startedAt: event.startedAt,
    completedAt: event.completedAt,
    inputRevision: event.inputRevision,
    refs: event.refs,
    publicText: payloadPublicText(event),
    reasonCodes: payloadReasonCodes(event),
    durationMs: payloadDuration(event)
  };
  const lifecycle = updateLifecycles(state, event);
  const plan = event.type === "plan.updated"
    ? {
        planRef: event.payload.planRef,
        revision: event.payload.revision,
        publicText: event.payload.publicText,
        reasonCodes: event.payload.reasonCodes,
        seq: event.seq,
        inputRevision: event.inputRevision,
        updatedAt: event.occurredAt
      }
    : event.type === "guidance.applied"
      && state.plan
      && event.payload.invalidatedPlanRefs.includes(state.plan.planRef)
      ? null
      : state.plan;
  const terminal = terminalFor(event);

  return {
    accepted: true,
    event,
    state: {
      ...state,
      source: state.source ?? event.source,
      cursor: event.seq,
      runStatus: nextRunStatus(state, event),
      terminal,
      terminalResponseId: event.type === "run.completed"
        ? event.payload.responseId
        : terminal
          ? null
          : state.terminalResponseId,
      terminalResponseStatus: event.type === "run.completed"
        ? event.payload.responseStatus
        : terminal
          ? null
          : state.terminalResponseStatus,
      latestInputRevision: event.inputRevision > state.latestInputRevision
        ? event.inputRevision
        : state.latestInputRevision,
      contextRevision: event.type === "context.usage.updated"
        ? event.payload.contextRevision
        : state.contextRevision,
      contextRevisionWasEstimate: event.type === "context.usage.updated"
        ? event.payload.isEstimate
        : state.contextRevisionWasEstimate,
      budgetRevision: event.type === "budget.updated"
        ? event.payload.budgetRevision
        : state.budgetRevision,
      budgetExhausted: event.type === "budget.updated"
        ? event.payload.exhausted
        : state.budgetExhausted,
      eventIds: { ...state.eventIds, [event.eventId]: true },
      processById: { ...state.processById, [id]: item },
      processOrder: state.processById[id] ? state.processOrder : [...state.processOrder, id],
      nodeExecutions: lifecycle.nodeExecutions,
      toolCalls: lifecycle.toolCalls,
      toolOrder: lifecycle.toolOrder,
      guidanceCommands: lifecycle.guidanceCommands,
      guidanceOrder: lifecycle.guidanceOrder,
      messages: lifecycle.messages,
      clarifications: lifecycle.clarifications,
      verificationsByRevision: lifecycle.verificationsByRevision,
      verifiedResponses: lifecycle.verifiedResponses,
      memoryResponseIds: lifecycle.memoryResponseIds,
      latestPlanRevision: event.type === "plan.updated"
        ? event.payload.revision
        : state.latestPlanRevision,
      plan
    }
  };
}

export function mergeV2RunInputs(state: V2RunState, inputs: readonly unknown[]) {
  const rejected: V2RejectedRunInput[] = [];
  let current = state;
  inputs.forEach((input, index) => {
    const result = mergeV2RunInput(current, input);
    if (result.accepted) current = result.state;
    else rejected.push({ index, errorCode: result.errorCode });
  });
  return { state: current, rejected };
}
