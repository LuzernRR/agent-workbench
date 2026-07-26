"use client";

import { useEffect, useState } from "react";

export function ShikiCodeBlock({ code, language }: { code: string; language: string }) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    import("shiki/bundle/web").then(({ codeToHtml }) => codeToHtml(code, { lang: language || "text", theme: "github-light" })).then((output) => {
      if (!cancelled) setHtml(output);
    }).catch(() => setHtml(null));
    return () => { cancelled = true; };
  }, [code, language]);

  if (!html) return <pre className="overflow-auto rounded-lg border border-line bg-panel p-3 font-mono text-xs leading-6"><code>{code}</code></pre>;
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
