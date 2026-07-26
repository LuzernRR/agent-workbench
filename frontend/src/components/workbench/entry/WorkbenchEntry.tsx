"use client";

import { startTransition, useCallback, useOptimistic } from "react";
import { useRouter } from "next/navigation";
import { WorkbenchShell } from "@/components/workbench/app-shell/WorkbenchShell";
import { workbenchSelectionPath, type WorkbenchSelection } from "@/lib/workbench-selection";

export function WorkbenchEntry({ initialProjectId = null, initialThreadId = null }: { initialProjectId?: string | null; initialThreadId?: string | null }) {
  const router = useRouter();
  const initialProject = initialThreadId ? undefined : initialProjectId;
  const [selection, setOptimisticSelection] = useOptimistic<WorkbenchSelection>({ projectId: initialProject, threadId: initialThreadId });

  const select = useCallback((projectId: string | null, threadId: string | null) => {
    startTransition(() => {
      setOptimisticSelection({ projectId, threadId });
      router.push(workbenchSelectionPath(projectId, threadId), { scroll: false });
    });
  }, [router, setOptimisticSelection]);

  return <WorkbenchShell projectId={selection.projectId} threadId={selection.threadId} onSelectThread={select} />;
}
