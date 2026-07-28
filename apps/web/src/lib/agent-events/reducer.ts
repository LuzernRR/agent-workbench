import type {
  AgentEvent,
  AgentThreadState,
  ApprovalItem,
  Artifact,
  LogEntry,
  MessageItem,
  MessageAttachment,
  PlanStep,
  StatusItem,
  ThinkingItem,
  ToolItem,
  ToolSource,
  WorkbenchFile
} from "./types";

export function createEmptyThreadState(projectId: string | null, threadId: string): AgentThreadState {
  return {
    projectId,
    threadId,
    activeRunId: null,
    runStatus: "idle",
    runStartedAt: null,
    items: {},
    itemOrder: [],
    artifacts: [],
    files: [],
    logs: [],
    plan: [],
    planUpdatedAt: null,
    runTimings: {},
    runStatuses: {},
    lastSeq: 0
  };
}

function appendItem(state: AgentThreadState, item: AgentThreadState["items"][string]) {
  return {
    items: { ...state.items, [item.id]: item },
    itemOrder: state.items[item.id] ? state.itemOrder : [...state.itemOrder, item.id]
  };
}

function upsertById<T extends { id: string }>(items: T[], next: T) {
  const index = items.findIndex((item) => item.id === next.id);
  if (index === -1) return [...items, next];
  return items.map((item, itemIndex) => (itemIndex === index ? next : item));
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function attachmentsValue(value: unknown): MessageAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const attachments = value.filter((item): item is MessageAttachment => {
    if (!item || typeof item !== "object") return false;
    const candidate = item as Partial<MessageAttachment>;
    return typeof candidate.id === "string" && typeof candidate.name === "string" && typeof candidate.mimeType === "string" && typeof candidate.url === "string" && typeof candidate.sizeBytes === "number" && (candidate.kind === "image" || candidate.kind === "document");
  });
  return attachments.length ? attachments : undefined;
}

function sourcesValue(value: unknown): ToolSource[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const sources = value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Partial<ToolSource>;
    if (typeof candidate.title !== "string" || typeof candidate.url !== "string" || typeof candidate.verified !== "boolean") return [];
    try {
      const url = new URL(candidate.url);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return [];
      return [{ title: candidate.title.trim().slice(0, 300) || "搜索来源", url: url.href, verified: candidate.verified }];
    } catch {
      return [];
    }
  });
  return sources.length ? sources : undefined;
}

function planValue(value: unknown): PlanStep[] | null {
  if (!Array.isArray(value)) return null;
  const steps: PlanStep[] = [];
  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== "object") return null;
    const candidate = item as Partial<PlanStep>;
    if (typeof candidate.title !== "string" || !candidate.title.trim() || !["todo", "in_progress", "done", "blocked"].includes(candidate.status || "")) return null;
    steps.push({
      id: typeof candidate.id === "string" && candidate.id ? candidate.id : String(index + 1),
      title: candidate.title.trim(),
      status: candidate.status as PlanStep["status"],
      notes: typeof candidate.notes === "string" && candidate.notes.trim() ? candidate.notes.trim() : undefined
    });
  }
  return steps;
}

function removeTimelineItem(state: AgentThreadState, id: string) {
  const items = { ...state.items };
  delete items[id];
  return { items, itemOrder: state.itemOrder.filter((itemId) => itemId !== id) };
}

function settleThinkingItems(state: AgentThreadState, runId: string, status: ThinkingItem["status"]) {
  const emptyIds = new Set(Object.values(state.items)
    .filter((item): item is ThinkingItem => item.kind === "thinking" && item.runId === runId && item.status === "streaming" && item.paragraphs.length === 0)
    .map((item) => item.id));
  return {
    items: Object.fromEntries(Object.entries(state.items)
      .filter(([id]) => !emptyIds.has(id))
      .map(([id, item]) => [
        id,
        item.kind === "thinking" && item.runId === runId && item.status === "streaming" ? { ...item, status } : item
      ])),
    itemOrder: state.itemOrder.filter((id) => !emptyIds.has(id))
  };
}

function settleRunningTools(state: AgentThreadState, runId: string) {
  return {
    items: Object.fromEntries(Object.entries(state.items).map(([id, item]) => [
      id,
      item.kind === "tool" && item.runId === runId && ["preparing", "running", "waiting"].includes(item.status)
        ? { ...item, status: "unknown" as const, summary: "工具结果状态未知", error: item.error || "OUTCOME_UNKNOWN" }
        : item
    ]))
  };
}

function settleRunItems(state: AgentThreadState, runId: string, thinkingStatus: ThinkingItem["status"]) {
  const thinking = { ...state, ...settleThinkingItems(state, runId, thinkingStatus) };
  return { ...thinking, ...settleRunningTools(thinking, runId) };
}

export function reduceAgentEvent(state: AgentThreadState, event: AgentEvent): AgentThreadState {
  if (event.threadId !== state.threadId || event.projectId !== state.projectId) return state;
  if (event.seq <= state.lastSeq) return state;

  let next: AgentThreadState = { ...state, lastSeq: event.seq, activeRunId: event.runId || state.activeRunId };
  const payload = event.payload;

  switch (event.type) {
    case "run.created":
    case "run.started":
      return {
        ...next,
        runStatus: "running",
        runStartedAt: event.createdAt,
        runStatuses: { ...next.runStatuses, [event.runId]: "running" },
        runTimings: { ...next.runTimings, [event.runId]: { startedAt: event.createdAt } }
      };
    case "run.status": {
      const status = stringValue(payload.status, "running") as AgentThreadState["runStatus"];
      const timing = next.runTimings[event.runId];
      const terminal = ["completed", "failed", "stopped"].includes(status);
      return {
        ...next,
        runStatus: status,
        runStatuses: { ...next.runStatuses, [event.runId]: status },
        runTimings: timing && terminal ? { ...next.runTimings, [event.runId]: { ...timing, completedAt: event.createdAt } } : next.runTimings
      };
    }
    case "thinking.started": {
      const id = stringValue(payload.thinkingId, `thinking:${event.runId}`);
      const existing = next.items[id];
      if (existing?.kind === "thinking" && existing.runId === event.runId) return next;
      const item: ThinkingItem = {
        kind: "thinking",
        id,
        runId: event.runId,
        activityKind: payload.activityKind === "verification" ? "verification" : "thinking",
        paragraphs: [],
        status: "streaming",
        createdAt: event.createdAt
      };
      return { ...next, ...appendItem(next, item) };
    }
    case "thinking.paragraph": {
      const id = stringValue(payload.thinkingId, `thinking:${event.runId}`);
      const current = next.items[id];
      if (!current || current.kind !== "thinking") return next;
      const paragraphId = stringValue(payload.paragraphId, event.id);
      const text = stringValue(payload.text).trim();
      if (!text) return next;
      const paragraph = {
        id: paragraphId,
        text,
        agent: stringValue(payload.agent) || undefined,
        node: stringValue(payload.node) || undefined,
        iteration: typeof payload.iteration === "number" ? numberValue(payload.iteration) : undefined
      };
      const existing = current.paragraphs.findIndex((candidate) => candidate.id === paragraphId);
      const paragraphs = existing < 0
        ? [...current.paragraphs, paragraph]
        : current.paragraphs.map((candidate, index) => index === existing ? paragraph : candidate);
      return { ...next, items: { ...next.items, [id]: { ...current, paragraphs, status: "streaming" } } };
    }
    case "thinking.completed": {
      const id = stringValue(payload.thinkingId, `thinking:${event.runId}`);
      const current = next.items[id];
      if (!current || current.kind !== "thinking") return next;
      if (current.paragraphs.length === 0) return { ...next, ...removeTimelineItem(next, id) };
      return { ...next, items: { ...next.items, [id]: { ...current, status: "completed" } } };
    }
    case "message.started": {
      const item: MessageItem = {
        kind: "message",
        id: stringValue(payload.messageId, event.id),
        runId: event.runId,
        role: stringValue(payload.role, "assistant") as MessageItem["role"],
        text: stringValue(payload.text),
        status: "streaming",
        createdAt: event.createdAt,
        agentId: stringValue(payload.agentId) || undefined,
        agentName: stringValue(payload.agentName) || undefined,
        attachments: attachmentsValue(payload.attachments)
      };
      return { ...next, ...appendItem(next, item) };
    }
    case "message.delta":
    case "text.delta": {
      const id = stringValue(payload.messageId);
      const current = next.items[id];
      if (!current || current.kind !== "message") return next;
      return {
        ...next,
        items: { ...next.items, [id]: { ...current, text: current.text + stringValue(payload.delta), status: "streaming" } }
      };
    }
    case "message.reset": {
      const id = stringValue(payload.messageId);
      const current = next.items[id];
      if (!current || current.kind !== "message") return next;
      return {
        ...next,
        items: { ...next.items, [id]: { ...current, text: stringValue(payload.text), status: "streaming" } }
      };
    }
    case "message.completed": {
      const id = stringValue(payload.messageId);
      const current = next.items[id];
      if (!current || current.kind !== "message") return next;
      const citations = Array.isArray(payload.citations) ? (payload.citations as MessageItem["citations"]) : current.citations;
      return {
        ...next,
        items: {
          ...next.items,
          [id]: { ...current, text: stringValue(payload.text, current.text), citations, attachments: attachmentsValue(payload.attachments) || current.attachments, status: "completed" }
        }
      };
    }
    case "tool.started": {
      const toolCallId = stringValue(payload.toolCallId, event.id);
      const id = `tool:${toolCallId}`;
      const existing = next.items[id];
      if (existing?.kind === "tool" && ["completed", "failed", "unknown"].includes(existing.status)) return next;
      const item: ToolItem = {
        kind: "tool",
        id,
        runId: event.runId,
        toolCallId,
        name: stringValue(payload.name, "工具"),
        summary: stringValue(payload.summary, "正在准备"),
        status: "running",
        query: stringValue(payload.query) || undefined,
        cached: payload.cached === true,
        input: payload.input,
        createdAt: event.createdAt
      };
      return { ...next, ...appendItem(next, item) };
    }
    case "tool.updated":
    case "tool.progress":
    case "tool.completed":
    case "tool.failed": {
      const toolCallId = stringValue(payload.toolCallId);
      const id = `tool:${toolCallId}`;
      const current = next.items[id];
      if (!current || current.kind !== "tool") return next;
      const status = event.type === "tool.completed" ? "completed" : event.type === "tool.failed" ? "failed" : stringValue(payload.status, current.status);
      const progressPayload = payload.progress;
      const progress = progressPayload && typeof progressPayload === "object"
        ? {
            current: numberValue((progressPayload as Record<string, unknown>).current),
            total: numberValue((progressPayload as Record<string, unknown>).total)
          }
        : current.progress;
      const payloadDuration = typeof payload.durationMs === "number"
        ? numberValue(payload.durationMs)
        : undefined;
      const startedAt = Date.parse(current.createdAt);
      const finishedAt = Date.parse(event.createdAt);
      const inferredDuration = ["tool.completed", "tool.failed"].includes(event.type)
        && Number.isFinite(startedAt)
        && Number.isFinite(finishedAt)
        ? Math.max(0, finishedAt - startedAt)
        : undefined;
      return {
        ...next,
        items: {
          ...next.items,
          [id]: {
            ...current,
            status: status as ToolItem["status"],
            summary: stringValue(payload.summary, current.summary),
            query: stringValue(payload.query, current.query) || undefined,
            provider: stringValue(payload.provider, current.provider) || undefined,
            resultCount: typeof payload.resultCount === "number" ? numberValue(payload.resultCount) : current.resultCount,
            evidenceCount: typeof payload.evidenceCount === "number" ? numberValue(payload.evidenceCount) : current.evidenceCount,
            sources: sourcesValue(payload.sources) || current.sources,
            cached: typeof payload.cached === "boolean" ? payload.cached : current.cached,
            retryable: typeof payload.retryable === "boolean" ? payload.retryable : current.retryable,
            progress,
            output: stringValue(payload.output, current.output),
            rawResult: payload.rawResult ?? current.rawResult,
            durationMs: payloadDuration ?? current.durationMs ?? inferredDuration,
            error: stringValue(payload.error, current.error)
          }
        }
      };
    }
    case "approval.required": {
      const approvalId = stringValue(payload.approvalId, event.id);
      const item: ApprovalItem = {
        kind: "approval",
        id: `approval:${approvalId}`,
        runId: event.runId,
        approvalId,
        toolCallId: stringValue(payload.toolCallId) || undefined,
        title: stringValue(payload.title, "需要确认"),
        description: stringValue(payload.description),
        status: "pending",
        createdAt: event.createdAt
      };
      return { ...next, runStatus: "waiting", runStatuses: { ...next.runStatuses, [event.runId]: "waiting" }, ...appendItem(next, item) };
    }
    case "approval.resolved": {
      const id = `approval:${stringValue(payload.approvalId)}`;
      const current = next.items[id];
      if (!current || current.kind !== "approval") return next;
      return {
        ...next,
        runStatus: "running",
        runStatuses: { ...next.runStatuses, [event.runId]: "running" },
        items: { ...next.items, [id]: { ...current, status: payload.decision === "deny" ? "denied" : "approved" } }
      };
    }
    case "plan.updated": {
      const plan = planValue(payload.steps);
      return plan ? { ...next, plan, planUpdatedAt: event.createdAt } : next;
    }
    case "artifact.created":
    case "artifact.updated": {
      const artifact = payload.artifact as Artifact | undefined;
      return artifact ? { ...next, artifacts: upsertById(next.artifacts, artifact) } : next;
    }
    case "citation.created": {
      const messageId = stringValue(payload.messageId);
      const current = next.items[messageId];
      const citation = payload.citation;
      if (!current || current.kind !== "message" || !citation || typeof citation !== "object") return next;
      return {
        ...next,
        items: {
          ...next.items,
          [messageId]: { ...current, citations: [...(current.citations || []), citation as { label: string; url: string }] }
        }
      };
    }
    case "file.changed": {
      const file = payload.file as WorkbenchFile | undefined;
      return file ? { ...next, files: upsertById(next.files, file) } : next;
    }
    case "log.appended": {
      const log = payload.log as LogEntry | undefined;
      return log && !next.logs.some((entry) => entry.id === log.id) ? { ...next, logs: [...next.logs, log] } : next;
    }
    case "memory.updated": {
      const status = stringValue(payload.status);
      const item: StatusItem = {
        kind: "status",
        id: `memory:${event.runId}:${stringValue(payload.memoryId, status || event.id)}`,
        runId: event.runId,
        label: stringValue(payload.summary, status === "degraded" ? "长期证据记忆当前不可用，主搜索继续运行" : "证据记忆已更新"),
        tone: status === "degraded" ? "warning" : "neutral",
        createdAt: event.createdAt
      };
      return { ...next, ...appendItem(next, item) };
    }
    case "run.completed": {
      const timing = next.runTimings[event.runId];
      const settled = settleRunItems(next, event.runId, "completed");
      const completed: AgentThreadState = {
        ...settled,
        runStatus: "completed",
        runStatuses: { ...settled.runStatuses, [event.runId]: "completed" },
        runTimings: timing ? { ...settled.runTimings, [event.runId]: { ...timing, completedAt: event.createdAt } } : settled.runTimings
      };
      if (payload.partial !== true && payload.verificationPassed !== false) return completed;
      const item: StatusItem = {
        kind: "status",
        id: `status:${event.id}`,
        runId: event.runId,
        label: stringValue(payload.summary, payload.partial === true ? "本次回答未完全核验，请结合引用来源审阅" : "回答已完成，本任务未使用外部证据核验"),
        tone: payload.partial === true ? "warning" : "neutral",
        createdAt: event.createdAt
      };
      return { ...completed, ...appendItem(completed, item) };
    }
    case "run.cancelled": {
      const timing = next.runTimings[event.runId];
      const settled = settleRunItems(next, event.runId, "stopped");
      return {
        ...settled,
        runStatus: "stopped",
        runStatuses: { ...settled.runStatuses, [event.runId]: "stopped" },
        runTimings: timing ? { ...settled.runTimings, [event.runId]: { ...timing, completedAt: event.createdAt } } : settled.runTimings
      };
    }
    case "run.failed": {
      const statusItem: StatusItem = {
        kind: "status",
        id: `status:${event.id}`,
        runId: event.runId,
        label: stringValue(payload.message, stringValue(payload.error, "运行失败")),
        tone: "danger",
        createdAt: event.createdAt
      };
      const timing = next.runTimings[event.runId];
      const settled = settleRunItems(next, event.runId, "error");
      return {
        ...settled,
        runStatus: "failed",
        runStatuses: { ...settled.runStatuses, [event.runId]: "failed" },
        runTimings: timing ? { ...settled.runTimings, [event.runId]: { ...timing, completedAt: event.createdAt } } : settled.runTimings,
        ...appendItem(settled, statusItem)
      };
    }
    default:
      return next;
  }
}

export function reduceAgentEvents(state: AgentThreadState, events: AgentEvent[]) {
  return events.reduce(reduceAgentEvent, state);
}

/**
 * Optimistically switch the visible linear branch before an edited message is
 * sent. The server performs the durable archive transaction; this function
 * guarantees that no stale reply survives in the first client render frame.
 */
export function truncateThreadStateForEdit(state: AgentThreadState, messageId: string, nextText: string): AgentThreadState {
  const index = state.itemOrder.indexOf(messageId);
  const target = state.items[messageId];
  if (index < 0 || !target || target.kind !== "message" || target.role !== "user") return state;
  const retainedOrder = state.itemOrder.slice(0, index + 1);
  const retainedItems = Object.fromEntries(retainedOrder.map((id) => [id, id === messageId ? { ...target, text: nextText, status: "completed" as const } : state.items[id]]));
  const removedRunIds = new Set(state.itemOrder.slice(index).map((id) => state.items[id]?.runId).filter(Boolean));
  return {
    ...state,
    activeRunId: null,
    runStatus: "queued",
    runStartedAt: null,
    items: retainedItems,
    itemOrder: retainedOrder,
    artifacts: [],
    files: [],
    logs: [],
    plan: [],
    planUpdatedAt: null,
    runStatuses: Object.fromEntries(Object.entries(state.runStatuses).filter(([runId]) => !removedRunIds.has(runId))),
    runTimings: Object.fromEntries(Object.entries(state.runTimings).filter(([runId]) => !removedRunIds.has(runId)))
  };
}
