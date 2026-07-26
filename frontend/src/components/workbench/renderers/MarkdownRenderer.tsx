"use client";

/* Markdown image sources are runtime data; next/image cannot safely predeclare
   arbitrary evidence hosts. The URL is allow-listed before this native image. */
/* eslint-disable @next/next/no-img-element */

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
          img({ src, alt, ...props }) {
            const safeSrc = safeWorkbenchHref(typeof src === "string" ? src : "");
            const label = safeLinkLabel(alt, "生成图片");
            return safeSrc ? <img src={safeSrc} alt={label} loading="lazy" referrerPolicy="no-referrer" {...props} /> : <span>{label}</span>;
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
