import type { ReasoningEffort } from "@/lib/agent-events/types";
import type { AgentRuntimeConfig } from "@/server/config/runtime-config";

export type DeepSeekChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type DeepSeekStreamResult = {
  text: string;
  finishReason: string | null;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
};

export class DeepSeekApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "DeepSeekApiError";
  }
}

type StreamInput = {
  config: AgentRuntimeConfig;
  modelId: string;
  reasoningEffort: ReasoningEffort;
  messages: DeepSeekChatMessage[];
  requestId: string;
  signal?: AbortSignal;
  onDelta: (delta: string) => void | Promise<void>;
};

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function safeApiError(status: number) {
  if (status === 400) return "模型请求参数无效";
  if (status === 401 || status === 403) return "模型密钥无效或无权访问";
  if (status === 402) return "模型账户余额不足";
  if (status === 404) return "配置的模型或接口不存在";
  if (status === 422) return "模型无法处理当前请求";
  if (status === 429) return "模型请求过于频繁，请稍后重试";
  if (status >= 500) return "模型服务暂时不可用";
  return `模型请求失败（${status}）`;
}

function requestSignal(external: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(external?.reason);
  if (external?.aborted) abort();
  else external?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("模型请求超时", "TimeoutError"));
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener("abort", abort);
    }
  };
}

function retryDelay(response: Response, attempt: number) {
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 10_000);
  return Math.min(500 * (2 ** attempt), 4_000);
}

const wait = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const onAbort = () => {
    clearTimeout(timer);
    reject(signal?.reason);
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  signal?.addEventListener("abort", onAbort, { once: true });
});

export async function streamDeepSeekChat(input: StreamInput): Promise<DeepSeekStreamResult> {
  const model = input.config.provider.models.find((candidate) => candidate.id === input.modelId)
    || input.config.provider.models.find((candidate) => candidate.id === input.config.provider.defaultModel);
  if (!model) throw new DeepSeekApiError("模型配置不可用");
  const reasoningEffort = model.reasoningEfforts.includes(input.reasoningEffort)
    ? input.reasoningEffort
    : model.defaultReasoningEffort;

  const payload = {
    model: model.id,
    messages: input.messages,
    stream: true,
    stream_options: { include_usage: true },
    temperature: input.config.generation.temperature,
    max_tokens: input.config.generation.maxTokens,
    thinking: { type: input.config.generation.thinkingEnabled ? "enabled" : "disabled" },
    reasoning_effort: reasoningEffort
  };

  for (let attempt = 0; attempt <= input.config.provider.request.maxRetries; attempt += 1) {
    const activeSignal = requestSignal(input.signal, input.config.provider.request.timeoutMs);
    let receivedContent = false;
    try {
      const response = await fetch(input.config.provider.endpoint, {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          authorization: `Bearer ${input.config.provider.apiKey}`,
          "content-type": "application/json; charset=utf-8",
          "x-client-request-id": input.requestId
        },
        body: JSON.stringify(payload),
        cache: "no-store",
        signal: activeSignal.signal
      });

      if (!response.ok) {
        if (RETRYABLE_STATUS.has(response.status) && attempt < input.config.provider.request.maxRetries) {
          const delay = retryDelay(response, attempt);
          await response.body?.cancel();
          activeSignal.cleanup();
          await wait(delay, input.signal);
          continue;
        }
        throw new DeepSeekApiError(safeApiError(response.status), response.status);
      }
      if (!response.body) throw new DeepSeekApiError("模型未返回流式响应");
      return await consumeDeepSeekSse(response.body, async (delta) => {
        receivedContent = true;
        await input.onDelta(delta);
      }, activeSignal.signal);
    } catch (error) {
      if (input.signal?.aborted) throw error;
      if (activeSignal.timedOut()) throw new DeepSeekApiError("模型响应超时");
      if (error instanceof DeepSeekApiError) throw error;
      if (receivedContent) throw new DeepSeekApiError("模型流式响应意外中断");
      if (attempt < input.config.provider.request.maxRetries) {
        await wait(Math.min(500 * (2 ** attempt), 4_000), input.signal);
        continue;
      }
      throw new DeepSeekApiError("无法连接模型服务");
    } finally {
      activeSignal.cleanup();
    }
  }
  throw new DeepSeekApiError("模型请求失败");
}

export async function consumeDeepSeekSse(body: ReadableStream<Uint8Array>, onDelta: StreamInput["onDelta"], signal?: AbortSignal): Promise<DeepSeekStreamResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let finishReason: string | null = null;
  let usage: DeepSeekStreamResult["usage"] = null;
  let completed = false;

  const consumeBlock = async (block: string) => {
    const data = block.split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data) return;
    if (data === "[DONE]") {
      completed = true;
      return;
    }

    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(data) as Record<string, unknown>;
    } catch {
      throw new DeepSeekApiError("模型返回了无法解析的数据");
    }
    if (chunk.error) throw new DeepSeekApiError("模型流式响应失败");
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const choice = choices[0] && typeof choices[0] === "object" ? choices[0] as Record<string, unknown> : null;
    const delta = choice?.delta && typeof choice.delta === "object" ? choice.delta as Record<string, unknown> : null;
    const content = typeof delta?.content === "string" ? delta.content : "";
    if (content) {
      text += content;
      await onDelta(content);
    }
    if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
    if (chunk.usage && typeof chunk.usage === "object") {
      const raw = chunk.usage as Record<string, unknown>;
      usage = {
        promptTokens: typeof raw.prompt_tokens === "number" ? raw.prompt_tokens : 0,
        completionTokens: typeof raw.completion_tokens === "number" ? raw.completion_tokens : 0,
        totalTokens: typeof raw.total_tokens === "number" ? raw.total_tokens : 0
      };
    }
  };

  try {
    while (!completed) {
      if (signal?.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const boundary = buffer.match(/\r?\n\r?\n/u);
        if (!boundary || boundary.index === undefined) break;
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        await consumeBlock(block);
        if (completed) break;
      }
    }
    buffer += decoder.decode();
    if (!completed && buffer.trim()) await consumeBlock(buffer);
  } finally {
    reader.releaseLock();
  }

  if (!completed) throw new DeepSeekApiError("模型流式响应意外中断");
  if (!text.trim()) throw new DeepSeekApiError("模型没有返回可显示内容");
  return { text, finishReason, usage };
}
