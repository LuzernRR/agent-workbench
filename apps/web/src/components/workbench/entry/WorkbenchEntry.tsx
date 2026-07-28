"use client";

import { startTransition, useCallback, useOptimistic } from "react";
import { useRouter } from "next/navigation";
import { WorkbenchShell } from "@/components/workbench/app-shell/WorkbenchShell";
import type { S01ProcessFixtureCatalog } from "@/lib/agent-events/v2/process-view-model";
import { workbenchSelectionPath, type WorkbenchSelection } from "@/lib/workbench-selection";

export function WorkbenchEntry({
  initialProjectId = null,
  initialThreadId = null,
  s01ProcessFixture = null
}: {
  initialProjectId?: string | null;
  initialThreadId?: string | null;
  s01ProcessFixture?: S01ProcessFixtureCatalog | null;
}) {
  const router = useRouter();
  const initialProject = initialThreadId ? undefined : initialProjectId;
  const [selection, setOptimisticSelection] = useOptimistic<WorkbenchSelection>({ projectId: initialProject, threadId: initialThreadId });

  const select = useCallback((projectId: string | null, threadId: string | null) => {
    startTransition(() => {
      setOptimisticSelection({ projectId, threadId });
      router.push(workbenchSelectionPath(projectId, threadId), { scroll: false });
    });
  }, [router, setOptimisticSelection]);

  return <WorkbenchShell
    projectId={selection.projectId}
    threadId={selection.threadId}
    onSelectThread={select}
    s01ProcessFixture={s01ProcessFixture}
  />;
}
