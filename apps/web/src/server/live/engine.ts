import type { ReasoningEffort } from "@/lib/agent-events/types";
import { loadRuntimeConfig } from "@/server/config/runtime-config";
import { requestSearchAgentStop } from "@/server/search-agent/client";
import { finalizeLiveRun, liveRun, prepareLiveRun, type LiveRunStatus } from "./store";

export async function startLiveRun(input: {
  visitorId: string;
  tenantId: string;
  threadId: string;
  message: string;
  modelId: string;
  reasoningEffort: ReasoningEffort;
  attachmentIds: string[];
  replaceMessageId?: string | null;
}) {
  const config = await loadRuntimeConfig();
  const model = config.provider.models.find((candidate) => candidate.id === input.modelId)
    ?? config.provider.models.find((candidate) => candidate.id === config.provider.defaultModel);
  if (!model) throw new Error("模型配置不可用");
  const reasoningEffort = model.reasoningEfforts.includes(input.reasoningEffort)
    ? input.reasoningEffort
    : model.defaultReasoningEffort;
  const prepared = await prepareLiveRun({
    ...input,
    agentId: "search-agent",
    modelId: model.id,
    reasoningEffort,
    memoryRecallItems: config.retention.projectMemoryRecallItems,
    memoryMaxChars: config.retention.projectMemoryMaxChars
  });
  return prepared ? { runId: prepared.run.id } : null;
}

const terminalStatus = (status: LiveRunStatus): status is Extract<LiveRunStatus, "completed" | "failed" | "stopped"> =>
  ["completed", "failed", "stopped"].includes(status);

async function currentTerminalStatus(visitorId: string, runId: string) {
  const current = await liveRun(visitorId, runId);
  return current && terminalStatus(current.status) ? current.status : null;
}

export async function stopLiveRun(
  visitorId: string,
  runId: string
): Promise<Extract<LiveRunStatus, "completed" | "failed" | "stopped"> | null> {
  const record = await liveRun(visitorId, runId);
  if (!record) return null;
  if (terminalStatus(record.status)) return record.status;

  // The durable transition clears the lease first, so an old Worker cannot
  // append events while the best-effort upstream stop request is in flight.
  const events = await finalizeLiveRun(record.run, "stopped", {});
  if (!events) return currentTerminalStatus(visitorId, runId);
  if (record.run.agentId === "search-agent") await requestSearchAgentStop(runId);
  return "stopped";
}
