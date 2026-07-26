"use client";

import { useState } from "react";
import { ChevronRight, SquareTerminal } from "lucide-react";
import type { ToolItem } from "@/lib/agent-events/types";
import { cn } from "@/lib/utils";
import { getRunFailureMessage } from "@/lib/errors";

export function isPlaceholderTool(item: Pick<ToolItem, "name" | "summary">) {
  return /^(?:工具|活动|任务)$/u.test(item.name.trim()) && /^(?:正在准备|准备中|执行中|正在执行|完成|已完成)$/u.test(item.summary.trim());
}

export function ActivityRow({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const duration = item.durationMs ? `${(item.durationMs / 1000).toFixed(item.durationMs >= 10000 ? 0 : 1)} 秒` : "";
  const commandTool = /(?:终端|命令|terminal|shell|exec|command)/i.test(item.name);
  const status = item.status === "completed" ? "已完成" : item.status === "failed" ? "失败" : item.status === "waiting" ? "等待中" : "执行中";
  const genericSummary = /^(?:正在准备|准备中|执行中|正在执行|完成|已完成)$/u.test(item.summary.trim());
  const summary = commandTool
    ? item.status === "completed" ? "运行了多个命令" : item.status === "failed" ? "命令执行失败" : "正在运行命令"
    : genericSummary ? item.name : item.summary || item.name;
  return (
    <div className="conversation-lane my-2" data-tool-call-id={item.toolCallId}>
      <button type="button" className="group flex min-h-9 w-full min-w-0 items-start gap-2 rounded-lg px-0.5 py-1 text-left text-tertiary transition-colors duration-150 hover:text-secondary" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-label={`${open ? "收起" : "展开"}工具调用：${item.name}`} title={summary}>
        <SquareTerminal className="mt-1 size-[18px] shrink-0 stroke-[1.5]" />
        <span className="min-w-0 flex-1 whitespace-normal break-words text-[15px] leading-6">{summary}</span>
        <span className="mt-0.5 shrink-0 text-[15px] tabular-nums text-tertiary">{duration || status}</span>
        <ChevronRight className={cn("mt-1 size-4 shrink-0 transition-transform duration-150", open && "rotate-90")} />
      </button>
      {open ? (
        <div className="ml-2 mt-1 grid gap-x-8 gap-y-2 border-l border-line py-1.5 pl-5 text-[15px] leading-6 text-secondary md:grid-cols-2">
          <Detail label="状态">{status}</Detail>
          {item.progress ? <Detail label="进度"><span className="tabular-nums">{item.progress.current} / {item.progress.total}</span></Detail> : null}
          <Detail label="执行耗时">{duration || "执行中"}</Detail>
          {item.error ? <Detail label="错误信息" danger>{commandTool ? "命令未能完成" : getRunFailureMessage(item.error)}</Detail> : null}
        </div>
      ) : null}
    </div>
  );
}

function Detail({ label, children, danger = false }: { label: string; children: React.ReactNode; danger?: boolean }) {
  return <div className="min-w-0"><div className="mb-1 text-[15px] font-medium text-tertiary">{label}</div><div className={danger ? "text-danger" : "text-secondary"}>{children}</div></div>;
}
