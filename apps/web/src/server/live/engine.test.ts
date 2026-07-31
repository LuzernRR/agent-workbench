import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PreparedImageInput } from "@/server/media/image-input";

const searchAgent = vi.hoisted(() => ({
  streamSearchAgentRun: vi.fn(),
  requestSearchAgentStop: vi.fn(async () => "requested" as const)
}));

const runtimeConfig = vi.hoisted(() => ({
  loadRuntimeConfig: vi.fn(async () => ({
    provider: {
      defaultModel: "deepseek-v4-flash",
      models: [{ id: "deepseek-v4-flash", name: "Flash", reasoningEfforts: ["medium", "high"], defaultReasoningEffort: "medium" }]
    },
    retention: { cleanupIntervalMinutes: 60, threadTtlDays: 3, projectMemoryRecallItems: 24, projectMemoryMaxChars: 16_000 }
  }))
}));

const store = vi.hoisted(() => {
  let seq = 0;
  return {
    deleteExpiredLiveThreads: vi.fn(async () => 0),
    recoverInterruptedLiveRuns: vi.fn(async () => ({ failed: 0, resumable: [] as Array<Record<string, unknown>> })),
    prepareLiveRun: vi.fn(async () => ({
      run: { id: "run_one", visitorId: "visitor_one", threadId: "thread_one", projectId: "project_one", modelId: "deepseek-v4-flash", agentId: "search-agent" },
      history: [],
      attachmentContext: "",
      imageInputs: [] as PreparedImageInput[],
      projectMemoryContext: "",
      userMessageId: "user_one"
    })),
    persistLiveEvent: vi.fn(async (run: { id: string; threadId: string; projectId: string | null }, type: string, payload: Record<string, unknown>) => ({ id: `event_${++seq}`, seq, projectId: run.projectId, threadId: run.threadId, runId: run.id, createdAt: "2026-07-28T00:00:00Z", type, payload })),
    finalizeLiveRun: vi.fn(async (run: { id: string; threadId: string; projectId: string | null }, status: string, payload: Record<string, unknown>, _completion?: unknown) => [{ id: `event_${++seq}`, seq, projectId: run.projectId, threadId: run.threadId, runId: run.id, createdAt: "2026-07-28T00:00:00Z", type: status === "completed" ? "run.completed" : status === "stopped" ? "run.cancelled" : "run.failed", payload }]),
    liveRun: vi.fn(async () => ({ run: { id: "run_one", visitorId: "visitor_one", threadId: "thread_one", projectId: "project_one", modelId: "deepseek-v4-flash", agentId: "search-agent" }, status: "running" })),
    resetSequence: () => { seq = 0; }
  };
});

vi.mock("@/server/config/runtime-config", () => runtimeConfig);
vi.mock("@/server/search-agent/client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/search-agent/client")>(),
  streamSearchAgentRun: searchAgent.streamSearchAgentRun,
  requestSearchAgentStop: searchAgent.requestSearchAgentStop
}));
vi.mock("./store", () => store);

import { SearchAgentRequestError } from "@/server/search-agent/client";

const sourceEnvelope = { version: 1, eventId: "stream_test_000001", streamId: "stream_test", streamSeq: 1, seq: 1, createdAt: "2026-07-28T00:00:00Z" } as const;
const completedEvent = {
  ...sourceEnvelope,
  version: 1,
  type: "run.completed",
  answerMarkdown: "基于来源的回答",
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

async function freshEngine() {
  vi.resetModules();
  const globals = globalThis as typeof globalThis & Record<string, unknown>;
  delete globals.__workbenchLiveRuns;
  delete globals.__workbenchRecovery;
  delete globals.__workbenchCleanup;
  delete globals.__workbenchLastCleanupAt;
  return import("./engine");
}

describe("live Search Agent engine", () => {
  beforeEach(() => {
    store.resetSequence();
    store.deleteExpiredLiveThreads.mockClear();
    store.recoverInterruptedLiveRuns.mockReset().mockResolvedValue({ failed: 0, resumable: [] });
    store.prepareLiveRun.mockClear();
    store.persistLiveEvent.mockClear();
    store.finalizeLiveRun.mockClear();
    store.liveRun.mockReset().mockResolvedValue({ run: { id: "run_one", visitorId: "visitor_one", threadId: "thread_one", projectId: "project_one", modelId: "deepseek-v4-flash", agentId: "search-agent" }, status: "running" });
    searchAgent.streamSearchAgentRun.mockReset();
    searchAgent.requestSearchAgentStop.mockReset().mockResolvedValue("requested");
  });

  it("把真实 Agent 流白名单映射、持久化并原子结算最终回答", async () => {
    searchAgent.streamSearchAgentRun.mockImplementation(async function* () {
      yield { ...sourceEnvelope, type: "node.started", node: "plan_research", nodeRunId: "plan_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", agent: "planner", iteration: 0 };
      yield { ...sourceEnvelope, type: "node.completed", node: "plan_research", nodeRunId: "plan_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", agent: "planner", iteration: 0, durationMs: 20, publicSummary: "将检索官方来源并核对最新信息" };
      yield { ...sourceEnvelope, type: "tool.started", toolCallId: "call_one", toolName: "web_search", query: "最新 LangGraph", cached: false };
      yield { ...sourceEnvelope, type: "tool.completed", toolCallId: "call_one", toolName: "web_search", query: "最新 LangGraph", channel: "web", provider: "tavily", summary: "找到 1 条结果", resultCount: 1, evidenceCount: 1, results: [{ channel: "web", provider: "tavily", query: "最新 LangGraph", title: "官方来源", url: "https://example.com/source", snippet: "不得持久化", verified: true, author: null, published_at: null, metrics: {}, limitation: null, provenance: { discovery_provider: "tavily", detail_provider: "trafilatura", source_kind: "public_page", observed_at: "2026-07-28T00:00:00Z", confidence: "high" } }], cached: false };
      yield completedEvent;
    });
    const engine = await freshEngine();
    await engine.startLiveRun({ visitorId: "visitor_one", threadId: "thread_one", message: "最新 LangGraph 是什么？", modelId: "deepseek-v4-flash", reasoningEffort: "high", attachmentIds: [] });
    await vi.waitFor(() => expect(store.finalizeLiveRun).toHaveBeenCalledWith(expect.objectContaining({ agentId: "search-agent" }), "completed", expect.objectContaining({ promptVersion: "2026-07-28.v2", verificationPassed: true, partial: false, sourceEventId: "stream_test_000001" }), expect.anything()));

    expect(searchAgent.streamSearchAgentRun).toHaveBeenCalledWith(expect.objectContaining({ runId: "run_one", visitorId: "visitor_one", question: "最新 LangGraph 是什么？", resume: false }), expect.any(AbortSignal));
    expect(store.persistLiveEvent.mock.calls.map((call) => call[1])).toEqual(expect.arrayContaining(["run.started", "thinking.started", "thinking.delta", "tool.started", "tool.completed"]));
    const thinkingPayloads = store.persistLiveEvent.mock.calls.filter((call) => String(call[1]).startsWith("thinking.")).map((call) => call[2]);
    expect(thinkingPayloads.every((payload) => payload.thinkingId === "thinking:run_one:plan_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(true);
    expect(thinkingPayloads[0]).toEqual(expect.objectContaining({ activityKind: "thinking" }));
    expect(thinkingPayloads.find((payload) => payload.delta)?.delta).toBe("将检索官方来源并核对最新信息");
    expect(JSON.stringify(thinkingPayloads)).not.toMatch(/正在|【/u);
    expect(JSON.stringify(store.persistLiveEvent.mock.calls)).not.toContain("不得持久化");
    const completion = store.finalizeLiveRun.mock.calls.at(-1)?.[3] as { events: Array<{ type: string; payload: Record<string, unknown> }> };
    expect(completion.events).toEqual([
      expect.objectContaining({ type: "message.started", payload: expect.objectContaining({ agentId: "search-agent" }) }),
      expect.objectContaining({ type: "message.delta", payload: expect.objectContaining({ delta: "基于来源的回答" }) }),
      expect.objectContaining({ type: "message.completed", payload: expect.objectContaining({ text: "基于来源的回答", citations: [{ label: "官方来源", url: "https://example.com/source" }] }) })
    ]);
  });

  it("图片模型未启用时只发送安全引用，并明确不把图片当作已读内容", async () => {
    const image = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(image, 0);
    image.write("IHDR", 12, "ascii");
    image.writeUInt32BE(3, 16);
    image.writeUInt32BE(2, 20);
    store.prepareLiveRun.mockResolvedValueOnce({
      run: { id: "run_image", visitorId: "visitor_one", threadId: "thread_one", projectId: "project_one", modelId: "deepseek-v4-flash", agentId: "search-agent" },
      history: [],
      attachmentContext: "附件《截图.png》（image/png，24 字节）",
      imageInputs: [{ attachmentId: "att_image_1", mimeType: "image/png", sizeBytes: 24, sha256: "a".repeat(64), bytes: image }],
      projectMemoryContext: "",
      userMessageId: "user_one"
    });
    searchAgent.streamSearchAgentRun.mockImplementation(async function* () { yield completedEvent; });
    const engine = await freshEngine();
    await engine.startLiveRun({ visitorId: "visitor_one", threadId: "thread_one", message: "这张图片是什么？", modelId: "deepseek-v4-flash", reasoningEffort: "high", attachmentIds: ["att_image_1"] });
    await vi.waitFor(() => expect(searchAgent.streamSearchAgentRun).toHaveBeenCalled());

    const request = searchAgent.streamSearchAgentRun.mock.calls[0][0] as Record<string, unknown>;
    expect(request.imageInputs).toEqual([{ attachmentId: "att_image_1", mimeType: "image/png", sizeBytes: 24, sha256: "a".repeat(64) }]);
    expect(String(request.question)).toContain("图片内容未发送给模型、搜索工具或作为回答依据");
    expect(JSON.stringify(request)).not.toContain(image.toString("base64"));
    expect(JSON.stringify(store.persistLiveEvent.mock.calls)).not.toContain(image.toString("base64"));
  });

  it("恢复 search-agent 运行时复用 runId、设置 resume 且不重复 run.started", async () => {
    store.recoverInterruptedLiveRuns.mockResolvedValue({
      failed: 0,
      resumable: [{
        run: { id: "run_recovery", visitorId: "visitor_one", threadId: "thread_one", projectId: "project_one", modelId: "deepseek-v4-flash", agentId: "search-agent" },
        message: "恢复问题",
        history: [{ role: "user", content: "历史问题" }, { role: "assistant", content: "历史回答" }],
        attachmentContext: "",
        projectMemoryContext: "项目记忆",
        reasoningEffort: "high"
      }]
    });
    searchAgent.streamSearchAgentRun.mockImplementation(async function* () { yield completedEvent; });
    const engine = await freshEngine();
    await expect(engine.ensureLiveRecovery()).resolves.toBe(1);
    await vi.waitFor(() => expect(searchAgent.streamSearchAgentRun).toHaveBeenCalledWith(expect.objectContaining({ runId: "run_recovery", resume: true, history: [{ role: "user", content: "历史问题" }, { role: "assistant", content: "历史回答" }] }), expect.any(AbortSignal)));
    await vi.waitFor(() => expect(store.finalizeLiveRun).toHaveBeenCalledWith(expect.objectContaining({ id: "run_recovery" }), "completed", expect.anything(), expect.anything()));
    expect(store.persistLiveEvent.mock.calls.some((call) => call[1] === "run.started")).toBe(false);
  });

  it("流断开后同 runId 有界 reconnect，并通过 checkpoint resume", async () => {
    let attempt = 0;
    searchAgent.streamSearchAgentRun.mockImplementation(async function* () {
      attempt += 1;
      if (attempt === 1) {
        yield { ...sourceEnvelope, type: "tool.started", toolCallId: "call_before_disconnect", toolName: "web_search", query: "断线前查询", cached: false };
        throw new SearchAgentRequestError("Search Agent 事件流提前结束", "SEARCH_AGENT_STREAM_ENDED");
      }
      yield completedEvent;
    });
    const engine = await freshEngine();
    expect(engine.SEARCH_AGENT_RECONNECT_DELAYS_MS).toEqual([1_000, 2_000, 4_000, 8_000]);
    await engine.startLiveRun({ visitorId: "visitor_one", threadId: "thread_one", message: "断线恢复测试", modelId: "deepseek-v4-flash", reasoningEffort: "high", attachmentIds: [] });
    await vi.waitFor(() => expect(store.finalizeLiveRun).toHaveBeenCalledWith(expect.anything(), "completed", expect.anything(), expect.anything()), { timeout: 3_000 });

    expect(searchAgent.streamSearchAgentRun).toHaveBeenCalledTimes(2);
    expect(searchAgent.streamSearchAgentRun.mock.calls[0][0]).toMatchObject({ runId: "run_one", resume: false });
    expect(searchAgent.streamSearchAgentRun.mock.calls[1][0]).toMatchObject({ runId: "run_one", resume: true });
    expect(store.persistLiveEvent.mock.calls.some((call) => call[1] === "tool.started")).toBe(true);
    expect(store.persistLiveEvent.mock.calls.filter((call) => call[1] === "run.status").map((call) => call[2])).toEqual([
      expect.objectContaining({ status: "reconnecting", reasonCode: "SEARCH_AGENT_STREAM_ENDED", recoveryAttempt: 1 }),
      expect.objectContaining({ status: "running", recovered: true, recoveryAttempt: 1 })
    ]);
  });

  it("resume 短暂遇到 RUN_ALREADY_ACTIVE 时继续有界等待，不抢占 durable 终态", async () => {
    let attempt = 0;
    searchAgent.streamSearchAgentRun.mockImplementation(async function* () {
      attempt += 1;
      if (attempt === 1) {
        yield { ...sourceEnvelope, type: "run.failed", reasonCode: "RUN_ALREADY_ACTIVE", message: "相同运行 ID 已在执行" };
        return;
      }
      yield completedEvent;
    });
    const engine = await freshEngine();
    await engine.startLiveRun({ visitorId: "visitor_one", threadId: "thread_one", message: "并发恢复测试", modelId: "deepseek-v4-flash", reasoningEffort: "high", attachmentIds: [] });
    await vi.waitFor(() => expect(store.finalizeLiveRun).toHaveBeenCalledWith(expect.anything(), "completed", expect.anything(), expect.anything()), { timeout: 3_000 });
    expect(searchAgent.streamSearchAgentRun).toHaveBeenCalledTimes(2);
    expect(store.finalizeLiveRun.mock.calls.some((call) => call[1] === "failed")).toBe(false);
  });

  it("重连首事件直接失败时不误报 recovered", async () => {
    let attempt = 0;
    searchAgent.streamSearchAgentRun.mockImplementation(async function* () {
      attempt += 1;
      if (attempt === 1) throw new SearchAgentRequestError("Search Agent 事件流提前结束", "SEARCH_AGENT_STREAM_ENDED");
      yield { ...sourceEnvelope, type: "run.failed", reasonCode: "PROVIDER_UNAVAILABLE", message: "搜索提供方不可用" };
    });
    const engine = await freshEngine();
    await engine.startLiveRun({ visitorId: "visitor_one", threadId: "thread_one", message: "失败恢复测试", modelId: "deepseek-v4-flash", reasoningEffort: "high", attachmentIds: [] });
    await vi.waitFor(() => expect(store.finalizeLiveRun).toHaveBeenCalledWith(expect.anything(), "failed", expect.objectContaining({ reasonCode: "PROVIDER_UNAVAILABLE" }), undefined), { timeout: 3_000 });

    expect(searchAgent.streamSearchAgentRun).toHaveBeenCalledTimes(2);
    expect(store.persistLiveEvent.mock.calls.filter((call) => call[1] === "run.status").map((call) => call[2])).toEqual([
      expect.objectContaining({ status: "reconnecting", reasonCode: "SEARCH_AGENT_STREAM_ENDED", recoveryAttempt: 1 })
    ]);
  });

  it("partial 或未核验回答不写入跨会话项目事实记忆", async () => {
    searchAgent.streamSearchAgentRun.mockImplementation(async function* () {
      yield { ...completedEvent, responseStatus: "partial", verificationPassed: false, stopReason: "SEARCH_UNAVAILABLE", citations: [] };
    });
    const engine = await freshEngine();
    await engine.startLiveRun({ visitorId: "visitor_one", threadId: "thread_one", message: "未核验问题", modelId: "deepseek-v4-flash", reasoningEffort: "medium", attachmentIds: [] });
    await vi.waitFor(() => expect(store.finalizeLiveRun).toHaveBeenCalledWith(expect.anything(), "completed", expect.objectContaining({ partial: true }), expect.anything()));
    const completion = store.finalizeLiveRun.mock.calls.at(-1)?.[3] as { memory?: unknown };
    expect(completion.memory).toBeUndefined();
  });

  it("INVALID_EVENT 与 HTTP 4xx 不自动 resume", async () => {
    searchAgent.streamSearchAgentRun.mockImplementation(async function* () {
      throw new SearchAgentRequestError("Search Agent 事件流校验失败", "SEARCH_AGENT_INVALID_EVENT");
    });
    const engine = await freshEngine();
    await engine.startLiveRun({ visitorId: "visitor_one", threadId: "thread_one", message: "坏事件测试", modelId: "deepseek-v4-flash", reasoningEffort: "medium", attachmentIds: [] });
    await vi.waitFor(() => expect(store.finalizeLiveRun).toHaveBeenCalledWith(expect.anything(), "failed", expect.objectContaining({ reasonCode: "SEARCH_AGENT_INVALID_EVENT" }), undefined));
    expect(searchAgent.streamSearchAgentRun).toHaveBeenCalledTimes(1);
    expect(store.persistLiveEvent.mock.calls.some((call) => call[1] === "run.status" && (call[2] as { status?: string }).status === "reconnecting")).toBe(false);
  });

  it("停止时先 await Python stop，再触发 AbortController 与本地终态", async () => {
    const order: string[] = [];
    let activeSignal: AbortSignal | undefined;
    let resolveStop!: () => void;
    const stopGate = new Promise<void>((resolve) => { resolveStop = resolve; });
    searchAgent.requestSearchAgentStop.mockImplementation(async () => {
      order.push("stop-called");
      await stopGate;
      order.push("stop-resolved");
      return "requested";
    });
    searchAgent.streamSearchAgentRun.mockImplementation(async function* (_input, signal: AbortSignal) {
      activeSignal = signal;
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => { order.push("aborted"); reject(signal.reason); }, { once: true }));
    });
    const engine = await freshEngine();
    await engine.startLiveRun({ visitorId: "visitor_one", threadId: "thread_one", message: "停止测试", modelId: "deepseek-v4-flash", reasoningEffort: "medium", attachmentIds: [] });
    await vi.waitFor(() => expect(activeSignal).toBeDefined());
    const stopping = engine.stopLiveRun("visitor_one", "run_one");
    await vi.waitFor(() => expect(order).toEqual(["stop-called"]));
    expect(activeSignal?.aborted).toBe(false);
    resolveStop();
    await expect(stopping).resolves.toBe("stopped");
    expect(order).toEqual(["stop-called", "stop-resolved", "aborted"]);
    expect(store.finalizeLiveRun).toHaveBeenCalledWith(expect.anything(), "stopped", {}, undefined);
  });
});
