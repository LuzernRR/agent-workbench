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
  ToolItem,
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
      const item: ToolItem = {
        kind: "tool",
        id: `tool:${toolCallId}`,
        runId: event.runId,
        toolCallId,
        name: stringValue(payload.name, "工具"),
        summary: stringValue(payload.summary, "正在准备"),
        status: "running",
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
      return {
        ...next,
        items: {
          ...next.items,
          [id]: {
            ...current,
            status: status as ToolItem["status"],
            summary: stringValue(payload.summary, current.summary),
            progress,
            output: stringValue(payload.output, current.output),
            rawResult: payload.rawResult ?? current.rawResult,
            durationMs: numberValue(payload.durationMs, current.durationMs),
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
    case "run.completed": {
      const timing = next.runTimings[event.runId];
      return {
        ...next,
        runStatus: "completed",
        runStatuses: { ...next.runStatuses, [event.runId]: "completed" },
        runTimings: timing ? { ...next.runTimings, [event.runId]: { ...timing, completedAt: event.createdAt } } : next.runTimings
      };
    }
    case "run.cancelled": {
      const timing = next.runTimings[event.runId];
      return {
        ...next,
        runStatus: "stopped",
        runStatuses: { ...next.runStatuses, [event.runId]: "stopped" },
        runTimings: timing ? { ...next.runTimings, [event.runId]: { ...timing, completedAt: event.createdAt } } : next.runTimings
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
      return {
        ...next,
        runStatus: "failed",
        runStatuses: { ...next.runStatuses, [event.runId]: "failed" },
        runTimings: timing ? { ...next.runTimings, [event.runId]: { ...timing, completedAt: event.createdAt } } : next.runTimings,
        ...appendItem(next, statusItem)
      };
    }
    default:
      return next;
  }
}

export function reduceAgentEvents(state: AgentThreadState, events: AgentEvent[]) {
  return events.reduce(reduceAgentEvent, state);
}
