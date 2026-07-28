"use client";

import { useState } from "react";
import type {
  V2ApprovalView,
  V2ClarificationView
} from "@/lib/agent-events/v2/process-view-model";
import type { V2PreviewInteractionRuntime } from "@/lib/agent-events/v2/use-v2-preview-interaction";

export function V2InterruptPanel({
  clarifications,
  approvals,
  interaction
}: {
  clarifications: readonly V2ClarificationView[];
  approvals: readonly V2ApprovalView[];
  interaction: V2PreviewInteractionRuntime | null;
}) {
  if (clarifications.length === 0 && approvals.length === 0) return null;
  return (
    <div className="min-w-0 space-y-3 border-t border-line pt-2.5" data-testid="v2-interrupt-panel">
      {clarifications.map((clarification) => (
        <ClarificationInput
          key={clarification.clarificationId}
          clarification={clarification}
          interaction={interaction}
        />
      ))}
      {approvals.map((approval) => (
        <ApprovalInput
          key={approval.approvalId}
          approval={approval}
          interaction={interaction}
        />
      ))}
    </div>
  );
}

function ClarificationInput({
  clarification,
  interaction
}: {
  clarification: V2ClarificationView;
  interaction: V2PreviewInteractionRuntime | null;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    const content = draft.trim();
    if (!content || busy || clarification.status !== "waiting" || !interaction) return;
    setBusy(true);
    setError("");
    const result = await interaction.resumeClarification({
      clarificationId: clarification.clarificationId,
      checkpointRef: clarification.checkpointRef,
      expectedStateRevision: clarification.stateRevision,
      content,
      attachmentRefs: []
    });
    if (result.status === "applied") setDraft("");
    else setError(result.errorCode === "CLARIFICATION_STALE_CHECKPOINT"
      ? "澄清检查点已变化，请重新读取后再提交"
      : result.errorCode === "RUN_TERMINAL"
        ? "任务已经结束，回答已保留"
        : "澄清回答未提交，内容已保留");
    setBusy(false);
  };

  return (
    <div
      className="min-w-0"
      data-clarification-id={clarification.clarificationId}
      data-clarification-status={clarification.status}
    >
      <div className="text-[13px] font-medium text-tertiary">需要澄清</div>
      <div className="mt-0.5 whitespace-normal break-words text-secondary">
        {clarification.question}
      </div>
      {clarification.status === "waiting" ? (
        <div className="mt-2 flex min-w-0 flex-col gap-2 sm:flex-row sm:items-end">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={busy || !interaction}
            rows={2}
            maxLength={4000}
            className="min-h-16 min-w-0 flex-1 resize-y rounded-md border border-line bg-surface px-3 py-2 text-[14px] leading-5 text-ink outline-none focus:border-[#aaa]"
            aria-label="澄清回答"
          />
          <button
            type="button"
            className="quiet-button shrink-0"
            disabled={!draft.trim() || busy || !interaction}
            aria-label="提交澄清回答"
            aria-busy={busy}
            onClick={() => void submit()}
          >
            {busy ? "提交中" : "提交回答"}
          </button>
        </div>
      ) : (
        <div className="mt-1 text-[13px] text-tertiary">
          {clarification.status === "resumed" ? "已提交回答" : "任务已停止，无法继续回答"}
        </div>
      )}
      <div className="mt-1 min-h-5 text-[13px] text-danger" aria-live="polite">
        {error}
      </div>
    </div>
  );
}

function ApprovalInput({
  approval,
  interaction
}: {
  approval: V2ApprovalView;
  interaction: V2PreviewInteractionRuntime | null;
}) {
  const [busy, setBusy] = useState<"allow_once" | "deny" | null>(null);
  const [error, setError] = useState("");
  const decide = async (decision: "allow_once" | "deny") => {
    if (busy || approval.status !== "waiting" || !interaction) return;
    setBusy(decision);
    setError("");
    const result = await interaction.decideApproval({
      approvalId: approval.approvalId,
      toolCallId: approval.toolCallId,
      decision
    });
    if (result.status !== "applied") {
      setError(result.errorCode === "RUN_TERMINAL"
        ? "任务已经结束，无法提交审批"
        : "审批决定未提交，请重试");
    }
    setBusy(null);
  };

  return (
    <div
      className="min-w-0"
      data-approval-id={approval.approvalId}
      data-approval-status={approval.status}
    >
      <div className="text-[13px] font-medium text-tertiary">权限确认</div>
      <div className="mt-0.5 whitespace-normal break-words text-secondary">
        {approval.actionSummary}
      </div>
      <div className="text-[13px] text-tertiary">{approval.permissionSummary}</div>
      {approval.status === "waiting" ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            className="quiet-button"
            disabled={Boolean(busy) || !interaction}
            aria-label="仅允许本次工具操作"
            aria-busy={busy === "allow_once"}
            onClick={() => void decide("allow_once")}
          >
            {busy === "allow_once" ? "提交中" : "仅允许本次"}
          </button>
          <button
            type="button"
            className="quiet-button text-danger"
            disabled={Boolean(busy) || !interaction}
            aria-label="拒绝工具操作"
            aria-busy={busy === "deny"}
            onClick={() => void decide("deny")}
          >
            {busy === "deny" ? "提交中" : "拒绝"}
          </button>
        </div>
      ) : (
        <div className="mt-1 text-[13px] text-tertiary">
          {approval.status === "allowed"
            ? "已允许本次"
            : approval.status === "denied"
              ? "已拒绝"
              : "等待调整或重新确认"}
        </div>
      )}
      <div className="mt-1 min-h-5 text-[13px] text-danger" aria-live="polite">
        {error}
      </div>
    </div>
  );
}
