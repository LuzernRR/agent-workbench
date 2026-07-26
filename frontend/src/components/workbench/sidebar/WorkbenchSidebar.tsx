"use client";

import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import * as Dialog from "@radix-ui/react-dialog";
import * as Popover from "@radix-ui/react-popover";
import { ChevronDown, ChevronRight, Edit3, Folder, FolderInput, FolderMinus, FolderOpen, FolderPlus, PanelLeftClose, PanelsTopLeft, Plus, Settings2, Trash2, X } from "lucide-react";
import type { ProjectSummary, ThreadSummary } from "@/lib/agent-events/types";
import { workbenchApi } from "@/lib/api/client";
import { getWorkbenchErrorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";

type ProjectDialogState = { mode: "create" | "rename"; project?: ProjectSummary } | null;
type SelectionHandler = (projectId: string | null, threadId: string | null) => void;

export function WorkbenchSidebar({ projectId, threadId, onSelectThread, onCollapse }: { projectId: string | null; threadId: string | null; onSelectThread?: SelectionHandler; onCollapse: () => void }) {
  const queryClient = useQueryClient();
  const projects = useQuery({ queryKey: ["projects"], queryFn: workbenchApi.projects });
  const projectIds = (projects.data || []).map((project) => project.id);
  const threads = useQuery({
    queryKey: ["threads", "all", projectIds],
    queryFn: () => workbenchApi.allThreads(projectIds),
    enabled: !projects.isLoading,
    staleTime: 15000
  });
  const [draggedThreadId, setDraggedThreadId] = useState<string | null>(null);
  const draggedThreadIdRef = useRef<string | null>(null);
  const [dropProjectId, setDropProjectId] = useState<string | null | undefined>(undefined);
  const [deleteTarget, setDeleteTarget] = useState<ThreadSummary | null>(null);
  const [projectDeleteTarget, setProjectDeleteTarget] = useState<ProjectSummary | null>(null);
  const [projectDialog, setProjectDialog] = useState<ProjectDialogState>(null);
  const [projectName, setProjectName] = useState("");
  const [threadRenameTarget, setThreadRenameTarget] = useState<ThreadSummary | null>(null);
  const [threadTitle, setThreadTitle] = useState("");
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(() => new Set());

  const threadsByProject = useMemo(() => {
    const groups = new Map<string, ThreadSummary[]>();
    for (const thread of threads.data || []) {
      if (!thread.projectId) continue;
      const group = groups.get(thread.projectId) || [];
      group.push(thread);
      groups.set(thread.projectId, group);
    }
    return groups;
  }, [threads.data]);
  const unassignedThreads = useMemo(() => (threads.data || []).filter((thread) => !thread.projectId), [threads.data]);

  const invalidateNavigation = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["projects"] }),
      queryClient.invalidateQueries({ queryKey: ["threads"] }),
      queryClient.invalidateQueries({ queryKey: ["thread", threadId] })
    ]);
  };

  const moveThread = useMutation({
    mutationFn: ({ id, destinationProjectId }: { id: string; destinationProjectId: string | null }) => workbenchApi.moveThread(id, destinationProjectId),
    onSuccess: async (thread) => {
      await invalidateNavigation();
      setDraggedThreadId(null);
      setDropProjectId(undefined);
      if (thread.id === threadId && thread.projectId !== projectId) onSelectThread?.(thread.projectId, thread.id);
    },
    onError: () => {
      setDraggedThreadId(null);
      setDropProjectId(undefined);
    }
  });

  const renameThread = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => workbenchApi.renameThread(id, title),
    onSuccess: async () => {
      await invalidateNavigation();
      setThreadRenameTarget(null);
    }
  });

  const deleteThread = useMutation({
    mutationFn: (id: string) => workbenchApi.deleteThread(id),
    onSuccess: async (_, id) => {
      const fallback = (threads.data || []).find((candidate) => candidate.id !== id);
      queryClient.removeQueries({ queryKey: ["thread", id] });
      if (id === threadId) onSelectThread?.(fallback?.projectId ?? null, fallback?.id ?? null);
      await invalidateNavigation();
      setDeleteTarget(null);
    }
  });

  const createProject = useMutation({
    mutationFn: () => workbenchApi.createProject({ name: projectName.trim() }),
    onSuccess: async () => {
      await invalidateNavigation();
      setProjectDialog(null);
      setProjectName("");
    }
  });

  const updateProject = useMutation({
    mutationFn: () => projectDialog?.project ? workbenchApi.updateProject(projectDialog.project.id, { name: projectName.trim() }) : Promise.reject(new Error("项目不存在")),
    onSuccess: async () => {
      await invalidateNavigation();
      setProjectDialog(null);
      setProjectName("");
    }
  });

  const deleteProject = useMutation({
    mutationFn: (id: string) => workbenchApi.deleteProject(id),
    onSuccess: async (_, id) => {
      const fallback = (threads.data || []).find((candidate) => candidate.projectId !== id);
      if (id === projectId) onSelectThread?.(fallback?.projectId ?? null, fallback?.id ?? null);
      await invalidateNavigation();
      setProjectDeleteTarget(null);
    }
  });

  const dropThread = (destinationProjectId: string | null, transferredThreadId?: string) => {
    const sourceId = transferredThreadId || draggedThreadIdRef.current || draggedThreadId;
    if (!sourceId || moveThread.isPending) return;
    const source = (threads.data || []).find((thread) => thread.id === sourceId);
    if (!source || source.projectId === destinationProjectId) {
      draggedThreadIdRef.current = null;
      setDraggedThreadId(null);
      setDropProjectId(undefined);
      return;
    }
    draggedThreadIdRef.current = null;
    moveThread.mutate({ id: sourceId, destinationProjectId });
  };

  const openCreateProject = () => {
    setProjectName("");
    setProjectDialog({ mode: "create" });
  };
  const openRenameProject = (project: ProjectSummary) => {
    setProjectName(project.name);
    setProjectDialog({ mode: "rename", project });
  };
  const openRenameThread = (thread: ThreadSummary) => {
    setThreadTitle(thread.title);
    setThreadRenameTarget(thread);
  };
  const startDrag = (thread: ThreadSummary, event: React.PointerEvent) => {
    if (event.button !== 0) return;
    draggedThreadIdRef.current = thread.id;
  };
  const endDrag = () => {
    draggedThreadIdRef.current = null;
    setDraggedThreadId(null);
    setDropProjectId(undefined);
  };
  const toggleProject = (id: string) => {
    setCollapsedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const dialogPending = createProject.isPending || updateProject.isPending;

  return (
    <aside className="flex h-full min-w-0 flex-col bg-sidebar" aria-label="项目与会话">
      <div className="flex min-h-[52px] shrink-0 items-center gap-2.5 border-b border-line px-3 py-2">
        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-ink text-white" aria-hidden><PanelsTopLeft className="size-4" /></span>
        <div className="min-w-0 flex-1 whitespace-normal break-words text-[15px] font-semibold">智能工作台</div>
        <button className="icon-button" onClick={onCollapse} title="折叠左栏" aria-label="折叠左栏"><PanelLeftClose className="size-4" /></button>
      </div>

      <div className="shrink-0 p-2.5">
        <button className="primary-button h-9 w-full justify-start" type="button" onClick={() => onSelectThread?.(null, null)}><Plus className="size-4" />新建会话</button>
        {moveThread.error ? <p role="alert" className="mt-2 px-1 text-[15px] text-danger">{getWorkbenchErrorMessage(moveThread.error, "任务移动失败")}</p> : null}
        {renameThread.error ? <p role="alert" className="mt-2 px-1 text-[15px] text-danger">{getWorkbenchErrorMessage(renameThread.error, "会话重命名失败")}</p> : null}
        {deleteThread.error ? <p role="alert" className="mt-2 px-1 text-[15px] text-danger">{getWorkbenchErrorMessage(deleteThread.error, "会话删除失败")}</p> : null}
        {createProject.error || updateProject.error || deleteProject.error ? <p role="alert" className="mt-2 px-1 text-[15px] text-danger">{getWorkbenchErrorMessage(createProject.error || updateProject.error || deleteProject.error, "项目操作失败")}</p> : null}
      </div>

      <div className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <section aria-labelledby="projects-heading">
          <div className="mb-1 flex items-center justify-between px-2 pt-2"><h2 id="projects-heading" className="text-balance text-[13px] font-semibold text-secondary">项目</h2><button type="button" className="icon-button size-7" onClick={openCreateProject} title="新建项目" aria-label="新建项目"><FolderPlus className="size-4" /></button></div>
          {projects.error ? <NavigationError label="项目加载失败" onRetry={() => void projects.refetch()} /> : null}
          {threads.error ? <NavigationError label="会话加载失败" onRetry={() => void threads.refetch()} /> : null}
          <div className="space-y-0.5" role="tree" aria-label="项目会话树">
            {projects.isLoading ? <NavigationSkeleton rows={3} /> : null}
            {(projects.data || []).map((project) => {
              const projectThreads = threadsByProject.get(project.id) || [];
              const expanded = !collapsedProjectIds.has(project.id);
              const isDropTarget = draggedThreadId !== null && dropProjectId === project.id;
              return <div key={project.id} role="treeitem" aria-expanded={expanded} aria-selected={project.id === projectId}>
                <div className={cn("group flex h-9 min-w-0 items-center rounded-md pr-1", isDropTarget && "bg-white ring-1 ring-ink")} onPointerUp={(event) => { if (event.button === 0) dropThread(project.id); }}>
                  <button type="button" aria-label={`${expanded ? "收起" : "展开"}项目 ${project.name}`} title={project.name} className={cn("flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-left text-[14px] leading-5 text-secondary hover:bg-white hover:text-ink", project.id === projectId && "font-medium text-ink")} onClick={() => toggleProject(project.id)}>
                    {expanded ? <ChevronDown className="size-3.5 shrink-0 text-tertiary" /> : <ChevronRight className="size-3.5 shrink-0 text-tertiary" />}
                    {expanded ? <FolderOpen className="size-4 shrink-0" /> : <Folder className="size-4 shrink-0" />}
                    <span className="min-w-0 flex-1 overflow-hidden text-clip whitespace-nowrap">{project.name}</span>
                    <span className="shrink-0 tabular-nums text-[12px] text-tertiary">{projectThreads.length}</span>
                  </button>
                  <ProjectMenu project={project} onRename={openRenameProject} onDelete={setProjectDeleteTarget} />
                </div>
                {expanded && projectThreads.length ? <div role="group" className="ml-[15px] border-l border-line pl-1.5">
                  {projectThreads.map((thread) => <div key={thread.id} role="treeitem" aria-selected={thread.id === threadId}><ThreadTreeRow thread={thread} projectName={project.name} selected={thread.id === threadId} dragged={draggedThreadId === thread.id} projects={projects.data || []} onSelect={() => onSelectThread?.(thread.projectId, thread.id)} onDragStart={startDrag} onDragEnd={endDrag} onRename={openRenameThread} onMove={(destinationProjectId) => moveThread.mutate({ id: thread.id, destinationProjectId })} onDelete={setDeleteTarget} /></div>)}
                </div> : null}
              </div>;
            })}
            {!projects.isLoading && !projects.data?.length ? <div className="rounded-lg border border-dashed border-line px-3 py-4 text-[14px] leading-5 text-secondary"><p>还没有项目</p><button type="button" className="mt-2 text-ink underline underline-offset-2" onClick={openCreateProject}>创建第一个项目</button></div> : null}
            {!projects.isLoading && threads.isLoading ? <NavigationSkeleton rows={4} detailed /> : null}
          </div>
        </section>

        <section className="mt-4" aria-labelledby="sessions-heading">
          <div className="mb-1 flex items-center justify-between px-2"><h2 id="sessions-heading" className="text-balance text-[13px] font-semibold text-secondary">会话</h2><button type="button" className="icon-button size-7" onClick={() => onSelectThread?.(null, null)} title="新建会话" aria-label="新建会话"><Plus className="size-4" /></button></div>
          {draggedThreadId ? <div role="button" tabIndex={0} aria-label="将会话移出项目" className={cn("mb-2 rounded-md border border-dashed border-line px-3 py-2 text-center text-[13px] text-secondary", dropProjectId === null && "border-ink bg-white text-ink")} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDropProjectId(null); }} onDrop={(event) => { event.preventDefault(); dropThread(null, event.dataTransfer.getData("text/plain")); }}>拖到此处移出项目</div> : null}
          <div className="space-y-0.5" aria-label="会话列表">
            {unassignedThreads.map((thread) => <ThreadTreeRow key={thread.id} thread={thread} selected={thread.id === threadId} dragged={draggedThreadId === thread.id} projects={projects.data || []} onSelect={() => onSelectThread?.(null, thread.id)} onDragStart={startDrag} onDragEnd={endDrag} onRename={openRenameThread} onMove={(destinationProjectId) => moveThread.mutate({ id: thread.id, destinationProjectId })} onDelete={setDeleteTarget} />)}
            {!threads.isLoading && !threads.data?.length ? <div className="rounded-lg border border-dashed border-line px-3 py-4 text-[14px] leading-5 text-secondary"><p>还没有会话</p><button type="button" className="mt-2 text-ink underline underline-offset-2" onClick={() => onSelectThread?.(null, null)}>开始第一个任务</button></div> : null}
          </div>
        </section>
      </div>

      <AlertDialog.Root open={Boolean(deleteTarget)} onOpenChange={(open) => { if (!open && !deleteThread.isPending) setDeleteTarget(null); }}><AlertDialog.Portal><AlertDialog.Overlay className="fixed inset-0 z-40 bg-black/25" /><AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(420px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-line bg-white p-5 shadow-xl"><AlertDialog.Title className="text-balance text-[17px] font-semibold text-ink">删除这个会话？</AlertDialog.Title><AlertDialog.Description className="mt-2 text-pretty text-[15px] leading-6 text-secondary">会话及其运行记录将被永久删除。</AlertDialog.Description><div className="mt-5 flex justify-end gap-2"><AlertDialog.Cancel asChild><button type="button" className="quiet-button" disabled={deleteThread.isPending}>取消</button></AlertDialog.Cancel><AlertDialog.Action asChild><button type="button" className="primary-button bg-danger" disabled={deleteThread.isPending} onClick={(event) => { event.preventDefault(); if (deleteTarget) deleteThread.mutate(deleteTarget.id); }}>{deleteThread.isPending ? "正在删除" : "删除"}</button></AlertDialog.Action></div></AlertDialog.Content></AlertDialog.Portal></AlertDialog.Root>
      <AlertDialog.Root open={Boolean(projectDeleteTarget)} onOpenChange={(open) => { if (!open && !deleteProject.isPending) setProjectDeleteTarget(null); }}><AlertDialog.Portal><AlertDialog.Overlay className="fixed inset-0 z-40 bg-black/25" /><AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(420px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-line bg-white p-5 shadow-xl"><AlertDialog.Title className="text-balance text-[17px] font-semibold text-ink">删除项目“{projectDeleteTarget?.name}”？</AlertDialog.Title><AlertDialog.Description className="mt-2 text-pretty text-[15px] leading-6 text-secondary">项目下的会话、运行记录和成果将一并删除，且无法恢复。</AlertDialog.Description><div className="mt-5 flex justify-end gap-2"><AlertDialog.Cancel asChild><button type="button" className="quiet-button" disabled={deleteProject.isPending}>取消</button></AlertDialog.Cancel><AlertDialog.Action asChild><button type="button" className="primary-button bg-danger" disabled={deleteProject.isPending} onClick={(event) => { event.preventDefault(); if (projectDeleteTarget) deleteProject.mutate(projectDeleteTarget.id); }}>{deleteProject.isPending ? "正在删除" : "删除项目"}</button></AlertDialog.Action></div></AlertDialog.Content></AlertDialog.Portal></AlertDialog.Root>
      <Dialog.Root open={Boolean(projectDialog)} onOpenChange={(open) => { if (!open && !dialogPending) setProjectDialog(null); }}><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-40 bg-black/25" /><Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(460px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-white p-5 shadow-xl outline-none"><Dialog.Title className="text-balance text-[18px] font-semibold text-ink">{projectDialog?.mode === "rename" ? "重命名项目" : "新建项目"}</Dialog.Title><Dialog.Description className="mt-1 text-pretty text-[15px] leading-6 text-secondary">用项目整理相关会话。</Dialog.Description><form className="mt-5 space-y-4" onSubmit={(event) => { event.preventDefault(); if (!projectName.trim()) return; if (projectDialog?.mode === "rename") updateProject.mutate(); else createProject.mutate(); }}><label className="block text-[15px] font-medium text-ink" htmlFor="project-name">项目名称<input id="project-name" autoFocus value={projectName} onChange={(event) => setProjectName(event.target.value)} maxLength={160} className="mt-1.5 h-10 w-full rounded-lg border border-line bg-white px-3 text-[16px] outline-none focus:border-ink" placeholder="例如：产品规划" /></label><div className="flex justify-end gap-2"><Dialog.Close asChild><button type="button" className="quiet-button" disabled={dialogPending}>取消</button></Dialog.Close><button type="submit" className="primary-button" disabled={dialogPending || !projectName.trim()}>{dialogPending ? "正在保存" : projectDialog?.mode === "rename" ? "保存" : "创建项目"}</button></div></form><Dialog.Close asChild><button type="button" className="icon-button absolute right-3 top-3" aria-label="关闭项目对话框" title="关闭"><X className="size-4" /></button></Dialog.Close></Dialog.Content></Dialog.Portal></Dialog.Root>
      <Dialog.Root open={Boolean(threadRenameTarget)} onOpenChange={(open) => { if (!open && !renameThread.isPending) setThreadRenameTarget(null); }}><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-40 bg-black/25" /><Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(420px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-white p-5 shadow-xl outline-none"><Dialog.Title className="text-balance text-[18px] font-semibold text-ink">重命名会话</Dialog.Title><Dialog.Description className="mt-1 text-pretty text-[15px] leading-6 text-secondary">修改侧栏中显示的名称。</Dialog.Description><form className="mt-5" onSubmit={(event) => { event.preventDefault(); if (threadRenameTarget && threadTitle.trim()) renameThread.mutate({ id: threadRenameTarget.id, title: threadTitle.trim() }); }}><label className="block text-[15px] font-medium text-ink" htmlFor="thread-title">会话名称<input id="thread-title" autoFocus value={threadTitle} onChange={(event) => setThreadTitle(event.target.value)} maxLength={240} className="mt-1.5 h-10 w-full rounded-lg border border-line bg-white px-3 text-[16px] outline-none focus:border-ink" /></label><div className="mt-4 flex justify-end gap-2"><Dialog.Close asChild><button type="button" className="quiet-button" disabled={renameThread.isPending}>取消</button></Dialog.Close><button type="submit" className="primary-button" disabled={renameThread.isPending || !threadTitle.trim()}>{renameThread.isPending ? "正在保存" : "保存"}</button></div></form><Dialog.Close asChild><button type="button" className="icon-button absolute right-3 top-3" aria-label="关闭会话重命名对话框" title="关闭"><X className="size-4" /></button></Dialog.Close></Dialog.Content></Dialog.Portal></Dialog.Root>
    </aside>
  );
}

function ThreadTreeRow({ thread, projectName, selected, dragged, projects, onSelect, onDragStart, onDragEnd, onRename, onMove, onDelete }: {
  thread: ThreadSummary;
  projectName?: string;
  selected: boolean;
  dragged: boolean;
  projects: ProjectSummary[];
  onSelect: () => void;
  onDragStart: (thread: ThreadSummary, event: React.PointerEvent) => void;
  onDragEnd: () => void;
  onRename: (thread: ThreadSummary) => void;
  onMove: (projectId: string | null) => void;
  onDelete: (thread: ThreadSummary) => void;
}) {
  const timestamp = thread.lastUserMessageAt ?? thread.updatedAt;
  return <div
    data-testid="thread-row"
    data-project-id={thread.projectId ?? ""}
    onPointerDown={(event) => onDragStart(thread, event)}
    onPointerUp={onDragEnd}
    onPointerCancel={onDragEnd}
    className={cn("group flex h-9 w-full min-w-0 items-center rounded-md pr-1 text-[14px] leading-5 text-secondary hover:bg-white hover:text-ink", selected && "bg-white text-ink ring-1 ring-line", dragged && "opacity-50")}
  >
    <button type="button" aria-label={projectName ? `${thread.title} ${projectName}` : thread.title} onClick={onSelect} className="flex h-full min-w-0 flex-1 items-center gap-2 px-2 text-left" title={thread.title}>
      <span className="status-dot shrink-0" data-status={thread.status} />
      <span data-testid="thread-title" className="min-w-0 flex-1 overflow-hidden text-clip whitespace-nowrap">{thread.title}</span>
      <time className="shrink-0 tabular-nums text-[12px] text-tertiary" dateTime={timestamp}>{formatThreadTime(timestamp)}</time>
    </button>
    <ThreadMenu thread={thread} projects={projects} onRename={onRename} onMove={onMove} onDelete={onDelete} />
  </div>;
}

function ProjectMenu({ project, onRename, onDelete }: { project: ProjectSummary; onRename: (project: ProjectSummary) => void; onDelete: (project: ProjectSummary) => void }) {
  return <Popover.Root><Popover.Trigger asChild><button type="button" className="icon-button mt-1 size-7 shrink-0 opacity-0 focus:opacity-100 group-hover:opacity-100" aria-label={`管理项目 ${project.name}`} title={`管理项目 ${project.name}`}><Settings2 className="size-4" /></button></Popover.Trigger><Popover.Portal><Popover.Content side="right" align="start" sideOffset={6} className="z-50 w-44 rounded-lg border border-line bg-white p-1.5 shadow-popover"><Popover.Close asChild><button type="button" className="flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-[15px] text-secondary hover:bg-panel hover:text-ink" onClick={() => onRename(project)}><Edit3 className="size-4" />重命名项目</button></Popover.Close><Popover.Close asChild><button type="button" className="mt-1 flex min-h-9 w-full items-center gap-2 border-t border-line px-2 pt-1 text-left text-[15px] text-danger" onClick={() => onDelete(project)}><Trash2 className="size-4" />删除项目</button></Popover.Close></Popover.Content></Popover.Portal></Popover.Root>;
}

function NavigationSkeleton({ rows, detailed = false }: { rows: number; detailed?: boolean }) {
  return <div role="status" aria-label={detailed ? "正在加载会话" : "正在加载项目"} className="space-y-1 py-1" aria-live="polite">{Array.from({ length: rows }, (_, index) => <div key={index} className={cn("animate-pulse rounded-lg bg-white/55 px-2", detailed ? "h-12" : "h-10")} aria-hidden><div className={cn("h-2.5 rounded-full bg-[#e8e8e6]", detailed ? "mt-2 w-3/4" : "mt-3.5 w-2/3")} />{detailed ? <div className="mt-2 h-2 w-1/2 rounded-full bg-[#eeeeec]" /> : null}</div>)}</div>;
}

function ThreadMenu({ thread, projects, onRename, onMove, onDelete }: { thread: ThreadSummary; projects: ProjectSummary[]; onRename: (thread: ThreadSummary) => void; onMove: (projectId: string | null) => void; onDelete: (thread: ThreadSummary) => void }) {
  return <Popover.Root><Popover.Trigger asChild><button type="button" className="icon-button mt-1.5 size-7 shrink-0 opacity-0 focus:opacity-100 group-hover:opacity-100" aria-label={`管理会话 ${thread.title}`} title={`管理会话 ${thread.title}`}><Settings2 className="size-4" /></button></Popover.Trigger><Popover.Portal><Popover.Content side="right" align="start" sideOffset={6} className="z-50 max-h-[min(520px,80dvh)] w-56 overflow-y-auto rounded-lg border border-line bg-white p-1.5 shadow-popover"><Popover.Close asChild><button type="button" className="flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-[15px] text-secondary hover:bg-panel hover:text-ink" onClick={() => onRename(thread)}><Edit3 className="size-4" />重命名会话</button></Popover.Close>{thread.projectId ? <Popover.Close asChild><button type="button" className="flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-[15px] text-secondary hover:bg-panel hover:text-ink" onClick={() => onMove(null)}><FolderMinus className="size-4" />移出项目</button></Popover.Close> : null}<div className="px-2 py-1 text-[14px] text-tertiary">移入项目</div>{projects.filter((candidate) => candidate.id !== thread.projectId).map((candidate) => <Popover.Close asChild key={candidate.id}><button type="button" className="flex min-h-9 w-full items-start gap-2 rounded-md px-2 py-2 text-left text-[15px] text-secondary hover:bg-panel hover:text-ink" title={candidate.name} onClick={() => onMove(candidate.id)}><FolderInput className="mt-0.5 size-4 shrink-0" /><span className="whitespace-normal break-words leading-5">{candidate.name}</span></button></Popover.Close>)}<Popover.Close asChild><button type="button" className="mt-1 flex min-h-9 w-full items-center gap-2 border-t border-line px-2 pt-1 text-left text-[15px] text-danger" onClick={() => onDelete(thread)}><Trash2 className="size-4" />删除会话</button></Popover.Close></Popover.Content></Popover.Portal></Popover.Root>;
}

function NavigationError({ label, onRetry }: { label: string; onRetry: () => void }) {
  return <div role="alert" className="mb-2 flex items-center gap-2 px-2 text-[14px] text-danger"><span className="min-w-0 flex-1">{label}</span><button type="button" className="shrink-0 text-ink underline underline-offset-2" onClick={onRetry}>重试</button></div>;
}

function formatThreadTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  const now = new Date();
  const diffMs = Math.max(0, now.getTime() - date.getTime());
  const diffMinutes = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMinutes < 1) return "刚刚";
  if (diffMinutes < 60) return `${diffMinutes}分前`;
  if (diffHours < 24) return `${diffHours}小时前`;
  if (diffDays < 7) return `${diffDays}天前`;
  if (date.getFullYear() === now.getFullYear()) return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(date);
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "numeric", day: "numeric" }).format(date);
}
