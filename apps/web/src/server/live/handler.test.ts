import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  liveRun: vi.fn(),
  verificationStatus: vi.fn(),
  verificationQrcode: vi.fn(),
  cancelVerification: vi.fn(),
  startLiveRun: vi.fn(),
  resolveVisitor: vi.fn()
}));

vi.mock("./engine", () => ({
  startLiveRun: mocks.startLiveRun,
  stopLiveRun: vi.fn()
}));

vi.mock("./store", () => ({
  activeEventsForRun: vi.fn(async () => []),
  createLiveProject: vi.fn(),
  createLiveThread: vi.fn(),
  deleteLiveProject: vi.fn(),
  deleteLiveThread: vi.fn(),
  getLiveSnapshot: vi.fn(),
  listLiveProjects: vi.fn(async () => []),
  listLiveThreads: vi.fn(async () => []),
  liveAttachment: vi.fn(),
  liveRun: mocks.liveRun,
  reorderLiveProjects: vi.fn(),
  updateLiveProject: vi.fn(),
  updateLiveThread: vi.fn(),
  uploadLiveAttachments: vi.fn()
}));

vi.mock("@/server/session/visitor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/session/visitor")>()),
  resolveVisitor: mocks.resolveVisitor
}));

vi.mock("@/server/search-agent/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/search-agent/client")>()),
  requestXiaohongshuVerificationStatus: mocks.verificationStatus,
  requestXiaohongshuVerificationQrcode: mocks.verificationQrcode,
  cancelXiaohongshuVerification: mocks.cancelVerification
}));

import { handleLive } from "./handler";
import { QuotaExceededError } from "./quota";

const challengeId = "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789";
const path = `/api/v1/runs/run_one/xiaohongshu-verifications/${challengeId}`;
const ownedRun = {
  run: {
    id: "run_one",
    visitorId: "visitor_one",
    threadId: "thread_one",
    projectId: null,
    modelId: "deepseek-v4-flash",
    agentId: "search-agent"
  },
  status: "running"
};

describe("Live 小红书工具账号验证代理", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.liveRun.mockResolvedValue(ownedRun);
    mocks.resolveVisitor.mockResolvedValue({ id: "visitor_one" });
  });

  it("只要求当前访客拥有 Run，不要求管理权限", async () => {
    mocks.verificationStatus.mockResolvedValue({
      version: 1,
      runId: "run_one",
      challengeId,
      status: "pending",
      expiresAt: "2026-08-01T00:04:00Z",
      retryAfterMs: 2000,
      reasonCode: null,
      message: "等待扫码"
    });

    const response = await handleLive(new Request(`http://localhost${path}`), path);

    expect(response.status).toBe(200);
    expect(mocks.liveRun).toHaveBeenCalledWith("visitor_one", "run_one");
    expect(mocks.verificationStatus).toHaveBeenCalledWith("run_one", challengeId);
    await expect(response.json()).resolves.toMatchObject({ status: "pending" });
  });

  it("拒绝访问其他访客的 Run", async () => {
    mocks.liveRun.mockResolvedValue(null);

    const response = await handleLive(new Request(`http://localhost${path}`), path);

    expect(response.status).toBe(404);
    expect(mocks.verificationStatus).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ code: "VERIFICATION_NOT_FOUND" });
  });

  it("二维码只经同源代理返回并强制 no-store", async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]);
    mocks.verificationQrcode.mockResolvedValue(png);

    const response = await handleLive(
      new Request(`http://localhost${path}/qrcode`),
      `${path}/qrcode`
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
  });
});

describe("Live 配额准入", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveVisitor.mockResolvedValue({ id: "visitor_one", tenantId: "tenant-one" });
  });

  it("配额超限映射为 429 与稳定原因码", async () => {
    mocks.startLiveRun.mockRejectedValue(new QuotaExceededError("QUOTA_CONCURRENT_RUNS_EXCEEDED", 5, 5));

    const response = await handleLive(
      new Request("http://localhost/api/v1/threads/thread_one/runs", {
        method: "POST",
        body: JSON.stringify({ message: "帮我查一下", modelId: "deepseek-v4-flash" })
      }),
      "/api/v1/threads/thread_one/runs"
    );

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({ code: "QUOTA_CONCURRENT_RUNS_EXCEEDED" });
    expect(mocks.startLiveRun).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "tenant-one" }));
  });

  it("配额以内正常创建运行", async () => {
    mocks.startLiveRun.mockResolvedValue({ runId: "run_one" });

    const response = await handleLive(
      new Request("http://localhost/api/v1/threads/thread_one/runs", {
        method: "POST",
        body: JSON.stringify({ message: "帮我查一下", modelId: "deepseek-v4-flash" })
      }),
      "/api/v1/threads/thread_one/runs"
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ runId: "run_one" });
  });
});
