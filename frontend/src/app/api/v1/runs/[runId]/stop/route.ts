import { proxyJson } from "@/server/backend-proxy";

export async function POST(request: Request, context: { params: Promise<{ runId: string }> }) {
  const { runId } = await context.params;
  return proxyJson(request, `/api/v1/runs/${runId}/stop`);
}
