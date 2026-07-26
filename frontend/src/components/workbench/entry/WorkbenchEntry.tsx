"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCcw } from "lucide-react";
import { WorkbenchShell } from "@/components/workbench/app-shell/WorkbenchShell";
import { workbenchApi } from "@/lib/api/client";
import { getWorkbenchErrorMessage } from "@/lib/errors";

export function WorkbenchEntry() {
  const [selectedThread, setSelectedThread] = useState<{ projectId: string | null; threadId: string | null }>({ projectId: null, threadId: null });
  const projects = useQuery({ queryKey: ["projects"], queryFn: workbenchApi.projects, retry: false });
  const projectIds = (projects.data || []).map((project) => project.id);
  const threads = useQuery({
    queryKey: ["threads", "all", projectIds],
    queryFn: () => workbenchApi.allThreads(projectIds),
    enabled: !projects.isLoading,
    staleTime: 15000,
    retry: false
  });
  const activeProjectId = selectedThread.projectId;
  const activeThreadId = selectedThread.threadId;
  const queryError = projects.error || threads.error;
  const canRenderSelectedThread = activeThreadId !== undefined && (!activeProjectId || projects.isSuccess);
  if (canRenderSelectedThread) return <WorkbenchShell projectId={activeProjectId} threadId={activeThreadId} onSelectThread={(projectId, threadId) => setSelectedThread({ projectId, threadId })} />;
  if (queryError) return <EntryState><div role="alert" aria-live="polite"><p className="text-danger">工作台暂时无法连接</p><p className="mt-1 max-w-sm text-[13px] leading-5 text-secondary">{getWorkbenchErrorMessage(queryError, "请检查工作台服务后重试")}</p></div><button type="button" className="quiet-button mt-3" onClick={() => { void projects.refetch(); void threads.refetch(); }}><RefreshCcw className="size-3.5" />重试</button></EntryState>;
  if (projects.isLoading || threads.isLoading) return <EntryState>正在准备工作台</EntryState>;
  return <EntryState><p>今天想完成什么？</p><button type="button" className="primary-button mt-4" onClick={() => setSelectedThread({ projectId: null, threadId: null })}>新建任务</button></EntryState>;
}

function EntryState({ children }: { children: React.ReactNode }) {
  return <main className="grid h-[100dvh] place-items-center bg-app text-center text-[15px] text-secondary"><div>{children}</div></main>;
}
