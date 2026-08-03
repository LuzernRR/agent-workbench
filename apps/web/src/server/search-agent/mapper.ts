import type { AgentEventType, ReasoningEffort } from "@/lib/agent-events/types";
import type { PreparedImageInput } from "@/server/media/image-input";
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

// 改写产出的是另一段答案，不能续写在已可见消息上（reducer 的旧消息不可回写）。
// composeRound 随 Verifier 的 rewrite 递增，因而每轮撰写都得到独立 messageId。
export function answerMessageId(runId: string, composeRound: number) {
  const base = `msg_${runId.replace(/[^A-Za-z0-9]/gu, "")}_assistant`;
  return composeRound > 0 ? `${base}_r${composeRound}` : base;
}

function channelName(channel: "web" | "x" | "xiaohongshu") {
  return channel === "x" ? "X 搜索" : channel === "xiaohongshu" ? "小红书搜索" : "网页搜索";
}

type SearchResultEvent = Extract<SearchAgentEvent, { type: "tool.completed" }>["results"][number];
type ToolLedgerEvent = Extract<SearchAgentEvent, { toolCallId: string }>;

function toolLedgerPayload(event: ToolLedgerEvent) {
  return {
    operationRef: "operationRef" in event ? event.operationRef : undefined,
    attempt: "attempt" in event ? event.attempt : undefined,
    inputHash: "inputHash" in event ? event.inputHash : undefined,
    outputHash: "outputHash" in event ? event.outputHash ?? undefined : undefined,
    resultRef: "resultRef" in event ? event.resultRef ?? undefined : undefined,
    researchBatchId: "researchBatchId" in event ? event.researchBatchId : undefined,
    researchResultId: "researchResultId" in event ? event.researchResultId : undefined,
    usage: "usage" in event ? event.usage : undefined
  };
}

const ineffectiveSourceText = /(?:未(?:成功)?(?:读取|加载|获取|核验|验证)|仅(?:发现|检索到).{0,12}(?:候选|索引)|(?:正文|帖子|笔记|详情|原文|内容).{0,12}(?:未|没有).{0,6}(?:读取|加载|获取|核验|验证)|受.{0,12}(?:读取|详情).{0,8}上限|(?:仅|只).{0,12}(?:标题|标签|话题|关键词)|(?:未|没有).{0,6}(?:展开|涉及|提及|覆盖|包含|提供).{0,60}(?:对比|区别|内容|信息|说明|细节|证据)|(?:无|没有|缺少).{0,12}(?:有效|实质|相关).{0,8}(?:内容|信息|证据|说明))/u;

function verifiedSource(result: SearchResultEvent | null) {
  if (!result?.verified) return null;
  const url = safeUrl(result.url);
  if (!url) return null;
  return {
    title: oneLine(result.title, 300),
    url,
    verified: true,
    channel: result.channel,
    author: result.author ? oneLine(result.author, 160) : undefined,
    publishedAt: result.published_at || undefined
  };
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
    if (!event.publicSummary || !["plan_research", "reflect"].includes(event.node)) return { events: [] };
    const id = activityId("thinking", runId, event.nodeRunId);
    return { events: [
      { type: "thinking.started", payload: { thinkingId: id, activityKind: "thinking" } },
      {
        type: "thinking.delta",
        payload: {
          thinkingId: id,
          paragraphId: `${id}:detail`,
          delta: oneLine(event.publicSummary),
          publicSummarySource: event.publicSummarySource,
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
    return {
      events: [{
        type: "plan.updated",
        payload: {
          planId: event.planId,
          revision: event.revision,
          steps: event.steps.map((step) => ({
            id: step.stepId,
            stepId: step.stepId,
            title: oneLine(step.objective, 500),
            facet: oneLine(step.facet, 200),
            objective: oneLine(step.objective, 500),
            query: oneLine(step.query, 300),
            channel: step.channel,
            dependsOn: step.dependsOn,
            priority: step.priority,
            evidenceNeeded: step.evidenceNeeded,
            canParallelize: step.canParallelize,
            status: step.status,
            reasonCode: step.reasonCode
          }))
        }
      }]
    };
  }
  if (event.type === "plan.rejected") {
    return {
      events: [{
        type: "log.appended",
        payload: {
          log: {
            id: `plan-rejected:${event.eventId}`,
            createdAt: event.createdAt,
            actor: "planner",
            level: "warn",
            content: event.reasonCode
          }
        }
      }]
    };
  }
  if (event.type === "tool.started") {
    const unknown = event.toolName === "unknown_tool";
    return { events: [{ type: "tool.started", payload: { toolCallId: event.toolCallId, planStepId: event.planStepId, ...toolLedgerPayload(event), name: unknown ? "未知工具请求" : channelName(event.channel), summary: unknown ? "正在拦截未注册工具请求" : `搜索：${oneLine(event.query, 300)}`, channel: event.channel, query: oneLine(event.query, 300), cached: event.cached } }] };
  }
  if (event.type === "tool.progress") {
    const source = verifiedSource(event.source);
    return {
      events: [{
        type: "tool.progress",
        payload: {
          toolCallId: event.toolCallId,
          ...toolLedgerPayload(event),
          channel: event.channel,
          query: oneLine(event.query, 300),
          provider: oneLine(event.provider, 80),
          resultCount: event.resultCount,
          evidenceCount: event.evidenceCount,
          sources: source ? [source] : []
        }
      }]
    };
  }
  if (event.type === "tool.verification.heartbeat") {
    // 只用于保持 Search Agent 内部事件流活跃；Workbench 不持久化轮询噪声。
    return { events: [] };
  }
  if (event.type === "tool.verification.required") {
    const verificationHref = `/workbench/verify/xiaohongshu/${encodeURIComponent(runId)}/${encodeURIComponent(event.challengeId)}`;
    return {
      events: [
        {
          type: "tool.updated",
          payload: {
            toolCallId: event.toolCallId,
            status: "waiting",
            reasonCode: "CAPTCHA_REQUIRED",
            verificationStatus: event.status,
            verificationHref,
            verificationExpiresAt: event.expiresAt,
            verificationMessage: oneLine(event.message, 300)
          }
        },
        { type: "run.status", payload: { status: "waiting", reasonCode: "CAPTCHA_REQUIRED" } }
      ]
    };
  }
  if (event.type === "tool.verification.resolved") {
    const verificationHref = `/workbench/verify/xiaohongshu/${encodeURIComponent(runId)}/${encodeURIComponent(event.challengeId)}`;
    return {
      events: [
        {
          type: "tool.updated",
          payload: {
            toolCallId: event.toolCallId,
            status: "running",
            clearReasonCode: event.status === "succeeded",
            verificationStatus: event.status,
            verificationHref,
            verificationExpiresAt: event.expiresAt,
            verificationMessage: oneLine(event.message, 300)
          }
        },
        { type: "run.status", payload: { status: "running", verificationStatus: event.status } }
      ]
    };
  }
  if (event.type === "tool.completed") {
    const sources = event.results
      .map((result) => verifiedSource(result))
      .filter((result): result is NonNullable<typeof result> => Boolean(result));
    return { events: [{ type: "tool.completed", payload: {
      toolCallId: event.toolCallId,
      planStepId: event.planStepId,
      ...toolLedgerPayload(event),
      settlementSummary: oneLine(event.summary),
      channel: event.channel,
      query: oneLine(event.query, 300),
      provider: oneLine(event.effectiveProvider || event.provider, 80),
      outcomeStatus: event.status || "success",
      primaryProvider: oneLine(event.primaryProvider || event.provider, 80),
      effectiveProvider: oneLine(event.effectiveProvider || event.provider, 80),
      reasonCode: event.reasonCode || undefined,
      resolutionMessage: event.message ? oneLine(event.message) : undefined,
      retryable: event.retryable || false,
      nextAction: event.nextAction || "none",
      resultCount: event.resultCount,
      evidenceCount: event.evidenceCount,
      sources,
      cached: event.cached,
      durationMs: event.durationMs
    } }] };
  }
  if (event.type === "tool.presented") {
    const sourcePresentations = event.sources.map((source) => ({
      url: safeUrl(source.url),
      text: oneLine(source.text, 180)
    })).filter((source) => source.url && source.text && !ineffectiveSourceText.test(source.text));
    return sourcePresentations.length
      ? {
          events: [
            {
              type: "tool.updated",
              payload: {
                toolCallId: event.toolCallId,
                sourcePresentationActive: true,
                sourcePresentationUrls: sourcePresentations.map((source) => source.url)
              }
            },
            ...sourcePresentations.map((source) => ({
              type: "tool.source.delta" as const,
              payload: {
                toolCallId: event.toolCallId,
                url: source.url,
                delta: source.text,
                presentationSource: event.presentationSource
              }
            })),
            {
              type: "tool.updated",
              payload: { toolCallId: event.toolCallId, sourcePresentationActive: false }
            }
          ]
        }
      : { events: [] };
  }
  if (event.type === "answer.started") {
    const messageId = answerMessageId(runId, event.composeRound);
    return {
      events: [{
        type: "message.started",
        payload: { messageId, role: "assistant", text: "", agentId: "search-agent", agentName: "搜索 Agent" }
      }]
    };
  }
  if (event.type === "answer.delta") {
    return {
      events: [{
        type: "message.delta",
        payload: { messageId: answerMessageId(runId, event.composeRound), delta: event.delta }
      }]
    };
  }
  if (event.type === "answer.completed") {
    return {
      events: [{
        type: "message.completed",
        payload: { messageId: answerMessageId(runId, event.composeRound), text: "" }
      }]
    };
  }
  if (event.type === "evidence.updated") {
    return {
      events: [{
        type: "tool.updated",
        payload: {
          toolCallId: event.toolCallId,
          sources: [{
            title: oneLine(event.title, 300),
            url: safeUrl(event.url),
            verified: true,
            channel: event.channel,
            evidenceId: event.evidenceId,
            sourceId: event.sourceId,
            contentHash: event.contentHash,
            evidenceStatus: event.status,
            evidenceReasonCode: event.reasonCode,
            evidenceUpdatedAt: event.updatedAt
          }]
        }
      }]
    };
  }
  if (event.type === "tool.failed") {
    return { events: [{ type: "tool.failed", payload: {
      toolCallId: event.toolCallId,
      planStepId: event.planStepId,
      ...toolLedgerPayload(event),
      settlementSummary: event.toolName === "unknown_tool" ? "未知工具请求已被阻止" : "搜索未完成",
      channel: event.channel,
      query: oneLine(event.query, 300),
      provider: oneLine(event.effectiveProvider || event.provider, 80),
      outcomeStatus: event.status || "failed",
      primaryProvider: oneLine(event.primaryProvider || event.provider, 80),
      effectiveProvider: oneLine(event.effectiveProvider || event.provider, 80),
      error: event.reasonCode,
      reasonCode: event.reasonCode,
      resolutionMessage: oneLine(event.message),
      retryable: event.retryable,
      nextAction: event.nextAction || "stop",
      resultCount: event.resultCount ?? 0,
      evidenceCount: event.evidenceCount ?? 0,
      durationMs: event.durationMs
    } }] };
  }
  if (event.type === "tool.unknown") {
    return { events: [{ type: "tool.unknown", payload: {
      toolCallId: event.toolCallId,
      planStepId: event.planStepId,
      ...toolLedgerPayload(event),
      status: "unknown",
      summary: "搜索结果状态未知",
      channel: event.channel,
      query: oneLine(event.query, 300),
      provider: event.provider ? oneLine(event.provider, 80) : "unknown",
      error: event.reasonCode,
      reasonCode: event.reasonCode,
      nextAction: event.nextAction || "check_operation",
      durationMs: event.durationMs || 0
    } }] };
  }
  if (event.type === "memory.updated") {
    const summary = event.status === "degraded"
      ? "历史证据记忆当前不可用，主搜索继续运行"
      : event.operation === "recall"
        ? `召回 ${event.count} 条历史证据线索`
        : `保存 ${event.count} 条已引用证据`;
    return { events: [{ type: "memory.updated", payload: {
      operation: event.operation,
      status: event.status,
      count: event.count,
      memoryRefs: event.memoryRefs,
      evidenceIds: event.evidenceIds,
      embeddingVersion: event.embeddingVersion,
      reasonCode: event.reasonCode,
      summary
    } }] };
  }
  if (event.type === "verification.completed") {
    if (!event.publicSummary) return { events: [] };
    const id = activityId("verification", runId, event.nodeRunId);
    return { events: [
      { type: "thinking.started", payload: { thinkingId: id, activityKind: "verification" } },
      {
        type: "thinking.delta",
        payload: {
          thinkingId: id,
          paragraphId: `${id}:detail`,
          delta: oneLine(event.publicSummary),
          publicSummarySource: event.publicSummarySource,
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
        answerSource: event.answerSource,
        answerModelCalls: event.answerModelCalls,
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
  imageInputs?: PreparedImageInput[];
  modelSupportsImageInput?: boolean;
  projectMemoryContext: string;
  reasoningEffort: ReasoningEffort;
  resume?: boolean;
};
