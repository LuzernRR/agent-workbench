import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { loadRuntimeConfig } from "@/server/config/runtime-config";
import { claimNextLiveRun, deleteExpiredLiveThreads, type ClaimedLiveRun } from "@/server/live/store";
import { runClaimedLiveRun, type ClaimedRunOutcome } from "./executor";

export type WorkerLog = (
  level: "info" | "error",
  message: string,
  context?: Record<string, unknown>
) => void;

export type RunWorkerOptions = {
  owner: string;
  leaseMs: number;
  heartbeatMs: number;
  pollMs: number;
  cleanupIntervalMs: number;
  threadTtlDays: number;
};

export type WorkerLoopDependencies = {
  claim: (owner: string, leaseMs: number) => Promise<ClaimedLiveRun | null>;
  execute: (claim: ClaimedLiveRun, options: {
    leaseMs: number;
    heartbeatMs: number;
    signal: AbortSignal;
    onError: (error: unknown, context: Record<string, unknown>) => void;
  }) => Promise<ClaimedRunOutcome>;
  cleanup: (threadTtlDays: number) => Promise<number>;
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

const defaultDependencies: WorkerLoopDependencies = {
  claim: claimNextLiveRun,
  execute: runClaimedLiveRun,
  cleanup: deleteExpiredLiveThreads,
  wait: abortableDelay
};

function integerEnvironment(environment: NodeJS.ProcessEnv, name: string, fallback: number, minimum: number, maximum: number) {
  const raw = environment[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} 必须是 ${minimum} 到 ${maximum} 之间的整数`);
  }
  return value;
}

export async function loadWorkerOptions(environment: NodeJS.ProcessEnv = process.env): Promise<RunWorkerOptions> {
  const config = await loadRuntimeConfig();
  const leaseMs = integerEnvironment(environment, "WORKBENCH_RUN_LEASE_MS", 30_000, 3_000, 300_000);
  const heartbeatMs = integerEnvironment(environment, "WORKBENCH_RUN_HEARTBEAT_MS", 10_000, 500, 60_000);
  if (heartbeatMs * 2 >= leaseMs) throw new Error("WORKBENCH_RUN_HEARTBEAT_MS 必须小于 lease 的一半");
  return {
    owner: environment.WORKBENCH_WORKER_ID?.trim()
      || `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`,
    leaseMs,
    heartbeatMs,
    pollMs: integerEnvironment(environment, "WORKBENCH_RUN_POLL_MS", 500, 50, 30_000),
    cleanupIntervalMs: config.retention.cleanupIntervalMinutes * 60_000,
    threadTtlDays: config.retention.threadTtlDays
  };
}

export async function runWorkerLoop(
  options: RunWorkerOptions,
  signal: AbortSignal,
  log: WorkerLog,
  dependencies: WorkerLoopDependencies = defaultDependencies
) {
  let lastCleanupAt = 0;
  while (!signal.aborted) {
    const now = Date.now();
    if (now - lastCleanupAt >= options.cleanupIntervalMs) {
      lastCleanupAt = now;
      try {
        const deleted = await dependencies.cleanup(options.threadTtlDays);
        if (deleted) log("info", "worker.retention.cleaned", { deleted });
      } catch (error) {
        log("error", "worker.retention.failed", { error: errorMessage(error) });
      }
    }

    let claim: ClaimedLiveRun | null = null;
    try {
      claim = await dependencies.claim(options.owner, options.leaseMs);
    } catch (error) {
      log("error", "worker.claim.failed", { error: errorMessage(error) });
    }
    if (signal.aborted) break;
    if (!claim) {
      await dependencies.wait(options.pollMs, signal);
      continue;
    }

    log("info", "worker.run.claimed", {
      runId: claim.run.id,
      attempt: claim.attempt,
      leaseEpoch: claim.lease.epoch,
      resume: claim.resume
    });
    const outcome = await dependencies.execute(claim, {
      leaseMs: options.leaseMs,
      heartbeatMs: options.heartbeatMs,
      signal,
      onError: (error, context) => log("error", "worker.run.error", { ...context, error: errorMessage(error) })
    });
    log("info", "worker.run.released", {
      runId: claim.run.id,
      leaseEpoch: claim.lease.epoch,
      outcome
    });
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function abortableDelay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", aborted);
      resolve();
    }, milliseconds);
    timer.unref?.();
    const aborted = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", aborted, { once: true });
  });
}
