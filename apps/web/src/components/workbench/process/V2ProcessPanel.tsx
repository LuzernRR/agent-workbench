"use client";

import { useLayoutEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { V2RunState } from "@/lib/agent-events/v2/run-reducer";
import { projectV2ProcessView } from "@/lib/agent-events/v2/process-view-model";
import type { V2ReasonCode } from "@/lib/agent-events/v2/types";
import {
  readV2ProcessOpenPreference,
  writeV2ProcessOpenPreference
} from "@/lib/agent-events/v2/process-panel-preference";
import { V2ToolActivityList } from "./V2ToolActivityRow";
import { V2GuidanceList } from "./V2GuidanceList";
import { V2InterruptPanel } from "./V2InterruptPanel";
import type { V2PreviewInteractionRuntime } from "@/lib/agent-events/v2/use-v2-preview-interaction";

const statusLabels = {
  active: "执行中",
  completed: "已完成",
  failed: "未完成",
  cancelled: "已停止",
  waiting: "等待中"
} as const;

const verificationLabels = {
  passed: "核验通过",
  failed: "核验未通过",
  partial: "部分核验"
} as const;

const verificationReasonLabels: Record<V2ReasonCode, string> = {
  direct_answer: "直接回答",
  search_required: "需要搜索",
  missing_critical_field: "缺少关键信息",
  freshness_required: "需要最新信息",
  source_policy: "来源策略限制",
  insufficient_evidence: "证据不足",
  conflicting_evidence: "来源冲突",
  unsupported_claim: "结论缺少支持",
  user_cancelled: "用户已停止",
  budget_exhausted: "预算已耗尽",
  provider_error: "模型服务异常",
  schema_invalid: "结果结构无效",
  tool_error: "工具执行异常",
  verification_failed: "核验未通过",
  completed: "核验完成",
  partial: "仅部分完成"
};

export function V2ProcessPanel({
  state,
  preferenceRunId = state.runId,
  interaction = null
}: {
  state: V2RunState;
  preferenceRunId?: string;
  interaction?: V2PreviewInteractionRuntime | null;
}) {
  const model = useMemo(() => projectV2ProcessView(state), [state]);
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);

  useLayoutEffect(() => {
    // Restore the persisted disclosure state before paint to avoid an open/closed flash.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setManualOpen(readV2ProcessOpenPreference(preferenceRunId));
  }, [preferenceRunId]);

  const open = manualOpen ?? model.defaultOpen;
  const toggle = () => {
    const next = !open;
    setManualOpen(next);
    writeV2ProcessOpenPreference(preferenceRunId, next);
  };
  const hasDetails = model.entries.length > 0
    || model.tools.length > 0
    || model.guidance.length > 0
    || model.clarifications.length > 0
    || model.approvals.length > 0
    || Boolean(model.verification);

  return (
    <section
      className="conversation-lane workbench-disclosure-row text-[15px] leading-6 text-secondary"
      data-testid="v2-process-panel"
      data-run-id={preferenceRunId}
      data-source={model.source ?? "unknown"}
    >
      <button
        type="button"
        className="workbench-disclosure-trigger flex w-full min-w-0 items-center gap-2 text-left text-secondary hover:text-ink"
        data-workbench-disclosure-trigger
        aria-expanded={open}
        aria-label={open ? "收起执行过程" : "展开执行过程"}
        onClick={toggle}
      >
        {open
          ? <ChevronDown className="size-4 shrink-0" aria-hidden="true" />
          : <ChevronRight className="size-4 shrink-0" aria-hidden="true" />}
        <span className="font-medium text-ink">执行过程</span>
        <span className="text-[13px] text-tertiary" aria-live="polite">{statusLabels[model.status]}</span>
        {model.source === "fixture"
          ? <span className="ml-auto shrink-0 text-[12px] text-tertiary">测试数据</span>
          : null}
      </button>

      {open && hasDetails ? (
        <div className="ml-2 mt-1 space-y-3 border-l border-line pl-4">
          {model.entries.map((entry) => (
            <div key={entry.id} className="min-w-0" data-process-kind={entry.kind}>
              {entry.kind === "plan"
                ? <div className="mb-0.5 text-[13px] text-tertiary">计划</div>
                : null}
              <p className="whitespace-normal break-words text-pretty text-secondary">{entry.text}</p>
            </div>
          ))}
          <V2GuidanceList guidance={model.guidance} />
          <V2ToolActivityList tools={model.tools} />
          <V2InterruptPanel
            clarifications={model.clarifications}
            approvals={model.approvals}
            interaction={interaction}
          />
          {model.verification ? (
            <div className="min-w-0 border-t border-line pt-2.5" data-verification-status={model.verification.status}>
              <div className="text-[13px] font-medium text-tertiary">
                {verificationLabels[model.verification.status]}
              </div>
              {model.verification.text
                ? <p className="mt-0.5 whitespace-normal break-words text-pretty text-secondary">{model.verification.text}</p>
                : null}
              {model.verification.reasonCodes.length > 0 ? (
                <div className="mt-1 flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-[13px] text-tertiary">
                  <span>原因：</span>
                  {model.verification.reasonCodes.map((reasonCode, index) => (
                    <span key={reasonCode} data-reason-code={reasonCode}>
                      {verificationReasonLabels[reasonCode]}
                      {index < model.verification!.reasonCodes.length - 1 ? "、" : null}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
