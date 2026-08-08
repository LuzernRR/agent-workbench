import { beforeEach, describe, expect, it, vi } from "vitest";

const runtimeConfig = vi.hoisted(() => ({
  loadRuntimeConfig: vi.fn(async () => ({
    provider: {
      defaultModel: "deepseek-v4-flash",
      models: [{
        id: "deepseek-v4-flash",
        reasoningEfforts: ["medium", "high"],
        defaultReasoningEffort: "medium"
      }]
    },
    retention: { projectMemoryRecallItems: 24, projectMemoryMaxChars: 16_000 }
  }))
}));

const store = vi.hoisted(() => ({
  createUserStoppedPayload: vi.fn(() => ({
    reasonCode: "USER_STOPPED",
    partial: true,
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, cost_usd: 0 }
  })),
  prepareLiveRun: vi.fn(),
  liveRun: vi.fn(),
  requestLiveRunStop: vi.fn(),
  finalizeLiveRun: vi.fn()
}));

const searchAgent = vi.hoisted(() => ({
  requestSearchAgentStop: vi.fn(async (): Promise<"requested" | "not_running" | "unsupported" | "unavailable"> => "requested")
}));

vi.mock("@/server/config/runtime-config", () => runtimeConfig);
vi.mock("./store", () => store);
vi.mock("@/server/search-agent/client", () => searchAgent);

import { startLiveRun, stopLiveRun } from "./engine";

const run = {
  id: "run_one",
  visitorId: "visitor_one",
  threadId: "thread_one",
  projectId: "project_one",
  modelId: "deepseek-v4-flash",
  agentId: "search-agent"
};

describe("live API queue boundary", () => {
  beforeEach(() => {
    store.prepareLiveRun.mockReset().mockResolvedValue({ run });
    store.liveRun.mockReset().mockResolvedValue({ run, status: "running" });
    store.requestLiveRunStop.mockReset().mockResolvedValue({ run, status: "running", hasActiveLease: true });
    store.finalizeLiveRun.mockReset().mockResolvedValue([{ type: "run.cancelled" }]);
    searchAgent.requestSearchAgentStop.mockReset().mockResolvedValue("requested");
  });

  it("创建运行时只持久入队并立即返回 runId", async () => {
    await expect(startLiveRun({
      visitorId: "visitor_one",
      tenantId: "tenant_one",
      threadId: "thread_one",
      message: "查询最新资料",
      modelId: "deepseek-v4-flash",
      reasoningEffort: "max",
      attachmentIds: []
    })).resolves.toEqual({ runId: "run_one" });

    expect(store.prepareLiveRun).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "search-agent",
      modelId: "deepseek-v4-flash",
      reasoningEffort: "medium"
    }));
  });

  it("用户停止先持久化请求，活动 Worker 异步收口且 API 返回 stopping", async () => {
    const order: string[] = [];
    store.requestLiveRunStop.mockImplementation(async () => {
      order.push("stop-requested");
      return { run, status: "running", hasActiveLease: true };
    });
    searchAgent.requestSearchAgentStop.mockImplementation(async () => {
      order.push("upstream-stop");
      return "requested";
    });

    await expect(stopLiveRun("visitor_one", "run_one")).resolves.toBe("stopping");
    expect(order).toEqual(["stop-requested", "upstream-stop"]);
    expect(store.finalizeLiveRun).not.toHaveBeenCalled();
  });

  it("未领取的运行直接用显式零用量终态兜底", async () => {
    store.requestLiveRunStop.mockResolvedValue({ run, status: "queued", hasActiveLease: false });

    await expect(stopLiveRun("visitor_one", "run_one")).resolves.toBe("stopped");
    expect(searchAgent.requestSearchAgentStop).not.toHaveBeenCalled();
    expect(store.finalizeLiveRun).toHaveBeenCalledWith(run, "stopped", {
      reasonCode: "USER_STOPPED",
      partial: true,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, cost_usd: 0 }
    });
  });

  it.each(["unavailable", "not_running", "unsupported"] as const)("活动租约的上游停止结果为 %s 时不抢占 Worker 终态", async (result) => {
    searchAgent.requestSearchAgentStop.mockResolvedValue(result);

    await expect(stopLiveRun("visitor_one", "run_one")).resolves.toBe("stopping");
    expect(store.finalizeLiveRun).not.toHaveBeenCalled();
  });

  it("终态已被 Worker 抢占时不覆盖结果", async () => {
    store.requestLiveRunStop.mockResolvedValue({ run, status: "completed", hasActiveLease: false });

    await expect(stopLiveRun("visitor_one", "run_one")).resolves.toBe("completed");
    expect(store.finalizeLiveRun).not.toHaveBeenCalled();
    expect(searchAgent.requestSearchAgentStop).not.toHaveBeenCalled();
  });

  it("本地兜底与 Worker 竞态时返回已提交终态", async () => {
    store.requestLiveRunStop.mockResolvedValue({ run, status: "running", hasActiveLease: false });
    store.finalizeLiveRun.mockResolvedValue(null);
    store.liveRun.mockResolvedValue({ run, status: "completed" });

    await expect(stopLiveRun("visitor_one", "run_one")).resolves.toBe("completed");
    expect(searchAgent.requestSearchAgentStop).not.toHaveBeenCalled();
  });
});
