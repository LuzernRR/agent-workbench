"use client";

import { useState } from "react";
import { ChevronRight, Wrench } from "lucide-react";
import type { V2ToolActivityView } from "@/lib/agent-events/v2/process-view-model";
import type { V2SourceType } from "@/lib/agent-events/v2/types";
import { cn } from "@/lib/utils";

const sourceTypeLabels: Record<V2SourceType, string> = {
  web: "网页",
  official_docs: "官方文档",
  news: "新闻",
  academic: "学术资料",
  code: "代码",
  dataset: "数据集",
  private: "私有来源",
  user_attachment: "用户附件",
  social: "社交平台"
};

const resultTypeLabels: Record<NonNullable<V2ToolActivityView["resultType"]>, string> = {
  links: "链接",
  pages: "页面",
  passages: "段落",
  records: "记录",
  artifacts: "成果",
  none: "无结果"
};

function formatDuration(durationMs: number) {
  if (durationMs < 1000) return `${durationMs} 毫秒`;
  const seconds = durationMs / 1000;
  return `${seconds.toFixed(durationMs >= 10000 ? 0 : 1)} 秒`;
}

function statusLabel(tool: V2ToolActivityView) {
  if (tool.status === "completed") return "已完成";
  if (tool.status === "failed") return "失败";
  if (tool.status === "unknown") return "结果未确认";
  if (tool.phase === "retrying") return "正在重试";
  if (tool.phase === "waiting_approval") return "等待审批";
  if (tool.phase === "approval_decided") {
    if (tool.approvalDecision === "allow_once") return "审批已通过";
    if (tool.approvalDecision === "deny") return "审批已拒绝";
    if (tool.approvalDecision === "edit") return "已提交修改";
  }
  if (tool.phase === "progress") return "执行中";
  return "准备中";
}

function summaryMetric(tool: V2ToolActivityView) {
  if (tool.resultCount !== null) {
    return `${tool.resultCount} 项`;
  }
  if (tool.durationMs !== null) return formatDuration(tool.durationMs);
  return null;
}

export function V2ToolActivityList({
  tools
}: {
  tools: readonly V2ToolActivityView[];
}) {
  if (tools.length === 0) return null;
  return (
    <div className="min-w-0 space-y-1 border-t border-line pt-2" data-testid="v2-tool-activity-list">
      {tools.map((tool) => <V2ToolActivityRow key={tool.toolCallId} tool={tool} />)}
    </div>
  );
}

export function V2ToolActivityRow({ tool }: { tool: V2ToolActivityView }) {
  const [open, setOpen] = useState(false);
  const status = statusLabel(tool);
  const metric = summaryMetric(tool);

  return (
    <div
      className="min-w-0"
      data-tool-call-id={tool.toolCallId}
      data-tool-status={tool.status}
      data-tool-phase={tool.phase}
      data-plan-step-id={tool.planStepId}
    >
      <button
        type="button"
        className="flex min-h-9 w-full min-w-0 items-start gap-2 py-1 text-left text-secondary hover:text-ink"
        aria-expanded={open}
        aria-label={`${open ? "收起" : "展开"}工具活动：${tool.registryTitle}`}
        onClick={() => setOpen((current) => !current)}
      >
        <Wrench className="mt-1 size-4 shrink-0 stroke-[1.6]" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block whitespace-normal break-words text-[15px] leading-6 text-ink">
            {tool.registryTitle}
          </span>
          <span className="block whitespace-normal break-words text-[13px] leading-5 text-tertiary" aria-live="polite">
            {status}
          </span>
        </span>
        {metric
          ? <span className="mt-1 shrink-0 text-[13px] tabular-nums text-tertiary">{metric}</span>
          : null}
        <ChevronRight
          className={cn("mt-1 size-4 shrink-0 transition-transform duration-150", open && "rotate-90")}
          aria-hidden="true"
        />
      </button>

      {open ? (
        <div className="ml-6 grid min-w-0 gap-x-6 gap-y-2 border-l border-line py-1.5 pl-4 text-[14px] leading-5 text-secondary md:grid-cols-2">
          <Detail label="状态">{status}</Detail>
          <Detail label="尝试次数"><span className="tabular-nums">{tool.attempt}</span></Detail>
          {tool.parameterSummary ? <Detail label="参数摘要">{tool.parameterSummary}</Detail> : null}
          {tool.resultSummary ? <Detail label="结果摘要">{tool.resultSummary}</Detail> : null}
          {tool.resultCount !== null
            ? <Detail label="结果数量"><span className="tabular-nums">{tool.resultCount}</span></Detail>
            : null}
          {tool.resultType ? <Detail label="结果类型">{resultTypeLabels[tool.resultType]}</Detail> : null}
          {tool.sourceTypes.length > 0
            ? <Detail label="来源类型">{tool.sourceTypes.map((sourceType) => sourceTypeLabels[sourceType]).join("、")}</Detail>
            : null}
          {tool.durationMs !== null ? <Detail label="执行耗时">{formatDuration(tool.durationMs)}</Detail> : null}
          {tool.costUsd !== null ? <Detail label="费用">USD {tool.costUsd}</Detail> : null}
          {tool.actionSummary ? <Detail label="审批内容">{tool.actionSummary}</Detail> : null}
          {tool.permissionSummary ? <Detail label="权限范围">{tool.permissionSummary}</Detail> : null}
          {tool.errorMessage ? <Detail label="错误信息" danger>{tool.errorMessage}</Detail> : null}
          {tool.errorCode ? <Detail label="错误代码">{tool.errorCode}</Detail> : null}
          {tool.retryable !== null ? <Detail label="可重试">{tool.retryable ? "是" : "否"}</Detail> : null}
          {tool.status === "unknown" ? (
            <>
              <Detail label="当前结论" danger>结果尚未确认</Detail>
              {tool.operationRef ? <Detail label="操作引用">{tool.operationRef}</Detail> : null}
              {tool.nextAction === "check_operation"
                ? <Detail label="后续动作">查询操作状态</Detail>
                : null}
              {tool.usage
                ? <Detail label="可能重复费用">USD {tool.usage.possibleDuplicateCostUsd}</Detail>
                : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Detail({
  label,
  children,
  danger = false
}: {
  label: string;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[13px] text-tertiary">{label}</div>
      <div className={cn("whitespace-normal break-words", danger && "text-danger")}>{children}</div>
    </div>
  );
}
