import { AGENT_LABELS, type MockAgentId } from "./catalog";
import { buildScript, type ScriptStep } from "./scripts";
import { db, emit, newId, touchThread, type MockRun, type MockThread } from "./store";
import type { ReasoningEffort } from "@/lib/agent-events/types";
import { loadRuntimeConfig, runtimeMode, type AgentRuntimeConfig } from "@/server/config/runtime-config";
import { streamDeepSeekChat, type DeepSeekChatMessage } from "@/server/llm/deepseek-client";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 单条 delta 的字符数。前端还会按字符做打字机渲染，这里只需切成合理的 token 块。 */
const DELTA_SIZE = 18;

function logStep(run: MockRun, level: "debug" | "info" | "warn" | "error", actor: string, content: string) {
  emit(run, "log.appended", {
    log: { id: newId("log"), createdAt: new Date().toISOString(), actor, level, content }
  });
}

async function runToolStep(run: MockRun, step: Extract<ScriptStep, { kind: "tool" }>) {
  const toolCallId = newId("call");

  if (step.requiresApproval) {
    const approvalId = newId("apr");
    const decision = await new Promise<"allow_once" | "always_allow" | "deny">((resolve) => {
      run.pendingApprovals.set(approvalId, resolve);
      emit(run, "approval.required", {
        approvalId,
        toolCallId,
        title: step.approvalTitle || `调用 ${step.name}`,
        description: step.approvalDescription || "该工具会产生外部副作用，请确认后继续。"
      });
    });
    run.pendingApprovals.delete(approvalId);
    emit(run, "approval.resolved", { approvalId, decision });
    if (decision === "deny") {
      logStep(run, "warn", "审批", `已拒绝调用 ${step.name}，跳过该步骤`);
      return;
    }
  }

  emit(run, "tool.started", {
    toolCallId,
    name: step.name,
    summary: "正在调用",
    input: step.input
  });

  const ticks = 3;
  for (let index = 1; index <= ticks; index += 1) {
    await sleep(Math.max(120, Math.round(step.durationMs / ticks)));
    if (run.cancelled) return;
    emit(run, "tool.progress", {
      toolCallId,
      status: "running",
      progress: { current: index, total: ticks },
      summary: index < ticks ? "正在调用" : step.summary
    });
  }

  emit(run, "tool.completed", {
    toolCallId,
    summary: step.summary,
    output: step.output,
    durationMs: step.durationMs
  });
  logStep(run, "debug", step.name, `${step.name} 完成，用时 ${step.durationMs} 毫秒`);
}

async function streamText(run: MockRun, messageId: string, chunks: string[]) {
  for (const chunk of chunks) {
    for (let offset = 0; offset < chunk.length; offset += DELTA_SIZE) {
      if (run.cancelled) return;
      emit(run, "text.delta", { messageId, delta: chunk.slice(offset, offset + DELTA_SIZE) });
      await sleep(45);
    }
  }
}

function completedConversation(thread: MockThread, replaceMessageId?: string | null): DeepSeekChatMessage[] {
  const messages: Array<DeepSeekChatMessage & { id: string }> = [];
  const drafts = new Map<string, DeepSeekChatMessage & { id: string }>();
  const events = thread.runIds
    .flatMap((runId) => db().runs.get(runId)?.events || [])
    .sort((left, right) => left.seq - right.seq);

  for (const event of events) {
    const messageId = typeof event.payload.messageId === "string" ? event.payload.messageId : "";
    if (!messageId) continue;
    if (event.type === "message.started") {
      const role = event.payload.role;
      if (role !== "user" && role !== "assistant") continue;
      drafts.set(messageId, { id: messageId, role, content: typeof event.payload.text === "string" ? event.payload.text : "" });
      continue;
    }
    if (event.type === "text.delta" || event.type === "message.delta") {
      const draft = drafts.get(messageId);
      if (draft && typeof event.payload.delta === "string") draft.content += event.payload.delta;
      continue;
    }
    if (event.type !== "message.completed") continue;
    const draft = drafts.get(messageId);
    if (!draft) continue;
    if (typeof event.payload.text === "string") draft.content = event.payload.text;
    const existingIndex = messages.findIndex((message) => message.id === messageId);
    if (existingIndex >= 0) messages.splice(existingIndex);
    if (draft.content.trim()) messages.push({ ...draft });
    drafts.delete(messageId);
  }

  const replaceIndex = replaceMessageId ? messages.findIndex((message) => message.id === replaceMessageId) : -1;
  const selected = replaceIndex >= 0 ? messages.slice(0, replaceIndex) : messages;
  const limited = selected.slice(-40);
  while (limited.length > 1 && limited.reduce((sum, message) => sum + message.content.length, 0) > 80_000) limited.shift();
  return limited.map(({ role, content }) => ({ role, content }));
}

function attachmentContext(thread: MockThread, attachmentIds: string[]) {
  const sections: string[] = [];
  for (const id of attachmentIds) {
    const attachment = thread.attachments.get(id);
    if (!attachment) continue;
    const textLike = attachment.mimeType.startsWith("text/") || ["application/json", "application/xml"].includes(attachment.mimeType);
    if (textLike && attachment.bytes.byteLength <= 64 * 1024) {
      try {
        const content = new TextDecoder("utf-8", { fatal: true }).decode(attachment.bytes).trim();
        sections.push(`附件《${attachment.name}》：\n${content}`);
        continue;
      } catch {
        // 文件名仍会进入上下文，但不会把无法解码的字节发送给模型。
      }
    }
    sections.push(`附件《${attachment.name}》（当前仅提供文件名）`);
  }
  return sections.join("\n\n");
}

async function executeModel(run: MockRun, thread: MockThread, config: AgentRuntimeConfig, messages: DeepSeekChatMessage[], modelId: string, reasoningEffort: ReasoningEffort) {
  const messageId = newId("msg");
  emit(run, "run.started", { agentId: run.agent, modelId });
  emit(run, "message.started", {
    messageId,
    role: "assistant",
    text: "",
    agentId: run.agent,
    agentName: AGENT_LABELS[run.agent]
  });
  logStep(run, "info", "助手", "已连接模型，正在生成回复");

  const result = await streamDeepSeekChat({
    config,
    modelId,
    reasoningEffort,
    messages: [{ role: "system", content: config.assistant.systemPrompt }, ...messages],
    requestId: run.id,
    signal: run.abortController.signal,
    onTextDelta: (delta) => {
      if (!run.cancelled) emit(run, "text.delta", { messageId, delta });
    }
  });
  if (run.cancelled) return;

  emit(run, "message.completed", { messageId, text: result.text, citations: [] });
  if (result.finishReason === "length") logStep(run, "warn", "模型", "回复达到输出长度上限");
  if (result.usage) logStep(run, "debug", "模型", `本轮使用 ${result.usage.totalTokens} 个令牌`);
  logStep(run, "info", "助手", "本轮处理完成");
  touchThread(thread, { status: "idle" });
  run.status = "completed";
  emit(run, "run.completed", { agentId: run.agent, modelId });
}

async function executeScript(run: MockRun, thread: MockThread, script: ScriptStep[], userMessage: string) {
  const messageId = newId("msg");
  const thinkingId = newId("thinking");
  let messageOpen = false;
  const citations: Array<{ label: string; url: string }> = [];
  let fullText = "";

  emit(run, "thinking.started", { thinkingId });
  await sleep(70);
  if (run.cancelled) return;
  emit(run, "thinking.paragraph", {
    thinkingId,
    paragraphId: "paragraph-1",
    text: `这次请求需要围绕“${userMessage.replace(/\s+/gu, " ").trim().slice(0, 140)}”组织可执行内容，并保持界面结果与交付内容一致。`
  });
  emit(run, "thinking.paragraph", {
    thinkingId,
    paragraphId: "paragraph-2",
    text: "我会先读取当前可用上下文，再完成请求中的主要工作，最后核对结果是否覆盖了关键约束。"
  });
  emit(run, "thinking.completed", { thinkingId, paragraphCount: 2 });

  const openMessage = () => {
    if (messageOpen) return;
    messageOpen = true;
    emit(run, "message.started", {
      messageId,
      role: "assistant",
      text: "",
      agentId: run.agent,
      agentName: AGENT_LABELS[run.agent]
    });
  };

  for (const step of script) {
    if (run.cancelled) return;
    switch (step.kind) {
      case "plan":
        emit(run, "plan.updated", {
          steps: step.steps.map((planStep, index) => ({ id: `step-${index + 1}`, ...planStep }))
        });
        break;
      case "log":
        logStep(run, step.level, step.actor, step.content);
        break;
      case "memory":
        if (step.recalled.length) {
          emit(run, "memory.updated", {
            operation: "recall",
            status: "completed",
            count: step.recalled.length,
            memoryRefs: step.recalled.map((_, index) => `memory_mock_recall_${index + 1}`),
            evidenceIds: step.recalled.map((_, index) => `evidence_mock_recall_${index + 1}`),
            embeddingVersion: "mock-v1",
            summary: `召回 ${step.recalled.length} 条历史证据线索`
          });
        }
        if (step.extracted.length) {
          emit(run, "memory.updated", {
            operation: "store",
            status: "completed",
            count: step.extracted.length,
            memoryRefs: step.extracted.map((_, index) => `memory_mock_store_${index + 1}`),
            evidenceIds: step.extracted.map((_, index) => `evidence_mock_store_${index + 1}`),
            embeddingVersion: "mock-v1",
            summary: `保存 ${step.extracted.length} 条已引用证据`
          });
        }
        break;
      case "tool":
        await runToolStep(run, step);
        break;
      case "text":
        openMessage();
        // 多段 text 步骤需要累加，message.completed 要携带完整正文。
        fullText += step.chunks.join("");
        await streamText(run, messageId, step.chunks);
        break;
      case "citations":
        openMessage();
        for (const citation of step.items) {
          citations.push(citation);
          emit(run, "citation.created", { messageId, citation });
        }
        break;
      case "artifact": {
        const artifactId = newId("art");
        db().artifacts.set(artifactId, {
          id: artifactId,
          threadId: run.threadId,
          name: step.name,
          mimeType: step.mimeType,
          content: step.content
        });
        emit(run, "artifact.created", {
          artifact: {
            id: artifactId,
            name: step.name,
            kind: step.artifactKind,
            mimeType: step.mimeType,
            content: step.content,
            version: 1,
            createdAt: new Date().toISOString(),
            downloadUrl: `/api/v1/artifacts/${artifactId}`
          }
        });
        emit(run, "file.changed", {
          file: {
            id: artifactId,
            path: `outputs/${step.name}`,
            name: step.name,
            status: "created",
            language: "markdown",
            content: step.content,
            version: 1,
            downloadUrl: `/api/v1/artifacts/${artifactId}`
          }
        });
        break;
      }
      case "file": {
        const fileId = newId("file");
        db().artifacts.set(fileId, {
          id: fileId,
          threadId: run.threadId,
          name: step.name,
          mimeType: "text/plain",
          content: step.content
        });
        emit(run, "file.changed", {
          file: {
            id: fileId,
            path: step.path,
            name: step.name,
            status: "created",
            language: step.language,
            content: step.content,
            version: 1,
            downloadUrl: `/api/v1/files/${fileId}`
          }
        });
        break;
      }
      default:
        break;
    }
    await sleep(90);
  }

  if (run.cancelled) return;
  openMessage();
  emit(run, "message.completed", { messageId, text: fullText, citations });
  logStep(run, "info", "助手", "本轮处理完成");
  touchThread(thread, { status: "idle" });
  run.status = "completed";
  emit(run, "run.completed", { agentId: run.agent });
}

export function startRun(input: {
  thread: MockThread;
  message: string;
  modelId: string;
  reasoningEffort: ReasoningEffort;
  attachmentIds?: string[];
  replaceMessageId?: string | null;
}): { runId: string } {
  const { thread, message } = input;
  const agent: MockAgentId = "assistant";
  const runId = newId("run");
  const history = completedConversation(thread, input.replaceMessageId);
  if (input.replaceMessageId) {
    const targetRunIndex = thread.runIds.findIndex((existingRunId) => db().runs.get(existingRunId)?.events.some((event) => event.payload.messageId === input.replaceMessageId));
    if (targetRunIndex >= 0) {
      const archivedRunIds = thread.runIds.splice(targetRunIndex);
      archivedRunIds.forEach((existingRunId) => db().runs.delete(existingRunId));
      for (const [artifactId, artifact] of db().artifacts) if (artifact.threadId === thread.id) db().artifacts.delete(artifactId);
    }
  }
  const attachmentText = attachmentContext(thread, input.attachmentIds || []);
  const modelMessage = attachmentText ? `${message}\n\n${attachmentText}` : message;

  const run: MockRun = {
    id: runId,
    threadId: thread.id,
    projectId: thread.projectId,
    agent,
    status: "running",
    createdAt: new Date().toISOString(),
    events: [],
    subscribers: new Set(),
    cancelled: false,
    abortController: new AbortController(),
    pendingApprovals: new Map()
  };
  db().runs.set(runId, run);
  thread.runIds.push(runId);

  const attachments = (input.attachmentIds || [])
    .map((id) => thread.attachments.get(id))
    .filter((attachment): attachment is NonNullable<typeof attachment> => Boolean(attachment))
    .map(({ bytes: _bytes, ...attachment }) => attachment);

  touchThread(thread, {
    status: "running",
    lastUserMessageAt: new Date().toISOString(),
    title: thread.runIds.length === 1 ? message.trim().slice(0, 40) || thread.title : thread.title
  });

  emit(run, "run.created", { agentId: agent, agentName: AGENT_LABELS[agent] });

  const userMessageId = input.replaceMessageId || newId("msg");
  emit(run, "message.started", { messageId: userMessageId, role: "user", text: message, attachments });
  emit(run, "message.completed", { messageId: userMessageId, text: message, attachments });

  logStep(run, "info", "助手", "开始处理当前消息");

  void (async () => {
    if (process.env.WORKBENCH_LLM_MODE === "mock") return executeScript(run, thread, buildScript(message), message);
    const config = await loadRuntimeConfig();
    if (runtimeMode(config) === "mock") return executeScript(run, thread, buildScript(message), message);
    return executeModel(run, thread, config, [...history, { role: "user", content: modelMessage }], input.modelId, input.reasoningEffort);
  })().catch((error) => {
    if (run.cancelled) return;
    run.status = "failed";
    touchThread(thread, { status: "failed" });
    emit(run, "run.failed", { message: error instanceof Error ? error.message : "运行失败" });
  });

  return { runId };
}

export function stopRun(runId: string) {
  const run = db().runs.get(runId);
  if (!run) return null;
  if (["completed", "failed", "stopped"].includes(run.status)) return run.status;
  run.cancelled = true;
  run.status = "stopped";
  run.abortController.abort(new DOMException("用户停止运行", "AbortError"));
  for (const resolve of run.pendingApprovals.values()) resolve("deny");
  run.pendingApprovals.clear();
  const thread = db().threads.get(run.threadId);
  if (thread) touchThread(thread, { status: "idle" });
  emit(run, "run.cancelled", {});
  return run.status;
}

export function resolveApproval(approvalId: string, decision: "allow_once" | "always_allow" | "deny") {
  for (const run of db().runs.values()) {
    const resolver = run.pendingApprovals.get(approvalId);
    if (resolver) {
      resolver(decision);
      return true;
    }
  }
  return false;
}
