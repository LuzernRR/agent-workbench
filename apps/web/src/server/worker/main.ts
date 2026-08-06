import { closeDatabase } from "@/server/persistence/database";
import { runAgentEventOutboxDispatcher } from "@/server/live/event-outbox";
import { loadWorkerOptions, runWorkerLoop, type WorkerLog } from "./loop";

const shutdown = new AbortController();

const log: WorkerLog = (level, message, context = {}) => {
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    service: "workbench-run-worker",
    message,
    ...context
  });
  if (level === "error") console.error(entry);
  else console.log(entry);
};

function requestShutdown(signal: NodeJS.Signals) {
  if (shutdown.signal.aborted) return;
  log("info", "worker.shutdown.requested", { signal });
  shutdown.abort(new DOMException(`收到 ${signal}`, "AbortError"));
}

process.once("SIGTERM", () => requestShutdown("SIGTERM"));
process.once("SIGINT", () => requestShutdown("SIGINT"));

async function main() {
  try {
    const options = await loadWorkerOptions();
    log("info", "worker.started", {
      owner: options.owner,
      leaseMs: options.leaseMs,
      heartbeatMs: options.heartbeatMs,
      pollMs: options.pollMs
    });
    const loops = [
      runWorkerLoop(options, shutdown.signal, log),
      runAgentEventOutboxDispatcher(
        { batchSize: 100, pollMs: Math.min(options.pollMs, 500) },
        shutdown.signal,
        log
      )
    ].map(async (loop) => {
      try {
        await loop;
      } finally {
        if (!shutdown.signal.aborted) {
          shutdown.abort(new DOMException("Worker 子循环已停止", "AbortError"));
        }
      }
    });
    const results = await Promise.allSettled(loops);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  } catch (error) {
    log("error", "worker.fatal", { error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  } finally {
    await closeDatabase();
    log("info", "worker.stopped");
  }
}

void main().catch((error) => {
  log("error", "worker.shutdown.failed", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
