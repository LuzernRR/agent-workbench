import { proxyStream } from "@/server/backend-proxy";

export async function GET(request: Request, context: { params: Promise<{ attachmentId: string }> }) {
  const { attachmentId } = await context.params;
  return proxyStream(request, `/api/v1/attachments/${attachmentId}`, "附件暂时无法读取");
}
