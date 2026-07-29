"use client";

import { useState } from "react";
import { ChevronRight, SquareTerminal } from "lucide-react";
import type { ToolItem } from "@/lib/agent-events/types";
import { cn } from "@/lib/utils";
import { getRunFailureMessage } from "@/lib/errors";
import { safeLinkLabel, safeWorkbenchHref } from "@/lib/api/client";

export function isPlaceholderTool(item: Pick<ToolItem, "name" | "summary">) {
  return /^(?:工具|活动|任务)$/u.test(item.name.trim()) && /^(?:正在准备|准备中|执行中|正在执行|完成|已完成)$/u.test(item.summary.trim());
}

function uniqueSourceCount(items: readonly ToolItem[], verifiedOnly: boolean) {
  const urls = new Set<string>();
  for (const item of items) {
    for (const source of item.sources || []) {
      if (verifiedOnly && !source.verified) continue;
      const href = safeWorkbenchHref(source.url);
      if (href) urls.add(href);
    }
  }
  return urls.size;
}

export function summarizeSearchActivity(items: readonly ToolItem[]) {
  const verifiedUrls = uniqueSourceCount(items, true);
  const resultCount = items.reduce((total, item) => total + (item.resultCount || 0), 0);
  const evidenceCount = verifiedUrls || items.reduce((total, item) => total + (item.evidenceCount || 0), 0);
  const active = items.some((item) => ["preparing", "running", "waiting"].includes(item.status));

  if (resultCount || evidenceCount) return `找到 ${resultCount} 条结果，读取 ${evidenceCount} 个来源`;
  if (active) return "搜索中";
  if (items.some((item) => item.status === "failed" || item.status === "unknown")) return "搜索未完成";
  return "未找到相关结果，读取 0 个来源";
}

function sourceLine(source: NonNullable<ToolItem["sources"]>[number], fallback: string) {
  const platform = source.channel === "x" ? "X" : source.channel === "xiaohongshu" ? "小红书" : source.channel === "web" ? "网页" : "";
  const author = source.author ? source.author.replace(/^@/u, "").trim() : "";
  const identity = author ? `${platform ? `${platform} · ` : ""}@${author}` : platform;
  const title = source.displayText || safeLinkLabel(source.title, fallback);
  return author && identity && !title.includes(`@${author}`)
    ? `${identity}：${title}`
    : platform ? `${platform} · ${title}` : title;
}

export function SearchActivitySummary({ items, isCurrentStep = false }: { items: readonly ToolItem[]; isCurrentStep?: boolean }) {
  const active = items.some((item) =>
    ["preparing", "running", "waiting"].includes(item.status) || item.sourcePresentationActive);
  const settledKey = active ? null : items.map((item) => `${item.toolCallId}:${item.status}`).join("|");
  const [manuallyOpenedKey, setManuallyOpenedKey] = useState<string | null>(null);
  if (!items.length) return null;
  const expanded = active || isCurrentStep || (settledKey !== null && manuallyOpenedKey === settledKey);
  const sources = new Map<string, NonNullable<ToolItem["sources"]>[number]>();
  for (const item of items) {
    for (const source of item.sources || []) {
      if (!source.verified || !source.displayText) continue;
      const href = safeWorkbenchHref(source.url);
      if (!href) continue;
      sources.set(href, { ...source, url: href });
    }
  }
  return <div
    className="conversation-lane my-2 text-[15px] leading-6 text-tertiary"
    data-search-activity-summary
    data-tool-call-id={items[0].toolCallId}
    data-tool-call-count={items.length}
    data-tool-call-ids={items.map((item) => item.toolCallId).join(",")}
  >
    <button
      type="button"
      className="flex min-h-8 max-w-full items-center gap-1.5 rounded-md px-0 text-left text-tertiary hover:text-secondary"
      aria-expanded={expanded}
      aria-label={`${expanded ? "收起" : "展开"}搜索详情`}
      onClick={() => {
        if (settledKey === null || isCurrentStep) return;
        setManuallyOpenedKey((current) => current === settledKey ? null : settledKey);
      }}
    >
      <ChevronRight className={cn("size-4 shrink-0 transition-transform duration-150", expanded && "rotate-90")} />
      <span>{summarizeSearchActivity(items)}</span>
    </button>
    {expanded && sources.size ? <div className="ml-2 mt-1 space-y-1 border-l border-line pl-4 text-secondary" data-search-activity-details>
      {[...sources.entries()].map(([href, source], index) => <p key={href} className="break-words"><a href={href} target="_blank" rel="noopener noreferrer" className="text-link hover:underline" title={source.title}>{sourceLine(source, `来源 ${index + 1}`)}</a></p>)}
    </div> : null}
  </div>;
}

export function ActivityRow({ item, isCurrentStep = false }: { item: ToolItem; isCurrentStep?: boolean }) {
  const active = ["preparing", "running", "waiting"].includes(item.status);
  const settledKey = active ? null : `${item.toolCallId}:${item.status}`;
  const [manuallyOpenedKey, setManuallyOpenedKey] = useState<string | null>(null);
  const expanded = active || isCurrentStep || (settledKey !== null && manuallyOpenedKey === settledKey);
  const duration = typeof item.durationMs === "number"
    ? `${(item.durationMs / 1000).toFixed(item.durationMs >= 10000 ? 0 : 1)} 秒`
    : "";
  const commandTool = /(?:终端|命令|terminal|shell|exec|command)/i.test(item.name);
  const status = item.status === "completed" ? "已完成" : item.status === "failed" ? "失败" : item.status === "unknown" ? "结果待确认" : item.status === "waiting" ? "等待中" : "执行中";
  const genericSummary = /^(?:正在准备|准备中|执行中|正在执行|完成|已完成)$/u.test(item.summary.trim());
  const summary = commandTool
    ? item.status === "completed" ? "运行了多个命令" : item.status === "failed" ? "命令执行失败" : "正在运行命令"
    : genericSummary ? item.name : item.summary || item.name;
  return (
    <div className="conversation-lane my-2" data-tool-call-id={item.toolCallId}>
      <button type="button" className="group flex min-h-9 w-full min-w-0 items-start gap-2 rounded-lg px-0.5 py-1 text-left text-tertiary transition-colors duration-150 hover:text-secondary" onClick={() => {
        if (settledKey === null || isCurrentStep) return;
        setManuallyOpenedKey((current) => current === settledKey ? null : settledKey);
      }} aria-expanded={expanded} aria-label={`${expanded ? "收起" : "展开"}工具调用：${item.name}`} title={summary}>
        <SquareTerminal className="mt-1 size-[18px] shrink-0 stroke-[1.5]" />
        <span className="min-w-0 flex-1 whitespace-normal break-words text-[15px] leading-6">{summary}</span>
        <span className="mt-0.5 shrink-0 text-[15px] tabular-nums text-tertiary">{duration || status}</span>
        <ChevronRight className={cn("mt-1 size-4 shrink-0 transition-transform duration-150", expanded && "rotate-90")} />
      </button>
      {expanded ? (
        <div className="ml-2 mt-1 grid gap-x-8 gap-y-2 border-l border-line py-1.5 pl-5 text-[15px] leading-6 text-secondary md:grid-cols-2">
          <Detail label="状态">{status}</Detail>
          {item.query ? <Detail label="搜索查询">{item.query}</Detail> : null}
          {item.provider ? <Detail label="搜索服务">{item.provider}</Detail> : null}
          {typeof item.resultCount === "number" ? <Detail label="搜索结果"><span className="tabular-nums">{item.resultCount} 条候选，{item.evidenceCount || 0} 条已读取来源</span></Detail> : null}
          {item.progress ? <Detail label="进度"><span className="tabular-nums">{item.progress.current} / {item.progress.total}</span></Detail> : null}
          {duration
            ? <Detail label="执行耗时">{duration}</Detail>
            : ["preparing", "running", "waiting"].includes(item.status)
              ? <Detail label="执行耗时">执行中</Detail>
              : null}
          {item.error ? <Detail label={item.status === "unknown" ? "状态说明" : "错误信息"} danger={item.status !== "unknown"}>{item.status === "unknown" ? "结果状态未知，系统未自动重试" : commandTool ? "命令未能完成" : getRunFailureMessage(item.error)}</Detail> : null}
          {item.sources?.length ? <div className="min-w-0 md:col-span-2"><div className="mb-1 text-[15px] font-medium text-tertiary">来源</div><ul className="space-y-1.5">{item.sources.map((source, index) => {
            const href = safeWorkbenchHref(source.url);
            if (!href) return null;
            return <li key={`${href}:${index}`} className="min-w-0"><a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex max-w-full items-center gap-1 break-all text-link hover:underline" title={source.title}>{safeLinkLabel(source.title, `来源 ${index + 1}`)}</a><span className="ml-1 text-[13px] text-tertiary">{source.verified ? "已读取" : "候选"}</span></li>;
          })}</ul></div> : null}
        </div>
      ) : null}
    </div>
  );
}

function Detail({ label, children, danger = false }: { label: string; children: React.ReactNode; danger?: boolean }) {
  return <div className="min-w-0"><div className="mb-1 text-[15px] font-medium text-tertiary">{label}</div><div className={danger ? "text-danger" : "text-secondary"}>{children}</div></div>;
}
