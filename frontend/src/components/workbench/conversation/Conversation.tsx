"use client";

// assistant-ui's minimal thread template is the runtime source for the
// ThreadPrimitive, MessagePrimitive, action bar, and composer composition here.
import { useEffect, useMemo, useRef, useState } from "react";
import { ActionBarPrimitive, AssistantRuntimeProvider, AuiIf, MessagePrimitive, ThreadPrimitive, useAuiState, useExternalStoreRuntime, type AppendMessage, type ThreadMessageLike } from "@assistant-ui/react";
import { ArrowDown, Check, Copy, FileText, Pencil, X } from "lucide-react";
import type { AgentThreadState, MessageAttachment, MessageItem, RunTiming, TimelineItem } from "@/lib/agent-events/types";
import { MarkdownRenderer } from "@/components/workbench/renderers/MarkdownRenderer";
import { ApprovalPart } from "./ApprovalPart";
import { AgentComposer } from "@/components/workbench/composer/AgentComposer";
import { ImagePreview } from "@/components/workbench/attachments/ImagePreview";
import { ActivityRow } from "@/components/workbench/activity-row/ActivityRow";
import { resolveWorkbenchResourceUrl, safeLinkLabel, safeWorkbenchHref } from "@/lib/api/client";
import { getRunFailureMessage } from "@/lib/errors";

function toAppendText(message: AppendMessage) {
  if (typeof message.content === "string") return message.content;
  return message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

function timelineMessageLike(item: TimelineItem): ThreadMessageLike {
  if (item.kind === "message") {
    return {
      id: item.id,
      role: item.role,
      content: item.text,
      createdAt: new Date(item.createdAt),
      status: item.role === "assistant" ? (item.status === "streaming" ? { type: "running" } : { type: "complete", reason: "stop" }) : undefined
    };
  }
  if (item.kind === "tool") {
    return {
      id: item.id,
      role: "assistant",
      content: [{
        type: "tool-call",
        toolCallId: item.toolCallId,
        toolName: item.name,
        args: (item.input && typeof item.input === "object" ? item.input : {}) as Record<string, never>,
        result: item,
        isError: item.status === "failed"
      }],
      createdAt: new Date(item.createdAt),
      status: item.status === "running" ? { type: "running" } : { type: "complete", reason: "stop" }
    };
  }
  if (item.kind === "approval") {
    return {
      id: item.id,
      role: "assistant",
      content: [{
        type: "tool-call",
        toolCallId: item.toolCallId || item.approvalId,
        toolName: "确认",
        args: {},
        result: item,
        approval: { id: item.approvalId, approved: item.status === "pending" ? undefined : item.status === "approved" }
      }],
      createdAt: new Date(item.createdAt),
      status: item.status === "pending" ? { type: "requires-action", reason: "tool-calls" } : { type: "complete", reason: "stop" }
    };
  }
  return { id: item.id, role: "assistant", content: item.label, createdAt: new Date(item.createdAt), status: { type: "incomplete", reason: "error", error: item.label } };
}

export function Conversation({ state, composerThreadId = state.threadId, onStartRun, onStopRun, onResolveApproval, isResolvingApproval, isStarting }: { state: AgentThreadState; composerThreadId?: string | null; onStartRun: (message: string, replaceMessageId?: string, attachments?: string[]) => Promise<unknown>; onStopRun: () => Promise<unknown>; onResolveApproval: (approvalId: string, decision: "allow_once" | "always_allow" | "deny") => Promise<unknown>; isResolvingApproval: boolean; isStarting: boolean }) {
  const timelineItems = useMemo(
    () => [...new Set(state.itemOrder)]
      .map((id) => state.items[id])
      .filter((item): item is TimelineItem => Boolean(item)),
    [state.itemOrder, state.items]
  );
  const runtime = useExternalStoreRuntime<TimelineItem>({
    messages: timelineItems,
    isRunning: ["queued", "running", "waiting", "reconnecting"].includes(state.runStatus) || isStarting,
    onNew: async (message: AppendMessage) => { const text = toAppendText(message); if (text) await onStartRun(text); },
    onCancel: async () => { await onStopRun(); },
    setMessages: () => undefined,
    convertMessage: (message: TimelineItem) => timelineMessageLike(message)
  });

  return <AssistantRuntimeProvider runtime={runtime}><ConversationViewport state={state} onStartRun={onStartRun} onResolveApproval={onResolveApproval} isResolvingApproval={isResolvingApproval} /><div className="shrink-0 bg-surface pb-3 pt-1"><AgentComposer threadId={composerThreadId} disabled={isStarting} /></div></AssistantRuntimeProvider>;
}

/**
 * Stable shell shown while a different thread read-model is being fetched.
 * It deliberately does not accept an AgentThreadState, so stale/empty state
 * can never be rendered as a real conversation during the identity handoff.
 */
export function ConversationSkeleton() {
  return <div className="flex min-h-0 flex-1 flex-col bg-surface" role="status" aria-label="正在加载会话" aria-live="polite">
    <div className="min-h-0 flex-1 overflow-hidden px-4 py-5 md:px-8">
      <div className="mx-auto flex h-full max-w-[850px] flex-col justify-end gap-4" aria-hidden="true">
        <div className="h-4 w-2/5 rounded-md bg-panel" />
        <div className="h-4 w-3/5 rounded-md bg-panel" />
        <div className="ml-auto h-12 w-2/3 rounded-2xl bg-panel" />
      </div>
    </div>
    <div className="shrink-0 bg-surface px-3 pb-3 pt-1" aria-disabled="true">
      <div className="min-h-[112px] rounded-2xl border border-line bg-surface p-3 opacity-70">
        <div className="h-5 w-3/5 rounded-md bg-panel" aria-hidden="true" />
        <div className="mt-7 flex items-center justify-between" aria-hidden="true">
          <div className="h-8 w-28 rounded-lg bg-panel" />
          <div className="size-10 rounded-lg bg-panel" />
        </div>
      </div>
    </div>
  </div>;
}

function ConversationViewport({ state, onStartRun, onResolveApproval, isResolvingApproval }: { state: AgentThreadState; onStartRun: (message: string, replaceMessageId?: string, attachments?: string[]) => Promise<unknown>; onResolveApproval: (approvalId: string, decision: "allow_once" | "always_allow" | "deny") => Promise<unknown>; isResolvingApproval: boolean }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const viewport = viewportRef.current;
      if (viewport) viewport.scrollTo({ top: viewport.scrollHeight, behavior: state.lastSeq > 0 ? "smooth" : "auto" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [state.lastSeq]);
  return <ThreadPrimitive.Root className="min-h-0 flex-1"><ThreadPrimitive.Viewport ref={viewportRef} turnAnchor="bottom" data-testid="conversation-viewport" className="scrollbar-subtle h-full overflow-y-auto scroll-smooth"><div className="conversation-content py-3"><ThreadPrimitive.Empty><div className="grid min-h-[48vh] place-items-center px-4"><h2 className="text-balance text-center text-3xl font-semibold leading-tight text-ink md:text-4xl">今天想做什么？</h2></div></ThreadPrimitive.Empty><div className="flex flex-col" aria-live="polite"><ThreadPrimitive.Messages>{() => <RuntimeMessage state={state} onStartRun={onStartRun} onResolveApproval={onResolveApproval} isResolvingApproval={isResolvingApproval} />}</ThreadPrimitive.Messages></div><ThreadPrimitive.ScrollToBottom className="sticky bottom-3 mx-auto mt-2 grid size-9 place-items-center rounded-full border border-line bg-white text-secondary shadow-popover disabled:invisible" aria-label="滚动到底部"><ArrowDown className="size-4" /></ThreadPrimitive.ScrollToBottom></div></ThreadPrimitive.Viewport></ThreadPrimitive.Root>;
}

function RuntimeMessage({ state, onStartRun, onResolveApproval, isResolvingApproval }: { state: AgentThreadState; onStartRun: (message: string, replaceMessageId?: string, attachments?: string[]) => Promise<unknown>; onResolveApproval: (approvalId: string, decision: "allow_once" | "always_allow" | "deny") => Promise<unknown>; isResolvingApproval: boolean }) {
  const messageId = useAuiState((snapshot) => snapshot.message.id);
  const item = state.items[messageId];
  if (!item) return null;
  if (item.kind === "tool") return <MessagePrimitive.Root><ActivityRow item={item} /></MessagePrimitive.Root>;
  if (item.kind === "approval") return <MessagePrimitive.Root className="mb-1"><ApprovalPart item={item} disabled={isResolvingApproval} onResolve={(decision) => void onResolveApproval(item.approvalId, decision)} /></MessagePrimitive.Root>;
  if (item.kind === "status") return <MessagePrimitive.Root className="conversation-lane mb-2 py-1 text-[14px] leading-5 text-danger">{getRunFailureMessage(item.label)}</MessagePrimitive.Root>;
  const itemIndex = state.itemOrder.indexOf(item.id);
  const isFirstAssistant = item.role === "assistant" && !state.itemOrder.slice(0, itemIndex).some((id) => {
    const previous = state.items[id];
    return previous?.kind === "message" && previous.role === "assistant" && previous.runId === item.runId;
  });
  const isLastAssistant = item.role === "assistant" && !state.itemOrder.slice(itemIndex + 1).some((id) => {
    const following = state.items[id];
    return following?.kind === "message" && following.role === "assistant" && following.runId === item.runId;
  });
  const runMessages = state.itemOrder
    .map((id) => state.items[id])
    .filter((candidate): candidate is MessageItem => candidate?.kind === "message" && candidate.role === "assistant" && candidate.runId === item.runId);
  const runComplete = state.runStatuses[item.runId] === "completed" && runMessages.length > 0 && runMessages.every((message) => message.status === "completed");
  const isLatestUser = item.role === "user" && !state.itemOrder.slice(itemIndex + 1).some((id) => state.items[id]?.kind === "message" && state.items[id]?.role === "user");
  const canEdit = isLatestUser && ["completed", "failed", "stopped"].includes(state.runStatuses[item.runId] || "");
  return <MessageEntry item={item} timing={isFirstAssistant ? state.runTimings[item.runId] : undefined} editable={canEdit} onResubmit={onStartRun} assistantReply={isLastAssistant && runComplete ? runMessages.map((message) => message.text).filter(Boolean).join("\n\n") : undefined} />;
}

function MessageEntry({ item, timing, editable, onResubmit, assistantReply }: { item: MessageItem; timing?: RunTiming; editable: boolean; onResubmit: (message: string, replaceMessageId?: string, attachments?: string[]) => Promise<unknown>; assistantReply?: string }) {
  const isUser = item.role === "user";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);
  const [submitting, setSubmitting] = useState(false);
  const submitEdit = async () => {
    const value = draft.trim();
    if (!value || submitting) return;
    setSubmitting(true);
    try {
      await onResubmit(value, item.id, item.attachments?.map((attachment) => attachment.id));
      setEditing(false);
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <MessagePrimitive.Root className={isUser ? "conversation-lane group mb-3 flex justify-end" : "group mb-2"} data-message-id={item.id}>
      <div className={isUser ? "flex min-w-0 max-w-[min(850px,82%)] flex-col items-end" : "max-w-none"}>
        {!isUser && timing ? <RunElapsed timing={timing} agentName={item.agentName} /> : null}
        <MessageAttachments attachments={item.attachments} isUser={isUser} />
        {item.text ? editing && isUser ? <div className="rounded-[18px] bg-[#f3f3f3] px-4 py-2 text-[16px] text-ink"><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void submitEdit(); } if (event.key === "Escape") { event.preventDefault(); setEditing(false); } }} autoFocus rows={2} aria-label="编辑当前消息" className="min-h-12 w-full resize-none border-0 bg-transparent leading-6 outline-none ring-0" /><div className="mt-1 flex justify-end gap-1"><button type="button" className="message-action" onClick={() => setEditing(false)} title="取消编辑" aria-label="取消编辑"><X className="size-4" /></button><button type="button" className="message-action text-ink" onClick={() => void submitEdit()} disabled={!draft.trim() || submitting} title="发送修改" aria-label="发送修改"><Check className="size-4" /></button></div></div> : <div className={isUser ? "rounded-[18px] bg-[#f3f3f3] px-4 py-2 text-[16px] font-normal leading-6 text-ink" : item.status === "streaming" ? "streaming-cursor" : ""}>
          {isUser ? <MessagePrimitive.Parts /> : <MessagePrimitive.Parts components={{ Text: () => <MarkdownRenderer>{item.text}</MarkdownRenderer> }} />}
        </div> : null}
        {!isUser && item.citations?.length ? <MessageCitations citations={item.citations} /> : null}
        <MessageActions item={item} isUser={isUser} editable={editable} onEdit={() => setEditing(true)} assistantReply={assistantReply} />
      </div>
    </MessagePrimitive.Root>
  );
}

function MessageCitations({ citations }: { citations: NonNullable<MessageItem["citations"]> }) {
  return <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[14px] leading-5 text-secondary">
    {citations.map((citation, index) => {
      const href = safeWorkbenchHref(citation.url);
      if (!href) return null;
      const label = safeLinkLabel(citation.label, `来源 ${index + 1}`);
      return <a key={`${citation.url}:${index}`} href={href} target="_blank" rel="noopener noreferrer" className="whitespace-normal break-words underline decoration-line underline-offset-2 hover:text-ink" title={label}>{`[${index + 1}] ${label}`}</a>;
    })}
  </div>;
}

function RunElapsed({ timing, agentName }: { timing: RunTiming; agentName?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (timing.completedAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [timing.completedAt]);
  const end = timing.completedAt ? new Date(timing.completedAt).getTime() : now;
  const seconds = Math.max(0, Math.floor((end - new Date(timing.startedAt).getTime()) / 1000));
  const minutes = Math.floor(seconds / 60);
  return <div className="mb-1.5 text-[15px] leading-6 text-secondary">{agentName ? <><span>{agentName}</span><span className="mx-1 text-tertiary">·</span></> : null}<span>已处理 <span className="tabular-nums">{minutes ? `${minutes} 分 ` : ""}{seconds % 60} 秒</span></span></div>;
}

function MessageActions({ item, isUser, editable, onEdit, assistantReply }: { item: MessageItem; isUser: boolean; editable: boolean; onEdit: () => void; assistantReply?: string }) {
  const [copied, setCopied] = useState(false);
  const copyReply = async () => {
    if (!assistantReply) return;
    await navigator.clipboard.writeText(assistantReply);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };
  const time = useMemo(() => new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(item.createdAt)), [item.createdAt]);
  if (!isUser && !assistantReply) return null;
  return (
    <div className={`mt-0 flex h-7 items-center gap-0.5 text-[15px] leading-6 text-tertiary ${isUser ? "justify-end" : "justify-start"}`}>
      {isUser ? <time className="mr-1 tabular-nums" dateTime={item.createdAt}>{time}</time> : null}
      {isUser && item.text ? <ActionBarPrimitive.Root className="flex items-center gap-0.5">
        <ActionBarPrimitive.Copy asChild>
          <button type="button" className="message-action" title="复制用户消息" aria-label="复制用户消息">
            <AuiIf condition={(snapshot) => snapshot.message.isCopied}><Check className="size-[18px] text-success" /></AuiIf>
            <AuiIf condition={(snapshot) => !snapshot.message.isCopied}><Copy className="size-[18px]" /></AuiIf>
          </button>
        </ActionBarPrimitive.Copy>
      </ActionBarPrimitive.Root> : null}
      {!isUser && assistantReply ? <button type="button" className="message-action" onClick={() => void copyReply()} title="复制完整回复" aria-label="复制完整回复">{copied ? <Check className="size-[18px] text-success" /> : <Copy className="size-[18px]" />}</button> : null}
      {isUser && item.text && editable ? <button type="button" className="message-action" onClick={onEdit} title="编辑最新消息" aria-label="编辑最新消息"><Pencil className="size-[18px]" /></button> : null}
    </div>
  );
}

function MessageAttachments({ attachments, isUser }: { attachments?: MessageAttachment[]; isUser: boolean }) {
  if (!attachments?.length) return null;
  return <div className={`mb-1 flex max-w-full flex-wrap gap-2 ${isUser ? "justify-end" : "justify-start"}`}>
    {attachments.map((attachment) => { const href = safeWorkbenchHref(resolveWorkbenchResourceUrl(attachment.url)); return attachment.kind === "image" && href ? (
      <ImagePreview key={attachment.id} src={href} alt={attachment.name} className="h-24 w-28 rounded-xl" sizes="128px" />
    ) : href ? (
      <a key={attachment.id} href={href} target="_blank" rel="noreferrer" className="flex min-h-9 max-w-64 items-start gap-2 rounded-lg bg-panel px-3 py-2 text-[15px] text-secondary hover:text-ink" title={`打开文档 ${attachment.name}`}>
        <FileText className="mt-0.5 size-4 shrink-0" /><span className="whitespace-normal break-words" title={attachment.name}>{attachment.name}</span>
      </a>
    ) : null; })}
  </div>;
}
