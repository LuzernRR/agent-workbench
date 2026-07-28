import { describe, expect, it } from "vitest";
import { applyRuntimeEnvironment, parseRuntimeConfig, publicModelDefinitions, requireDatabaseConfig, RuntimeConfigError } from "./runtime-config";

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
      name: "DeepSeek V4 Flash",
      description: "快速响应",
      reasoningEfforts: ["medium", "high"],
      defaultReasoningEffort: "medium"
    }],
    request: { timeoutMs: 30_000, maxRetries: 2 }
  },
  database: { url: "postgresql://workbench:secret@127.0.0.1:5432/agent_workbench", ssl: false, poolMax: 10 },
  session: { cookieName: "workbench_visitor", ttlDays: 365 },
  retention: { threadTtlDays: 3, cleanupIntervalMinutes: 15, projectMemoryMaxItems: 120, projectMemoryRecallItems: 24, projectMemoryMaxChars: 16_000 },
  generation: { temperature: 0.6, maxTokens: 1024, thinkingEnabled: true },
  assistant: { systemPrompt: "使用中文回答。" }
};

describe("统一运行配置", () => {
  it("校验配置并只公开模型字段", () => {
    const config = parseRuntimeConfig(validConfig);
    expect(publicModelDefinitions(config)).toEqual([{
      id: "deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      description: "快速响应",
      reasoningEfforts: ["medium", "high"],
      defaultReasoningEffort: "medium"
    }]);
    expect(publicModelDefinitions(config)[0]).not.toHaveProperty("apiKey");
    expect(requireDatabaseConfig(config)).toEqual(validConfig.database);
    expect(config.retention.threadTtlDays).toBe(3);
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

  it("仅在服务端以显式环境变量覆盖容器数据库地址", () => {
    const config = applyRuntimeEnvironment(parseRuntimeConfig(validConfig), {
      WORKBENCH_DATABASE_URL: "postgresql://workbench:secret@postgres:5432/agent_workbench",
      WORKBENCH_DATABASE_SSL: "false",
      WORKBENCH_DATABASE_POOL_MAX: "16"
    });
    expect(requireDatabaseConfig(config)).toEqual({
      url: "postgresql://workbench:secret@postgres:5432/agent_workbench",
      ssl: false,
      poolMax: 16
    });
    expect(() => applyRuntimeEnvironment(parseRuntimeConfig(validConfig), {
      WORKBENCH_DATABASE_SSL: "sometimes"
    })).toThrow("WORKBENCH_DATABASE_SSL");
  });
});
