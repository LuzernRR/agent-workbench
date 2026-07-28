import type { RunStatus, TimelineItem } from "@/lib/agent-events/types";
import type {
  V2ProcessItem,
  V2RunState,
  V2GuidanceState,
  V2ToolActivityState
} from "./run-reducer";
import type { V2ReasonCode } from "./types";
import type { V2AgentEvent } from "./types";

export const S01_PROCESS_SCENARIOS = [
  "active",
  "direct",
  "complex",
  "verification_failed",
  "partial",
  "waiting",
  "failed",
  "stopped",
  "tool_success",
  "tool_parallel",
  "tool_progress",
  "tool_retrying",
  "tool_waiting_approval",
  "tool_approval_decided",
  "tool_empty",
  "tool_failed",
  "tool_unknown",
  "tool_long",
  "composer_active",
  "guidance_pending",
  "guidance_applied",
  "guidance_superseded",
  "guidance_revision_conflict",
  "guidance_failed",
  "guidance_terminal_rejected",
  "clarification_waiting",
  "clarification_resumed",
  "clarification_stopped",
  "approval_waiting",
  "approval_allowed",
  "approval_denied",
  "approval_edit_readonly"
] as const;

export type S01ProcessScenario = (typeof S01_PROCESS_SCENARIOS)[number];

export interface S01ProcessFixtureCatalog {
  readonly schemaVersion: "2.0";
  readonly source: "fixture";
  readonly mode: "mock";
  readonly selectedScenario: S01ProcessScenario;
  readonly states: Readonly<Record<S01ProcessScenario, V2RunState>>;
  readonly stopTerminalTemplate: V2AgentEvent<"run.cancelled">;
}

export interface V2ProcessEntryView {
  readonly id: string;
  readonly kind: "node" | "plan";
  readonly seq: number;
  readonly text: string;
}

export interface V2VerificationView {
  readonly status: "passed" | "failed" | "partial";
  readonly text: string | null;
  readonly reasonCodes: readonly V2ReasonCode[];
  readonly seq: number;
}

export type V2ToolActivityView = V2ToolActivityState;
export type V2GuidanceView = V2GuidanceState;

export interface V2ClarificationView {
  readonly clarificationId: string;
  readonly checkpointRef: string;
  readonly question: string;
  readonly stateRevision: number;
  readonly status: "waiting" | "resumed" | "stopped";
  readonly seq: number;
}

export interface V2ApprovalView {
  readonly approvalId: string;
  readonly toolCallId: string;
  readonly actionSummary: string;
  readonly permissionSummary: string;
  readonly status: "waiting" | "allowed" | "denied" | "edit_readonly";
  readonly seq: number;
}

export interface V2ProcessViewModel {
  readonly runId: string;
  readonly source: "live" | "fixture" | null;
  readonly status: "active" | "completed" | "failed" | "cancelled" | "waiting";
  readonly defaultOpen: boolean;
  readonly entries: readonly V2ProcessEntryView[];
  readonly tools: readonly V2ToolActivityView[];
  readonly guidance: readonly V2GuidanceView[];
  readonly clarifications: readonly V2ClarificationView[];
  readonly approvals: readonly V2ApprovalView[];
  readonly verification: V2VerificationView | null;
  readonly finalAnswerVisible: boolean;
}

function publicParagraph(item: V2ProcessItem) {
  const text = item.publicText?.trim();
  return text ? text : null;
}

function latestVerificationItem(state: V2RunState) {
  return state.processOrder
    .map((id) => state.processById[id])
    .filter((item): item is V2ProcessItem =>
      Boolean(item)
      && item.type === "verification.completed"
      && item.inputRevision === state.latestInputRevision
    )
    .sort((left, right) => right.seq - left.seq)[0] ?? null;
}

function processStatus(state: V2RunState): V2ProcessViewModel["status"] {
  if (state.terminal === "completed") return "completed";
  if (state.terminal === "failed") return "failed";
  if (state.terminal === "cancelled") return "cancelled";
  if (Object.values(state.clarifications).some((item) => item.status === "waiting")) return "waiting";
  if (Object.values(state.toolCalls).some((item) => item.status === "waiting_approval")) return "waiting";
  if (["waiting", "waiting_approval", "waiting_clarification"].includes(state.runStatus)) return "waiting";
  return "active";
}

function verificationView(state: V2RunState): V2VerificationView | null {
  const item = latestVerificationItem(state);
  if (!item) return null;
  const result = state.verificationsByRevision[item.inputRevision];
  if (!result || result.seq !== item.seq) return null;
  const reasonCodes = item.reasonCodes;
  const partial = state.terminalResponseStatus === "partial"
    || reasonCodes.some((code) => [
      "partial",
      "budget_exhausted",
      "insufficient_evidence",
      "conflicting_evidence"
    ].includes(code));
  return {
    status: result.passed ? "passed" : partial ? "partial" : "failed",
    text: publicParagraph(item),
    reasonCodes,
    seq: item.seq
  };
}

export function projectV2ProcessView(state: V2RunState): V2ProcessViewModel {
  const entries: V2ProcessEntryView[] = state.processOrder
    .map((id) => state.processById[id])
    .filter((item): item is V2ProcessItem =>
      Boolean(item)
      && item.type === "node.completed"
      && item.inputRevision === state.latestInputRevision
      && Boolean(publicParagraph(item))
    )
    .map((item) => ({
      id: item.id,
      kind: "node",
      seq: item.seq,
      text: publicParagraph(item)!
    }));

  if (
    state.plan
    && state.plan.inputRevision === state.latestInputRevision
    && state.plan.publicText?.trim()
  ) {
    entries.push({
      id: `plan:${state.plan.planRef}`,
      kind: "plan",
      seq: state.plan.seq,
      text: state.plan.publicText.trim()
    });
  }
  entries.sort((left, right) => left.seq - right.seq);
  const tools = state.toolOrder
    .map((toolCallId) => state.toolCalls[toolCallId])
    .filter((tool): tool is V2ToolActivityState =>
      Boolean(tool) && tool.inputRevision === state.latestInputRevision
    );
  const guidance = state.guidanceOrder
    .map((commandId) => state.guidanceCommands[commandId])
    .filter((item): item is V2GuidanceState => Boolean(item))
    .sort((left, right) => left.commandSeq - right.commandSeq);
  const clarifications = Object.entries(state.clarifications)
    .map(([clarificationId, item]) => ({
      clarificationId,
      checkpointRef: item.checkpointRef,
      question: item.question,
      stateRevision: item.stateRevision,
      status: state.terminal && item.status === "waiting"
        ? "stopped" as const
        : item.status,
      seq: item.seq
    }))
    .sort((left, right) => left.seq - right.seq);
  const approvals = state.toolOrder
    .map((toolCallId) => state.toolCalls[toolCallId])
    .filter((tool): tool is V2ToolActivityState => Boolean(tool?.approvalId))
    .map((tool) => ({
      approvalId: tool.approvalId!,
      toolCallId: tool.toolCallId,
      actionSummary: tool.actionSummary ?? "",
      permissionSummary: tool.permissionSummary ?? "",
      status: tool.approvalDecision === "allow_once"
        ? "allowed" as const
        : tool.approvalDecision === "deny"
          ? "denied" as const
          : tool.approvalDecision === "edit"
            ? "edit_readonly" as const
            : "waiting" as const,
      seq: tool.lastSeq
    }));

  const verification = verificationView(state);
  const terminalResponse = state.terminalResponseId
    ? state.verifiedResponses[state.terminalResponseId]
    : null;
  const finalAnswerVisible = state.terminal === "completed"
    && Boolean(verification)
    && Boolean(terminalResponse)
    && terminalResponse?.inputRevision === state.latestInputRevision
    && (verification?.status === "passed" || verification?.status === "partial");
  const status = processStatus(state);
  return {
    runId: state.runId,
    source: state.source,
    status,
    defaultOpen: status !== "completed",
    entries,
    tools,
    guidance,
    clarifications,
    approvals,
    verification,
    finalAnswerVisible
  };
}

export function selectS01ProcessFixtureState(
  catalog: S01ProcessFixtureCatalog,
  runStatus: RunStatus | undefined
) {
  if (runStatus === "queued" || runStatus === "running" || runStatus === "reconnecting") {
    return catalog.states.active;
  }
  if (runStatus === "waiting") return catalog.states.waiting;
  if (runStatus === "stopped") return catalog.states.stopped;
  if (runStatus === "failed" && catalog.selectedScenario !== "verification_failed") {
    return catalog.states.failed;
  }
  return catalog.states[catalog.selectedScenario];
}

export function isLegacyTimelineItemVisibleInS01Preview(
  item: TimelineItem,
  anchorRunId: string
) {
  if (item.runId !== anchorRunId) return true;
  return item.kind === "message" && item.role === "user";
}
