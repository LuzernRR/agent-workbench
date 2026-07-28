"use client";

import { Children, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import * as Dialog from "@radix-ui/react-dialog";
import * as Popover from "@radix-ui/react-popover";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragCancelEvent,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent
} from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronDown, ChevronRight, Edit3, Folder, FolderInput, FolderMinus, FolderOpen, FolderPlus, GripVertical, PanelLeftClose, PanelsTopLeft, Plus, Settings2, Trash2, X } from "lucide-react";
import type { ProjectSummary, ThreadSummary } from "@/lib/agent-events/types";
import { workbenchApi } from "@/lib/api/client";
import { getWorkbenchErrorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";

type ProjectDialogState = { mode: "create" | "rename"; project?: ProjectSummary } | null;
type SelectionHandler = (projectId: string | null, threadId: string | null) => void;
type ActiveDrag = { type: "project"; projectId: string } | { type: "thread"; threadId: string };
type ThreadCacheContext = { previous: ThreadSummary[] | undefined; key: readonly ["threads", "all", string[]] };
type ProjectCacheContext = { previous: ProjectSummary[] | undefined };
type MoveThreadInput = { id: string; destinationProjectId: string | null; optimistic?: ThreadCacheContext };
type ReorderProjectsInput = { ids: string[]; optimistic?: ProjectCacheContext };

const projectDragId = (id: string) => `project:${id}`;
const threadDragId = (id: string) => `thread:${id}`;
const UNASSIGNED_DROP_ID = "drop:unassigned";

export function WorkbenchSidebar({ projectId, threadId, onSelectThread, onCollapse }: { projectId: string | null; threadId: string | null; onSelectThread?: SelectionHandler; onCollapse: () => void }) {
  const queryClient = useQueryClient();
  const projects = useQuery({ queryKey: ["projects"], queryFn: workbenchApi.projects, staleTime: 15_000 });
  const projectIds = (projects.data || []).map((project) => project.id);
  const threads = useQuery({
    queryKey: ["threads", "all", projectIds],
    queryFn: () => workbenchApi.allThreads(projectIds),
    enabled: !projects.isLoading,
    staleTime: 15_000
  });
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 1 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const [activeDrag, setActiveDrag] = useState<ActiveDrag | null>(null);
  const [overProjectId, setOverProjectId] = useState<string | null | undefined>(undefined);
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
      threadId ? queryClient.invalidateQueries({ queryKey: ["thread", threadId] }) : Promise.resolve()
    ]);
  };

  const optimisticallyMoveThread = (id: string, destinationProjectId: string | null): ThreadCacheContext => {
    const cancellation = queryClient.cancelQueries({ queryKey: ["threads"] });
    const key = ["threads", "all", projectIds] as const;
    const previous = queryClient.getQueryData<ThreadSummary[]>(key);
    queryClient.setQueryData<ThreadSummary[]>(key, (current) => (current || []).map((thread) => thread.id === id ? { ...thread, projectId: destinationProjectId, updatedAt: new Date().toISOString() } : thread));
    if (id === threadId) onSelectThread?.(destinationProjectId, id);
    void cancellation;
    return { previous, key };
  };
  const optimisticallyReorderProjects = (ids: string[]): ProjectCacheContext => {
    const cancellation = queryClient.cancelQueries({ queryKey: ["projects"] });
    const previous = queryClient.getQueryData<ProjectSummary[]>(["projects"]);
    const byId = new Map((previous || []).map((project) => [project.id, project]));
    queryClient.setQueryData<ProjectSummary[]>(["projects"], ids.map((id) => byId.get(id)).filter((project): project is ProjectSummary => Boolean(project)));
    void cancellation;
    return { previous };
  };

  const moveThread = useMutation({
    mutationFn: ({ id, destinationProjectId }: MoveThreadInput) => workbenchApi.moveThread(id, destinationProjectId),
    onMutate: ({ id, destinationProjectId, optimistic }) => optimistic ?? optimisticallyMoveThread(id, destinationProjectId),
    onError: (_error, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(context.key, context.previous);
    },
    onSettled: () => void invalidateNavigation()
  });

  const reorderProjects = useMutation({
    mutationFn: ({ ids }: ReorderProjectsInput) => workbenchApi.reorderProjects(ids),
    onMutate: ({ ids, optimistic }) => optimistic ?? optimisticallyReorderProjects(ids),
    onError: (_error, _input, context) => {
      if (context?.previous) queryClient.setQueryData(["projects"], context.previous);
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["projects"] })
  });

  const renameThread = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => workbenchApi.renameThread(id, title),
    onSuccess: async () => { await invalidateNavigation(); setThreadRenameTarget(null); }
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
    onSuccess: async (project) => {
      await invalidateNavigation();
      setProjectDialog(null);
      setProjectName("");
      onSelectThread?.(project.id, null);
    }
  });
  const updateProject = useMutation({
    mutationFn: () => projectDialog?.project ? workbenchApi.updateProject(projectDialog.project.id, { name: projectName.trim() }) : Promise.reject(new Error("项目不存在")),
    onSuccess: async () => { await invalidateNavigation(); setProjectDialog(null); setProjectName(""); }
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

  const openCreateProject = () => { setProjectName(""); setProjectDialog({ mode: "create" }); };
  const openRenameProject = (project: ProjectSummary) => { setProjectName(project.name); setProjectDialog({ mode: "rename", project }); };
  const openRenameThread = (thread: ThreadSummary) => { setThreadTitle(thread.title); setThreadRenameTarget(thread); };
  const toggleProject = (id: string) => setCollapsedProjectIds((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const dialogPending = createProject.isPending || updateProject.isPending;

  const destinationFor = (event: DragOverEvent | DragEndEvent) => {
    const over = event.over;
    if (!over) return undefined;
    if (over.id === UNASSIGNED_DROP_ID) return null;
    const data = over.data.current;
    if (data?.type === "project") return String(data.projectId);
    if (data?.type === "thread") return (threads.data || []).find((thread) => thread.id === data.threadId)?.projectId ?? null;
    return undefined;
  };
  const resetDrag = () => { setActiveDrag(null); setOverProjectId(undefined); };
  const onDragStart = (event: DragStartEvent) => {
    const data = event.active.data.current;
    if (data?.type === "project") setActiveDrag({ type: "project", projectId: String(data.projectId) });
    if (data?.type === "thread") setActiveDrag({ type: "thread", threadId: String(data.threadId) });
  };
  const onDragOver = (event: DragOverEvent) => {
    if (activeDrag?.type === "thread") setOverProjectId(destinationFor(event));
  };
  const onDragCancel = (_event: DragCancelEvent) => resetDrag();
  const onDragEnd = (event: DragEndEvent) => {
    const active = activeDrag;
    if (active?.type === "project" && event.over) {
      const current = projects.data || [];
      const from = current.findIndex((project) => project.id === active.projectId);
      const overData = event.over.data.current;
      const targetProjectId = overData?.type === "project" ? String(overData.projectId) : overData?.type === "thread" ? (threads.data || []).find((thread) => thread.id === overData.threadId)?.projectId : null;
      const to = current.findIndex((project) => project.id === targetProjectId);
      if (from >= 0 && to >= 0 && from !== to) {
        const ids = arrayMove(current, from, to).map((project) => project.id);
        reorderProjects.mutate({ ids, optimistic: optimisticallyReorderProjects(ids) });
      }
    }
    if (active?.type === "thread") {
      const source = (threads.data || []).find((thread) => thread.id === active.threadId);
      const destination = destinationFor(event);
      if (source && destination !== undefined && source.projectId !== destination) {
        moveThread.mutate({ id: source.id, destinationProjectId: destination, optimistic: optimisticallyMoveThread(source.id, destination) });
      }
    }
    resetDrag();
  };

  const activeLabel = activeDrag?.type === "project"
    ? projects.data?.find((project) => project.id === activeDrag.projectId)?.name
    : activeDrag?.type === "thread" ? threads.data?.find((thread) => thread.id === activeDrag.threadId)?.title : null;

  return (
    <aside className="flex h-full min-w-0 flex-col bg-sidebar" aria-label="项目与会话">
      <div className="flex min-h-[52px] shrink-0 items-center gap-2.5 border-b border-line px-3 py-2">
        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-ink text-white" aria-hidden><PanelsTopLeft className="size-4" /></span>
        <div className="min-w-0 flex-1 overflow-hidden text-clip whitespace-nowrap text-[15px] font-semibold">智能工作台</div>
        <button className="icon-button" onClick={onCollapse} title="折叠左栏" aria-label="折叠左栏"><PanelLeftClose className="size-4" /></button>
      </div>

      <div className="shrink-0 p-2.5">
        <button className="primary-button h-9 w-full justify-start" type="button" onClick={() => onSelectThread?.(null, null)}><Plus className="size-4" />新建会话</button>
        {moveThread.error ? <NavigationAlert error={moveThread.error} fallback="会话移动失败" /> : null}
        {reorderProjects.error ? <NavigationAlert error={reorderProjects.error} fallback="项目排序失败" /> : null}
        {renameThread.error ? <NavigationAlert error={renameThread.error} fallback="会话重命名失败" /> : null}
        {deleteThread.error ? <NavigationAlert error={deleteThread.error} fallback="会话删除失败" /> : null}
        {createProject.error || updateProject.error || deleteProject.error ? <NavigationAlert error={createProject.error || updateProject.error || deleteProject.error} fallback="项目操作失败" /> : null}
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={onDragStart} onDragOver={onDragOver} onDragCancel={onDragCancel} onDragEnd={onDragEnd}>
        <div className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          <section aria-labelledby="projects-heading">
            <div className="mb-1 flex items-center justify-between px-2 pt-2"><h2 id="projects-heading" className="text-[13px] font-semibold text-secondary">项目</h2><button type="button" className="icon-button size-7" onClick={openCreateProject} title="新建项目" aria-label="新建项目"><FolderPlus className="size-4" /></button></div>
            {projects.error ? <NavigationError label="项目加载失败" onRetry={() => void projects.refetch()} /> : null}
            {threads.error ? <NavigationError label="会话加载失败" onRetry={() => void threads.refetch()} /> : null}
            <SortableContext items={(projects.data || []).map((project) => projectDragId(project.id))} strategy={verticalListSortingStrategy}>
              <div className="space-y-0.5" role="tree" aria-label="项目会话树">
                {projects.isLoading ? <NavigationSkeleton rows={3} /> : null}
                {(projects.data || []).map((project) => {
                  const projectThreads = threadsByProject.get(project.id) || [];
                  const expanded = !collapsedProjectIds.has(project.id);
                  return <ProjectTreeItem key={project.id} project={project} expanded={expanded} selected={project.id === projectId && !threadId} dropTarget={activeDrag?.type === "thread" && overProjectId === project.id} onToggle={() => toggleProject(project.id)} onSelect={() => onSelectThread?.(project.id, null)} onRename={openRenameProject} onDelete={setProjectDeleteTarget}>
                    {projectThreads.map((thread) => <ThreadTreeRow key={thread.id} thread={thread} projectName={project.name} selected={thread.id === threadId} projects={projects.data || []} onSelect={() => onSelectThread?.(thread.projectId, thread.id)} onRename={openRenameThread} onMove={(destinationProjectId) => moveThread.mutate({ id: thread.id, destinationProjectId })} onDelete={setDeleteTarget} />)}
                  </ProjectTreeItem>;
                })}
                {!projects.isLoading && threads.isLoading ? <NavigationSkeleton rows={4} detailed /> : null}
              </div>
            </SortableContext>
          </section>

          <UnassignedDropZone active={activeDrag?.type === "thread"} over={activeDrag?.type === "thread" && overProjectId === null}>
            <section className="mt-4" aria-labelledby="sessions-heading">
              <div className="mb-1 flex items-center justify-between px-2"><h2 id="sessions-heading" className="text-[13px] font-semibold text-secondary">会话</h2><button type="button" className="icon-button size-7" onClick={() => onSelectThread?.(null, null)} title="新建会话" aria-label="新建会话"><Plus className="size-4" /></button></div>
              {activeDrag?.type === "thread" ? <div className={cn("mb-1 grid h-9 place-items-center rounded-md bg-white/55 text-[13px] text-secondary transition-all duration-200", overProjectId === null && "bg-[#e9e9e6] text-ink")}>移出项目</div> : null}
              <div className="space-y-0.5" aria-label="会话列表">
                {unassignedThreads.map((thread) => <ThreadTreeRow key={thread.id} thread={thread} selected={thread.id === threadId} projects={projects.data || []} onSelect={() => onSelectThread?.(null, thread.id)} onRename={openRenameThread} onMove={(destinationProjectId) => moveThread.mutate({ id: thread.id, destinationProjectId })} onDelete={setDeleteTarget} />)}
              </div>
            </section>
          </UnassignedDropZone>
        </div>
        <DragOverlay dropAnimation={null} adjustScale={false}>
          {activeLabel ? <div className="pointer-events-none flex h-9 max-w-60 items-center gap-2 rounded-lg bg-white px-3 text-[14px] font-medium text-ink shadow-popover"><GripVertical className="size-4 text-tertiary" /><span className="min-w-0 overflow-hidden text-clip whitespace-nowrap">{activeLabel}</span></div> : null}
        </DragOverlay>
      </DndContext>

      <AlertDialog.Root open={Boolean(deleteTarget)} onOpenChange={(open) => { if (!open && !deleteThread.isPending) setDeleteTarget(null); }}><AlertDialog.Portal><AlertDialog.Overlay className="fixed inset-0 z-40 bg-black/25" /><AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(420px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-5 shadow-xl"><AlertDialog.Title className="text-[17px] font-semibold text-ink">删除这个会话？</AlertDialog.Title><AlertDialog.Description className="mt-2 text-[15px] leading-6 text-secondary">会话及其运行记录将被永久删除。</AlertDialog.Description><div className="mt-5 flex justify-end gap-2"><AlertDialog.Cancel asChild><button type="button" className="quiet-button" disabled={deleteThread.isPending}>取消</button></AlertDialog.Cancel><AlertDialog.Action asChild><button type="button" className="primary-button bg-danger" disabled={deleteThread.isPending} onClick={(event) => { event.preventDefault(); if (deleteTarget) deleteThread.mutate(deleteTarget.id); }}>{deleteThread.isPending ? "正在删除" : "删除"}</button></AlertDialog.Action></div></AlertDialog.Content></AlertDialog.Portal></AlertDialog.Root>
      <AlertDialog.Root open={Boolean(projectDeleteTarget)} onOpenChange={(open) => { if (!open && !deleteProject.isPending) setProjectDeleteTarget(null); }}><AlertDialog.Portal><AlertDialog.Overlay className="fixed inset-0 z-40 bg-black/25" /><AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(420px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-5 shadow-xl"><AlertDialog.Title className="text-[17px] font-semibold text-ink">删除项目“{projectDeleteTarget?.name}”？</AlertDialog.Title><AlertDialog.Description className="mt-2 text-[15px] leading-6 text-secondary">项目下的会话、运行记录和附件将一并删除，且无法恢复。</AlertDialog.Description><div className="mt-5 flex justify-end gap-2"><AlertDialog.Cancel asChild><button type="button" className="quiet-button" disabled={deleteProject.isPending}>取消</button></AlertDialog.Cancel><AlertDialog.Action asChild><button type="button" className="primary-button bg-danger" disabled={deleteProject.isPending} onClick={(event) => { event.preventDefault(); if (projectDeleteTarget) deleteProject.mutate(projectDeleteTarget.id); }}>{deleteProject.isPending ? "正在删除" : "删除项目"}</button></AlertDialog.Action></div></AlertDialog.Content></AlertDialog.Portal></AlertDialog.Root>
      <Dialog.Root open={Boolean(projectDialog)} onOpenChange={(open) => { if (!open && !dialogPending) setProjectDialog(null); }}><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-40 bg-black/25" /><Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(460px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-5 shadow-xl outline-none"><Dialog.Title className="text-[18px] font-semibold text-ink">{projectDialog?.mode === "rename" ? "重命名项目" : "新建项目"}</Dialog.Title><Dialog.Description className="mt-1 text-[15px] leading-6 text-secondary">用项目整理相关会话。</Dialog.Description><form className="mt-5" onSubmit={(event) => { event.preventDefault(); if (!projectName.trim()) return; if (projectDialog?.mode === "rename") updateProject.mutate(); else createProject.mutate(); }}><label className="block text-[14px] font-medium text-secondary" htmlFor="project-name">项目名称</label><input id="project-name" autoFocus value={projectName} onChange={(event) => setProjectName(event.target.value)} maxLength={160} className="borderless-field mt-2 h-11 w-full rounded-xl border-0 bg-panel px-3 text-[16px] text-ink outline-none ring-0 placeholder:text-tertiary" placeholder="例如：产品规划" /><div className="mt-5 flex justify-end gap-2"><Dialog.Close asChild><button type="button" className="quiet-button" disabled={dialogPending}>取消</button></Dialog.Close><button type="submit" className="primary-button" disabled={dialogPending || !projectName.trim()}>{dialogPending ? "正在保存" : projectDialog?.mode === "rename" ? "保存" : "创建项目"}</button></div></form><Dialog.Close asChild><button type="button" className="icon-button absolute right-3 top-3" aria-label="关闭项目对话框" title="关闭"><X className="size-4" /></button></Dialog.Close></Dialog.Content></Dialog.Portal></Dialog.Root>
      <Dialog.Root open={Boolean(threadRenameTarget)} onOpenChange={(open) => { if (!open && !renameThread.isPending) setThreadRenameTarget(null); }}><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-40 bg-black/25" /><Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(420px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-5 shadow-xl outline-none"><Dialog.Title className="text-[18px] font-semibold text-ink">重命名会话</Dialog.Title><Dialog.Description className="mt-1 text-[15px] leading-6 text-secondary">修改侧栏中显示的名称。</Dialog.Description><form className="mt-5" onSubmit={(event) => { event.preventDefault(); if (threadRenameTarget && threadTitle.trim()) renameThread.mutate({ id: threadRenameTarget.id, title: threadTitle.trim() }); }}><label className="block text-[14px] font-medium text-secondary" htmlFor="thread-title">会话名称</label><input id="thread-title" autoFocus value={threadTitle} onChange={(event) => setThreadTitle(event.target.value)} maxLength={240} className="borderless-field mt-2 h-11 w-full rounded-xl border-0 bg-panel px-3 text-[16px] text-ink outline-none ring-0" /><div className="mt-5 flex justify-end gap-2"><Dialog.Close asChild><button type="button" className="quiet-button" disabled={renameThread.isPending}>取消</button></Dialog.Close><button type="submit" className="primary-button" disabled={renameThread.isPending || !threadTitle.trim()}>{renameThread.isPending ? "正在保存" : "保存"}</button></div></form><Dialog.Close asChild><button type="button" className="icon-button absolute right-3 top-3" aria-label="关闭会话重命名对话框" title="关闭"><X className="size-4" /></button></Dialog.Close></Dialog.Content></Dialog.Portal></Dialog.Root>
    </aside>
  );
}

function ProjectTreeItem({ project, expanded, selected, dropTarget, onToggle, onSelect, onRename, onDelete, children }: { project: ProjectSummary; expanded: boolean; selected: boolean; dropTarget: boolean; onToggle: () => void; onSelect: () => void; onRename: (project: ProjectSummary) => void; onDelete: (project: ProjectSummary) => void; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: projectDragId(project.id), data: { type: "project", projectId: project.id } });
  const style = { transform: isDragging ? undefined : CSS.Transform.toString(transform), transition: isDragging ? "opacity 120ms ease-out" : transition || "transform 160ms ease-out, opacity 120ms ease-out", zIndex: isDragging ? 10 : undefined };
  return <div ref={setNodeRef} style={style} role="treeitem" aria-expanded={expanded} aria-selected={selected} className={cn("relative motion-reduce:!transition-none", isDragging && "opacity-25")}>
    <div className={cn("group flex h-9 min-w-0 items-center rounded-md pr-1 transition-colors duration-150", selected && "bg-[#ececea] text-ink", dropTarget && "bg-[#e5e5e2] shadow-[inset_0_0_0_1px_#8f8f8b]")}>
      <button type="button" aria-label={`${expanded ? "收起" : "展开"}项目 ${project.name}`} className="grid size-8 shrink-0 place-items-center rounded-md text-tertiary hover:bg-white/80 hover:text-ink" onClick={onToggle}>{expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}</button>
      <button type="button" onClick={onSelect} className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left text-[14px] leading-5 text-secondary hover:text-ink" title={project.name}>{expanded ? <FolderOpen className="size-4 shrink-0" /> : <Folder className="size-4 shrink-0" />}<span className="min-w-0 flex-1 overflow-hidden text-clip whitespace-nowrap">{project.name}</span><span className="shrink-0 tabular-nums text-[12px] text-tertiary">{Children.count(children)}</span></button>
      <button type="button" ref={setActivatorNodeRef} {...attributes} {...listeners} className="grid size-7 touch-none place-items-center rounded-md text-tertiary opacity-0 transition-opacity hover:bg-white hover:text-ink focus:opacity-100 group-hover:opacity-100" aria-label={`拖动项目 ${project.name}`} title="拖动项目"><GripVertical className="size-4" /></button>
      <ProjectMenu project={project} onRename={onRename} onDelete={onDelete} />
    </div>
    {expanded && Children.count(children) ? <div role="group" className="ml-[15px] border-l border-line pl-1.5">{children}</div> : null}
  </div>;
}

function ThreadTreeRow({ thread, projectName, selected, projects, onSelect, onRename, onMove, onDelete }: { thread: ThreadSummary; projectName?: string; selected: boolean; projects: ProjectSummary[]; onSelect: () => void; onRename: (thread: ThreadSummary) => void; onMove: (projectId: string | null) => void; onDelete: (thread: ThreadSummary) => void }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useDraggable({ id: threadDragId(thread.id), data: { type: "thread", threadId: thread.id } });
  const style = { transition: "opacity 120ms ease-out" };
  return <div ref={setNodeRef} style={style} data-testid="thread-row" data-thread-id={thread.id} data-project-id={thread.projectId ?? ""} className={cn("group flex h-9 w-full min-w-0 items-center rounded-md pr-1 text-[14px] leading-5 text-secondary transition-colors duration-150 motion-reduce:!transition-none hover:bg-white hover:text-ink", selected && "bg-[#ececea] text-ink", isDragging && "opacity-20")}>
    <button type="button" ref={setActivatorNodeRef} {...attributes} {...listeners} className="grid size-7 touch-none shrink-0 place-items-center rounded-md text-tertiary opacity-0 transition-opacity hover:bg-white focus:opacity-100 group-hover:opacity-100" aria-label={`拖动会话 ${thread.title}`} title="拖动会话"><GripVertical className="size-3.5" /></button>
    <button type="button" aria-label={projectName ? `${thread.title} ${projectName}` : thread.title} onClick={onSelect} className="flex h-full min-w-0 flex-1 items-center px-1 text-left" title={thread.title}><span data-testid="thread-title" className="block min-w-0 flex-1 overflow-hidden text-clip whitespace-nowrap">{thread.title}</span></button>
    <ThreadMenu thread={thread} projects={projects} onRename={onRename} onMove={onMove} onDelete={onDelete} />
  </div>;
}

function UnassignedDropZone({ active, over, children }: { active: boolean; over: boolean; children: React.ReactNode }) {
  const { setNodeRef } = useDroppable({ id: UNASSIGNED_DROP_ID, data: { type: "unassigned" } });
  return <div ref={setNodeRef} className={cn("rounded-lg transition-colors duration-150", active && over && "bg-white/40")}>{children}</div>;
}

function ProjectMenu({ project, onRename, onDelete }: { project: ProjectSummary; onRename: (project: ProjectSummary) => void; onDelete: (project: ProjectSummary) => void }) {
  return <Popover.Root><Popover.Trigger asChild><button type="button" className="icon-button size-7 shrink-0 opacity-0 focus:opacity-100 group-hover:opacity-100" aria-label={`管理项目 ${project.name}`} title={`管理项目 ${project.name}`}><Settings2 className="size-4" /></button></Popover.Trigger><Popover.Portal><Popover.Content side="right" align="start" sideOffset={6} className="z-50 w-44 rounded-lg border border-line bg-white p-1.5 shadow-popover"><Popover.Close asChild><button type="button" className="flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-[15px] text-secondary hover:bg-panel hover:text-ink" onClick={() => onRename(project)}><Edit3 className="size-4" />重命名项目</button></Popover.Close><Popover.Close asChild><button type="button" className="mt-1 flex min-h-9 w-full items-center gap-2 border-t border-line px-2 pt-1 text-left text-[15px] text-danger" onClick={() => onDelete(project)}><Trash2 className="size-4" />删除项目</button></Popover.Close></Popover.Content></Popover.Portal></Popover.Root>;
}

function ThreadMenu({ thread, projects, onRename, onMove, onDelete }: { thread: ThreadSummary; projects: ProjectSummary[]; onRename: (thread: ThreadSummary) => void; onMove: (projectId: string | null) => void; onDelete: (thread: ThreadSummary) => void }) {
  return <Popover.Root><Popover.Trigger asChild><button type="button" className="icon-button size-7 shrink-0 opacity-0 focus:opacity-100 group-hover:opacity-100" aria-label={`管理会话 ${thread.title}`} title={`管理会话 ${thread.title}`}><Settings2 className="size-4" /></button></Popover.Trigger><Popover.Portal><Popover.Content side="right" align="start" sideOffset={6} className="z-50 max-h-[min(520px,80dvh)] w-56 overflow-y-auto rounded-lg border border-line bg-white p-1.5 shadow-popover"><Popover.Close asChild><button type="button" className="flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-[15px] text-secondary hover:bg-panel hover:text-ink" onClick={() => onRename(thread)}><Edit3 className="size-4" />重命名会话</button></Popover.Close>{thread.projectId ? <Popover.Close asChild><button type="button" className="flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-[15px] text-secondary hover:bg-panel hover:text-ink" onClick={() => onMove(null)}><FolderMinus className="size-4" />移出项目</button></Popover.Close> : null}<div className="px-2 py-1 text-[14px] text-tertiary">移入项目</div>{projects.filter((candidate) => candidate.id !== thread.projectId).map((candidate) => <Popover.Close asChild key={candidate.id}><button type="button" className="flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-[15px] text-secondary hover:bg-panel hover:text-ink" title={candidate.name} onClick={() => onMove(candidate.id)}><FolderInput className="size-4 shrink-0" /><span className="min-w-0 overflow-hidden text-clip whitespace-nowrap">{candidate.name}</span></button></Popover.Close>)}<Popover.Close asChild><button type="button" className="mt-1 flex min-h-9 w-full items-center gap-2 border-t border-line px-2 pt-1 text-left text-[15px] text-danger" onClick={() => onDelete(thread)}><Trash2 className="size-4" />删除会话</button></Popover.Close></Popover.Content></Popover.Portal></Popover.Root>;
}

function NavigationAlert({ error, fallback }: { error: unknown; fallback: string }) {
  return <p role="alert" className="mt-2 px-1 text-[14px] text-danger">{getWorkbenchErrorMessage(error, fallback)}</p>;
}

function NavigationError({ label, onRetry }: { label: string; onRetry: () => void }) {
  return <div role="alert" className="mb-2 rounded-lg bg-white/65 px-3 py-2 text-[14px] text-danger"><p>{label}</p><button type="button" className="mt-1 text-ink underline underline-offset-2" onClick={onRetry}>重新加载</button></div>;
}

function NavigationSkeleton({ rows, detailed = false }: { rows: number; detailed?: boolean }) {
  return <div className="space-y-1 py-1" role="status" aria-label="正在加载列表">{Array.from({ length: rows }, (_, index) => <div key={index} className={cn("h-8 rounded-md bg-white/55", detailed && index % 2 === 1 && "ml-5 w-[calc(100%-20px)]")} />)}</div>;
}
