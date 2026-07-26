import { proxyJson } from "@/server/backend-proxy";

export async function GET(request: Request, context: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await context.params;
  return proxyJson(request, `/api/v1/threads/${threadId}`);
}

export async function PATCH(request: Request, context: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await context.params;
  return proxyJson(request, `/api/v1/threads/${threadId}`);
}

export async function DELETE(request: Request, context: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await context.params;
  return proxyJson(request, `/api/v1/threads/${threadId}`);
}
