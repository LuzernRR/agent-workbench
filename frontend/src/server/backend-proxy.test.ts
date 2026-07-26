import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalOrigin = process.env.WORKBENCH_API_ORIGIN;
const originalTenant = process.env.WORKBENCH_TENANT;
const originalUser = process.env.WORKBENCH_USER;
const originalToken = process.env.WORKBENCH_INTERNAL_TOKEN;

describe("backend proxy", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.WORKBENCH_API_ORIGIN = "http://workbench-api:8080";
    process.env.WORKBENCH_TENANT = "tenant-test";
    process.env.WORKBENCH_USER = "user-test";
    process.env.WORKBENCH_INTERNAL_TOKEN = "token-test";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    restore("WORKBENCH_API_ORIGIN", originalOrigin);
    restore("WORKBENCH_TENANT", originalTenant);
    restore("WORKBENCH_USER", originalUser);
    restore("WORKBENCH_INTERNAL_TOKEN", originalToken);
  });

  it("保留 SSE 游标与事件正文并关闭代理缓冲", async () => {
    const upstream = "id: 8\nevent: text.delta\ndata: {\"seq\":8}\n\n";
    const fetchMock = vi.fn().mockResolvedValue(new Response(upstream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "private" }
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { proxyStream } = await import("./backend-proxy");
    const request = new Request("http://localhost/workbench/api/v1/runs/run-1/events?after=7", {
      headers: { "Last-Event-ID": "7" }
    });

    const response = await proxyStream(request, "/api/v1/runs/run-1/events?after=7");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);

    expect(url).toBe("http://workbench-api:8080/api/v1/runs/run-1/events?after=7");
    expect(headers.get("Last-Event-ID")).toBe("7");
    expect(headers.get("X-Workspace-Tenant")).toBe("tenant-test");
    expect(headers.get("X-Workspace-User")).toBe("user-test");
    expect(headers.get("X-Workbench-Token")).toBe("token-test");
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-cache, no-transform");
    expect(response.headers.get("X-Accel-Buffering")).toBe("no");
    expect(await response.text()).toBe(upstream);
  });

  it("原样保留附件下载类型、文件名与正文", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": "attachment; filename=result.pdf",
        "X-Content-Type-Options": "nosniff"
      }
    })));
    const { proxyStream } = await import("./backend-proxy");

    const response = await proxyStream(new Request("http://localhost/workbench/api/v1/attachments/file-1"), "/api/v1/attachments/file-1", "附件暂时无法读取");

    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Content-Disposition")).toBe("attachment; filename=result.pdf");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it("附件上游断开时返回中文错误 envelope", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection reset")));
    const { proxyStream } = await import("./backend-proxy");

    const response = await proxyStream(new Request("http://localhost/workbench/api/v1/attachments/file-1"), "/api/v1/attachments/file-1", "附件暂时无法读取");

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ success: false, code: "BACKEND_UNAVAILABLE", message: "附件暂时无法读取" });
  });

  it("原样透传 JSON 错误状态和 envelope", async () => {
    const envelope = { success: false, code: "RUNNER_UNAVAILABLE", message: "助手配置暂不可用" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(envelope, { status: 503 })));
    const { proxyJson } = await import("./backend-proxy");

    const response = await proxyJson(new Request("http://localhost/workbench/api/v1/agents"), "/api/v1/agents");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual(envelope);
  });
});

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
