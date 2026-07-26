import { NextResponse } from "next/server";
import { handleMock } from "@/server/mock/handler";
import { handleLive } from "@/server/live/handler";

export const externalBackendUrl = process.env.WORKBENCH_API_ORIGIN?.replace(/\/$/, "") || null;

/** 未配置外部后端时，测试端口显式使用 fixture，正式端口进入 PostgreSQL live runtime。 */
const fixtureMode = process.env.WORKBENCH_LLM_MODE === "mock";

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

export async function proxyJson(request: Request, path: string): Promise<Response> {
  if (!externalBackendUrl) return fixtureMode ? handleMock(request, path) : handleLive(request, path);
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
  if (!externalBackendUrl) return fixtureMode ? handleMock(request, path) : handleLive(request, path);
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
