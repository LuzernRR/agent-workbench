export const V2_AGENT_EVENT_TYPES = [
  "run.created",
  "run.status",
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
  "clarification.required",
  "clarification.resumed",
  "context.usage.updated",
  "budget.updated",
  "artifact.created",
  "citation.created",
  "verification.completed",
  "memory.updated",
  "message.started",
  "message.completed",
  "guidance.accepted",
  "guidance.applied",
  "guidance.superseded",
  "guidance.rejected",
  "guidance.failed",
  "run.completed",
  "run.cancelled",
  "run.failed"
] as const;

export type V2AgentEventType = (typeof V2_AGENT_EVENT_TYPES)[number];
export type V2EventSource = "live" | "fixture";
export type V2PublicText = string | null;
export type V2SourceType =
  | "web"
  | "official_docs"
  | "news"
  | "academic"
  | "code"
  | "dataset"
  | "private"
  | "user_attachment"
  | "social";
export type V2ReasonCode =
  | "direct_answer"
  | "search_required"
  | "missing_critical_field"
  | "freshness_required"
  | "source_policy"
  | "insufficient_evidence"
  | "conflicting_evidence"
  | "unsupported_claim"
  | "user_cancelled"
  | "budget_exhausted"
  | "provider_error"
  | "schema_invalid"
  | "tool_error"
  | "verification_failed"
  | "completed"
  | "partial";

export interface V2Scope {
  readonly tenantId: string;
  readonly actorId: string;
  readonly visitorId: string;
  readonly projectId: string | null;
  readonly threadId: string;
}

export interface V2EventRefs {
  readonly planRef?: string;
  readonly toolCallId?: string;
  readonly artifactId?: string;
  readonly citationId?: string;
  readonly messageId?: string;
  readonly commandId?: string;
  readonly responseId?: string;
  readonly checkpointRef?: string;
}

export interface V2ToolDisplay {
  readonly registryTitle: string;
  readonly category: "search" | "fetch" | "retrieve" | "transform" | "verify" | "other";
  readonly parameterSummary: string | null;
  readonly resultSummary: string | null;
  readonly errorMessage: string | null;
  readonly resultCount: number | null;
  readonly resultType: "links" | "pages" | "passages" | "records" | "artifacts" | "none" | null;
  readonly sourceTypes: readonly V2SourceType[];
  readonly durationMs: number | null;
  readonly costUsd: string | null;
  readonly attemptStatus: "pending" | "confirmed" | "unknown";
  readonly approvalStatus: "none" | "required" | "approved" | "denied";
  readonly errorCode: string | null;
}

export interface V2Actor {
  readonly actorId: string;
  readonly actorType: "visitor" | "user" | "service";
}

export interface V2SteeringCommand {
  readonly schemaVersion: "2.0";
  readonly commandId: string;
  readonly runId: string;
  readonly threadId: string;
  readonly expectedSteeringRevision: number;
  readonly kind: "steer";
  readonly mode: "at_next_checkpoint";
  readonly content: string;
  readonly attachmentRefs: readonly [];
  readonly createdAt: string;
  readonly idempotencyKey: string;
  readonly contentHash: string;
  readonly actor: V2Actor;
  readonly scope: V2Scope;
}

export interface V2ModelUsage {
  readonly provider: string;
  readonly model: string;
  readonly pricingVersion: string;
  readonly currency: "USD";
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly reasoningTokens: number;
  readonly cacheHitInputTokens: number;
  readonly cacheMissInputTokens: number;
  readonly estimatedCostUsd: string;
  readonly actualCostUsd: string | null;
  readonly possibleDuplicateCostUsd: string;
}

export interface V2ToolUsage {
  readonly toolId: string;
  readonly toolVersion: string;
  readonly provider: string;
  readonly pricingVersion: string;
  readonly currency: "USD";
  readonly calls: number;
  readonly attempts: number;
  readonly units: number;
  readonly bytes: number;
  readonly resultCount: number;
  readonly searchQueries: number;
  readonly pageReads: number;
  readonly estimatedCostUsd: string;
  readonly actualCostUsd: string | null;
  readonly possibleDuplicateCostUsd: string;
}

export interface V2RunUsage {
  readonly currency: "USD";
  readonly modelBreakdown: readonly V2ModelUsage[];
  readonly toolBreakdown: readonly V2ToolUsage[];
  readonly totals: {
    readonly modelCalls: number;
    readonly toolCalls: number;
    readonly searchQueries: number;
    readonly pageReads: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
    readonly reasoningTokens: number;
    readonly peakParallelTools: number;
    readonly elapsedMs: number;
    readonly estimatedCostUsd: string;
    readonly actualCostUsd: string | null;
    readonly possibleDuplicateCostUsd: string;
  };
}

export interface V2BudgetCounter {
  readonly max: number;
  readonly used: number;
  readonly reserved: number;
  readonly remaining: number;
}

export interface V2MoneyBudgetCounter {
  readonly max: string;
  readonly used: string;
  readonly reserved: string;
  readonly remaining: string;
}

export interface V2Budget {
  readonly deadlineAt: string;
  readonly modelCalls: V2BudgetCounter;
  readonly inputTokens: V2BudgetCounter;
  readonly outputTokens: V2BudgetCounter;
  readonly costUsd: V2MoneyBudgetCounter;
  readonly planRevisions: V2BudgetCounter;
  readonly searchQueries: V2BudgetCounter;
  readonly pageReads: V2BudgetCounter;
  readonly toolCalls: V2BudgetCounter;
  readonly parallelTools: V2BudgetCounter;
  readonly wallTimeMs: V2BudgetCounter;
  readonly exhausted: boolean;
}

export interface V2ModelAttempt {
  readonly attemptId: string;
  readonly ordinal: number;
  readonly status: "confirmed" | "unknown";
  readonly possibleDuplicateCostUsd: string | null;
}

export interface V2ArtifactRef {
  readonly artifactId: string;
  readonly kind: "document" | "table" | "dataset" | "snapshot" | "report";
  readonly contentHash: string;
  readonly storageRef: string;
}

export interface V2ContextSectionUsage {
  readonly originalTokens: number;
  readonly retainedTokens: number;
  readonly status: "retained" | "truncated" | "omitted";
}

export interface V2ContextSections {
  readonly system: V2ContextSectionUsage;
  readonly history: V2ContextSectionUsage;
  readonly projectMemory: V2ContextSectionUsage;
  readonly retrieval: V2ContextSectionUsage;
  readonly toolResults: V2ContextSectionUsage;
  readonly attachments: V2ContextSectionUsage;
  readonly userInput: V2ContextSectionUsage;
}

type NodeBase = {
  readonly node: string;
  readonly nodeExecutionId: string;
  readonly executionKind: "model" | "deterministic";
  readonly ordinal: number;
  readonly attemptNumber: number;
  readonly publicText: V2PublicText;
  readonly reasonCodes: readonly V2ReasonCode[];
};
type ToolBase = {
  readonly toolCallId: string;
  readonly toolId: string;
  readonly display: V2ToolDisplay;
  readonly attempt: number;
  readonly publicText: null;
  readonly reasonCodes: readonly V2ReasonCode[];
};
type TerminalUsage = {
  readonly usage: V2RunUsage;
  readonly budget: V2Budget;
};

export interface V2AgentPayloadByType {
  readonly "run.created": {
    readonly agentId: string;
    readonly modelId: string;
    readonly graphVersion: string;
    readonly runRevision: number;
    readonly budget: V2Budget;
  };
  readonly "run.status": {
    readonly status: "queued" | "running" | "waiting";
    readonly stateRevision: number;
    readonly node: string;
    readonly publicText: V2PublicText;
    readonly reasonCodes: readonly V2ReasonCode[];
  };
  readonly "node.started": NodeBase & { readonly publicText: null };
  readonly "node.completed": NodeBase & {
    readonly resultRef: string;
    readonly resultHash: string;
    readonly durationMs: number;
    readonly modelUsage: V2ModelUsage | null;
    readonly modelAttempt: V2ModelAttempt | null;
  };
  readonly "node.failed": NodeBase & {
    readonly errorCode: string;
    readonly durationMs: number;
    readonly retryable: boolean;
    readonly modelUsage: V2ModelUsage | null;
    readonly modelAttempt: V2ModelAttempt | null;
  };
  readonly "plan.updated": {
    readonly planRef: string;
    readonly revision: number;
    readonly publicText: V2PublicText;
    readonly reasonCodes: readonly V2ReasonCode[];
  };
  readonly "tool.started": ToolBase & {
    readonly planStepId: string;
    readonly inputHash: string;
  };
  readonly "tool.updated": ToolBase & {
    readonly phase: "progress" | "retrying" | "waiting_approval";
  };
  readonly "tool.completed": ToolBase & {
    readonly resultRef: string;
    readonly outputHash: string;
    readonly resultCount: number;
    readonly artifactCount: number;
    readonly evidenceCount: number;
    readonly durationMs: number;
    readonly usage: V2ToolUsage;
  };
  readonly "tool.failed": ToolBase & {
    readonly errorCode: string;
    readonly retryable: boolean;
    readonly durationMs: number;
    readonly usage: V2ToolUsage;
  };
  readonly "tool.unknown": ToolBase & {
    readonly operationRef: string;
    readonly errorCode: string;
    readonly nextAction: "check_operation";
    readonly durationMs: number;
    readonly usage: V2ToolUsage;
  };
  readonly "approval.required": {
    readonly approvalId: string;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly actionSummary: string;
    readonly permissionSummary: string;
    readonly expiresAt: string;
    readonly publicText: null;
    readonly reasonCodes: readonly V2ReasonCode[];
  };
  readonly "approval.decided": {
    readonly approvalId: string;
    readonly toolCallId: string;
    readonly decision: "allow_once" | "deny" | "edit";
    readonly decidedBy: V2Actor;
    readonly decidedAt: string;
    readonly publicText: null;
    readonly reasonCodes: readonly V2ReasonCode[];
  };
  readonly "clarification.required": {
    readonly clarificationId: string;
    readonly question: string;
    readonly checkpointRef: string;
    readonly stateRevision: number;
    readonly expiresAt: string;
    readonly publicText: null;
    readonly reasonCodes: readonly V2ReasonCode[];
  };
  readonly "clarification.resumed": {
    readonly clarificationId: string;
    readonly checkpointRef: string;
    readonly responseMessageRef: string;
    readonly responseHash: string;
    readonly resumedAtStateRevision: number;
    readonly idempotencyKey: string;
    readonly publicText: null;
    readonly reasonCodes: readonly V2ReasonCode[];
  };
  readonly "context.usage.updated": {
    readonly modelLimitTokens: number;
    readonly estimatedInputTokens: number;
    readonly actualInputTokens: number | null;
    readonly reservedOutputTokens: number;
    readonly safetyMarginTokens: number;
    readonly remainingTokens: number;
    readonly utilizationBasisPoints: number;
    readonly isEstimate: boolean;
    readonly contextRevision: number;
    readonly sections: V2ContextSections;
    readonly publicText: null;
    readonly reasonCodes: readonly V2ReasonCode[];
  };
  readonly "budget.updated": {
    readonly budgetRevision: number;
    readonly pricingVersion: string;
    readonly budget: V2Budget;
    readonly usage: V2RunUsage;
    readonly possibleDuplicateCostUsd: string;
    readonly exhausted: boolean;
    readonly publicText: null;
    readonly reasonCodes: readonly V2ReasonCode[];
  };
  readonly "artifact.created": { readonly artifact: V2ArtifactRef };
  readonly "citation.created": {
    readonly citationId: string;
    readonly claimId: string;
    readonly evidenceId: string;
    readonly locatorVerified: boolean;
  };
  readonly "verification.completed": {
    readonly passed: boolean;
    readonly unsupportedClaimIds: readonly string[];
    readonly verifiedCitationIds: readonly string[];
    readonly draftRevision: number;
    readonly publicText: V2PublicText;
    readonly reasonCodes: readonly V2ReasonCode[];
  };
  readonly "memory.updated": {
    readonly memoryRef: string;
    readonly sourceResponseId: string;
    readonly exchangeVerified: true;
  };
  readonly "message.started": {
    readonly messageId: string;
    readonly role: "user" | "assistant";
    readonly steeringRevision: number;
  };
  readonly "message.completed": {
    readonly messageId: string;
    readonly role: "user" | "assistant";
    readonly contentRef: string;
    readonly contentHash: string;
    readonly responseId: string | null;
    readonly steeringRevision: number;
    readonly verified: boolean;
  };
  readonly "guidance.accepted": {
    readonly commandId: string;
    readonly commandSeq: number;
    readonly expectedSteeringRevision: number;
    readonly acceptedAtStateRevision: number;
    readonly currentSteeringRevision: number;
    readonly pendingApply: true;
    readonly idempotencyKey: string;
  };
  readonly "guidance.applied": {
    readonly batchId: string;
    readonly commandId: string;
    readonly commandSeq: number;
    readonly previousSteeringRevision: number;
    readonly newSteeringRevision: number;
    readonly acceptedAtStateRevision: number;
    readonly appliedAtStateRevision: number;
    readonly appliedAtNode: string;
    readonly checkpointRef: string;
    readonly impact: "format_only" | "replan" | "permission_change" | "cancel_requested";
    readonly invalidatedPlanRefs: readonly string[];
    readonly invalidatedDraftRefs: readonly string[];
    readonly invalidatedVerificationRefs: readonly string[];
    readonly invalidatedArtifactRefs: readonly string[];
    readonly newPlanRef: string | null;
  };
  readonly "guidance.superseded": {
    readonly batchId: string;
    readonly commandId: string;
    readonly commandSeq: number;
    readonly previousSteeringRevision: number;
    readonly newSteeringRevision: number;
    readonly supersededByCommandId: string;
    readonly reason: "last_write_wins" | "permission_precedence" | "cancel_precedence" | "terminal";
  };
  readonly "guidance.rejected": {
    readonly commandId: string;
    readonly commandSeq: number;
    readonly code: "COMMAND_REVISION_CONFLICT" | "COMMAND_AFTER_TERMINAL" | "COMMAND_SCOPE_MISMATCH";
    readonly actualSteeringRevision: number;
  };
  readonly "guidance.failed": {
    readonly commandId: string;
    readonly commandSeq: number;
    readonly errorCode: string;
    readonly errorMessage: string | null;
    readonly retryable: boolean;
  };
  readonly "run.completed": TerminalUsage & {
    readonly responseId: string;
    readonly responseStatus: "completed" | "partial";
    readonly stopReason: string;
  };
  readonly "run.cancelled": TerminalUsage & { readonly stopReason: "user_cancelled" };
  readonly "run.failed": TerminalUsage & {
    readonly stopReason: string;
    readonly errorCode: string;
  };
}

export type V2EventKindByType = {
  readonly "run.created": "run";
  readonly "run.status": "run";
  readonly "node.started": "node";
  readonly "node.completed": "node";
  readonly "node.failed": "node";
  readonly "plan.updated": "plan";
  readonly "tool.started": "tool";
  readonly "tool.updated": "tool";
  readonly "tool.completed": "tool";
  readonly "tool.failed": "tool";
  readonly "tool.unknown": "tool";
  readonly "approval.required": "approval";
  readonly "approval.decided": "approval";
  readonly "clarification.required": "clarification";
  readonly "clarification.resumed": "clarification";
  readonly "context.usage.updated": "context";
  readonly "budget.updated": "budget";
  readonly "artifact.created": "artifact";
  readonly "citation.created": "citation";
  readonly "verification.completed": "verification";
  readonly "memory.updated": "memory";
  readonly "message.started": "message";
  readonly "message.completed": "message";
  readonly "guidance.accepted": "guidance";
  readonly "guidance.applied": "guidance";
  readonly "guidance.superseded": "guidance";
  readonly "guidance.rejected": "guidance";
  readonly "guidance.failed": "guidance";
  readonly "run.completed": "run";
  readonly "run.cancelled": "run";
  readonly "run.failed": "run";
};

export type V2EventStatusByType = {
  readonly "run.created": "pending";
  readonly "run.status": "running" | "waiting" | "waiting_approval" | "waiting_clarification";
  readonly "node.started": "running";
  readonly "node.completed": "completed";
  readonly "node.failed": "failed";
  readonly "plan.updated": "completed";
  readonly "tool.started": "running";
  readonly "tool.updated": "running" | "waiting_approval";
  readonly "tool.completed": "completed";
  readonly "tool.failed": "failed";
  readonly "tool.unknown": "unknown";
  readonly "approval.required": "waiting_approval";
  readonly "approval.decided": "completed";
  readonly "clarification.required": "waiting_clarification";
  readonly "clarification.resumed": "completed";
  readonly "context.usage.updated": "completed";
  readonly "budget.updated": "completed";
  readonly "artifact.created": "completed";
  readonly "citation.created": "completed";
  readonly "verification.completed": "completed";
  readonly "memory.updated": "completed";
  readonly "message.started": "running";
  readonly "message.completed": "completed";
  readonly "guidance.accepted": "pending";
  readonly "guidance.applied": "completed";
  readonly "guidance.superseded": "superseded";
  readonly "guidance.rejected": "rejected";
  readonly "guidance.failed": "failed";
  readonly "run.completed": "completed";
  readonly "run.cancelled": "cancelled";
  readonly "run.failed": "failed";
};

export type V2AgentEvent<T extends V2AgentEventType = V2AgentEventType> = T extends V2AgentEventType
  ? {
      readonly schemaVersion: "2.0";
      readonly eventId: string;
      readonly runId: string;
      readonly scope: V2Scope;
      readonly seq: number;
      readonly occurredAt: string;
      readonly type: T;
      readonly kind: V2EventKindByType[T];
      readonly status: V2EventStatusByType[T];
      readonly startedAt: string | null;
      readonly completedAt: string | null;
      readonly inputRevision: number;
      readonly refs: V2EventRefs;
      readonly source: V2EventSource;
      readonly payload: V2AgentPayloadByType[T];
    }
  : never;

export interface V2RunQueueEntry {
  readonly schemaVersion: "2.0";
  readonly queueEntryId: string;
  readonly threadId: string;
  readonly messageRef: string;
  readonly runId: string | null;
  readonly position: number;
  readonly queueRevision: number;
  readonly status: "queued" | "starting" | "running" | "cancelled" | "failed" | "completed";
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly idempotencyKey: string;
  readonly scope: V2Scope;
  readonly publicDisplay: {
    readonly messagePreview: string | null;
    readonly attachmentCount: number;
  };
}

export interface V2ThreadQueueEvent {
  readonly schemaVersion: "2.0";
  readonly eventId: string;
  readonly threadId: string;
  readonly scope: V2Scope;
  readonly queueCursor: number;
  readonly queueRevision: number;
  readonly occurredAt: string;
  readonly type: "queue.updated";
  readonly source: V2EventSource;
  readonly payload: {
    readonly transition: "enqueued" | "edited" | "cancelled" | "dequeued" | "paused" | "resumed" | "snapshot";
    readonly expectedPreviousRevision: number;
    readonly trigger: {
      readonly runId: string;
      readonly terminalStatus: "completed" | "cancelled" | "failed";
    } | null;
    readonly entries: readonly V2RunQueueEntry[];
    readonly activeRunIds: readonly string[];
    readonly autoStartNext: boolean;
    readonly paused: boolean;
    readonly pauseReason: "stopped" | "failed" | "manual" | "revision_conflict" | null;
  };
}

export type V2AdapterErrorCode = "PRIVATE_REASONING_FORBIDDEN" | "SCHEMA_INVALID";
export type V2ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errorCode: V2AdapterErrorCode };
