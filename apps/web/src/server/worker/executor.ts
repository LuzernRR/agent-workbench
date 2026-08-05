import { loadRuntimeConfig } from "@/server/config/runtime-config";
import { negotiateImageInputs } from "@/server/media/image-input";
import { SearchAgentRequestError, streamSearchAgentRun } from "@/server/search-agent/client";
import { mapSearchAgentEvent, type SearchAgentExecutionInput } from "@/server/search-agent/mapper";
import {
  finalizeClaimedLiveRun,
  persistClaimedLiveEvent,
  releaseLiveRunLease,
  renewLiveRunLease,
  type ClaimedLiveRun
} from "@/server/live/store";

export const SEARCH_AGENT_RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const;

export type ClaimedRunOutcome = "completed" | "failed" | "stopped" | "released" | "lease-lost";

export type ClaimedRunOptions = {
  leaseMs: number;
  heartbeatMs: number;
  signal: AbortSignal;
  onError?: (error: unknown, context: Record<string, unknown>) => void;
};

type ClaimedRuntime = {
  claim: ClaimedLiveRun;
  abortController: AbortController;
  eventTail: Promise<void>;
  leaseLost: boolean;
  stopping: boolean;
  settled: boolean;
};

class LeaseLostError extends Error {
  constructor() {
    super("Worker lease 已失效");
    this.name = "LeaseLostError";
  }
}

function loseLease(runtime: ClaimedRuntime) {
  if (runtime.leaseLost) return;
  runtime.leaseLost = true;
  runtime.abortController.abort(new LeaseLostError());
}

function enqueueRuntimeOperation<T>(runtime: ClaimedRuntime, operation: () => Promise<T>) {
  const pending = runtime.eventTail.then(async () => {
    if (runtime.leaseLost || runtime.stopping) throw new LeaseLostError();
    return operation();
  });
  runtime.eventTail = pending.then(() => undefined, () => undefined);
  return pending;
}

async function emit(runtime: ClaimedRuntime, type: Parameters<typeof persistClaimedLiveEvent>[1], payload: Record<string, unknown>) {
  return enqueueRuntimeOperation(runtime, async () => {
    const event = await persistClaimedLiveEvent(runtime.claim, type, payload);
    if (!event) {
      loseLease(runtime);
      throw new LeaseLostError();
    }
    return event;
  });
}

async function finalize(
  runtime: ClaimedRuntime,
  status: "completed" | "failed" | "stopped",
  payload: Record<string, unknown>,
  completion?: Parameters<typeof finalizeClaimedLiveRun>[3]
) {
  const events = await enqueueRuntimeOperation(runtime, () =>
    finalizeClaimedLiveRun(runtime.claim, status, payload, completion)
  );
  if (!events) {
    loseLease(runtime);
    throw new LeaseLostError();
  }
  runtime.settled = true;
  return events;
}

async function executeSearchRun(
  runtime: ClaimedRuntime,
  input: SearchAgentExecutionInput,
  modelSupportsImageInput: boolean
): Promise<Extract<ClaimedRunOutcome, "completed" | "failed" | "stopped">> {
  const run = runtime.claim.run;
  const messageId = `msg_${run.id.replace(/[^A-Za-z0-9]/gu, "")}_assistant`;
  let streamedMessageId = "";
  if (runtime.claim.resume) {
    await emit(runtime, "run.status", {
      status: "running",
      recovered: true,
      workerAttempt: runtime.claim.attempt,
      leaseEpoch: runtime.claim.lease.epoch
    });
  } else {
    await emit(runtime, "run.started", { agentId: "search-agent", modelId: run.modelId });
  }

  const imageInput = negotiateImageInputs(input.imageInputs || [], modelSupportsImageInput);
  const question = [input.message, input.attachmentContext, imageInput.context].filter(Boolean).join("\n\n").slice(0, 20_000);
  const retryableCodes = new Set(["SEARCH_AGENT_UNAVAILABLE", "SEARCH_AGENT_STREAM_ENDED", "SEARCH_AGENT_ALREADY_ACTIVE"]);
  for (let attempt = 0; attempt <= SEARCH_AGENT_RECONNECT_DELAYS_MS.length; attempt += 1) {
    let receivedOnRetry = false;
    try {
      for await (const sourceEvent of streamSearchAgentRun({
        runId: run.id,
        tenantId: process.env.WORKBENCH_TENANT || "local",
        visitorId: run.visitorId,
        projectId: run.projectId,
        threadId: run.threadId,
        question,
        modelId: run.modelId,
        reasoningEffort: input.reasoningEffort,
        history: input.history.slice(-40).map((message) => ({ ...message, content: message.content.slice(0, 20_000) })),
        projectMemoryContext: input.projectMemoryContext.slice(-20_000),
        imageInputs: imageInput.references,
        resume: Boolean(runtime.claim.resume || attempt > 0)
      }, runtime.abortController.signal)) {
        if (runtime.leaseLost || runtime.stopping) throw new LeaseLostError();
        if (sourceEvent.type === "run.failed" && sourceEvent.reasonCode === "RUN_ALREADY_ACTIVE" && attempt < SEARCH_AGENT_RECONNECT_DELAYS_MS.length) {
          throw new SearchAgentRequestError("Search Agent 上一次流仍在收口", "SEARCH_AGENT_ALREADY_ACTIVE");
        }
        if (attempt > 0 && !receivedOnRetry && sourceEvent.type !== "run.failed") {
          receivedOnRetry = true;
          await emit(runtime, "run.status", { status: "running", recoveryAttempt: attempt, recovered: true });
        }
        const projection = mapSearchAgentEvent(sourceEvent, run.id);
        for (const event of projection.events) {
          if (event.type === "message.delta") streamedMessageId = String(event.payload.messageId || "");
          await emit(runtime, event.type, event.payload);
        }
        if (!projection.terminal) continue;
        if (projection.terminal.kind === "failed") {
          await finalize(runtime, "failed", projection.terminal.payload);
          return "failed";
        }
        if (projection.terminal.kind === "stopped") {
          await finalize(runtime, "stopped", projection.terminal.payload);
          return "stopped";
        }
        await finalize(runtime, "completed", projection.terminal.payload, {
          events: streamedMessageId
            ? [{
                type: "message.completed",
                payload: { messageId: streamedMessageId, text: projection.terminal.answer, citations: projection.terminal.citations }
              }]
            : [
                { type: "message.started", payload: { messageId, role: "assistant", text: "", agentId: "search-agent", agentName: "搜索 Agent" } },
                { type: "message.delta", payload: { messageId, delta: projection.terminal.answer } },
                { type: "message.completed", payload: { messageId, text: projection.terminal.answer, citations: projection.terminal.citations } }
              ],
          memory: projection.terminal.remember
            ? { userMessage: input.message, assistantMessage: projection.terminal.answer }
            : undefined
        });
        return "completed";
      }
      throw new SearchAgentRequestError("Search Agent 事件流提前结束", "SEARCH_AGENT_STREAM_ENDED");
    } catch (error) {
      if (runtime.leaseLost || runtime.stopping) throw error;
      if (!(error instanceof SearchAgentRequestError) || !retryableCodes.has(error.code) || attempt >= SEARCH_AGENT_RECONNECT_DELAYS_MS.length) throw error;
      await emit(runtime, "run.status", { status: "reconnecting", reasonCode: error.code, recoveryAttempt: attempt + 1 });
      await waitForReconnect(SEARCH_AGENT_RECONNECT_DELAYS_MS[attempt], runtime.abortController.signal);
    }
  }
  throw new SearchAgentRequestError("Search Agent 重连次数耗尽", "SEARCH_AGENT_STREAM_ENDED");
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

export async function runClaimedLiveRun(claim: ClaimedLiveRun, options: ClaimedRunOptions): Promise<ClaimedRunOutcome> {
  const runtime: ClaimedRuntime = {
    claim,
    abortController: new AbortController(),
    eventTail: Promise.resolve(),
    leaseLost: false,
    stopping: options.signal.aborted,
    settled: false
  };
  const stop = () => {
    runtime.stopping = true;
    runtime.abortController.abort(options.signal.reason ?? new DOMException("Worker 正在停止", "AbortError"));
  };
  options.signal.addEventListener("abort", stop, { once: true });
  if (options.signal.aborted) stop();

  let heartbeatTail = Promise.resolve();
  const heartbeat = setInterval(() => {
    heartbeatTail = heartbeatTail.then(async () => {
      if (runtime.stopping || runtime.leaseLost || runtime.settled) return;
      try {
        if (!await renewLiveRunLease(claim, options.leaseMs)) loseLease(runtime);
      } catch (error) {
        options.onError?.(error, { operation: "heartbeat", runId: claim.run.id, leaseEpoch: claim.lease.epoch });
        loseLease(runtime);
      }
    });
  }, options.heartbeatMs);
  heartbeat.unref?.();

  let outcome: ClaimedRunOutcome = runtime.stopping ? "released" : "failed";
  try {
    if (!runtime.stopping) {
      const config = await loadRuntimeConfig();
      const model = config.provider.models.find((candidate) => candidate.id === claim.run.modelId);
      if (!model) {
        await finalize(runtime, "failed", { message: "运行模型配置已失效", reasonCode: "MODEL_CONFIG_MISSING" });
        outcome = "failed";
      } else {
        outcome = await executeSearchRun(runtime, claim.input, Boolean(model.capabilities.imageInput));
      }
    }
  } catch (error) {
    if (runtime.leaseLost || error instanceof LeaseLostError) {
      outcome = "lease-lost";
    } else if (runtime.stopping) {
      outcome = "released";
    } else {
      options.onError?.(error, { operation: "execute", runId: claim.run.id, leaseEpoch: claim.lease.epoch });
      try {
        await finalize(runtime, "failed", {
          message: error instanceof SearchAgentRequestError ? error.message : "Search Agent 运行失败",
          reasonCode: error instanceof SearchAgentRequestError ? error.code : "SEARCH_AGENT_RUNTIME_ERROR"
        });
        outcome = "failed";
      } catch (finalizeError) {
        options.onError?.(finalizeError, { operation: "finalize", runId: claim.run.id, leaseEpoch: claim.lease.epoch });
        outcome = "lease-lost";
      }
    }
  } finally {
    clearInterval(heartbeat);
    await heartbeatTail;
    await runtime.eventTail;
    options.signal.removeEventListener("abort", stop);
    if (runtime.stopping && !runtime.settled && !runtime.leaseLost) {
      try {
        outcome = await releaseLiveRunLease(claim) ? "released" : "lease-lost";
      } catch (error) {
        options.onError?.(error, { operation: "release", runId: claim.run.id, leaseEpoch: claim.lease.epoch });
        outcome = "lease-lost";
      }
    }
  }
  return outcome;
}
