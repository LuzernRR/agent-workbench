import { proxyJson } from "@/server/backend-proxy";

export async function POST(request: Request, context: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await context.params;
  return proxyJson(request, `/api/v1/threads/${threadId}/attachments`);
}
