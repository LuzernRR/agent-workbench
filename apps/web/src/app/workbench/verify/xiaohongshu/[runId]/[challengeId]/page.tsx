import type { Metadata } from "next";
import { XiaohongshuVerificationView } from "@/components/workbench/verification/XiaohongshuVerificationView";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "小红书工具账号验证 | Agent Workbench",
  robots: { index: false, follow: false }
};

export default async function XiaohongshuVerificationPage({
  params
}: {
  params: Promise<{ runId: string; challengeId: string }>;
}) {
  const { runId, challengeId } = await params;
  return <XiaohongshuVerificationView runId={runId} challengeId={challengeId} />;
}
