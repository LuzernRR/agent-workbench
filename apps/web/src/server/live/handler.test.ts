import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  liveRun: vi.fn(),
  verificationStatus: vi.fn(),
  verificationQrcode: vi.fn(),
  cancelVerification: vi.fn(),
  startLiveRun: vi.fn(),
  stopLiveRun: vi.fn(),
  resolveVisitor: vi.fn(),
  updateLiveProject: vi.fn(),
  updateLiveThread: vi.fn(),
  deleteLiveProject: vi.fn(),
  deleteLiveThread: vi.fn(),
  reorderLiveProjects: vi.fn(),
  getLiveSnapshot: vi.fn(),
  liveAttachment: vi.fn(),
  recordAuthorizationDenied: vi.fn(),
  recordAuthorizationDenials: vi.fn()
}));

vi.mock("./engine", () => ({
  startLiveRun: mocks.startLiveRun,
  stopLiveRun: mocks.stopLiveRun
}));

vi.mock("./store", () => ({
  activeEventsForRun: vi.fn(async () => []),
  createLiveProject: vi.fn(),
  createLiveThread: vi.fn(),
  deleteLiveProject: mocks.deleteLiveProject,
  deleteLiveThread: mocks.deleteLiveThread,
  getLiveSnapshot: mocks.getLiveSnapshot,
  listLiveProjects: vi.fn(async () => []),
  listLiveThreads: vi.fn(async () => []),
  liveAttachment: mocks.liveAttachment,
  liveRun: mocks.liveRun,
  reorderLiveProjects: mocks.reorderLiveProjects,
  updateLiveProject: mocks.updateLiveProject,
  updateLiveThread: mocks.updateLiveThread,
  uploadLiveAttachments: vi.fn()
}));

vi.mock("./quota", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./quota")>()),
  recordAuthorizationDenied: mocks.recordAuthorizationDenied,
  recordAuthorizationDenials: mocks.recordAuthorizationDenials
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

  it.each([
    "QUOTA_REQUESTS_PER_MINUTE_EXCEEDED",
    "QUOTA_CONCURRENT_RUNS_EXCEEDED",
    "QUOTA_TOKENS_PER_DAY_EXCEEDED",
    "QUOTA_COST_PER_DAY_EXCEEDED"
  ] as const)("%s 都映射为 429 且不丢失原因码", async (reasonCode) => {
    mocks.startLiveRun.mockRejectedValue(new QuotaExceededError(reasonCode, 1, 1));
    const response = await handleLive(
      new Request("http://localhost/api/v1/threads/thread_one/runs", {
        method: "POST",
        body: JSON.stringify({ message: "帮我查一下", modelId: "deepseek-v4-flash" })
      }),
      "/api/v1/threads/thread_one/runs"
    );
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({ code: reasonCode });
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

describe("Live 资源授权拒绝审计", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveVisitor.mockResolvedValue({ id: "visitor_one", tenantId: "tenant-one" });
    mocks.recordAuthorizationDenied.mockResolvedValue(undefined);
    mocks.recordAuthorizationDenials.mockResolvedValue(undefined);
  });

  it("他人资源与不存在资源返回相同响应，并为调用主体写稳定 denied 审计", async () => {
    mocks.updateLiveProject.mockResolvedValue(null);
    const request = (id: string) => handleLive(new Request(`http://localhost/api/v1/projects/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "越权改名" })
    }), `/api/v1/projects/${id}`);

    const foreign = await request("project_foreign");
    const missing = await request("project_missing");
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await foreign.json()).toEqual(await missing.json());
    expect(mocks.recordAuthorizationDenied).toHaveBeenNthCalledWith(1, {
      tenantId: "tenant-one",
      visitorId: "visitor_one",
      action: "project.update",
      resourceKind: "project",
      resourceId: "project_foreign"
    });
    expect(mocks.recordAuthorizationDenied).toHaveBeenCalledTimes(2);
    expect(mocks.recordAuthorizationDenials).not.toHaveBeenCalled();
  });

  it("项目与会话删除拒绝同时审计被阻断的 memory.delete 能力", async () => {
    mocks.deleteLiveProject.mockResolvedValue(false);
    mocks.deleteLiveThread.mockResolvedValue(false);

    const project = await handleLive(
      new Request("http://localhost/api/v1/projects/project_foreign", { method: "DELETE" }),
      "/api/v1/projects/project_foreign"
    );
    const thread = await handleLive(
      new Request("http://localhost/api/v1/threads/thread_foreign", { method: "DELETE" }),
      "/api/v1/threads/thread_foreign"
    );

    expect(project.status).toBe(404);
    expect(thread.status).toBe(404);
    expect(mocks.recordAuthorizationDenials).toHaveBeenNthCalledWith(1, [
      {
        tenantId: "tenant-one",
        visitorId: "visitor_one",
        action: "project.delete",
        resourceKind: "project",
        resourceId: "project_foreign"
      },
      {
        tenantId: "tenant-one",
        visitorId: "visitor_one",
        action: "memory.delete",
        resourceKind: "memory",
        resourceId: "project:project_foreign"
      }
    ]);
    expect(mocks.recordAuthorizationDenials).toHaveBeenNthCalledWith(2, [
      {
        tenantId: "tenant-one",
        visitorId: "visitor_one",
        action: "thread.delete",
        resourceKind: "thread",
        resourceId: "thread_foreign"
      },
      {
        tenantId: "tenant-one",
        visitorId: "visitor_one",
        action: "memory.delete",
        resourceKind: "memory",
        resourceId: "thread:thread_foreign"
      }
    ]);
    expect(mocks.recordAuthorizationDenied).not.toHaveBeenCalled();
  });

  it("附件读取拒绝写 attachment.read 审计", async () => {
    mocks.liveAttachment.mockResolvedValue(null);
    const response = await handleLive(
      new Request("http://localhost/api/v1/attachments/attachment_foreign"),
      "/api/v1/attachments/attachment_foreign"
    );
    expect(response.status).toBe(404);
    expect(mocks.recordAuthorizationDenied).toHaveBeenCalledWith({
      tenantId: "tenant-one",
      visitorId: "visitor_one",
      action: "attachment.read",
      resourceKind: "attachment",
      resourceId: "attachment_foreign"
    });
  });

  it("会话更新按真实拒绝对象记录 thread 或 target project，外部响应保持一致", async () => {
    mocks.updateLiveThread
      .mockResolvedValueOnce({ kind: "thread_denied", resourceId: "thread_foreign" })
      .mockResolvedValueOnce({ kind: "target_project_denied", resourceId: "project_foreign" });
    const request = (threadId: string, projectId: string) => handleLive(
      new Request(`http://localhost/api/v1/threads/${threadId}`, {
        method: "PATCH",
        body: JSON.stringify({ projectId })
      }),
      `/api/v1/threads/${threadId}`
    );

    const threadDenied = await request("thread_foreign", "project_one");
    const projectDenied = await request("thread_one", "project_foreign");
    expect(threadDenied.status).toBe(404);
    expect(projectDenied.status).toBe(404);
    expect(await threadDenied.json()).toEqual(await projectDenied.json());
    expect(mocks.recordAuthorizationDenied).toHaveBeenNthCalledWith(1, {
      tenantId: "tenant-one",
      visitorId: "visitor_one",
      action: "thread.update",
      resourceKind: "thread",
      resourceId: "thread_foreign"
    });
    expect(mocks.recordAuthorizationDenied).toHaveBeenNthCalledWith(2, {
      tenantId: "tenant-one",
      visitorId: "visitor_one",
      action: "thread.update",
      resourceKind: "project",
      resourceId: "project_foreign"
    });
  });

  it("项目排序只对无权或不存在 ID 写 denied，无效顺序仅返回相同 400", async () => {
    mocks.reorderLiveProjects
      .mockResolvedValueOnce({ kind: "invalid_order" })
      .mockResolvedValueOnce({ kind: "not_owned_or_missing", resourceId: "project_foreign" });
    const request = (projectIds: string[]) => handleLive(
      new Request("http://localhost/api/v1/projects/reorder", {
        method: "PATCH",
        body: JSON.stringify({ projectIds })
      }),
      "/api/v1/projects/reorder"
    );

    const invalid = await request(["project_one", "project_one"]);
    expect(invalid.status).toBe(400);
    expect(mocks.recordAuthorizationDenied).not.toHaveBeenCalled();

    const denied = await request(["project_one", "project_foreign"]);
    expect(denied.status).toBe(400);
    expect(await denied.json()).toEqual(await invalid.json());
    expect(mocks.recordAuthorizationDenied).toHaveBeenCalledTimes(1);
    expect(mocks.recordAuthorizationDenied).toHaveBeenCalledWith({
      tenantId: "tenant-one",
      visitorId: "visitor_one",
      action: "project.reorder",
      resourceKind: "project",
      resourceId: "project_foreign"
    });
  });

  it("审计写入失败时 fail closed 为 503，不返回无审计的 404", async () => {
    mocks.getLiveSnapshot.mockResolvedValue(null);
    mocks.recordAuthorizationDenied.mockRejectedValue(new Error("audit unavailable"));
    const response = await handleLive(
      new Request("http://localhost/api/v1/threads/thread_foreign"),
      "/api/v1/threads/thread_foreign"
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "LIVE_SERVICE_UNAVAILABLE" });
  });

  it("批量 memory 删除审计写入失败时同样 fail closed 为 503", async () => {
    mocks.deleteLiveThread.mockResolvedValue(false);
    mocks.recordAuthorizationDenials.mockRejectedValue(new Error("batch audit unavailable"));
    const response = await handleLive(
      new Request("http://localhost/api/v1/threads/thread_foreign", { method: "DELETE" }),
      "/api/v1/threads/thread_foreign"
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "LIVE_SERVICE_UNAVAILABLE" });
    expect(mocks.recordAuthorizationDenied).not.toHaveBeenCalled();
  });
});
