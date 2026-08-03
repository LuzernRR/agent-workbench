"""Issue #33 真实页面校验（临时脚本，不属于 feature 代码）。

对真实候选页面跑 _fetch_static，对比 trafilatura metadata title 与修复后的
最终 title，确认日期限定词是否被保留。不打印任何密钥内容。
"""

from __future__ import annotations

import asyncio
import sys

import trafilatura

from app.tools import fetch_page as module

URLS = [
    "https://www.huangli.com/huangli/2026/08_03.html",
    "https://www.langchain.com/langgraph",
]


async def main() -> int:
    for url in URLS:
        result = await module._fetch_static(url, 20.0)
        if not result.ok:
            print(f"[skip] {url} -> {result.error_category}: {result.error}")
            continue
        print(f"[ok] {url}")
        print(f"  最终 title    = {result.title!r}")
        print(f"  正文字符数    = {result.char_count}")
        print(f"  title 含 2026 = {'2026' in (result.title or '')}")
        print(f"  正文含 2026   = {'2026' in result.text}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
