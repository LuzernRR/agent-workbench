import type { AgentEventType, ReasoningEffort } from "@/lib/agent-events/types";
import type { SearchAgentEvent } from "./events";

export type PersistableSearchAgentEvent = { type: AgentEventType; payload: Record<string, unknown> };
export type SearchAgentTerminal =
  | { kind: "completed"; answer: string; citations: Array<{ label: string; url: string }>; remember: boolean; payload: Record<string, unknown> }
  | { kind: "stopped"; payload: Record<string, unknown> }
  | { kind: "failed"; payload: Record<string, unknown> };

export type SearchAgentProjection = {
  events: PersistableSearchAgentEvent[];
  terminal?: SearchAgentTerminal;
};

function oneLine(value: string, max = 500) {
  return Array.from(value.replace(/[\u0000-\u001F\u007F]+/gu, " ").replace(/\s+/gu, " ").trim()).slice(0, max).join("");
}

function safeUrl(value: string) {
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return "";
  return parsed.href;
}

function activityId(kind: "thinking" | "verification", runId: string, nodeRunId: string) {
  return `${kind}:${runId}:${nodeRunId}`;
}

function channelName(channel: "web" | "x" | "xiaohongshu") {
  return channel === "x" ? "X 搜索" : channel === "xiaohongshu" ? "小红书搜索" : "网页搜索";
}

function projectSearchAgentEvent(event: SearchAgentEvent, runId: string): SearchAgentProjection {
  if (event.type === "node.started") {
    // 节点开始时还没有可公开的模型摘要。若此时先创建思考项，工具事件会
    // 排在它后面，而 node.completed 又会回填上方旧项，破坏真实时间顺序。
    return { events: [] };
  }
  if (event.type === "node.completed") {
    // verify 由 verification.completed 单独投影，避免混入“思考”。其余节点
    // 在完成时创建独立活动原子；前端只合并时间上相邻的同类原子。
    if (!event.publicSummary || event.node === "verify") return { events: [] };
    const id = activityId("thinking", runId, event.nodeRunId);
    return { events: [
      { type: "thinking.started", payload: { thinkingId: id, activityKind: "thinking" } },
      {
        type: "thinking.paragraph",
        payload: {
          thinkingId: id,
          paragraphId: `${id}:detail`,
          text: oneLine(event.publicSummary),
          agent: event.agent,
          node: event.node,
          iteration: event.iteration,
          durationMs: event.durationMs
        }
      },
      { type: "thinking.completed", payload: { thinkingId: id } }
    ] };
  }
  if (event.type === "node.failed") {
    return { events: [] };
  }
  if (event.type === "plan.updated") {
    // Planner 的模型摘要已经进入唯一思考项的逐行详情；具体查询由真实
    // tool.started/completed 卡片展示。这里不再创建无法随工具结果可靠
    // 收口的重复计划栏，避免运行结束后仍显示“进行中”。
    return { events: [] };
  }
  if (event.type === "tool.started") {
    const unknown = event.toolName === "unknown_tool";
    return { events: [{ type: "tool.started", payload: { toolCallId: event.toolCallId, name: unknown ? "未知工具请求" : channelName(event.channel), summary: unknown ? "正在拦截未注册工具请求" : `搜索：${oneLine(event.query, 300)}`, channel: event.channel, query: oneLine(event.query, 300), cached: event.cached } }] };
  }
  if (event.type === "tool.completed") {
    const sources = event.results.map((result) => ({
      title: oneLine(result.title, 300),
      url: safeUrl(result.url),
      verified: result.verified,
      channel: result.channel,
      author: result.author ? oneLine(result.author, 160) : undefined,
      publishedAt: result.published_at || undefined,
      limitation: result.limitation ? oneLine(result.limitation, 500) : undefined
    })).filter((result) => result.url);
    return { events: [{ type: "tool.completed", payload: { toolCallId: event.toolCallId, summary: oneLine(event.summary), channel: event.channel, query: oneLine(event.query, 300), provider: oneLine(event.provider, 80), resultCount: event.resultCount, evidenceCount: event.evidenceCount, sources, cached: event.cached } }] };
  }
  if (event.type === "tool.presented") {
    const sourcePresentations = event.sources.map((source) => ({
      url: safeUrl(source.url),
      text: oneLine(source.text, 180)
    })).filter((source) => source.url && source.text);
    return sourcePresentations.length
      ? { events: [{ type: "tool.updated", payload: { toolCallId: event.toolCallId, sourcePresentations } }] }
      : { events: [] };
  }
  if (event.type === "tool.failed") {
    return { events: [{ type: "tool.failed", payload: { toolCallId: event.toolCallId, summary: event.toolName === "unknown_tool" ? "未知工具请求已被阻止" : "搜索未完成", channel: event.channel, query: oneLine(event.query, 300), provider: oneLine(event.provider, 80), error: event.reasonCode, retryable: event.retryable } }] };
  }
  if (event.type === "tool.unknown") {
    return { events: [{ type: "tool.updated", payload: { toolCallId: event.toolCallId, status: "unknown", summary: "搜索结果状态未知", channel: event.channel, query: oneLine(event.query, 300), error: event.reasonCode } }] };
  }
  if (event.type === "memory.status") {
    const summary = event.status === "available"
      ? `已召回 ${event.recalledCount || 0} 条同项目证据线索`
      : event.status === "stored"
        ? `已保存 ${event.storedCount || 0} 条核验证据`
        : "长期证据记忆当前不可用，主搜索继续运行";
    return { events: [{ type: "memory.updated", payload: { memoryId: `memory:${event.status}`, status: event.status, summary, recalledCount: event.recalledCount, storedCount: event.storedCount, embeddingVersion: event.embeddingVersion, reasonCode: event.reasonCode } }] };
  }
  if (event.type === "verification.completed") {
    if (!event.publicSummary) return { events: [] };
    const id = activityId("verification", runId, event.nodeRunId);
    return { events: [
      { type: "thinking.started", payload: { thinkingId: id, activityKind: "verification" } },
      {
        type: "thinking.paragraph",
        payload: {
          thinkingId: id,
          paragraphId: `${id}:detail`,
          text: oneLine(event.publicSummary),
          agent: "verifier",
          node: "verify"
        }
      },
      { type: "thinking.completed", payload: { thinkingId: id } }
    ] };
  }
  if (event.type === "run.failed") {
    return {
      events: [],
      terminal: { kind: "failed", payload: { message: "Search Agent 运行失败", reasonCode: event.reasonCode } }
    };
  }
  if (event.type === "run.stopped") {
    return {
      events: [],
      terminal: { kind: "stopped", payload: { reasonCode: event.reasonCode, partial: true } }
    };
  }
  const citations = event.citations.map((citation) => ({ label: oneLine(citation.label, 300), url: safeUrl(citation.url) })).filter((citation) => citation.url);
  const partial = event.responseStatus === "partial";
  const terminalSummary = partial
    ? "本次回答未完全核验，请结合引用来源审阅"
    : event.verificationPassed
      ? "回答已通过证据核验"
      : "回答已完成，本任务未使用外部证据核验";
  return {
    events: [],
    terminal: {
      kind: "completed",
      answer: event.answerMarkdown,
      citations,
      remember: event.responseStatus === "completed" && event.verificationPassed,
      payload: {
        agentId: "search-agent",
        promptVersion: event.promptVersion,
        verificationPassed: event.verificationPassed,
        responseStatus: event.responseStatus,
        stopReason: event.stopReason,
        partial,
        summary: terminalSummary,
        usage: event.usage,
        modelCalls: event.modelCalls,
        toolCalls: event.toolCalls,
        evidenceCount: event.evidenceCount
      }
    }
  };
}

export function mapSearchAgentEvent(event: SearchAgentEvent, runId = event.streamId): SearchAgentProjection {
  const projection = projectSearchAgentEvent(event, runId);
  const audit = { sourceEventId: event.eventId, sourceStreamId: event.streamId, sourceStreamSeq: event.streamSeq, sourceSeq: event.seq };
  return {
    events: projection.events.map((item) => ({ ...item, payload: { ...item.payload, ...audit } })),
    terminal: projection.terminal ? { ...projection.terminal, payload: { ...projection.terminal.payload, ...audit } } : undefined
  };
}

export type SearchAgentExecutionInput = {
  message: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  attachmentContext: string;
  projectMemoryContext: string;
  reasoningEffort: ReasoningEffort;
  resume?: boolean;
};
