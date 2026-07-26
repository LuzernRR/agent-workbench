import type { AgentEvent, ReasoningEffort } from "@/lib/agent-events/types";
import { loadRuntimeConfig } from "@/server/config/runtime-config";
import { streamDeepSeekChat, summarizeDeepSeekReasoning, type DeepSeekChatMessage } from "@/server/llm/deepseek-client";
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
import { buildLiveSystemMessages } from "./prompt-policy";

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
  runtimeGlobal.__workbenchRecovery ??= recoverInterruptedLiveRuns();
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

async function execute(runtime: LiveRuntime, input: { message: string; history: DeepSeekChatMessage[]; attachmentContext: string; projectMemoryContext: string; reasoningEffort: ReasoningEffort }) {
  const config = await loadRuntimeConfig();
  const messageId = `msg_${crypto.randomUUID().replaceAll("-", "")}`;
  const thinkingId = `thinking_${crypto.randomUUID().replaceAll("-", "")}`;
  let reasoningText = "";
  let thinkingStarted = false;
  let thinkingCompleted = false;
  let thinkingCompletion: Promise<void> | null = null;
  let messageStarted = false;
  await emit(runtime, "run.started", { agentId: "chat", modelId: runtime.run.modelId });
  const currentMessage = input.attachmentContext ? `${input.message}\n\n${input.attachmentContext}` : input.message;

  const completeThinking = () => {
    if (!thinkingStarted || thinkingCompleted) return Promise.resolve();
    thinkingCompletion ??= (async () => {
      let paragraphs;
      try {
        paragraphs = await summarizeDeepSeekReasoning({
          config,
          modelId: runtime.run.modelId,
          userMessage: input.message,
          reasoningText,
          requestId: runtime.run.id,
          signal: runtime.abortController.signal
        });
      } catch {
        if (runtime.cancelled) return;
        await emit(runtime, "thinking.completed", { thinkingId, paragraphCount: 0 });
        thinkingCompleted = true;
        return;
      }
      if (runtime.cancelled) return;
      for (const paragraph of paragraphs) {
        await emit(runtime, "thinking.paragraph", { thinkingId, paragraphId: paragraph.id, text: paragraph.text });
      }
      await emit(runtime, "thinking.completed", { thinkingId, paragraphCount: paragraphs.length });
      thinkingCompleted = true;
    })();
    return thinkingCompletion;
  };

  const result = await streamDeepSeekChat({
    config,
    modelId: runtime.run.modelId,
    reasoningEffort: input.reasoningEffort,
    messages: [
      ...buildLiveSystemMessages(config.assistant.systemPrompt, input.projectMemoryContext, {
        providerName: config.provider.type === "deepseek" ? "DeepSeek" : config.provider.type,
        modelName: config.provider.models.find((model) => model.id === runtime.run.modelId)?.name ?? runtime.run.modelId,
        modelId: runtime.run.modelId
      }),
      ...input.history,
      { role: "user", content: currentMessage }
    ],
    requestId: runtime.run.id,
    signal: runtime.abortController.signal,
    onReasoningDelta: async (delta) => {
      if (runtime.cancelled) return;
      reasoningText += delta;
      if (!thinkingStarted) {
        thinkingStarted = true;
        await emit(runtime, "thinking.started", { thinkingId });
      }
    },
    onTextDelta: async (delta) => {
      await completeThinking();
      if (runtime.cancelled) return;
      if (!messageStarted) {
        messageStarted = true;
        await emit(runtime, "message.started", { messageId, role: "assistant", text: "", agentId: "chat" });
      }
      if (!runtime.cancelled) await emit(runtime, "text.delta", { messageId, delta });
    }
  });
  if (runtime.cancelled) return;
  await completeThinking();
  if (!messageStarted) await emit(runtime, "message.started", { messageId, role: "assistant", text: "", agentId: "chat" });
  await finalize(runtime, "completed", {
    agentId: "chat",
    modelId: runtime.run.modelId,
    finishReason: result.finishReason,
    usage: result.usage
  }, {
    events: [{ type: "message.completed", payload: { messageId, text: result.text, citations: [] } }],
    memory: {
      userMessage: input.message,
      assistantMessage: result.text
    }
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
  void execute(runtime, {
    message: input.message,
    history: prepared.history,
    attachmentContext: prepared.attachmentContext,
    projectMemoryContext: prepared.projectMemoryContext,
    reasoningEffort: model.reasoningEfforts.includes(input.reasoningEffort) ? input.reasoningEffort : model.defaultReasoningEffort
  }).catch(async (error) => {
    if (runtime.cancelled) return;
    await finalize(runtime, "failed", { message: error instanceof Error ? error.message : "模型运行失败" });
  }).finally(() => {
    windowlessDelay(() => runtimes.delete(runtime.run.id), 30_000);
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
    runtime.abortController.abort(new DOMException("用户停止运行", "AbortError"));
    const events = await finalize(runtime, "stopped", {});
    windowlessDelay(() => runtimes.delete(runId), 30_000);
    return events ? "stopped" : currentTerminalStatus(visitorId, runId);
  }
  const events = await finalizeLiveRun(record.run, "stopped", {});
  return events ? "stopped" : currentTerminalStatus(visitorId, runId);
}

export function subscribeLiveRun(runId: string, subscriber: (event: AgentEvent) => void) {
  const runtime = runtimes.get(runId);
  if (!runtime) return null;
  runtime.subscribers.add(subscriber);
  return () => runtime.subscribers.delete(subscriber);
}
