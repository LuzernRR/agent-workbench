import { describe, expect, it } from "vitest";
import { parseRuntimeConfig, publicModelDefinitions, RuntimeConfigError } from "./runtime-config";

const validConfig = {
  version: 1,
  runtime: { mode: "live" },
  provider: {
    type: "deepseek",
    apiKey: "sk-test-key-not-real",
    endpoint: "https://api.deepseek.com/chat/completions",
    defaultModel: "deepseek-v4-flash",
    models: [{
      id: "deepseek-v4-flash",
      name: "快速模型",
      description: "快速响应",
      reasoningEfforts: ["medium", "high"],
      defaultReasoningEffort: "medium"
    }],
    request: { timeoutMs: 30_000, maxRetries: 2 }
  },
  generation: { temperature: 0.6, maxTokens: 1024, thinkingEnabled: true },
  assistant: { systemPrompt: "使用中文回答。" }
};

describe("统一运行配置", () => {
  it("校验配置并只公开模型字段", () => {
    const config = parseRuntimeConfig(validConfig);
    expect(publicModelDefinitions(config)).toEqual([{
      id: "deepseek-v4-flash",
      name: "快速模型",
      description: "快速响应",
      reasoningEfforts: ["medium", "high"],
      defaultReasoningEffort: "medium"
    }]);
    expect(publicModelDefinitions(config)[0]).not.toHaveProperty("apiKey");
  });

  it("拒绝非对话接口和未知默认模型", () => {
    expect(() => parseRuntimeConfig({
      ...validConfig,
      provider: { ...validConfig.provider, endpoint: "https://api.deepseek.com/models" }
    })).toThrow(RuntimeConfigError);
    expect(() => parseRuntimeConfig({
      ...validConfig,
      provider: { ...validConfig.provider, defaultModel: "missing-model" }
    })).toThrow("默认模型未在模型列表中定义");
  });
});

