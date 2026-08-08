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
  prepareLiveRun: vi.fn(),
  liveRun: vi.fn(),
  finalizeLiveRun: vi.fn()
}));

const searchAgent = vi.hoisted(() => ({
  requestSearchAgentStop: vi.fn(async () => "requested" as const)
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

  it("用户停止先抢占持久终态并清除租约，再通知 Search Agent", async () => {
    const order: string[] = [];
    store.finalizeLiveRun.mockImplementation(async () => {
      order.push("durable-stop");
      return [{ type: "run.cancelled" }];
    });
    searchAgent.requestSearchAgentStop.mockImplementation(async () => {
      order.push("upstream-stop");
      return "requested";
    });

    await expect(stopLiveRun("visitor_one", "run_one")).resolves.toBe("stopped");
    expect(order).toEqual(["durable-stop", "upstream-stop"]);
    expect(store.finalizeLiveRun).toHaveBeenCalledWith(run, "stopped", {});
  });

  it("终态已被 Worker 抢占时不覆盖结果", async () => {
    store.finalizeLiveRun.mockResolvedValue(null);
    store.liveRun
      .mockResolvedValueOnce({ run, status: "running" })
      .mockResolvedValueOnce({ run, status: "completed" });

    await expect(stopLiveRun("visitor_one", "run_one")).resolves.toBe("completed");
    expect(searchAgent.requestSearchAgentStop).not.toHaveBeenCalled();
  });
});
