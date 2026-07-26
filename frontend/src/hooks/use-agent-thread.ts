"use client";

// Subscription/read-model split follows Kanna useKannaState + event-store and
// OpenHands use-event-store, transported as resumable SSE for this stack.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AGENT_EVENT_TYPES, type AgentEvent, type AgentThreadState } from "@/lib/agent-events/types";
import { parseAgentEvent } from "@/lib/agent-events/schema";
import { reduceAgentEvent } from "@/lib/agent-events/reducer";
import { createRenderQueue } from "@/lib/agent-events/typewriter-queue";
import { workbenchApi } from "@/lib/api/client";
import { useWorkbenchUiStore } from "@/stores/workbench-ui-store";

export type StreamConnection = "idle" | "connecting" | "connected" | "reconnecting" | "disconnected";

export function useAgentThread(threadId: string | null) {
  const queryClient = useQueryClient();
  const snapshotQuery = useQuery({ queryKey: ["thread", threadId], queryFn: () => workbenchApi.thread(threadId!), enabled: Boolean(threadId), placeholderData: threadId ? keepPreviousData : undefined });
  const [state, setState] = useState<AgentThreadState | null>(null);
  const [connection, setConnection] = useState<StreamConnection>("idle");
  const lastSeqRef = useRef(0);
  const identityRef = useRef<string | null>(threadId);
  const selectedToolIds = useWorkbenchUiStore((store) => store.selectedToolIds);
  const agentId = useWorkbenchUiStore((store) => store.agentId);
  const modelId = useWorkbenchUiStore((store) => store.modelId);
  const reasoningEffort = useWorkbenchUiStore((store) => store.reasoningEffort);
  const permissionMode = useWorkbenchUiStore((store) => store.permissionMode);
  const pendingAttachments = useWorkbenchUiStore((store) => store.pendingAttachments);
  const clearPendingAttachments = useWorkbenchUiStore((store) => store.clearPendingAttachments);

  useEffect(() => {
    if (identityRef.current === threadId) return;
    identityRef.current = threadId;
    lastSeqRef.current = 0;
    // The shell's selection gate will keep the previous frame out of view;
    // clearing the read model here also guarantees the old SSE subscription
    // cannot feed events into the newly selected thread during the fetch gap.
    setState(null);
    setConnection("idle");
  }, [threadId]);

  useEffect(() => {
    if (!threadId) {
      // A draft is an explicit empty selection. Never retain the previous
      // thread read model or its SSE cursor while the shell stays mounted.
      lastSeqRef.current = 0;
      return;
    }
    if (!snapshotQuery.data || snapshotQuery.data.thread.id !== threadId) return;
    // The event reducer needs an independent mutable stream snapshot.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState(snapshotQuery.data.state);
    lastSeqRef.current = snapshotQuery.data.state.lastSeq;
  }, [snapshotQuery.data, threadId]);

  useEffect(() => {
    const activeThread = Boolean(threadId && state?.threadId === threadId);
    const runId = activeThread ? state?.activeRunId : null;
    const activeProjectId = activeThread ? state?.projectId ?? null : null;
    const activeThreadId = activeThread ? state?.threadId || threadId! : threadId;
    const activeRunStatus = activeThread ? state?.runStatus : "idle";
    if (!activeThread || !runId || ["idle", "completed", "failed", "stopped"].includes(activeRunStatus || "idle")) {
      return;
    }
    const source = new EventSource(workbenchApi.eventUrl(runId, lastSeqRef.current));
    type RenderQueueItem = { event: AgentEvent; characters: string[] | null; offset: number };
    const renderQueue: RenderQueueItem[] = [];
    let renderFrame = 0;
    let disposed = false;

    const applyEvent = (event: AgentEvent) => {
      setState((current) => (current ? reduceAgentEvent(current, event) : current));
      if (event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled") {
        setConnection("idle");
      }
    };

    const drainRenderQueue = () => {
      renderFrame = 0;
      if (disposed) return;
      while (renderQueue.length > 0) {
        const current = renderQueue[0];
        if (current.characters) {
          if (current.offset < current.characters.length) {
            const characterIndex = current.offset++;
            const synthetic = {
              ...current.event,
              // The reducer enforces monotonic durable sequence numbers. Use
              // fractional display-only positions inside this one persisted
              // delta so each grapheme is rendered exactly once and the next
              // real event still has a larger integer sequence.
              seq: current.event.seq - 1 + (characterIndex + 1) / (current.characters.length + 1),
              payload: { ...current.event.payload, delta: current.characters[characterIndex] }
            } satisfies AgentEvent;
            applyEvent(synthetic);
            renderFrame = window.requestAnimationFrame(drainRenderQueue);
            return;
          }
          renderQueue.shift();
          continue;
        }
        renderQueue.shift();
        applyEvent(current.event);
      }
    };

    const scheduleRender = () => {
      if (!disposed && !renderFrame) renderFrame = window.requestAnimationFrame(drainRenderQueue);
    };

    const enqueueEvent = (event: AgentEvent) => {
      if (event.type === "message.reset") {
        // A quality retry invalidates any unrendered portion of the previous
        // draft. Drop only queued deltas, preserve preceding control/tool
        // events, then apply the reset in durable order.
        const retained = renderQueue.filter((item) => item.event.type !== "text.delta" && item.event.type !== "message.delta");
        renderQueue.splice(0, renderQueue.length, ...retained, { event, characters: null, offset: 0 });
        scheduleRender();
        return;
      }
      if (event.type === "text.delta" || event.type === "message.delta") {
        const characters = Array.from(String(event.payload.delta || ""));
        if (characters.length > 0) renderQueue.push({ event, characters, offset: 0 });
      } else {
        renderQueue.push({ event, characters: null, offset: 0 });
      }
      scheduleRender();
    };

    const onEvent = (raw: Event) => {
      try {
        const message = raw as MessageEvent<string>;
        const event = parseAgentEvent(JSON.parse(message.data), { projectId: activeProjectId, threadId: activeThreadId!, runId });
        lastSeqRef.current = Math.max(lastSeqRef.current, event.seq);
        enqueueEvent(event);
      } catch (error) {
        console.error("Invalid AgentEvent", error);
      }
    };
    AGENT_EVENT_TYPES.forEach((type) => source.addEventListener(type, onEvent));
    source.onmessage = onEvent;
    source.onopen = () => setConnection("connected");
    source.onerror = () => setConnection(source.readyState === EventSource.CLOSED ? "disconnected" : "reconnecting");
    return () => {
      disposed = true;
      if (renderFrame) window.cancelAnimationFrame(renderFrame);
      renderQueue.length = 0;
      AGENT_EVENT_TYPES.forEach((type) => source.removeEventListener(type, onEvent));
      source.close();
    };
  }, [state?.activeRunId, state?.projectId, state?.threadId, state?.runStatus, threadId]);

  const startMutation = useMutation({
    mutationFn: ({ message, replaceMessageId, attachments }: { message: string; replaceMessageId?: string; attachments?: string[] }) => {
      if (!threadId) throw new Error("请先发送首条指令");
      return workbenchApi.startRun(threadId, { message, agentId, modelId, reasoningEffort, toolIds: selectedToolIds, permissionMode, attachmentIds: attachments || pendingAttachments.map((attachment) => attachment.id), replaceMessageId: replaceMessageId || null });
    },
    onSuccess: () => {
      clearPendingAttachments();
      void (async () => {
        const refreshed = await workbenchApi.thread(threadId!);
        queryClient.setQueryData(["thread", threadId], refreshed);
        lastSeqRef.current = refreshed.state.lastSeq;
        setState(refreshed.state);
      })();
    }
  });

  const stopMutation = useMutation({
    mutationFn: () => {
      if (!state?.activeRunId || state.threadId !== threadId) throw new Error("没有正在运行的任务");
      return workbenchApi.stopRun(state.activeRunId);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["thread", threadId] });
    }
  });

  const approvalMutation = useMutation({
    mutationFn: ({ approvalId, decision }: { approvalId: string; decision: "allow_once" | "always_allow" | "deny" }) => workbenchApi.resolveApproval(approvalId, decision),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["thread", threadId] });
    }
  });

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ["thread", threadId] });
  }, [queryClient, threadId]);

  const visibleState = threadId ? state : null;
  return useMemo(() => ({
    snapshot: snapshotQuery.data,
    state: visibleState,
    connection: threadId ? connection : "idle" as StreamConnection,
    isLoading: snapshotQuery.isLoading,
    isFetching: snapshotQuery.isFetching,
    error: snapshotQuery.error || startMutation.error || stopMutation.error || approvalMutation.error,
    startRun: (message: string, replaceMessageId?: string, attachments?: string[]) => startMutation.mutateAsync({ message, replaceMessageId, attachments }),
    stopRun: stopMutation.mutateAsync,
    resolveApproval: approvalMutation.mutateAsync,
    isResolvingApproval: approvalMutation.isPending,
    refresh,
    isStarting: startMutation.isPending
  }), [approvalMutation.error, approvalMutation.isPending, approvalMutation.mutateAsync, connection, refresh, snapshotQuery.data, snapshotQuery.error, snapshotQuery.isFetching, snapshotQuery.isLoading, startMutation, threadId, visibleState, stopMutation.error, stopMutation.mutateAsync]);
}
