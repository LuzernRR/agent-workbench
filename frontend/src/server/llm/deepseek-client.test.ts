import { afterEach, describe, expect, it, vi } from "vitest";
import { consumeDeepSeekSse, DeepSeekApiError, streamDeepSeekChat } from "./deepseek-client";
import { parseRuntimeConfig } from "@/server/config/runtime-config";

function stream(parts: string[]) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      parts.forEach((part) => controller.enqueue(encoder.encode(part)));
      controller.close();
    }
  });
}

const config = parseRuntimeConfig({
  version: 1,
  runtime: { mode: "live" },
  provider: {
    type: "deepseek",
    apiKey: "sk-test-key-not-real",
    endpoint: "https://api.deepseek.com/chat/completions",
    defaultModel: "deepseek-v4-flash",
    models: [{ id: "deepseek-v4-flash", name: "快速模型", description: "快速响应", reasoningEfforts: ["medium", "high"], defaultReasoningEffort: "medium" }],
    request: { timeoutMs: 30_000, maxRetries: 0 }
  },
  retention: { threadTtlDays: 3, cleanupIntervalMinutes: 15, projectMemoryMaxItems: 120, projectMemoryRecallItems: 24, projectMemoryMaxChars: 16_000 },
  generation: { temperature: 0.6, maxTokens: 1024, thinkingEnabled: true },
  assistant: { systemPrompt: "使用中文回答。" }
});

afterEach(() => vi.unstubAllGlobals());

describe("DeepSeek 流式客户端", () => {
  it("跨网络分块解析文本、结束原因和用量", async () => {
    const deltas: string[] = [];
    const result = await consumeDeepSeekSse(stream([
      "data: {\"choices\":[{\"delta\":{\"content\":\"连接\"}}]}\r\n\r",
      "\ndata: {\"choices\":[{\"delta\":{\"content\":\"成功\"},\"finish_reason\":\"stop\"}]}\n\n",
      "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2,\"total_tokens\":5}}\n\n",
      "data: [DONE]\n\n"
    ]), (delta) => { deltas.push(delta); });

    expect(deltas).toEqual(["连接", "成功"]);
    expect(result).toEqual({
      text: "连接成功",
      finishReason: "stop",
      usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 }
    });
  });

  it("拒绝未正常结束的响应流", async () => {
    await expect(consumeDeepSeekSse(stream([
      "data: {\"choices\":[{\"delta\":{\"content\":\"半段回复\"}}]}\n\n"
    ]), () => undefined)).rejects.toThrow("模型流式响应意外中断");
  });

  it("发送统一配置并转发增量文本", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(stream([
      "data: {\"choices\":[{\"delta\":{\"content\":\"收到\"},\"finish_reason\":\"stop\"}]}\n\n",
      "data: [DONE]\n\n"
    ]), { status: 200, headers: { "content-type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetchMock);
    const deltas: string[] = [];
    const result = await streamDeepSeekChat({
      config,
      modelId: "deepseek-v4-flash",
      reasoningEffort: "medium",
      messages: [{ role: "user", content: "测试" }],
      requestId: "run-test",
      onDelta: (delta) => { deltas.push(delta); }
    });

    const request = fetchMock.mock.calls[0][1] as RequestInit;
    const payload = JSON.parse(String(request.body));
    expect(payload).toMatchObject({ model: "deepseek-v4-flash", stream: true, reasoning_effort: "medium" });
    expect((request.headers as Record<string, string>).authorization).toBe("Bearer sk-test-key-not-real");
    expect(deltas).toEqual(["收到"]);
    expect(result.text).toBe("收到");
  });

  it("将鉴权错误转换为安全中文信息", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 401 })));
    await expect(streamDeepSeekChat({
      config,
      modelId: "deepseek-v4-flash",
      reasoningEffort: "medium",
      messages: [{ role: "user", content: "测试" }],
      requestId: "run-test",
      onDelta: () => undefined
    })).rejects.toEqual(expect.objectContaining<Partial<DeepSeekApiError>>({ message: "模型密钥无效或无权访问", status: 401 }));
  });
});
