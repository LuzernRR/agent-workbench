import type { V2GuidanceView } from "@/lib/agent-events/v2/process-view-model";

const guidanceStatusLabels = {
  accepted_pending: "已接收，等待应用",
  applied: "已应用",
  superseded: "已被后续引导替代",
  rejected: "已拒绝",
  failed: "处理失败"
} as const;

const guidanceErrorLabels: Readonly<Record<string, string>> = {
  COMMAND_REVISION_CONFLICT: "引导版本已变化，请重新读取后再提交",
  COMMAND_AFTER_TERMINAL: "任务已经结束",
  COMMAND_SCOPE_MISMATCH: "引导不属于当前任务",
  GUIDANCE_PROVIDER_ERROR: "引导暂时无法处理"
};

export function V2GuidanceList({
  guidance
}: {
  guidance: readonly V2GuidanceView[];
}) {
  if (guidance.length === 0) return null;
  return (
    <div className="min-w-0 border-t border-line pt-2" data-testid="v2-guidance-list">
      <div className="mb-1 text-[13px] font-medium text-tertiary">运行中引导</div>
      <div className="space-y-1">
        {guidance.map((item) => (
          <div
            key={item.commandId}
            className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[14px] leading-5"
            data-command-id={item.commandId}
            data-command-seq={item.commandSeq}
            data-guidance-status={item.status}
          >
            <span className="shrink-0 text-tertiary">引导 {item.commandSeq}</span>
            <span className="text-secondary">{guidanceStatusLabels[item.status]}</span>
            {item.errorCode && guidanceErrorLabels[item.errorCode]
              ? (
                  <span className="min-w-0 break-words text-danger" data-error-code={item.errorCode}>
                    {guidanceErrorLabels[item.errorCode]}
                  </span>
                )
              : null}
          </div>
        ))}
      </div>
    </div>
  );
}
