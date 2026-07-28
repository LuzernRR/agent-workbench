"use client";

import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import {
  V2InteractionController,
  type V2ApprovalDecisionCommand,
  type V2ClarificationResumeCommand,
  type V2ClientCommandState,
  type V2EnqueueCommand,
  type V2InteractionAdapter,
  type V2InteractionAdapterResult,
  type V2InteractionControllerState,
  type V2SteerInput
} from "./interaction-controller";
import type {
  S01ProcessFixtureCatalog,
  S01ProcessScenario
} from "./process-view-model";
import { mergeV2RunInput, type V2RunState } from "./run-reducer";
import type {
  V2AgentEvent,
  V2Scope,
  V2SteeringCommand
} from "./types";
import type { V2ComposerSubmitMode } from "./composer-routing";

const actor = { actorId: "actor_1", actorType: "user" } as const;

function accepted(evidence: V2AgentEvent | null): V2InteractionAdapterResult {
  return { outcome: "accepted", evidence };
}

function rejected(errorCode: string): V2InteractionAdapterResult {
  return { outcome: "rejected", errorCode };
}

function failed(errorCode: string, retryable: boolean): V2InteractionAdapterResult {
  return { outcome: "failed", errorCode, retryable };
}

function nextGuidanceSeq(state: V2RunState) {
  return Object.values(state.guidanceCommands)
    .reduce((highest, command) => Math.max(highest, command.commandSeq), 0) + 1;
}

function currentSteeringRevision(state: V2RunState) {
  return Object.values(state.guidanceCommands).reduce(
    (highest, command) => Math.max(
      highest,
      command.currentSteeringRevision ?? 0,
      command.newSteeringRevision ?? 0
    ),
    0
  );
}

function fixtureEventBase(state: V2RunState, type: V2AgentEvent["type"]) {
  const now = new Date().toISOString();
  return {
    schemaVersion: "2.0" as const,
    eventId: `preview_${type.replaceAll(".", "_")}_${crypto.randomUUID().replaceAll("-", "_")}`,
    runId: state.runId,
    scope: state.scope,
    seq: state.cursor + 1,
    occurredAt: now,
    startedAt: now,
    inputRevision: state.latestInputRevision,
    source: "fixture" as const
  };
}

function createPreviewAdapter(
  scenario: S01ProcessScenario,
  getRunState: () => V2RunState
): V2InteractionAdapter {
  return {
    async steer(command: V2SteeringCommand) {
      const state = getRunState();
      if (state.terminal || scenario === "guidance_terminal_rejected") {
        return rejected("COMMAND_AFTER_TERMINAL");
      }
      if (scenario === "guidance_revision_conflict") {
        return rejected("COMMAND_REVISION_CONFLICT");
      }
      if (scenario === "guidance_failed") {
        return failed("NETWORK_ERROR", true);
      }
      const base = fixtureEventBase(state, "guidance.accepted");
      const event: V2AgentEvent<"guidance.accepted"> = {
        ...base,
        type: "guidance.accepted",
        kind: "guidance",
        status: "pending",
        completedAt: null,
        refs: { commandId: command.commandId },
        payload: {
          commandId: command.commandId,
          commandSeq: nextGuidanceSeq(state),
          expectedSteeringRevision: command.expectedSteeringRevision,
          acceptedAtStateRevision: state.cursor,
          currentSteeringRevision: currentSteeringRevision(state),
          pendingApply: true,
          idempotencyKey: command.idempotencyKey
        }
      };
      return accepted(event);
    },

    async enqueue(_command: V2EnqueueCommand) {
      return getRunState().terminal
        ? rejected("RUN_TERMINAL")
        : accepted(null);
    },

    async resumeClarification(command: V2ClarificationResumeCommand) {
      const state = getRunState();
      if (state.terminal) return rejected("RUN_TERMINAL");
      const clarification = state.clarifications[command.clarificationId];
      if (!clarification || clarification.status === "resumed") {
        return rejected("CLARIFICATION_ALREADY_RESUMED");
      }
      if (
        clarification.checkpointRef !== command.checkpointRef
        || clarification.stateRevision !== command.expectedStateRevision
      ) return rejected("CLARIFICATION_STALE_CHECKPOINT");
      const base = fixtureEventBase(state, "clarification.resumed");
      const event: V2AgentEvent<"clarification.resumed"> = {
        ...base,
        inputRevision: state.latestInputRevision + 1,
        type: "clarification.resumed",
        kind: "clarification",
        status: "completed",
        completedAt: base.occurredAt,
        refs: {
          checkpointRef: command.checkpointRef,
          messageId: `message_${command.commandId}`
        },
        payload: {
          clarificationId: command.clarificationId,
          checkpointRef: command.checkpointRef,
          responseMessageRef: `message_${command.commandId}`,
          responseHash: command.contentHash,
          resumedAtStateRevision: command.expectedStateRevision + 1,
          idempotencyKey: command.idempotencyKey,
          publicText: null,
          reasonCodes: []
        }
      };
      return accepted(event);
    },

    async decideApproval(command: V2ApprovalDecisionCommand) {
      const state = getRunState();
      if (state.terminal) return rejected("RUN_TERMINAL");
      const tool = state.toolCalls[command.toolCallId];
      if (
        !tool
        || tool.approvalId !== command.approvalId
        || tool.approvalDecision
      ) return rejected("APPROVAL_ALREADY_DECIDED");
      const base = fixtureEventBase(state, "approval.decided");
      const event: V2AgentEvent<"approval.decided"> = {
        ...base,
        type: "approval.decided",
        kind: "approval",
        status: "completed",
        completedAt: base.occurredAt,
        refs: { toolCallId: command.toolCallId },
        payload: {
          approvalId: command.approvalId,
          toolCallId: command.toolCallId,
          decision: command.decision,
          decidedBy: command.actor,
          decidedAt: base.occurredAt,
          publicText: null,
          reasonCodes: ["source_policy"]
        }
      };
      return accepted(event);
    }
  };
}

// 阻断项 6：停止前收口一个未终态工具时，用它当前的 display 快照合成
// schema 合法的 tool.failed。running 直接失败；waiting_approval 先 deny
// 再失败。usage 缺失时补一份零值，满足 ToolFailedPayload 的必填约束。
type PreviewToolState = V2RunState["toolCalls"][string];

function cancelUsageFor(tool: PreviewToolState) {
  if (tool.usage) return { ...tool.usage, toolId: tool.toolId };
  return {
    toolId: tool.toolId,
    toolVersion: "tool_v1",
    provider: "preview",
    pricingVersion: "pricing_preview",
    currency: "USD" as const,
    calls: 0,
    attempts: tool.attempt,
    units: 0,
    bytes: 0,
    resultCount: 0,
    searchQueries: 0,
    pageReads: 0,
    estimatedCostUsd: "0",
    actualCostUsd: null,
    possibleDuplicateCostUsd: "0"
  };
}

function cancelDisplayFor(tool: PreviewToolState, approvalStatus: "none" | "denied") {
  return {
    registryTitle: tool.registryTitle,
    category: tool.category,
    parameterSummary: tool.parameterSummary,
    resultSummary: tool.resultSummary,
    errorMessage: "任务已停止，工具未完成",
    resultCount: tool.resultCount,
    resultType: tool.resultType,
    sourceTypes: tool.sourceTypes,
    durationMs: tool.durationMs,
    costUsd: tool.costUsd,
    attemptStatus: "unknown" as const,
    approvalStatus,
    errorCode: "RUN_CANCELLED"
  };
}

function stopEventBase(state: V2RunState) {
  const now = new Date().toISOString();
  return {
    schemaVersion: "2.0" as const,
    scope: state.scope,
    seq: state.cursor + 1,
    occurredAt: now,
    startedAt: now,
    completedAt: now,
    inputRevision: state.latestInputRevision,
    source: "fixture" as const,
    eventId: `preview_close_${crypto.randomUUID().replaceAll("-", "_")}`,
    runId: state.runId
  };
}

function closeOpenTools(
  initial: V2RunState,
  apply: (event: V2AgentEvent) => boolean,
  getState: () => V2RunState
): boolean {
  const openIds = initial.toolOrder.filter((id) => {
    const status = initial.toolCalls[id]?.status;
    return status === "running" || status === "waiting_approval";
  });
  for (const toolCallId of openIds) {
    const state = getState();
    const tool = state.toolCalls[toolCallId];
    if (!tool || (tool.status !== "running" && tool.status !== "waiting_approval")) {
      continue;
    }
    // waiting_approval：先发规范化 deny，工具才允许失败。
    if (tool.status === "waiting_approval" && tool.approvalId && !tool.approvalDecision) {
      const base = stopEventBase(state);
      const denyEvent = {
        schemaVersion: base.schemaVersion,
        eventId: base.eventId,
        runId: base.runId,
        scope: base.scope,
        seq: base.seq,
        occurredAt: base.occurredAt,
        type: "approval.decided" as const,
        kind: "approval" as const,
        status: "completed" as const,
        startedAt: base.startedAt,
        completedAt: base.completedAt,
        inputRevision: base.inputRevision,
        refs: { toolCallId },
        source: base.source,
        payload: {
          approvalId: tool.approvalId,
          toolCallId,
          decision: "deny" as const,
          decidedBy: actor,
          decidedAt: base.completedAt,
          publicText: null,
          reasonCodes: ["user_cancelled" as const]
        }
      } as V2AgentEvent<"approval.decided">;
      if (!apply(denyEvent)) return false;
    }
    const afterDeny = getState();
    const current = afterDeny.toolCalls[toolCallId];
    if (!current || current.status === "failed" || current.status === "completed"
      || current.status === "unknown") {
      continue;
    }
    const denied = current.approvalDecision === "deny";
    const base = stopEventBase(afterDeny);
    const failedEvent = {
      schemaVersion: base.schemaVersion,
      eventId: base.eventId,
      runId: base.runId,
      scope: base.scope,
      seq: base.seq,
      occurredAt: base.occurredAt,
      type: "tool.failed" as const,
      kind: "tool" as const,
      status: "failed" as const,
      startedAt: base.startedAt,
      completedAt: base.completedAt,
      inputRevision: base.inputRevision,
      refs: { toolCallId },
      source: base.source,
      payload: {
        toolCallId,
        toolId: current.toolId,
        display: cancelDisplayFor(current, denied ? "denied" : "none"),
        errorCode: "RUN_CANCELLED",
        retryable: false,
        durationMs: current.durationMs ?? 0,
        attempt: current.attempt,
        usage: cancelUsageFor(current),
        publicText: null,
        reasonCodes: ["user_cancelled" as const]
      }
    } as V2AgentEvent<"tool.failed">;
    if (!apply(failedEvent)) return false;
  }
  return true;
}

const emptyControllerState: V2InteractionControllerState = {
  order: [],
  commands: {}
};

function commandFeedback(command: V2ClientCommandState | null) {
  if (!command) return null;
  if (command.status === "submitting") return "正在提交";
  if (command.status === "accepted_pending") return "已接收，等待应用";
  if (command.status === "applied") return "已应用";
  if (command.status === "superseded") return "已被后续引导替代";
  if (command.errorCode === "COMMAND_REVISION_CONFLICT") return "引导版本已变化，请保留内容并重新读取后再提交";
  if (command.errorCode === "COMMAND_AFTER_TERMINAL" || command.errorCode === "RUN_TERMINAL") {
    return "当前任务已经结束，内容已保留";
  }
  if (command.errorCode === "STEERING_ATTACHMENTS_UNSUPPORTED") {
    return "当前引导合同不支持附件，内容和附件已保留";
  }
  if (command.status === "rejected") return "请求已拒绝，内容已保留";
  return "提交失败，内容已保留";
}

export interface V2PreviewInteractionRuntime {
  readonly activeRun: boolean;
  readonly runState: V2RunState;
  readonly controllerState: V2InteractionControllerState;
  readonly feedback: string | null;
  submitComposer(
    mode: V2ComposerSubmitMode,
    content: string,
    attachmentRefs: readonly string[]
  ): Promise<V2ClientCommandState>;
  resumeClarification(input: {
    readonly clarificationId: string;
    readonly checkpointRef: string;
    readonly expectedStateRevision: number;
    readonly content: string;
    readonly attachmentRefs: readonly string[];
  }): Promise<V2ClientCommandState>;
  decideApproval(input: {
    readonly approvalId: string;
    readonly toolCallId: string;
    readonly decision: "allow_once" | "deny";
  }): Promise<V2ClientCommandState>;
  ingestEvidence(event: V2AgentEvent): boolean;
  retry(commandId: string): Promise<V2ClientCommandState | null>;
  stop(): Promise<boolean>;
}

export function useV2PreviewInteraction(
  catalog: S01ProcessFixtureCatalog | null,
  selectedState: V2RunState | null
): V2PreviewInteractionRuntime | null {
  const [runStates, setRunStates] = useState<Readonly<Record<string, V2RunState>>>({});
  const scenario = catalog?.selectedScenario ?? null;
  const sessionKey = selectedState ? `${scenario}:${selectedState.runId}` : "disabled";
  const runState = runStates[sessionKey] ?? selectedState;
  const session = useMemo(() => {
    if (!catalog || !selectedState || !scenario) return null;
    const stateHolder = { value: selectedState };
    const adapter = createPreviewAdapter(scenario, () => stateHolder.value);
    const applyEvidence = (event: V2AgentEvent) => {
      const merged = mergeV2RunInput(stateHolder.value, event);
      if (!merged.accepted) return false;
      stateHolder.value = merged.state;
      setRunStates((current) => ({
        ...current,
        [sessionKey]: merged.state
      }));
      return true;
    };
    const controller = new V2InteractionController({
      adapter,
      onEvidence: applyEvidence
    });
    let stopInFlight: Promise<boolean> | null = null;
    const stop = () => {
      if (stopInFlight) return stopInFlight;
      let pending!: Promise<boolean>;
      pending = (async () => {
        const current = stateHolder.value;
        if (current.terminal) return true;
        // 停止前先收口所有未终态工具。waiting_approval 必须先 deny 再
        // failed；running 直接 failed，最后才允许 run.cancelled。
        if (!closeOpenTools(
          current,
          applyEvidence,
          () => stateHolder.value
        )) return false;
        const afterClose = stateHolder.value;
        if (afterClose.terminal) return true;
        const now = new Date().toISOString();
        const event: V2AgentEvent<"run.cancelled"> = {
          ...catalog.stopTerminalTemplate,
          eventId: `preview_stop_${crypto.randomUUID().replaceAll("-", "_")}`,
          runId: afterClose.runId,
          scope: afterClose.scope as V2Scope,
          seq: afterClose.cursor + 1,
          occurredAt: now,
          startedAt: now,
          completedAt: now,
          inputRevision: afterClose.latestInputRevision,
          source: "fixture"
        };
        return applyEvidence(event);
      })().finally(() => {
        if (stopInFlight === pending) stopInFlight = null;
      });
      stopInFlight = pending;
      return pending;
    };
    return {
      controller,
      stop
    };
  }, [catalog, scenario, selectedState, sessionKey]);
  const controller = session?.controller ?? null;

  const subscribe = useCallback(
    (listener: () => void) => controller?.subscribe(listener) ?? (() => undefined),
    [controller]
  );
  const getSnapshot = useCallback(
    () => controller?.getState() ?? emptyControllerState,
    [controller]
  );
  const controllerState = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  if (!catalog || !runState || !controller || !session) return null;

  const context = {
    runId: runState.runId,
    threadId: runState.scope.threadId,
    scope: runState.scope,
    actor
  };
  const lastCommandId = controllerState.order.at(-1);
  const lastCommand = lastCommandId ? controllerState.commands[lastCommandId] : null;

  return {
    activeRun: !runState.terminal,
    runState,
    controllerState,
    feedback: commandFeedback(lastCommand),
    submitComposer: (mode, content, attachmentRefs) => mode === "steer"
      ? controller.submitSteer({
          ...context,
          expectedSteeringRevision: currentSteeringRevision(runState),
          content,
          attachmentRefs
        } satisfies V2SteerInput)
      : controller.submitEnqueue({
          ...context,
          content,
          attachmentRefs
        }),
    resumeClarification: (input) => controller.resumeClarification({
      ...context,
      ...input
    }),
    decideApproval: (input) => controller.decideApproval({
      ...context,
      ...input
    }),
    // 3110 的事件源与首响应共用同一控制器入口。真实 SSE 接入时只需把
    // 已解析的 AgentEvent 送到这里，晚到状态便会先过相关性校验、再进 reducer。
    ingestEvidence: (event) => controller.ingestEvidence(event),
    retry: (commandId) => controller.retry(commandId),
    stop: session.stop
  };
}
