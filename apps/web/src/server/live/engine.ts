import type { AgentEvent, ReasoningEffort } from "@/lib/agent-events/types";
import { loadRuntimeConfig } from "@/server/config/runtime-config";
import { requestSearchAgentStop, SearchAgentRequestError, streamSearchAgentRun } from "@/server/search-agent/client";
import { mapSearchAgentEvent, type SearchAgentExecutionInput } from "@/server/search-agent/mapper";
import {
  deleteExpiredLiveThreads,
  finalizeLiveRun,
  liveRun,
  persistLiveEvent,
  prepareLiveRun,
  recoverInterruptedLiveRuns,
  type LiveRunRecord,
  type LiveRunStatus
} from "./store";

type LiveRuntime = {
  run: LiveRunRecord;
  abortController: AbortController;
  cancelled: boolean;
  eventTail: Promise<void>;
  subscribers: Set<(event: AgentEvent) => void>;
};

type LiveRuntimeGlobal = {
  __workbenchLiveRuns?: Map<string, LiveRuntime>;
  __workbenchRecovery?: Promise<number>;
  __workbenchCleanup?: Promise<number>;
  __workbenchLastCleanupAt?: number;
};

const runtimeGlobal = globalThis as unknown as LiveRuntimeGlobal;
const runtimes = runtimeGlobal.__workbenchLiveRuns ??= new Map<string, LiveRuntime>();
export const SEARCH_AGENT_RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const;

async function ensureLiveMaintenance() {
  const config = await loadRuntimeConfig();
  const now = Date.now();
  const intervalMs = config.retention.cleanupIntervalMinutes * 60_000;
  if (runtimeGlobal.__workbenchCleanup) return runtimeGlobal.__workbenchCleanup;
  if (runtimeGlobal.__workbenchLastCleanupAt && now - runtimeGlobal.__workbenchLastCleanupAt < intervalMs) return 0;
  runtimeGlobal.__workbenchLastCleanupAt = now;
  const cleanup = deleteExpiredLiveThreads(config.retention.threadTtlDays);
  runtimeGlobal.__workbenchCleanup = cleanup;
  try {
    return await cleanup;
  } finally {
    runtimeGlobal.__workbenchCleanup = undefined;
  }
}

export async function ensureLiveRecovery() {
  runtimeGlobal.__workbenchRecovery ??= (async () => {
    const config = await loadRuntimeConfig();
    const recovered = await recoverInterruptedLiveRuns({
      memoryRecallItems: config.retention.projectMemoryRecallItems,
      memoryMaxChars: config.retention.projectMemoryMaxChars
    });
    for (const item of recovered.resumable) {
      if (runtimes.has(item.run.id)) continue;
      const runtime: LiveRuntime = {
        run: item.run,
        abortController: new AbortController(),
        cancelled: false,
        eventTail: Promise.resolve(),
        subscribers: new Set()
      };
      runtimes.set(runtime.run.id, runtime);
      launchRuntime(runtime, { ...item, resume: true });
    }
    return recovered.failed + recovered.resumable.length;
  })();
  const recovered = await runtimeGlobal.__workbenchRecovery;
  await ensureLiveMaintenance();
  return recovered;
}

async function emit(runtime: LiveRuntime, type: Parameters<typeof persistLiveEvent>[1], payload: Record<string, unknown>) {
  return enqueueRuntimeOperation(runtime, async () => {
    if (runtime.cancelled) return null;
    const event = await persistLiveEvent(runtime.run, type, payload);
    publish(runtime, event);
    return event;
  });
}

function publish(runtime: LiveRuntime, event: AgentEvent) {
  for (const subscriber of runtime.subscribers) {
    try {
      subscriber(event);
    } catch {
      // One disconnected response must not affect persistence or other clients.
    }
  }
}

function enqueueRuntimeOperation<T>(runtime: LiveRuntime, operation: () => Promise<T>) {
  const pending = runtime.eventTail.then(operation);
  runtime.eventTail = pending.then(() => undefined, () => undefined);
  return pending;
}

async function finalize(
  runtime: LiveRuntime,
  status: "completed" | "failed" | "stopped",
  payload: Record<string, unknown>,
  completion?: Parameters<typeof finalizeLiveRun>[3]
) {
  return enqueueRuntimeOperation(runtime, async () => {
    if (runtime.cancelled && status !== "stopped") return null;
    const events = await finalizeLiveRun(runtime.run, status, payload, completion);
    events?.forEach((event) => publish(runtime, event));
    return events;
  });
}

async function execute(runtime: LiveRuntime, input: SearchAgentExecutionInput) {
  const messageId = `msg_${runtime.run.id.replace(/[^A-Za-z0-9]/gu, "")}_assistant`;
  if (!input.resume) await emit(runtime, "run.started", { agentId: "search-agent", modelId: runtime.run.modelId });
  const question = (input.attachmentContext ? `${input.message}\n\n${input.attachmentContext}` : input.message).slice(0, 20_000);
  const retryableCodes = new Set(["SEARCH_AGENT_UNAVAILABLE", "SEARCH_AGENT_STREAM_ENDED", "SEARCH_AGENT_ALREADY_ACTIVE"]);
  for (let attempt = 0; attempt <= SEARCH_AGENT_RECONNECT_DELAYS_MS.length; attempt += 1) {
    let receivedOnRetry = false;
    try {
      for await (const sourceEvent of streamSearchAgentRun({
        runId: runtime.run.id,
        tenantId: process.env.WORKBENCH_TENANT || "local",
        visitorId: runtime.run.visitorId,
        projectId: runtime.run.projectId,
        threadId: runtime.run.threadId,
        question,
        modelId: runtime.run.modelId,
        reasoningEffort: input.reasoningEffort,
        history: input.history.slice(-40).map((message) => ({ ...message, content: message.content.slice(0, 20_000) })),
        projectMemoryContext: input.projectMemoryContext.slice(-20_000),
        resume: Boolean(input.resume || attempt > 0)
      }, runtime.abortController.signal)) {
        if (runtime.cancelled) return;
        if (sourceEvent.type === "run.failed" && sourceEvent.reasonCode === "RUN_ALREADY_ACTIVE" && attempt < SEARCH_AGENT_RECONNECT_DELAYS_MS.length) {
          throw new SearchAgentRequestError("Search Agent 上一次流仍在收口", "SEARCH_AGENT_ALREADY_ACTIVE");
        }
        if (attempt > 0 && !receivedOnRetry && sourceEvent.type !== "run.failed") {
          receivedOnRetry = true;
          await emit(runtime, "run.status", { status: "running", recoveryAttempt: attempt, recovered: true });
        }
        const projection = mapSearchAgentEvent(sourceEvent, runtime.run.id);
        for (const event of projection.events) await emit(runtime, event.type, event.payload);
        if (!projection.terminal) continue;
        if (projection.terminal.kind === "failed") {
          await finalize(runtime, "failed", projection.terminal.payload);
          return;
        }
        if (projection.terminal.kind === "stopped") {
          await finalize(runtime, "stopped", projection.terminal.payload);
          return;
        }
        await finalize(runtime, "completed", projection.terminal.payload, {
          events: [
            { type: "message.started", payload: { messageId, role: "assistant", text: "", agentId: "search-agent", agentName: "搜索 Agent" } },
            { type: "message.completed", payload: { messageId, text: projection.terminal.answer, citations: projection.terminal.citations } }
          ],
          memory: projection.terminal.remember ? { userMessage: input.message, assistantMessage: projection.terminal.answer } : undefined
        });
        return;
      }
      throw new SearchAgentRequestError("Search Agent 事件流提前结束", "SEARCH_AGENT_STREAM_ENDED");
    } catch (error) {
      if (runtime.cancelled) return;
      if (!(error instanceof SearchAgentRequestError) || !retryableCodes.has(error.code) || attempt >= SEARCH_AGENT_RECONNECT_DELAYS_MS.length) throw error;
      await emit(runtime, "run.status", { status: "reconnecting", reasonCode: error.code, recoveryAttempt: attempt + 1 });
      await waitForReconnect(SEARCH_AGENT_RECONNECT_DELAYS_MS[attempt], runtime.abortController.signal);
    }
  }
}

function waitForReconnect(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function launchRuntime(runtime: LiveRuntime, input: SearchAgentExecutionInput) {
  void execute(runtime, input).catch(async (error) => {
    if (runtime.cancelled) return;
    await finalize(runtime, "failed", {
      message: error instanceof SearchAgentRequestError ? error.message : "Search Agent 运行失败",
      reasonCode: error instanceof SearchAgentRequestError ? error.code : "SEARCH_AGENT_RUNTIME_ERROR"
    });
  }).finally(() => {
    windowlessDelay(() => runtimes.delete(runtime.run.id), 30_000);
  });
}

export async function startLiveRun(input: {
  visitorId: string;
  threadId: string;
  message: string;
  modelId: string;
  reasoningEffort: ReasoningEffort;
  attachmentIds: string[];
  replaceMessageId?: string | null;
}) {
  await ensureLiveRecovery();
  const config = await loadRuntimeConfig();
  const model = config.provider.models.find((candidate) => candidate.id === input.modelId)
    ?? config.provider.models.find((candidate) => candidate.id === config.provider.defaultModel);
  if (!model) throw new Error("模型配置不可用");
  const prepared = await prepareLiveRun({
    ...input,
    agentId: "search-agent",
    modelId: model.id,
    memoryRecallItems: config.retention.projectMemoryRecallItems,
    memoryMaxChars: config.retention.projectMemoryMaxChars
  });
  if (!prepared) return null;
  const runtime: LiveRuntime = {
    run: prepared.run,
    abortController: new AbortController(),
    cancelled: false,
    eventTail: Promise.resolve(),
    subscribers: new Set()
  };
  runtimes.set(runtime.run.id, runtime);
  launchRuntime(runtime, {
    message: input.message,
    history: prepared.history,
    attachmentContext: prepared.attachmentContext,
    projectMemoryContext: prepared.projectMemoryContext,
    reasoningEffort: model.reasoningEfforts.includes(input.reasoningEffort) ? input.reasoningEffort : model.defaultReasoningEffort
  });
  return { runId: runtime.run.id };
}

function windowlessDelay(callback: () => void, milliseconds: number) {
  const timer = setTimeout(callback, milliseconds);
  timer.unref?.();
}

const terminalStatus = (status: LiveRunStatus): status is Extract<LiveRunStatus, "completed" | "failed" | "stopped"> => ["completed", "failed", "stopped"].includes(status);

async function currentTerminalStatus(visitorId: string, runId: string) {
  const current = await liveRun(visitorId, runId);
  return current && terminalStatus(current.status) ? current.status : null;
}

export async function stopLiveRun(visitorId: string, runId: string): Promise<Extract<LiveRunStatus, "completed" | "failed" | "stopped"> | null> {
  const record = await liveRun(visitorId, runId);
  if (!record) return null;
  if (terminalStatus(record.status)) return record.status;
  const runtime = runtimes.get(runId);
  if (runtime && runtime.run.visitorId === visitorId) {
    if (runtime.cancelled) {
      await runtime.eventTail;
      const current = await currentTerminalStatus(visitorId, runId);
      if (current) return current;
      const retriedEvents = await finalize(runtime, "stopped", {});
      return retriedEvents ? "stopped" : currentTerminalStatus(visitorId, runId);
    }
    runtime.cancelled = true;
    if (runtime.run.agentId === "search-agent") await requestSearchAgentStop(runId);
    runtime.abortController.abort(new DOMException("用户停止运行", "AbortError"));
    const events = await finalize(runtime, "stopped", {});
    windowlessDelay(() => runtimes.delete(runId), 30_000);
    return events ? "stopped" : currentTerminalStatus(visitorId, runId);
  }
  if (record.run.agentId === "search-agent") await requestSearchAgentStop(runId);
  const events = await finalizeLiveRun(record.run, "stopped", {});
  return events ? "stopped" : currentTerminalStatus(visitorId, runId);
}

export function subscribeLiveRun(runId: string, subscriber: (event: AgentEvent) => void) {
  const runtime = runtimes.get(runId);
  if (!runtime) return null;
  runtime.subscribers.add(subscriber);
  return () => runtime.subscribers.delete(subscriber);
}
