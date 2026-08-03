"""Issue #33 真实页面校验（临时脚本，不属于 feature 代码）。

对真实候选页面跑 _fetch_static，打印修复前后的 title 差异。
不打印任何密钥内容。
"""

from __future__ import annotations

import asyncio
import sys

import trafilatura

from app.tools import fetch_page as module

URLS = [
    "https://www.huangli.com/riqi/2026-08-03.html",
    "https://www.timeanddate.com/worldclock/china/beijing",
    "https://python.langchain.com/docs/introduction/",
]


async def main() -> int:
    for url in URLS:
        result = await module._fetch_static(url, 20.0)
        if not result.ok:
            print(f"[skip] {url} -> {result.error_category}: {result.error}")
            continue
        print(f"[ok] {url}")
        print(f"  title   = {result.title!r}")
        print(f"  chars   = {result.char_count}")
        print(f"  含 2026 = {'2026' in (result.title or '') or '2026' in result.text}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
