import { createHash } from "node:crypto";
import type { AgentEventType } from "@/lib/agent-events/types";
import { transaction } from "@/server/persistence/database";
import type { SearchAgentEvent } from "@/server/search-agent/events";
import {
  insertEventWithClient,
  rememberProjectExchangeWithClient,
  type LiveRunLease,
  type LiveRunRecord,
  type ProjectExchangeInput
} from "./store";

export type AuthoritativeCheckpoint = {
  id: string;
  parentId: string | null;
  namespace: string;
  sessionId: string;
  step: number;
};

type CheckpointBoundary = Extract<SearchAgentEvent, { type: "checkpoint.committed" }>;
type PersistableEvent = { type: AgentEventType; payload: Record<string, unknown> };

export type ClaimedCheckpointBatch = {
  boundary: CheckpointBoundary;
  sourceEvents: SearchAgentEvent[];
  events: PersistableEvent[];
  terminal?: {
    status: "completed" | "failed" | "stopped";
    memory?: ProjectExchangeInput;
  };
};

type ClaimedRunIdentity = {
  run: LiveRunRecord;
  lease: LiveRunLease;
};

type LockedRunRow = {
  revision: string | number;
  checkpoint_id: string | null;
  checkpoint_session_id: string | null;
  checkpoint_ns: string | null;
  checkpoint_step: string | number | null;
  status: string;
  lease_owner: string | null;
  lease_epoch: string | number;
  lease_valid: boolean;
  archived_at: string | null;
};

type ExistingCommitRow = {
  revision: string | number;
  parent_checkpoint_id: string | null;
  checkpoint_session_id: string;
  checkpoint_ns: string;
  step: string | number;
  source_count: number;
  event_count: number;
  batch_hash: string;
};

export class CheckpointBatchConflictError extends Error {
  readonly code = "CHECKPOINT_BATCH_CONFLICT";

  constructor(message = "Checkpoint batch 与已持久化内容冲突") {
    super(message);
    this.name = "CheckpointBatchConflictError";
  }
}

export class CheckpointParentConflictError extends Error {
  readonly code = "CHECKPOINT_PARENT_CONFLICT";

  constructor(message = "Checkpoint parent 与 Run 权威引用不连续") {
    super(message);
    this.name = "CheckpointParentConflictError";
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CheckpointBatchConflictError("Batch 包含非有限数值");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  throw new CheckpointBatchConflictError("Batch 包含不可序列化值");
}

function sha256(value: unknown) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function canonicalCheckpointBatchHash(batch: ClaimedCheckpointBatch) {
  return sha256({
    boundary: batch.boundary,
    sourceEvents: batch.sourceEvents,
    events: batch.events,
    terminal: batch.terminal
  });
}

function safeInteger(value: string | number | null, field: string) {
  const parsed = typeof value === "number" ? value : value === null ? Number.NaN : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new CheckpointBatchConflictError(`${field} 不是安全整数`);
  }
  return parsed;
}

function checkpoint(boundary: CheckpointBoundary): AuthoritativeCheckpoint {
  return {
    id: boundary.checkpointId,
    parentId: boundary.parentCheckpointId,
    namespace: boundary.checkpointNs,
    sessionId: boundary.checkpointSessionId,
    step: boundary.step
  };
}

function validateBatch(batch: ClaimedCheckpointBatch) {
  if (batch.sourceEvents.length + 1 > 10_000 || batch.events.length > 10_000) {
    throw new CheckpointBatchConflictError("Checkpoint batch 超过上限");
  }
  const eventIds = new Set<string>();
  const streamSequences = new Set<number>();
  let previousSequence = 0;
  for (const event of batch.sourceEvents) {
    if (
      event.type === "checkpoint.committed"
      || event.streamId !== batch.boundary.streamId
      || event.streamSeq >= batch.boundary.streamSeq
      || event.streamSeq <= previousSequence
      || eventIds.has(event.eventId)
      || streamSequences.has(event.streamSeq)
    ) {
      throw new CheckpointBatchConflictError("Source event 顺序或业务键冲突");
    }
    eventIds.add(event.eventId);
    streamSequences.add(event.streamSeq);
    previousSequence = event.streamSeq;
  }
  if (
    eventIds.has(batch.boundary.eventId)
    || streamSequences.has(batch.boundary.streamSeq)
    || batch.boundary.streamSeq <= previousSequence
  ) {
    throw new CheckpointBatchConflictError("Checkpoint boundary 业务键或顺序冲突");
  }
  const sourceTerminal = batch.sourceEvents.at(-1)?.type;
  const expectedTerminal = batch.terminal?.status === "completed"
    ? "run.completed"
    : batch.terminal?.status === "failed"
      ? "run.failed"
      : batch.terminal?.status === "stopped"
        ? "run.stopped"
        : undefined;
  const terminalCount = batch.sourceEvents.filter((event) =>
    ["run.completed", "run.failed", "run.stopped"].includes(event.type)
  ).length;
  if (
    (expectedTerminal !== undefined && (expectedTerminal !== sourceTerminal || terminalCount !== 1))
    || (expectedTerminal === undefined && terminalCount !== 0)
  ) {
    throw new CheckpointBatchConflictError("终态必须唯一且是 batch 中最后一个 source event");
  }
  const expectedProjectedTerminal = batch.terminal?.status === "completed"
    ? "run.completed"
    : batch.terminal?.status === "failed"
      ? "run.failed"
      : batch.terminal?.status === "stopped"
        ? "run.cancelled"
        : undefined;
  const projectedTerminal = batch.events.at(-1)?.type;
  const projectedTerminalCount = batch.events.filter((event) =>
    ["run.completed", "run.failed", "run.cancelled"].includes(event.type)
  ).length;
  if (
    (expectedProjectedTerminal !== undefined
      && (expectedProjectedTerminal !== projectedTerminal || projectedTerminalCount !== 1))
    || (expectedProjectedTerminal === undefined && projectedTerminalCount !== 0)
  ) {
    throw new CheckpointBatchConflictError("公开终态必须唯一、匹配 Run 状态且是 batch 中最后一个投影事件");
  }
  if (batch.terminal?.status !== "completed" && batch.terminal?.memory !== undefined) {
    throw new CheckpointBatchConflictError("只有完成终态可以写入项目记忆");
  }
}

function duplicateMatches(
  existing: ExistingCommitRow,
  batch: ClaimedCheckpointBatch,
  hash: string
) {
  const boundary = batch.boundary;
  return existing.parent_checkpoint_id === boundary.parentCheckpointId
    && existing.checkpoint_session_id === boundary.checkpointSessionId
    && existing.checkpoint_ns === boundary.checkpointNs
    && safeInteger(existing.step, "checkpoint step") === boundary.step
    && existing.source_count === batch.sourceEvents.length + 1
    && existing.event_count === batch.events.length
    && existing.batch_hash.trim() === hash;
}

export async function commitClaimedCheckpointBatch(
  claim: ClaimedRunIdentity,
  batch: ClaimedCheckpointBatch
) {
  validateBatch(batch);
  const hash = canonicalCheckpointBatchHash(batch);
  const sourceEvents = [...batch.sourceEvents, batch.boundary];
  return transaction(async (client) => {
    const locked = await client.query<LockedRunRow>(`
      SELECT revision, checkpoint_id, checkpoint_session_id, checkpoint_ns, checkpoint_step,
        status, lease_owner, lease_epoch, lease_expires_at > now() AS lease_valid,
        archived_at
      FROM wb_runs
      WHERE id = $1 AND visitor_id = $2
      FOR UPDATE
    `, [claim.run.id, claim.run.visitorId]);
    const run = locked.rows[0];
    if (!run) return null;

    const existingResult = await client.query<ExistingCommitRow>(`
      SELECT revision, parent_checkpoint_id, checkpoint_session_id, checkpoint_ns,
        step, source_count, event_count, batch_hash
      FROM wb_checkpoint_commits
      WHERE run_id = $1 AND checkpoint_id = $2
    `, [claim.run.id, batch.boundary.checkpointId]);
    const existing = existingResult.rows[0];
    if (existing) {
      if (!duplicateMatches(existing, batch, hash)) throw new CheckpointBatchConflictError();
      return {
        status: "duplicate" as const,
        revision: safeInteger(existing.revision, "commit revision"),
        checkpoint: checkpoint(batch.boundary)
      };
    }

    if (
      run.archived_at !== null
      || !["running", "waiting"].includes(run.status)
      || run.lease_owner !== claim.lease.owner
      || safeInteger(run.lease_epoch, "run lease epoch") !== claim.lease.epoch
      || !run.lease_valid
    ) {
      return null;
    }

    const revision = safeInteger(run.revision, "run revision");
    const currentStep = run.checkpoint_step === null
      ? null
      : safeInteger(run.checkpoint_step, "run checkpoint step");
    if (
      run.checkpoint_id !== batch.boundary.parentCheckpointId
      || (run.checkpoint_id !== null && run.checkpoint_session_id !== batch.boundary.checkpointSessionId)
      || (run.checkpoint_id !== null && run.checkpoint_ns !== batch.boundary.checkpointNs)
      || (currentStep !== null && batch.boundary.step <= currentStep)
    ) {
      throw new CheckpointParentConflictError();
    }

    if (sourceEvents.length) {
      const collisions = await client.query(`
        SELECT source_event_id
        FROM wb_source_event_inbox
        WHERE run_id = $1 AND (
          source_event_id = ANY($2::text[])
          OR (source_stream_id, source_stream_seq) IN (
            SELECT * FROM unnest($3::text[], $4::integer[])
          )
        )
        LIMIT 1
      `, [
        claim.run.id,
        sourceEvents.map((event) => event.eventId),
        sourceEvents.map((event) => event.streamId),
        sourceEvents.map((event) => event.streamSeq)
      ]);
      if (collisions.rowCount) {
        throw new CheckpointBatchConflictError("Source Inbox 业务键已属于其他 batch");
      }
    }

    const nextRevision = revision + 1;
    if (!Number.isSafeInteger(nextRevision)) {
      throw new CheckpointBatchConflictError("Run revision 超出安全整数范围");
    }
    const terminalStatus = batch.terminal?.status ?? null;
    const updated = await client.query(`
      UPDATE wb_runs
      SET revision = $4,
          checkpoint_id = $5,
          checkpoint_session_id = $6,
          checkpoint_ns = $7,
          checkpoint_step = $8,
          status = COALESCE($9::text, status),
          completed_at = CASE WHEN $9::text IS NULL THEN completed_at ELSE now() END,
          lease_owner = CASE WHEN $9::text IS NULL THEN lease_owner ELSE NULL END,
          lease_expires_at = CASE WHEN $9::text IS NULL THEN lease_expires_at ELSE NULL END
      WHERE id = $1 AND lease_owner = $2 AND lease_epoch = $3
        AND archived_at IS NULL
        AND status IN ('running', 'waiting')
        AND lease_expires_at > now()
    `, [
      claim.run.id,
      claim.lease.owner,
      claim.lease.epoch,
      nextRevision,
      batch.boundary.checkpointId,
      batch.boundary.checkpointSessionId,
      batch.boundary.checkpointNs,
      batch.boundary.step,
      terminalStatus
    ]);
    if (updated.rowCount !== 1) return null;

    await client.query(`
      INSERT INTO wb_checkpoint_commits (
        run_id, visitor_id, revision, checkpoint_id, checkpoint_session_id,
        checkpoint_ns, parent_checkpoint_id, step, source_count, event_count, batch_hash
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `, [
      claim.run.id,
      claim.run.visitorId,
      nextRevision,
      batch.boundary.checkpointId,
      batch.boundary.checkpointSessionId,
      batch.boundary.checkpointNs,
      batch.boundary.parentCheckpointId,
      batch.boundary.step,
      sourceEvents.length,
      batch.events.length,
      hash
    ]);

    if (sourceEvents.length) {
      const inboxRows = sourceEvents.map((event) => ({
        sourceEventId: event.eventId,
        sourceStreamId: event.streamId,
        sourceStreamSeq: event.streamSeq,
        sourceType: event.type,
        contentHash: sha256(event),
        payload: event
      }));
      await client.query(`
        INSERT INTO wb_source_event_inbox (
          run_id, visitor_id, checkpoint_id, source_event_id, source_stream_id,
          source_stream_seq, source_type, content_hash, payload
        )
        SELECT $1, $2, $3,
          item->>'sourceEventId', item->>'sourceStreamId',
          (item->>'sourceStreamSeq')::integer, item->>'sourceType',
          item->>'contentHash', item->'payload'
        FROM jsonb_array_elements($4::jsonb) AS item
      `, [
        claim.run.id,
        claim.run.visitorId,
        batch.boundary.checkpointId,
        JSON.stringify(inboxRows)
      ]);
    }

    for (const event of batch.events) {
      await insertEventWithClient(client, claim.run, event.type, event.payload);
    }

    if (batch.terminal) {
      await client.query(
        "UPDATE wb_threads SET status = $3, updated_at = now() WHERE id = $1 AND visitor_id = $2",
        [
          claim.run.threadId,
          claim.run.visitorId,
          batch.terminal.status === "failed" ? "failed" : "idle"
        ]
      );
      if (batch.terminal.memory) {
        await rememberProjectExchangeWithClient(client, claim.run, batch.terminal.memory);
      }
    }

    return {
      status: "committed" as const,
      revision: nextRevision,
      checkpoint: checkpoint(batch.boundary)
    };
  });
}
