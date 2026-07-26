"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, Search } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { LogEntry } from "@/lib/agent-events/types";
import { cn } from "@/lib/utils";

const levelLabels: Record<LogEntry["level"], string> = { debug: "调试", info: "信息", warn: "警告", error: "错误" };

export function LogViewer({ logs }: { logs: LogEntry[] }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [level, setLevel] = useState("all");
  const [query, setQuery] = useState("");
  const [follow, setFollow] = useState(true);
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const rows = logs.filter((log) => (level === "all" || log.level === level) && (!normalizedQuery || `${log.actor} ${log.content}`.toLocaleLowerCase("zh-CN").includes(normalizedQuery)));
  // TanStack Virtual intentionally exposes mutable measurement helpers.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => parentRef.current, estimateSize: () => 36, overscan: 8 });

  useEffect(() => {
    if (!follow) return;
    const frame = window.requestAnimationFrame(() => parentRef.current?.scrollTo({ top: parentRef.current.scrollHeight, behavior: "smooth" }));
    return () => window.cancelAnimationFrame(frame);
  }, [follow, logs.length]);

  return <div className="flex h-full flex-col">
    <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-line px-2">
      <div className="flex min-w-0 flex-1 items-center gap-1 rounded-md bg-white px-1.5"><Search className="size-3.5 shrink-0 text-tertiary" /><input value={query} onChange={(event) => setQuery(event.target.value)} className="h-7 min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-tertiary" placeholder="搜索日志" aria-label="搜索日志" /></div>
      <select value={level} onChange={(event) => setLevel(event.target.value)} className="h-7 bg-transparent text-[12px] text-secondary outline-none" aria-label="日志级别"><option value="all">全部</option><option value="debug">调试</option><option value="info">信息</option><option value="warn">警告</option><option value="error">错误</option></select>
      <button type="button" className={cn("icon-button size-7", follow && "bg-white text-accent")} onClick={() => setFollow((value) => !value)} title={follow ? "停止自动跟随" : "开启自动跟随"} aria-label={follow ? "停止自动跟随" : "开启自动跟随"}><ArrowDownToLine className="size-3.5" /></button>
    </div>
    <div ref={parentRef} className="scrollbar-subtle min-h-0 flex-1 overflow-auto px-3 py-2">
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>{virtualizer.getVirtualItems().map((row) => {
        const log = rows[row.index];
        return <div key={log.id} data-index={row.index} ref={virtualizer.measureElement} className="absolute left-0 right-0 flex gap-2 border-b border-line py-2 text-[12px] leading-5" style={{ transform: `translateY(${row.start}px)` }}><span className="shrink-0 tabular-nums text-tertiary">{new Date(log.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}</span><span className={log.level === "error" ? "text-danger" : log.level === "warn" ? "text-warning" : "text-secondary"}>{levelLabels[log.level]}</span><span className="shrink-0 font-medium text-ink">{log.actor}</span><span className="min-w-0 break-words text-secondary">{log.content}</span></div>;
      })}</div>
    </div>
  </div>;
}
