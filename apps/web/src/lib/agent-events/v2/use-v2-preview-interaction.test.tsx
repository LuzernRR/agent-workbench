import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  createS01ProcessFixtureCatalog,
  projectS01ProcessFixture
} from "@/server/mock/s01-event-fixtures";
import { useV2PreviewInteraction } from "./use-v2-preview-interaction";
import type { V2AgentEvent } from "./types";

function renderScenario(
  scenario: Parameters<typeof createS01ProcessFixtureCatalog>[0]
) {
  const catalog = createS01ProcessFixtureCatalog(scenario);
  return renderHook(() => useV2PreviewInteraction(
    catalog,
    catalog.states[catalog.selectedScenario]
  ));
}

describe("useV2PreviewInteraction", () => {
  it("merges accepted guidance as pending without claiming it was applied", async () => {
    const hook = renderScenario("composer_active");
    let command;
    await act(async () => {
      command = await hook.result.current!.submitComposer(
        "steer",
        "把结论改成表格",
        []
      );
    });

    expect(command).toMatchObject({ status: "accepted_pending" });
    expect(Object.values(hook.result.current!.runState.guidanceCommands)).toEqual([
      expect.objectContaining({ status: "accepted_pending", commandSeq: 1 })
    ]);
    expect(hook.result.current!.feedback).toBe("已接收，等待应用");
  });

  it.each([
    ["guidance_revision_conflict", "COMMAND_REVISION_CONFLICT"],
    ["guidance_terminal_rejected", "COMMAND_AFTER_TERMINAL"]
  ] as const)("keeps %s rejection typed and non-retryable", async (scenario, errorCode) => {
    const hook = renderScenario(scenario);
    let command;
    await act(async () => {
      command = await hook.result.current!.submitComposer(
        "steer",
        "保留这段输入",
        []
      );
    });

    expect(command).toMatchObject({
      status: "rejected",
      errorCode,
      retryable: false,
      snapshot: { content: "保留这段输入", attachmentRefs: [] }
    });
  });

  it("retries a network failure with the same command identity and hash", async () => {
    const hook = renderScenario("guidance_failed");
    let first;
    await act(async () => {
      first = await hook.result.current!.submitComposer(
        "steer",
        "保持原请求重试",
        []
      );
    });
    expect(first).toMatchObject({
      status: "failed",
      errorCode: "NETWORK_ERROR",
      retryable: true
    });

    let retried;
    await act(async () => {
      retried = await hook.result.current!.retry(first!.commandId);
    });
    expect(retried).toMatchObject({
      commandId: first!.commandId,
      idempotencyKey: first!.idempotencyKey,
      contentHash: first!.contentHash,
      status: "failed",
      retryable: true
    });
    expect(hook.result.current!.controllerState.order).toEqual([
      first!.commandId
    ]);
  });

  it("routes a late guidance event through correlation and the run reducer", async () => {
    const hook = renderScenario("composer_active");
    let command;
    await act(async () => {
      command = await hook.result.current!.submitComposer(
        "steer",
        "把结论改成表格",
        []
      );
    });
    const before = hook.result.current!.runState;
    const guidance = before.guidanceCommands[command!.commandId];
    const now = "2026-07-27T08:30:00.000Z";
    const event: V2AgentEvent<"guidance.applied"> = {
      schemaVersion: "2.0",
      eventId: `late_${command!.commandId}`,
      runId: before.runId,
      scope: before.scope,
      seq: before.cursor + 1,
      occurredAt: now,
      type: "guidance.applied",
      kind: "guidance",
      status: "completed",
      startedAt: now,
      completedAt: now,
      inputRevision: before.latestInputRevision + 1,
      refs: {
        commandId: command!.commandId,
        checkpointRef: "checkpoint_late_1"
      },
      source: "fixture",
      payload: {
        batchId: "batch_late_1",
        commandId: command!.commandId,
        commandSeq: guidance.commandSeq,
        previousSteeringRevision: guidance.currentSteeringRevision!,
        newSteeringRevision: guidance.currentSteeringRevision! + 1,
        acceptedAtStateRevision: before.cursor - 1,
        appliedAtStateRevision: before.cursor,
        appliedAtNode: "compose_response",
        checkpointRef: "checkpoint_late_1",
        impact: "format_only",
        invalidatedPlanRefs: [],
        invalidatedDraftRefs: [],
        invalidatedVerificationRefs: [],
        invalidatedArtifactRefs: [],
        newPlanRef: null
      }
    };

    let ingested = false;
    act(() => {
      ingested = hook.result.current!.ingestEvidence(event);
    });

    expect(ingested).toBe(true);
    expect(hook.result.current!.controllerState.commands[command!.commandId].status).toBe(
      "applied"
    );
    expect(hook.result.current!.runState.guidanceCommands[command!.commandId].status).toBe(
      "applied"
    );
    expect(hook.result.current!.runState.cursor).toBe(event.seq);
  });

  it("rejects stale and duplicate clarification resumes without another command flow", async () => {
    const stale = renderScenario("clarification_waiting");
    const clarification = Object.entries(
      stale.result.current!.runState.clarifications
    )[0];
    expect(clarification).toBeDefined();
    const [clarificationId, waiting] = clarification;

    let staleResult;
    await act(async () => {
      staleResult = await stale.result.current!.resumeClarification({
        clarificationId,
        checkpointRef: waiting.checkpointRef,
        expectedStateRevision: waiting.stateRevision - 1,
        content: "最近一年",
        attachmentRefs: []
      });
    });
    expect(staleResult).toMatchObject({
      status: "rejected",
      errorCode: "CLARIFICATION_STALE_CHECKPOINT"
    });

    let applied;
    await act(async () => {
      applied = await stale.result.current!.resumeClarification({
        clarificationId,
        checkpointRef: waiting.checkpointRef,
        expectedStateRevision: waiting.stateRevision,
        content: "最近一年",
        attachmentRefs: []
      });
    });
    expect(applied).toMatchObject({ status: "applied" });
    expect(
      stale.result.current!.runState.clarifications[clarificationId].status
    ).toBe("resumed");

    let duplicate;
    await act(async () => {
      duplicate = await stale.result.current!.resumeClarification({
        clarificationId,
        checkpointRef: waiting.checkpointRef,
        expectedStateRevision: waiting.stateRevision,
        content: "最近一年",
        attachmentRefs: []
      });
    });
    expect(duplicate).toMatchObject({
      status: "rejected",
      errorCode: "CLARIFICATION_ALREADY_RESUMED"
    });
  });

  it("applies one approval decision and rejects a second decision", async () => {
    const hook = renderScenario("approval_waiting");
    const tool = Object.values(hook.result.current!.runState.toolCalls)
      .find((item) => item.approvalId);
    expect(tool?.approvalId).toBeTruthy();

    let allowed;
    await act(async () => {
      allowed = await hook.result.current!.decideApproval({
        approvalId: tool!.approvalId!,
        toolCallId: tool!.toolCallId,
        decision: "allow_once"
      });
    });
    expect(allowed).toMatchObject({ status: "applied" });
    expect(
      hook.result.current!.runState.toolCalls[tool!.toolCallId].approvalDecision
    ).toBe("allow_once");

    let duplicate;
    await act(async () => {
      duplicate = await hook.result.current!.decideApproval({
        approvalId: tool!.approvalId!,
        toolCallId: tool!.toolCallId,
        decision: "deny"
      });
    });
    expect(duplicate).toMatchObject({
      status: "rejected",
      errorCode: "APPROVAL_ALREADY_DECIDED"
    });
  });

  // 阻断项 6：停止前先收口未终态工具，再发 run.cancelled，不留悬空工具。
  it("closes a waiting-approval tool before cancelling the run", async () => {
    const hook = renderScenario("approval_waiting");
    const tool = Object.values(hook.result.current!.runState.toolCalls)
      .find((item) => item.status === "waiting_approval");
    expect(tool?.approvalId).toBeTruthy();

    let stopped;
    await act(async () => {
      stopped = await hook.result.current!.stop();
    });
    expect(stopped).toBe(true);

    const finalState = hook.result.current!.runState;
    expect(finalState.terminal).toBe("cancelled");
    // 原本 waiting_approval 的工具必须已被收口成 failed，且先经过 deny。
    const closed = finalState.toolCalls[tool!.toolCallId];
    expect(closed.status).toBe("failed");
    expect(closed.approvalDecision).toBe("deny");
    // 没有任何工具停留在 running / waiting_approval。
    expect(
      Object.values(finalState.toolCalls).some(
        (item) => item.status === "running" || item.status === "waiting_approval"
      )
    ).toBe(false);
  });

  it("cancels directly when a running tool has no pending approval", async () => {
    const hook = renderScenario("tool_progress");
    const running = Object.values(hook.result.current!.runState.toolCalls)
      .filter((item) => item.status === "running");
    expect(running.length).toBeGreaterThan(0);

    let stopped;
    await act(async () => {
      stopped = await hook.result.current!.stop();
    });
    expect(stopped).toBe(true);

    const finalState = hook.result.current!.runState;
    expect(finalState.terminal).toBe("cancelled");
    expect(
      Object.values(finalState.toolCalls).every(
        (item) => item.status === "failed"
          || item.status === "completed"
          || item.status === "unknown"
      )
    ).toBe(true);
  });

  it("closes every open tool before cancelling a multi-tool run", async () => {
    const catalog = createS01ProcessFixtureCatalog("tool_progress");
    const base = projectS01ProcessFixture("tool_progress");
    const firstId = base.toolOrder.find(
      (id) => base.toolCalls[id]?.status === "running"
    )!;
    const first = base.toolCalls[firstId];
    const secondId = "call_second_running";
    const selected = {
      ...base,
      toolCalls: {
        ...base.toolCalls,
        [secondId]: {
          ...first,
          toolCallId: secondId,
          toolId: "page_fetch",
          registryTitle: "第二个运行中工具"
        }
      },
      toolOrder: [...base.toolOrder, secondId]
    };
    const hook = renderHook(() => useV2PreviewInteraction(catalog, selected));

    await act(async () => {
      expect(await hook.result.current!.stop()).toBe(true);
    });

    const finalState = hook.result.current!.runState;
    expect(finalState.terminal).toBe("cancelled");
    expect(finalState.toolCalls[firstId].status).toBe("failed");
    expect(finalState.toolCalls[secondId].status).toBe("failed");
    expect(finalState.cursor).toBe(base.cursor + 3);
  });

  it("cancels a clarification wait once and makes repeated stop idempotent", async () => {
    const hook = renderScenario("clarification_waiting");
    expect(Object.values(hook.result.current!.runState.clarifications)).toEqual([
      expect.objectContaining({ status: "waiting" })
    ]);

    await act(async () => {
      expect(await hook.result.current!.stop()).toBe(true);
    });
    const cursorAfterFirstStop = hook.result.current!.runState.cursor;
    expect(hook.result.current!.runState.terminal).toBe("cancelled");

    await act(async () => {
      expect(await hook.result.current!.stop()).toBe(true);
    });
    expect(hook.result.current!.runState.cursor).toBe(cursorAfterFirstStop);
    expect(hook.result.current!.runState.terminal).toBe("cancelled");
  });

  it("shares one in-flight stop operation across concurrent callers", async () => {
    const hook = renderScenario("tool_progress");
    const beforeCursor = hook.result.current!.runState.cursor;
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;

    await act(async () => {
      first = hook.result.current!.stop();
      second = hook.result.current!.stop();
      expect(second).toBe(first);
      expect(await Promise.all([first, second])).toEqual([true, true]);
    });

    expect(hook.result.current!.runState.terminal).toBe("cancelled");
    expect(hook.result.current!.runState.cursor).toBe(beforeCursor + 2);
  });
});
