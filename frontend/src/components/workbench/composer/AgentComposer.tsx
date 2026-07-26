"use client";

// assistant-ui owns the composer lifecycle; the workbench supplies the model
// selection, attachments, and run controls around it.
import { useEffect, useRef, useState } from "react";
import { AuiIf, ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import * as Popover from "@radix-ui/react-popover";
import { ArrowUp, Check, ChevronDown, FileText, Plus, Square, X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { workbenchApi, safeWorkbenchHref } from "@/lib/api/client";
import { ImagePreview } from "@/components/workbench/attachments/ImagePreview";
import { useWorkbenchUiStore } from "@/stores/workbench-ui-store";
import { resolveWorkbenchResourceUrl } from "@/lib/api/client";
import { getWorkbenchErrorMessage } from "@/lib/errors";

const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export function AgentComposer({ threadId, disabled }: { threadId: string | null; disabled?: boolean }) {
  const aui = useAui();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeThreadId = useRef<string | null>(threadId);
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const agents = useQuery({ queryKey: ["agents"], queryFn: workbenchApi.agents });
  const models = useQuery({ queryKey: ["models"], queryFn: workbenchApi.models });
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const agentId = useWorkbenchUiStore((store) => store.agentId);
  const modelId = useWorkbenchUiStore((store) => store.modelId);
  const reasoningEffort = useWorkbenchUiStore((store) => store.reasoningEffort);
  const pendingAttachments = useWorkbenchUiStore((store) => store.pendingAttachments);
  const pendingDraftAttachments = useWorkbenchUiStore((store) => store.pendingDraftAttachments);
  const selectedToolIds = useWorkbenchUiStore((store) => store.selectedToolIds);
  const setAgentId = useWorkbenchUiStore((store) => store.setAgentId);
  const setSelectedToolIds = useWorkbenchUiStore((store) => store.setSelectedToolIds);
  const setModel = useWorkbenchUiStore((store) => store.setModel);
  const addPendingAttachments = useWorkbenchUiStore((store) => store.addPendingAttachments);
  const removePendingAttachment = useWorkbenchUiStore((store) => store.removePendingAttachment);
  const clearPendingAttachments = useWorkbenchUiStore((store) => store.clearPendingAttachments);
  const addPendingDraftAttachments = useWorkbenchUiStore((store) => store.addPendingDraftAttachments);
  const removePendingDraftAttachment = useWorkbenchUiStore((store) => store.removePendingDraftAttachment);
  const clearPendingDraftAttachments = useWorkbenchUiStore((store) => store.clearPendingDraftAttachments);
  const selectedModel = models.data?.find((model) => model.id === modelId);
  const draftMode = !threadId;
  const visibleAttachments = draftMode ? pendingDraftAttachments : pendingAttachments;

  useEffect(() => {
    const previous = activeThreadId.current;
    activeThreadId.current = threadId;
    if (previous !== threadId) {
      clearPendingAttachments();
      clearPendingDraftAttachments();
      setUploadError("");
    }
    return () => {
      if (activeThreadId.current === threadId) activeThreadId.current = null;
      clearPendingAttachments();
      clearPendingDraftAttachments();
    };
  }, [clearPendingAttachments, clearPendingDraftAttachments, threadId]);

  const uploadFiles = async (incoming: File[]) => {
    const files = incoming.filter((file) => file.size > 0);
    if (!files.length) return;
    if (visibleAttachments.length + files.length > MAX_ATTACHMENTS) {
      setUploadError(`每条消息最多上传 ${MAX_ATTACHMENTS} 个文件`);
      return;
    }
    const oversized = files.find((file) => file.size > MAX_ATTACHMENT_BYTES);
    if (oversized) {
      setUploadError(`${oversized.name} 超过 20 MB`);
      return;
    }
    setUploadError("");
    setIsUploading(true);
    try {
      if (!threadId) {
        addPendingDraftAttachments(files.map((file) => ({
          id: crypto.randomUUID(),
          name: file.name,
          mimeType: file.type || "application/octet-stream",
          sizeBytes: file.size,
          kind: file.type.startsWith("image/") ? "image" : "document",
          url: URL.createObjectURL(file),
          file
        })));
      } else {
        const uploaded = await workbenchApi.uploadAttachments(threadId, files);
        if (activeThreadId.current === threadId) addPendingAttachments(uploaded);
      }
    } catch (error) {
      if (activeThreadId.current === threadId) setUploadError(getWorkbenchErrorMessage(error, "附件上传失败"));
    } finally {
      if (activeThreadId.current === threadId) setIsUploading(false);
    }
  };

  useEffect(() => {
    if (!agents.data?.length) return;
    const current = agents.data.find((agent) => agent.id === agentId) || agents.data[0];
    if (current.id !== agentId) setAgentId(current.id);
    setSelectedToolIds(current.toolIds || []);
  }, [agentId, agents.data, setAgentId, setSelectedToolIds]);

  useEffect(() => {
    if (!models.data?.length) return;
    const current = models.data.find((model) => model.id === modelId);
    if (!current) setModel(models.data[0].id, models.data[0].defaultReasoningEffort);
    else if (!current.reasoningEfforts.includes(reasoningEffort)) setModel(current.id, current.defaultReasoningEffort);
  }, [modelId, models.data, reasoningEffort, setModel]);

  return (
    <ComposerPrimitive.Root className="conversation-composer flex flex-col" data-testid="composer">
      <input ref={fileInputRef} type="file" multiple className="sr-only" aria-label="选择图片或文档" accept="image/*,.pdf,.txt,.md,.csv,.json,.doc,.docx,.xls,.xlsx,.ppt,.pptx" onChange={(event) => { void uploadFiles(Array.from(event.target.files || [])); event.target.value = ""; }} />
      <div className="flex flex-col rounded-2xl border border-[#d8d8d8] bg-surface shadow-composer transition-colors duration-150 focus-within:border-[#a8a8ad]" onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }} onDrop={(event) => { event.preventDefault(); void uploadFiles(Array.from(event.dataTransfer.files)); }}>
          {visibleAttachments.length ? <div className="flex flex-wrap gap-2 px-4 pt-3" aria-label="待发送附件">
          {visibleAttachments.map((attachment) => { const href = safeWorkbenchHref(resolveWorkbenchResourceUrl(attachment.url)); return <div key={attachment.id} className="group/attachment relative flex min-h-14 max-w-72 items-start gap-2 rounded-lg bg-panel py-2 pr-8 text-[15px] text-secondary">
            {attachment.kind === "image" && href ? <ImagePreview src={href} alt={attachment.name} className="size-14 shrink-0 rounded-lg" sizes="56px" /> : href ? <a href={href} target="_blank" rel="noreferrer" className="grid size-14 shrink-0 place-items-center rounded-lg bg-[#f0f0ee]" title={`打开 ${attachment.name}`}><FileText className="size-5" /></a> : <span className="grid size-14 shrink-0 place-items-center rounded-lg bg-[#f0f0ee] text-[13px]">附件不可用</span>}
            <span className="min-w-0 whitespace-normal break-words leading-5" title={attachment.name}>{attachment.name}</span>
            <button type="button" className="absolute right-1 top-1 grid size-6 place-items-center rounded-md text-tertiary hover:bg-white hover:text-ink" onClick={() => draftMode ? removePendingDraftAttachment(attachment.id) : removePendingAttachment(attachment.id)} aria-label={`移除附件 ${attachment.name}`} title="移除附件"><X className="size-3.5" /></button>
          </div>; })}
        </div> : null}
        {uploadError ? <div role="alert" className="px-5 pt-2 text-[15px] text-danger">{uploadError}</div> : null}
        {agents.error ? <div role="alert" className="px-5 pt-2 text-[15px] text-danger">{getWorkbenchErrorMessage(agents.error, "助手配置加载失败")}</div> : null}
        {models.error ? <div role="alert" className="px-5 pt-2 text-[15px] text-danger">{getWorkbenchErrorMessage(models.error, "模型加载失败")}</div> : null}
        <ComposerPrimitive.Input
          disabled={disabled || isUploading}
          autoFocus
          rows={1}
          aria-label="任务输入"
          placeholder="输入消息"
          className="min-h-[48px] max-h-40 w-full resize-none border-0 bg-transparent px-5 pb-2 pt-3 text-[15px] font-normal leading-6 text-ink outline-none placeholder:text-tertiary"
          onKeyDown={(event) => {
            if (event.key === "Escape" && isRunning) {
              event.preventDefault();
              aui.thread().cancelRun();
            }
          }}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files);
            if (files.length) {
              event.preventDefault();
              void uploadFiles(files);
            }
          }}
        />
        <div className="flex min-h-10 items-center gap-2 px-3 pb-2">
          <button type="button" className="icon-button" onClick={() => fileInputRef.current?.click()} disabled={disabled || isUploading || visibleAttachments.length >= MAX_ATTACHMENTS} title={isUploading ? "正在上传" : "上传图片或文档"} aria-label={isUploading ? "正在上传附件" : "上传图片或文档"}>{isUploading ? <span className="size-4 animate-spin rounded-full border-2 border-tertiary border-t-transparent" /> : <Plus className="size-[18px]" />}</button>
          <div className="min-w-0 flex-1" />

          <Popover.Root>
            <Popover.Trigger asChild>
              <button type="button" className="flex min-h-9 max-w-52 items-center gap-1.5 rounded-lg px-2 py-1 text-[15px] leading-5 text-secondary transition-colors hover:bg-panel hover:text-ink" aria-label="选择模型" title={selectedModel?.name || "选择模型"}>
                <span className="whitespace-normal break-words">{selectedModel?.name || "模型"}</span><ChevronDown className="size-3.5 shrink-0 text-tertiary" />
              </button>
            </Popover.Trigger>
            <Popover.Portal><Popover.Content side="top" align="end" sideOffset={10} className="z-50 w-64 rounded-xl border border-line bg-surface p-1.5 shadow-popover">
              {(models.data || []).map((model) => <Popover.Close asChild key={model.id}><button type="button" onClick={() => setModel(model.id, model.defaultReasoningEffort)} className="flex w-full items-start gap-2 rounded-lg px-3 py-2.5 text-left text-[15px] text-ink hover:bg-panel" title={model.name}><span className="min-w-0 flex-1 whitespace-normal break-words leading-5">{model.name}</span>{model.id === modelId ? <Check className="mt-0.5 size-4 shrink-0 text-ink" /> : null}</button></Popover.Close>)}
            </Popover.Content></Popover.Portal>
          </Popover.Root>

          <AuiIf condition={(state) => state.thread.isRunning}><ComposerPrimitive.Cancel className="grid size-10 shrink-0 place-items-center rounded-lg bg-panel text-ink ring-1 ring-line transition-colors hover:bg-[#efefef]" title="停止执行" aria-label="停止执行"><Square className="size-4 fill-current" /></ComposerPrimitive.Cancel></AuiIf>
          <AuiIf condition={(state) => !state.thread.isRunning}><ComposerPrimitive.Send disabled={disabled || isUploading || !agentId || !modelId} className="grid size-10 shrink-0 place-items-center rounded-lg bg-ink text-white transition-colors duration-150 hover:bg-black disabled:opacity-35" title="发送" aria-label="发送"><ArrowUp className="size-5 stroke-[2]" /></ComposerPrimitive.Send></AuiIf>
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
}
