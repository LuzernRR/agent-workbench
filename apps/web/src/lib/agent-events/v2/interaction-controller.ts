import { parseV2SteeringCommand } from "./adapter";
import type {
  V2Actor,
  V2AgentEvent,
  V2Scope,
  V2SteeringCommand
} from "./types";

export type V2InteractionCommandKind =
  | "steer"
  | "enqueue"
  | "clarification_resume"
  | "approval_decision";

export type V2InteractionCommandStatus =
  | "submitting"
  | "accepted_pending"
  | "applied"
  | "superseded"
  | "rejected"
  | "failed";

export type V2InteractionErrorCode =
  | "COMMAND_REVISION_CONFLICT"
  | "COMMAND_AFTER_TERMINAL"
  | "COMMAND_SCOPE_MISMATCH"
  | "STEERING_ATTACHMENTS_UNSUPPORTED"
  | "CLARIFICATION_ALREADY_RESUMED"
  | "CLARIFICATION_STALE_CHECKPOINT"
  | "APPROVAL_ALREADY_DECIDED"
  | "RUN_TERMINAL"
  | "NETWORK_ERROR"
  | "SCHEMA_INVALID"
  | "EVENT_REJECTED"
  | "COMMAND_EVIDENCE_MISMATCH"
  | "COMMAND_ALREADY_IN_FLIGHT"
  | string;

export interface V2CommandSnapshot {
  readonly content: string;
  readonly attachmentRefs: readonly string[];
}

interface V2CommandBase {
  readonly schemaVersion: "2.0";
  readonly commandId: string;
  readonly runId: string;
  readonly threadId: string;
  readonly createdAt: string;
  readonly idempotencyKey: string;
  readonly contentHash: string;
  readonly actor: V2Actor;
  readonly scope: V2Scope;
}

export interface V2EnqueueCommand extends V2CommandBase {
  readonly kind: "enqueue";
  readonly content: string;
  readonly attachmentRefs: readonly string[];
}

export interface V2ClarificationResumeCommand extends V2CommandBase {
  readonly kind: "clarification_resume";
  readonly clarificationId: string;
  readonly checkpointRef: string;
  readonly expectedStateRevision: number;
  readonly content: string;
  readonly attachmentRefs: readonly string[];
}

export interface V2ApprovalDecisionCommand extends V2CommandBase {
  readonly kind: "approval_decision";
  readonly approvalId: string;
  readonly toolCallId: string;
  readonly decision: "allow_once" | "deny";
}

export type V2InteractionWireCommand =
  | V2SteeringCommand
  | V2EnqueueCommand
  | V2ClarificationResumeCommand
  | V2ApprovalDecisionCommand;

export interface V2ClientCommandState {
  readonly commandId: string;
  readonly kind: V2InteractionCommandKind;
  readonly idempotencyKey: string;
  readonly contentHash: string;
  readonly status: V2InteractionCommandStatus;
  readonly snapshot: V2CommandSnapshot;
  readonly errorCode: V2InteractionErrorCode | null;
  readonly retryable: boolean;
}

export interface V2InteractionControllerState {
  readonly order: readonly string[];
  readonly commands: Readonly<Record<string, V2ClientCommandState>>;
}

export type V2InteractionAdapterResult =
  | {
      readonly outcome: "accepted";
      readonly evidence: V2AgentEvent | null;
    }
  | {
      readonly outcome: "rejected";
      readonly errorCode: V2InteractionErrorCode;
    }
  | {
      readonly outcome: "failed";
      readonly errorCode: V2InteractionErrorCode;
      readonly retryable: boolean;
    };

export interface V2InteractionAdapter {
  steer(command: V2SteeringCommand): Promise<V2InteractionAdapterResult>;
  enqueue(command: V2EnqueueCommand): Promise<V2InteractionAdapterResult>;
  resumeClarification(command: V2ClarificationResumeCommand): Promise<V2InteractionAdapterResult>;
  decideApproval(command: V2ApprovalDecisionCommand): Promise<V2InteractionAdapterResult>;
}

export interface V2InteractionControllerOptions {
  readonly adapter: V2InteractionAdapter;
  readonly onEvidence?: (event: V2AgentEvent) => boolean;
  readonly randomId?: () => string;
  readonly now?: () => string;
}

export interface V2CommandContext {
  readonly runId: string;
  readonly threadId: string;
  readonly scope: V2Scope;
  readonly actor: V2Actor;
}

export interface V2SteerInput extends V2CommandContext {
  readonly expectedSteeringRevision: number;
  readonly content: string;
  readonly attachmentRefs: readonly string[];
}

export interface V2EnqueueInput extends V2CommandContext {
  readonly content: string;
  readonly attachmentRefs: readonly string[];
}

export interface V2ClarificationResumeInput extends V2CommandContext {
  readonly clarificationId: string;
  readonly checkpointRef: string;
  readonly expectedStateRevision: number;
  readonly content: string;
  readonly attachmentRefs: readonly string[];
}

export interface V2ApprovalDecisionInput extends V2CommandContext {
  readonly approvalId: string;
  readonly toolCallId: string;
  readonly decision: "allow_once" | "deny";
}

type Listener = () => void;

function defaultRandomId() {
  return crypto.randomUUID().replaceAll("-", "_");
}

export function normalizeV2CommandContent(content: string) {
  return content.normalize("NFC").replace(/\r\n?/gu, "\n").trim();
}

function canonicalScope(scope: V2Scope) {
  return {
    tenantId: scope.tenantId,
    actorId: scope.actorId,
    visitorId: scope.visitorId,
    projectId: scope.projectId,
    threadId: scope.threadId
  };
}

export async function hashV2CommandContent(input: {
  readonly content: string;
  readonly attachmentRefs: readonly string[];
  readonly scope: V2Scope;
}) {
  const normalized = normalizeV2CommandContent(input.content);
  const canonical = JSON.stringify({
    content: normalized,
    attachmentRefs: [...input.attachmentRefs],
    scope: canonicalScope(input.scope)
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function eventStatus(event: V2AgentEvent): V2InteractionCommandStatus {
  if (event.type === "guidance.accepted") return "accepted_pending";
  if (event.type === "guidance.applied") return "applied";
  if (event.type === "guidance.superseded") return "superseded";
  if (event.type === "guidance.rejected") return "rejected";
  if (event.type === "guidance.failed") return "failed";
  if (event.type === "clarification.resumed" || event.type === "approval.decided") return "applied";
  return "accepted_pending";
}

function evidencePatch(event: V2AgentEvent): Partial<V2ClientCommandState> {
  return {
    status: eventStatus(event),
    errorCode: event.type === "guidance.rejected"
      ? event.payload.code
      : event.type === "guidance.failed"
        ? event.payload.errorCode
        : null,
    retryable: event.type === "guidance.failed"
      ? event.payload.retryable
      : false
  };
}

const GUIDANCE_EVENT_TYPES = new Set<V2AgentEvent["type"]>([
  "guidance.accepted",
  "guidance.applied",
  "guidance.superseded",
  "guidance.rejected",
  "guidance.failed"
]);

interface V2GuidanceReceipt {
  readonly commandSeq: number;
  readonly expectedSteeringRevision: number;
  readonly acceptedAtStateRevision: number;
  readonly currentSteeringRevision: number;
  readonly idempotencyKey: string;
}

type V2EvidenceDisposition =
  | "accepted"
  | "mismatch"
  | "event_rejected"
  | "unmatched";

function sameScope(left: V2Scope, right: V2Scope) {
  return left.tenantId === right.tenantId
    && left.actorId === right.actorId
    && left.visitorId === right.visitorId
    && left.projectId === right.projectId
    && left.threadId === right.threadId;
}

function sameRefs(left: readonly string[], right: readonly string[]) {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

/**
 * 证据必须属于原命令（HANDOFF 阻断项 2）。
 *
 * 每条 typed 事件只能推进产生它的那条 client command：
 * - steer / enqueue 走 guidance.* ，靠 payload.commandId 关联。
 * - clarification_resume 走 clarification.resumed ，靠 clarificationId
 *   + idempotencyKey + checkpointRef 关联。
 * - approval_decision 走 approval.decided ，靠 approvalId + toolCallId
 *   + decision 关联。
 *
 * 任何字段错配都判为不属于本命令：既不应用、也不调用 onEvidence 推进 reducer。
 */
function evidenceBelongsToCommand(
  request: V2InteractionWireCommand,
  event: V2AgentEvent,
  guidanceReceipt: V2GuidanceReceipt | null
): boolean {
  if (
    event.runId !== request.runId
    || event.scope.threadId !== request.threadId
    || !sameScope(event.scope, request.scope)
  ) return false;

  if (request.kind === "steer") {
    if (!GUIDANCE_EVENT_TYPES.has(event.type)) return false;
    const payload = event.payload as {
      readonly commandId?: string;
      readonly commandSeq?: number;
    };
    if (
      payload.commandId !== request.commandId
      || event.refs.commandId !== request.commandId
    ) return false;

    if (event.type === "guidance.accepted") {
      return event.payload.idempotencyKey === request.idempotencyKey
        && event.payload.expectedSteeringRevision === request.expectedSteeringRevision
        && event.payload.currentSteeringRevision === request.expectedSteeringRevision
        && (!guidanceReceipt || (
          event.payload.commandSeq === guidanceReceipt.commandSeq
          && event.payload.expectedSteeringRevision === guidanceReceipt.expectedSteeringRevision
          && event.payload.acceptedAtStateRevision === guidanceReceipt.acceptedAtStateRevision
          && event.payload.currentSteeringRevision === guidanceReceipt.currentSteeringRevision
          && event.payload.idempotencyKey === guidanceReceipt.idempotencyKey
        ));
    }

    if (!guidanceReceipt || payload.commandSeq !== guidanceReceipt.commandSeq) {
      return false;
    }
    if (event.type === "guidance.applied") {
      return event.payload.acceptedAtStateRevision === guidanceReceipt.acceptedAtStateRevision
        && event.payload.previousSteeringRevision === guidanceReceipt.currentSteeringRevision
        && event.payload.newSteeringRevision === event.payload.previousSteeringRevision + 1
        && event.payload.appliedAtStateRevision > event.payload.acceptedAtStateRevision
        && event.payload.checkpointRef === event.refs.checkpointRef;
    }
    if (event.type === "guidance.superseded") {
      return event.payload.previousSteeringRevision === guidanceReceipt.currentSteeringRevision
        && event.payload.newSteeringRevision === event.payload.previousSteeringRevision + 1;
    }
    return true;
  }

  // enqueue 由独立的 ThreadQueueEvent 证明；AgentEvent 不能冒充入队回执。
  if (request.kind === "enqueue") return false;

  if (request.kind === "clarification_resume") {
    if (event.type !== "clarification.resumed") return false;
    const payload = event.payload;
    return payload.clarificationId === request.clarificationId
      && payload.checkpointRef === request.checkpointRef
      && payload.idempotencyKey === request.idempotencyKey
      && payload.responseHash === request.contentHash
      && payload.resumedAtStateRevision === request.expectedStateRevision + 1
      && event.refs.checkpointRef === request.checkpointRef
      && event.refs.messageId === payload.responseMessageRef;
  }

  // approval_decision
  if (event.type !== "approval.decided") return false;
  const payload = event.payload;
  return payload.approvalId === request.approvalId
    && payload.toolCallId === request.toolCallId
    && payload.decision === request.decision
    && event.refs.toolCallId === request.toolCallId
    && payload.decidedBy.actorId === request.actor.actorId
    && payload.decidedBy.actorType === request.actor.actorType;
}

export class V2InteractionController {
  private readonly adapter: V2InteractionAdapter;
  private readonly onEvidence?: (event: V2AgentEvent) => boolean;
  private readonly randomId: () => string;
  private readonly now: () => string;
  private readonly listeners = new Set<Listener>();
  private readonly requests = new Map<string, V2InteractionWireCommand>();
  private readonly guidanceReceipts = new Map<string, V2GuidanceReceipt>();
  private readonly guidanceCommandBySeq = new Map<number, string>();
  private readonly processedEvidenceIds = new Set<string>();
  // 同一澄清/审批对象共享同一个在途 Promise，因此双击不会产生第二条命令、
  // 第二个幂等键或第二次 adapter 调用。
  private readonly inFlightByObject = new Map<string, Promise<V2ClientCommandState>>();
  private readonly lastCommandByObject = new Map<string, string>();
  private state: V2InteractionControllerState = { order: [], commands: {} };

  constructor(options: V2InteractionControllerOptions) {
    this.adapter = options.adapter;
    this.onEvidence = options.onEvidence;
    this.randomId = options.randomId ?? defaultRandomId;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  getState() {
    return this.state;
  }

  /**
   * 阻断项 3：同一逻辑对象的在途去重键。
   *
   * 澄清按 clarificationId、审批按 approvalId 归组。双击会在第一次
   * 请求的异步 hash 完成之前再次触发，所以这个键必须能同步算出、
   * 同步占用，才能真正挡住第二次点击。steer / enqueue 由 Composer 的
   * 提交锁保护，这里不参与对象级去重，返回 null。
   */
  private static logicalObjectKey(
    kind: V2InteractionCommandKind,
    ids: { readonly clarificationId?: string; readonly approvalId?: string }
  ): string | null {
    if (kind === "clarification_resume" && ids.clarificationId) {
      return `clarification:${ids.clarificationId}`;
    }
    if (kind === "approval_decision" && ids.approvalId) {
      return `approval:${ids.approvalId}`;
    }
    return null;
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    this.listeners.forEach((listener) => listener());
  }

  private update(commandId: string, patch: Partial<V2ClientCommandState>) {
    const current = this.state.commands[commandId];
    if (!current) return;
    this.state = {
      ...this.state,
      commands: {
        ...this.state.commands,
        [commandId]: { ...current, ...patch }
      }
    };
    this.emit();
  }

  private runForObject(
    objectKey: string,
    operation: () => Promise<V2ClientCommandState>
  ): Promise<V2ClientCommandState> {
    const current = this.inFlightByObject.get(objectKey);
    if (current) return current;

    let guarded!: Promise<V2ClientCommandState>;
    guarded = Promise.resolve()
      .then(operation)
      .finally(() => {
        if (this.inFlightByObject.get(objectKey) === guarded) {
          this.inFlightByObject.delete(objectKey);
        }
      });
    this.inFlightByObject.set(objectKey, guarded);
    return guarded;
  }

  private async metadata(
    kind: V2InteractionCommandKind,
    content: string,
    attachmentRefs: readonly string[],
    scope: V2Scope
  ) {
    const suffix = this.randomId();
    const normalized = normalizeV2CommandContent(content);
    return {
      commandId: `command_${suffix}`,
      idempotencyKey: `idem_${suffix}`,
      contentHash: await hashV2CommandContent({
        content: normalized,
        attachmentRefs,
        scope
      }),
      createdAt: this.now(),
      kind,
      snapshot: {
        content: normalized,
        attachmentRefs: [...attachmentRefs]
      }
    } as const;
  }

  private register(metadata: Awaited<ReturnType<V2InteractionController["metadata"]>>) {
    const command: V2ClientCommandState = {
      commandId: metadata.commandId,
      kind: metadata.kind,
      idempotencyKey: metadata.idempotencyKey,
      contentHash: metadata.contentHash,
      status: "submitting",
      snapshot: metadata.snapshot,
      errorCode: null,
      retryable: false
    };
    this.state = {
      order: [...this.state.order, command.commandId],
      commands: { ...this.state.commands, [command.commandId]: command }
    };
    this.emit();
    return command;
  }

  private resolveEvidenceCommandId(event: V2AgentEvent): string | null {
    if (GUIDANCE_EVENT_TYPES.has(event.type)) {
      return (event.payload as { readonly commandId?: string }).commandId ?? null;
    }
    if (event.type !== "clarification.resumed" && event.type !== "approval.decided") {
      return null;
    }
    const matches = [...this.requests.entries()].filter(([commandId, request]) => {
      const command = this.state.commands[commandId];
      return Boolean(command)
        && evidenceBelongsToCommand(
          request,
          event,
          this.guidanceReceipts.get(commandId) ?? null
        );
    });
    return matches.length === 1 ? matches[0][0] : null;
  }

  private processEvidence(
    event: V2AgentEvent,
    expectedCommandId: string | null = null
  ): V2EvidenceDisposition {
    if (this.processedEvidenceIds.has(event.eventId)) return "accepted";

    const commandId = expectedCommandId ?? this.resolveEvidenceCommandId(event);
    if (!commandId) return "unmatched";
    const command = this.state.commands[commandId];
    const request = this.requests.get(commandId);
    if (!command || !request) return "unmatched";

    // 本地安全快照也必须仍属于原 request，避免被错误状态替换后继续吃证据。
    if (
      command.commandId !== request.commandId
      || command.kind !== request.kind
      || command.idempotencyKey !== request.idempotencyKey
      || command.contentHash !== request.contentHash
      || !evidenceBelongsToCommand(
        request,
        event,
        this.guidanceReceipts.get(commandId) ?? null
      )
    ) return "mismatch";

    if (event.type === "guidance.accepted") {
      const existing = this.guidanceCommandBySeq.get(event.payload.commandSeq);
      if (existing && existing !== commandId) return "mismatch";
    }

    // reducer 是 cursor/revision 的权威。只有真正归并成功后才迁移 client command；
    // 错配事件在此之前已被挡住，因此不会调用回调、也不会吞掉 cursor。
    if (!(this.onEvidence?.(event) ?? true)) return "event_rejected";

    this.processedEvidenceIds.add(event.eventId);
    if (event.type === "guidance.accepted") {
      const receipt: V2GuidanceReceipt = {
        commandSeq: event.payload.commandSeq,
        expectedSteeringRevision: event.payload.expectedSteeringRevision,
        acceptedAtStateRevision: event.payload.acceptedAtStateRevision,
        currentSteeringRevision: event.payload.currentSteeringRevision,
        idempotencyKey: event.payload.idempotencyKey
      };
      this.guidanceReceipts.set(commandId, receipt);
      this.guidanceCommandBySeq.set(receipt.commandSeq, commandId);
    }
    this.update(commandId, evidencePatch(event));
    return "accepted";
  }

  private async dispatch(
    command: V2ClientCommandState,
    request: V2InteractionWireCommand,
    send: () => Promise<V2InteractionAdapterResult>
  ) {
    this.requests.set(command.commandId, request);
    try {
      const result = await send();
      if (result.outcome === "rejected") {
        this.update(command.commandId, {
          status: "rejected",
          errorCode: result.errorCode,
          retryable: false
        });
      } else if (result.outcome === "failed") {
        this.update(command.commandId, {
          status: "failed",
          errorCode: result.errorCode,
          retryable: result.retryable
        });
      } else if (result.evidence) {
        const disposition = this.processEvidence(result.evidence, command.commandId);
        if (disposition === "mismatch" || disposition === "unmatched") {
          this.update(command.commandId, {
            status: "failed",
            errorCode: "COMMAND_EVIDENCE_MISMATCH",
            retryable: false
          });
        } else if (disposition === "event_rejected") {
          this.update(command.commandId, {
            status: "failed",
            errorCode: "EVENT_REJECTED",
            retryable: false
          });
        }
      } else {
        this.update(command.commandId, {
          status: "accepted_pending",
          errorCode: null,
          retryable: false
        });
      }
    } catch {
      this.update(command.commandId, {
        status: "failed",
        errorCode: "NETWORK_ERROR",
        retryable: true
      });
    }
    return this.state.commands[command.commandId];
  }

  async submitSteer(input: V2SteerInput) {
    const metadata = await this.metadata("steer", input.content, input.attachmentRefs, input.scope);
    const command = this.register(metadata);
    if (input.attachmentRefs.length > 0) {
      this.update(command.commandId, {
        status: "rejected",
        errorCode: "STEERING_ATTACHMENTS_UNSUPPORTED",
        retryable: false
      });
      return this.state.commands[command.commandId];
    }
    const request: V2SteeringCommand = {
      schemaVersion: "2.0",
      commandId: command.commandId,
      runId: input.runId,
      threadId: input.threadId,
      expectedSteeringRevision: input.expectedSteeringRevision,
      kind: "steer",
      mode: "at_next_checkpoint",
      content: command.snapshot.content,
      attachmentRefs: [],
      createdAt: metadata.createdAt,
      idempotencyKey: command.idempotencyKey,
      contentHash: command.contentHash,
      actor: input.actor,
      scope: input.scope
    };
    if (!parseV2SteeringCommand(request).ok) {
      this.update(command.commandId, {
        status: "failed",
        errorCode: "SCHEMA_INVALID",
        retryable: false
      });
      return this.state.commands[command.commandId];
    }
    return this.dispatch(command, request, () => this.adapter.steer(request));
  }

  async submitEnqueue(input: V2EnqueueInput) {
    const metadata = await this.metadata("enqueue", input.content, input.attachmentRefs, input.scope);
    const command = this.register(metadata);
    const request: V2EnqueueCommand = {
      schemaVersion: "2.0",
      commandId: command.commandId,
      runId: input.runId,
      threadId: input.threadId,
      kind: "enqueue",
      content: command.snapshot.content,
      attachmentRefs: command.snapshot.attachmentRefs,
      createdAt: metadata.createdAt,
      idempotencyKey: command.idempotencyKey,
      contentHash: command.contentHash,
      actor: input.actor,
      scope: input.scope
    };
    return this.dispatch(command, request, () => this.adapter.enqueue(request));
  }

  private matchingClarificationRetry(
    objectKey: string,
    input: V2ClarificationResumeInput
  ): string | null {
    const commandId = this.lastCommandByObject.get(objectKey);
    const command = commandId ? this.state.commands[commandId] : null;
    const request = commandId ? this.requests.get(commandId) : null;
    if (!commandId || !command?.retryable || request?.kind !== "clarification_resume") {
      return null;
    }
    return request.runId === input.runId
      && request.threadId === input.threadId
      && sameScope(request.scope, input.scope)
      && request.clarificationId === input.clarificationId
      && request.checkpointRef === input.checkpointRef
      && request.expectedStateRevision === input.expectedStateRevision
      && request.content === normalizeV2CommandContent(input.content)
      && sameRefs(request.attachmentRefs, input.attachmentRefs)
      ? commandId
      : null;
  }

  resumeClarification(input: V2ClarificationResumeInput) {
    const objectKey = V2InteractionController.logicalObjectKey(
      "clarification_resume",
      { clarificationId: input.clarificationId }
    )!;
    return this.runForObject(objectKey, async () => {
      const retryCommandId = this.matchingClarificationRetry(objectKey, input);
      if (retryCommandId) return this.retryUnlocked(retryCommandId);

      const metadata = await this.metadata(
        "clarification_resume",
        input.content,
        input.attachmentRefs,
        input.scope
      );
      const command = this.register(metadata);
      const request: V2ClarificationResumeCommand = {
        schemaVersion: "2.0",
        commandId: command.commandId,
        runId: input.runId,
        threadId: input.threadId,
        kind: "clarification_resume",
        clarificationId: input.clarificationId,
        checkpointRef: input.checkpointRef,
        expectedStateRevision: input.expectedStateRevision,
        content: command.snapshot.content,
        attachmentRefs: command.snapshot.attachmentRefs,
        createdAt: metadata.createdAt,
        idempotencyKey: command.idempotencyKey,
        contentHash: command.contentHash,
        actor: input.actor,
        scope: input.scope
      };
      this.lastCommandByObject.set(objectKey, command.commandId);
      return this.dispatch(command, request, () => this.adapter.resumeClarification(request));
    });
  }

  private matchingApprovalRetry(
    objectKey: string,
    input: V2ApprovalDecisionInput
  ): string | null {
    const commandId = this.lastCommandByObject.get(objectKey);
    const command = commandId ? this.state.commands[commandId] : null;
    const request = commandId ? this.requests.get(commandId) : null;
    if (!commandId || !command?.retryable || request?.kind !== "approval_decision") {
      return null;
    }
    return request.runId === input.runId
      && request.threadId === input.threadId
      && sameScope(request.scope, input.scope)
      && request.approvalId === input.approvalId
      && request.toolCallId === input.toolCallId
      && request.decision === input.decision
      ? commandId
      : null;
  }

  decideApproval(input: V2ApprovalDecisionInput) {
    const objectKey = V2InteractionController.logicalObjectKey(
      "approval_decision",
      { approvalId: input.approvalId }
    )!;
    return this.runForObject(objectKey, async () => {
      const retryCommandId = this.matchingApprovalRetry(objectKey, input);
      if (retryCommandId) return this.retryUnlocked(retryCommandId);

      const metadata = await this.metadata(
        "approval_decision",
        `approval:${input.decision}`,
        [],
        input.scope
      );
      const command = this.register(metadata);
      const request: V2ApprovalDecisionCommand = {
        schemaVersion: "2.0",
        commandId: command.commandId,
        runId: input.runId,
        threadId: input.threadId,
        kind: "approval_decision",
        approvalId: input.approvalId,
        toolCallId: input.toolCallId,
        decision: input.decision,
        createdAt: metadata.createdAt,
        idempotencyKey: command.idempotencyKey,
        contentHash: command.contentHash,
        actor: input.actor,
        scope: input.scope
      };
      this.lastCommandByObject.set(objectKey, command.commandId);
      return this.dispatch(command, request, () => this.adapter.decideApproval(request));
    });
  }

  /**
   * 阻断项 4：晚到事件必须能迁移同一 client command。
   *
   * steer 的第一响应是 guidance.accepted（accepted_pending，中间态），
   * 真正的 applied/superseded/rejected/failed 往往稍后才从事件流到达。
   * 这个入口按 payload.commandId 找到原始命令并原位迁移它的状态，
   * 而不是新建一条命令，从而让「已接收 → 已应用/被替代/被拒绝/失败」
   * 落到同一条记录上。
   *
   * 入口先做完整命令相关性校验，再调用同一个 onEvidence reducer 接缝；
   * reducer 拒绝、未知命令或任何字段错配都返回 false 且不迁移状态。
   */
  ingestEvidence(event: V2AgentEvent): boolean {
    return this.processEvidence(event) === "accepted";
  }

  private retryUnlocked(commandId: string): Promise<V2ClientCommandState> {
    const request = this.requests.get(commandId);
    const command = this.state.commands[commandId];
    if (!request || !command || !command.retryable) {
      return Promise.resolve(command!);
    }
    this.update(commandId, {
      status: "submitting",
      errorCode: null,
      retryable: false
    });
    if (request.kind === "steer") {
      return this.dispatch(command, request, () => this.adapter.steer(request));
    }
    if (request.kind === "enqueue") {
      return this.dispatch(command, request, () => this.adapter.enqueue(request));
    }
    if (request.kind === "clarification_resume") {
      return this.dispatch(command, request, () => this.adapter.resumeClarification(request));
    }
    return this.dispatch(command, request, () => this.adapter.decideApproval(request));
  }

  retry(commandId: string): Promise<V2ClientCommandState | null> {
    const request = this.requests.get(commandId);
    const command = this.state.commands[commandId];
    if (!request || !command || !command.retryable) {
      return Promise.resolve(command ?? null);
    }
    const objectKey = request.kind === "clarification_resume"
      ? V2InteractionController.logicalObjectKey(request.kind, {
          clarificationId: request.clarificationId
        })
      : request.kind === "approval_decision"
        ? V2InteractionController.logicalObjectKey(request.kind, {
            approvalId: request.approvalId
          })
        : null;
    return objectKey
      ? this.runForObject(objectKey, () => this.retryUnlocked(commandId))
      : this.retryUnlocked(commandId);
  }
}
