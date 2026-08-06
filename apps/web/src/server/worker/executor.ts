import { loadRuntimeConfig } from "@/server/config/runtime-config";
import { negotiateImageInputs } from "@/server/media/image-input";
import { SearchAgentRequestError, streamSearchAgentRun } from "@/server/search-agent/client";
import type { SearchAgentEvent } from "@/server/search-agent/events";
import { mapSearchAgentEvent, type SearchAgentExecutionInput } from "@/server/search-agent/mapper";
import {
  CheckpointBatchConflictError,
  CheckpointParentConflictError,
  commitClaimedCheckpointBatch,
  type ClaimedCheckpointBatch
} from "@/server/live/checkpoint-batches";
import {
  finalizeClaimedLiveRun,
  liveId,
  persistClaimedLiveEvent,
  readClaimedLiveCheckpoint,
  releaseLiveRunLease,
  renewLiveRunLease,
  type ClaimedLiveRun
} from "@/server/live/store";

export const SEARCH_AGENT_RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const;
export const MAX_CHECKPOINT_SOURCE_EVENTS = 10_000;
export const MAX_CHECKPOINT_SOURCE_BYTES = 8 * 1024 * 1024;

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
  releaseRequested: boolean;
  settled: boolean;
};

class LeaseLostError extends Error {
  constructor() {
    super("Worker lease 已失效");
    this.name = "LeaseLostError";
  }
}

class CheckpointCommitRetryableError extends Error {
  constructor(readonly cause: unknown) {
    super("Checkpoint batch 暂时无法提交");
    this.name = "CheckpointCommitRetryableError";
  }
}

function checkpointSourceRecordBytes(input: {
  bufferedCount: number;
  bufferedBytes: number;
  event: SearchAgentEvent;
  reserveBoundary: boolean;
}) {
  const eventBytes = Buffer.byteLength(JSON.stringify(input.event), "utf8");
  const totalRecords = input.bufferedCount + 1 + (input.reserveBoundary ? 1 : 0);
  if (
    totalRecords > MAX_CHECKPOINT_SOURCE_EVENTS
    || eventBytes > MAX_CHECKPOINT_SOURCE_BYTES - input.bufferedBytes
  ) {
    throw new SearchAgentRequestError(
      "Search Agent checkpoint 前事件缓冲超过安全上限",
      "SEARCH_AGENT_CHECKPOINT_BUFFER_LIMIT"
    );
  }
  return eventBytes;
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

function projectCheckpointBatch(input: {
  run: ClaimedLiveRun["run"];
  executionInput: SearchAgentExecutionInput;
  messageId: string;
  streamedMessageId: string;
  sourceEvents: SearchAgentEvent[];
  boundary: Extract<SearchAgentEvent, { type: "checkpoint.committed" }>;
}) {
  const events: ClaimedCheckpointBatch["events"] = [];
  let streamedMessageId = input.streamedMessageId;
  let terminal: ClaimedCheckpointBatch["terminal"];
  let outcome: Extract<ClaimedRunOutcome, "completed" | "failed" | "stopped"> | undefined;
  for (const sourceEvent of input.sourceEvents) {
    const projection = mapSearchAgentEvent(sourceEvent, input.run.id);
    for (const event of projection.events) {
      if (event.type === "message.delta") streamedMessageId = String(event.payload.messageId || "");
      events.push(event);
    }
    if (!projection.terminal) continue;
    if (terminal) throw new CheckpointBatchConflictError("一个 batch 不能包含多个终态");
    if (projection.terminal.kind === "failed") {
      outcome = "failed";
      terminal = { status: "failed" };
      events.push({ type: "run.failed", payload: projection.terminal.payload });
      continue;
    }
    if (projection.terminal.kind === "stopped") {
      outcome = "stopped";
      terminal = { status: "stopped" };
      events.push({ type: "run.cancelled", payload: projection.terminal.payload });
      continue;
    }
    outcome = "completed";
    terminal = {
      status: "completed",
      memory: projection.terminal.remember
        ? {
            userMessage: input.executionInput.message,
            assistantMessage: projection.terminal.answer
          }
        : undefined
    };
    if (streamedMessageId) {
      for (let index = events.length - 1; index >= 0; index -= 1) {
        if (
          events[index].type === "message.completed"
          && events[index].payload.messageId === streamedMessageId
        ) {
          events.splice(index, 1);
        }
      }
      events.push({
        type: "message.completed",
        payload: {
          messageId: streamedMessageId,
          text: projection.terminal.answer,
          citations: projection.terminal.citations
        }
      });
    } else {
      events.push(
        {
          type: "message.started",
          payload: {
            messageId: input.messageId,
            role: "assistant",
            text: "",
            agentId: "search-agent",
            agentName: "搜索 Agent"
          }
        },
        {
          type: "message.delta",
          payload: { messageId: input.messageId, delta: projection.terminal.answer }
        },
        {
          type: "message.completed",
          payload: {
            messageId: input.messageId,
            text: projection.terminal.answer,
            citations: projection.terminal.citations
          }
        }
      );
    }
    events.push({ type: "run.completed", payload: projection.terminal.payload });
  }
  return {
    batch: {
      boundary: input.boundary,
      sourceEvents: input.sourceEvents,
      events,
      terminal
    } satisfies ClaimedCheckpointBatch,
    outcome,
    streamedMessageId
  };
}

async function commitSourceBatch(input: {
  runtime: ClaimedRuntime;
  executionInput: SearchAgentExecutionInput;
  messageId: string;
  streamedMessageId: string;
  sourceEvents: SearchAgentEvent[];
  boundary: Extract<SearchAgentEvent, { type: "checkpoint.committed" }>;
}) {
  const projected = projectCheckpointBatch({
    run: input.runtime.claim.run,
    executionInput: input.executionInput,
    messageId: input.messageId,
    streamedMessageId: input.streamedMessageId,
    sourceEvents: input.sourceEvents,
    boundary: input.boundary
  });
  let committed;
  try {
    committed = await enqueueRuntimeOperation(input.runtime, () =>
      commitClaimedCheckpointBatch(input.runtime.claim, projected.batch)
    );
  } catch (error) {
    if (
      error instanceof CheckpointBatchConflictError
      || error instanceof CheckpointParentConflictError
      || error instanceof LeaseLostError
    ) {
      throw error;
    }
    throw new CheckpointCommitRetryableError(error);
  }
  if (!committed) {
    loseLease(input.runtime);
    throw new LeaseLostError();
  }
  if (projected.outcome) input.runtime.settled = true;
  return projected;
}

async function executeSearchRun(
  runtime: ClaimedRuntime,
  input: SearchAgentExecutionInput,
  modelSupportsImageInput: boolean
): Promise<Extract<ClaimedRunOutcome, "completed" | "failed" | "stopped">> {
  const run = runtime.claim.run;
  const messageId = `msg_${run.id.replace(/[^A-Za-z0-9]/gu, "")}_assistant`;
  let streamedMessageId = "";
  let bufferedSourceEvents: SearchAgentEvent[] = [];
  let bufferedSourceBytes = 0;
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
      let authority;
      try {
        authority = await enqueueRuntimeOperation(runtime, () =>
          readClaimedLiveCheckpoint(runtime.claim)
        );
      } catch (error) {
        if (error instanceof LeaseLostError) throw error;
        throw new CheckpointCommitRetryableError(error);
      }
      if (!authority.valid) {
        loseLease(runtime);
        throw new LeaseLostError();
      }
      const checkpointSessionId = authority.checkpoint?.sessionId ?? liveId("checkpoint_session");
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
        resume: authority.checkpoint !== null,
        checkpointId: authority.checkpoint?.id,
        checkpointNs: authority.checkpoint?.namespace,
        checkpointSessionId
      }, runtime.abortController.signal)) {
        if (runtime.leaseLost || runtime.stopping) throw new LeaseLostError();
        if (sourceEvent.type === "run.failed" && sourceEvent.reasonCode === "RUN_ALREADY_ACTIVE" && attempt < SEARCH_AGENT_RECONNECT_DELAYS_MS.length) {
          throw new SearchAgentRequestError("Search Agent 上一次流仍在收口", "SEARCH_AGENT_ALREADY_ACTIVE");
        }
        if (attempt > 0 && !receivedOnRetry && sourceEvent.type !== "run.failed") {
          receivedOnRetry = true;
          await emit(runtime, "run.status", { status: "running", recoveryAttempt: attempt, recovered: true });
        }
        if (sourceEvent.type !== "checkpoint.committed") {
          bufferedSourceBytes += checkpointSourceRecordBytes({
            bufferedCount: bufferedSourceEvents.length,
            bufferedBytes: bufferedSourceBytes,
            event: sourceEvent,
            reserveBoundary: true
          });
          bufferedSourceEvents.push(sourceEvent);
          continue;
        }
        checkpointSourceRecordBytes({
          bufferedCount: bufferedSourceEvents.length,
          bufferedBytes: bufferedSourceBytes,
          event: sourceEvent,
          reserveBoundary: false
        });
        const projected = await commitSourceBatch({
          runtime,
          executionInput: input,
          messageId,
          streamedMessageId,
          sourceEvents: bufferedSourceEvents,
          boundary: sourceEvent
        });
        bufferedSourceEvents = [];
        bufferedSourceBytes = 0;
        streamedMessageId = projected.streamedMessageId;
        if (projected.outcome) return projected.outcome;
      }
      throw new SearchAgentRequestError("Search Agent 事件流提前结束", "SEARCH_AGENT_STREAM_ENDED");
    } catch (error) {
      bufferedSourceEvents = [];
      bufferedSourceBytes = 0;
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
    releaseRequested: false,
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
    } else if (error instanceof CheckpointCommitRetryableError) {
      options.onError?.(error.cause, {
        operation: "checkpoint-commit",
        runId: claim.run.id,
        leaseEpoch: claim.lease.epoch
      });
      runtime.releaseRequested = true;
      runtime.abortController.abort(error);
      outcome = "released";
    } else if (runtime.stopping) {
      outcome = "released";
    } else {
      options.onError?.(error, { operation: "execute", runId: claim.run.id, leaseEpoch: claim.lease.epoch });
      try {
        const errorCode = String((error as { code?: unknown })?.code ?? "");
        const stableErrorCode = /^[A-Z0-9_]{1,80}$/u.test(errorCode)
          ? errorCode
          : "SEARCH_AGENT_RUNTIME_ERROR";
        await finalize(runtime, "failed", {
          message: error instanceof SearchAgentRequestError ? error.message : "Search Agent 运行失败",
          reasonCode: error instanceof SearchAgentRequestError ? error.code : stableErrorCode
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
    if ((runtime.stopping || runtime.releaseRequested) && !runtime.settled && !runtime.leaseLost) {
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
