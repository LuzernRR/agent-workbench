import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaimedLiveRun } from "@/server/live/store";

const searchAgent = vi.hoisted(() => ({
  streamSearchAgentRun: vi.fn()
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

import { SearchAgentRequestError } from "@/server/search-agent/client";
import { runClaimedLiveRun, SEARCH_AGENT_RECONNECT_DELAYS_MS } from "./executor";

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

function claim(patch: Partial<ClaimedLiveRun> = {}): ClaimedLiveRun {
  return {
    run: {
      id: "run_one",
      visitorId: "visitor_one",
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
    searchAgent.streamSearchAgentRun.mockReset();
  });

  it("只通过 fencing 写入映射事件并原子结算最终回答", async () => {
    searchAgent.streamSearchAgentRun.mockImplementation(async function* () {
      yield { ...sourceEnvelope, type: "node.completed", node: "plan_research", nodeRunId: "plan_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", agent: "planner", iteration: 0, durationMs: 20, publicSummary: "检索官方来源", publicSummarySource: "model" };
      yield completedEvent;
    });

    await expect(runClaimedLiveRun(claim(), options())).resolves.toBe("completed");
    expect(searchAgent.streamSearchAgentRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run_one",
      resume: false,
      question: "最新 LangGraph 是什么？"
    }), expect.any(AbortSignal));
    expect(store.persistClaimedLiveEvent.mock.calls.map((call) => call[1])).toEqual(expect.arrayContaining([
      "run.started",
      "thinking.started",
      "thinking.delta",
      "thinking.completed"
    ]));
    expect(store.finalizeClaimedLiveRun).toHaveBeenCalledWith(
      expect.objectContaining({ lease: { owner: "worker_one", epoch: 1 } }),
      "completed",
      expect.objectContaining({ verificationPassed: true }),
      expect.anything()
    );
  });

  it("正文已流式写入时终态只补 citations，不重复正文 delta", async () => {
    searchAgent.streamSearchAgentRun.mockImplementation(async function* () {
      yield { ...sourceEnvelope, type: "answer.started", composeRound: 0 };
      yield { ...sourceEnvelope, type: "answer.delta", composeRound: 0, delta: "基于来源的回答" };
      yield { ...sourceEnvelope, type: "answer.completed", composeRound: 0 };
      yield completedEvent;
    });

    await runClaimedLiveRun(claim(), options());
    const completion = store.finalizeClaimedLiveRun.mock.calls.at(-1)?.[3] as {
      events: Array<{ type: string; payload: Record<string, unknown> }>;
    };
    expect(completion.events).toEqual([{
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
      if (attempt === 1) throw new SearchAgentRequestError("事件流中断", "SEARCH_AGENT_STREAM_ENDED");
      yield completedEvent;
    });

    const running = runClaimedLiveRun(claim(), options());
    await vi.advanceTimersByTimeAsync(SEARCH_AGENT_RECONNECT_DELAYS_MS[0]);
    await expect(running).resolves.toBe("completed");
    expect(searchAgent.streamSearchAgentRun).toHaveBeenCalledTimes(2);
    expect(searchAgent.streamSearchAgentRun.mock.calls[1][0]).toMatchObject({ runId: "run_one", resume: true });
    vi.useRealTimers();
  });

  it("接管时 epoch 递增且不重复 run.started", async () => {
    searchAgent.streamSearchAgentRun.mockImplementation(async function* () { yield completedEvent; });
    const resumed = claim({
      lease: { owner: "worker_two", epoch: 2 },
      resume: true,
      attempt: 2,
      input: { ...claim().input, resume: true }
    });

    await expect(runClaimedLiveRun(resumed, options())).resolves.toBe("completed");
    expect(searchAgent.streamSearchAgentRun.mock.calls[0][0]).toMatchObject({ runId: "run_one", resume: true });
    expect(store.persistClaimedLiveEvent.mock.calls.some((call) => call[1] === "run.started")).toBe(false);
    expect(store.persistClaimedLiveEvent).toHaveBeenCalledWith(resumed, "run.status", expect.objectContaining({
      recovered: true,
      leaseEpoch: 2,
      workerAttempt: 2
    }));
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
