import { describe, expect, expectTypeOf, it } from "vitest";
import {
  S01_BUDGET_EVENTS,
  S01_CLARIFICATION_EVENTS,
  S01_COMPLETED_QUEUE_EVENTS,
  S01_COMPLEX_RUN_EVENTS,
  S01_CONTEXT_EVENTS,
  S01_DIRECT_RUN_EVENTS,
  S01_EVENT_FIXTURE_METADATA,
  S01_NODE_EVENTS,
  S01_QUEUE_EVENTS,
  S01_QUEUE_LIFECYCLE_EVENTS,
  S01_STEERING_EVENTS,
  S01_TOOL_EVENTS,
  S01_TOOL_FAILED_EVENTS,
  S01_TOOL_UNKNOWN_EVENTS,
  projectS01ProcessFixture
} from "@/server/mock/s01-event-fixtures";
import { parseV2AgentEvent, parseV2ThreadQueueEvent } from "./adapter";
import {
  createV2QueueState,
  mergeV2QueueInput,
  mergeV2QueueInputs
} from "./queue-reducer";
import {
  createV2RunState,
  mergeV2RunInput,
  mergeV2RunInputs,
  type V2RunState
} from "./run-reducer";
import { projectV2Snapshot } from "./snapshot-projector";
import type { V2AgentEvent, V2Scope } from "./types";

type JsonObject = Record<string, unknown>;

const scope: V2Scope = {
  tenantId: "tenant_1",
  actorId: "actor_1",
  visitorId: "visitor_1",
  projectId: "project_1",
  threadId: "thread_1"
};

function cloneObject(input: unknown): JsonObject {
  return structuredClone(input) as JsonObject;
}

function eventWith(input: unknown, patch: JsonObject): JsonObject {
  return { ...cloneObject(input), ...patch };
}

function runState(runId: string) {
  return createV2RunState(runId, scope);
}

function queueState() {
  return createV2QueueState(scope.threadId, scope);
}

function expectRunRejection(
  state: V2RunState,
  input: unknown,
  errorCode: string
) {
  const result = mergeV2RunInput(state, input);
  expect(result).toMatchObject({ accepted: false, errorCode });
  expect(result.state).toBe(state);
  expect(result.state.cursor).toBe(state.cursor);
  return result;
}

describe("v2 event adapter", () => {
  it("keeps event status narrowed by event type at compile time", () => {
    expectTypeOf<Extract<V2AgentEvent, { type: "tool.completed" }>["status"]>()
      .toEqualTypeOf<"completed">();
    expectTypeOf<Extract<V2AgentEvent, { type: "run.created" }>["status"]>()
      .toEqualTypeOf<"pending">();
  });

  it("parses strict AgentEvent and ThreadQueueEvent discriminated unions", () => {
    const run = parseV2AgentEvent(S01_DIRECT_RUN_EVENTS[0]);
    const queue = parseV2ThreadQueueEvent(S01_QUEUE_EVENTS[0]);

    expect(run.ok && run.value.type).toBe("verification.completed");
    expect(queue.ok && queue.value.type).toBe("queue.updated");
  });

  it("rejects bad versions, unknown payload fields and private reasoning recursively", () => {
    const badVersion = eventWith(S01_DIRECT_RUN_EVENTS[0], { schemaVersion: "1.0" });
    const badPayload = cloneObject(S01_DIRECT_RUN_EVENTS[0]);
    (badPayload.payload as JsonObject).unexpected = true;
    const privateReasoning = cloneObject(S01_DIRECT_RUN_EVENTS[0]);
    (privateReasoning.payload as JsonObject).nested = { reasoning_content: "private" };

    expect(parseV2AgentEvent(badVersion)).toMatchObject({ ok: false, errorCode: "SCHEMA_INVALID" });
    expect(parseV2AgentEvent(badPayload)).toMatchObject({ ok: false, errorCode: "SCHEMA_INVALID" });
    expect(parseV2AgentEvent(privateReasoning)).toMatchObject({
      ok: false,
      errorCode: "PRIVATE_REASONING_FORBIDDEN"
    });

    const badQueue = cloneObject(S01_QUEUE_EVENTS[0]);
    (badQueue.payload as JsonObject).prompt = "secret";
    expect(parseV2ThreadQueueEvent(badQueue)).toMatchObject({ ok: false, errorCode: "SCHEMA_INVALID" });
  });

  it("rejects an unknown event type without consuming the run cursor", () => {
    const initial = runState("run_direct");
    const unknownType = eventWith(S01_DIRECT_RUN_EVENTS[0], { type: "future.event" });

    expect(parseV2AgentEvent(unknownType)).toMatchObject({ ok: false, errorCode: "SCHEMA_INVALID" });
    expectRunRejection(initial, unknownType, "SCHEMA_INVALID");
  });
});

describe("v2 run reducer", () => {
  it("does not consume the cursor for a bad event and accepts the corrected same-seq event", () => {
    const initial = runState("run_direct");
    const bad = eventWith(S01_DIRECT_RUN_EVENTS[0], { schemaVersion: "1.0" });

    expectRunRejection(initial, bad, "SCHEMA_INVALID");
    const corrected = mergeV2RunInput(initial, S01_DIRECT_RUN_EVENTS[0]);

    expect(corrected.accepted).toBe(true);
    expect(corrected.state.cursor).toBe(1);
  });

  it("changes runStatus only for run lifecycle events", () => {
    const terminal = cloneObject(S01_DIRECT_RUN_EVENTS.at(-1));
    const terminalPayload = terminal.payload as JsonObject;
    const runCreated = {
      schemaVersion: "2.0",
      eventId: "event_status_created",
      runId: "run_status",
      scope,
      seq: 1,
      occurredAt: "2026-07-27T00:00:00Z",
      type: "run.created",
      kind: "run",
      status: "pending",
      startedAt: "2026-07-27T00:00:00Z",
      completedAt: null,
      inputRevision: 0,
      refs: {},
      source: "fixture",
      payload: {
        agentId: "search_agent",
        modelId: "deepseek_v4_flash",
        graphVersion: "graph_v2",
        runRevision: 0,
        budget: terminalPayload.budget
      }
    };
    const processEvents = [
      ...S01_NODE_EVENTS,
      S01_COMPLEX_RUN_EVENTS[0],
      ...S01_BUDGET_EVENTS,
      ...S01_TOOL_FAILED_EVENTS
    ].map((event, index) => eventWith(event, {
      eventId: `event_status_${index + 2}`,
      runId: "run_status",
      seq: index + 2
    }));

    const created = mergeV2RunInput(runState("run_status"), runCreated);
    expect(created.accepted).toBe(true);
    const merged = mergeV2RunInputs(created.state, processEvents);

    expect(merged.rejected).toEqual([]);
    expect(merged.state.runStatus).toBe("pending");
    expect(merged.state.nodeExecutions.node_execution_classify_1.status).toBe("completed");
    expect(merged.state.toolCalls.call_failed_1.status).toBe("failed");
  });

  it("enforces message and clarification lifecycle pairing", () => {
    const messageCompleted = eventWith(S01_DIRECT_RUN_EVENTS[2], { seq: 1 });
    expectRunRejection(runState("run_direct"), messageCompleted, "MESSAGE_LIFECYCLE_INVALID");

    const resumed = eventWith(S01_CLARIFICATION_EVENTS[1], { seq: 1 });
    expectRunRejection(
      runState("run_clarification"),
      resumed,
      "CLARIFICATION_LIFECYCLE_INVALID"
    );

    const valid = mergeV2RunInputs(runState("run_clarification"), S01_CLARIFICATION_EVENTS);
    expect(valid.rejected).toEqual([]);
    expect(valid.state.clarifications.clarification_1.status).toBe("resumed");
  });

  it("requires current verified output and no running node or tool before completion", () => {
    const verificationFailed = cloneObject(S01_DIRECT_RUN_EVENTS[0]);
    (verificationFailed.payload as JsonObject).passed = false;
    const incomplete = [
      verificationFailed,
      eventWith(S01_DIRECT_RUN_EVENTS[1], { seq: 2 }),
      eventWith(S01_DIRECT_RUN_EVENTS[2], { seq: 3 })
    ];
    const beforeTerminal = mergeV2RunInputs(runState("run_direct"), incomplete).state;
    const terminal = eventWith(S01_DIRECT_RUN_EVENTS[4], { seq: 4 });
    expectRunRejection(beforeTerminal, terminal, "TERMINAL_PREREQUISITE_INVALID");

    const verified = mergeV2RunInputs(
      runState("run_direct"),
      S01_DIRECT_RUN_EVENTS.slice(0, 3)
    ).state;
    const runningNode = eventWith(S01_NODE_EVENTS[0], {
      eventId: "event_dangling_node",
      runId: "run_direct",
      seq: 4
    });
    const withDanglingNode = mergeV2RunInput(verified, runningNode);
    expect(withDanglingNode.accepted).toBe(true);
    expectRunRejection(
      withDanglingNode.state,
      eventWith(S01_DIRECT_RUN_EVENTS[4], { seq: 5 }),
      "TERMINAL_PREREQUISITE_INVALID"
    );

    const runningTool = eventWith(S01_TOOL_FAILED_EVENTS[0], {
      eventId: "event_dangling_tool",
      runId: "run_direct",
      seq: 4
    });
    const withDanglingTool = mergeV2RunInput(verified, runningTool);
    expect(withDanglingTool.accepted).toBe(true);
    expectRunRejection(
      withDanglingTool.state,
      eventWith(S01_DIRECT_RUN_EVENTS[4], { seq: 5 }),
      "TERMINAL_PREREQUISITE_INVALID"
    );
  });

  it("merges each tool lifecycle in place and keeps parallel order by started seq", () => {
    const lifecycle = mergeV2RunInputs(runState("run_tool_1"), S01_TOOL_EVENTS);
    expect(lifecycle.rejected).toEqual([]);
    expect(lifecycle.state.toolOrder).toEqual(["call_tool_1"]);
    expect(Object.keys(lifecycle.state.toolCalls)).toEqual(["call_tool_1"]);
    expect(lifecycle.state.toolCalls.call_tool_1).toMatchObject({
      status: "completed",
      phase: "completed",
      approvalStatus: "approved",
      approvalDecision: "allow_once",
      firstSeq: 1,
      lastSeq: 5
    });
    expect(JSON.stringify(lifecycle.state.toolCalls)).not.toMatch(
      /inputHash|outputHash|resultRef|arguments|providerBody/u
    );

    const parallel = projectS01ProcessFixture("tool_parallel");
    expect(parallel.toolOrder).toEqual(["call_parallel_a", "call_parallel_b"]);
    expect(parallel.toolCalls.call_parallel_b.lastSeq).toBeLessThan(
      parallel.toolCalls.call_parallel_a.lastSeq
    );
    expect(Object.keys(parallel.toolCalls)).toHaveLength(2);
  });

  it("rejects tool updates, terminals and approvals without a matching start", () => {
    expectRunRejection(
      runState("run_tool_1"),
      eventWith(S01_TOOL_EVENTS[1], { seq: 1 }),
      "TOOL_LIFECYCLE_INVALID"
    );
    expectRunRejection(
      runState("run_tool_1"),
      eventWith(S01_TOOL_EVENTS[4], { seq: 1 }),
      "TOOL_LIFECYCLE_INVALID"
    );
    expectRunRejection(
      runState("run_tool_1"),
      eventWith(S01_TOOL_EVENTS[2], { seq: 1 }),
      "APPROVAL_LIFECYCLE_INVALID"
    );
  });

  it("treats approval denial as an auditable stop, not permission to keep executing", () => {
    const deniedDecision = cloneObject(S01_TOOL_EVENTS[3]);
    (deniedDecision.payload as JsonObject).decision = "deny";
    const denied = mergeV2RunInputs(runState("run_tool_1"), [
      ...S01_TOOL_EVENTS.slice(0, 3),
      deniedDecision
    ]);
    expect(denied.rejected).toEqual([]);
    expect(denied.state.toolCalls.call_tool_1).toMatchObject({
      status: "denied",
      phase: "approval_decided",
      approvalStatus: "denied",
      approvalDecision: "deny"
    });

    const completedRunPayload = cloneObject(S01_DIRECT_RUN_EVENTS[4]).payload as JsonObject;
    const runFailedAfterDeny = eventWith(S01_DIRECT_RUN_EVENTS[4], {
      eventId: "event_run_failed_after_deny",
      runId: "run_tool_1",
      seq: 5,
      type: "run.failed",
      status: "failed",
      refs: {},
      payload: {
        stopReason: "failed",
        errorCode: "APPROVAL_DENIED",
        usage: completedRunPayload.usage,
        budget: completedRunPayload.budget
      }
    });
    expectRunRejection(
      denied.state,
      runFailedAfterDeny,
      "TERMINAL_PREREQUISITE_INVALID"
    );

    const progress = cloneObject(S01_TOOL_EVENTS[1]);
    progress.eventId = "event_denied_progress";
    progress.seq = 5;
    progress.status = "running";
    const progressPayload = progress.payload as JsonObject;
    progressPayload.phase = "progress";
    (progressPayload.display as JsonObject).approvalStatus = "denied";
    expectRunRejection(denied.state, progress, "TOOL_LIFECYCLE_INVALID");

    const completed = cloneObject(S01_TOOL_EVENTS[4]);
    completed.eventId = "event_denied_completed";
    completed.seq = 5;
    (completed.payload as JsonObject).display = {
      ...((completed.payload as JsonObject).display as JsonObject),
      approvalStatus: "denied"
    };
    expectRunRejection(denied.state, completed, "TOOL_LIFECYCLE_INVALID");

    const unknown = cloneObject(S01_TOOL_UNKNOWN_EVENTS[1]);
    unknown.eventId = "event_denied_unknown";
    unknown.runId = "run_tool_1";
    unknown.seq = 5;
    unknown.refs = { toolCallId: "call_tool_1" };
    unknown.payload = {
      ...(unknown.payload as JsonObject),
      toolCallId: "call_tool_1",
      toolId: "web_search",
      display: {
        ...((unknown.payload as JsonObject).display as JsonObject),
        registryTitle: "网页搜索",
        category: "search",
        approvalStatus: "denied"
      }
    };
    expectRunRejection(denied.state, unknown, "TOOL_LIFECYCLE_INVALID");

    const failed = cloneObject(S01_TOOL_FAILED_EVENTS[1]);
    failed.eventId = "event_denied_failed";
    failed.runId = "run_tool_1";
    failed.seq = 5;
    failed.refs = { toolCallId: "call_tool_1" };
    failed.payload = {
      ...(failed.payload as JsonObject),
      toolCallId: "call_tool_1",
      toolId: "web_search",
      display: {
        ...((failed.payload as JsonObject).display as JsonObject),
        registryTitle: "网页搜索",
        category: "search",
        approvalStatus: "denied"
      },
      usage: {
        ...((failed.payload as JsonObject).usage as JsonObject),
        toolId: "web_search"
      }
    };
    const normalizedFailure = mergeV2RunInput(denied.state, failed);
    expect(normalizedFailure.accepted).toBe(true);
    expect(normalizedFailure.state.toolCalls.call_tool_1.status).toBe("failed");

    const runFailedAfterToolTerminal = eventWith(runFailedAfterDeny, {
      eventId: "event_run_failed_after_tool_terminal",
      seq: 6
    });
    const terminal = mergeV2RunInput(normalizedFailure.state, runFailedAfterToolTerminal);
    expect(terminal.accepted).toBe(true);
    expect(terminal.state.terminal).toBe("failed");
  });

  it("rejects a terminal tool display that contradicts an approval decision", () => {
    const unapproved = mergeV2RunInput(runState("run_tool_1"), S01_TOOL_EVENTS[0]);
    expect(unapproved.accepted).toBe(true);
    const completedWithoutDecision = cloneObject(S01_TOOL_EVENTS[4]);
    completedWithoutDecision.eventId = "event_completed_without_approval";
    completedWithoutDecision.seq = 2;
    (completedWithoutDecision.payload as JsonObject).display = {
      ...((completedWithoutDecision.payload as JsonObject).display as JsonObject),
      approvalStatus: "required"
    };
    expectRunRejection(
      unapproved.state,
      completedWithoutDecision,
      "TOOL_LIFECYCLE_INVALID"
    );

    const approved = mergeV2RunInputs(runState("run_tool_1"), S01_TOOL_EVENTS.slice(0, 4));
    expect(approved.rejected).toEqual([]);
    const completed = cloneObject(S01_TOOL_EVENTS[4]);
    (completed.payload as JsonObject).display = {
      ...((completed.payload as JsonObject).display as JsonObject),
      approvalStatus: "none"
    };
    expectRunRejection(approved.state, completed, "TOOL_LIFECYCLE_INVALID");
  });

  it("keeps approval edit as read-only audit state until a future resume contract exists", () => {
    const editDecision = cloneObject(S01_TOOL_EVENTS[3]);
    (editDecision.payload as JsonObject).decision = "edit";
    const edited = mergeV2RunInputs(runState("run_tool_1"), [
      ...S01_TOOL_EVENTS.slice(0, 3),
      editDecision
    ]);
    expect(edited.rejected).toEqual([]);
    expect(edited.state.toolCalls.call_tool_1).toMatchObject({
      status: "waiting_approval",
      phase: "approval_decided",
      approvalDecision: "edit"
    });

    const progress = cloneObject(S01_TOOL_EVENTS[1]);
    progress.eventId = "event_edited_progress";
    progress.seq = 5;
    progress.status = "running";
    const payload = progress.payload as JsonObject;
    payload.phase = "progress";
    expectRunRejection(edited.state, progress, "TOOL_LIFECYCLE_INVALID");
  });

  it("permits memory only after passed verification and a verified assistant response", () => {
    const memory = eventWith(S01_DIRECT_RUN_EVENTS[3], { seq: 1 });
    expectRunRejection(runState("run_direct"), memory, "MEMORY_WRITE_INVALID");

    const verified = mergeV2RunInputs(
      runState("run_direct"),
      S01_DIRECT_RUN_EVENTS.slice(0, 4)
    );
    expect(verified.rejected).toEqual([]);

    const completedPayload = cloneObject(S01_DIRECT_RUN_EVENTS[4]).payload as JsonObject;
    const failedTerminal = {
      ...eventWith(S01_DIRECT_RUN_EVENTS[4], {
        type: "run.failed",
        status: "failed",
        refs: {},
        payload: {
          stopReason: "failed",
          errorCode: "PROVIDER_ERROR",
          usage: completedPayload.usage,
          budget: completedPayload.budget
        }
      })
    };
    expectRunRejection(verified.state, failedTerminal, "MEMORY_WRITE_INVALID");

    const oldResponseEvents = [
      eventWith(S01_DIRECT_RUN_EVENTS[0], {
        eventId: "event_verify_old",
        refs: { responseId: "response_old" }
      }),
      eventWith(S01_DIRECT_RUN_EVENTS[1], {
        eventId: "event_message_old_started",
        payload: {
          messageId: "message_old",
          role: "assistant",
          steeringRevision: 0
        },
        refs: { messageId: "message_old" }
      }),
      eventWith(S01_DIRECT_RUN_EVENTS[2], {
        eventId: "event_message_old_completed",
        payload: {
          ...(cloneObject(S01_DIRECT_RUN_EVENTS[2]).payload as JsonObject),
          messageId: "message_old",
          responseId: "response_old"
        },
        refs: { messageId: "message_old", responseId: "response_old" }
      }),
      eventWith(S01_DIRECT_RUN_EVENTS[3], {
        eventId: "event_memory_old",
        payload: {
          memoryRef: "memory_old",
          sourceResponseId: "response_old",
          exchangeVerified: true
        },
        refs: { responseId: "response_old" }
      }),
      eventWith(S01_STEERING_EVENTS[1], {
        eventId: "event_guidance_new_accepted",
        runId: "run_direct",
        seq: 5
      }),
      eventWith(S01_STEERING_EVENTS[3], {
        eventId: "event_guidance_new_applied",
        runId: "run_direct",
        seq: 6
      }),
      eventWith(S01_DIRECT_RUN_EVENTS[0], {
        eventId: "event_verify_new",
        seq: 7,
        inputRevision: 1
      }),
      eventWith(S01_DIRECT_RUN_EVENTS[1], {
        eventId: "event_message_new_started",
        seq: 8,
        inputRevision: 1
      }),
      eventWith(S01_DIRECT_RUN_EVENTS[2], {
        eventId: "event_message_new_completed",
        seq: 9,
        inputRevision: 1
      })
    ];
    const stateWithStaleMemory = mergeV2RunInputs(runState("run_direct"), oldResponseEvents);
    expect(stateWithStaleMemory.rejected).toEqual([]);
    expectRunRejection(
      stateWithStaleMemory.state,
      eventWith(S01_DIRECT_RUN_EVENTS[4], { seq: 10, inputRevision: 1 }),
      "MEMORY_WRITE_INVALID"
    );
  });

  it("rejects stale outputs after a guidance revision without consuming seq", () => {
    const steered = mergeV2RunInputs(
      runState("run_steering_batch"),
      S01_STEERING_EVENTS.slice(0, 4)
    );
    expect(steered.rejected).toEqual([]);
    expect(steered.state.latestInputRevision).toBe(1);

    const staleVerification = eventWith(S01_DIRECT_RUN_EVENTS[0], {
      eventId: "event_stale_verification",
      runId: "run_steering_batch",
      seq: 5,
      inputRevision: 0
    });
    expectRunRejection(steered.state, staleVerification, "INPUT_REVISION_STALE");

    const staleContext = eventWith(S01_CONTEXT_EVENTS[0], {
      eventId: "event_stale_context",
      runId: "run_steering_batch",
      seq: 5,
      inputRevision: 0
    });
    expectRunRejection(steered.state, staleContext, "INPUT_REVISION_STALE");

    const staleTool = eventWith(S01_TOOL_EVENTS[0], {
      eventId: "event_stale_tool",
      runId: "run_steering_batch",
      seq: 5,
      inputRevision: 0
    });
    expectRunRejection(steered.state, staleTool, "INPUT_REVISION_STALE");

    const staleApproval = eventWith(S01_TOOL_EVENTS[2], {
      eventId: "event_stale_approval",
      runId: "run_steering_batch",
      seq: 5,
      inputRevision: 0
    });
    expectRunRejection(steered.state, staleApproval, "INPUT_REVISION_STALE");
  });

  it("enforces context estimate-to-actual and strict budget revisions", () => {
    const context = mergeV2RunInputs(runState("run_context_1"), S01_CONTEXT_EVENTS.slice(0, 2));
    expect(context.rejected).toEqual([]);
    const actualAgain = eventWith(S01_CONTEXT_EVENTS[1], {
      eventId: "context_actual_again",
      seq: 3
    });
    expectRunRejection(context.state, actualAgain, "CONTEXT_REVISION_INVALID");

    const advanced = mergeV2RunInput(context.state, S01_CONTEXT_EVENTS[2]);
    expect(advanced.accepted).toBe(true);
    const regressed = eventWith(S01_CONTEXT_EVENTS[1], {
      eventId: "context_regressed",
      seq: 4,
      inputRevision: 1
    });
    expectRunRejection(advanced.state, regressed, "CONTEXT_REVISION_INVALID");

    const budget = mergeV2RunInput(runState("run_budget_1"), S01_BUDGET_EVENTS[0]);
    expect(budget.accepted).toBe(true);
    const duplicateRevision = eventWith(S01_BUDGET_EVENTS[0], {
      eventId: "budget_duplicate_revision",
      seq: 2
    });
    expectRunRejection(budget.state, duplicateRevision, "BUDGET_REVISION_INVALID");
  });

  it("keeps direct runs plan-free and projects complex plans without replay drift", () => {
    const direct = projectV2Snapshot({
      runId: "run_direct",
      threadId: scope.threadId,
      scope,
      runEvents: S01_DIRECT_RUN_EVENTS,
      queueEvents: S01_COMPLETED_QUEUE_EVENTS
    });
    const complex = projectV2Snapshot({
      runId: "run_complex",
      threadId: scope.threadId,
      scope,
      runEvents: S01_COMPLEX_RUN_EVENTS,
      queueEvents: []
    });
    const directIncremental = mergeV2RunInputs(runState("run_direct"), S01_DIRECT_RUN_EVENTS);

    expect(direct.rejectedRunInputs).toEqual([]);
    expect(direct.run).toEqual(directIncremental.state);
    expect(direct.run.plan).toBeNull();
    expect(complex.rejectedRunInputs).toEqual([]);
    expect(complex.run.plan).toMatchObject({ planRef: "plan_complex", revision: 1 });
  });

  it("rejects seq gaps, duplicate ids and events after terminal without state mutation", () => {
    const gap = eventWith(S01_DIRECT_RUN_EVENTS[0], { seq: 2 });
    expectRunRejection(runState("run_direct"), gap, "RUN_SEQ_INVALID");

    const first = mergeV2RunInput(runState("run_direct"), S01_DIRECT_RUN_EVENTS[0]);
    expect(first.accepted).toBe(true);
    const duplicateId = eventWith(S01_DIRECT_RUN_EVENTS[1], {
      seq: 2,
      eventId: "event_verify_direct"
    });
    expectRunRejection(first.state, duplicateId, "EVENT_ID_DUPLICATE");

    const terminal = mergeV2RunInputs(runState("run_direct"), S01_DIRECT_RUN_EVENTS);
    expect(terminal.rejected).toEqual([]);
    const after = eventWith(S01_DIRECT_RUN_EVENTS[0], {
      eventId: "event_after_terminal",
      seq: 6
    });
    expectRunRejection(terminal.state, after, "EVENT_AFTER_TERMINAL");
  });
});

describe("v2 queue reducer and snapshot projector", () => {
  it("keeps run and queue cursors independent when either stream rejects input", () => {
    const run = mergeV2RunInput(runState("run_direct"), S01_DIRECT_RUN_EVENTS[0]);
    const queue = mergeV2QueueInput(queueState(), S01_QUEUE_EVENTS[0]);
    expect(run.accepted).toBe(true);
    expect(queue.accepted).toBe(true);

    const badRun = eventWith(S01_DIRECT_RUN_EVENTS[1], { seq: 3 });
    const badQueue = eventWith(S01_QUEUE_LIFECYCLE_EVENTS[0], {
      queueCursor: 2,
      queueRevision: 2,
      payload: {
        ...(cloneObject(S01_QUEUE_LIFECYCLE_EVENTS[0]).payload as JsonObject),
        expectedPreviousRevision: 0
      }
    });
    const rejectedRun = mergeV2RunInput(run.state, badRun);
    const rejectedQueue = mergeV2QueueInput(queue.state, badQueue);

    expect(rejectedRun.state.cursor).toBe(1);
    expect(rejectedQueue.state.cursor).toBe(1);
    expect(run.state.cursor).toBe(1);
    expect(queue.state.cursor).toBe(1);
  });

  it("does not consume queue revision for a bad event and then accepts the corrected event", () => {
    const initial = queueState();
    const bad = eventWith(S01_QUEUE_EVENTS[0], {
      payload: {
        ...(cloneObject(S01_QUEUE_EVENTS[0]).payload as JsonObject),
        expectedPreviousRevision: 9
      }
    });
    const rejected = mergeV2QueueInput(initial, bad);

    expect(rejected).toMatchObject({ accepted: false, errorCode: "QUEUE_REVISION_CONFLICT" });
    expect(rejected.state).toBe(initial);
    const corrected = mergeV2QueueInput(initial, S01_QUEUE_EVENTS[0]);
    expect(corrected.accepted).toBe(true);
    expect(corrected.state).toMatchObject({ cursor: 1, revision: 1 });
  });

  it("enforces FIFO timestamps and unique active run", () => {
    const fifo = cloneObject(S01_QUEUE_EVENTS[0]);
    const fifoPayload = fifo.payload as JsonObject;
    const entries = structuredClone(fifoPayload.entries) as JsonObject[];
    entries[1].createdAt = "2026-07-26T16:03:00Z";
    entries[2].createdAt = "2026-07-26T16:02:00Z";
    fifoPayload.entries = entries;
    const fifoResult = mergeV2QueueInput(queueState(), fifo);
    expect(fifoResult).toMatchObject({ accepted: false, errorCode: "QUEUE_ORDER_INVALID" });
    expect(fifoResult.state.cursor).toBe(0);

    const doubleActive = cloneObject(S01_QUEUE_EVENTS[0]);
    const activePayload = doubleActive.payload as JsonObject;
    const activeEntries = structuredClone(activePayload.entries) as JsonObject[];
    activeEntries.push({
      ...activeEntries[0],
      queueEntryId: "queue_running_2",
      messageRef: "message_running_2",
      runId: "run_active_2",
      idempotencyKey: "idem_queue_running_2"
    });
    activePayload.entries = activeEntries;
    activePayload.activeRunIds = ["run_active_1", "run_active_2"];
    const activeResult = mergeV2QueueInput(queueState(), doubleActive);
    expect(activeResult).toMatchObject({ accepted: false, errorCode: "QUEUE_ACTIVE_RUN_CONFLICT" });
    expect(activeResult.state.cursor).toBe(0);
  });

  it("enforces terminal pause and completed auto-start semantics", () => {
    const cancelled = cloneObject(S01_QUEUE_LIFECYCLE_EVENTS[0]);
    const cancelledPayload = cancelled.payload as JsonObject;
    cancelledPayload.transition = "dequeued";
    cancelledPayload.trigger = { runId: "run_stopped", terminalStatus: "cancelled" };
    const cancelledResult = mergeV2QueueInput(queueState(), cancelled);
    expect(cancelledResult).toMatchObject({ accepted: false, errorCode: "QUEUE_PAUSE_INVALID" });
    expect(cancelledResult.state.cursor).toBe(0);

    const validCancelled = cloneObject(cancelled);
    const validCancelledPayload = validCancelled.payload as JsonObject;
    validCancelledPayload.paused = true;
    validCancelledPayload.pauseReason = "stopped";
    const validCancelledResult = mergeV2QueueInput(queueState(), validCancelled);
    expect(validCancelledResult.accepted).toBe(true);
    expect(validCancelledResult.state).toMatchObject({
      paused: true,
      pauseReason: "stopped",
      activeRunIds: []
    });

    const completed = cloneObject(S01_QUEUE_LIFECYCLE_EVENTS[0]);
    const completedPayload = completed.payload as JsonObject;
    completedPayload.transition = "dequeued";
    completedPayload.trigger = { runId: "run_completed", terminalStatus: "completed" };
    completedPayload.autoStartNext = true;
    const completedResult = mergeV2QueueInput(queueState(), completed);
    expect(completedResult).toMatchObject({ accepted: false, errorCode: "QUEUE_ORDER_INVALID" });
    expect(completedResult.state.cursor).toBe(0);

    const validCompleted = mergeV2QueueInput(queueState(), S01_COMPLETED_QUEUE_EVENTS[0]);
    expect(validCompleted.accepted).toBe(true);
    expect(validCompleted.state.activeRunIds).toEqual(["run_next_1"]);

    const manualPause = cloneObject(S01_QUEUE_EVENTS[0]);
    const manualPausePayload = manualPause.payload as JsonObject;
    manualPausePayload.transition = "paused";
    manualPausePayload.paused = true;
    manualPausePayload.pauseReason = "manual";
    const manualPauseResult = mergeV2QueueInput(queueState(), manualPause);
    expect(manualPauseResult.accepted).toBe(true);
    expect(manualPauseResult.state).toMatchObject({
      paused: true,
      pauseReason: "manual",
      activeRunIds: ["run_active_1"]
    });
  });

  it("replays queue snapshots and live increments to the same read model", () => {
    const replayed = mergeV2QueueInputs(queueState(), S01_QUEUE_LIFECYCLE_EVENTS);
    const projected = projectV2Snapshot({
      runId: "run_unused",
      threadId: scope.threadId,
      scope,
      runEvents: [],
      queueEvents: S01_QUEUE_LIFECYCLE_EVENTS
    });

    expect(replayed.rejected).toEqual([]);
    expect(projected.rejectedQueueInputs).toEqual([]);
    expect(projected.queue).toEqual(replayed.state);
  });

  it("keeps S01 fixtures explicit and unavailable to production by contract", () => {
    expect(S01_EVENT_FIXTURE_METADATA).toEqual({
      schemaVersion: "2.0",
      source: "fixture",
      mode: "mock",
      port: 3110,
      productionEligible: false
    });
    expect(JSON.stringify({
      direct: S01_DIRECT_RUN_EVENTS,
      complex: S01_COMPLEX_RUN_EVENTS,
      queue: S01_QUEUE_EVENTS
    })).not.toMatch(/reasoning_content|rawReasoning|rawCoT|chainOfThought/);
  });
});
