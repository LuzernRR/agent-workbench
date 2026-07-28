import { proxyJson } from "@/server/backend-proxy";

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await context.params;
  return proxyJson(request, `/api/v1/projects/${projectId}/threads`);
}

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await context.params;
  return proxyJson(request, `/api/v1/projects/${projectId}/threads`);
}
