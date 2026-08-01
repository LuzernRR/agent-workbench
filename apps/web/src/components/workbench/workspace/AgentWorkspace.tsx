"use client";

// Dynamic workspace tabs follow OpenHands Agent Canvas files-tab and Kanna's
// TerminalWorkspaceShell patterns, adapted to server-authoritative AgentEvents.
import { useEffect, useState } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { Check, Circle, CircleAlert, Download, ExternalLink, FileCode2, FileText, Folder, ListChecks, LoaderCircle, Maximize2, Minimize2, PanelRightClose, RefreshCcw, Table2 } from "lucide-react";
import type { AgentThreadState } from "@/lib/agent-events/types";
import { cn } from "@/lib/utils";
import { useWorkbenchUiStore, type WorkspaceTab } from "@/stores/workbench-ui-store";
import { MarkdownRenderer } from "@/components/workbench/renderers/MarkdownRenderer";
import { CodePreview } from "./CodePreview";
import { LogViewer } from "./LogViewer";
import { safeWorkbenchHref } from "@/lib/api/client";

const tabMeta: Record<WorkspaceTab, { label: string; icon: typeof FileText }> = {
  plan: { label: "计划", icon: ListChecks },
  artifacts: { label: "成果", icon: FileText },
  files: { label: "文件", icon: Folder },
  web: { label: "网页", icon: ExternalLink },
  code: { label: "代码", icon: FileCode2 },
  logs: { label: "日志", icon: Table2 }
};

export function AgentWorkspace({ state, onCollapse, collapseLabel = "折叠右栏" }: { state: AgentThreadState; onCollapse: () => void; collapseLabel?: string }) {
  const tab = useWorkbenchUiStore((store) => store.workspaceTab);
  const setTab = useWorkbenchUiStore((store) => store.setWorkspaceTab);
  const selectedArtifactId = useWorkbenchUiStore((store) => store.selectedArtifactId);
  const setArtifactId = useWorkbenchUiStore((store) => store.setSelectedArtifactId);
  const selectedFileId = useWorkbenchUiStore((store) => store.selectedFileId);
  const setFileId = useWorkbenchUiStore((store) => store.setSelectedFileId);
  const fullscreen = useWorkbenchUiStore((store) => store.workspaceFullscreen);
  const setFullscreen = useWorkbenchUiStore((store) => store.setWorkspaceFullscreen);
  const visibleArtifacts = state.artifacts.filter((artifact) => !isDuplicateConversationArtifact(artifact.content, state));
  const defaultArtifact = visibleArtifacts.find((artifact) => artifact.kind === "report" || artifact.mimeType.includes("markdown")) || visibleArtifacts[0];
  const selectedArtifact = visibleArtifacts.find((artifact) => artifact.id === selectedArtifactId) || defaultArtifact;
  const selectedFile = state.files.find((file) => file.id === selectedFileId) || state.files[0];
  const selectedCodeFile = state.files.find((file) => file.id === selectedFileId && file.language && file.language !== "markdown")
    || state.files.find((file) => file.language && file.language !== "markdown");
  const webUrl = findWebUrl(state);
  const artifactReview = findArtifactReview(state);
  const reviewPending = artifactReview?.status === "preparing" || artifactReview?.status === "running" || artifactReview?.status === "waiting";
  const reviewFailed = artifactReview?.status === "failed";
  const availableTabs = (Object.keys(tabMeta) as WorkspaceTab[]).filter((key) => key === "plan" ? state.plan.length > 0 : key === "artifacts" ? visibleArtifacts.length > 0 : key === "files" ? state.files.length > 0 : key === "code" ? state.files.some((file) => file.language && file.language !== "markdown") : key === "logs" ? state.logs.length > 0 : key === "web" ? Boolean(webUrl) : false);
  useEffect(() => { if (availableTabs.length && !availableTabs.includes(tab)) setTab(availableTabs[0]); }, [availableTabs, setTab, tab]);
  useEffect(() => { if (!selectedArtifactId && defaultArtifact) setArtifactId(defaultArtifact.id); }, [defaultArtifact, selectedArtifactId, setArtifactId]);
  useEffect(() => { if (!selectedFileId && state.files[0]) setFileId(state.files[0].id); }, [selectedFileId, setFileId, state.files]);
  useEffect(() => { if (state.planUpdatedAt) setTab("plan"); }, [setTab, state.planUpdatedAt]);

  return <aside className={cn("flex h-full min-w-0 flex-col bg-panel", fullscreen && "fixed inset-0 z-50 border border-line shadow-2xl")} aria-label="工作区"><div className="flex min-h-[52px] shrink-0 items-start gap-2 border-b border-line px-3 py-2"><div className="min-w-0 flex-1 whitespace-normal break-words text-[15px] font-semibold text-ink">工作区{reviewPending ? <span role="status" className="ml-2 font-normal text-warning">成果正在审核重构</span> : null}{reviewFailed ? <span role="alert" className="ml-2 font-normal text-danger">成果审核失败，暂不可导出</span> : null}</div><button className="icon-button" onClick={() => setFullscreen(!fullscreen)} title={fullscreen ? "退出全屏" : "全屏查看"} aria-label={fullscreen ? "退出全屏" : "全屏查看"}>{fullscreen ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}</button>{!fullscreen ? <button className="icon-button" onClick={onCollapse} title={collapseLabel} aria-label={collapseLabel}><PanelRightClose className="size-4" /></button> : null}</div><Tabs.Root value={tab} onValueChange={(value) => setTab(value as WorkspaceTab)} orientation="horizontal" className="flex min-h-0 flex-1 flex-col"><Tabs.List className="scrollbar-subtle flex h-11 shrink-0 gap-1 overflow-x-auto border-b border-line px-2 py-1.5" aria-label="工作区内容">{availableTabs.map((key) => { const Icon = tabMeta[key].icon; return <Tabs.Trigger key={key} value={key} className="relative flex shrink-0 items-center gap-1.5 rounded-lg px-2 text-[15px] text-secondary outline-none transition-colors duration-150 hover:bg-white/70 data-[state=active]:bg-white data-[state=active]:font-medium data-[state=active]:text-ink"><Icon className="size-3.5" />{tabMeta[key].label}{key === "artifacts" && visibleArtifacts.length > 0 ? <span className="size-1.5 rounded-full bg-accent" /> : null}</Tabs.Trigger>; })}</Tabs.List><div className="min-h-0 flex-1"><Tabs.Content value="plan" className="h-full outline-none"><PlanView steps={state.plan} /></Tabs.Content><Tabs.Content value="artifacts" className="h-full outline-none"><ArtifactView artifacts={visibleArtifacts} artifact={selectedArtifact} selectedId={selectedArtifact?.id} onSelect={setArtifactId} downloadAllowed={!reviewPending && !reviewFailed} reviewPending={reviewPending} reviewFailed={reviewFailed} /></Tabs.Content><Tabs.Content value="files" className="h-full outline-none"><FilesView files={state.files} selectedId={selectedFile?.id} onSelect={setFileId} /></Tabs.Content><Tabs.Content value="web" className="h-full outline-none"><WebView url={webUrl} /></Tabs.Content><Tabs.Content value="code" className="h-full outline-none"><CodePreview file={selectedCodeFile} /></Tabs.Content><Tabs.Content value="logs" className="h-full outline-none"><LogViewer logs={state.logs} /></Tabs.Content></div></Tabs.Root></aside>;
}

export function PlanView({ steps }: { steps: AgentThreadState["plan"] }) {
  const channelLabels = { web: "网页", x: "X", xiaohongshu: "小红书" } as const;
  return <div className="scrollbar-subtle h-full overflow-y-auto px-5 py-5">{steps.map((step, index) => <div key={step.id} className="relative grid min-h-[68px] grid-cols-[20px_minmax(0,1fr)] gap-3" aria-label={`${step.title}，${step.status === "done" ? "已完成" : step.status === "in_progress" ? "执行中" : step.status === "blocked" ? "已阻塞" : step.status === "skipped" ? "已跳过" : "待执行"}`}>
    {index < steps.length - 1 ? <span className={cn("absolute left-[9px] top-5 h-[calc(100%-8px)] w-px", step.status === "done" ? "bg-success/55" : step.status === "blocked" ? "bg-danger/45" : "bg-line")} aria-hidden /> : null}
    <span className="relative z-10 mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-panel" aria-hidden>{step.status === "done" ? <span className="grid size-5 place-items-center rounded-full bg-success text-white"><Check className="size-3" /></span> : step.status === "in_progress" ? <LoaderCircle className="size-5 animate-spin text-accent" /> : step.status === "blocked" ? <CircleAlert className="size-5 text-danger" /> : <Circle className="size-5 text-tertiary" />}</span>
    <div className={cn("min-w-0 pb-5 text-[16px] leading-6", step.status === "todo" || step.status === "skipped" ? "text-tertiary" : step.status === "blocked" ? "text-danger" : "text-ink")}>
      <div>{step.title}</div>
      {step.query ? <div className="mt-1 break-words text-[14px] leading-5 text-secondary">查询：{step.query}</div> : null}
      {(step.channel || step.priority !== undefined || step.evidenceNeeded !== undefined) ? <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] leading-5 text-tertiary">
        {step.channel ? <span>渠道：{channelLabels[step.channel]}</span> : null}
        {step.priority !== undefined ? <span>优先级：{step.priority}</span> : null}
        {step.evidenceNeeded !== undefined ? <span>证据目标：{step.evidenceNeeded}</span> : null}
        {step.canParallelize !== undefined ? <span>{step.canParallelize ? "可并行" : "串行"}</span> : null}
      </div> : null}
      {step.dependsOn?.length ? <div className="mt-0.5 break-all text-[12px] leading-5 text-tertiary">依赖：{step.dependsOn.join("、")}</div> : null}
      {step.reasonCode ? <div className="mt-0.5 text-[12px] leading-5 text-danger">状态码：{step.reasonCode}</div> : null}
      {step.notes ? <div className={cn("mt-1 text-[14px] leading-5", step.status === "blocked" ? "text-danger" : "text-secondary")}>{step.notes}</div> : null}
    </div>
  </div>)}</div>;
}

export function extractArtifactMarkdown(content: string) {
  let value: unknown = content.trim();
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof value !== "string") break;
    const stripped = value.trim().replace(/^```(?:json|markdown|md)?\s*/i, "").replace(/\s*```$/, "").trim();
    if (!stripped.startsWith("{") && !stripped.startsWith("[")) return stripped.replace(/\\n/g, "\n");
    try {
      value = JSON.parse(stripped) as unknown;
    } catch {
      return stripped.replace(/\\n/g, "\n");
    }
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["content", "markdown", "report", "text", "body"]) {
      if (typeof record[key] === "string") return extractArtifactMarkdown(record[key]);
    }
  }
  return "成果内容暂不可预览";
}

export function isDuplicateConversationArtifact(content: string, state: AgentThreadState) {
  const artifactText = comparableMarkdown(extractArtifactMarkdown(content));
  if (!artifactText || artifactText === comparableMarkdown("成果内容暂不可预览")) return false;
  return state.itemOrder.some((id) => {
    const item = state.items[id];
    return item?.kind === "message" && item.role === "assistant" && comparableMarkdown(item.text) === artifactText;
  });
}

function comparableMarkdown(value: string) {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/!\[([^\]]*)]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/[`*_>#~-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function ArtifactView({ artifacts, artifact, selectedId, onSelect, downloadAllowed, reviewPending, reviewFailed }: { artifacts: AgentThreadState["artifacts"]; artifact: AgentThreadState["artifacts"][number] | undefined; selectedId?: string; onSelect: (id: string) => void; downloadAllowed: boolean; reviewPending: boolean; reviewFailed: boolean }) {
  if (!artifact) return <div className="grid h-full place-items-center px-5 text-center text-[16px] text-secondary">{reviewPending ? "成果正在审核重构，完成后显示" : reviewFailed ? "成果审核失败，暂时无法导出" : "等待生成成果"}</div>;
  const downloadHref = safeWorkbenchHref(artifact.downloadUrl) || safeWorkbenchHref(`/api/v1/artifacts/${artifact.id}`);
  const download = downloadAllowed && downloadHref ? <a className="icon-button" href={downloadHref} download title="下载成果" aria-label="下载成果"><Download className="size-4" /></a> : null;
  if (artifacts.length === 1) {
    return <div className="relative h-full"><div className="absolute right-3 top-3 z-10">{download}</div><div className="scrollbar-subtle h-full overflow-auto px-5 py-5 pr-14"><MarkdownRenderer>{extractArtifactMarkdown(artifact.content)}</MarkdownRenderer></div></div>;
  }
  return <div className="flex h-full flex-col"><div className="flex min-h-11 shrink-0 items-start gap-2 border-b border-line px-3 py-2"><select aria-label="选择成果" title={artifact.name} className="min-w-0 flex-1 bg-transparent text-[15px] font-medium text-ink outline-none" value={selectedId || artifact.id} onChange={(event) => onSelect(event.target.value)}>{artifacts.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select>{download}</div><div className="scrollbar-subtle min-h-0 flex-1 overflow-auto px-5 py-5"><MarkdownRenderer>{extractArtifactMarkdown(artifact.content)}</MarkdownRenderer></div></div>;
}

function FilesView({ files, selectedId, onSelect }: { files: AgentThreadState["files"]; selectedId: string | undefined; onSelect: (id: string) => void }) {
  return <div className="scrollbar-subtle h-full overflow-auto p-2"><div className="mb-2 flex items-center gap-1.5 px-2 py-1 text-[13px] font-medium text-secondary"><Folder className="size-3.5" />生成文件</div>{files.map((file) => { const href = safeWorkbenchHref(file.downloadUrl) || safeWorkbenchHref(`/api/v1/files/${file.id}`); return <div key={file.id} className={cn("flex w-full items-start gap-2 rounded-lg px-2 py-2 text-[13px] text-secondary hover:bg-white hover:text-ink", file.id === selectedId && "bg-white text-ink")}><button type="button" onClick={() => onSelect(file.id)} className="flex min-w-0 flex-1 items-start gap-2 text-left" title={file.name}><FileText className="mt-0.5 size-3.5 shrink-0" /><span className="min-w-0 flex-1 whitespace-normal break-words">{file.name}</span><span className={file.status === "created" ? "shrink-0 text-success" : "shrink-0 text-warning"}>{file.status === "created" ? "新增" : "修改"}</span></button>{href ? <a className="icon-button size-7" href={href} download title="下载文件" aria-label="下载文件"><Download className="size-3.5" /></a> : null}</div>; })}</div>;
}

function WebView({ url }: { url: string | null }) {
  const [revision, setRevision] = useState(0);
  const safeUrl = safeWorkbenchHref(url);
  if (!safeUrl || !/^https?:\/\//iu.test(safeUrl)) return null;
  return <div className="flex h-full flex-col"><div className="flex min-h-11 shrink-0 items-start gap-1.5 border-b border-line px-3 py-2"><span className="min-w-0 flex-1 whitespace-normal break-words text-[15px] font-medium text-ink">网页预览</span><button className="icon-button" type="button" onClick={() => setRevision((value) => value + 1)} title="刷新网页" aria-label="刷新网页"><RefreshCcw className="size-4" /></button><a className="icon-button" href={safeUrl} target="_blank" rel="noopener noreferrer" title="在新窗口打开" aria-label="在新窗口打开"><ExternalLink className="size-4" /></a></div><iframe key={`${safeUrl}:${revision}`} className="min-h-0 flex-1 border-0 bg-white" src={safeUrl} title="网页预览" sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" /></div>;
}

export function findArtifactReview(state: AgentThreadState) {
  for (const id of [...state.itemOrder].reverse()) {
    const item = state.items[id];
    if (item?.kind !== "tool") continue;
    if (/(?:deepseek[-_ ]?)?artifact[-_ ]?review|editor(?:[-_ ]?review)?/iu.test(`${item.name} ${item.toolCallId}`)) return item;
  }
  return undefined;
}

function findWebUrl(state: AgentThreadState) {
  for (const id of [...state.itemOrder].reverse()) {
    const item = state.items[id];
    if (!item || item.kind !== "tool") continue;
    for (const candidate of [item.rawResult, item.input]) {
      if (!candidate || typeof candidate !== "object") continue;
      const value = candidate as Record<string, unknown>;
      if (typeof value.url === "string" && /^https:\/\//.test(value.url)) return value.url;
      if (Array.isArray(value.sources)) {
        const source = value.sources.find((entry) => entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).url === "string") as Record<string, unknown> | undefined;
        if (typeof source?.url === "string" && /^https:\/\//.test(source.url)) return source.url;
      }
    }
  }
  return null;
}
