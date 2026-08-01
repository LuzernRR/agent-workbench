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
import { safeSourceUrl, sourceUrlIdentity } from "./source-url";

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
    planId: null,
    planRevision: 0,
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

function verificationHrefValue(value: unknown, fallback?: string) {
  if (typeof value !== "string") return fallback;
  return /^\/workbench\/verify\/xiaohongshu\/[A-Za-z0-9_.:-]+\/[A-Za-z0-9_-]{43}$/u.test(value)
    ? value
    : fallback;
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
      const url = safeSourceUrl(candidate.url);
      if (!url) return [];
      const channel = ["web", "x", "xiaohongshu"].includes(candidate.channel || "")
        ? candidate.channel
        : undefined;
      return [{
        title: candidate.title.trim().slice(0, 300) || "搜索来源",
        url,
        verified: candidate.verified,
        channel,
        author: typeof candidate.author === "string" && candidate.author.trim() ? candidate.author.trim().slice(0, 160) : undefined,
        publishedAt: typeof candidate.publishedAt === "string" && candidate.publishedAt.trim() ? candidate.publishedAt.trim().slice(0, 80) : undefined,
        limitation: typeof candidate.limitation === "string" && candidate.limitation.trim() ? candidate.limitation.trim().slice(0, 500) : undefined
      }];
    } catch {
      return [];
    }
  });
  return sources.length ? sources : undefined;
}

function sourcePresentationsValue(value: unknown): Array<{ url: string; text: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as { url?: unknown; text?: unknown };
    if (typeof candidate.url !== "string" || typeof candidate.text !== "string") return [];
    const text = candidate.text.trim().slice(0, 180);
    if (
      !text
      || /(?:未(?:成功)?(?:读取|加载|获取|核验|验证)|仅(?:发现|检索到).{0,12}(?:候选|索引)|(?:正文|帖子|笔记|详情|原文|内容).{0,12}(?:未|没有).{0,6}(?:读取|加载|获取|核验|验证)|受.{0,12}(?:读取|详情).{0,8}上限|(?:仅|只).{0,12}(?:标题|标签|话题|关键词)|(?:未|没有).{0,6}(?:展开|涉及|提及|覆盖|包含|提供).{0,60}(?:对比|区别|内容|信息|说明|细节|证据)|(?:无|没有|缺少).{0,12}(?:有效|实质|相关).{0,8}(?:内容|信息|证据|说明))/u.test(text)
    ) return [];
    try {
      const url = safeSourceUrl(candidate.url);
      if (!url) return [];
      return [{ url, text }];
    } catch {
      return [];
    }
  });
}

function mergeSources(
  current: ToolSource[] | undefined,
  incoming: ToolSource[]
): ToolSource[] {
  const sources = new Map((current || []).map((source) => [sourceUrlIdentity(source.url), source]));
  for (const source of incoming) {
    const key = sourceUrlIdentity(source.url);
    if (!key) continue;
    const previous = sources.get(key);
    if (previous?.verified && !source.verified) continue;
    sources.set(key, {
      ...previous,
      ...source,
      url: previous?.url || source.url,
      displayText: previous?.displayText || source.displayText
    });
  }
  return [...sources.values()];
}

function planValue(value: unknown): PlanStep[] | null {
  if (!Array.isArray(value)) return null;
  const steps: PlanStep[] = [];
  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== "object") return null;
    const candidate = item as Omit<Partial<PlanStep>, "status"> & { status?: string };
    const rawStatus = candidate.status === "running" ? "in_progress" : candidate.status;
    const title = typeof candidate.title === "string" ? candidate.title.trim() : typeof candidate.objective === "string" ? candidate.objective.trim() : "";
    if (!title || !["todo", "in_progress", "done", "blocked", "skipped"].includes(rawStatus || "")) return null;
    steps.push({
      id: typeof candidate.id === "string" && candidate.id ? candidate.id : String(index + 1),
      title,
      ...(typeof candidate.planId === "string" ? { planId: candidate.planId } : {}),
      ...(typeof candidate.revision === "number" ? { revision: candidate.revision } : {}),
      ...(typeof candidate.facet === "string" && candidate.facet.trim() ? { facet: candidate.facet.trim() } : {}),
      ...(typeof candidate.objective === "string" && candidate.objective.trim() ? { objective: candidate.objective.trim() } : {}),
      ...(typeof candidate.query === "string" && candidate.query.trim() ? { query: candidate.query.trim() } : {}),
      ...(["web", "x", "xiaohongshu"].includes(candidate.channel || "") ? { channel: candidate.channel } : {}),
      ...(Array.isArray(candidate.dependsOn) && candidate.dependsOn.every((item) => typeof item === "string") ? { dependsOn: candidate.dependsOn } : {}),
      ...(typeof candidate.priority === "number" && Number.isInteger(candidate.priority) ? { priority: candidate.priority } : {}),
      ...(typeof candidate.evidenceNeeded === "number" && Number.isInteger(candidate.evidenceNeeded) ? { evidenceNeeded: candidate.evidenceNeeded } : {}),
      ...(typeof candidate.canParallelize === "boolean" ? { canParallelize: candidate.canParallelize } : {}),
      ...(typeof candidate.reasonCode === "string" && candidate.reasonCode ? { reasonCode: candidate.reasonCode } : {}),
      status: rawStatus as PlanStep["status"],
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
      item.kind === "tool" && item.runId === runId
        ? {
            ...item,
            sourcePresentationActive: false,
            ...(["preparing", "running", "waiting"].includes(item.status)
              ? { status: "unknown" as const, summary: "工具结果状态未知", error: item.error || "OUTCOME_UNKNOWN" }
              : {})
          }
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
      // 完整段落只用于初始化旧事件；同一 paragraphId 后续不得覆盖已显示前缀。
      if (existing >= 0) return next;
      const paragraphs = [...current.paragraphs, paragraph];
      return { ...next, items: { ...next.items, [id]: { ...current, paragraphs, status: "streaming" } } };
    }
    case "thinking.delta": {
      const id = stringValue(payload.thinkingId, `thinking:${event.runId}`);
      const current = next.items[id];
      if (!current || current.kind !== "thinking") return next;
      const paragraphId = stringValue(payload.paragraphId, `${id}:detail`);
      const delta = stringValue(payload.delta);
      if (!delta) return next;
      const existing = current.paragraphs.findIndex((candidate) => candidate.id === paragraphId);
      const paragraph = existing < 0
        ? {
            id: paragraphId,
            text: delta,
            agent: stringValue(payload.agent) || undefined,
            node: stringValue(payload.node) || undefined,
            iteration: typeof payload.iteration === "number" ? numberValue(payload.iteration) : undefined
          }
        : {
            ...current.paragraphs[existing],
            text: current.paragraphs[existing].text + delta
          };
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
      // 重试必须使用新的 messageId；旧消息一旦可见便不可回写。
      return { ...next, items: { ...next.items, [id]: { ...current, status: "streaming" } } };
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
          [id]: { ...current, citations, attachments: attachmentsValue(payload.attachments) || current.attachments, status: "completed" }
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
        planStepId: stringValue(payload.planStepId) || undefined,
        name: stringValue(payload.name, "工具"),
        summary: stringValue(payload.summary, "正在准备"),
        status: "running",
        channel: ["web", "x", "xiaohongshu"].includes(stringValue(payload.channel)) ? stringValue(payload.channel) as ToolItem["channel"] : undefined,
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
      const sourcePresentations = new Map(
        sourcePresentationsValue(payload.sourcePresentations).map((item) => [sourceUrlIdentity(item.url), item.text])
      );
      // 重连或重复控制事件不能清空已经逐字显示的来源说明。
      const currentSources = current.sources;
      const nextSources = sourcePresentations.size && currentSources
        ? currentSources.map((source) => ({
            ...source,
            displayText: source.verified
              ? sourcePresentations.get(sourceUrlIdentity(source.url)) || source.displayText
              : source.displayText
          }))
        : (() => {
            const incoming = sourcesValue(payload.sources);
            return incoming ? mergeSources(currentSources, incoming) : currentSources;
          })();
      const nextResultCount = typeof payload.resultCount === "number"
        ? Math.max(current.resultCount || 0, numberValue(payload.resultCount))
        : current.resultCount;
      const nextEvidenceCount = typeof payload.evidenceCount === "number"
        ? Math.max(current.evidenceCount || 0, numberValue(payload.evidenceCount))
        : current.evidenceCount;
      return {
        ...next,
        items: {
          ...next.items,
          [id]: {
            ...current,
            status: status as ToolItem["status"],
            summary: current.summary,
            settlementSummary: stringValue(
              payload.settlementSummary ?? payload.summary,
              current.settlementSummary
            ) || undefined,
            outcomeStatus: ["success", "degraded", "failed"].includes(stringValue(payload.outcomeStatus))
              ? stringValue(payload.outcomeStatus) as ToolItem["outcomeStatus"]
              : current.outcomeStatus,
            channel: ["web", "x", "xiaohongshu"].includes(stringValue(payload.channel)) ? stringValue(payload.channel) as ToolItem["channel"] : current.channel,
            query: stringValue(payload.query, current.query) || undefined,
            provider: stringValue(payload.provider, current.provider) || undefined,
            primaryProvider: stringValue(payload.primaryProvider, current.primaryProvider) || undefined,
            effectiveProvider: stringValue(payload.effectiveProvider, current.effectiveProvider) || undefined,
            reasonCode: payload.clearReasonCode === true
              ? undefined
              : stringValue(payload.reasonCode, current.reasonCode) || undefined,
            resolutionMessage: stringValue(payload.resolutionMessage, current.resolutionMessage) || undefined,
            nextAction: ["none", "use_fallback", "use_alternative_channel", "reconnect_account", "retry_later", "stop"].includes(stringValue(payload.nextAction))
              ? stringValue(payload.nextAction) as ToolItem["nextAction"]
              : current.nextAction,
            resultCount: nextResultCount,
            evidenceCount: nextEvidenceCount,
            sources: nextSources,
            sourcePresentationActive: typeof payload.sourcePresentationActive === "boolean"
              ? payload.sourcePresentationActive
              : current.sourcePresentationActive,
            cached: typeof payload.cached === "boolean" ? payload.cached : current.cached,
            retryable: typeof payload.retryable === "boolean" ? payload.retryable : current.retryable,
            verificationStatus: ["pending", "succeeded", "expired", "account_mismatch", "failed", "cancelled"].includes(stringValue(payload.verificationStatus))
              ? stringValue(payload.verificationStatus) as ToolItem["verificationStatus"]
              : current.verificationStatus,
            verificationHref: verificationHrefValue(payload.verificationHref, current.verificationHref),
            verificationExpiresAt: typeof payload.verificationExpiresAt === "string" && Number.isFinite(Date.parse(payload.verificationExpiresAt))
              ? payload.verificationExpiresAt
              : current.verificationExpiresAt,
            verificationMessage: stringValue(payload.verificationMessage, current.verificationMessage).slice(0, 300) || undefined,
            progress,
            output: stringValue(payload.output, current.output),
            rawResult: payload.rawResult ?? current.rawResult,
            durationMs: payloadDuration ?? current.durationMs ?? inferredDuration,
            error: stringValue(payload.error, current.error)
          }
        }
      };
    }
    case "tool.source.delta": {
      const toolCallId = stringValue(payload.toolCallId);
      const id = `tool:${toolCallId}`;
      const current = next.items[id];
      if (!current || current.kind !== "tool") return next;
      const url = safeSourceUrl(payload.url);
      const delta = stringValue(payload.delta);
      if (!url || !delta || !current.sources) return next;
      const presentationKey = sourceUrlIdentity(url);
      const sources = current.sources.map((source) => {
        if (!source.verified || sourceUrlIdentity(source.url) !== presentationKey) return source;
        return {
          ...source,
          displayText: `${source.displayText || ""}${delta}`.slice(0, 180)
        };
      });
      return {
        ...next,
        items: {
          ...next.items,
          [id]: { ...current, sources }
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
      const revision = numberValue(payload.revision);
      if (revision > 0 && revision <= next.planRevision) return next;
      const plan = planValue(payload.steps);
      const planId = stringValue(payload.planId) || next.planId;
      const hydrated = plan?.map((step) => ({
        ...step,
        ...(planId ? { planId } : {}),
        ...(revision > 0 ? { revision } : {})
      }));
      return hydrated ? { ...next, plan: hydrated, planId, planRevision: revision || next.planRevision + 1, planUpdatedAt: event.createdAt } : next;
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
    planId: null,
    planRevision: 0,
    planUpdatedAt: null,
    runStatuses: Object.fromEntries(Object.entries(state.runStatuses).filter(([runId]) => !removedRunIds.has(runId))),
    runTimings: Object.fromEntries(Object.entries(state.runTimings).filter(([runId]) => !removedRunIds.has(runId)))
  };
}
