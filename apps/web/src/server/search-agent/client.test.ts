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

const encoder = new TextEncoder();
const originalToken = process.env.WORKBENCH_INTERNAL_TOKEN;
const sourceEnvelope = { version: 1, eventId: "stream_test_000001", streamId: "stream_test", streamSeq: 1, seq: 1, createdAt: "2026-07-28T00:00:00Z" };

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
  projectMemoryContext: ""
};

describe("Search Agent 服务端 client", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.WORKBENCH_INTERNAL_TOKEN = "internal-test-token";
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.WORKBENCH_INTERNAL_TOKEN;
    else process.env.WORKBENCH_INTERNAL_TOKEN = originalToken;
  });

  it("只从 BFF 服务端调用内部 NDJSON 接口并携带最小运行请求", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(ndjsonResponse([{
      ...sourceEnvelope,
      type: "run.failed",
      reasonCode: "SEARCH_UNAVAILABLE",
      message: "搜索不可用"
    }]));
    const events = [];
    for await (const event of streamSearchAgentRun(request, new AbortController().signal)) events.push(event);

    expect(events).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8100/v1/runs/stream");
    expect(new Headers(init.headers).get("X-Workbench-Token")).toBe("internal-test-token");
    expect(JSON.parse(String(init.body))).toEqual(expect.objectContaining({ version: 1, runId: "run_one", question: "需要搜索的问题", resume: false }));
    expect(String(init.body)).not.toMatch(/apiKey|Authorization|reasoning_content/u);
  });

  it("图片只传递不可逆引用，不传 bytes、base64 或附件地址", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(ndjsonResponse([{
      ...sourceEnvelope,
      type: "run.failed",
      reasonCode: "SEARCH_UNAVAILABLE",
      message: "搜索不可用"
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

  it("调用内部 stop endpoint，并把不存在 endpoint 视为 unsupported", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockResolvedValueOnce(new Response("", { status: 404 }));
    await expect(requestSearchAgentStop("run_one")).resolves.toBe("requested");
    await expect(requestSearchAgentStop("run_two")).resolves.toBe("unsupported");
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:8100/v1/runs/run_one/stop");
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
