import type { AgentDefinition, ModelDefinition, ToolDefinition } from "@/lib/agent-events/types";

export const AGENT_IDS = ["assistant"] as const;
export type MockAgentId = (typeof AGENT_IDS)[number];

export const TOOLS: ToolDefinition[] = [
  { id: "context_read", name: "上下文读取", description: "读取当前会话与附件中的必要信息。", group: "基础", requiresApproval: false },
  { id: "task_plan", name: "任务规划", description: "把复杂任务拆分为可执行步骤。", group: "基础", requiresApproval: false },
  { id: "calculator", name: "计算器", description: "执行精确的数值计算。", group: "基础", requiresApproval: false },
  { id: "code_runner", name: "代码运行", description: "运行受控代码并返回结果。", group: "开发", requiresApproval: true }
];

export const AGENTS: AgentDefinition[] = [
  {
    id: "assistant",
    name: "对话",
    description: "测试模式对话运行器。",
    toolIds: TOOLS.map((tool) => tool.id)
  }
];

export const MOCK_MODELS: ModelDefinition[] = [
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    description: "快速响应与日常任务。",
    reasoningEfforts: ["medium", "high"],
    defaultReasoningEffort: "medium"
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    description: "复杂任务与深度推理。",
    reasoningEfforts: ["medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "high"
  }
];

export const AGENT_LABELS: Record<MockAgentId, string> = { assistant: "对话" };
