import budgetUpdatedBundle from "@contracts/v2/fixtures/valid/budget-updated.json";
import clarificationBundle from "@contracts/v2/fixtures/valid/clarification-interrupt.json";
import contextUsageBundle from "@contracts/v2/fixtures/valid/context-usage-lifecycle.json";
import nodeLifecycleBundle from "@contracts/v2/fixtures/valid/node-lifecycle.json";
import queueFifoBundle from "@contracts/v2/fixtures/valid/queue-fifo.json";
import queueLifecycleBundle from "@contracts/v2/fixtures/valid/queue-lifecycle.json";
import runCancelledBundle from "@contracts/v2/fixtures/valid/run-cancelled.json";
import runCompletedBundle from "@contracts/v2/fixtures/valid/run-completed.json";
import runFailedBundle from "@contracts/v2/fixtures/valid/run-failed.json";
import runPartialBundle from "@contracts/v2/fixtures/valid/run-partial-budget.json";
import steeringBatchBundle from "@contracts/v2/fixtures/valid/steering-batch.json";
import toolEventsBundle from "@contracts/v2/fixtures/valid/tool-events.json";
import toolFailedBundle from "@contracts/v2/fixtures/valid/tool-failed-events.json";
import toolUnknownBundle from "@contracts/v2/fixtures/valid/tool-unknown-outcome.json";
import {
  S01_PROCESS_SCENARIOS,
  type S01ProcessFixtureCatalog,
  type S01ProcessScenario
} from "@/lib/agent-events/v2/process-view-model";
import { createV2RunState, mergeV2RunInputs } from "@/lib/agent-events/v2/run-reducer";
import type { V2Scope, V2ToolDisplay, V2ToolUsage } from "@/lib/agent-events/v2/types";
import type { V2AgentEvent } from "@/lib/agent-events/v2/types";

export const S01_EVENT_FIXTURE_METADATA = Object.freeze({
  schemaVersion: "2.0",
  source: "fixture",
  mode: "mock",
  port: 3110,
  productionEligible: false
} as const);

export const S01_DIRECT_RUN_EVENTS: readonly unknown[] = runCompletedBundle.events;
export const S01_NODE_EVENTS: readonly unknown[] = nodeLifecycleBundle.events;
export const S01_CONTEXT_EVENTS: readonly unknown[] = contextUsageBundle.events;
export const S01_BUDGET_EVENTS: readonly unknown[] = budgetUpdatedBundle.events;
export const S01_CLARIFICATION_EVENTS: readonly unknown[] = clarificationBundle.events;
export const S01_STEERING_EVENTS: readonly unknown[] = steeringBatchBundle.events;
export const S01_TOOL_EVENTS: readonly unknown[] = toolEventsBundle.events;
export const S01_TOOL_FAILED_EVENTS: readonly unknown[] = toolFailedBundle.events;
export const S01_TOOL_UNKNOWN_EVENTS: readonly unknown[] = toolUnknownBundle.events;

const complexPlanEvent = {
  schemaVersion: "2.0",
  eventId: "event_plan_complex",
  runId: "run_complex",
  scope: runCompletedBundle.scope,
  seq: 1,
  occurredAt: "2026-07-26T12:59:59.900Z",
  type: "plan.updated",
  kind: "plan",
  status: "completed",
  startedAt: "2026-07-26T12:59:59.800Z",
  completedAt: "2026-07-26T12:59:59.900Z",
  inputRevision: 0,
  refs: { planRef: "plan_complex" },
  source: "fixture",
  payload: {
    planRef: "plan_complex",
    revision: 1,
    publicText: "已形成分步检索计划，后续按证据需求执行。",
    reasonCodes: ["search_required"]
  }
} as const;

export const S01_COMPLEX_RUN_EVENTS: readonly unknown[] = [
  complexPlanEvent,
  ...runCompletedBundle.events.map((event) => ({
    ...event,
    eventId: `${event.eventId}_complex`,
    runId: "run_complex",
    seq: event.seq + 1
  }))
];

export const S01_QUEUE_EVENTS: readonly unknown[] = queueFifoBundle.queueEvents;
export const S01_QUEUE_LIFECYCLE_EVENTS: readonly unknown[] = queueLifecycleBundle.queueEvents;
export const S01_COMPLETED_QUEUE_EVENTS: readonly unknown[] = runCompletedBundle.queueEvents;

type FixtureEvent = {
  readonly eventId: string;
  readonly runId: string;
  readonly seq: number;
  readonly [key: string]: unknown;
};

type ToolFixturePayload = {
  readonly toolCallId: string;
  readonly toolId: string;
  readonly display: V2ToolDisplay;
  readonly attempt: number;
  readonly usage?: V2ToolUsage;
  readonly [key: string]: unknown;
};

type ToolFixtureEvent = FixtureEvent & {
  readonly refs: { readonly toolCallId: string };
  readonly payload: ToolFixturePayload;
};

const fixtureScope = runCompletedBundle.scope as V2Scope;

function remapEvents(
  events: readonly FixtureEvent[],
  runId: string,
  prefix: string,
  offset = 0
): readonly unknown[] {
  return events.map((event) => ({
    ...event,
    eventId: `${prefix}_${event.eventId}`,
    runId,
    seq: event.seq + offset
  }));
}

function remapSequentialEvents(
  events: readonly FixtureEvent[],
  runId: string,
  prefix: string,
  offset = 0
): readonly unknown[] {
  return events.map((event, index) => ({
    ...event,
    eventId: `${prefix}_${event.eventId}`,
    runId,
    seq: index + 1 + offset
  }));
}

function runStatusEvent(runId: string, status: "running" | "waiting") {
  return {
    schemaVersion: "2.0",
    eventId: `${runId}_status`,
    runId,
    scope: fixtureScope,
    seq: 1,
    occurredAt: "2026-07-27T01:00:00Z",
    type: "run.status",
    kind: "run",
    status,
    startedAt: "2026-07-27T01:00:00Z",
    completedAt: null,
    inputRevision: 0,
    refs: {},
    source: "fixture",
    payload: {
      status,
      stateRevision: 1,
      node: status === "waiting" ? "await_input" : "compose_response",
      publicText: null,
      reasonCodes: []
    }
  } as const;
}

function toolEvent(
  source: unknown,
  options: {
    readonly eventId: string;
    readonly runId: string;
    readonly seq: number;
    readonly toolCallId?: string;
    readonly toolId?: string;
    readonly attempt?: number;
    readonly status?: string;
    readonly payload?: Readonly<Record<string, unknown>>;
    readonly display?: Partial<V2ToolDisplay>;
  }
) {
  const event = structuredClone(source) as ToolFixtureEvent;
  const toolCallId = options.toolCallId ?? event.payload.toolCallId;
  return {
    ...event,
    eventId: options.eventId,
    runId: options.runId,
    seq: options.seq,
    status: options.status ?? event.status,
    refs: { ...event.refs, toolCallId },
    payload: {
      ...event.payload,
      ...options.payload,
      toolCallId,
      toolId: options.toolId ?? event.payload.toolId,
      attempt: options.attempt ?? event.payload.attempt,
      display: {
        ...event.payload.display,
        ...options.display
      }
    }
  };
}

function toolScenario(runId: string, events: readonly unknown[]) {
  return [
    runStatusEvent(runId, "running"),
    ...events
  ];
}

function withClassifyResult(
  events: readonly unknown[],
  publicText: string,
  reasonCodes: readonly ("direct_answer" | "search_required")[]
) {
  return events.map((event) => {
    const candidate = event as {
      readonly type?: string;
      readonly payload?: { readonly node?: string; readonly [key: string]: unknown };
    };
    if (candidate.type !== "node.completed" || candidate.payload?.node !== "classify_intent") {
      return event;
    }
    return {
      ...(event as object),
      payload: {
        ...candidate.payload,
        publicText,
        reasonCodes
      }
    };
  });
}

const directProcessEvents = [
  ...remapEvents(nodeLifecycleBundle.events as readonly FixtureEvent[], "run_s01_direct", "s01_direct"),
  ...remapEvents(runCompletedBundle.events as readonly FixtureEvent[], "run_s01_direct", "s01_direct", 4)
];

const complexProcessEvents = [
  ...withClassifyResult(
    remapEvents(nodeLifecycleBundle.events as readonly FixtureEvent[], "run_s01_complex", "s01_complex"),
    "该任务需要比较多个来源，后续结论需要证据支持。",
    ["search_required"]
  ),
  {
    ...complexPlanEvent,
    eventId: "s01_complex_plan",
    runId: "run_s01_complex",
    seq: 5
  },
  ...remapEvents(runCompletedBundle.events as readonly FixtureEvent[], "run_s01_complex", "s01_complex", 5)
];

const activeProcessEvents = [
  runStatusEvent("run_s01_active", "running"),
  ...withClassifyResult(
    remapEvents(nodeLifecycleBundle.events as readonly FixtureEvent[], "run_s01_active", "s01_active", 1),
    "已根据问题范围完成处理路径选择。",
    []
  )
];

const failedVerification = {
  ...runCompletedBundle.events[0],
  eventId: "s01_verification_failed",
  runId: "run_s01_verification_failed",
  seq: 1,
  refs: {},
  payload: {
    ...runCompletedBundle.events[0].payload,
    passed: false,
    publicText: "现有结果未通过核验，不能作为最终答复。",
    reasonCodes: ["verification_failed"]
  }
};

const toolStarted = toolEventsBundle.events[0];
const toolUpdated = toolEventsBundle.events[1];
const toolCompleted = toolEventsBundle.events[4];
const toolFailed = toolFailedBundle.events[1];
const toolUnknown = toolUnknownBundle.events[1];

const toolSuccessEvents = toolScenario("run_s01_tool_success", [
  toolEvent(toolStarted, {
    eventId: "s01_tool_success_started",
    runId: "run_s01_tool_success",
    seq: 2,
    display: { approvalStatus: "none" }
  }),
  toolEvent(toolCompleted, {
    eventId: "s01_tool_success_completed",
    runId: "run_s01_tool_success",
    seq: 3,
    display: { approvalStatus: "none" }
  })
]);

const toolProgressEvents = toolScenario("run_s01_tool_progress", [
  toolEvent(toolStarted, {
    eventId: "s01_tool_progress_started",
    runId: "run_s01_tool_progress",
    seq: 2,
    display: { approvalStatus: "none" }
  }),
  toolEvent(toolUpdated, {
    eventId: "s01_tool_progress_updated",
    runId: "run_s01_tool_progress",
    seq: 3,
    status: "running",
    payload: { phase: "progress" },
    display: {
      approvalStatus: "none",
      resultSummary: "已读取 2 个候选来源",
      resultCount: 2,
      resultType: "links"
    }
  })
]);

const toolRetryingEvents = toolScenario("run_s01_tool_retrying", [
  toolEvent(toolStarted, {
    eventId: "s01_tool_retrying_started",
    runId: "run_s01_tool_retrying",
    seq: 2,
    display: { approvalStatus: "none" }
  }),
  toolEvent(toolUpdated, {
    eventId: "s01_tool_retrying_updated",
    runId: "run_s01_tool_retrying",
    seq: 3,
    status: "running",
    attempt: 2,
    payload: { phase: "retrying" },
    display: {
      approvalStatus: "none",
      errorMessage: "请求频率受限，等待后重试",
      errorCode: "RATE_LIMITED"
    }
  })
]);

const toolWaitingApprovalEvents = toolScenario(
  "run_s01_tool_waiting_approval",
  remapEvents(
    toolEventsBundle.events.slice(0, 3) as readonly FixtureEvent[],
    "run_s01_tool_waiting_approval",
    "s01_tool_waiting_approval",
    1
  )
);

const toolApprovalDecidedEvents = toolScenario(
  "run_s01_tool_approval_decided",
  remapEvents(
    toolEventsBundle.events.slice(0, 4) as readonly FixtureEvent[],
    "run_s01_tool_approval_decided",
    "s01_tool_approval_decided",
    1
  )
);

const toolEmptyEvents = toolScenario("run_s01_tool_empty", [
  toolEvent(toolStarted, {
    eventId: "s01_tool_empty_started",
    runId: "run_s01_tool_empty",
    seq: 2,
    display: { approvalStatus: "none" }
  }),
  toolEvent(toolCompleted, {
    eventId: "s01_tool_empty_completed",
    runId: "run_s01_tool_empty",
    seq: 3,
    display: {
      approvalStatus: "none",
      resultSummary: "未返回匹配结果",
      resultCount: 0,
      resultType: "none",
      costUsd: "0.002"
    },
    payload: {
      resultCount: 0,
      usage: {
        ...toolCompleted.payload.usage,
        resultCount: 0
      }
    }
  })
]);

const toolFailedEvents = toolScenario("run_s01_tool_failed", [
  toolEvent(toolFailedBundle.events[0], {
    eventId: "s01_tool_failed_started",
    runId: "run_s01_tool_failed",
    seq: 2
  }),
  toolEvent(toolFailed, {
    eventId: "s01_tool_failed_terminal",
    runId: "run_s01_tool_failed",
    seq: 3,
    display: { errorMessage: "页面读取超时" }
  })
]);

const toolUnknownEvents = toolScenario("run_s01_tool_unknown", [
  ...remapEvents(
    toolUnknownBundle.events as readonly FixtureEvent[],
    "run_s01_tool_unknown",
    "s01_tool_unknown",
    1
  )
]);

const toolParallelEvents = toolScenario("run_s01_tool_parallel", [
  toolEvent(toolStarted, {
    eventId: "s01_tool_parallel_a_started",
    runId: "run_s01_tool_parallel",
    seq: 2,
    toolCallId: "call_parallel_a",
    display: {
      registryTitle: "官方文档搜索",
      approvalStatus: "none"
    }
  }),
  toolEvent(toolStarted, {
    eventId: "s01_tool_parallel_b_started",
    runId: "run_s01_tool_parallel",
    seq: 3,
    toolCallId: "call_parallel_b",
    toolId: "page_fetch",
    display: {
      registryTitle: "页面读取",
      category: "fetch",
      approvalStatus: "none",
      sourceTypes: ["web"]
    },
    payload: { planStepId: "step_fetch" }
  }),
  toolEvent(toolCompleted, {
    eventId: "s01_tool_parallel_b_completed",
    runId: "run_s01_tool_parallel",
    seq: 4,
    toolCallId: "call_parallel_b",
    toolId: "page_fetch",
    display: {
      registryTitle: "页面读取",
      category: "fetch",
      approvalStatus: "none",
      resultSummary: "读取 2 个页面",
      resultCount: 2,
      resultType: "pages",
      sourceTypes: ["web"]
    },
    payload: {
      resultCount: 2,
      usage: {
        ...toolCompleted.payload.usage,
        toolId: "page_fetch",
        resultCount: 2,
        searchQueries: 0,
        pageReads: 2
      }
    }
  }),
  toolEvent(toolCompleted, {
    eventId: "s01_tool_parallel_a_completed",
    runId: "run_s01_tool_parallel",
    seq: 5,
    toolCallId: "call_parallel_a",
    display: {
      registryTitle: "官方文档搜索",
      approvalStatus: "none"
    }
  })
]);

const longTitle = "跨平台公开资料与官方文档联合检索工具（用于验证超长工具名称在窄屏下稳定换行）";
const longParameterSummary = "比较多个公开来源中的版本、发布时间、适用范围与已知限制，仅保留允许公开的参数摘要，不包含访问凭据或原始请求。";
const longResultSummary = "已返回多个可公开检查的候选来源，并按来源类型整理摘要；此处只展示 Tool Gateway 白名单投影，不展示原始响应正文。";
const toolLongEvents = toolScenario("run_s01_tool_long", [
  toolEvent(toolStarted, {
    eventId: "s01_tool_long_started",
    runId: "run_s01_tool_long",
    seq: 2,
    display: {
      registryTitle: longTitle,
      parameterSummary: longParameterSummary,
      approvalStatus: "none"
    }
  }),
  toolEvent(toolCompleted, {
    eventId: "s01_tool_long_completed",
    runId: "run_s01_tool_long",
    seq: 3,
    display: {
      registryTitle: longTitle,
      parameterSummary: longParameterSummary,
      resultSummary: longResultSummary,
      approvalStatus: "none"
    }
  })
]);

const composerActiveEvents = [
  runStatusEvent("run_s01_composer_active", "running")
];

const guidancePendingEvents = remapSequentialEvents(
  [steeringBatchBundle.events[0]] as readonly FixtureEvent[],
  "run_s01_guidance_pending",
  "s01_guidance_pending"
);

const guidanceAppliedEvents = remapSequentialEvents(
  [steeringBatchBundle.events[1], steeringBatchBundle.events[3]] as readonly FixtureEvent[],
  "run_s01_guidance_applied",
  "s01_guidance_applied"
);

const guidanceSupersededEvents = remapSequentialEvents(
  [steeringBatchBundle.events[0], steeringBatchBundle.events[2]] as readonly FixtureEvent[],
  "run_s01_guidance_superseded",
  "s01_guidance_superseded"
);

const guidanceRevisionConflictEvents = remapSequentialEvents(
  [steeringBatchBundle.events[4]] as readonly FixtureEvent[],
  "run_s01_guidance_revision_conflict",
  "s01_guidance_revision_conflict"
);

const guidanceFailedEvent = {
  ...steeringBatchBundle.events[4],
  eventId: "s01_guidance_failed_terminal",
  runId: "run_s01_guidance_failed",
  seq: 2,
  type: "guidance.failed",
  status: "failed",
  refs: { commandId: "command_format_1" },
  payload: {
    commandId: "command_format_1",
    commandSeq: 1,
    errorCode: "GUIDANCE_PROVIDER_ERROR",
    errorMessage: "引导暂时无法处理",
    retryable: true
  }
};

const guidanceFailedEvents = [
  ...remapSequentialEvents(
    [steeringBatchBundle.events[0]] as readonly FixtureEvent[],
    "run_s01_guidance_failed",
    "s01_guidance_failed"
  ),
  guidanceFailedEvent
];

const guidanceTerminalRejectedEvent = {
  ...steeringBatchBundle.events[4],
  eventId: "s01_guidance_terminal_rejected",
  runId: "run_s01_guidance_terminal_rejected",
  seq: 1,
  payload: {
    ...steeringBatchBundle.events[4].payload,
    code: "COMMAND_AFTER_TERMINAL"
  }
};

const clarificationWaitingEvents = remapSequentialEvents(
  [clarificationBundle.events[0]] as readonly FixtureEvent[],
  "run_s01_clarification_waiting",
  "s01_clarification_waiting"
);

const clarificationResumedEvents = remapSequentialEvents(
  clarificationBundle.events as readonly FixtureEvent[],
  "run_s01_clarification_resumed",
  "s01_clarification_resumed"
);

const clarificationStoppedEvents = [
  ...remapSequentialEvents(
    [clarificationBundle.events[0]] as readonly FixtureEvent[],
    "run_s01_clarification_stopped",
    "s01_clarification_stopped"
  ),
  ...remapSequentialEvents(
    runCancelledBundle.events as readonly FixtureEvent[],
    "run_s01_clarification_stopped",
    "s01_clarification_stopped_terminal",
    1
  )
];

function approvalDecisionEvent(
  runId: string,
  decision: "allow_once" | "deny" | "edit",
  seq: number
) {
  return {
    ...toolEventsBundle.events[3],
    eventId: `${runId}_${decision}`,
    runId,
    seq,
    payload: {
      ...toolEventsBundle.events[3].payload,
      decision
    }
  };
}

function approvalPrefix(runId: string) {
  return toolScenario(
    runId,
    remapEvents(
      toolEventsBundle.events.slice(0, 3) as readonly FixtureEvent[],
      runId,
      runId,
      1
    )
  );
}

const approvalWaitingEvents = approvalPrefix("run_s01_approval_waiting");
const approvalAllowedEvents = [
  ...approvalPrefix("run_s01_approval_allowed"),
  approvalDecisionEvent("run_s01_approval_allowed", "allow_once", 5)
];
const approvalDeniedEvents = [
  ...approvalPrefix("run_s01_approval_denied"),
  approvalDecisionEvent("run_s01_approval_denied", "deny", 5),
  toolEvent(toolFailed, {
    eventId: "run_s01_approval_denied_tool_failed",
    runId: "run_s01_approval_denied",
    seq: 6,
    toolCallId: "call_tool_1",
    toolId: "web_search",
    display: {
      registryTitle: "网页搜索",
      category: "search",
      approvalStatus: "denied",
      errorMessage: "用户拒绝授权",
      errorCode: "APPROVAL_DENIED"
    },
    payload: {
      errorCode: "APPROVAL_DENIED",
      retryable: false,
      usage: {
        ...toolFailed.payload.usage,
        toolId: "web_search"
      }
    }
  })
];
const approvalEditReadonlyEvents = [
  ...approvalPrefix("run_s01_approval_edit_readonly"),
  approvalDecisionEvent("run_s01_approval_edit_readonly", "edit", 5)
];

const processEventsByScenario: Readonly<Record<S01ProcessScenario, readonly unknown[]>> = {
  active: activeProcessEvents,
  direct: directProcessEvents,
  complex: complexProcessEvents,
  verification_failed: [
    failedVerification,
    ...remapEvents(
      runFailedBundle.events as readonly FixtureEvent[],
      "run_s01_verification_failed",
      "s01_verification_failed",
      1
    )
  ],
  partial: remapEvents(
    runPartialBundle.events as readonly FixtureEvent[],
    "run_s01_partial",
    "s01_partial"
  ),
  waiting: [runStatusEvent("run_s01_waiting", "waiting")],
  failed: remapEvents(
    runFailedBundle.events as readonly FixtureEvent[],
    "run_s01_failed",
    "s01_failed"
  ),
  stopped: remapEvents(
    runCancelledBundle.events as readonly FixtureEvent[],
    "run_s01_stopped",
    "s01_stopped"
  ),
  tool_success: toolSuccessEvents,
  tool_parallel: toolParallelEvents,
  tool_progress: toolProgressEvents,
  tool_retrying: toolRetryingEvents,
  tool_waiting_approval: toolWaitingApprovalEvents,
  tool_approval_decided: toolApprovalDecidedEvents,
  tool_empty: toolEmptyEvents,
  tool_failed: toolFailedEvents,
  tool_unknown: toolUnknownEvents,
  tool_long: toolLongEvents,
  composer_active: composerActiveEvents,
  guidance_pending: guidancePendingEvents,
  guidance_applied: guidanceAppliedEvents,
  guidance_superseded: guidanceSupersededEvents,
  guidance_revision_conflict: guidanceRevisionConflictEvents,
  guidance_failed: guidanceFailedEvents,
  guidance_terminal_rejected: [guidanceTerminalRejectedEvent],
  clarification_waiting: clarificationWaitingEvents,
  clarification_resumed: clarificationResumedEvents,
  clarification_stopped: clarificationStoppedEvents,
  approval_waiting: approvalWaitingEvents,
  approval_allowed: approvalAllowedEvents,
  approval_denied: approvalDeniedEvents,
  approval_edit_readonly: approvalEditReadonlyEvents
};

export function projectS01ProcessFixture(scenario: S01ProcessScenario) {
  const runId = `run_s01_${scenario}`;
  const projected = mergeV2RunInputs(
    createV2RunState(runId, fixtureScope),
    processEventsByScenario[scenario]
  );
  if (projected.rejected.length > 0) {
    throw new Error(`Invalid S01 ${scenario} fixture: ${projected.rejected[0].errorCode}`);
  }
  return projected.state;
}

export function createS01ProcessFixtureCatalog(
  requestedScenario: string | null | undefined
): S01ProcessFixtureCatalog {
  const selectedScenario = S01_PROCESS_SCENARIOS.includes(requestedScenario as S01ProcessScenario)
    ? requestedScenario as S01ProcessScenario
    : "complex";
  return {
    schemaVersion: "2.0",
    source: "fixture",
    mode: "mock",
    selectedScenario,
    stopTerminalTemplate: runCancelledBundle.events[0] as V2AgentEvent<"run.cancelled">,
    states: Object.fromEntries(
      S01_PROCESS_SCENARIOS.map((scenario) => [scenario, projectS01ProcessFixture(scenario)])
    ) as Record<S01ProcessScenario, ReturnType<typeof projectS01ProcessFixture>>
  };
}
