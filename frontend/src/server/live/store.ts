import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { createEmptyThreadState, reduceAgentEvents } from "@/lib/agent-events/reducer";
import type { AgentEvent, AgentEventType, AgentThreadState, MessageAttachment, ProjectSummary, ThreadSnapshot, ThreadSummary } from "@/lib/agent-events/types";
import { query, transaction } from "@/server/persistence/database";
import type { DeepSeekChatMessage } from "@/server/llm/deepseek-client";

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
};

export type LiveRunStatus = "queued" | "running" | "waiting" | "completed" | "failed" | "stopped";

type ProjectExchangeInput = {
  userMessage: string;
  assistantMessage: string;
};

export type PreparedRun = {
  run: LiveRunRecord;
  history: DeepSeekChatMessage[];
  attachmentContext: string;
  projectMemoryContext: string;
  userMessageId: string;
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

export async function reorderLiveProjects(visitorId: string, projectIds: string[]) {
  return transaction(async (client) => {
    const owned = await client.query<{ id: string }>("SELECT id FROM wb_projects WHERE visitor_id = $1 FOR UPDATE", [visitorId]);
    const ownedIds = new Set(owned.rows.map((row) => row.id));
    if (projectIds.length !== ownedIds.size || projectIds.some((id) => !ownedIds.has(id))) return false;
    for (let index = 0; index < projectIds.length; index += 1) {
      await client.query("UPDATE wb_projects SET sort_order = $3, updated_at = now() WHERE id = $1 AND visitor_id = $2", [projectIds[index], visitorId, index]);
    }
    return true;
  });
}

export async function deleteLiveProject(visitorId: string, projectId: string) {
  const result = await query("DELETE FROM wb_projects WHERE id = $1 AND visitor_id = $2", [projectId, visitorId]);
  return result.rowCount === 1;
}

export async function listLiveThreads(visitorId: string, projectId?: string) {
  const values: unknown[] = [visitorId];
  const projectClause = projectId === undefined ? "" : " AND project_id = $2";
  if (projectId !== undefined) values.push(projectId);
  const result = await query<ThreadRow>(`
    SELECT id, project_id, title, status, updated_at, last_user_message_at
    FROM wb_threads
    WHERE visitor_id = $1${projectClause}
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

export async function updateLiveThread(visitorId: string, threadId: string, patch: { title?: string; projectId?: string | null }) {
  return transaction(async (client) => {
    if (patch.projectId) {
      const project = await client.query("SELECT 1 FROM wb_projects WHERE id = $1 AND visitor_id = $2", [patch.projectId, visitorId]);
      if (!project.rowCount) return null;
    }
    const result = await client.query<ThreadRow>(`
      UPDATE wb_threads
      SET title = COALESCE($3, title),
          project_id = CASE WHEN $4::boolean THEN $5::text ELSE project_id END,
          updated_at = now()
      WHERE id = $1 AND visitor_id = $2
      RETURNING id, project_id, title, status, updated_at, last_user_message_at
    `, [threadId, visitorId, patch.title ?? null, Object.prototype.hasOwnProperty.call(patch, "projectId"), patch.projectId ?? null]);
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
    return result.rows[0] ? threadSummary(result.rows[0]) : null;
  });
}

export async function deleteLiveThread(visitorId: string, threadId: string) {
  return transaction(async (client) => {
    await client.query("DELETE FROM wb_project_memories WHERE source_thread_id = $1 AND visitor_id = $2", [threadId, visitorId]);
    const result = await client.query("DELETE FROM wb_threads WHERE id = $1 AND visitor_id = $2", [threadId, visitorId]);
    return result.rowCount === 1;
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
    query<{ id: string; status: "running" | "waiting" }>(`
      SELECT id, status FROM wb_runs
      WHERE visitor_id = $1 AND thread_id = $2 AND archived_at IS NULL AND status IN ('running', 'waiting')
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
  const completed: Array<DeepSeekChatMessage & { id: string; runId: string }> = [];
  const drafts = new Map<string, DeepSeekChatMessage & { id: string; runId: string }>();
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

async function insertEventWithClient(client: PoolClient, run: LiveRunRecord, type: AgentEventType, payload: Record<string, unknown>) {
  const id = liveId("evt");
  const result = await client.query<EventRow>(`
    INSERT INTO wb_agent_events (id, visitor_id, run_id, project_id, thread_id, event_type, payload)
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
    RETURNING id, seq, project_id, thread_id, run_id, created_at, event_type, payload
  `, [id, run.visitorId, run.id, run.projectId, run.threadId, type, JSON.stringify(payload)]);
  return agentEvent(result.rows[0]);
}

export async function persistLiveEvent(run: LiveRunRecord, type: AgentEventType, payload: Record<string, unknown>) {
  return transaction((client) => insertEventWithClient(client, run, type, payload));
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

async function rememberProjectExchangeWithClient(client: PoolClient, run: LiveRunRecord, input: ProjectExchangeInput) {
  if (!run.projectId) return 0;
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
  threadId: string;
  message: string;
  modelId: string;
  attachmentIds: string[];
  replaceMessageId?: string | null;
  memoryRecallItems: number;
  memoryMaxChars: number;
}): Promise<PreparedRun | null> {
  return transaction(async (client) => {
    const threadResult = await client.query<ThreadRow>(`
      SELECT id, project_id, title, status, updated_at, last_user_message_at
      FROM wb_threads WHERE id = $1 AND visitor_id = $2 FOR UPDATE
    `, [input.threadId, input.visitorId]);
    const thread = threadResult.rows[0];
    if (!thread || thread.status === "running" || thread.status === "waiting") return null;

    const eventResult = await client.query<EventRow>(`
      SELECT id, seq, project_id, thread_id, run_id, created_at, event_type, payload
      FROM wb_agent_events
      WHERE visitor_id = $1 AND thread_id = $2 AND archived_at IS NULL
      ORDER BY seq
    `, [input.visitorId, input.threadId]);
    const messages = completedMessages(eventResult.rows);
    let selected = messages;
    if (input.replaceMessageId) {
      const replaceIndex = messages.findIndex((message) => message.id === input.replaceMessageId && message.role === "user");
      if (replaceIndex < 0) return null;
      selected = messages.slice(0, replaceIndex);
      const targetRunId = messages[replaceIndex].runId;
      const targetRun = await client.query<{ created_at: Date | string }>("SELECT created_at FROM wb_runs WHERE id = $1 AND visitor_id = $2", [targetRunId, input.visitorId]);
      if (!targetRun.rows[0]) return null;
      await client.query(`
        UPDATE wb_agent_events SET archived_at = now()
        WHERE visitor_id = $1 AND thread_id = $2 AND archived_at IS NULL AND run_id IN (
          SELECT id FROM wb_runs WHERE visitor_id = $1 AND thread_id = $2 AND archived_at IS NULL AND created_at >= $3
        )
      `, [input.visitorId, input.threadId, targetRun.rows[0].created_at]);
      await client.query(`
        UPDATE wb_project_memories SET archived_at = now()
        WHERE visitor_id = $1 AND source_thread_id = $2 AND archived_at IS NULL AND source_run_id IN (
          SELECT id FROM wb_runs WHERE visitor_id = $1 AND thread_id = $2 AND archived_at IS NULL AND created_at >= $3
        )
      `, [input.visitorId, input.threadId, targetRun.rows[0].created_at]);
      await client.query(`
        UPDATE wb_runs SET archived_at = now()
        WHERE visitor_id = $1 AND thread_id = $2 AND archived_at IS NULL AND created_at >= $3
      `, [input.visitorId, input.threadId, targetRun.rows[0].created_at]);
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

    const attachmentResult = input.attachmentIds.length ? await client.query<AttachmentRow>(`
      SELECT id, name, mime_type, size_bytes, kind, bytes
      FROM wb_attachments
      WHERE visitor_id = $1 AND thread_id = $2 AND id = ANY($3::text[])
      ORDER BY created_at
    `, [input.visitorId, input.threadId, input.attachmentIds]) : { rows: [] as AttachmentRow[] };
    const sections: string[] = [];
    for (const attachment of attachmentResult.rows) {
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

    const run: LiveRunRecord = {
      id: liveId("run"),
      visitorId: input.visitorId,
      threadId: input.threadId,
      projectId: thread.project_id,
      modelId: input.modelId
    };
    await client.query(`
      INSERT INTO wb_runs (id, visitor_id, thread_id, project_id, agent_id, model_id, status)
      VALUES ($1, $2, $3, $4, 'chat', $5, 'running')
    `, [run.id, run.visitorId, run.threadId, run.projectId, run.modelId]);
    const isFirstMessage = !selected.some((message) => message.role === "user");
    await client.query(`
      UPDATE wb_threads
      SET status = 'running', last_user_message_at = now(), updated_at = now(),
          title = CASE WHEN $3 THEN $4 ELSE title END
      WHERE id = $1 AND visitor_id = $2
    `, [run.threadId, run.visitorId, isFirstMessage, input.message.slice(0, 40) || "新会话"]);

    const attachments = attachmentResult.rows.map(attachmentSummary);
    const userMessageId = input.replaceMessageId || liveId("msg");
    await insertEventWithClient(client, run, "run.created", { agentId: "chat", modelId: run.modelId });
    await insertEventWithClient(client, run, "message.started", { messageId: userMessageId, role: "user", text: input.message, attachments });
    await insertEventWithClient(client, run, "message.completed", { messageId: userMessageId, text: input.message, attachments });
    return { run, history, attachmentContext: sections.join("\n\n"), projectMemoryContext, userMessageId };
  });
}

export async function finalizeLiveRun(
  run: LiveRunRecord,
  status: "completed" | "failed" | "stopped",
  payload: Record<string, unknown>,
  completion?: {
    events: Array<{ type: AgentEventType; payload: Record<string, unknown> }>;
    memory?: ProjectExchangeInput;
  }
) {
  return transaction(async (client) => {
    const transitioned = await client.query(`
      UPDATE wb_runs
      SET status = $3, completed_at = now()
      WHERE id = $1 AND visitor_id = $2
        AND archived_at IS NULL
        AND status IN ('queued', 'running', 'waiting')
      RETURNING id
    `, [run.id, run.visitorId, status]);
    // Stop, provider completion and provider failure can race. The first
    // terminal transition owns the durable terminal event; late contenders do
    // nothing and can never overwrite the winning status.
    if (!transitioned.rowCount) return null;
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
  });
}

export async function recoverInterruptedLiveRuns() {
  return transaction(async (client) => {
    const interrupted = await client.query<{ id: string; visitor_id: string; thread_id: string; project_id: string | null; model_id: string }>(`
      SELECT id, visitor_id, thread_id, project_id, model_id
      FROM wb_runs
      WHERE archived_at IS NULL AND status IN ('queued', 'running', 'waiting')
      FOR UPDATE
    `);
    for (const row of interrupted.rows) {
      const run: LiveRunRecord = { id: row.id, visitorId: row.visitor_id, threadId: row.thread_id, projectId: row.project_id, modelId: row.model_id };
      await client.query("UPDATE wb_runs SET status = 'failed', completed_at = now() WHERE id = $1", [run.id]);
      await client.query("UPDATE wb_threads SET status = 'failed', updated_at = now() WHERE id = $1 AND visitor_id = $2", [run.threadId, run.visitorId]);
      await insertEventWithClient(client, run, "run.failed", { message: "服务重启导致上次生成中断，请重新发送" });
    }
    return interrupted.rowCount ?? 0;
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
  const result = await query<{ id: string; thread_id: string; project_id: string | null; model_id: string; status: LiveRunStatus }>(`
    SELECT id, thread_id, project_id, model_id, status
    FROM wb_runs WHERE id = $1 AND visitor_id = $2 AND archived_at IS NULL
  `, [runId, visitorId]);
  const row = result.rows[0];
  return row ? { run: { id: row.id, visitorId, threadId: row.thread_id, projectId: row.project_id, modelId: row.model_id } satisfies LiveRunRecord, status: row.status } : null;
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
