import { proxyJson } from "@/server/backend-proxy";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ runId: string; challengeId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { runId, challengeId } = await context.params;
  return proxyJson(
    request,
    `/api/v1/runs/${encodeURIComponent(runId)}/xiaohongshu-verifications/${encodeURIComponent(challengeId)}`
  );
}

export async function DELETE(request: Request, context: RouteContext) {
  const { runId, challengeId } = await context.params;
  return proxyJson(
    request,
    `/api/v1/runs/${encodeURIComponent(runId)}/xiaohongshu-verifications/${encodeURIComponent(challengeId)}`
  );
}
