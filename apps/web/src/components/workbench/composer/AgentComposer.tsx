"use client";

// assistant-ui owns the composer lifecycle; the workbench supplies the model
// selection, attachments, and run controls around it.
import { useCallback, useEffect, useRef, useState } from "react";
import { AuiIf, ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import * as Popover from "@radix-ui/react-popover";
import { ArrowUp, Check, ChevronDown, FileText, Plus, Square, X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { workbenchApi, safeWorkbenchHref, safeWorkbenchImageSrc } from "@/lib/api/client";
import { ImagePreview } from "@/components/workbench/attachments/ImagePreview";
import {
  useWorkbenchUiStore,
  type DraftAttachment
} from "@/stores/workbench-ui-store";
import type { MessageAttachment } from "@/lib/agent-events/types";
import { resolveWorkbenchResourceUrl } from "@/lib/api/client";
import { getWorkbenchErrorMessage } from "@/lib/errors";
import {
  normalizeV2CommandContent,
  type V2ClientCommandState
} from "@/lib/agent-events/v2/interaction-controller";
import {
  routeV2ComposerClick,
  routeV2ComposerKey,
  type V2ComposerSubmitMode
} from "@/lib/agent-events/v2/composer-routing";
import type { V2PreviewInteractionRuntime } from "@/lib/agent-events/v2/use-v2-preview-interaction";

const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

type PreviewAttachment = MessageAttachment | DraftAttachment;

interface PreviewDraftSnapshot {
  readonly content: string;
  readonly attachmentRefs: readonly string[];
  readonly attachments: readonly PreviewAttachment[];
  readonly draftMode: boolean;
  readonly cleared: boolean;
}

function isDraftAttachment(attachment: PreviewAttachment): attachment is DraftAttachment {
  return "file" in attachment;
}

export function AgentComposer({
  threadId,
  disabled,
  previewInteraction = null
}: {
  threadId: string | null;
  disabled?: boolean;
  previewInteraction?: V2PreviewInteractionRuntime | null;
}) {
  const aui = useAui();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeThreadId = useRef<string | null>(threadId);
  const previewSubmissionRef = useRef(false);
  const previewStopGenerationRef = useRef(0);
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const composerText = useAuiState((state) => state.composer.text);
  const agents = useQuery({ queryKey: ["agents"], queryFn: workbenchApi.agents });
  const models = useQuery({ queryKey: ["models"], queryFn: workbenchApi.models });
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [previewMode, setPreviewMode] = useState<V2ComposerSubmitMode>("enqueue");
  const [previewBusy, setPreviewBusy] = useState(false);
  // 阻断项 1：停止必须独立于提交/重试/引导的命令锁。用单独的 in-flight
  // 标记与 busy 状态，保证任何命令挂起时停止按钮仍可点击，且重复停止幂等。
  const stopInFlightRef = useRef(false);
  const [stopBusy, setStopBusy] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [previewDrafts, setPreviewDrafts] = useState<ReadonlyMap<string, PreviewDraftSnapshot>>(
    () => new Map()
  );
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
  const previewActive = Boolean(previewInteraction?.activeRun);
  const lastPreviewCommandId = previewInteraction?.controllerState.order.at(-1);
  const lastPreviewCommand = lastPreviewCommandId
    ? previewInteraction?.controllerState.commands[lastPreviewCommandId] ?? null
    : null;
  const recoveryCandidateId = previewInteraction
    ? [...previewInteraction.controllerState.order].reverse().find((commandId) => {
        const command = previewInteraction.controllerState.commands[commandId];
        const snapshot = previewDrafts.get(commandId);
        return Boolean(
          snapshot?.cleared
          && (command?.status === "rejected" || command?.status === "failed")
        );
      }) ?? null
    : null;
  const restorableCommandId = recoveryCandidateId
    && (composerText.length > 0 || visibleAttachments.length > 0)
    ? recoveryCandidateId
    : null;

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

  const clearVisibleAttachments = () => {
    if (draftMode) clearPendingDraftAttachments();
    else clearPendingAttachments();
  };

  const submitPreview = async (mode: V2ComposerSubmitMode) => {
    const content = aui.composer().getState().text.trim();
    if (
      !previewInteraction
      || !previewInteraction.activeRun
      || !content
      || previewSubmissionRef.current
    ) return;
    const submissionAttachments = [...visibleAttachments] as PreviewAttachment[];
    const attachmentRefs = submissionAttachments.map((attachment) => attachment.id);
    const stopGeneration = previewStopGenerationRef.current;
    previewSubmissionRef.current = true;
    setPreviewBusy(true);
    setPreviewError("");
    try {
      const result = await previewInteraction.submitComposer(
        mode,
        content,
        attachmentRefs
      );
      let cleared = false;
      if (
        previewStopGenerationRef.current === stopGeneration
        && (
          result.status === "accepted_pending"
          || result.status === "applied"
          || result.status === "superseded"
        )
      ) {
        const store = useWorkbenchUiStore.getState();
        const currentAttachments = draftMode
          ? store.pendingDraftAttachments
          : store.pendingAttachments;
        cleared = clearAcceptedPreviewSnapshot(
          result,
          aui.composer().getState().text,
          currentAttachments.map((attachment) => attachment.id)
        );
      }
      const snapshot: PreviewDraftSnapshot = {
        content: result.snapshot.content,
        attachmentRefs: [...result.snapshot.attachmentRefs],
        attachments: submissionAttachments,
        draftMode,
        cleared
      };
      setPreviewDrafts((current) => new Map(current).set(result.commandId, snapshot));
    } finally {
      previewSubmissionRef.current = false;
      setPreviewBusy(false);
    }
  };

  function clearAcceptedPreviewSnapshot(
    command: V2ClientCommandState,
    currentContent: string,
    currentAttachmentRefs: readonly string[]
  ) {
    if (
      command.status !== "accepted_pending"
      && command.status !== "applied"
      && command.status !== "superseded"
    ) return false;
    const sameContent = normalizeV2CommandContent(currentContent)
      === command.snapshot.content;
    const sameAttachments = currentAttachmentRefs.length
      === command.snapshot.attachmentRefs.length
      && currentAttachmentRefs.every(
        (ref, index) => ref === command.snapshot.attachmentRefs[index]
      );
    if (!sameContent || !sameAttachments) return false;
    aui.composer().setText("");
    clearVisibleAttachments();
    return true;
  }

  const retryPreview = async () => {
    if (
      !previewInteraction
      || !lastPreviewCommand?.retryable
      || previewSubmissionRef.current
    ) return;
    const stopGeneration = previewStopGenerationRef.current;
    previewSubmissionRef.current = true;
    setPreviewBusy(true);
    setPreviewError("");
    try {
      const result = await previewInteraction.retry(lastPreviewCommand.commandId);
      if (result && previewStopGenerationRef.current === stopGeneration) {
        const store = useWorkbenchUiStore.getState();
        const currentAttachments = draftMode
          ? store.pendingDraftAttachments
          : store.pendingAttachments;
        const cleared = clearAcceptedPreviewSnapshot(
          result,
          aui.composer().getState().text,
          currentAttachments.map((attachment) => attachment.id)
        );
        if (cleared) {
          setPreviewDrafts((current) => {
            const snapshot = current.get(result.commandId);
            return snapshot
              ? new Map(current).set(result.commandId, { ...snapshot, cleared: true })
              : current;
          });
        }
      }
    } finally {
      previewSubmissionRef.current = false;
      setPreviewBusy(false);
    }
  };

  const stopPreview = async () => {
    // 阻断项 1：停止不看 previewSubmissionRef（提交锁），只看自己的
    // stopInFlightRef。这样提交、重试或引导挂起时停止仍可发起。
    // 重复点击靠 stopInFlightRef 幂等，不会二次发送。
    if (!previewInteraction || stopInFlightRef.current) return;
    stopInFlightRef.current = true;
    setStopBusy(true);
    setPreviewError("");
    try {
      const stopped = await previewInteraction.stop();
      if (stopped) previewStopGenerationRef.current += 1;
      else setPreviewError("停止请求未完成，请检查当前任务状态");
    } finally {
      stopInFlightRef.current = false;
      setStopBusy(false);
    }
  };

  const restorePreviewSnapshot = useCallback((commandId: string) => {
    const snapshot = previewDrafts.get(commandId);
    if (!snapshot) return false;

    aui.composer().setText(snapshot.content);
    if (snapshot.draftMode) {
      clearPendingDraftAttachments();
      const drafts = snapshot.attachments
        .filter(isDraftAttachment)
        .map((attachment) => ({
          ...attachment,
          url: URL.createObjectURL(attachment.file)
        }));
      if (drafts.length > 0) addPendingDraftAttachments(drafts);
    } else {
      clearPendingAttachments();
      if (snapshot.attachments.length > 0) {
        addPendingAttachments(snapshot.attachments.map((attachment) => ({ ...attachment })));
      }
    }
    setPreviewDrafts((current) => {
      if (!current.has(commandId)) return current;
      const next = new Map(current);
      next.delete(commandId);
      return next;
    });
    return true;
  }, [
    addPendingAttachments,
    addPendingDraftAttachments,
    aui,
    clearPendingAttachments,
    clearPendingDraftAttachments,
    previewDrafts
  ]);

  useEffect(() => {
    if (
      !recoveryCandidateId
      || composerText.length > 0
      || visibleAttachments.length > 0
    ) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) restorePreviewSnapshot(recoveryCandidateId);
    });
    return () => {
      cancelled = true;
    };
  }, [
    composerText.length,
    recoveryCandidateId,
    restorePreviewSnapshot,
    visibleAttachments.length
  ]);

  return (
    <ComposerPrimitive.Root className="conversation-composer flex flex-col" data-testid="composer">
      <input ref={fileInputRef} type="file" multiple className="sr-only" aria-label="选择图片或文档" accept="image/*,.pdf,.txt,.md,.csv,.json,.doc,.docx,.xls,.xlsx,.ppt,.pptx" onChange={(event) => { void uploadFiles(Array.from(event.target.files || [])); event.target.value = ""; }} />
      <div className="flex flex-col rounded-2xl border border-[#d8d8d8] bg-surface shadow-composer" onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }} onDrop={(event) => { event.preventDefault(); void uploadFiles(Array.from(event.dataTransfer.files)); }}>
          {visibleAttachments.length ? <div className="flex flex-wrap gap-2 px-4 pt-3" aria-label="待发送附件">
          {visibleAttachments.map((attachment) => { const href = safeWorkbenchHref(resolveWorkbenchResourceUrl(attachment.url)); const imageSrc = safeWorkbenchImageSrc(attachment.url); const remove = () => draftMode ? removePendingDraftAttachment(attachment.id) : removePendingAttachment(attachment.id); return attachment.kind === "image" && imageSrc ? <div key={attachment.id} className="group/attachment relative size-16 overflow-hidden rounded-xl bg-panel">
            <ImagePreview src={imageSrc} alt="已上传图片" className="size-16 rounded-xl" sizes="64px" />
            <button type="button" className="absolute right-1 top-1 grid size-6 place-items-center rounded-full bg-black/55 text-white transition-colors hover:bg-black/75" onClick={remove} aria-label="移除图片" title="移除图片"><X className="size-3.5" /></button>
          </div> : <div key={attachment.id} className="group/attachment relative flex min-h-14 max-w-72 items-start gap-2 rounded-lg bg-panel py-2 pr-8 text-[15px] text-secondary">
            {href ? <a href={href} target="_blank" rel="noreferrer" className="grid size-14 shrink-0 place-items-center rounded-lg bg-[#f0f0ee]" title={`打开 ${attachment.name}`}><FileText className="size-5" /></a> : <span className="grid size-14 shrink-0 place-items-center rounded-lg bg-[#f0f0ee] text-[13px]">附件不可用</span>}
            <span className="min-w-0 whitespace-normal break-words leading-5" title={attachment.name}>{attachment.name}</span>
            <button type="button" className="absolute right-1 top-1 grid size-6 place-items-center rounded-md text-tertiary hover:bg-white hover:text-ink" onClick={remove} aria-label={`移除附件 ${attachment.name}`} title="移除附件"><X className="size-3.5" /></button>
          </div>; })}
        </div> : null}
        {uploadError ? <div role="alert" className="px-5 pt-2 text-[15px] text-danger">{uploadError}</div> : null}
        {agents.error ? <div role="alert" className="px-5 pt-2 text-[15px] text-danger">{getWorkbenchErrorMessage(agents.error, "对话配置加载失败")}</div> : null}
        {models.error ? <div role="alert" className="px-5 pt-2 text-[15px] text-danger">{getWorkbenchErrorMessage(models.error, "模型加载失败")}</div> : null}
        {previewInteraction && (
          previewError
          || previewInteraction.feedback
          || restorableCommandId
        ) ? (
          <div className="flex min-w-0 items-baseline gap-2 px-5 pt-2 text-[13px] leading-5">
            <span
              className={`min-w-0 break-words ${previewError ? "text-danger" : "text-tertiary"}`}
              aria-live="polite"
              data-testid="v2-composer-feedback"
            >
              {previewError || previewInteraction.feedback}
            </span>
            {lastPreviewCommand?.retryable ? (
              <button
                type="button"
                className="shrink-0 text-ink underline decoration-line underline-offset-2 disabled:opacity-40"
                aria-label="重试上次提交"
                disabled={previewBusy}
                onClick={() => void retryPreview()}
              >
                重试
              </button>
            ) : null}
            {restorableCommandId ? (
              <button
                type="button"
                className="shrink-0 text-ink underline decoration-line underline-offset-2"
                aria-label="恢复原提交内容"
                onClick={() => restorePreviewSnapshot(restorableCommandId)}
              >
                恢复原提交
              </button>
            ) : null}
          </div>
        ) : null}
        <ComposerPrimitive.Input
          disabled={disabled || isUploading}
          rows={1}
          aria-label="任务输入"
          placeholder="输入消息"
          className="min-h-[48px] max-h-40 w-full resize-none border-0 bg-transparent px-5 pb-2 pt-3 text-[15px] font-normal leading-6 text-ink outline-none placeholder:text-tertiary"
          onKeyDown={(event) => {
            if (previewInteraction) {
              const reactIsComposing = (
                event as typeof event & { readonly isComposing?: boolean }
              ).isComposing === true;
              const route = routeV2ComposerKey({
                key: event.key,
                shiftKey: event.shiftKey,
                ctrlKey: event.ctrlKey,
                metaKey: event.metaKey,
                repeat: event.repeat,
                isComposing: reactIsComposing,
                nativeIsComposing: event.nativeEvent.isComposing
              }, previewInteraction.activeRun);
              if (
                event.key === "Enter"
                && route === "ignore"
                && (event.repeat || reactIsComposing || event.nativeEvent.isComposing)
              ) {
                event.preventDefault();
                return;
              }
              if (route === "enqueue" || route === "steer") {
                event.preventDefault();
                event.stopPropagation();
                void submitPreview(route);
                return;
              }
            }
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

          {previewActive ? (
            <select
              value={previewMode}
              onChange={(event) => setPreviewMode(event.target.value as V2ComposerSubmitMode)}
              className="min-h-9 max-w-[112px] rounded-md border border-line bg-surface px-2 text-[13px] text-secondary outline-none sm:hidden"
              aria-label="运行中发送模式"
              disabled={previewBusy}
            >
              <option value="enqueue">下一条消息</option>
              <option value="steer">引导当前任务</option>
            </select>
          ) : null}

          <div className={previewActive ? "hidden sm:block" : ""}>
            <Popover.Root open={modelMenuOpen} onOpenChange={setModelMenuOpen}>
              <Popover.Trigger asChild>
                <button type="button" className="flex min-h-9 max-w-52 items-center gap-1.5 rounded-lg px-2 py-1 text-[15px] leading-5 text-secondary transition-colors hover:bg-panel hover:text-ink" aria-label="选择模型" title={selectedModel?.name || "选择模型"}>
                  <span className="whitespace-normal break-words">{modelMenuOpen ? "模型" : selectedModel?.name || "模型"}</span><ChevronDown className="size-3.5 shrink-0 text-tertiary" />
                </button>
              </Popover.Trigger>
              <Popover.Portal><Popover.Content side="top" align="end" sideOffset={10} className="z-50 w-64 rounded-xl border border-line bg-surface p-1.5 shadow-popover">
                {(models.data || []).map((model) => <Popover.Close asChild key={model.id}><button type="button" onClick={() => setModel(model.id, model.defaultReasoningEffort)} className="flex w-full items-start gap-2 rounded-lg px-3 py-2.5 text-left text-[15px] text-ink hover:bg-panel" title={`${model.name} · ${model.id}`} aria-label={model.name}><span className="min-w-0 flex-1 leading-5"><span className="block whitespace-normal break-words">{model.name}</span><span className="mt-0.5 block font-mono text-[12px] text-tertiary">{model.id}</span></span>{model.id === modelId ? <Check className="mt-0.5 size-4 shrink-0 text-ink" /> : null}</button></Popover.Close>)}
              </Popover.Content></Popover.Portal>
            </Popover.Root>
          </div>

          {previewActive ? (
            <>
              <button
                type="button"
                className="grid size-10 shrink-0 place-items-center rounded-lg bg-panel text-ink ring-1 ring-line transition-colors hover:bg-[#efefef] disabled:opacity-35"
                title="停止执行"
                aria-label="停止执行"
                aria-busy={stopBusy}
                disabled={stopBusy}
                onClick={() => void stopPreview()}
              >
                <Square className="size-4 fill-current" />
              </button>
              <button
                type="button"
                className="grid size-10 shrink-0 place-items-center rounded-lg bg-ink text-white transition-colors duration-150 hover:bg-black disabled:opacity-35"
                title={previewMode === "steer" ? "引导当前任务" : "发送下一条消息"}
                aria-label={previewMode === "steer" ? "引导当前任务" : "发送下一条消息"}
                aria-busy={previewBusy}
                disabled={disabled || isUploading || previewBusy || !composerText.trim()}
                onClick={() => {
                  const route = routeV2ComposerClick(true, previewMode);
                  if (route !== "send") void submitPreview(route);
                }}
              >
                <ArrowUp className="size-5 stroke-[2]" />
              </button>
            </>
          ) : (
            <>
              <AuiIf condition={(state) => state.thread.isRunning}><ComposerPrimitive.Cancel className="grid size-10 shrink-0 place-items-center rounded-lg bg-panel text-ink ring-1 ring-line transition-colors hover:bg-[#efefef]" title="停止执行" aria-label="停止执行"><Square className="size-4 fill-current" /></ComposerPrimitive.Cancel></AuiIf>
              <AuiIf condition={(state) => !state.thread.isRunning}><ComposerPrimitive.Send disabled={disabled || isUploading || !agentId || !modelId} className="grid size-10 shrink-0 place-items-center rounded-lg bg-ink text-white transition-colors duration-150 hover:bg-black disabled:opacity-35" title="发送" aria-label="发送"><ArrowUp className="size-5 stroke-[2]" /></ComposerPrimitive.Send></AuiIf>
            </>
          )}
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
}
