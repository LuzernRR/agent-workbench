import { proxyJson } from "@/server/backend-proxy";

export async function GET(request: Request, context: { params: Promise<{ fileId: string }> }) {
  const { fileId } = await context.params;
  return proxyJson(request, `/api/v1/files/${fileId}`);
}
