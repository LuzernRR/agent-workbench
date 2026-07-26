import { proxyJson } from "@/server/backend-proxy";

export async function PATCH(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await context.params;
  return proxyJson(request, `/api/v1/projects/${projectId}`);
}

export async function DELETE(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await context.params;
  return proxyJson(request, `/api/v1/projects/${projectId}`);
}
