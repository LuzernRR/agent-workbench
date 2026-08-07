"use client";

// Three-pane shell adapted from OpenHands Agent Canvas conversation-panel and
// Kanna TerminalWorkspaceShell; react-resizable-panels remains the source runtime.
import { useEffect, useRef, useState } from "react";
import { Group, Panel, Separator, usePanelRef } from "react-resizable-panels";
import * as Dialog from "@radix-ui/react-dialog";
import * as Popover from "@radix-ui/react-popover";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronRight, PanelLeftOpen, PanelRightOpen, Plus, RefreshCcw, X } from "lucide-react";
import { WorkbenchSidebar } from "@/components/workbench/sidebar/WorkbenchSidebar";
import { Conversation, ConversationSkeleton } from "@/components/workbench/conversation/Conversation";
import { AgentWorkspace } from "@/components/workbench/workspace/AgentWorkspace";
import { useAgentThread } from "@/hooks/use-agent-thread";
import { workbenchApi } from "@/lib/api/client";
import { getWorkbenchErrorMessage } from "@/lib/errors";
import { createEmptyThreadState } from "@/lib/agent-events/reducer";
import type { S01ProcessFixtureCatalog } from "@/lib/agent-events/v2/process-view-model";
import { useWorkbenchUiStore } from "@/stores/workbench-ui-store";

type ViewportMode = "desktop" | "compact" | "mobile";

function useViewportMode() {
  const [mode, setMode] = useState<ViewportMode>("desktop");
  useEffect(() => {
    const update = () => setMode(window.innerWidth <= 760 ? "mobile" : window.innerWidth <= 1020 ? "compact" : "desktop");
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return mode;
}

export function resolveDraftElapsedStartedAt({
  draftStartedAt,
  draftHandoffThreadId,
  threadId,
  handoffHydrated
}: {
  draftStartedAt: string | null;
  draftHandoffThreadId: string | null;
  threadId: string | null;
  handoffHydrated: boolean;
}) {
  if (!draftStartedAt) return null;
  if (!threadId) return draftStartedAt;
  if (draftHandoffThreadId !== threadId || handoffHydrated) return null;
  return draftStartedAt;
}

export function WorkbenchShell({
  projectId,
  threadId,
  onSelectThread,
  s01ProcessFixture = null
}: {
  projectId: string | null | undefined;
  threadId: string | null;
  onSelectThread?: (projectId: string | null, threadId: string | null) => void;
  s01ProcessFixture?: S01ProcessFixtureCatalog | null;
}) {
  const thread = useAgentThread(threadId);
  const queryClient = useQueryClient();
  const projects = useQuery({ queryKey: ["projects"], queryFn: workbenchApi.projects });
  const [draftStarting, setDraftStarting] = useState(false);
  const [draftStartedAt, setDraftStartedAt] = useState<string | null>(null);
  const [draftHandoffThreadId, setDraftHandoffThreadId] = useState<string | null>(null);
  const draftSubmissionRef = useRef<Promise<unknown> | null>(null);
  const createdThreadRef = useRef<string | null>(null);
  const uploadedAttachmentIdsRef = useRef<string[] | null>(null);
  const mode = useViewportMode();
  const [dismissedError, setDismissedError] = useState<Error | null>(null);
  const leftRef = usePanelRef();
  const rightRef = usePanelRef();
  const leftCollapsed = useWorkbenchUiStore((store) => store.leftPanelCollapsed);
  const rightCollapsed = useWorkbenchUiStore((store) => store.rightPanelCollapsed);
  const setLeftCollapsed = useWorkbenchUiStore((store) => store.setLeftPanelCollapsed);
  const setRightCollapsed = useWorkbenchUiStore((store) => store.setRightPanelCollapsed);
  const [compactWorkspaceOpen, setCompactWorkspaceOpen] = useState(false);
  const previousSelectionRef = useRef(`${projectId === undefined ? "resolving" : projectId ?? "standalone"}:${threadId ?? "draft"}`);
  const revealBaselineReadyRef = useRef(false);
  const previousRevealSignalRef = useRef({ plan: "", artifacts: "" });
  const planRevealSignal = thread.state?.planUpdatedAt || "";
  const artifactRevealSignal = thread.state?.artifacts.map((artifact) => `${artifact.id}:${artifact.version}`).join("|") || "";

  useEffect(() => {
    const selection = `${projectId === undefined ? "resolving" : projectId ?? "standalone"}:${threadId ?? "draft"}`;
    if (previousSelectionRef.current === selection) return;
    previousSelectionRef.current = selection;
    const createdSelection = Boolean(threadId && createdThreadRef.current === threadId);
    // Refs belong to a draft selection.  Keeping the shell mounted avoids a
    // full-frame flash while these transient values are reset explicitly.
    draftSubmissionRef.current = null;
    if (!createdSelection) {
      createdThreadRef.current = null;
      uploadedAttachmentIdsRef.current = null;
    }
    revealBaselineReadyRef.current = false;
    previousRevealSignalRef.current = { plan: "", artifacts: "" };
  }, [projectId, threadId]);

  useEffect(() => {
    if (!thread.state) return;
    if (!revealBaselineReadyRef.current) {
      revealBaselineReadyRef.current = true;
      previousRevealSignalRef.current = { plan: planRevealSignal, artifacts: artifactRevealSignal };
      return;
    }
    const previous = previousRevealSignalRef.current;
    const shouldReveal = (Boolean(planRevealSignal) && previous.plan !== planRevealSignal)
      || (Boolean(artifactRevealSignal) && previous.artifacts !== artifactRevealSignal);
    previousRevealSignalRef.current = { plan: planRevealSignal, artifacts: artifactRevealSignal };
    if (!shouldReveal) return;
    if (mode === "desktop") {
      rightRef.current?.expand();
      return;
    }
    // A compact workspace is a modal surface. Opening it automatically would
    // cover the elapsed indicator and the model's live answer, so only the
    // explicit top-bar command may open it outside desktop layouts.
    return;
  }, [artifactRevealSignal, mode, planRevealSignal, rightRef, thread.state]);

  const snapshotMatchesSelection = Boolean(threadId && thread.snapshot?.thread.id === threadId);
  const stateMatchesSelection = Boolean(threadId && thread.state?.threadId === threadId);
  const previousFrameAvailable = Boolean(thread.snapshot || thread.state || projectId === null || projects.data?.some((item) => item.id === projectId));
  if (threadId && thread.error && !previousFrameAvailable) return <div className="grid h-[100dvh] place-items-center bg-app"><div className="text-center"><p className="text-sm text-danger">{getWorkbenchErrorMessage(thread.error, "工作台连接失败")}</p><button type="button" className="quiet-button mt-3" onClick={() => void thread.refresh()}><RefreshCcw className="size-3.5" />重试</button></div></div>;

  const resolvedProjectId = snapshotMatchesSelection ? thread.snapshot?.thread.projectId ?? null : projectId;
  const project = snapshotMatchesSelection
    ? thread.snapshot?.project ?? null
    : resolvedProjectId ? projects.data?.find((item) => item.id === resolvedProjectId) ?? null : null;
  const projectLoading = Boolean(!threadId && resolvedProjectId && !project && projects.isLoading);
  const state = stateMatchesSelection && thread.state ? thread.state : createEmptyThreadState(resolvedProjectId ?? null, threadId || "draft");
  const switchingThread = Boolean(threadId && (thread.isFetching || !snapshotMatchesSelection || !stateMatchesSelection));
  const draftElapsedStartedAt = resolveDraftElapsedStartedAt({
    draftStartedAt,
    draftHandoffThreadId,
    threadId,
    handoffHydrated: snapshotMatchesSelection && stateMatchesSelection
  });
  const startRun = threadId ? thread.startRun : (message: string) => {
    if (draftSubmissionRef.current) return draftSubmissionRef.current;
    const startedAt = new Date().toISOString();
    setDraftStartedAt(startedAt);
    setDraftHandoffThreadId(null);
    let handedOff = false;
    const submission = (async () => {
      setDraftStarting(true);
      const store = useWorkbenchUiStore.getState();
      const createdThread = createdThreadRef.current ? null : await workbenchApi.createThread(resolvedProjectId ?? null);
      const createdId = createdThreadRef.current ?? createdThread!.id;
      createdThreadRef.current = createdId;
      setDraftHandoffThreadId(createdId);
      if (uploadedAttachmentIdsRef.current === null) {
        const uploaded = store.pendingDraftAttachments.length
          ? await workbenchApi.uploadAttachments(createdId, store.pendingDraftAttachments.map((attachment) => attachment.file))
          : [];
        uploadedAttachmentIdsRef.current = uploaded.map((attachment) => attachment.id);
      }
      const current = useWorkbenchUiStore.getState();
      await workbenchApi.startRun(createdId, { message, agentId: current.agentId, modelId: current.modelId, reasoningEffort: current.reasoningEffort, toolIds: current.selectedToolIds, permissionMode: current.permissionMode, attachmentIds: uploadedAttachmentIdsRef.current, replaceMessageId: null });
      current.clearPendingDraftAttachments();
      await queryClient.invalidateQueries({ queryKey: ["threads"] });
      if (onSelectThread) {
        onSelectThread(createdThread?.projectId ?? resolvedProjectId ?? null, createdId);
        handedOff = true;
      }
    })().finally(() => {
      setDraftStarting(false);
      if (!handedOff) setDraftStartedAt(null);
      draftSubmissionRef.current = null;
    });
    draftSubmissionRef.current = submission;
    return submission;
  };

  const showLeft = mode !== "mobile";
  const showRight = mode === "desktop";
  const operationError = thread.error && thread.error !== dismissedError ? thread.error : null;
  return (
    <div className="relative h-[100dvh] w-screen overflow-hidden bg-app">
      <Group orientation="horizontal" className="h-full">
        {showLeft ? <><Panel id="left-sidebar" panelRef={leftRef} defaultSize={leftCollapsed ? "0px" : "248px"} minSize="220px" maxSize="300px" collapsible collapsedSize="0px" groupResizeBehavior="preserve-pixel-size" onResize={(size) => setLeftCollapsed(size.inPixels < 8)}><WorkbenchSidebar projectId={resolvedProjectId ?? null} threadId={threadId} onSelectThread={onSelectThread} onCollapse={() => leftRef.current?.collapse()} /></Panel><Separator id="left-separator" className={leftCollapsed ? "hidden" : ""} /></> : null}
        <Panel id="conversation" minSize={mode === "mobile" ? "0px" : "640px"}>
          <main className="flex h-full min-w-0 flex-col bg-surface">
            <WorkbenchTopbar projectId={resolvedProjectId ?? null} threadId={threadId} projectName={project?.name} threadTitle={snapshotMatchesSelection ? thread.snapshot?.thread.title : undefined} loading={switchingThread || projectLoading} leftCollapsed={leftCollapsed} rightCollapsed={rightCollapsed} canOpenLeft={showLeft} canOpenRight={showRight} canOpenCompactWorkspace={!showRight} onSelectThread={onSelectThread} onOpenLeft={() => leftRef.current?.expand()} onOpenRight={() => rightRef.current?.expand()} onOpenCompactWorkspace={() => setCompactWorkspaceOpen(true)} />
            {operationError ? <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-[#f0caca] bg-[#fff7f7] px-4 py-2 text-[14px] leading-5 text-danger"><span className="min-w-0 flex-1">{getWorkbenchErrorMessage(operationError, "任务请求失败")}</span><button type="button" className="icon-button size-7 shrink-0" onClick={() => setDismissedError(operationError)} title="关闭错误" aria-label="关闭错误"><X className="size-3.5" /></button></div> : null}
            {switchingThread || projectLoading ? <ConversationSkeleton pendingStartedAt={thread.pendingStartedAt || draftElapsedStartedAt} /> : <Conversation state={state} composerThreadId={threadId} onStartRun={startRun} onStopRun={thread.stopRun} onResolveApproval={(approvalId, decision) => thread.resolveApproval({ approvalId, decision })} isResolvingApproval={thread.isResolvingApproval} isStarting={thread.isStarting || draftStarting} pendingStartedAt={thread.pendingStartedAt || draftElapsedStartedAt} s01ProcessFixture={s01ProcessFixture} />}
          </main>
        </Panel>
        {showRight ? <><Separator id="right-separator" className={rightCollapsed ? "hidden" : ""} /><Panel id="right-workspace" panelRef={rightRef} defaultSize={rightCollapsed ? "0px" : "380px"} minSize="340px" maxSize="680px" collapsible collapsedSize="0px" groupResizeBehavior="preserve-pixel-size" onResize={(size) => setRightCollapsed(size.inPixels < 8)}><AgentWorkspace state={state} onCollapse={() => rightRef.current?.collapse()} /></Panel></> : null}
      </Group>
      {!showRight ? <Dialog.Root open={compactWorkspaceOpen} onOpenChange={setCompactWorkspaceOpen}><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-40 bg-black/20" /><Dialog.Content className="fixed inset-y-0 right-0 z-50 h-[100dvh] w-[min(520px,100vw)] bg-panel shadow-2xl outline-none"><Dialog.Title className="sr-only">工作区</Dialog.Title><AgentWorkspace state={state} onCollapse={() => setCompactWorkspaceOpen(false)} collapseLabel="关闭工作区" /></Dialog.Content></Dialog.Portal></Dialog.Root> : null}
    </div>
  );
}

function WorkbenchTopbar({ projectId, threadId, projectName, threadTitle, loading, leftCollapsed, rightCollapsed, canOpenLeft, canOpenRight, canOpenCompactWorkspace, onSelectThread, onOpenLeft, onOpenRight, onOpenCompactWorkspace }: { projectId: string | null; threadId: string | null; projectName?: string; threadTitle?: string; loading: boolean; leftCollapsed: boolean; rightCollapsed: boolean; canOpenLeft: boolean; canOpenRight: boolean; canOpenCompactWorkspace: boolean; onSelectThread?: (projectId: string | null, threadId: string | null) => void; onOpenLeft: () => void; onOpenRight: () => void; onOpenCompactWorkspace: () => void }) {
  const projects = useQuery({ queryKey: ["projects"], queryFn: workbenchApi.projects });
  const projectIds = (projects.data || []).map((project) => project.id);
  const threads = useQuery({
    queryKey: ["threads", "all", projectIds],
    queryFn: () => workbenchApi.allThreads(projectIds),
    enabled: !projects.isLoading,
    staleTime: 15000
  });
  const visibleThreads = (threads.data || []).filter((thread) => projectId ? thread.projectId === projectId : thread.projectId === null);
  const displayTitle = projectId && !threadId ? projectName || "项目" : threadTitle || "新会话";
  const threadSwitcher = threadId ? <Popover.Root>
    <Popover.Trigger asChild>
      <button type="button" className="flex min-h-9 min-w-0 max-w-full items-center gap-1.5 rounded-lg px-2 py-1 text-left transition-colors hover:bg-panel" aria-label="切换会话" title={threadTitle || "新会话"}>
        <span className="min-w-0 overflow-hidden text-clip whitespace-nowrap leading-5">{threadTitle || "新会话"}</span>
        <ChevronDown className="size-3.5 shrink-0 text-tertiary" />
      </button>
    </Popover.Trigger>
    <Popover.Portal><Popover.Content side="bottom" align="start" sideOffset={7} className="z-50 max-h-[min(460px,70dvh)] w-80 overflow-y-auto rounded-xl border border-line bg-white p-1.5 shadow-popover">
      {visibleThreads.map((thread) => <Popover.Close asChild key={thread.id}><button type="button" onClick={() => onSelectThread?.(thread.projectId, thread.id)} className="flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[15px] text-ink hover:bg-panel" title={thread.title}><span className="min-w-0 flex-1 overflow-hidden text-clip whitespace-nowrap leading-5">{thread.title}</span>{thread.id === threadId ? <Check className="size-4 shrink-0" /> : null}</button></Popover.Close>)}
    </Popover.Content></Popover.Portal>
  </Popover.Root> : null;
  return <>
    <header className="flex min-h-[52px] shrink-0 items-center gap-2 border-b border-line px-2.5 py-1.5 md:px-4">
    {canOpenLeft && leftCollapsed ? <button className="icon-button" onClick={onOpenLeft} title="展开左栏" aria-label="展开左栏"><PanelLeftOpen className="size-4" /></button> : null}
    <h1 aria-label={loading ? "正在加载会话" : displayTitle} className="min-w-0 flex-1 text-balance text-[15px] font-semibold text-ink">
      {loading ? <span className="block h-5 w-44 rounded-md bg-panel" aria-hidden="true" /> : <span className="flex min-w-0 items-center">
        {projectId && projectName ? <button type="button" onClick={() => onSelectThread?.(projectId, null)} className="min-h-9 max-w-48 overflow-hidden text-clip whitespace-nowrap rounded-lg px-2 py-1 text-left font-normal leading-5 text-secondary transition-colors hover:bg-panel hover:text-ink" aria-label={`打开项目 ${projectName}`} title={projectName}>{projectName}</button> : null}
        {projectId && projectName && threadId ? <ChevronRight className="size-3 shrink-0 text-tertiary" aria-hidden="true" /> : null}
        {threadSwitcher || (!projectId ? <span className="px-2 leading-5">新会话</span> : null)}
      </span>}
    </h1>
    {canOpenRight && rightCollapsed ? <button className="icon-button" onClick={onOpenRight} title="展开工作区" aria-label="展开工作区"><PanelRightOpen className="size-4" /></button> : null}
    {canOpenCompactWorkspace ? <button type="button" className="icon-button" onClick={onOpenCompactWorkspace} title="打开工作区" aria-label="打开工作区"><PanelRightOpen className="size-4" /></button> : null}
    {!canOpenLeft ? <button type="button" className="icon-button" onClick={() => onSelectThread?.(null, null)} title="新建会话" aria-label="新建会话"><Plus className="size-4" /></button> : null}
    </header>
  </>;
}
