"use client";

import type { ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { cn } from "@/lib/utils";
import { safeLinkLabel, safeWorkbenchHref } from "@/lib/api/client";
import { ShikiCodeBlock } from "./ShikiCodeBlock";

export function MarkdownRenderer({ children, className = "" }: { children: string; className?: string }) {
  return (
    <div className={cn("markdown-body text-pretty", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={{
          code({ className, children: codeChildren, ...props }: ComponentPropsWithoutRef<"code">) {
            const language = /language-(\w+)/.exec(className || "")?.[1];
            const value = String(codeChildren).replace(/\n$/, "");
            return language ? <ShikiCodeBlock code={value} language={language} /> : <code className={className} {...props}>{codeChildren}</code>;
          },
          a({ href, children: linkChildren, ...props }) {
            const safeHref = safeWorkbenchHref(href);
            const text = textContent(linkChildren);
            const label = safeLinkLabel(text, linkLabel(safeHref));
            return safeHref ? <a href={safeHref} target="_blank" rel="noopener noreferrer" title={label} {...props}>{text ? label : linkChildren}</a> : <span>{text ? label : linkChildren}</span>;
          },
          img({ alt }) {
            const label = safeLinkLabel(alt, "生成图片");
            // Model/web content is untrusted. Never auto-fetch Markdown images:
            // a crafted URL could make the browser probe localhost or the LAN.
            // User attachments keep using the separate, controlled preview path.
            return <span>{`图片已隐藏：${label}`}</span>;
          },
          table({ children: tableChildren, ...props }) {
            return <div className="markdown-table-scroll scrollbar-subtle"><table {...props}>{tableChildren}</table></div>;
          }
        }}
      >{children}</ReactMarkdown>
    </div>
  );
}

function textContent(value: React.ReactNode): string {
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (!Array.isArray(value)) return "";
  return value.map(textContent).join("").trim();
}

function linkLabel(href: string) {
  if (!href) return "不可用链接";
  if (href.startsWith("/")) return "查看工作台资源";
  try {
    const host = new URL(href).hostname.replace(/^www\./u, "");
    return host ? `访问 ${host}` : "查看外部来源";
  } catch {
    return "查看外部来源";
  }
}
