import { describe, expect, it, vi } from "vitest";
import type { ClaimedLiveRun } from "@/server/live/store";
import { runWorkerLoop, type RunWorkerOptions, type WorkerLoopDependencies } from "./loop";

const workerOptions: RunWorkerOptions = {
  owner: "worker-test",
  leaseMs: 30_000,
  heartbeatMs: 10_000,
  pollMs: 50,
  cleanupIntervalMs: 60_000,
  threadTtlDays: 3
};

const claim: ClaimedLiveRun = {
  run: {
    id: "run-one",
    visitorId: "visitor-one",
    threadId: "thread-one",
    projectId: null,
    modelId: "deepseek-v4-flash",
    agentId: "search-agent"
  },
  lease: { owner: "worker-test", epoch: 1 },
  input: {
    message: "测试",
    history: [],
    attachmentContext: "",
    projectMemoryContext: "",
    reasoningEffort: "medium"
  },
  resume: false,
  checkpoint: null,
  attempt: 1,
  leaseExpiresAt: "2026-08-05T00:01:00Z"
};

describe("Worker polling loop", () => {
  it("收到停止信号后等待当前任务释放且不再 claim 新任务", async () => {
    const shutdown = new AbortController();
    const dependencies: WorkerLoopDependencies = {
      claim: vi.fn(async () => claim),
      execute: vi.fn(async (_claim, options) => {
        shutdown.abort(new DOMException("SIGTERM", "AbortError"));
        expect(options.signal.aborted).toBe(true);
        return "released" as const;
      }),
      cleanup: vi.fn(async () => 0),
      wait: vi.fn(async () => undefined)
    };

    await runWorkerLoop(workerOptions, shutdown.signal, vi.fn(), dependencies);

    expect(dependencies.claim).toHaveBeenCalledTimes(1);
    expect(dependencies.execute).toHaveBeenCalledTimes(1);
  });

  it("空队列轮询可被停止信号立即唤醒", async () => {
    const shutdown = new AbortController();
    const dependencies: WorkerLoopDependencies = {
      claim: vi.fn(async () => null),
      execute: vi.fn(),
      cleanup: vi.fn(async () => 0),
      wait: vi.fn(async (_milliseconds, signal) => {
        shutdown.abort(new DOMException("SIGINT", "AbortError"));
        expect(signal.aborted).toBe(true);
      })
    };

    await runWorkerLoop(workerOptions, shutdown.signal, vi.fn(), dependencies);

    expect(dependencies.claim).toHaveBeenCalledTimes(1);
    expect(dependencies.execute).not.toHaveBeenCalled();
  });
});
