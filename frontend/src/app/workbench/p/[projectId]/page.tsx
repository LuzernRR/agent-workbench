import { WorkbenchEntry } from "@/components/workbench/entry/WorkbenchEntry";

export default async function ProjectWorkbenchPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <WorkbenchEntry initialProjectId={projectId} />;
}
