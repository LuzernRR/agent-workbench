import { proxyStream } from "@/server/backend-proxy";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ runId: string }> }) {
  const { runId } = await context.params;
  const url = new URL(request.url);
  return proxyStream(request, `/api/v1/runs/${runId}/events${url.search}`);
}
