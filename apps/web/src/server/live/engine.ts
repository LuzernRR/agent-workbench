import type { ReasoningEffort } from "@/lib/agent-events/types";
import { loadRuntimeConfig } from "@/server/config/runtime-config";
import { requestSearchAgentStop } from "@/server/search-agent/client";
import {
  createUserStoppedPayload,
  finalizeLiveRun,
  liveRun,
  prepareLiveRun,
  requestLiveRunStop,
  type LiveRunStatus
} from "./store";

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

export type StopLiveRunStatus = Extract<LiveRunStatus, "completed" | "failed" | "stopped"> | "stopping";

async function currentTerminalStatus(visitorId: string, runId: string) {
  const current = await liveRun(visitorId, runId);
  return current && terminalStatus(current.status) ? current.status : null;
}

export async function stopLiveRun(
  visitorId: string,
  runId: string
): Promise<StopLiveRunStatus | null> {
  const record = await requestLiveRunStop(visitorId, runId);
  if (!record) return null;
  if (terminalStatus(record.status)) return record.status;

  // An active lease owns terminal settlement. The HTTP request only persists
  // intent and gives the upstream a bounded best-effort nudge; the Worker keeps
  // draining until it can atomically commit the authoritative stopped usage.
  if (record.hasActiveLease) {
    if (record.run.agentId === "search-agent") await requestSearchAgentStop(runId);
    return "stopping";
  }
  const events = await finalizeLiveRun(record.run, "stopped", createUserStoppedPayload());
  if (!events) return await currentTerminalStatus(visitorId, runId) ?? "stopping";
  return "stopped";
}
