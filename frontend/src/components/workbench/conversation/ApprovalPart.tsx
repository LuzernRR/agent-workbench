"use client";

import { ShieldCheck } from "lucide-react";
import type { ApprovalItem } from "@/lib/agent-events/types";

export function ApprovalPart({ item, onResolve, disabled }: { item: ApprovalItem; onResolve: (decision: "allow_once" | "always_allow" | "deny") => void; disabled: boolean }) {
  if (item.status !== "pending") {
    return <div className="conversation-lane my-1 flex min-h-8 items-center gap-2 py-1 text-[15px] text-secondary"><ShieldCheck className="size-4 text-success" /><span>{item.status === "approved" ? "已批准工具访问" : "已拒绝工具访问"}</span></div>;
  }
  return (
    <div className="conversation-lane my-2 py-1">
      <div className="flex items-center gap-2 text-[15px] font-medium text-ink"><ShieldCheck className="size-4 text-warning" />{item.title}</div>
      <p className="mb-2 mt-1 pl-6 text-[15px] leading-6 text-secondary">{item.description}</p>
      <div className="flex flex-wrap gap-1.5 pl-6">
        <button type="button" className="primary-button" disabled={disabled} onClick={() => onResolve("allow_once")}>允许一次</button>
        <button type="button" className="quiet-button" disabled={disabled} onClick={() => onResolve("always_allow")}>始终允许</button>
        <button type="button" className="quiet-button" disabled={disabled} onClick={() => onResolve("deny")}>拒绝</button>
      </div>
    </div>
  );
}
