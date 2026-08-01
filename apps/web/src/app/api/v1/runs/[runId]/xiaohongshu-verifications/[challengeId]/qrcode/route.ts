import { proxyStream } from "@/server/backend-proxy";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ runId: string; challengeId: string }> }
) {
  const { runId, challengeId } = await context.params;
  return proxyStream(
    request,
    `/api/v1/runs/${encodeURIComponent(runId)}/xiaohongshu-verifications/${encodeURIComponent(challengeId)}/qrcode`,
    "小红书工具账号验证二维码暂不可用"
  );
}
