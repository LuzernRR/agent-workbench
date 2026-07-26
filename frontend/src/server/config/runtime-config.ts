import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ModelDefinition, ReasoningEffort } from "@/lib/agent-events/types";

const reasoningEffortSchema = z.enum(["medium", "high", "xhigh", "max"]);
const modelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  reasoningEfforts: z.array(reasoningEffortSchema).min(1),
  defaultReasoningEffort: reasoningEffortSchema
}).strict();

const runtimeConfigSchema = z.object({
  version: z.literal(1),
  runtime: z.object({ mode: z.enum(["live", "mock"]) }).strict(),
  provider: z.object({
    type: z.literal("deepseek"),
    apiKey: z.string().min(10),
    endpoint: z.string().url(),
    defaultModel: z.string().min(1),
    models: z.array(modelSchema).min(1),
    request: z.object({
      timeoutMs: z.number().int().min(5_000).max(300_000),
      maxRetries: z.number().int().min(0).max(5)
    }).strict()
  }).strict(),
  generation: z.object({
    temperature: z.number().min(0).max(2),
    maxTokens: z.number().int().min(1).max(16_384),
    thinkingEnabled: z.boolean()
  }).strict(),
  assistant: z.object({ systemPrompt: z.string().min(1).max(20_000) }).strict()
}).strict();

export type AgentRuntimeConfig = z.infer<typeof runtimeConfigSchema>;

export class RuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeConfigError";
  }
}

export function runtimeConfigPath() {
  return process.env.AGENT_RUNTIME_CONFIG_PATH
    ? path.resolve(process.env.AGENT_RUNTIME_CONFIG_PATH)
    : path.resolve(process.cwd(), "..", "config", "agent-runtime.local.json");
}

export function parseRuntimeConfig(input: unknown): AgentRuntimeConfig {
  const parsed = runtimeConfigSchema.safeParse(input);
  if (!parsed.success) throw new RuntimeConfigError("统一配置文件格式无效");

  const config = parsed.data;
  const endpoint = new URL(config.provider.endpoint);
  if (!["http:", "https:"].includes(endpoint.protocol)) throw new RuntimeConfigError("模型接口协议无效");
  if (!endpoint.pathname.replace(/\/$/u, "").endsWith("/chat/completions")) {
    throw new RuntimeConfigError("模型接口必须指向 chat/completions");
  }
  const defaultModel = config.provider.models.find((model) => model.id === config.provider.defaultModel);
  if (!defaultModel) throw new RuntimeConfigError("默认模型未在模型列表中定义");
  if (!defaultModel.reasoningEfforts.includes(defaultModel.defaultReasoningEffort)) {
    throw new RuntimeConfigError("默认推理强度未在模型能力中定义");
  }
  return config;
}

export async function loadRuntimeConfig(): Promise<AgentRuntimeConfig> {
  let text: string;
  try {
    text = await readFile(runtimeConfigPath(), "utf8");
  } catch {
    throw new RuntimeConfigError("统一配置文件不存在或不可读取");
  }
  try {
    return parseRuntimeConfig(JSON.parse(text) as unknown);
  } catch (error) {
    if (error instanceof RuntimeConfigError) throw error;
    throw new RuntimeConfigError("统一配置文件不是有效 JSON");
  }
}

export function publicModelDefinitions(config: AgentRuntimeConfig): ModelDefinition[] {
  return config.provider.models.map((model) => ({
    id: model.id,
    name: model.name,
    description: model.description,
    reasoningEfforts: [...model.reasoningEfforts] as ReasoningEffort[],
    defaultReasoningEffort: model.defaultReasoningEffort as ReasoningEffort
  }));
}

export function runtimeMode(config: AgentRuntimeConfig) {
  return process.env.WORKBENCH_LLM_MODE === "mock" ? "mock" : config.runtime.mode;
}
