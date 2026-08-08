import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaimedCheckpointBatch } from "@/server/live/checkpoint-batches";
import type { ClaimedLiveRun, LiveCheckpointReference } from "@/server/live/store";

const searchAgent = vi.hoisted(() => ({
  streamSearchAgentRun: vi.fn()
}));

const checkpointBatches = vi.hoisted(() => ({
  commitClaimedCheckpointBatch: vi.fn()
}));

const store = vi.hoisted(() => {
  let seq = 0;
  return {
    persistClaimedLiveEvent: vi.fn(async (claim: ClaimedLiveRun, type: string, payload: Record<string, unknown>) => ({
      id: `event_${++seq}`,
      seq,
      projectId: claim.run.projectId,
      threadId: claim.run.threadId,
      runId: claim.run.id,
      createdAt: "2026-08-05T00:00:00Z",
      type,
      payload
    })),
    finalizeClaimedLiveRun: vi.fn(async (
      _claim: ClaimedLiveRun,
      _status: string,
      _payload: Record<string, unknown>,
      _completion?: unknown
    ) => [{ type: "run.completed" }]),
    renewLiveRunLease: vi.fn(async () => true),
    releaseLiveRunLease: vi.fn(async () => true),
    readClaimedLiveCheckpoint: vi.fn(async (): Promise<{
      valid: boolean;
      checkpoint: LiveCheckpointReference | null;
    }> => ({ valid: true, checkpoint: null })),
    liveId: vi.fn((prefix: string) => `${prefix}_generated`),
    reset: () => { seq = 0; }
  };
});

vi.mock("@/server/config/runtime-config", () => ({
  loadRuntimeConfig: vi.fn(async () => ({
    provider: {
      models: [{ id: "deepseek-v4-flash", capabilities: { imageInput: false } }]
    }
  }))
}));
vi.mock("@/server/search-agent/client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/search-agent/client")>(),
  streamSearchAgentRun: searchAgent.streamSearchAgentRun
}));
vi.mock("@/server/live/store", () => store);
vi.mock("@/server/live/checkpoint-batches", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/live/checkpoint-batches")>(),
  commitClaimedCheckpointBatch: checkpointBatches.commitClaimedCheckpointBatch
}));

import { SearchAgentRequestError } from "@/server/search-agent/client";
import {
  MAX_CHECKPOINT_SOURCE_BYTES,
  MAX_CHECKPOINT_SOURCE_EVENTS,
  runClaimedLiveRun,
  SEARCH_AGENT_RECONNECT_DELAYS_MS
} from "./executor";

const sourceEnvelope = {
  version: 1,
  eventId: "stream_test_000001",
  streamId: "stream_test",
  streamSeq: 1,
  seq: 1,
  createdAt: "2026-08-05T00:00:00Z"
} as const;

const completedEvent = {
  ...sourceEnvelope,
  type: "run.completed",
  answerMarkdown: "基于来源的回答",
  answerSource: "model",
  answerModelCalls: 1,
  promptVersion: "2026-07-28.v2",
  responseStatus: "completed",
  citations: [{ label: "官方来源", url: "https://example.com/source" }],
  verificationPassed: true,
  stopReason: "VERIFIED",
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, cost_usd: 0.001 },
  modelCalls: 3,
  toolCalls: 1,
  evidenceCount: 1
} as const;

function boundary(
  checkpointId = "checkpoint_one",
  parentCheckpointId: string | null = null,
  streamSeq = 2
) {
  return {
    ...sourceEnvelope,
    eventId: `stream_test_${String(streamSeq).padStart(6, "0")}`,
    streamSeq,
    seq: streamSeq,
    type: "checkpoint.committed" as const,
    checkpointId,
    parentCheckpointId,
    checkpointNs: "",
    checkpointSessionId: "checkpoint_session_generated",
    step: parentCheckpointId ? 1 : -1
  };
}

const authoritativeCheckpoint = {
  id: "checkpoint_one",
  namespace: "",
  sessionId: "checkpoint_session_one",
  step: 1
};

function claim(patch: Partial<ClaimedLiveRun> = {}): ClaimedLiveRun {
  return {
    run: {
      id: "run_one",
      visitorId: "visitor_one",
      tenantId: "tenant_one",
      threadId: "thread_one",
      projectId: "project_one",
      modelId: "deepseek-v4-flash",
      agentId: "search-agent"
    },
    lease: { owner: "worker_one", epoch: 1 },
    input: {
      message: "最新 LangGraph 是什么？",
      history: [],
      attachmentContext: "",
      imageInputs: [],
      projectMemoryContext: "",
      reasoningEffort: "high",
      resume: false
    },
    resume: false,
    checkpoint: null,
    attempt: 1,
    leaseExpiresAt: "2026-08-05T00:01:00Z",
    ...patch
  };
}

function options(signal = new AbortController().signal, heartbeatMs = 10_000) {
  return { leaseMs: 30_000, heartbeatMs, signal };
}

describe("durable run Worker executor", () => {
  beforeEach(() => {
    store.reset();
    store.persistClaimedLiveEvent.mockClear();
    store.finalizeClaimedLiveRun.mockReset().mockResolvedValue([{ type: "run.completed" }]);
    store.renewLiveRunLease.mockReset().mockResolvedValue(true);
    store.releaseLiveRunLease.mockReset().mockResolvedValue(true);
    store.readClaimedLiveCheckpoint.mockReset().mockResolvedValue({ valid: true, checkpoint: null });
    store.liveId.mockClear();
    checkpointBatches.commitClaimedCheckpointBatch.mockReset().mockImplementation(async (_claim, batch) => ({
      status: "committed",
      revision: 1,
      checkpoint: {
        id: batch.boundary.checkpointId,
        parentId: batch.boundary.parentCheckpointId,
        namespace: batch.boundary.checkpointNs,
        sessionId: batch.boundary.checkpointSessionId,
        step: batch.boundary.step
      }
    }));
    searchAgent.streamSearchAgentRun.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("checkpoint 前只缓冲 source，并在一个 fenced batch 中结算最终回答", async () => {
    searchAgent.streamSearchAgentRun.mockImplementation(async function* () {
      yield { ...sourceEnvelope, type: "node.completed", node: "plan_research", nodeRunId: "plan_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", agent: "planner", iteration: 0, durationMs: 20, publicSummary: "检索官方来源", publicSummarySource: "model" };
      yield { ...completedEvent, eventId: "stream_test_000002", streamSeq: 2, seq: 2 };
      yield boundary("checkpoint_one", null, 3);
    });

    await expect(runClaimedLiveRun(claim(), options())).resolves.toBe("completed");
    expect(searchAgent.streamSearchAgentRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run_one",
      resume: false,
      checkpointSessionId: "checkpoint_session_generated",
      question: "最新 LangGraph 是什么？"
    }), expect.any(AbortSignal));
    expect(store.persistClaimedLiveEvent.mock.calls.map((call) => call[1])).toEqual(["run.started"]);
    expect(checkpointBatches.commitClaimedCheckpointBatch).toHaveBeenCalledWith(
      expect.objectContaining({ lease: { owner: "worker_one", epoch: 1 } }),
      expect.objectContaining({
        sourceEvents: [
          expect.objectContaining({ type: "node.completed" }),
          expect.objectContaining({ type: "run.completed" })
        ],
        events: expect.arrayContaining([
          expect.objectContaining({ type: "thinking.started" }),
          expect.objectContaining({ type: "run.completed" })
        ]),
        terminal: expect.objectContaining({ status: "completed" })
      })
    );
    expect(store.finalizeClaimedLiveRun).not.toHaveBeenCalled();
  });

  it("正文已流式写入时终态只补 citations，不重复正文 delta", async () => {
    searchAgent.streamSearchAgentRun.mockImplementation(async function* () {
      yield { ...sourceEnvelope, type: "answer.started", composeRound: 0 };
      yield { ...sourceEnvelope, eventId: "stream_test_000002", streamSeq: 2, seq: 2, type: "answer.delta", composeRound: 0, delta: "基于来源的回答" };
      yield { ...sourceEnvelope, eventId: "stream_test_000003", streamSeq: 3, seq: 3, type: "answer.completed", composeRound: 0 };
      yield { ...completedEvent, eventId: "stream_test_000004", streamSeq: 4, seq: 4 };
      yield boundary("checkpoint_one", null, 5);
    });

    await runClaimedLiveRun(claim(), options());
    const committed = checkpointBatches.commitClaimedCheckpointBatch.mock.calls.at(-1)?.[1] as {
      events: Array<{ type: string; payload: Record<string, unknown> }>;
    };
    expect(committed.events.filter((event) => event.type === "message.completed")).toEqual([{
      type: "message.completed",
      payload: {
        messageId: "msg_runone_assistant",
        text: "基于来源的回答",
        citations: [{ label: "官方来源", url: "https://example.com/source" }]
      }
    }]);
  });

  it("流中断后以同一 runId 有界重连并启用 checkpoint resume", async () => {
    vi.useFakeTimers();
    let attempt = 0;
    searchAgent.streamSearchAgentRun.mockImplementation(async function* () {
      attempt += 1;
      if (attempt === 1) {
        yield boundary();
        throw new SearchAgentRequestError("事件流中断", "SEARCH_AGENT_STREAM_ENDED");
      }
      yield { ...completedEvent, streamId: "stream_retry", eventId: "stream_retry_000001" };
      yield {
        ...boundary("checkpoint_two", "checkpoint_one", 2),
        streamId: "stream_retry",
        eventId: "stream_retry_000002",
        checkpointSessionId: "checkpoint_session_one"
      };
    });
    store.readClaimedLiveCheckpoint
      .mockResolvedValueOnce({ valid: true, checkpoint: null })
      .mockResolvedValueOnce({ valid: true, checkpoint: authoritativeCheckpoint });

    const running = runClaimedLiveRun(claim(), options());
    await vi.advanceTimersByTimeAsync(SEARCH_AGENT_RECONNECT_DELAYS_MS[0]);
    await expect(running).resolves.toBe("completed");
    expect(searchAgent.streamSearchAgentRun).toHaveBeenCalledTimes(2);
    expect(store.readClaimedLiveCheckpoint).toHaveBeenCalledTimes(2);
    expect(searchAgent.streamSearchAgentRun.mock.calls[1][0]).toMatchObject({
      runId: "run_one",
      resume: true,
      checkpointId: "checkpoint_one",
      checkpointNs: "",
      checkpointSessionId: "checkpoint_session_one"
    });
  });

  it("Python 已产生孤立 checkpoint 但 Node 未确认时，新尝试不恢复该 session", async () => {
    vi.useFakeTimers();
    let attempt = 0;
    store.liveId
      .mockReturnValueOnce("checkpoint_session_orphan")
      .mockReturnValueOnce("checkpoint_session_retry");
    searchAgent.streamSearchAgentRun.mockImplementation(async function* () {
      attempt += 1;
      if (attempt === 1) {
        yield {
          ...sourceEnvelope,
          type: "node.completed",
          node: "plan_research",
          nodeRunId: "node_orphan",
          agent: "planner",
          iteration: 0,
          durationMs: 5,
          publicSummary: "孤立 checkpoint 前事件",
          publicSummarySource: "model"
        } as const;
        throw new SearchAgentRequestError("Node 尚未确认 checkpoint", "SEARCH_AGENT_STREAM_ENDED");
      }
      yield { ...completedEvent, streamId: "stream_retry", eventId: "stream_retry_000001" };
      yield {
        ...boundary("checkpoint_retry", null, 2),
        streamId: "stream_retry",
        eventId: "stream_retry_000002",
        checkpointSessionId: "checkpoint_session_retry"
      };
    });
    store.readClaimedLiveCheckpoint.mockResolvedValue({ valid: true, checkpoint: null });

    const running = runClaimedLiveRun(claim(), options());
    await vi.advanceTimersByTimeAsync(SEARCH_AGENT_RECONNECT_DELAYS_MS[0]);
    await expect(running).resolves.toBe("completed");

    expect(searchAgent.streamSearchAgentRun).toHaveBeenCalledTimes(2);
    expect(searchAgent.streamSearchAgentRun.mock.calls[0][0]).toMatchObject({
      resume: false,
      checkpointSessionId: "checkpoint_session_orphan"
    });
    expect(searchAgent.streamSearchAgentRun.mock.calls[1][0]).toMatchObject({
      resume: false,
      checkpointSessionId: "checkpoint_session_retry"
    });
    expect(searchAgent.streamSearchAgentRun.mock.calls[1][0].checkpointId).toBeUndefined();
    const committed = checkpointBatches.commitClaimedCheckpointBatch.mock.calls.at(-1)?.[1] as ClaimedCheckpointBatch;
    expect(committed.sourceEvents.map((event) => event.type)).toEqual(["run.completed"]);
    expect(committed.sourceEvents.some((event) => event.eventId === sourceEnvelope.eventId)).toBe(false);
  });

  it("接管时 epoch 递增且不重复 run.started", async () => {
    searchAgent.streamSearchAgentRun.mockImplementation(async function* () {
      yield completedEvent;
      yield { ...boundary("checkpoint_two", "checkpoint_one"), checkpointSessionId: "checkpoint_session_one" };
    });
    const resumed = claim({
      lease: { owner: "worker_two", epoch: 2 },
      resume: true,
      checkpoint: authoritativeCheckpoint,
      attempt: 2,
      input: { ...claim().input, resume: true }
    });
    store.readClaimedLiveCheckpoint.mockResolvedValue({ valid: true, checkpoint: authoritativeCheckpoint });

    await expect(runClaimedLiveRun(resumed, options())).resolves.toBe("completed");
    expect(searchAgent.streamSearchAgentRun.mock.calls[0][0]).toMatchObject({
      runId: "run_one",
      resume: true,
      checkpointId: "checkpoint_one",
      checkpointNs: "",
      checkpointSessionId: "checkpoint_session_one"
    });
    expect(store.persistClaimedLiveEvent.mock.calls.some((call) => call[1] === "run.started")).toBe(false);
    expect(store.persistClaimedLiveEvent).toHaveBeenCalledWith(resumed, "run.status", expect.objectContaining({
      recovered: true,
      leaseEpoch: 2,
      workerAttempt: 2
    }));
  });

  it("checkpoint 事务失败时不写终态并交还租约供下一 Worker 恢复", async () => {
    searchAgent.streamSearchAgentRun.mockImplementation(async function* () {
      yield completedEvent;
      yield boundary();
    });
    checkpointBatches.commitClaimedCheckpointBatch.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(runClaimedLiveRun(claim(), options())).resolves.toBe("released");
    expect(store.finalizeClaimedLiveRun).not.toHaveBeenCalled();
    expect(store.releaseLiveRunLease).toHaveBeenCalled();
  });

  it("checkpoint 前 source event 数量超过上限时立即失败且不提交 batch", async () => {
    searchAgent.streamSearchAgentRun.mockImplementation(async function* () {
      for (let index = 1; index <= MAX_CHECKPOINT_SOURCE_EVENTS + 1; index += 1) {
        yield {
          ...sourceEnvelope,
          eventId: `stream_limit_${String(index).padStart(6, "0")}`,
          streamId: "stream_limit",
          streamSeq: index,
          seq: index,
          type: "node.started",
          node: "plan_research",
          nodeRunId: `node_${index}`,
          agent: "planner",
          iteration: 0
        };
      }
    });

    await expect(runClaimedLiveRun(claim(), options())).resolves.toBe("failed");
    expect(checkpointBatches.commitClaimedCheckpointBatch).not.toHaveBeenCalled();
    expect(store.finalizeClaimedLiveRun).toHaveBeenCalledWith(
      expect.anything(),
      "failed",
      expect.objectContaining({ reasonCode: "SEARCH_AGENT_CHECKPOINT_BUFFER_LIMIT" }),
      undefined
    );
  });

  it("checkpoint 前 source event 累计 UTF-8 bytes 超过上限时立即失败", async () => {
    const delta = "数".repeat(16_000);
    searchAgent.streamSearchAgentRun.mockImplementation(async function* () {
      for (let index = 1; index <= Math.ceil(MAX_CHECKPOINT_SOURCE_BYTES / 48_000) + 2; index += 1) {
        yield {
          ...sourceEnvelope,
          eventId: `stream_bytes_${String(index).padStart(6, "0")}`,
          streamId: "stream_bytes",
          streamSeq: index,
          seq: index,
          type: "answer.delta",
          composeRound: 0,
          delta
        };
      }
    });

    await expect(runClaimedLiveRun(claim(), options())).resolves.toBe("failed");
    expect(checkpointBatches.commitClaimedCheckpointBatch).not.toHaveBeenCalled();
    expect(store.finalizeClaimedLiveRun).toHaveBeenCalledWith(
      expect.anything(),
      "failed",
      expect.objectContaining({ reasonCode: "SEARCH_AGENT_CHECKPOINT_BUFFER_LIMIT" }),
      undefined
    );
  });

  it("heartbeat 失租后立即中断上游且不再 finalize 或 release", async () => {
    store.renewLiveRunLease.mockResolvedValue(false);
    searchAgent.streamSearchAgentRun.mockImplementation(async function* (_input, signal: AbortSignal) {
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });

    const result = runClaimedLiveRun(claim(), options(new AbortController().signal, 5));
    await expect(result).resolves.toBe("lease-lost");
    expect(store.renewLiveRunLease).toHaveBeenCalled();
    expect(store.finalizeClaimedLiveRun).not.toHaveBeenCalled();
    expect(store.releaseLiveRunLease).not.toHaveBeenCalled();
  });

  it("SIGTERM 等外部停止信号会取消上游并主动交还租约", async () => {
    const shutdown = new AbortController();
    searchAgent.streamSearchAgentRun.mockImplementation(async function* (_input, signal: AbortSignal) {
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });

    const result = runClaimedLiveRun(claim(), options(shutdown.signal));
    await vi.waitFor(() => expect(searchAgent.streamSearchAgentRun).toHaveBeenCalled());
    shutdown.abort(new DOMException("SIGTERM", "AbortError"));
    await expect(result).resolves.toBe("released");
    expect(store.releaseLiveRunLease).toHaveBeenCalledWith(expect.objectContaining({
      lease: { owner: "worker_one", epoch: 1 }
    }));
  });
});
