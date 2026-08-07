"use client";

// Subscription/read-model split follows Kanna useKannaState + event-store and
// OpenHands use-event-store, transported as resumable SSE for this stack.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AGENT_EVENT_TYPES, type AgentEvent, type AgentThreadState } from "@/lib/agent-events/types";
import { parseAgentEvent } from "@/lib/agent-events/schema";
import { reduceAgentEvent, truncateThreadStateForEdit } from "@/lib/agent-events/reducer";
import { createRenderQueue } from "@/lib/agent-events/typewriter-queue";
import { workbenchApi } from "@/lib/api/client";
import { useWorkbenchUiStore } from "@/stores/workbench-ui-store";

export type StreamConnection = "idle" | "connecting" | "connected" | "reconnecting" | "disconnected";

export function reconcileThreadSnapshot(
  current: AgentThreadState | null,
  incoming: AgentThreadState,
  currentCursor: number
) {
  const sameThread = current?.threadId === incoming.threadId;
  const wouldRewind = sameThread && current.lastSeq > incoming.lastSeq;
  const hasVisibleActiveRun = sameThread
    && Boolean(current.activeRunId)
    && ["queued", "running", "waiting", "reconnecting"].includes(current.runStatus);
  if (wouldRewind || hasVisibleActiveRun) {
    return { state: current, lastSeq: currentCursor };
  }
  return { state: incoming, lastSeq: Math.max(currentCursor, incoming.lastSeq) };
}

export function useAgentThread(threadId: string | null) {
  const queryClient = useQueryClient();
  const snapshotQuery = useQuery({ queryKey: ["thread", threadId], queryFn: () => workbenchApi.thread(threadId!), enabled: Boolean(threadId), staleTime: 15_000 });
  const [state, setState] = useState<AgentThreadState | null>(null);
  const [connection, setConnection] = useState<StreamConnection>("idle");
  const [pendingStartedAt, setPendingStartedAt] = useState<string | null>(null);
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
    setPendingStartedAt(null);
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
    setState((current) => {
      const incoming = snapshotQuery.data.state;
      // A refetch can start before an approval/stop response and finish after
      // newer SSE events. Never let that older snapshot rewind the visible
      // read model or strand a running tool at an earlier frame.
      const reconciled = reconcileThreadSnapshot(current, incoming, lastSeqRef.current);
      lastSeqRef.current = reconciled.lastSeq;
      return reconciled.state;
    });
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
    let source: EventSource | null = null;
    let disposed = false;
    let snapshotRecoveryInFlight = false;

    const applyEvent = (event: AgentEvent) => {
      setState((current) => (current ? reduceAgentEvent(current, event) : current));
      if (event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled") {
        setPendingStartedAt(null);
        setConnection("idle");
      }
    };

    const renderQueue = createRenderQueue({ apply: applyEvent });

    const onEvent = (raw: Event) => {
      try {
        const message = raw as MessageEvent<string>;
        const event = parseAgentEvent(JSON.parse(message.data), { projectId: activeProjectId, threadId: activeThreadId!, runId });
        // The URL cursor is fixed when EventSource is created and older proxies
        // may omit Last-Event-ID on reconnect. Never enqueue the same durable
        // event twice, especially while a hidden page is flushing whole deltas.
        if (event.seq <= lastSeqRef.current) return;
        lastSeqRef.current = Math.max(lastSeqRef.current, event.seq);
        renderQueue.enqueue(event);
      } catch (error) {
        console.error("Invalid AgentEvent", error);
      }
    };
    const connectEventSource = () => {
      if (disposed) return;
      source?.close();
      const nextSource = new EventSource(workbenchApi.eventUrl(runId, lastSeqRef.current));
      source = nextSource;
      AGENT_EVENT_TYPES.forEach((type) => nextSource.addEventListener(type, onEvent));
      nextSource.onmessage = onEvent;
      nextSource.onopen = () => setConnection("connected");
      nextSource.onerror = () => {
        setConnection(nextSource.readyState === EventSource.CLOSED ? "disconnected" : "reconnecting");
        void recoverFromDurableSnapshot();
      };
    };
    const recoverFromDurableSnapshot = async () => {
      if (disposed || snapshotRecoveryInFlight) return;
      snapshotRecoveryInFlight = true;
      try {
        const refreshed = await workbenchApi.thread(activeThreadId!);
        if (
          disposed
          || refreshed.state.threadId !== activeThreadId
          || refreshed.state.lastSeq <= lastSeqRef.current
        ) return;

        // A half-open Cloudflare SSE is replaced at the current durable cursor.
        // Missed events still pass through the render queue, so no Agent text
        // jumps from an empty block directly to a completed paragraph.
        connectEventSource();
      } catch {
        // The next timer or native EventSource reconnect uses the same cursor.
      } finally {
        snapshotRecoveryInFlight = false;
      }
    };
    connectEventSource();
    const snapshotRecoveryTimer = setInterval(() => {
      void recoverFromDurableSnapshot();
    }, 10_000);
    return () => {
      disposed = true;
      clearInterval(snapshotRecoveryTimer);
      renderQueue.dispose();
      source?.close();
    };
  }, [state?.activeRunId, state?.projectId, state?.threadId, state?.runStatus, threadId]);

  const startMutation = useMutation({
    mutationFn: ({ message, replaceMessageId, attachments }: { message: string; replaceMessageId?: string; attachments?: string[] }) => {
      if (!threadId) throw new Error("请先发送首条指令");
      return workbenchApi.startRun(threadId, { message, agentId, modelId, reasoningEffort, toolIds: selectedToolIds, permissionMode, attachmentIds: attachments || pendingAttachments.map((attachment) => attachment.id), replaceMessageId: replaceMessageId || null });
    },
    onMutate: ({ message, replaceMessageId }) => {
      const startedAt = new Date().toISOString();
      setPendingStartedAt(startedAt);
      let previous: AgentThreadState | null = null;
      if (replaceMessageId) {
        setState((current) => {
          previous = current;
          return current ? truncateThreadStateForEdit(current, replaceMessageId, message) : current;
        });
      }
      return { previous, startedAt };
    },
    onError: (_error, _variables, context) => {
      setPendingStartedAt((current) => current === context?.startedAt ? null : current);
      if (context?.previous) setState(context.previous);
    },
    onSuccess: ({ runId }, _variables, context) => {
      const startedAt = context?.startedAt || new Date().toISOString();
      setState((current) => {
        if (current?.threadId !== threadId) return current;
        const existingTiming = current.runTimings[runId];
        const timing = existingTiming || { startedAt };
        return {
          ...current,
          activeRunId: runId,
          runStatus: "running",
          runStartedAt: timing.startedAt,
          runStatuses: { ...current.runStatuses, [runId]: "running" },
          runTimings: { ...current.runTimings, [runId]: timing }
        };
      });
      setPendingStartedAt((current) => current === startedAt ? null : current);
      clearPendingAttachments();
      void (async () => {
        const refreshed = await workbenchApi.thread(threadId!);
        queryClient.setQueryData(["thread", threadId], refreshed);
        setState((current) => {
          if (current?.threadId === refreshed.state.threadId && current.activeRunId === runId) {
            return current;
          }
          lastSeqRef.current = Math.max(lastSeqRef.current, refreshed.state.lastSeq);
          return refreshed.state;
        });
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
    isStarting: startMutation.isPending,
    pendingStartedAt
  }), [approvalMutation.error, approvalMutation.isPending, approvalMutation.mutateAsync, connection, pendingStartedAt, refresh, snapshotQuery.data, snapshotQuery.error, snapshotQuery.isFetching, snapshotQuery.isLoading, startMutation, threadId, visibleState, stopMutation.error, stopMutation.mutateAsync]);
}
