import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const serviceSchema = z.object({
  origin: z.string().url(),
  requestTimeoutMs: z.number().int().min(5_000).max(600_000)
}).strict();

const searchAgentConfigSchema = z.object({
  version: z.literal(1),
  service: serviceSchema,
  graph: z.unknown(),
  search: z.unknown(),
  milvus: z.unknown(),
  pricing: z.unknown()
}).strict();

export type SearchAgentServiceConfig = {
  origin: string;
  requestTimeoutMs: number;
};

export class SearchAgentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchAgentConfigError";
  }
}

export function searchAgentConfigPath() {
  return process.env.SEARCH_AGENT_CONFIG_PATH
    ? path.resolve(process.env.SEARCH_AGENT_CONFIG_PATH)
    : path.resolve(process.cwd(), "..", "..", "config", "search-agent.json");
}

export function parseSearchAgentServiceConfig(input: unknown): SearchAgentServiceConfig {
  const parsed = searchAgentConfigSchema.safeParse(input);
  if (!parsed.success) throw new SearchAgentConfigError("Search Agent 配置格式无效");
  const configuredOrigin = process.env.WORKBENCH_SEARCH_AGENT_ORIGIN
    || process.env.SEARCH_AGENT_ORIGIN
    || parsed.data.service.origin;
  let origin: URL;
  try {
    origin = new URL(configuredOrigin);
  } catch {
    throw new SearchAgentConfigError("Search Agent 地址无效");
  }
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password) {
    throw new SearchAgentConfigError("Search Agent 地址协议无效");
  }
  const timeoutOverride = Number(process.env.WORKBENCH_SEARCH_AGENT_TIMEOUT_MS || "");
  return {
    origin: origin.href.replace(/\/$/u, ""),
    requestTimeoutMs: Number.isInteger(timeoutOverride) && timeoutOverride >= 5_000 && timeoutOverride <= 600_000
      ? timeoutOverride
      : parsed.data.service.requestTimeoutMs
  };
}

export async function loadSearchAgentServiceConfig(): Promise<SearchAgentServiceConfig> {
  let text: string;
  try {
    text = await readFile(searchAgentConfigPath(), "utf8");
  } catch {
    throw new SearchAgentConfigError("Search Agent 配置不存在或不可读取");
  }
  try {
    return parseSearchAgentServiceConfig(JSON.parse(text) as unknown);
  } catch (error) {
    if (error instanceof SearchAgentConfigError) throw error;
    throw new SearchAgentConfigError("Search Agent 配置不是有效 JSON");
  }
}
