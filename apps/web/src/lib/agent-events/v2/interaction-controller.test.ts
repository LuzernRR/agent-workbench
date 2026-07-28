import { describe, expect, it, vi } from "vitest";
import { projectS01ProcessFixture } from "@/server/mock/s01-event-fixtures";
import type {
  V2AgentEvent,
  V2SteeringCommand
} from "./types";
import {
  V2InteractionController,
  type V2ApprovalDecisionCommand,
  type V2ClarificationResumeCommand,
  type V2InteractionAdapter,
  type V2InteractionAdapterResult
} from "./interaction-controller";

const state = projectS01ProcessFixture("composer_active");
const context = {
  runId: state.runId,
  threadId: state.scope.threadId,
  scope: state.scope,
  actor: { actorId: "actor_1", actorType: "user" as const }
};

function accepted(evidence: V2AgentEvent | null = null): V2InteractionAdapterResult {
  return { outcome: "accepted", evidence };
}

function rejected(errorCode: string): V2InteractionAdapterResult {
  return { outcome: "rejected", errorCode };
}

function failed(errorCode: string, retryable = true): V2InteractionAdapterResult {
  return { outcome: "failed", errorCode, retryable };
}

function adapterWith(
  patch: Partial<V2InteractionAdapter> = {}
): V2InteractionAdapter {
  return {
    steer: vi.fn(async () => accepted()),
    enqueue: vi.fn(async () => accepted()),
    resumeClarification: vi.fn(async () => accepted()),
    decideApproval: vi.fn(async () => accepted()),
    ...patch
  };
}

const eventEnvelope = {
  schemaVersion: "2.0" as const,
  eventId: "event_test",
  scope: state.scope,
  seq: 1,
  occurredAt: "2026-07-27T08:00:00.000Z",
  startedAt: "2026-07-27T08:00:00.000Z",
  completedAt: null,
  inputRevision: 0,
  source: "fixture" as const
};

const guidanceAcceptedBase = {
  ...eventEnvelope,
  type: "guidance.accepted" as const,
  kind: "guidance" as const,
  status: "pending" as const,
  refs: {},
  payload: {
    commandId: "command_placeholder",
    commandSeq: 1,
    expectedSteeringRevision: 0,
    acceptedAtStateRevision: 0,
    currentSteeringRevision: 0,
    pendingApply: true as const,
    idempotencyKey: "idem_placeholder"
  }
} as unknown as V2AgentEvent<"guidance.accepted">;

const guidanceAppliedBase = {
  ...eventEnvelope,
  type: "guidance.applied" as const,
  kind: "guidance" as const,
  status: "completed" as const,
  completedAt: "2026-07-27T08:00:00.000Z",
  refs: {},
  payload: {
    batchId: "batch_1",
    commandId: "command_placeholder",
    commandSeq: 1,
    previousSteeringRevision: 0,
    newSteeringRevision: 1,
    acceptedAtStateRevision: 0,
    appliedAtStateRevision: 1,
    appliedAtNode: "compose_response",
    checkpointRef: "checkpoint_1",
    impact: "format_only" as const,
    invalidatedPlanRefs: [],
    invalidatedDraftRefs: [],
    invalidatedVerificationRefs: [],
    invalidatedArtifactRefs: [],
    newPlanRef: null
  }
} as unknown as V2AgentEvent<"guidance.applied">;

function guidanceAcceptedFor(
  request: V2SteeringCommand,
  patch: Partial<V2AgentEvent<"guidance.accepted">> = {}
): V2AgentEvent<"guidance.accepted"> {
  return {
    ...guidanceAcceptedBase,
    runId: request.runId,
    scope: request.scope,
    refs: { commandId: request.commandId },
    payload: {
      ...guidanceAcceptedBase.payload,
      commandId: request.commandId,
      expectedSteeringRevision: request.expectedSteeringRevision,
      currentSteeringRevision: request.expectedSteeringRevision,
      idempotencyKey: request.idempotencyKey
    },
    ...patch
  };
}

function guidanceAppliedFor(
  request: V2SteeringCommand,
  acceptedEvent: V2AgentEvent<"guidance.accepted">,
  patch: Partial<V2AgentEvent<"guidance.applied">> = {}
): V2AgentEvent<"guidance.applied"> {
  return {
    ...guidanceAppliedBase,
    eventId: `${acceptedEvent.eventId}_applied`,
    runId: request.runId,
    scope: request.scope,
    refs: {
      commandId: request.commandId,
      checkpointRef: guidanceAppliedBase.payload.checkpointRef
    },
    payload: {
      ...guidanceAppliedBase.payload,
      commandId: request.commandId,
      commandSeq: acceptedEvent.payload.commandSeq,
      previousSteeringRevision: acceptedEvent.payload.currentSteeringRevision,
      acceptedAtStateRevision: acceptedEvent.payload.acceptedAtStateRevision
    },
    ...patch
  };
}

function clarificationResumedFor(
  request: V2ClarificationResumeCommand
): V2AgentEvent<"clarification.resumed"> {
  return {
    ...eventEnvelope,
    eventId: `event_${request.commandId}_resumed`,
    runId: request.runId,
    scope: request.scope,
    type: "clarification.resumed",
    kind: "clarification",
    status: "completed",
    completedAt: eventEnvelope.occurredAt,
    refs: {
      checkpointRef: request.checkpointRef,
      messageId: `message_${request.commandId}`
    },
    payload: {
      clarificationId: request.clarificationId,
      checkpointRef: request.checkpointRef,
      responseMessageRef: `message_${request.commandId}`,
      responseHash: request.contentHash,
      resumedAtStateRevision: request.expectedStateRevision + 1,
      idempotencyKey: request.idempotencyKey,
      publicText: null,
      reasonCodes: []
    }
  };
}

function approvalDecidedFor(
  request: V2ApprovalDecisionCommand
): V2AgentEvent<"approval.decided"> {
  return {
    ...eventEnvelope,
    eventId: `event_${request.commandId}_decided`,
    runId: request.runId,
    scope: request.scope,
    type: "approval.decided",
    kind: "approval",
    status: "completed",
    completedAt: eventEnvelope.occurredAt,
    refs: { toolCallId: request.toolCallId },
    payload: {
      approvalId: request.approvalId,
      toolCallId: request.toolCallId,
      decision: request.decision,
      decidedBy: request.actor,
      decidedAt: eventEnvelope.occurredAt,
      publicText: null,
      reasonCodes: []
    }
  };
}

function terminalGuidanceFor(
  request: V2SteeringCommand,
  acceptedEvent: V2AgentEvent<"guidance.accepted">,
  type: "guidance.applied" | "guidance.superseded" | "guidance.rejected" | "guidance.failed"
): V2AgentEvent {
  const common = {
    ...eventEnvelope,
    eventId: `event_${request.commandId}_${type.replace("guidance.", "")}`,
    runId: request.runId,
    scope: request.scope,
    completedAt: eventEnvelope.occurredAt,
    refs: { commandId: request.commandId }
  };
  if (type === "guidance.applied") {
    return guidanceAppliedFor(request, acceptedEvent, {
      eventId: common.eventId
    });
  }
  if (type === "guidance.superseded") {
    return {
      ...common,
      type,
      kind: "guidance",
      status: "superseded",
      payload: {
        batchId: "batch_1",
        commandId: request.commandId,
        commandSeq: acceptedEvent.payload.commandSeq,
        previousSteeringRevision: acceptedEvent.payload.currentSteeringRevision,
        newSteeringRevision: acceptedEvent.payload.currentSteeringRevision + 1,
        supersededByCommandId: "command_newer",
        reason: "last_write_wins"
      }
    };
  }
  if (type === "guidance.rejected") {
    return {
      ...common,
      type,
      kind: "guidance",
      status: "rejected",
      payload: {
        commandId: request.commandId,
        commandSeq: acceptedEvent.payload.commandSeq,
        code: "COMMAND_REVISION_CONFLICT",
        actualSteeringRevision: acceptedEvent.payload.currentSteeringRevision + 1
      }
    };
  }
  return {
    ...common,
    type,
    kind: "guidance",
    status: "failed",
    payload: {
      commandId: request.commandId,
      commandSeq: acceptedEvent.payload.commandSeq,
      errorCode: "NETWORK_ERROR",
      errorMessage: null,
      retryable: true
    }
  };
}

describe("V2InteractionController", () => {
  it("reuses the exact key, hash and request for a network retry", async () => {
    const sent: unknown[] = [];
    const steer = vi.fn(async (request) => {
      sent.push(request);
      return sent.length === 1
        ? { outcome: "failed", errorCode: "NETWORK_ERROR", retryable: true } as const
        : accepted();
    });
    let suffix = 0;
    const controller = new V2InteractionController({
      adapter: adapterWith({ steer }),
      randomId: () => `retry_${++suffix}`,
      now: () => "2026-07-27T08:00:00.000Z"
    });

    const first = await controller.submitSteer({
      ...context,
      expectedSteeringRevision: 0,
      content: "  调整格式\r\n并保留来源  ",
      attachmentRefs: []
    });
    expect(first.status).toBe("failed");
    expect(first.retryable).toBe(true);

    const retried = await controller.retry(first.commandId);
    expect(retried?.status).toBe("accepted_pending");
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
    expect(retried?.idempotencyKey).toBe(first.idempotencyKey);
    expect(retried?.contentHash).toBe(first.contentHash);
  });

  it("creates a new idempotency key while hashing normalized content deterministically", async () => {
    let suffix = 0;
    const controller = new V2InteractionController({
      adapter: adapterWith(),
      randomId: () => `fresh_${++suffix}`,
      now: () => "2026-07-27T08:00:00.000Z"
    });
    const first = await controller.submitEnqueue({
      ...context,
      content: "下一项\r\n内容",
      attachmentRefs: ["artifact_1"]
    });
    const sameContent = await controller.submitEnqueue({
      ...context,
      content: "下一项\n内容",
      attachmentRefs: ["artifact_1"]
    });
    const changed = await controller.submitEnqueue({
      ...context,
      content: "下一项\n不同内容",
      attachmentRefs: ["artifact_1"]
    });

    expect(sameContent.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(sameContent.commandId).not.toBe(first.commandId);
    expect(sameContent.contentHash).toBe(first.contentHash);
    expect(changed.contentHash).not.toBe(first.contentHash);
  });

  it("keeps accepted guidance pending until an applied event proves application", async () => {
    const controller = new V2InteractionController({
      adapter: adapterWith({
        steer: vi.fn(async (request) => accepted(guidanceAcceptedFor(request)))
      }),
      onEvidence: () => true,
      randomId: () => "accepted_1",
      now: () => "2026-07-27T08:00:00.000Z"
    });

    const command = await controller.submitSteer({
      ...context,
      expectedSteeringRevision: 0,
      content: "改为表格",
      attachmentRefs: []
    });

    expect(command.status).toBe("accepted_pending");
    expect(command.status).not.toBe("applied");
  });

  it("never falls back between steer, enqueue, clarification and approval", async () => {
    const adapter = adapterWith({
      steer: vi.fn(async () => rejected("COMMAND_REVISION_CONFLICT")),
      enqueue: vi.fn(async () => rejected("RUN_TERMINAL")),
      resumeClarification: vi.fn(async () => rejected("CLARIFICATION_STALE_CHECKPOINT")),
      decideApproval: vi.fn(async () => rejected("APPROVAL_ALREADY_DECIDED"))
    });
    let suffix = 0;
    const controller = new V2InteractionController({
      adapter,
      randomId: () => `flow_${++suffix}`,
      now: () => "2026-07-27T08:00:00.000Z"
    });

    const steer = await controller.submitSteer({
      ...context,
      expectedSteeringRevision: 0,
      content: "保留草稿",
      attachmentRefs: []
    });
    const enqueue = await controller.submitEnqueue({
      ...context,
      content: "下一条",
      attachmentRefs: ["artifact_2"]
    });
    const clarification = await controller.resumeClarification({
      ...context,
      clarificationId: "clarification_1",
      checkpointRef: "checkpoint_1",
      expectedStateRevision: 3,
      content: "澄清回答",
      attachmentRefs: []
    });
    const approval = await controller.decideApproval({
      ...context,
      approvalId: "approval_1",
      toolCallId: "tool_call_1",
      decision: "deny"
    });

    expect(adapter.steer).toHaveBeenCalledTimes(1);
    expect(adapter.enqueue).toHaveBeenCalledTimes(1);
    expect(adapter.resumeClarification).toHaveBeenCalledTimes(1);
    expect(adapter.decideApproval).toHaveBeenCalledTimes(1);
    expect(steer).toMatchObject({
      status: "rejected",
      errorCode: "COMMAND_REVISION_CONFLICT",
      retryable: false,
      snapshot: { content: "保留草稿", attachmentRefs: [] }
    });
    expect(enqueue.snapshot).toEqual({
      content: "下一条",
      attachmentRefs: ["artifact_2"]
    });
    expect(clarification.errorCode).toBe("CLARIFICATION_STALE_CHECKPOINT");
    expect(approval.errorCode).toBe("APPROVAL_ALREADY_DECIDED");
  });

  it("rejects steering attachments locally without calling another adapter", async () => {
    const adapter = adapterWith();
    const controller = new V2InteractionController({
      adapter,
      randomId: () => "attachment_1",
      now: () => "2026-07-27T08:00:00.000Z"
    });

    const result = await controller.submitSteer({
      ...context,
      expectedSteeringRevision: 0,
      content: "结合附件调整",
      attachmentRefs: ["artifact_private"]
    });

    expect(result).toMatchObject({
      status: "rejected",
      errorCode: "STEERING_ATTACHMENTS_UNSUPPORTED",
      snapshot: {
        content: "结合附件调整",
        attachmentRefs: ["artifact_private"]
      }
    });
    expect(adapter.steer).not.toHaveBeenCalled();
    expect(adapter.enqueue).not.toHaveBeenCalled();
  });

  // ── 阻断项 2：证据必须属于原命令 ──────────────────────────
  it("rejects an accepted evidence whose commandId belongs to another command", async () => {
    const foreign: V2AgentEvent<"guidance.accepted"> = {
      ...guidanceAcceptedBase,
      runId: context.runId,
      payload: { ...guidanceAcceptedBase.payload, commandId: "command_other" }
    };
    const applied = vi.fn();
    const controller = new V2InteractionController({
      adapter: adapterWith({ steer: vi.fn(async () => accepted(foreign)) }),
      onEvidence: () => {
        applied();
        return true;
      },
      randomId: () => "own_1",
      now: () => "2026-07-27T08:00:00.000Z"
    });

    const command = await controller.submitSteer({
      ...context,
      expectedSteeringRevision: 0,
      content: "改为表格",
      attachmentRefs: []
    });

    expect(command.status).toBe("failed");
    expect(command.errorCode).toBe("COMMAND_EVIDENCE_MISMATCH");
    expect(applied).not.toHaveBeenCalled();
  });

  it("accepts an evidence whose commandId matches the issuing command", async () => {
    const steer = vi.fn(async (request: V2SteeringCommand) => accepted(
      guidanceAcceptedFor(request)
    ));
    const controller = new V2InteractionController({
      adapter: adapterWith({ steer }),
      onEvidence: () => true,
      randomId: () => "own_2",
      now: () => "2026-07-27T08:00:00.000Z"
    });

    const command = await controller.submitSteer({
      ...context,
      expectedSteeringRevision: 0,
      content: "改为表格",
      attachmentRefs: []
    });

    expect(command.status).toBe("accepted_pending");
    expect(command.errorCode).toBeNull();
  });

  it.each([
    "runId",
    "scope",
    "commandId",
    "commandRef",
    "idempotencyKey",
    "revision"
  ] as const)("rejects guidance evidence with mismatched %s before reducer merge", async (field) => {
    const merged = vi.fn(() => true);
    const steer = vi.fn(async (request: V2SteeringCommand) => {
      const valid = guidanceAcceptedFor(request);
      const evidence: V2AgentEvent<"guidance.accepted"> = field === "runId"
        ? { ...valid, runId: "run_foreign" }
        : field === "scope"
          ? { ...valid, scope: { ...valid.scope, projectId: "project_foreign" } }
          : field === "commandId"
            ? { ...valid, payload: { ...valid.payload, commandId: "command_foreign" } }
            : field === "commandRef"
              ? { ...valid, refs: { commandId: "command_foreign" } }
              : field === "idempotencyKey"
                ? { ...valid, payload: { ...valid.payload, idempotencyKey: "idem_foreign" } }
                : {
                    ...valid,
                    payload: {
                      ...valid.payload,
                      expectedSteeringRevision: request.expectedSteeringRevision + 1
                    }
                  };
      return accepted(evidence);
    });
    const controller = new V2InteractionController({
      adapter: adapterWith({ steer }),
      onEvidence: merged,
      randomId: () => `mismatch_${field}`,
      now: () => "2026-07-27T08:00:00.000Z"
    });

    const command = await controller.submitSteer({
      ...context,
      expectedSteeringRevision: 2,
      content: "严格关联",
      attachmentRefs: []
    });

    expect(command).toMatchObject({
      status: "failed",
      errorCode: "COMMAND_EVIDENCE_MISMATCH"
    });
    expect(merged).not.toHaveBeenCalled();
  });

  it("does not let an enqueue command consume a guidance event", async () => {
    const merged = vi.fn(() => true);
    const controller = new V2InteractionController({
      adapter: adapterWith({
        enqueue: vi.fn(async (request) => accepted({
          ...guidanceAcceptedBase,
          runId: request.runId,
          scope: request.scope,
          refs: { commandId: request.commandId },
          payload: {
            ...guidanceAcceptedBase.payload,
            commandId: request.commandId,
            idempotencyKey: request.idempotencyKey
          }
        }))
      }),
      onEvidence: merged,
      randomId: () => "enqueue_evidence",
      now: () => "2026-07-27T08:00:00.000Z"
    });

    const command = await controller.submitEnqueue({
      ...context,
      content: "下一条",
      attachmentRefs: []
    });

    expect(command.errorCode).toBe("COMMAND_EVIDENCE_MISMATCH");
    expect(merged).not.toHaveBeenCalled();
  });

  it("rejects reuse of one guidance commandSeq by another command", async () => {
    const merged = vi.fn(() => true);
    const controller = new V2InteractionController({
      adapter: adapterWith({
        steer: vi.fn(async (request) => accepted(guidanceAcceptedFor(request, {
          eventId: `event_${request.commandId}`,
          payload: {
            ...guidanceAcceptedBase.payload,
            commandId: request.commandId,
            commandSeq: 1,
            expectedSteeringRevision: request.expectedSteeringRevision,
            idempotencyKey: request.idempotencyKey
          }
        })))
      }),
      onEvidence: merged,
      randomId: (() => {
        let value = 0;
        return () => `sequence_${++value}`;
      })(),
      now: () => "2026-07-27T08:00:00.000Z"
    });

    const first = await controller.submitSteer({
      ...context,
      expectedSteeringRevision: 0,
      content: "第一条",
      attachmentRefs: []
    });
    const second = await controller.submitSteer({
      ...context,
      expectedSteeringRevision: 0,
      content: "第二条",
      attachmentRefs: []
    });

    expect(first.status).toBe("accepted_pending");
    expect(second.errorCode).toBe("COMMAND_EVIDENCE_MISMATCH");
    expect(merged).toHaveBeenCalledTimes(1);
  });

  it.each([
    "clarificationId",
    "checkpointRef",
    "checkpointEventRef",
    "idempotencyKey",
    "responseHash",
    "messageRef",
    "stateRevision"
  ] as const)("rejects clarification evidence with mismatched %s", async (field) => {
    const merged = vi.fn(() => true);
    const controller = new V2InteractionController({
      adapter: adapterWith({
        resumeClarification: vi.fn(async (request) => {
          const valid = clarificationResumedFor(request);
          const evidence: V2AgentEvent<"clarification.resumed"> = field === "clarificationId"
            ? { ...valid, payload: { ...valid.payload, clarificationId: "clarification_foreign" } }
            : field === "checkpointRef"
              ? { ...valid, payload: { ...valid.payload, checkpointRef: "checkpoint_foreign" } }
              : field === "checkpointEventRef"
                ? { ...valid, refs: { ...valid.refs, checkpointRef: "checkpoint_foreign" } }
                : field === "idempotencyKey"
                  ? { ...valid, payload: { ...valid.payload, idempotencyKey: "idem_foreign" } }
                  : field === "responseHash"
                    ? { ...valid, payload: { ...valid.payload, responseHash: "f".repeat(64) } }
                    : field === "messageRef"
                      ? { ...valid, refs: { ...valid.refs, messageId: "message_foreign" } }
                      : {
                          ...valid,
                          payload: {
                            ...valid.payload,
                            resumedAtStateRevision: request.expectedStateRevision + 2
                          }
                        };
          return accepted(evidence);
        })
      }),
      onEvidence: merged,
      randomId: () => `clarification_${field}`,
      now: () => "2026-07-27T08:00:00.000Z"
    });

    const command = await controller.resumeClarification({
      ...context,
      clarificationId: "clarification_1",
      checkpointRef: "checkpoint_1",
      expectedStateRevision: 4,
      content: "最近一年",
      attachmentRefs: []
    });

    expect(command.errorCode).toBe("COMMAND_EVIDENCE_MISMATCH");
    expect(merged).not.toHaveBeenCalled();
  });

  it.each([
    "approvalId",
    "toolCallId",
    "toolEventRef",
    "decision",
    "actor"
  ] as const)("rejects approval evidence with mismatched %s", async (field) => {
    const merged = vi.fn(() => true);
    const controller = new V2InteractionController({
      adapter: adapterWith({
        decideApproval: vi.fn(async (request) => {
          const valid = approvalDecidedFor(request);
          const evidence: V2AgentEvent<"approval.decided"> = field === "approvalId"
            ? { ...valid, payload: { ...valid.payload, approvalId: "approval_foreign" } }
            : field === "toolCallId"
              ? { ...valid, payload: { ...valid.payload, toolCallId: "tool_foreign" } }
              : field === "toolEventRef"
                ? { ...valid, refs: { toolCallId: "tool_foreign" } }
                : field === "decision"
                  ? { ...valid, payload: { ...valid.payload, decision: "deny" } }
                  : {
                      ...valid,
                      payload: {
                        ...valid.payload,
                        decidedBy: { actorId: "actor_foreign", actorType: "user" }
                      }
                    };
          return accepted(evidence);
        })
      }),
      onEvidence: merged,
      randomId: () => `approval_${field}`,
      now: () => "2026-07-27T08:00:00.000Z"
    });

    const command = await controller.decideApproval({
      ...context,
      approvalId: "approval_1",
      toolCallId: "tool_call_1",
      decision: "allow_once"
    });

    expect(command.errorCode).toBe("COMMAND_EVIDENCE_MISMATCH");
    expect(merged).not.toHaveBeenCalled();
  });

  // ── 阻断项 3：同一逻辑对象在途只允许一条命令 ────────────────
  it("shares one in-flight command and idempotency key for the same approval object", async () => {
    let release!: (value: V2InteractionAdapterResult) => void;
    const pending = new Promise<V2InteractionAdapterResult>((resolve) => {
      release = resolve;
    });
    const decideApproval = vi.fn(() => pending);
    let suffix = 0;
    const controller = new V2InteractionController({
      adapter: adapterWith({ decideApproval }),
      randomId: () => `dup_${++suffix}`,
      now: () => "2026-07-27T08:00:00.000Z"
    });

    const firstPromise = controller.decideApproval({
      ...context,
      approvalId: "approval_1",
      toolCallId: "tool_call_1",
      decision: "allow_once"
    });
    const secondPromise = controller.decideApproval({
      ...context,
      approvalId: "approval_1",
      toolCallId: "tool_call_1",
      decision: "deny"
    });

    release(accepted());
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(first.status).toBe("accepted_pending");
    expect(second.commandId).toBe(first.commandId);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(decideApproval).toHaveBeenCalledTimes(1);

    // 首个命令收口后，同一对象可以再次提交（例如换个决定）。
    const third = await controller.decideApproval({
      ...context,
      approvalId: "approval_1",
      toolCallId: "tool_call_1",
      decision: "deny"
    });
    expect(third.status).not.toBe("rejected");
    expect(decideApproval).toHaveBeenCalledTimes(2);
  });

  it("allows concurrent in-flight decisions for different approval objects", async () => {
    const decideApproval = vi.fn(async () => accepted());
    let suffix = 0;
    const controller = new V2InteractionController({
      adapter: adapterWith({ decideApproval }),
      randomId: () => `multi_${++suffix}`,
      now: () => "2026-07-27T08:00:00.000Z"
    });

    const [one, two] = await Promise.all([
      controller.decideApproval({
        ...context,
        approvalId: "approval_1",
        toolCallId: "tool_call_1",
        decision: "allow_once"
      }),
      controller.decideApproval({
        ...context,
        approvalId: "approval_2",
        toolCallId: "tool_call_2",
        decision: "allow_once"
      })
    ]);

    expect(one.status).not.toBe("rejected");
    expect(two.status).not.toBe("rejected");
    expect(decideApproval).toHaveBeenCalledTimes(2);
  });

  it("reuses the original clarification request when the same answer is resubmitted", async () => {
    const sent: V2ClarificationResumeCommand[] = [];
    const resumeClarification = vi.fn(async (request: V2ClarificationResumeCommand) => {
      sent.push(request);
      return sent.length === 1 ? failed("NETWORK_ERROR") : accepted(null);
    });
    let suffix = 0;
    const controller = new V2InteractionController({
      adapter: adapterWith({ resumeClarification }),
      randomId: () => `clarification_retry_${++suffix}`,
      now: () => "2026-07-27T08:00:00.000Z"
    });
    const input = {
      ...context,
      clarificationId: "clarification_1",
      checkpointRef: "checkpoint_1",
      expectedStateRevision: 4,
      content: "最近一年",
      attachmentRefs: []
    };

    const first = await controller.resumeClarification(input);
    const retried = await controller.resumeClarification(input);

    expect(first.retryable).toBe(true);
    expect(retried.commandId).toBe(first.commandId);
    expect(retried.idempotencyKey).toBe(first.idempotencyKey);
    expect(retried.contentHash).toBe(first.contentHash);
    expect(sent[1]).toBe(sent[0]);
    expect(controller.getState().order).toEqual([first.commandId]);
  });

  it("creates a fresh clarification command only when the answer changes", async () => {
    const resumeClarification = vi.fn(async () => failed("NETWORK_ERROR"));
    let suffix = 0;
    const controller = new V2InteractionController({
      adapter: adapterWith({ resumeClarification }),
      randomId: () => `clarification_changed_${++suffix}`,
      now: () => "2026-07-27T08:00:00.000Z"
    });
    const first = await controller.resumeClarification({
      ...context,
      clarificationId: "clarification_1",
      checkpointRef: "checkpoint_1",
      expectedStateRevision: 4,
      content: "最近一年",
      attachmentRefs: []
    });
    const changed = await controller.resumeClarification({
      ...context,
      clarificationId: "clarification_1",
      checkpointRef: "checkpoint_1",
      expectedStateRevision: 4,
      content: "最近三年",
      attachmentRefs: []
    });

    expect(changed.commandId).not.toBe(first.commandId);
    expect(changed.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(changed.contentHash).not.toBe(first.contentHash);
    expect(resumeClarification).toHaveBeenCalledTimes(2);
  });

  it("reuses the original approval request after a retryable failure", async () => {
    const sent: V2ApprovalDecisionCommand[] = [];
    const decideApproval = vi.fn(async (request: V2ApprovalDecisionCommand) => {
      sent.push(request);
      return sent.length === 1 ? failed("NETWORK_ERROR") : accepted(null);
    });
    let suffix = 0;
    const controller = new V2InteractionController({
      adapter: adapterWith({ decideApproval }),
      randomId: () => `approval_retry_${++suffix}`,
      now: () => "2026-07-27T08:00:00.000Z"
    });
    const input = {
      ...context,
      approvalId: "approval_1",
      toolCallId: "tool_call_1",
      decision: "deny" as const
    };

    const first = await controller.decideApproval(input);
    const retried = await controller.decideApproval(input);

    expect(retried.commandId).toBe(first.commandId);
    expect(retried.idempotencyKey).toBe(first.idempotencyKey);
    expect(sent[1]).toBe(sent[0]);
    expect(controller.getState().order).toEqual([first.commandId]);
  });

  it("creates a new approval command when the decision changes after failure", async () => {
    const decideApproval = vi.fn(async () => failed("NETWORK_ERROR"));
    let suffix = 0;
    const controller = new V2InteractionController({
      adapter: adapterWith({ decideApproval }),
      randomId: () => `approval_changed_${++suffix}`,
      now: () => "2026-07-27T08:00:00.000Z"
    });
    const first = await controller.decideApproval({
      ...context,
      approvalId: "approval_1",
      toolCallId: "tool_call_1",
      decision: "allow_once"
    });
    const changed = await controller.decideApproval({
      ...context,
      approvalId: "approval_1",
      toolCallId: "tool_call_1",
      decision: "deny"
    });

    expect(changed.commandId).not.toBe(first.commandId);
    expect(changed.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(decideApproval).toHaveBeenCalledTimes(2);
  });

  // ── 阻断项 4：晚到事件迁移同一 client command ──────────────
  it("migrates a late applied event onto the same accepted command", async () => {
    let sentRequest: V2SteeringCommand | null = null;
    let acceptedEvent: V2AgentEvent<"guidance.accepted"> | null = null;
    const steer = vi.fn(async (request: V2SteeringCommand) => {
      sentRequest = request;
      acceptedEvent = guidanceAcceptedFor(request);
      return accepted(acceptedEvent);
    });
    const controller = new V2InteractionController({
      adapter: adapterWith({ steer }),
      onEvidence: () => true,
      randomId: () => "late_1",
      now: () => "2026-07-27T08:00:00.000Z"
    });

    const command = await controller.submitSteer({
      ...context,
      expectedSteeringRevision: 0,
      content: "改为表格",
      attachmentRefs: []
    });
    expect(command.status).toBe("accepted_pending");

    const migrated = controller.ingestEvidence(guidanceAppliedFor(
      sentRequest!,
      acceptedEvent!
    ));

    expect(migrated).toBe(true);
    expect(controller.getState().commands[command.commandId].status).toBe("applied");
  });

  it.each([
    ["guidance.applied", "applied", null, false],
    ["guidance.superseded", "superseded", null, false],
    ["guidance.rejected", "rejected", "COMMAND_REVISION_CONFLICT", false],
    ["guidance.failed", "failed", "NETWORK_ERROR", true]
  ] as const)("merges late %s evidence through the reducer callback", async (
    type,
    expectedStatus,
    expectedError,
    expectedRetryable
  ) => {
    let sentRequest!: V2SteeringCommand;
    let acceptedEvent!: V2AgentEvent<"guidance.accepted">;
    const merged = vi.fn(() => true);
    const controller = new V2InteractionController({
      adapter: adapterWith({
        steer: vi.fn(async (request) => {
          sentRequest = request;
          acceptedEvent = guidanceAcceptedFor(request);
          return accepted(acceptedEvent);
        })
      }),
      onEvidence: merged,
      randomId: () => `late_${type}`,
      now: () => "2026-07-27T08:00:00.000Z"
    });
    const command = await controller.submitSteer({
      ...context,
      expectedSteeringRevision: 0,
      content: "晚到状态",
      attachmentRefs: []
    });
    const lateEvent = terminalGuidanceFor(sentRequest, acceptedEvent, type);

    expect(controller.ingestEvidence(lateEvent)).toBe(true);
    expect(controller.getState().commands[command.commandId]).toMatchObject({
      status: expectedStatus,
      errorCode: expectedError,
      retryable: expectedRetryable
    });
    expect(merged).toHaveBeenCalledTimes(2);
    expect(merged).toHaveBeenLastCalledWith(lateEvent);

    // 同一个持久化事件重复送达时幂等，不再次推进 reducer。
    expect(controller.ingestEvidence(lateEvent)).toBe(true);
    expect(merged).toHaveBeenCalledTimes(2);
  });

  it.each([
    "commandSeq",
    "commandRef",
    "acceptedRevision",
    "previousRevision",
    "checkpointRef"
  ] as const)("ignores late applied evidence with mismatched %s", async (field) => {
    let sentRequest!: V2SteeringCommand;
    let acceptedEvent!: V2AgentEvent<"guidance.accepted">;
    const merged = vi.fn(() => true);
    const controller = new V2InteractionController({
      adapter: adapterWith({
        steer: vi.fn(async (request) => {
          sentRequest = request;
          acceptedEvent = guidanceAcceptedFor(request);
          return accepted(acceptedEvent);
        })
      }),
      onEvidence: merged,
      randomId: () => `late_mismatch_${field}`,
      now: () => "2026-07-27T08:00:00.000Z"
    });
    const command = await controller.submitSteer({
      ...context,
      expectedSteeringRevision: 0,
      content: "不要错配",
      attachmentRefs: []
    });
    const valid = guidanceAppliedFor(sentRequest, acceptedEvent);
    const invalid: V2AgentEvent<"guidance.applied"> = field === "commandSeq"
      ? { ...valid, payload: { ...valid.payload, commandSeq: valid.payload.commandSeq + 1 } }
      : field === "commandRef"
        ? { ...valid, refs: { ...valid.refs, commandId: "command_foreign" } }
        : field === "acceptedRevision"
          ? {
              ...valid,
              payload: {
                ...valid.payload,
                acceptedAtStateRevision: valid.payload.acceptedAtStateRevision + 1
              }
            }
          : field === "previousRevision"
            ? {
                ...valid,
                payload: {
                  ...valid.payload,
                  previousSteeringRevision: valid.payload.previousSteeringRevision + 1
                }
              }
            : {
                ...valid,
                refs: { ...valid.refs, checkpointRef: "checkpoint_foreign" }
              };

    expect(controller.ingestEvidence(invalid)).toBe(false);
    expect(controller.getState().commands[command.commandId].status).toBe("accepted_pending");
    expect(merged).toHaveBeenCalledTimes(1);
  });

  it("keeps the accepted command pending when the runtime reducer rejects a late event", async () => {
    let sentRequest!: V2SteeringCommand;
    let acceptedEvent!: V2AgentEvent<"guidance.accepted">;
    const merged = vi.fn((event: V2AgentEvent) => event.type === "guidance.accepted");
    const controller = new V2InteractionController({
      adapter: adapterWith({
        steer: vi.fn(async (request) => {
          sentRequest = request;
          acceptedEvent = guidanceAcceptedFor(request);
          return accepted(acceptedEvent);
        })
      }),
      onEvidence: merged,
      randomId: () => "late_reducer_reject",
      now: () => "2026-07-27T08:00:00.000Z"
    });
    const command = await controller.submitSteer({
      ...context,
      expectedSteeringRevision: 0,
      content: "保留中间态",
      attachmentRefs: []
    });

    expect(controller.ingestEvidence(
      guidanceAppliedFor(sentRequest, acceptedEvent)
    )).toBe(false);
    expect(controller.getState().commands[command.commandId].status).toBe("accepted_pending");
  });

  it("ignores a late event with no matching client command", async () => {
    const controller = new V2InteractionController({
      adapter: adapterWith(),
      randomId: () => "late_2",
      now: () => "2026-07-27T08:00:00.000Z"
    });

    const migrated = controller.ingestEvidence({
      ...guidanceAppliedBase,
      runId: context.runId,
      payload: { ...guidanceAppliedBase.payload, commandId: "command_unknown" }
    } as V2AgentEvent);

    expect(migrated).toBe(false);
  });
});
