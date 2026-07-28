"use client";

import dynamic from "next/dynamic";
import type { WorkbenchFile } from "@/lib/agent-events/types";

const Monaco = dynamic(() => import("@monaco-editor/react"), { ssr: false, loading: () => <div className="grid h-full place-items-center text-xs text-tertiary">正在加载代码编辑器</div> });

export function CodePreview({ file }: { file: WorkbenchFile | undefined }) {
  if (!file) return <div className="grid h-full place-items-center text-[13px] text-tertiary">选择一个代码文件开始预览</div>;
  return <div className="flex h-full flex-col"><div className="flex min-h-9 shrink-0 items-start gap-2 border-b border-line px-3 py-2"><span className="min-w-0 flex-1 whitespace-normal break-words text-[13px] font-medium text-ink" title={file.name}>{file.name}</span><span className="shrink-0 text-[12px] text-tertiary">版本 {file.version}</span></div><div className="min-h-0 flex-1"><Monaco loading={<div className="grid h-full place-items-center text-xs text-tertiary">正在加载代码编辑器</div>} theme="light" language={file.language || "plaintext"} value={file.content || ""} options={{ readOnly: true, minimap: { enabled: false }, lineNumbers: "on", fontSize: 15, scrollBeyondLastLine: false, wordWrap: "on", padding: { top: 12 } }} /></div></div>;
}
