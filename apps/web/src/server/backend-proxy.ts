import { NextResponse } from "next/server";
import { handleMock } from "@/server/mock/handler";
import { handleLive } from "@/server/live/handler";
import { resolveVisitor, VisitorSessionError } from "@/server/session/visitor";

export const externalBackendUrl = process.env.WORKBENCH_API_ORIGIN?.replace(/\/$/, "") || null;

/** 未配置外部后端时，测试端口显式使用 fixture，正式端口进入 PostgreSQL live runtime。 */
const fixtureMode = process.env.WORKBENCH_LLM_MODE === "mock";

async function backendHeaders(request: Request) {
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
  // Derive the forwarded principal from the visitor session rather than the
  // environment, and overwrite whatever the client sent: a caller-supplied
  // tenant header is an assertion, not authorization.
  const principal = await resolveVisitor(request);
  headers.set("X-Workspace-Tenant", principal.tenantId);
  headers.set("X-Workspace-User", principal.id);
  const token = process.env.WORKBENCH_INTERNAL_TOKEN;
  if (token) headers.set("X-Workbench-Token", token);
  else headers.delete("X-Workbench-Token");
  return headers;
}

const unauthorized = () => NextResponse.json(
  { success: false, code: "VISITOR_SESSION_INVALID", message: "匿名会话凭证无效" },
  { status: 401 }
);

export async function proxyJson(request: Request, path: string): Promise<Response> {
  if (!externalBackendUrl) return fixtureMode ? handleMock(request, path) : handleLive(request, path);
  // Resolve outside the try: an invalid session is a 401, not a backend outage.
  let headers: Headers;
  try {
    headers = await backendHeaders(request);
  } catch (error) {
    if (error instanceof VisitorSessionError) return unauthorized();
    throw error;
  }
  try {
    const response = await fetch(`${externalBackendUrl}${path}`, {
      method: request.method,
      headers,
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
  let requestHeaders: Headers;
  try {
    requestHeaders = await backendHeaders(request);
  } catch (error) {
    if (error instanceof VisitorSessionError) return unauthorized();
    throw error;
  }
  try {
    const response = await fetch(`${externalBackendUrl}${path}`, {
      headers: requestHeaders,
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
