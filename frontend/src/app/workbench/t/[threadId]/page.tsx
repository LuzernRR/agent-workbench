import { WorkbenchEntry } from "@/components/workbench/entry/WorkbenchEntry";

export default async function ThreadWorkbenchPage({ params }: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await params;
  return <WorkbenchEntry initialThreadId={threadId} />;
}
