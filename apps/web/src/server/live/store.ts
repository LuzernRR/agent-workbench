import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { createEmptyThreadState, reduceAgentEvents } from "@/lib/agent-events/reducer";
import type { AgentEvent, AgentEventType, AgentThreadState, MessageAttachment, ProjectSummary, ThreadSnapshot, ThreadSummary } from "@/lib/agent-events/types";
import {
  checkRunAdmissionWithClient,
  memoryAuthorizationScope,
  QuotaExceededError,
  recordAuthorizationDeniedWithClient,
  recordAuthorizationDenialsWithClient,
  recordRunLifecycleWithClient
} from "@/server/live/quota";
import { ImageInputError, MAX_IMAGE_INPUTS_PER_RUN, prepareImageInput, type PreparedImageInput } from "@/server/media/image-input";
import { query, transaction } from "@/server/persistence/database";
import type { SearchAgentEvent } from "@/server/search-agent/events";
import type { SearchAgentExecutionInput } from "@/server/search-agent/mapper";
import {
  canonicalDirectTerminalSettlementHash,
  TerminalSettlementConflictError,
  terminalSettlementValuesEqual,
  validateDirectTerminalSettlement,
  type DirectTerminalSettlement,
  type DirectTerminalStatus
} from "./terminal-settlements";

type ProjectRow = { id: string; name: string; path: string; status: ProjectSummary["status"] };
type ThreadRow = {
  id: string;
  project_id: string | null;
  title: string;
  status: ThreadSummary["status"];
  updated_at: Date | string;
  last_user_message_at: Date | string | null;
};
type EventRow = {
  id: string;
  seq: string | number;
  project_id: string | null;
  thread_id: string;
  run_id: string;
  created_at: Date | string;
  event_type: AgentEventType;
  payload: Record<string, unknown>;
};
type AttachmentRow = {
  id: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  kind: "image" | "document";
  bytes: Buffer;
};
type ProjectMemoryRow = {
  id: string;
  source_thread_id: string;
  source_thread_title: string;
  source_run_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: Date | string;
};

type ProjectMemoryExchange = {
  sourceThreadId: string;
  sourceThreadTitle: string;
  sourceRunId: string;
  createdAt: string;
  user: string;
  assistant: string;
  rowIds: string[];
};

export type LiveRunRecord = {
  id: string;
  visitorId: string;
  threadId: string;
  projectId: string | null;
  modelId: string;
  agentId?: string;
  /** Server-derived from the owning visitor row; absent for records read on paths that do not authorize. */
  tenantId?: string;
};

export type LiveRunStatus = "queued" | "running" | "waiting" | "completed" | "failed" | "stopped";

export function createUserStoppedPayload(): Record<string, unknown> {
  return {
    reasonCode: "USER_STOPPED",
    partial: true,
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, cost_usd: 0 }
  };
}

export type ProjectExchangeInput = {
  userMessage: string;
  assistantMessage: string;
};

export type PreparedRun = {
  run: LiveRunRecord;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  attachmentContext: string;
  /** 图片 bytes 只保留在 BFF 内存，绝不能进入事件或 Search Agent JSON。 */
  imageInputs: PreparedImageInput[];
  projectMemoryContext: string;
  userMessageId: string;
};

const durableSearchRunInputSchema = z.object({
  version: z.literal(1),
  message: z.string().min(1),
  history: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string()
  }).strict()).max(40),
  attachmentIds: z.array(z.string().min(1)).max(32),
  projectMemoryContext: z.string(),
  reasoningEffort: z.enum(["medium", "high", "xhigh", "max"])
}).strict();

type DurableSearchRunInput = z.infer<typeof durableSearchRunInputSchema>;

export type LiveRunLease = {
  owner: string;
  epoch: number;
};

export type LiveCheckpointReference = {
  id: string;
  namespace: string;
  sessionId: string;
  step: number;
};

export type ClaimedLiveRun = {
  run: LiveRunRecord;
  lease: LiveRunLease;
  input: SearchAgentExecutionInput;
  resume: boolean;
  checkpoint: LiveCheckpointReference | null;
  attempt: number;
  leaseExpiresAt: string;
};

type ClaimedRunIdentity = Pick<ClaimedLiveRun, "run" | "lease">;

type ClaimRow = {
  id: string;
  visitor_id: string;
  thread_id: string;
  project_id: string | null;
  model_id: string;
  agent_id: string;
  execution_input: unknown;
  lease_epoch: string | number;
  lease_expires_at: Date | string;
  worker_attempt: number;
  stop_requested_at: Date | string | null;
  checkpoint_id: string | null;
  checkpoint_session_id: string | null;
  checkpoint_ns: string | null;
  checkpoint_step: string | number | null;
  tenant_id: string | null;
};

type TerminalSettlementRow = {
  run_id: string;
  visitor_id: string;
  staged_lease_owner: string;
  staged_lease_epoch: string | number;
  source_stream_id: string;
  source_first_seq: number;
  source_last_seq: number;
  source_count: number;
  source_events: unknown;
  projected_count: number;
  projected_events: unknown;
  terminal_status: DirectTerminalStatus;
  terminal_payload: unknown;
  usage: unknown;
  canonical_hash: string;
  settled_lease_owner: string | null;
  settled_lease_epoch: string | number | null;
  settled_status: DirectTerminalStatus | null;
  settled_at: Date | string | null;
};

type TerminalSettlementRunRow = {
  status: LiveRunStatus;
  archived_at: Date | string | null;
  lease_owner: string | null;
  lease_epoch: string | number;
  lease_expires_at: Date | string | null;
  lease_valid: boolean;
  stop_requested_at: Date | string | null;
};

const iso = (value: Date | string) => value instanceof Date ? value.toISOString() : new Date(value).toISOString();

export function liveId(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function projectSummary(row: ProjectRow): ProjectSummary {
  return { id: row.id, name: row.name, path: row.path, status: row.status };
}

function threadSummary(row: ThreadRow): ThreadSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    status: row.status,
    updatedAt: iso(row.updated_at),
    lastUserMessageAt: row.last_user_message_at ? iso(row.last_user_message_at) : undefined
  };
}

function agentEvent(row: EventRow): AgentEvent {
  return {
    id: row.id,
    seq: Number(row.seq),
    projectId: row.project_id,
    threadId: row.thread_id,
    runId: row.run_id,
    createdAt: iso(row.created_at),
    type: row.event_type,
    payload: row.payload
  };
}

function attachmentSummary(row: AttachmentRow): MessageAttachment {
  return {
    id: row.id,
    name: row.name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    kind: row.kind,
    url: `/api/v1/attachments/${row.id}`
  };
}

export async function listLiveProjects(visitorId: string) {
  const result = await query<ProjectRow>(`
    SELECT p.id, p.name, p.path,
      CASE
        WHEN EXISTS (SELECT 1 FROM wb_threads t WHERE t.project_id = p.id AND t.visitor_id = p.visitor_id AND t.status = 'failed') THEN 'failed'
        WHEN EXISTS (SELECT 1 FROM wb_threads t WHERE t.project_id = p.id AND t.visitor_id = p.visitor_id AND t.status = 'waiting') THEN 'waiting'
        WHEN EXISTS (SELECT 1 FROM wb_threads t WHERE t.project_id = p.id AND t.visitor_id = p.visitor_id AND t.status = 'running') THEN 'running'
        ELSE 'idle'
      END AS status
    FROM wb_projects p
    WHERE p.visitor_id = $1
    ORDER BY p.sort_order, p.created_at
  `, [visitorId]);
  return result.rows.map(projectSummary);
}

export async function createLiveProject(visitorId: string, name: string) {
  const id = liveId("proj");
  const result = await query<ProjectRow>(`
    INSERT INTO wb_projects (id, visitor_id, name, sort_order)
    VALUES ($1, $2, $3, COALESCE((SELECT max(sort_order) + 1 FROM wb_projects WHERE visitor_id = $2), 0))
    RETURNING id, name, path, 'idle'::text AS status
  `, [id, visitorId, name]);
  return projectSummary(result.rows[0]);
}

export async function updateLiveProject(visitorId: string, projectId: string, patch: { name?: string; path?: string }) {
  const result = await query<ProjectRow>(`
    UPDATE wb_projects
    SET name = COALESCE($3, name), path = COALESCE($4, path), updated_at = now()
    WHERE id = $1 AND visitor_id = $2
    RETURNING id, name, path, 'idle'::text AS status
  `, [projectId, visitorId, patch.name ?? null, patch.path ?? null]);
  return result.rows[0] ? projectSummary(result.rows[0]) : null;
}

export type ReorderLiveProjectsResult =
  | { kind: "reordered" }
  | { kind: "invalid_order" }
  | { kind: "not_owned_or_missing"; resourceId: string };

export async function reorderLiveProjects(visitorId: string, projectIds: string[]): Promise<ReorderLiveProjectsResult> {
  return transaction(async (client) => {
    const owned = await client.query<{ id: string }>("SELECT id FROM wb_projects WHERE visitor_id = $1 FOR UPDATE", [visitorId]);
    const ownedIds = new Set(owned.rows.map((row) => row.id));
    if (new Set(projectIds).size !== projectIds.length) return { kind: "invalid_order" };
    const deniedId = projectIds.find((id) => !ownedIds.has(id));
    if (deniedId) return { kind: "not_owned_or_missing", resourceId: deniedId };
    if (projectIds.length !== ownedIds.size) return { kind: "invalid_order" };
    for (let index = 0; index < projectIds.length; index += 1) {
      await client.query("UPDATE wb_projects SET sort_order = $3, updated_at = now() WHERE id = $1 AND visitor_id = $2", [projectIds[index], visitorId, index]);
    }
    return { kind: "reordered" };
  });
}

export async function deleteLiveProject(visitorId: string, projectId: string) {
  const result = await query("DELETE FROM wb_projects WHERE id = $1 AND visitor_id = $2", [projectId, visitorId]);
  return result.rowCount === 1;
}

export async function listLiveThreads(visitorId: string, projectId?: string) {
  if (projectId !== undefined) {
    return transaction(async (client) => {
      const owned = await client.query("SELECT 1 FROM wb_projects WHERE id = $1 AND visitor_id = $2", [projectId, visitorId]);
      if (!owned.rowCount) return null;
      const result = await client.query<ThreadRow>(`
        SELECT id, project_id, title, status, updated_at, last_user_message_at
        FROM wb_threads
        WHERE visitor_id = $1 AND project_id = $2
        ORDER BY updated_at DESC
      `, [visitorId, projectId]);
      return result.rows.map(threadSummary);
    });
  }
  const values: unknown[] = [visitorId];
  const result = await query<ThreadRow>(`
    SELECT id, project_id, title, status, updated_at, last_user_message_at
    FROM wb_threads
    WHERE visitor_id = $1
    ORDER BY updated_at DESC
  `, values);
  return result.rows.map(threadSummary);
}

export async function createLiveThread(visitorId: string, projectId: string | null, title?: string) {
  const id = liveId("thread");
  const result = await query<ThreadRow>(`
    INSERT INTO wb_threads (id, visitor_id, project_id, title)
    SELECT $1, $2, $3, $4
    WHERE $3::text IS NULL OR EXISTS (SELECT 1 FROM wb_projects WHERE id = $3 AND visitor_id = $2)
    RETURNING id, project_id, title, status, updated_at, last_user_message_at
  `, [id, visitorId, projectId, title?.trim() || "新会话"]);
  return result.rows[0] ? threadSummary(result.rows[0]) : null;
}

export type UpdateLiveThreadResult =
  | { kind: "updated"; thread: ThreadSummary }
  | { kind: "thread_denied"; resourceId: string }
  | { kind: "target_project_denied"; resourceId: string };

export async function updateLiveThread(
  visitorId: string,
  threadId: string,
  patch: { title?: string; projectId?: string | null }
): Promise<UpdateLiveThreadResult> {
  return transaction(async (client) => {
    const ownedThread = await client.query("SELECT 1 FROM wb_threads WHERE id = $1 AND visitor_id = $2 FOR UPDATE", [threadId, visitorId]);
    if (!ownedThread.rowCount) return { kind: "thread_denied", resourceId: threadId };
    if (patch.projectId) {
      const project = await client.query("SELECT 1 FROM wb_projects WHERE id = $1 AND visitor_id = $2", [patch.projectId, visitorId]);
      if (!project.rowCount) return { kind: "target_project_denied", resourceId: patch.projectId };
    }
    const result = await client.query<ThreadRow>(`
      UPDATE wb_threads
      SET title = COALESCE($3, title),
          project_id = CASE WHEN $4::boolean THEN $5::text ELSE project_id END,
          updated_at = now()
      WHERE id = $1 AND visitor_id = $2
      RETURNING id, project_id, title, status, updated_at, last_user_message_at
    `, [threadId, visitorId, patch.title ?? null, Object.prototype.hasOwnProperty.call(patch, "projectId"), patch.projectId ?? null]);
    if (!result.rows[0]) throw new Error("已验证会话更新失败");
    if (patch.title && result.rows[0]) {
      await client.query(
        "UPDATE wb_project_memories SET source_thread_title = $3 WHERE source_thread_id = $1 AND visitor_id = $2",
        [threadId, visitorId, result.rows[0].title]
      );
    }
    if (Object.prototype.hasOwnProperty.call(patch, "projectId") && result.rows[0]) {
      await client.query("UPDATE wb_runs SET project_id = $3 WHERE thread_id = $1 AND visitor_id = $2", [threadId, visitorId, patch.projectId ?? null]);
      await client.query("UPDATE wb_agent_events SET project_id = $3 WHERE thread_id = $1 AND visitor_id = $2", [threadId, visitorId, patch.projectId ?? null]);
      if (patch.projectId) {
        await client.query("UPDATE wb_project_memories SET project_id = $3 WHERE source_thread_id = $1 AND visitor_id = $2 AND archived_at IS NULL", [threadId, visitorId, patch.projectId]);
      } else {
        await client.query("UPDATE wb_project_memories SET archived_at = now() WHERE source_thread_id = $1 AND visitor_id = $2 AND archived_at IS NULL", [threadId, visitorId]);
      }
    }
    return { kind: "updated", thread: threadSummary(result.rows[0]) };
  });
}

export async function deleteLiveThread(visitorId: string, threadId: string) {
  return transaction(async (client) => {
    const owned = await client.query("SELECT 1 FROM wb_threads WHERE id = $1 AND visitor_id = $2 FOR UPDATE", [threadId, visitorId]);
    if (!owned.rowCount) return false;
    await client.query("DELETE FROM wb_project_memories WHERE source_thread_id = $1 AND visitor_id = $2", [threadId, visitorId]);
    const result = await client.query("DELETE FROM wb_threads WHERE id = $1 AND visitor_id = $2", [threadId, visitorId]);
    if (result.rowCount !== 1) throw new Error("已验证会话删除失败");
    return true;
  });
}

async function eventRows(visitorId: string, threadId: string) {
  const result = await query<EventRow>(`
    SELECT id, seq, project_id, thread_id, run_id, created_at, event_type, payload
    FROM wb_agent_events
    WHERE visitor_id = $1 AND thread_id = $2 AND archived_at IS NULL
    ORDER BY seq
  `, [visitorId, threadId]);
  return result.rows;
}

export async function getLiveSnapshot(visitorId: string, threadId: string): Promise<ThreadSnapshot | null> {
  const threadResult = await query<ThreadRow>(`
    SELECT id, project_id, title, status, updated_at, last_user_message_at
    FROM wb_threads WHERE id = $1 AND visitor_id = $2
  `, [threadId, visitorId]);
  const thread = threadResult.rows[0];
  if (!thread) return null;
  const [events, projects, activeRun] = await Promise.all([
    eventRows(visitorId, threadId),
    thread.project_id ? listLiveProjects(visitorId) : Promise.resolve([]),
    query<{ id: string; status: "queued" | "running" | "waiting" }>(`
      SELECT id, status FROM wb_runs
      WHERE visitor_id = $1 AND thread_id = $2 AND archived_at IS NULL AND status IN ('queued', 'running', 'waiting')
      ORDER BY created_at DESC LIMIT 1
    `, [visitorId, threadId])
  ]);
  const state = reduceAgentEvents(createEmptyThreadState(thread.project_id, thread.id), events.map(agentEvent));
  const active = activeRun.rows[0];
  const hydrated: AgentThreadState = {
    ...state,
    activeRunId: active?.id ?? null,
    runStatus: active?.status ?? (state.runStatus === "running" ? "completed" : state.runStatus)
  };
  return {
    project: thread.project_id ? projects.find((project) => project.id === thread.project_id) ?? null : null,
    thread: threadSummary(thread),
    state: hydrated
  };
}

function completedMessages(rows: EventRow[]) {
  type CompletedMessage = { id: string; runId: string; role: "user" | "assistant"; content: string };
  const completed: CompletedMessage[] = [];
  const drafts = new Map<string, CompletedMessage>();
  for (const row of rows) {
    const messageId = typeof row.payload.messageId === "string" ? row.payload.messageId : "";
    if (!messageId) continue;
    if (row.event_type === "message.started") {
      const role = row.payload.role;
      if (role === "user" || role === "assistant") drafts.set(messageId, { id: messageId, runId: row.run_id, role, content: typeof row.payload.text === "string" ? row.payload.text : "" });
      continue;
    }
    if (row.event_type === "text.delta" || row.event_type === "message.delta") {
      const draft = drafts.get(messageId);
      if (draft && typeof row.payload.delta === "string") draft.content += row.payload.delta;
      continue;
    }
    if (row.event_type !== "message.completed") continue;
    const draft = drafts.get(messageId);
    if (!draft) continue;
    if (typeof row.payload.text === "string") draft.content = row.payload.text;
    const existing = completed.findIndex((message) => message.id === messageId);
    if (existing >= 0) completed.splice(existing);
    if (draft.content.trim()) completed.push({ ...draft });
    drafts.delete(messageId);
  }
  return completed;
}

export async function insertEventWithClient(client: PoolClient, run: LiveRunRecord, type: AgentEventType, payload: Record<string, unknown>) {
  const id = liveId("evt");
  const result = await client.query<EventRow>(`
    INSERT INTO wb_agent_events (id, visitor_id, run_id, project_id, thread_id, event_type, payload)
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
    RETURNING id, seq, project_id, thread_id, run_id, created_at, event_type, payload
  `, [id, run.visitorId, run.id, run.projectId, run.threadId, type, JSON.stringify(payload)]);
  await client.query(`
    INSERT INTO wb_agent_event_outbox (event_id, visitor_id, run_id)
    VALUES ($1, $2, $3)
  `, [id, run.visitorId, run.id]);
  return agentEvent(result.rows[0]);
}

function safeTerminalSettlementEpoch(value: string | number | null, field: string, minimum = 0) {
  const epoch = value === null ? Number.NaN : Number(value);
  if (!Number.isSafeInteger(epoch) || epoch < minimum) {
    throw new TerminalSettlementConflictError(`${field} fencing epoch 无效`);
  }
  return epoch;
}

function directSettlementFromRow(run: LiveRunRecord, row: TerminalSettlementRow) {
  if (
    row.run_id !== run.id
    || row.visitor_id !== run.visitorId
    || !Array.isArray(row.source_events)
    || !Array.isArray(row.projected_events)
    || !["failed", "stopped"].includes(row.terminal_status)
    || !row.terminal_payload
    || typeof row.terminal_payload !== "object"
    || Array.isArray(row.terminal_payload)
  ) {
    throw new TerminalSettlementConflictError("持久终态结算结构无效");
  }
  const settlement = {
    terminalStatus: row.terminal_status,
    sourceEvents: row.source_events,
    events: row.projected_events,
    terminalPayload: row.terminal_payload
  } as DirectTerminalSettlement;
  const { terminal, terminalStatus } = validateDirectTerminalSettlement(run.id, settlement);
  const hash = canonicalDirectTerminalSettlementHash(run.id, settlement);
  if (
    row.source_count !== settlement.sourceEvents.length
    || row.projected_count !== settlement.events.length
    || row.source_stream_id !== terminal.streamId
    || row.source_first_seq !== settlement.sourceEvents[0].streamSeq
    || row.source_last_seq !== terminal.streamSeq
    || !terminalSettlementValuesEqual(row.usage, terminal.usage)
    || row.canonical_hash.trim() !== hash
  ) {
    throw new TerminalSettlementConflictError("持久终态结算元数据或 canonical hash 不一致");
  }
  return { settlement, terminal, terminalStatus, hash };
}

type PendingTerminalSettlementConsumeResult =
  | { kind: "none" }
  | { kind: "blocked" }
  | { kind: "settled"; terminalStatus: DirectTerminalStatus; events: AgentEvent[] }
  | { kind: "duplicate"; terminalStatus: DirectTerminalStatus; events: AgentEvent[] };

function stoppedPayloadFromTerminal(
  terminal: Extract<SearchAgentEvent, { type: "run.failed" | "run.stopped" }>,
  terminalPayload: Record<string, unknown>
) {
  return {
    reasonCode: "USER_STOPPED",
    partial: true,
    usage: terminal.usage,
    sourceEventId: terminalPayload.sourceEventId,
    sourceStreamId: terminalPayload.sourceStreamId,
    sourceStreamSeq: terminalPayload.sourceStreamSeq,
    sourceSeq: terminalPayload.sourceSeq
  };
}

type PendingTerminalSettlementAuthority =
  | { kind: "claimed"; claim: ClaimedRunIdentity }
  | { kind: "unleased"; owner: string };

async function consumePendingTerminalSettlementWithClient(
  client: PoolClient,
  run: LiveRunRecord,
  authority: PendingTerminalSettlementAuthority
): Promise<PendingTerminalSettlementConsumeResult> {
  const runResult = await client.query<TerminalSettlementRunRow>(`
    SELECT status, archived_at, lease_owner, lease_epoch, lease_expires_at,
      COALESCE(lease_expires_at > now(), false) AS lease_valid,
      stop_requested_at
    FROM wb_runs
    WHERE id = $1 AND visitor_id = $2
    FOR UPDATE
  `, [run.id, run.visitorId]);
  const lockedRun = runResult.rows[0];
  if (!lockedRun) return { kind: "none" };

  const settlementResult = await client.query<TerminalSettlementRow>(`
    SELECT run_id, visitor_id, staged_lease_owner, staged_lease_epoch,
      source_stream_id, source_first_seq, source_last_seq, source_count,
      source_events, projected_count, projected_events, terminal_status,
      stopped_payload AS terminal_payload, usage, canonical_hash,
      settled_lease_owner, settled_lease_epoch, settled_status, settled_at
    FROM wb_run_terminal_settlements
    WHERE run_id = $1 AND visitor_id = $2
    FOR UPDATE
  `, [run.id, run.visitorId]);
  const row = settlementResult.rows[0];
  // A real row always carries the table's run_id column. The extra guard also
  // keeps fail-closed behavior when a legacy/mock adapter returns an unrelated
  // row shape for an unknown table query.
  if (!row || typeof row.run_id !== "string") return { kind: "none" };
  const { settlement, terminal, terminalStatus } = directSettlementFromRow(run, row);
  const stagedEpoch = safeTerminalSettlementEpoch(row.staged_lease_epoch, "staged", 1);
  const currentEpoch = safeTerminalSettlementEpoch(lockedRun.lease_epoch, "current");

  if (row.settled_at !== null) {
    safeTerminalSettlementEpoch(row.settled_lease_epoch, "settled", stagedEpoch);
    if (
      !row.settled_status
      || lockedRun.status !== row.settled_status
      || lockedRun.lease_owner !== null
      || lockedRun.lease_expires_at !== null
    ) {
      throw new TerminalSettlementConflictError("已结算终态与 Run 终态不一致");
    }
    return { kind: "duplicate", terminalStatus: row.settled_status, events: [] };
  }
  if (
    lockedRun.archived_at !== null
    || !["queued", "running", "waiting"].includes(lockedRun.status)
    || currentEpoch < stagedEpoch
  ) {
    throw new TerminalSettlementConflictError("待结算终态与 Run 当前状态冲突");
  }

  let settledOwner: string;
  if (authority.kind === "claimed") {
    if (
      lockedRun.lease_owner !== authority.claim.lease.owner
      || currentEpoch !== authority.claim.lease.epoch
      || !lockedRun.lease_valid
    ) {
      return { kind: "blocked" };
    }
    settledOwner = authority.claim.lease.owner;
  } else {
    if (lockedRun.lease_valid) return { kind: "blocked" };
    settledOwner = authority.owner;
  }

  const settledStatus: DirectTerminalStatus = lockedRun.stop_requested_at !== null && terminalStatus !== "stopped"
    ? "stopped"
    : terminalStatus;
  const terminalPayload = settledStatus === "stopped" && terminalStatus !== "stopped"
    ? stoppedPayloadFromTerminal(terminal, settlement.terminalPayload)
    : settlement.terminalPayload;
  const transitioned = authority.kind === "claimed"
    ? await client.query(`
        UPDATE wb_runs
        SET status = $5, completed_at = now(), lease_owner = NULL, lease_expires_at = NULL
        WHERE id = $1 AND visitor_id = $2
          AND lease_owner = $3 AND lease_epoch = $4 AND lease_expires_at > now()
          AND archived_at IS NULL
          AND status IN ('running', 'waiting')
      `, [run.id, run.visitorId, authority.claim.lease.owner, authority.claim.lease.epoch, settledStatus])
    : await client.query(`
        UPDATE wb_runs
        SET status = $3, completed_at = now(), lease_owner = NULL, lease_expires_at = NULL
        WHERE id = $1 AND visitor_id = $2
          AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= now())
          AND archived_at IS NULL
          AND status IN ('queued', 'running', 'waiting')
      `, [run.id, run.visitorId, settledStatus]);
  if (transitioned.rowCount !== 1) return { kind: "blocked" };

  const events: AgentEvent[] = [];
  for (const event of settlement.events) {
    events.push(await insertEventWithClient(client, run, event.type, event.payload));
  }
  events.push(await insertEventWithClient(
    client,
    run,
    settledStatus === "stopped" ? "run.cancelled" : "run.failed",
    terminalPayload
  ));
  await recordTerminalLifecycleWithClient(client, run, settledStatus, terminalPayload);
  await client.query(
    "UPDATE wb_threads SET status = $3, updated_at = now() WHERE id = $1 AND visitor_id = $2",
    [run.threadId, run.visitorId, settledStatus === "stopped" ? "idle" : "failed"]
  );
  const consumed = await client.query(`
    UPDATE wb_run_terminal_settlements
    SET settled_lease_owner = $3, settled_lease_epoch = $4, settled_status = $5, settled_at = now()
    WHERE run_id = $1 AND visitor_id = $2 AND settled_at IS NULL
  `, [run.id, run.visitorId, settledOwner, currentEpoch, settledStatus]);
  if (consumed.rowCount !== 1) {
    throw new TerminalSettlementConflictError("待结算终态已被并发消费");
  }
  return { kind: "settled", terminalStatus: settledStatus, events };
}

export async function stageClaimedTerminalSettlement(
  claim: ClaimedRunIdentity,
  settlement: DirectTerminalSettlement
) {
  const { terminal } = validateDirectTerminalSettlement(claim.run.id, settlement);
  const hash = canonicalDirectTerminalSettlementHash(claim.run.id, settlement);
  return transaction(async (client) => {
    const runResult = await client.query<TerminalSettlementRunRow>(`
      SELECT status, archived_at, lease_owner, lease_epoch, lease_expires_at,
        COALESCE(lease_expires_at > now(), false) AS lease_valid,
        stop_requested_at
      FROM wb_runs
      WHERE id = $1 AND visitor_id = $2
      FOR UPDATE
    `, [claim.run.id, claim.run.visitorId]);
    const lockedRun = runResult.rows[0];
    if (!lockedRun) return null;

    const existingResult = await client.query<TerminalSettlementRow>(`
      SELECT run_id, visitor_id, staged_lease_owner, staged_lease_epoch,
        source_stream_id, source_first_seq, source_last_seq, source_count,
        source_events, projected_count, projected_events, terminal_status,
        stopped_payload AS terminal_payload, usage, canonical_hash,
        settled_lease_owner, settled_lease_epoch, settled_status, settled_at
      FROM wb_run_terminal_settlements
      WHERE run_id = $1 AND visitor_id = $2
      FOR UPDATE
    `, [claim.run.id, claim.run.visitorId]);
    const existing = existingResult.rows[0];
    if (existing) {
      directSettlementFromRow(claim.run, existing);
      if (existing.canonical_hash.trim() === hash) {
        return { status: "duplicate" as const, hash, settled: existing.settled_at !== null };
      }
      throw new TerminalSettlementConflictError();
    }
    if (
      lockedRun.archived_at !== null
      || !["running", "waiting"].includes(lockedRun.status)
      || lockedRun.lease_owner !== claim.lease.owner
      || safeTerminalSettlementEpoch(lockedRun.lease_epoch, "current") !== claim.lease.epoch
      || !lockedRun.lease_valid
    ) {
      return null;
    }
    const sourceCollisions = await client.query(`
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
      settlement.sourceEvents.map((event) => event.eventId),
      settlement.sourceEvents.map((event) => event.streamId),
      settlement.sourceEvents.map((event) => event.streamSeq)
    ]);
    if (sourceCollisions.rowCount) {
      throw new TerminalSettlementConflictError("无 checkpoint 终态 source 键已归属 checkpoint inbox");
    }
    await client.query(`
      INSERT INTO wb_run_terminal_settlements (
        run_id, visitor_id, staged_lease_owner, staged_lease_epoch,
        source_stream_id, source_first_seq, source_last_seq, source_count,
        source_events, projected_count, projected_events, terminal_status,
        stopped_payload, usage, canonical_hash
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9::jsonb, $10, $11::jsonb, $12, $13::jsonb, $14::jsonb, $15
      )
    `, [
      claim.run.id,
      claim.run.visitorId,
      claim.lease.owner,
      claim.lease.epoch,
      terminal.streamId,
      settlement.sourceEvents[0].streamSeq,
      terminal.streamSeq,
      settlement.sourceEvents.length,
      JSON.stringify(settlement.sourceEvents),
      settlement.events.length,
      JSON.stringify(settlement.events),
      settlement.terminalStatus,
      JSON.stringify(settlement.terminalPayload),
      JSON.stringify(terminal.usage),
      hash
    ]);
    return { status: "staged" as const, hash, settled: false };
  });
}

export async function settleClaimedTerminalSettlement(claim: ClaimedRunIdentity) {
  return transaction(async (client) => {
    const result = await consumePendingTerminalSettlementWithClient(client, claim.run, { kind: "claimed", claim });
    if (result.kind === "settled" || result.kind === "duplicate") return result;
    return null;
  });
}

function prepareRunAttachments(rows: AttachmentRow[]) {
  const sections: string[] = [];
  const imageInputs: PreparedImageInput[] = [];
  for (const attachment of rows) {
    if (attachment.kind === "image") {
      try {
        imageInputs.push(prepareImageInput({
          id: attachment.id,
          mimeType: attachment.mime_type,
          sizeBytes: attachment.size_bytes,
          bytes: attachment.bytes
        }));
      } catch {
        // 旧附件或被篡改的 MIME 只能保留为用户附件，不得传给任何模型。
      }
    }
    const textLike = attachment.mime_type.startsWith("text/") || ["application/json", "application/xml"].includes(attachment.mime_type);
    if (textLike && attachment.bytes.byteLength <= 64 * 1024) {
      try {
        const content = new TextDecoder("utf-8", { fatal: true }).decode(attachment.bytes).trim();
        sections.push(`附件《${attachment.name}》：\n${content}`);
        continue;
      } catch {
        // A binary or invalid UTF-8 attachment is represented by metadata only.
      }
    }
    sections.push(`附件《${attachment.name}》（${attachment.mime_type}，${attachment.size_bytes} 字节）`);
  }
  if (imageInputs.length > MAX_IMAGE_INPUTS_PER_RUN) {
    throw new ImageInputError("IMAGE_INPUT_TOO_MANY", "单次最多处理 4 张图片");
  }
  return { attachmentContext: sections.join("\n\n"), imageInputs };
}

async function recallProjectMemory(client: PoolClient, input: {
  visitorId: string;
  projectId: string | null;
  query: string;
  excludedRunIds: string[];
  recallItems: number;
  maxChars: number;
}) {
  if (!input.projectId) return "";
  const result = await client.query<ProjectMemoryRow>(`
    SELECT id, source_thread_id, source_thread_title, source_run_id, role, content, created_at
    FROM wb_project_memories
    WHERE visitor_id = $1 AND project_id = $2 AND archived_at IS NULL
      AND NOT (source_run_id = ANY($3::text[]))
    ORDER BY created_at DESC
  `, [input.visitorId, input.projectId, input.excludedRunIds]);
  const selected = buildProjectMemoryContext(result.rows, input.query, input.recallItems, input.maxChars);
  if (selected.rowIds.length) {
    await client.query("UPDATE wb_project_memories SET last_accessed_at = now() WHERE id = ANY($1::text[])", [selected.rowIds]);
  }
  return selected.context;
}

function queryTerms(queryText: string) {
  const normalized = queryText.toLocaleLowerCase("zh-CN");
  const terms = new Set(normalized.split(/[\p{P}\p{S}\s]+/gu).map((term) => term.trim()).filter((term) => term.length >= 2));
  for (const match of normalized.matchAll(/[\p{Script=Han}]{2,}/gu)) {
    const value = match[0];
    for (let index = 0; index < value.length - 1 && terms.size < 80; index += 1) terms.add(value.slice(index, index + 2));
  }
  return [...terms];
}

function relevanceScore(exchange: ProjectMemoryExchange, terms: string[]) {
  const content = `${exchange.sourceThreadTitle}\n${exchange.user}\n${exchange.assistant}`.toLocaleLowerCase("zh-CN");
  return terms.reduce((score, term) => content.includes(term) ? score + Math.min(term.length, 8) : score, 0);
}

function exchangeBlock(exchange: ProjectMemoryExchange, maxChars = Number.POSITIVE_INFINITY) {
  const header = `[会话：${exchange.sourceThreadTitle} | 时间：${exchange.createdAt}]`;
  const userLabel = exchange.user ? "\n用户：" : "";
  const assistantLabel = exchange.assistant ? "\n助手：" : "";
  if (!Number.isFinite(maxChars)) return `${header}${userLabel}${exchange.user}${assistantLabel}${exchange.assistant}`;
  const fixed = header.length + userLabel.length + assistantLabel.length;
  if (fixed >= maxChars) return header.slice(0, Math.max(0, maxChars));
  const available = maxChars - fixed;
  const userBudget = exchange.user && exchange.assistant ? Math.floor(available / 2) : exchange.user ? available : 0;
  const assistantBudget = available - userBudget;
  return `${header}${userLabel}${exchange.user.slice(0, userBudget)}${assistantLabel}${exchange.assistant.slice(0, assistantBudget)}`;
}

export function buildProjectMemoryContext(rows: ProjectMemoryRow[], queryText: string, recallItems: number, maxChars: number) {
  if (!rows.length || maxChars <= 0) return { context: "", rowIds: [] as string[] };
  const exchangesByRun = new Map<string, ProjectMemoryExchange>();
  for (const row of rows) {
    const createdAt = iso(row.created_at);
    const exchange = exchangesByRun.get(row.source_run_id) ?? {
      sourceThreadId: row.source_thread_id,
      sourceThreadTitle: row.source_thread_title,
      sourceRunId: row.source_run_id,
      createdAt,
      user: "",
      assistant: "",
      rowIds: []
    };
    exchange.createdAt = exchange.createdAt > createdAt ? exchange.createdAt : createdAt;
    exchange.sourceThreadTitle = row.source_thread_title;
    exchange[row.role] = row.content;
    exchange.rowIds.push(row.id);
    exchangesByRun.set(row.source_run_id, exchange);
  }

  const exchanges = [...exchangesByRun.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const sourceThreads = new Map<string, { title: string; latestAt: string }>();
  for (const exchange of exchanges) {
    if (!sourceThreads.has(exchange.sourceThreadId)) sourceThreads.set(exchange.sourceThreadId, { title: exchange.sourceThreadTitle, latestAt: exchange.createdAt });
  }
  const directory = `项目来源会话：\n${[...sourceThreads.values()].sort((left, right) => right.latestAt.localeCompare(left.latestAt)).map((thread) => `- ${thread.title}`).join("\n")}`;
  if (directory.length >= maxChars) return { context: directory.slice(0, maxChars), rowIds: [] as string[] };

  const maxExchanges = Math.max(1, Math.floor(recallItems / 2));
  const selected: ProjectMemoryExchange[] = [];
  const selectedRuns = new Set<string>();
  const add = (exchange: ProjectMemoryExchange) => {
    if (selected.length >= maxExchanges || selectedRuns.has(exchange.sourceRunId)) return;
    selected.push(exchange);
    selectedRuns.add(exchange.sourceRunId);
  };
  const latestThreads = new Set<string>();
  for (const exchange of exchanges) {
    if (latestThreads.has(exchange.sourceThreadId)) continue;
    latestThreads.add(exchange.sourceThreadId);
    add(exchange);
  }
  const terms = queryTerms(queryText);
  exchanges
    .filter((exchange) => !selectedRuns.has(exchange.sourceRunId))
    .map((exchange) => ({ exchange, score: relevanceScore(exchange, terms) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || right.exchange.createdAt.localeCompare(left.exchange.createdAt))
    .forEach((candidate) => add(candidate.exchange));
  exchanges.forEach(add);

  const ordered = selected.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const fullBlocks = ordered.map((exchange) => exchangeBlock(exchange));
  const fullContext = `${directory}\n\n${fullBlocks.join("\n\n")}`;
  if (fullContext.length <= maxChars) return { context: fullContext, rowIds: ordered.flatMap((exchange) => exchange.rowIds) };

  const blocks: string[] = [];
  let remaining = maxChars - directory.length - 2;
  for (const [index, exchange] of ordered.entries()) {
    const separators = index ? 2 : 0;
    remaining -= separators;
    if (remaining <= 0) break;
    const remainingItems = ordered.length - index;
    const budget = Math.max(1, Math.floor(remaining / remainingItems));
    const block = exchangeBlock(exchange, budget);
    blocks.push(block);
    remaining -= block.length;
  }
  const context = `${directory}\n\n${blocks.join("\n\n")}`.slice(0, maxChars);
  return { context, rowIds: ordered.slice(0, blocks.length).flatMap((exchange) => exchange.rowIds) };
}

export async function rememberProjectExchangeWithClient(client: PoolClient, run: LiveRunRecord, input: ProjectExchangeInput) {
  if (!run.projectId) return 0;
  if (!run.tenantId) throw new Error("项目记忆写入缺少可信租户归属");
  const authority = await client.query(`
    SELECT 1
    FROM wb_runs owned_run
    JOIN wb_visitors visitor ON visitor.id = owned_run.visitor_id
    WHERE owned_run.id = $1
      AND owned_run.visitor_id = $2
      AND owned_run.thread_id = $3
      AND owned_run.project_id = $4
      AND visitor.tenant_id = $5
  `, [run.id, run.visitorId, run.threadId, run.projectId, run.tenantId]);
  if (!authority.rowCount) {
    await recordAuthorizationDeniedWithClient(client, {
      tenantId: run.tenantId,
      visitorId: run.visitorId,
      action: "memory.write",
      resourceKind: "memory",
      resourceId: run.id
    });
    return 0;
  }
  const entries = [
    { role: "user" as const, content: input.userMessage.trim() },
    { role: "assistant" as const, content: input.assistantMessage.trim() }
  ].filter((entry) => entry.content);
  for (const entry of entries) {
    const hash = createHash("sha256").update(`${entry.role}\0${entry.content}`, "utf8").digest("hex");
    await client.query(`
      INSERT INTO wb_project_memories (id, visitor_id, project_id, source_thread_id, source_thread_title, source_run_id, role, content, content_hash)
      SELECT $1, $2, $3, $4,
        COALESCE((SELECT title FROM wb_threads WHERE id = $4 AND visitor_id = $2), '会话'),
        $5, $6, $7, $8
      ON CONFLICT (source_run_id, role)
      DO UPDATE SET source_thread_title = EXCLUDED.source_thread_title, content = EXCLUDED.content, content_hash = EXCLUDED.content_hash, last_accessed_at = now(), archived_at = NULL
    `, [liveId("memory"), run.visitorId, run.projectId, run.threadId, run.id, entry.role, entry.content, hash]);
  }
  return entries.length;
}

export async function rememberProjectExchange(run: LiveRunRecord, input: ProjectExchangeInput) {
  if (!run.projectId) return 0;
  return transaction((client) => rememberProjectExchangeWithClient(client, run, input));
}

export async function prepareLiveRun(input: {
  visitorId: string;
  tenantId: string;
  threadId: string;
  message: string;
  modelId: string;
  agentId?: "chat" | "search-agent";
  reasoningEffort?: "medium" | "high" | "xhigh" | "max";
  attachmentIds: string[];
  replaceMessageId?: string | null;
  memoryRecallItems: number;
  memoryMaxChars: number;
}): Promise<PreparedRun | null> {
  const result = await transaction(async (client) => {
    const threadResult = await client.query<ThreadRow>(`
      SELECT id, project_id, title, status, updated_at, last_user_message_at
      FROM wb_threads WHERE id = $1 AND visitor_id = $2 FOR UPDATE
    `, [input.threadId, input.visitorId]);
    const thread = threadResult.rows[0];
    if (!thread) {
      await recordAuthorizationDenialsWithClient(client, [
        {
          tenantId: input.tenantId,
          visitorId: input.visitorId,
          action: "run.start",
          resourceKind: "thread",
          resourceId: input.threadId
        },
        {
          tenantId: input.tenantId,
          visitorId: input.visitorId,
          action: "memory.read",
          resourceKind: "memory",
          resourceId: memoryAuthorizationScope("thread", input.threadId)
        }
      ]);
      return null;
    }
    if (thread.status === "running" || thread.status === "waiting") return null;

    const eventResult = await client.query<EventRow>(`
      SELECT id, seq, project_id, thread_id, run_id, created_at, event_type, payload
      FROM wb_agent_events
      WHERE visitor_id = $1 AND thread_id = $2 AND archived_at IS NULL
      ORDER BY seq
    `, [input.visitorId, input.threadId]);
    const messages = completedMessages(eventResult.rows);
    let selected = messages;
    let replaceCreatedAt: Date | string | null = null;
    if (input.replaceMessageId) {
      const replaceIndex = messages.findIndex((message) => message.id === input.replaceMessageId && message.role === "user");
      if (replaceIndex < 0) return null;
      selected = messages.slice(0, replaceIndex);
      const targetRunId = messages[replaceIndex].runId;
      const targetRun = await client.query<{ created_at: Date | string }>("SELECT created_at FROM wb_runs WHERE id = $1 AND visitor_id = $2", [targetRunId, input.visitorId]);
      if (!targetRun.rows[0]) return null;
      replaceCreatedAt = targetRun.rows[0].created_at;
    }

    const requestedAttachmentIds = [...new Set(input.attachmentIds)];
    const attachmentResult = requestedAttachmentIds.length ? await client.query<AttachmentRow>(`
      SELECT id, name, mime_type, size_bytes, kind, bytes
      FROM wb_attachments
      WHERE visitor_id = $1 AND thread_id = $2 AND id = ANY($3::text[])
      ORDER BY created_at
    `, [input.visitorId, input.threadId, requestedAttachmentIds]) : { rows: [] as AttachmentRow[] };
    if (attachmentResult.rows.length !== requestedAttachmentIds.length) {
      const returned = new Set(attachmentResult.rows.map((attachment) => attachment.id));
      await recordAuthorizationDeniedWithClient(client, {
        tenantId: input.tenantId,
        visitorId: input.visitorId,
        action: "attachment.use",
        resourceKind: "attachment",
        resourceId: requestedAttachmentIds.find((id) => !returned.has(id)) ?? null
      });
      return null;
    }

    const run: LiveRunRecord = {
      id: liveId("run"),
      visitorId: input.visitorId,
      tenantId: input.tenantId,
      threadId: input.threadId,
      projectId: thread.project_id,
      modelId: input.modelId,
      agentId: input.agentId || "chat"
    };
    const decision = await checkRunAdmissionWithClient(client, {
      tenantId: input.tenantId,
      visitorId: input.visitorId,
      resourceId: run.id
    });
    if (!decision.allowed) return { kind: "quota" as const, decision };

    if (replaceCreatedAt !== null) {
      await client.query(`
        UPDATE wb_agent_events SET archived_at = now()
        WHERE visitor_id = $1 AND thread_id = $2 AND archived_at IS NULL AND run_id IN (
          SELECT id FROM wb_runs WHERE visitor_id = $1 AND thread_id = $2 AND archived_at IS NULL AND created_at >= $3
        )
      `, [input.visitorId, input.threadId, replaceCreatedAt]);
      await client.query(`
        UPDATE wb_project_memories SET archived_at = now()
        WHERE visitor_id = $1 AND source_thread_id = $2 AND archived_at IS NULL AND source_run_id IN (
          SELECT id FROM wb_runs WHERE visitor_id = $1 AND thread_id = $2 AND archived_at IS NULL AND created_at >= $3
        )
      `, [input.visitorId, input.threadId, replaceCreatedAt]);
      await client.query(`
        UPDATE wb_runs SET archived_at = now()
        WHERE visitor_id = $1 AND thread_id = $2 AND archived_at IS NULL AND created_at >= $3
      `, [input.visitorId, input.threadId, replaceCreatedAt]);
    }

    const limited = selected.slice(-40);
    while (limited.length > 1 && limited.reduce((sum, message) => sum + message.content.length, 0) > 80_000) limited.shift();
    const history = limited.map(({ role, content }) => ({ role, content }));
    const projectMemoryContext = await recallProjectMemory(client, {
      visitorId: input.visitorId,
      projectId: thread.project_id,
      query: input.message,
      excludedRunIds: [...new Set(limited.map((message) => message.runId))],
      recallItems: input.memoryRecallItems,
      maxChars: input.memoryMaxChars
    });

    const { attachmentContext, imageInputs } = prepareRunAttachments(attachmentResult.rows);

    const executionInput: DurableSearchRunInput = {
      version: 1,
      message: input.message,
      history,
      attachmentIds: attachmentResult.rows.map((attachment) => attachment.id),
      projectMemoryContext,
      reasoningEffort: input.reasoningEffort || "medium"
    };
    await client.query(`
      INSERT INTO wb_runs (id, visitor_id, thread_id, project_id, agent_id, model_id, status, execution_input, available_at)
      VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7::jsonb, now())
    `, [run.id, run.visitorId, run.threadId, run.projectId, run.agentId, run.modelId, JSON.stringify(executionInput)]);
    const isFirstMessage = !selected.some((message) => message.role === "user");
    await client.query(`
      UPDATE wb_threads
      SET status = 'running', last_user_message_at = now(), updated_at = now(),
          title = CASE WHEN $3 THEN $4 ELSE title END
      WHERE id = $1 AND visitor_id = $2
    `, [run.threadId, run.visitorId, isFirstMessage, input.message.slice(0, 40) || "新会话"]);

    const attachments = attachmentResult.rows.map(attachmentSummary);
    const userMessageId = input.replaceMessageId || liveId("msg");
    await insertEventWithClient(client, run, "run.created", { agentId: run.agentId, modelId: run.modelId, reasoningEffort: input.reasoningEffort || "medium" });
    await insertEventWithClient(client, run, "message.started", { messageId: userMessageId, role: "user", text: input.message, attachments });
    await insertEventWithClient(client, run, "message.completed", { messageId: userMessageId, text: input.message, attachments });
    await recordRunLifecycleWithClient(client, {
      runId: run.id,
      tenantId: input.tenantId,
      visitorId: input.visitorId,
      status: "queued",
      payload: {}
    });
    return {
      kind: "prepared" as const,
      value: { run, history, attachmentContext, imageInputs, projectMemoryContext, userMessageId }
    };
  });
  if (!result) return null;
  if (result.kind === "quota") {
    throw new QuotaExceededError(result.decision.reasonCode, result.decision.limit, result.decision.observed);
  }
  return result.value;
}

type LiveRunCompletion = {
  events: Array<{ type: AgentEventType; payload: Record<string, unknown> }>;
  memory?: ProjectExchangeInput;
};

function leaseMilliseconds(value: number) {
  if (!Number.isInteger(value) || value < 1 || value > 86_400_000) {
    throw new Error("Worker lease 必须是 1 到 86400000 之间的整数毫秒");
  }
  return value;
}

function leaseOwner(value: string) {
  const owner = value.trim();
  if (!owner || owner.length > 240) throw new Error("Worker owner 必须是 1 到 240 字符");
  return owner;
}

function checkpointReference(row: {
  checkpoint_id: string | null;
  checkpoint_session_id: string | null;
  checkpoint_ns: string | null;
  checkpoint_step: string | number | null;
}): LiveCheckpointReference | null {
  const fields = [
    row.checkpoint_id,
    row.checkpoint_session_id,
    row.checkpoint_ns,
    row.checkpoint_step
  ];
  if (fields.every((value) => value === null)) return null;
  const step = Number(row.checkpoint_step);
  if (
    fields.some((value) => value === null)
    || typeof row.checkpoint_id !== "string"
    || !/^[A-Za-z0-9_-]{1,128}$/u.test(row.checkpoint_id)
    || typeof row.checkpoint_session_id !== "string"
    || !/^[A-Za-z0-9_-]{1,128}$/u.test(row.checkpoint_session_id)
    || typeof row.checkpoint_ns !== "string"
    || row.checkpoint_ns.length > 256
    || /[\r\n\u0000]/u.test(row.checkpoint_ns)
    || !Number.isSafeInteger(step)
    || step < -1
  ) {
    throw new Error("Run checkpoint 权威引用无效");
  }
  return {
    id: row.checkpoint_id,
    namespace: row.checkpoint_ns,
    sessionId: row.checkpoint_session_id,
    step
  };
}

export async function claimNextLiveRun(ownerInput: string, leaseMsInput: number): Promise<ClaimedLiveRun | null> {
  const owner = leaseOwner(ownerInput);
  const leaseMs = leaseMilliseconds(leaseMsInput);
  const claimed = await transaction<{ row: ClaimRow | null; terminalSettled: boolean }>(async (client) => {
    const result = await client.query<ClaimRow>(`
      WITH candidate AS (
        SELECT id
        FROM wb_runs
        WHERE archived_at IS NULL
          AND agent_id = 'search-agent'
          AND available_at <= now()
          AND (
            status = 'queued'
            OR (
              status IN ('running', 'waiting')
              AND (lease_expires_at IS NULL OR lease_expires_at <= now())
            )
          )
        ORDER BY available_at, created_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE wb_runs run
      SET status = 'running',
          lease_owner = $1,
          lease_epoch = run.lease_epoch + 1,
          lease_expires_at = now() + ($2::int * interval '1 millisecond'),
          heartbeat_at = now(),
          worker_attempt = run.worker_attempt + 1,
          started_at = COALESCE(run.started_at, now())
      FROM candidate
      WHERE run.id = candidate.id
      RETURNING run.id, run.visitor_id, run.thread_id, run.project_id, run.model_id,
        run.agent_id, run.execution_input, run.lease_epoch, run.lease_expires_at, run.worker_attempt,
        run.stop_requested_at, run.checkpoint_id, run.checkpoint_session_id, run.checkpoint_ns, run.checkpoint_step,
        (SELECT tenant_id FROM wb_visitors WHERE id = run.visitor_id) AS tenant_id
    `, [owner, leaseMs]);
    const candidate = result.rows[0] ?? null;
    if (!candidate || !candidate.tenant_id) return { row: candidate, terminalSettled: false };
    const candidateRun: LiveRunRecord = {
      id: candidate.id,
      visitorId: candidate.visitor_id,
      threadId: candidate.thread_id,
      projectId: candidate.project_id,
      modelId: candidate.model_id,
      agentId: candidate.agent_id,
      tenantId: candidate.tenant_id
    };
    const candidateEpoch = Number(candidate.lease_epoch);
    if (!Number.isSafeInteger(candidateEpoch) || candidateEpoch < 1) {
      throw new Error("Worker lease epoch 无效");
    }
    const consumed = await consumePendingTerminalSettlementWithClient(client, candidateRun, {
      kind: "claimed",
      claim: { run: candidateRun, lease: { owner, epoch: candidateEpoch } }
    });
    if (consumed.kind === "settled" || consumed.kind === "duplicate") {
      return { row: null, terminalSettled: true };
    }
    if (consumed.kind === "blocked") {
      throw new TerminalSettlementConflictError("新 Worker 无法消费待结算终态");
    }
    return { row: candidate, terminalSettled: false };
  });
  if (claimed.terminalSettled) return null;
  const row = claimed.row;
  if (!row) return null;

  const epoch = Number(row.lease_epoch);
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error("Worker lease epoch 无效");
  const identity: ClaimedRunIdentity = {
    run: {
      id: row.id,
      visitorId: row.visitor_id,
      threadId: row.thread_id,
      projectId: row.project_id,
      modelId: row.model_id,
      agentId: row.agent_id,
      tenantId: row.tenant_id ?? undefined
    },
    lease: { owner, epoch }
  };
  // Fail closed: a run whose owning visitor no longer resolves to a tenant must
  // not execute under a fallback tenant, or it would run against another
  // tenant's scoped memory and quota.
  if (!row.tenant_id) {
    await finalizeClaimedLiveRun(identity, "failed", {
      message: "运行归属租户不可解析，请重新发送",
      reasonCode: "RUN_TENANT_UNRESOLVED"
    });
    return null;
  }
  if (row.stop_requested_at) {
    await finalizeClaimedLiveRun(identity, "stopped", createUserStoppedPayload());
    return null;
  }
  const parsed = durableSearchRunInputSchema.safeParse(row.execution_input);
  if (!parsed.success) {
    await finalizeClaimedLiveRun(identity, "failed", {
      message: "运行输入不可恢复，请重新发送",
      reasonCode: "RUN_INPUT_INVALID"
    });
    return null;
  }

  const attachmentResult = parsed.data.attachmentIds.length ? await query<AttachmentRow>(`
    SELECT id, name, mime_type, size_bytes, kind, bytes
    FROM wb_attachments
    WHERE visitor_id = $1 AND thread_id = $2 AND id = ANY($3::text[])
    ORDER BY array_position($3::text[], id)
  `, [row.visitor_id, row.thread_id, parsed.data.attachmentIds]) : { rows: [] as AttachmentRow[] };
  const attachments = prepareRunAttachments(attachmentResult.rows);
  const checkpoint = checkpointReference(row);
  const resume = checkpoint !== null;
  return {
    ...identity,
    input: {
      message: parsed.data.message,
      history: parsed.data.history,
      attachmentContext: attachments.attachmentContext,
      imageInputs: attachments.imageInputs,
      projectMemoryContext: parsed.data.projectMemoryContext,
      reasoningEffort: parsed.data.reasoningEffort,
      resume
    },
    resume,
    checkpoint,
    attempt: row.worker_attempt,
    leaseExpiresAt: iso(row.lease_expires_at)
  };
}

export async function readClaimedLiveCheckpoint(claim: ClaimedRunIdentity): Promise<{
  valid: boolean;
  checkpoint: LiveCheckpointReference | null;
}> {
  const result = await query<{
    checkpoint_id: string | null;
    checkpoint_session_id: string | null;
    checkpoint_ns: string | null;
    checkpoint_step: string | number | null;
  }>(`
    SELECT checkpoint_id, checkpoint_session_id, checkpoint_ns, checkpoint_step
    FROM wb_runs
    WHERE id = $1 AND lease_owner = $2 AND lease_epoch = $3
      AND archived_at IS NULL
      AND status IN ('running', 'waiting')
      AND lease_expires_at > now()
  `, [claim.run.id, claim.lease.owner, claim.lease.epoch]);
  const row = result.rows[0];
  if (!row) return { valid: false, checkpoint: null };
  return { valid: true, checkpoint: checkpointReference(row) };
}

export async function renewLiveRunLease(claim: ClaimedRunIdentity, leaseMsInput: number) {
  const leaseMs = leaseMilliseconds(leaseMsInput);
  const result = await query<{ stop_requested: boolean }>(`
    UPDATE wb_runs
    SET lease_expires_at = now() + ($4::int * interval '1 millisecond'), heartbeat_at = now()
    WHERE id = $1 AND lease_owner = $2 AND lease_epoch = $3
      AND archived_at IS NULL
      AND status IN ('running', 'waiting')
      AND lease_expires_at > now()
    RETURNING stop_requested_at IS NOT NULL AS stop_requested
  `, [claim.run.id, claim.lease.owner, claim.lease.epoch, leaseMs]);
  return {
    renewed: result.rowCount === 1,
    stopRequested: result.rows[0]?.stop_requested === true
  };
}

export async function releaseLiveRunLease(claim: ClaimedRunIdentity) {
  const result = await query(`
    UPDATE wb_runs
    SET status = 'queued', available_at = now(), lease_owner = NULL, lease_expires_at = NULL
    WHERE id = $1 AND lease_owner = $2 AND lease_epoch = $3
      AND archived_at IS NULL
      AND status IN ('running', 'waiting')
      AND lease_expires_at > now()
  `, [claim.run.id, claim.lease.owner, claim.lease.epoch]);
  return result.rowCount === 1;
}

async function lockClaimedLiveRun(client: PoolClient, claim: ClaimedRunIdentity) {
  const result = await client.query(`
    SELECT 1
    FROM wb_runs
    WHERE id = $1 AND lease_owner = $2 AND lease_epoch = $3
      AND archived_at IS NULL
      AND status IN ('running', 'waiting')
      AND lease_expires_at > now()
    FOR UPDATE
  `, [claim.run.id, claim.lease.owner, claim.lease.epoch]);
  return result.rowCount === 1;
}

export async function persistClaimedLiveEvent(claim: ClaimedRunIdentity, type: AgentEventType, payload: Record<string, unknown>) {
  return transaction(async (client) => {
    if (!await lockClaimedLiveRun(client, claim)) return null;
    return insertEventWithClient(client, claim.run, type, payload);
  });
}

async function appendLiveRunFinalization(
  client: PoolClient,
  run: LiveRunRecord,
  status: "completed" | "failed" | "stopped",
  payload: Record<string, unknown>,
  completion?: LiveRunCompletion
) {
  await client.query(
    "UPDATE wb_threads SET status = $3, updated_at = now() WHERE id = $1 AND visitor_id = $2",
    [run.threadId, run.visitorId, status === "completed" || status === "stopped" ? "idle" : "failed"]
  );
  if (completion?.memory) await rememberProjectExchangeWithClient(client, run, completion.memory);
  const events: AgentEvent[] = [];
  for (const event of completion?.events ?? []) {
    events.push(await insertEventWithClient(client, run, event.type, event.payload));
  }
  const eventType: AgentEventType = status === "completed" ? "run.completed" : status === "stopped" ? "run.cancelled" : "run.failed";
  events.push(await insertEventWithClient(client, run, eventType, payload));
  return events;
}

async function recordTerminalLifecycleWithClient(
  client: PoolClient,
  run: LiveRunRecord,
  status: "completed" | "failed" | "stopped",
  payload: Record<string, unknown>
) {
  // The only tenant-less terminal is the fail-closed repair of an orphaned
  // visitor row. Every authorized enqueue/read path carries the stored tenant;
  // silently skipping any other case would reintroduce unbilled completions.
  if (!run.tenantId) {
    if (payload.reasonCode === "RUN_TENANT_UNRESOLVED") return;
    throw new Error("Run 终态缺少可信租户归属");
  }
  await recordRunLifecycleWithClient(client, {
    tenantId: run.tenantId,
    runId: run.id,
    visitorId: run.visitorId,
    status,
    payload
  });
}

export async function finalizeClaimedLiveRun(
  claim: ClaimedRunIdentity,
  status: "completed" | "failed" | "stopped",
  payload: Record<string, unknown>,
  completion?: LiveRunCompletion
) {
  return transaction(async (client) => {
    const pending = await consumePendingTerminalSettlementWithClient(client, claim.run, { kind: "claimed", claim });
    if (pending.kind === "settled" || pending.kind === "duplicate") return pending.events;
    if (pending.kind === "blocked") return null;
    const transitioned = await client.query(`
      UPDATE wb_runs
      SET status = $4, completed_at = now(), lease_owner = NULL, lease_expires_at = NULL
      WHERE id = $1 AND lease_owner = $2 AND lease_epoch = $3
        AND archived_at IS NULL
        AND status IN ('running', 'waiting')
        AND lease_expires_at > now()
        AND (stop_requested_at IS NULL OR $4::text = 'stopped')
      RETURNING id
    `, [claim.run.id, claim.lease.owner, claim.lease.epoch, status]);
    if (!transitioned.rowCount) return null;
    // Bill inside the terminal transaction: a committed completion always has
    // its usage row, and a rolled-back one never leaves a phantom charge.
    await recordTerminalLifecycleWithClient(client, claim.run, status, payload);
    return appendLiveRunFinalization(client, claim.run, status, payload, completion);
  });
}

export async function finalizeLiveRun(
  run: LiveRunRecord,
  status: "completed" | "failed" | "stopped",
  payload: Record<string, unknown>,
  completion?: LiveRunCompletion
) {
  return transaction(async (client) => {
    const pending = await consumePendingTerminalSettlementWithClient(client, run, {
      kind: "unleased",
      owner: "system:terminal-fallback"
    });
    if (pending.kind === "settled" || pending.kind === "duplicate") return pending.events;
    if (pending.kind === "blocked") return null;
    const transitioned = await client.query(`
      UPDATE wb_runs
      SET status = $3, completed_at = now(), lease_owner = NULL, lease_expires_at = NULL
      WHERE id = $1 AND visitor_id = $2
        AND archived_at IS NULL
        AND status IN ('queued', 'running', 'waiting')
        AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= now())
        AND (stop_requested_at IS NULL OR $3::text = 'stopped')
      RETURNING id
    `, [run.id, run.visitorId, status]);
    // User stop, provider completion and provider failure race for one durable terminal event.
    if (!transitioned.rowCount) return null;
    await recordTerminalLifecycleWithClient(client, run, status, payload);
    return appendLiveRunFinalization(client, run, status, payload, completion);
  });
}

export async function deleteExpiredLiveThreads(threadTtlDays: number) {
  const result = await query<{ id: string }>(`
    DELETE FROM wb_threads
    WHERE updated_at < now() - ($1::int * interval '1 day')
      AND status NOT IN ('running', 'waiting')
    RETURNING id
  `, [threadTtlDays]);
  return result.rowCount ?? 0;
}

export async function activeEventsForRun(visitorId: string, runId: string, after: number) {
  const result = await query<EventRow>(`
    SELECT e.id, e.seq, e.project_id, e.thread_id, e.run_id, e.created_at, e.event_type, e.payload
    FROM wb_agent_events e
    JOIN wb_runs r ON r.id = e.run_id AND r.visitor_id = e.visitor_id
    WHERE e.visitor_id = $1 AND e.run_id = $2 AND e.archived_at IS NULL AND e.seq > $3
    ORDER BY e.seq
  `, [visitorId, runId, after]);
  return result.rows.map(agentEvent);
}

export async function liveRun(visitorId: string, runId: string) {
  const result = await query<{ id: string; thread_id: string; project_id: string | null; model_id: string; agent_id: string; status: LiveRunStatus; tenant_id: string }>(`
    SELECT run.id, run.thread_id, run.project_id, run.model_id, run.agent_id, run.status, visitor.tenant_id
    FROM wb_runs run
    JOIN wb_visitors visitor ON visitor.id = run.visitor_id
    WHERE run.id = $1 AND run.visitor_id = $2 AND run.archived_at IS NULL
  `, [runId, visitorId]);
  const row = result.rows[0];
  return row ? { run: { id: row.id, visitorId, tenantId: row.tenant_id, threadId: row.thread_id, projectId: row.project_id, modelId: row.model_id, agentId: row.agent_id } satisfies LiveRunRecord, status: row.status } : null;
}

export async function requestLiveRunStop(visitorId: string, runId: string) {
  return transaction(async (client) => {
    const result = await client.query<{
      id: string;
      thread_id: string;
      project_id: string | null;
      model_id: string;
      agent_id: string;
      status: LiveRunStatus;
      tenant_id: string;
      lease_owner: string | null;
      lease_valid: boolean | null;
    }>(`
      SELECT run.id, run.thread_id, run.project_id, run.model_id, run.agent_id,
        run.status, visitor.tenant_id, run.lease_owner,
        run.lease_expires_at > now() AS lease_valid
      FROM wb_runs run
      JOIN wb_visitors visitor ON visitor.id = run.visitor_id
      WHERE run.id = $1 AND run.visitor_id = $2 AND run.archived_at IS NULL
      FOR UPDATE OF run
    `, [runId, visitorId]);
    const row = result.rows[0];
    if (!row) return null;
    if (!["completed", "failed", "stopped"].includes(row.status)) {
      await client.query(
        "UPDATE wb_runs SET stop_requested_at = COALESCE(stop_requested_at, now()) WHERE id = $1 AND visitor_id = $2",
        [runId, visitorId]
      );
    }
    return {
      run: {
        id: row.id,
        visitorId,
        tenantId: row.tenant_id,
        threadId: row.thread_id,
        projectId: row.project_id,
        modelId: row.model_id,
        agentId: row.agent_id
      } satisfies LiveRunRecord,
      status: row.status,
      hasActiveLease: row.lease_owner !== null && row.lease_valid === true
    };
  });
}

export async function uploadLiveAttachments(visitorId: string, threadId: string, files: File[]) {
  return transaction(async (client) => {
    const owner = await client.query("SELECT 1 FROM wb_threads WHERE id = $1 AND visitor_id = $2", [threadId, visitorId]);
    if (!owner.rowCount) return null;
    const uploaded: MessageAttachment[] = [];
    for (const file of files) {
      const id = liveId("att");
      const kind = file.type.startsWith("image/") ? "image" : "document";
      const bytes = Buffer.from(await file.arrayBuffer());
      if (kind === "image") {
        // 上传时校验 MIME、魔数、尺寸与像素，运行时还会再次 fail-closed 校验。
        prepareImageInput({ id, mimeType: file.type, sizeBytes: file.size, bytes });
      }
      await client.query(`
        INSERT INTO wb_attachments (id, visitor_id, thread_id, name, mime_type, size_bytes, kind, bytes)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [id, visitorId, threadId, file.name, file.type || "application/octet-stream", file.size, kind, bytes]);
      uploaded.push({ id, name: file.name, mimeType: file.type || "application/octet-stream", sizeBytes: file.size, kind, url: `/api/v1/attachments/${id}` });
    }
    return uploaded;
  });
}

export async function liveAttachment(visitorId: string, attachmentId: string) {
  const result = await query<AttachmentRow>(`
    SELECT id, name, mime_type, size_bytes, kind, bytes
    FROM wb_attachments WHERE id = $1 AND visitor_id = $2
  `, [attachmentId, visitorId]);
  return result.rows[0] ?? null;
}
