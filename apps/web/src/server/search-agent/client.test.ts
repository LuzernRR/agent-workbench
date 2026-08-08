import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const config = vi.hoisted(() => ({
  loadSearchAgentServiceConfig: vi.fn(async () => ({ origin: "http://127.0.0.1:8100", requestTimeoutMs: 30_000 }))
}));

vi.mock("./config", () => config);

import {
  cancelXiaohongshuVerification,
  requestSearchAgentStop,
  requestXiaohongshuVerificationQrcode,
  requestXiaohongshuVerificationStatus,
  SearchAgentRequestError,
  streamSearchAgentRun
} from "./client";
import { TENANT_ASSERTION_HEADER, verifyTenantAssertion } from "./tenant-assertion";

const encoder = new TextEncoder();
const assertionSecret = "0123456789abcdef0123456789abcdef";
const original = {
  token: process.env.WORKBENCH_INTERNAL_TOKEN,
  assertionSecret: process.env.WORKBENCH_TENANT_ASSERTION_SECRET,
  allowInsecureLoopback: process.env.SEARCH_AGENT_ALLOW_INSECURE_LOOPBACK
};
const sourceEnvelope = { version: 1, eventId: "stream_test_000001", streamId: "stream_test", streamSeq: 1, seq: 1, createdAt: "2026-07-28T00:00:00Z" };

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function ndjsonResponse(events: unknown[]) {
  return new Response(events.map((event) => JSON.stringify(event)).join("\n"), {
    status: 200,
    headers: { "content-type": "application/x-ndjson; charset=utf-8" }
  });
}

const request = {
  runId: "run_one",
  tenantId: "local",
  visitorId: "visitor_one",
  projectId: null,
  threadId: "thread_one",
  question: "需要搜索的问题",
  modelId: "deepseek-v4-flash",
  reasoningEffort: "high" as const,
  history: [],
  projectMemoryContext: "",
  checkpointSessionId: "checkpoint_session_1"
};

describe("Search Agent 服务端 client", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    config.loadSearchAgentServiceConfig.mockReset().mockResolvedValue({ origin: "http://127.0.0.1:8100", requestTimeoutMs: 30_000 });
    process.env.WORKBENCH_INTERNAL_TOKEN = "internal-test-token";
    process.env.WORKBENCH_TENANT_ASSERTION_SECRET = assertionSecret;
    delete process.env.SEARCH_AGENT_ALLOW_INSECURE_LOOPBACK;
  });

  afterEach(() => {
    restore("WORKBENCH_INTERNAL_TOKEN", original.token);
    restore("WORKBENCH_TENANT_ASSERTION_SECRET", original.assertionSecret);
    restore("SEARCH_AGENT_ALLOW_INSECURE_LOOPBACK", original.allowInsecureLoopback);
  });

  it("只从 BFF 服务端调用内部 NDJSON 接口并携带最小运行请求", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(ndjsonResponse([{
      ...sourceEnvelope,
      type: "run.failed",
      reasonCode: "SEARCH_UNAVAILABLE",
      message: "搜索不可用",
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, cost_usd: 0 }
    }]));
    const events = [];
    for await (const event of streamSearchAgentRun(request, new AbortController().signal)) events.push(event);

    expect(events).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8100/v1/runs/stream");
    const headers = new Headers(init.headers);
    expect(headers.get("X-Workbench-Token")).toBe("internal-test-token");
    expect(verifyTenantAssertion(headers.get(TENANT_ASSERTION_HEADER), request)).toBe(true);
    expect(JSON.parse(String(init.body))).toEqual(expect.objectContaining({
      version: 1,
      runId: "run_one",
      question: "需要搜索的问题",
      resume: false,
      checkpointSessionId: "checkpoint_session_1"
    }));
    expect(String(init.body)).not.toMatch(/apiKey|Authorization|reasoning_content/u);
  });

  it("租户断言密钥缺失、过弱或复用内部 Token 时在 fetch 前失败", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const consume = async () => {
      for await (const _event of streamSearchAgentRun(request, new AbortController().signal)) void _event;
    };

    delete process.env.WORKBENCH_TENANT_ASSERTION_SECRET;
    await expect(consume()).rejects.toMatchObject({ code: "SEARCH_AGENT_TENANT_ASSERTION_CONFIG" });

    process.env.WORKBENCH_TENANT_ASSERTION_SECRET = "too-short";
    await expect(consume()).rejects.toMatchObject({ code: "SEARCH_AGENT_TENANT_ASSERTION_CONFIG" });

    process.env.WORKBENCH_TENANT_ASSERTION_SECRET = assertionSecret;
    process.env.WORKBENCH_INTERNAL_TOKEN = assertionSecret;
    await expect(consume()).rejects.toMatchObject({ code: "SEARCH_AGENT_TENANT_ASSERTION_CONFIG" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("显式 loopback 开发模式可在无断言密钥时省略断言", async () => {
    delete process.env.WORKBENCH_TENANT_ASSERTION_SECRET;
    process.env.SEARCH_AGENT_ALLOW_INSECURE_LOOPBACK = "1";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(ndjsonResponse([{
      ...sourceEnvelope,
      type: "run.failed",
      reasonCode: "SEARCH_UNAVAILABLE",
      message: "搜索不可用",
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, cost_usd: 0 }
    }]));

    for await (const _event of streamSearchAgentRun(request, new AbortController().signal)) void _event;

    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).has(TENANT_ASSERTION_HEADER)).toBe(false);
  });

  it("非 loopback 地址即使设置开发开关也不能省略断言", async () => {
    delete process.env.WORKBENCH_TENANT_ASSERTION_SECRET;
    process.env.SEARCH_AGENT_ALLOW_INSECURE_LOOPBACK = "1";
    config.loadSearchAgentServiceConfig.mockResolvedValueOnce({ origin: "http://search-agent:8100", requestTimeoutMs: 30_000 });
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const consume = async () => {
      for await (const _event of streamSearchAgentRun(request, new AbortController().signal)) void _event;
    };

    await expect(consume()).rejects.toMatchObject({ code: "SEARCH_AGENT_TENANT_ASSERTION_CONFIG" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("只接受成对且格式合法的权威 checkpoint 恢复引用", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(ndjsonResponse([{
      ...sourceEnvelope,
      type: "run.failed",
      reasonCode: "SEARCH_UNAVAILABLE",
      message: "搜索不可用",
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, cost_usd: 0 }
    }]));

    const invalid = [
      { ...request, checkpointSessionId: "bad/session" },
      { ...request, resume: false, checkpointId: "checkpoint_1" },
      { ...request, resume: false, checkpointNs: "" },
      { ...request, resume: true },
      { ...request, resume: true, checkpointId: "checkpoint_1" },
      { ...request, resume: true, checkpointId: "bad/checkpoint", checkpointNs: "" },
      { ...request, resume: true, checkpointId: "checkpoint_1", checkpointNs: "bad\nnamespace" }
    ];
    for (const candidate of invalid) {
      const consume = async () => {
        for await (const _event of streamSearchAgentRun(candidate, new AbortController().signal)) void _event;
      };
      await expect(consume()).rejects.toMatchObject({ code: "SEARCH_AGENT_INVALID_CHECKPOINT" });
    }
    expect(fetchMock).not.toHaveBeenCalled();

    const exact = {
      ...request,
      resume: true,
      checkpointId: "checkpoint_1",
      checkpointNs: "research/subgraph"
    };
    for await (const _event of streamSearchAgentRun(exact, new AbortController().signal)) void _event;
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toMatchObject({
      resume: true,
      checkpointId: "checkpoint_1",
      checkpointNs: "research/subgraph",
      checkpointSessionId: "checkpoint_session_1"
    });
    const recoveryHeaders = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(verifyTenantAssertion(recoveryHeaders.get(TENANT_ASSERTION_HEADER), exact)).toBe(true);
  });

  it("图片只传递不可逆引用，不传 bytes、base64 或附件地址", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(ndjsonResponse([{
      ...sourceEnvelope,
      type: "run.failed",
      reasonCode: "SEARCH_UNAVAILABLE",
      message: "搜索不可用",
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, cost_usd: 0 }
    }]));
    const imageRequest = {
      ...request,
      imageInputs: [{ attachmentId: "att_image_1", mimeType: "image/png" as const, sizeBytes: 24, sha256: "a".repeat(64) }]
    };
    for await (const _event of streamSearchAgentRun(imageRequest, new AbortController().signal)) void _event;

    const body = String((fetchMock.mock.calls[0][1] as RequestInit).body);
    expect(JSON.parse(body).imageInputs).toEqual(imageRequest.imageInputs);
    expect(body).not.toMatch(/base64|data:image|https:\/\//u);
  });

  it("拒绝非 NDJSON 响应且不读取 Provider body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("provider secret", { status: 200, headers: { "content-type": "application/json" } }));
    const consume = async () => { for await (const _event of streamSearchAgentRun(request, new AbortController().signal)) void _event; };
    await expect(consume()).rejects.toMatchObject({ code: "SEARCH_AGENT_BAD_CONTENT_TYPE" } satisfies Partial<SearchAgentRequestError>);
  });

  it("把 body/TCP 中途断开分类为可恢复 STREAM_ENDED，而非协议污染", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(encoder.encode(`${JSON.stringify({ ...sourceEnvelope, type: "node.started", node: "research", nodeRunId: "research_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", agent: "researcher", iteration: 0 })}\n`));
          return;
        }
        controller.error(new TypeError("socket closed"));
      }
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } }));
    const received: string[] = [];
    let failure: unknown;
    try {
      for await (const event of streamSearchAgentRun(request, new AbortController().signal)) received.push(event.type);
    } catch (error) {
      failure = error;
    }
    expect(received).toEqual(["node.started"]);
    expect(failure).toMatchObject({ code: "SEARCH_AGENT_STREAM_ENDED" });
  });

  it("严格解析内部 stop 结果，并把 stopping/already_stopped 视为已请求", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: 1, runId: "run_one", status: "stopping", taskCancelled: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: 1, runId: "run_two", status: "already_stopped", taskCancelled: false }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: 1, runId: "run_three", status: "not_running", taskCancelled: false }), { status: 200 }))
      .mockResolvedValueOnce(new Response("", { status: 404 }));
    await expect(requestSearchAgentStop("run_one")).resolves.toBe("requested");
    await expect(requestSearchAgentStop("run_two")).resolves.toBe("requested");
    await expect(requestSearchAgentStop("run_three")).resolves.toBe("not_running");
    await expect(requestSearchAgentStop("run_four")).resolves.toBe("unsupported");
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:8100/v1/runs/run_one/stop");
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("accept")).toBe("application/json");
    expect(timeout).toHaveBeenCalledWith(500);
  });

  it("stop 的空正文、错误 runId 与额外字段全部 fail closed", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: 1, runId: "run_other", status: "stopping", taskCancelled: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: 1, runId: "run_one", status: "stopping", taskCancelled: true, extra: true }), { status: 200 }));

    await expect(requestSearchAgentStop("run_one")).resolves.toBe("unavailable");
    await expect(requestSearchAgentStop("run_one")).resolves.toBe("unavailable");
    await expect(requestSearchAgentStop("run_one")).resolves.toBe("unavailable");
  });

  it("stop 配置不可用时返回 unavailable，不阻断本地停止兜底", async () => {
    config.loadSearchAgentServiceConfig.mockRejectedValueOnce(new Error("config missing"));
    await expect(requestSearchAgentStop("run_one")).resolves.toBe("unavailable");
  });

  it("严格代理工具账号验证状态、二维码和取消请求", async () => {
    const challengeId = "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789";
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]);
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        version: 1,
        runId: "run_one",
        challengeId,
        status: "pending",
        expiresAt: "2026-07-28T00:04:00Z",
        retryAfterMs: 2000,
        reasonCode: null,
        message: "等待使用小红书 App 扫码验证工具账号"
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(png, { status: 200, headers: { "content-type": "image/png", "cache-control": "no-store" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: 1, runId: "run_one", challengeId, status: "cancelled" }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(requestXiaohongshuVerificationStatus("run_one", challengeId)).resolves.toMatchObject({ status: "pending" });
    await expect(requestXiaohongshuVerificationQrcode("run_one", challengeId)).resolves.toEqual(png);
    await expect(cancelXiaohongshuVerification("run_one", challengeId)).resolves.toBeUndefined();

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `http://127.0.0.1:8100/v1/runs/run_one/xiaohongshu-verifications/${challengeId}`,
      `http://127.0.0.1:8100/v1/runs/run_one/xiaohongshu-verifications/${challengeId}/qrcode`,
      `http://127.0.0.1:8100/v1/runs/run_one/xiaohongshu-verifications/${challengeId}`
    ]);
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get("accept")).toBe("image/png");
  });

  it("拒绝验证接口的额外字段和伪造二维码", async () => {
    const challengeId = "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789";
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        version: 1,
        runId: "run_one",
        challengeId,
        status: "pending",
        expiresAt: "2026-07-28T00:04:00Z",
        retryAfterMs: 2000,
        reasonCode: null,
        message: "等待扫码",
        qrcode: "secret"
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response("not png", { status: 200, headers: { "content-type": "image/png" } }));

    await expect(requestXiaohongshuVerificationStatus("run_one", challengeId)).rejects.toMatchObject({ code: "SEARCH_AGENT_INVALID_EVENT" });
    await expect(requestXiaohongshuVerificationQrcode("run_one", challengeId)).rejects.toMatchObject({ code: "SEARCH_AGENT_INVALID_EVENT" });
  });
});
