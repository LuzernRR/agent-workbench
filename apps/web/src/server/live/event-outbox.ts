import { transaction } from "@/server/persistence/database";

export const AGENT_EVENT_NOTIFY_CHANNEL = "workbench_agent_events";

const MAX_BATCH_SIZE = 500;
const RETRY_DELAY_MS = 1_000;

type OutboxRow = {
  event_id: string;
  event_seq: string | number;
};

export type AgentEventOutboxDispatchResult = {
  claimed: number;
  published: number;
  failed: number;
};

export type AgentEventOutboxOptions = {
  batchSize: number;
  pollMs: number;
};

type OutboxLog = (
  level: "info" | "error",
  message: string,
  context?: Record<string, unknown>
) => void;

type OutboxDispatcherDependencies = {
  dispatch: (batchSize: number) => Promise<AgentEventOutboxDispatchResult>;
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

function checkedInteger(value: number, name: string, minimum: number, maximum: number) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} 必须是 ${minimum} 到 ${maximum} 之间的整数`);
  }
  return value;
}

function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replaceAll("\u0000", "")
    .slice(0, 1_000);
}

export async function dispatchAgentEventOutboxBatch(batchSizeInput = 100) {
  const batchSize = checkedInteger(batchSizeInput, "batchSize", 1, MAX_BATCH_SIZE);
  return transaction<AgentEventOutboxDispatchResult>(async (client) => {
    const claimed = await client.query<OutboxRow>(`
      SELECT outbox.event_id, event.seq::text AS event_seq
      FROM wb_agent_event_outbox outbox
      JOIN wb_agent_events event ON event.id = outbox.event_id
      WHERE outbox.published_at IS NULL AND outbox.available_at <= now()
      ORDER BY outbox.available_at, outbox.created_at, outbox.event_id
      LIMIT $1
      FOR UPDATE OF outbox SKIP LOCKED
    `, [batchSize]);

    let published = 0;
    let failed = 0;
    for (const row of claimed.rows) {
      await client.query("SAVEPOINT wb_agent_event_publish");
      try {
        // The sequence is a bounded wake-up hint. Durable delivery remains the event table + SSE cursor.
        await client.query(`SELECT pg_notify('${AGENT_EVENT_NOTIFY_CHANNEL}', $1)`, [String(row.event_seq)]);
        const settled = await client.query(`
          UPDATE wb_agent_event_outbox
          SET attempts = attempts + 1, published_at = now(), last_error = NULL
          WHERE event_id = $1 AND published_at IS NULL
        `, [row.event_id]);
        if (settled.rowCount !== 1) throw new Error("Outbox 发布结算丢失锁定行");
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT wb_agent_event_publish");
        const retained = await client.query(`
          UPDATE wb_agent_event_outbox
          SET attempts = attempts + 1,
              available_at = now() + ($3::integer * interval '1 millisecond'),
              last_error = $2
          WHERE event_id = $1 AND published_at IS NULL
        `, [row.event_id, errorMessage(error), RETRY_DELAY_MS]);
        if (retained.rowCount !== 1) throw new Error("Outbox 失败结算丢失锁定行");
        await client.query("RELEASE SAVEPOINT wb_agent_event_publish");
        failed += 1;
        continue;
      }
      await client.query("RELEASE SAVEPOINT wb_agent_event_publish");
      published += 1;
    }

    return { claimed: claimed.rows.length, published, failed };
  });
}

const defaultDependencies: OutboxDispatcherDependencies = {
  dispatch: dispatchAgentEventOutboxBatch,
  wait: abortableOutboxDelay
};

export async function runAgentEventOutboxDispatcher(
  options: AgentEventOutboxOptions,
  signal: AbortSignal,
  log: OutboxLog,
  dependencies: OutboxDispatcherDependencies = defaultDependencies
) {
  const batchSize = checkedInteger(options.batchSize, "batchSize", 1, MAX_BATCH_SIZE);
  const pollMs = checkedInteger(options.pollMs, "pollMs", 10, 60_000);
  while (!signal.aborted) {
    let result: AgentEventOutboxDispatchResult | null = null;
    try {
      result = await dependencies.dispatch(batchSize);
      if (result.published || result.failed) {
        log("info", "worker.outbox.dispatched", result);
      }
    } catch (error) {
      log("error", "worker.outbox.failed", { error: errorMessage(error) });
    }
    if (signal.aborted) break;
    if (result?.claimed === batchSize) continue;
    await dependencies.wait(pollMs, signal);
  }
}

function abortableOutboxDelay(milliseconds: number, signal: AbortSignal) {
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
