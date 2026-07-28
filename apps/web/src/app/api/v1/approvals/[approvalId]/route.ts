import { proxyJson } from "@/server/backend-proxy";

export async function POST(request: Request, context: { params: Promise<{ approvalId: string }> }) {
  const { approvalId } = await context.params;
  return proxyJson(request, `/api/v1/approvals/${approvalId}`);
}
