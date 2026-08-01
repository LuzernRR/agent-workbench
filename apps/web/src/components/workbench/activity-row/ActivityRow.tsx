"use client";

import { useState } from "react";
import { ChevronRight, SquareTerminal } from "lucide-react";
import type { ToolItem } from "@/lib/agent-events/types";
import { cn } from "@/lib/utils";
import { getRunFailureMessage } from "@/lib/errors";
import { safeLinkLabel, safeWorkbenchHref } from "@/lib/api/client";
import { sourceUrlIdentity } from "@/lib/agent-events/source-url";

export function isPlaceholderTool(item: Pick<ToolItem, "name" | "summary">) {
  return /^(?:工具|活动|任务)$/u.test(item.name.trim()) && /^(?:正在准备|准备中|执行中|正在执行|完成|已完成)$/u.test(item.summary.trim());
}

function uniqueSourceCount(items: readonly ToolItem[], verifiedOnly: boolean) {
  const urls = new Set<string>();
  for (const item of items) {
    for (const source of item.sources || []) {
      if (verifiedOnly && !source.verified) continue;
      const href = safeWorkbenchHref(source.url);
      const identity = sourceUrlIdentity(href);
      if (identity) urls.add(identity);
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

type SearchRecoveryNotice = {
  key: "xiaohongshu-captcha" | "xiaohongshu-auth";
  message: string;
  href?: string;
  linkLabel?: string;
};

function searchRecoveryNotice(item: Pick<ToolItem, "channel" | "reasonCode" | "verificationStatus" | "verificationHref">): SearchRecoveryNotice | null {
  if (item.channel !== "xiaohongshu") return null;
  if (item.verificationStatus === "pending" && item.verificationHref) {
    return {
      key: "xiaohongshu-captcha",
      message: "小红书工具账号需要安全验证。打开验证页并用小红书 App 扫码；成功后当前搜索会自动继续。",
      href: item.verificationHref,
      linkLabel: "立即验证"
    };
  }
  if (item.verificationStatus === "expired") {
    return { key: "xiaohongshu-captcha", message: "小红书工具账号验证已超时，当前运行已停止等待并进入受控降级。" };
  }
  if (item.verificationStatus === "account_mismatch") {
    return { key: "xiaohongshu-captcha", message: "扫码账号与当前工具账号不一致，登录会话未被更新。" };
  }
  if (item.verificationStatus === "cancelled") {
    return { key: "xiaohongshu-captcha", message: "小红书工具账号验证已取消，当前运行将按可用证据继续。" };
  }
  if (item.verificationStatus === "failed") {
    return { key: "xiaohongshu-captcha", message: "小红书工具账号验证未完成，当前运行将返回结构化降级结果。" };
  }
  if (item.reasonCode === "CAPTCHA_REQUIRED") {
    return {
      key: "xiaohongshu-captcha",
      message: "小红书要求安全验证，但工具账号验证入口未能建立；当前运行不会打开普通小红书页面。"
    };
  }
  if (item.reasonCode === "AUTH_REQUIRED") {
    return {
      key: "xiaohongshu-auth",
      message: "小红书工具账号登录状态已失效，当前无法安全确认原账号；Workbench 不会打开无关页面或收集登录凭据。"
    };
  }
  return null;
}

function SearchRecoveryNoticeView({ notice, className }: { notice: SearchRecoveryNotice; className: string }) {
  return <p className={className}>
    {notice.message}
    {notice.href && notice.linkLabel ? <> <a href={notice.href} target="_blank" rel="noopener noreferrer" className="font-medium text-link underline decoration-line underline-offset-2 hover:text-ink">{notice.linkLabel}</a></> : null}
  </p>;
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

function evidenceStatusLabel(source: NonNullable<ToolItem["sources"]>[number]) {
  if (!source.evidenceStatus) return source.verified ? "已读取" : "候选";
  return {
    read: "已读取",
    accepted: "已采用",
    rejected: "已排除",
    cited: "已引用"
  }[source.evidenceStatus];
}

export function SearchActivitySummary({ items, isCurrentStep = false }: { items: readonly ToolItem[]; isCurrentStep?: boolean }) {
  const active = items.some((item) =>
    ["preparing", "running", "waiting"].includes(item.status) || item.sourcePresentationActive);
  const settledKey = active ? null : items.map((item) => `${item.toolCallId}:${item.status}`).join("|");
  const [manuallyOpenedKey, setManuallyOpenedKey] = useState<string | null>(null);
  if (!items.length) return null;
  const expanded = active || isCurrentStep || (settledKey !== null && manuallyOpenedKey === settledKey);
  const recoveryNotices = new Map<SearchRecoveryNotice["key"], SearchRecoveryNotice>();
  for (const item of items) {
    const notice = searchRecoveryNotice(item);
    if (notice) recoveryNotices.set(notice.key, notice);
  }
  const sources = new Map<string, NonNullable<ToolItem["sources"]>[number]>();
  for (const item of items) {
    for (const source of item.sources || []) {
      if (!source.verified || !source.displayText) continue;
      const href = safeWorkbenchHref(source.url);
      const identity = sourceUrlIdentity(href);
      if (!href || !identity) continue;
      sources.set(identity, { ...source, url: href });
    }
  }
  return <div
    className="conversation-lane workbench-disclosure-row text-[15px] leading-6 text-tertiary"
    data-search-activity-summary
    data-tool-call-id={items[0].toolCallId}
    data-tool-call-count={items.length}
    data-tool-call-ids={items.map((item) => item.toolCallId).join(",")}
  >
    <button
      type="button"
      className="workbench-disclosure-trigger flex max-w-full items-center gap-1.5 rounded-md px-0 text-left text-tertiary hover:text-secondary"
      data-workbench-disclosure-trigger
      aria-expanded={expanded}
      aria-label={`${expanded ? "收起" : "展开"}搜索详情`}
      onClick={() => {
        if (settledKey === null || isCurrentStep) return;
        setManuallyOpenedKey((current) => current === settledKey ? null : settledKey);
      }}
    >
      <ChevronRight className={cn("size-4 shrink-0 transition-transform duration-150", expanded && "rotate-90")} />
      <span>搜索记录</span>
    </button>
    {recoveryNotices.size ? <div className="ml-5 mt-1 space-y-1 text-[14px] leading-5 text-warning" role="status" aria-live="polite" data-search-safety-notice>
      {[...recoveryNotices.values()].map((notice) => <SearchRecoveryNoticeView key={notice.key} notice={notice} className="break-words" />)}
    </div> : null}
    {expanded ? <div className="ml-2 mt-1 space-y-1 border-l border-line pl-4 text-secondary" data-search-activity-details>
      {items.filter((item) => !["preparing", "running", "waiting"].includes(item.status)).map((item) => <p key={`settled:${item.toolCallId}`} className="break-words" data-search-settlement>
        {item.query ? `${item.query}：` : ""}{item.outcomeStatus === "degraded" ? "受控降级，" : ""}{summarizeSearchActivity([item])}
      </p>)}
      {[...sources.entries()].map(([identity, source], index) => <p key={identity} className="break-words"><a href={source.url} target="_blank" rel="noopener noreferrer" className="text-link hover:underline" title={source.title}>{sourceLine(source, `来源 ${index + 1}`)}</a><span className="ml-1 text-[13px] text-tertiary">{evidenceStatusLabel(source)}</span></p>)}
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
  const status = item.outcomeStatus === "degraded" ? "受控降级" : item.status === "completed" ? "已完成" : item.status === "failed" ? "失败" : item.status === "unknown" ? "结果待确认" : item.status === "waiting" ? "等待中" : "执行中";
  const genericSummary = /^(?:正在准备|准备中|执行中|正在执行|完成|已完成)$/u.test(item.summary.trim());
  const summary = commandTool
    ? item.status === "completed" ? "运行了多个命令" : item.status === "failed" ? "命令执行失败" : "正在运行命令"
    : genericSummary ? item.name : item.summary || item.name;
  const recoveryNotice = searchRecoveryNotice(item);
  return (
    <div className="conversation-lane workbench-disclosure-row" data-tool-call-id={item.toolCallId}>
      <button type="button" className="workbench-disclosure-trigger group flex w-full min-w-0 items-start gap-2 rounded-lg px-0.5 text-left text-tertiary transition-colors duration-150 hover:text-secondary" data-workbench-disclosure-trigger onClick={() => {
        if (settledKey === null || isCurrentStep) return;
        setManuallyOpenedKey((current) => current === settledKey ? null : settledKey);
      }} aria-expanded={expanded} aria-label={`${expanded ? "收起" : "展开"}工具调用：${item.name}`} title={summary}>
        <SquareTerminal className="mt-1 size-[18px] shrink-0 stroke-[1.5]" />
        <span className="min-w-0 flex-1 whitespace-normal break-words text-[15px] leading-6">{summary}</span>
        <span className="mt-0.5 shrink-0 text-[15px] tabular-nums text-tertiary">{duration || status}</span>
        <ChevronRight className={cn("mt-1 size-4 shrink-0 transition-transform duration-150", expanded && "rotate-90")} />
      </button>
      {recoveryNotice ? <div role="status" aria-live="polite" data-search-safety-notice><SearchRecoveryNoticeView notice={recoveryNotice} className="ml-7 mt-1 break-words text-[14px] leading-5 text-warning" /></div> : null}
      {expanded ? (
        <div className="ml-2 mt-1 grid gap-x-8 gap-y-2 border-l border-line py-1.5 pl-5 text-[15px] leading-6 text-secondary md:grid-cols-2">
          <Detail label="状态">{status}</Detail>
          {item.settlementSummary ? <Detail label="完成记录">{item.settlementSummary}</Detail> : null}
          {item.query ? <Detail label="搜索查询">{item.query}</Detail> : null}
          {item.effectiveProvider || item.provider ? <Detail label="搜索服务">{item.effectiveProvider || item.provider}</Detail> : null}
          {item.primaryProvider && item.primaryProvider !== (item.effectiveProvider || item.provider) ? <Detail label="首选服务">{item.primaryProvider}</Detail> : null}
          {typeof item.resultCount === "number" ? <Detail label="搜索结果"><span className="tabular-nums">{item.resultCount} 条候选，{item.evidenceCount || 0} 条已读取来源</span></Detail> : null}
          {item.progress ? <Detail label="进度"><span className="tabular-nums">{item.progress.current} / {item.progress.total}</span></Detail> : null}
          {duration
            ? <Detail label="执行耗时">{duration}</Detail>
            : ["preparing", "running", "waiting"].includes(item.status)
              ? <Detail label="执行耗时">执行中</Detail>
              : null}
          {item.error ? <Detail label={item.status === "unknown" ? "状态说明" : "错误信息"} danger={item.status !== "unknown"}>{item.status === "unknown" ? "结果状态未知，系统未自动重试" : commandTool ? "命令未能完成" : getRunFailureMessage(item.error)}</Detail> : null}
          {item.outcomeStatus === "degraded" && item.resolutionMessage ? <Detail label="降级说明">{item.resolutionMessage}</Detail> : null}
          {item.nextAction && item.nextAction !== "none" ? <Detail label="后续动作">{nextActionLabel(item.nextAction)}</Detail> : null}
          {item.sources?.length ? <div className="min-w-0 md:col-span-2"><div className="mb-1 text-[15px] font-medium text-tertiary">来源</div><ul className="space-y-1.5">{item.sources.map((source, index) => {
            const href = safeWorkbenchHref(source.url);
            if (!href) return null;
            return <li key={`${href}:${index}`} className="min-w-0"><a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex max-w-full items-center gap-1 break-all text-link hover:underline" title={source.title}>{safeLinkLabel(source.title, `来源 ${index + 1}`)}</a><span className="ml-1 text-[13px] text-tertiary">{evidenceStatusLabel(source)}</span></li>;
          })}</ul></div> : null}
        </div>
      ) : null}
    </div>
  );
}

function nextActionLabel(action: NonNullable<ToolItem["nextAction"]>) {
  return {
    none: "无需操作",
    use_fallback: "已使用受控备用渠道",
    use_alternative_channel: "改用其他只读渠道",
    reconnect_account: "重新连接小红书账号",
    retry_later: "稍后重试",
    check_operation: "检查工具操作状态",
    stop: "停止自动重试"
  }[action];
}

function Detail({ label, children, danger = false }: { label: string; children: React.ReactNode; danger?: boolean }) {
  return <div className="min-w-0"><div className="mb-1 text-[15px] font-medium text-tertiary">{label}</div><div className={danger ? "text-danger" : "text-secondary"}>{children}</div></div>;
}
