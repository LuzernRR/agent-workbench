import { NextResponse } from "next/server";
import { handleMock } from "@/server/mock/handler";

export const externalBackendUrl = process.env.WORKBENCH_API_ORIGIN?.replace(/\/$/, "") || null;

/**
 * 未配置真实后端时使用内存实现，让工作台在没有 Java/Python 服务的情况下也能完整运行。
 * 设为 WORKBENCH_DISABLE_MOCK=1 可恢复原来的 503 行为。
 */
const mockEnabled = !externalBackendUrl && process.env.WORKBENCH_DISABLE_MOCK !== "1";

function backendHeaders(request: Request) {
  const headers = new Headers(request.headers);
  [
    "host",
    "content-length",
    "connection",
    "keep-alive",
    "transfer-encoding",
    "upgrade",
    "expect",
    "te",
    "trailer",
    "proxy-authenticate",
    "proxy-authorization"
  ].forEach((name) => headers.delete(name));
  headers.set("X-Workspace-Tenant", process.env.WORKBENCH_TENANT || "local");
  headers.set("X-Workspace-User", process.env.WORKBENCH_USER || "demo-user");
  const token = process.env.WORKBENCH_INTERNAL_TOKEN;
  if (token) headers.set("X-Workbench-Token", token);
  else headers.delete("X-Workbench-Token");
  return headers;
}

export function backendUnavailable() {
  return NextResponse.json(
    { success: false, code: "BACKEND_UNAVAILABLE", message: "工作台后端尚未配置" },
    { status: 503 }
  );
}

export async function proxyJson(request: Request, path: string): Promise<Response> {
  if (mockEnabled) return handleMock(request, path);
  if (!externalBackendUrl) return backendUnavailable();
  try {
    const response = await fetch(`${externalBackendUrl}${path}`, {
      method: request.method,
      headers: backendHeaders(request),
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
      cache: "no-store",
      signal: AbortSignal.timeout(15000)
    });
    return new NextResponse(response.body, { status: response.status, headers: response.headers });
  } catch {
    return NextResponse.json(
      { success: false, code: "BACKEND_UNAVAILABLE", message: "工作台后端请求失败" },
      { status: 502 }
    );
  }
}

export async function proxyStream(request: Request, path: string, unavailableMessage = "工作台事件流暂不可用"): Promise<Response> {
  if (mockEnabled) return handleMock(request, path);
  if (!externalBackendUrl) return backendUnavailable();
  try {
    const response = await fetch(`${externalBackendUrl}${path}`, {
      headers: backendHeaders(request),
      cache: "no-store",
      signal: request.signal
    });
    const headers = new Headers(response.headers);
    if (headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
      headers.set("Cache-Control", "no-cache, no-transform");
      headers.set("X-Accel-Buffering", "no");
    }
    return new Response(response.body, { status: response.status, headers });
  } catch {
    return NextResponse.json(
      { success: false, code: "BACKEND_UNAVAILABLE", message: unavailableMessage },
      { status: 502 }
    );
  }
}
