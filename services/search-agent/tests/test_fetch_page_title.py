"""Issue #33：trafilatura metadata title 丢失限定词时回退到 HTML <title>。

标题是 Evidence 的组成部分（`channels/web.py` 用 `page.title` 作为来源标题），
trafilatura 命中导航面包屑时会把日期这类关键限定词丢掉，Writer 因此判定证据
不足。这些用例锁定回退行为，同时确认 trafilatura 已给出有效标题时不被改写。
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from app.tools import fetch_page as module

# 实测样本：trafilatura 抽到 "黄历"，日期只出现在 <title> 里。
_HUANGLI_HTML = """<!doctype html>
<html><head><title>2026年08月03日农历是多少_2026年08月03日星期几-黄历网</title></head>
<body><nav>黄历</nav><p>子时 23:00-00:59 吉</p></body></html>"""


def test_navigation_breadcrumb_title_falls_back_to_html_title_tag() -> None:
    resolved = module._resolve_title("黄历", _HUANGLI_HTML)
    assert resolved == "2026年08月03日农历是多少_2026年08月03日星期几-黄历网"


def test_informative_trafilatura_title_is_kept_verbatim() -> None:
    markup = "<html><head><title>短</title></head><body></body></html>"
    resolved = module._resolve_title("LangGraph 0.6 发布说明与迁移指南", markup)
    assert resolved == "LangGraph 0.6 发布说明与迁移指南"


def test_missing_trafilatura_title_uses_html_title_tag() -> None:
    resolved = module._resolve_title(None, _HUANGLI_HTML)
    assert resolved == "2026年08月03日农历是多少_2026年08月03日星期几-黄历网"


def test_title_without_any_source_stays_none() -> None:
    assert module._resolve_title(None, "<html><body>无标题</body></html>") is None
    assert module._resolve_title("   ", "<html><body>无标题</body></html>") is None


def test_html_title_is_unescaped_normalized_and_bounded() -> None:
    markup = (
        '<html><head><title lang="zh">\n  2026&#24180;  &amp;  '
        "<span>08月</span>\t03日报告\n</title></head></html>"
    )
    assert module._html_title(markup) == "2026年 & 08月 03日报告"
    long_markup = f"<title>{'长' * 400}</title>"
    assert len(module._html_title(long_markup) or "") == module._MAX_TITLE_CHARS


def test_short_html_title_does_not_replace_longer_breadcrumb() -> None:
    # 回退只在能带来更多信息时生效，否则保留 trafilatura 的结果。
    resolved = module._resolve_title("黄历网农历", "<html><head><title>黄历</title></head></html>")
    assert resolved == "黄历网农历"


@pytest.mark.asyncio
async def test_static_fetch_reports_html_title_when_metadata_is_generic(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def allow_robots(url: str, timeout: float = 0.0) -> Any:
        return type("Decision", (), {"allowed": True, "reason": ""})()

    async def pinned_get(url: str, timeout: float) -> tuple[httpx.Response, str]:
        request = httpx.Request("GET", url)
        response = httpx.Response(
            200,
            request=request,
            headers={"content-type": "text/html; charset=utf-8"},
            text=_HUANGLI_HTML,
        )
        return response, url

    monkeypatch.setattr(module, "check_robots", allow_robots)
    monkeypatch.setattr(module, "_pinned_get", pinned_get)
    monkeypatch.setattr(module.trafilatura, "extract", lambda *a, **k: "子时 23:00-00:59 吉")
    monkeypatch.setattr(
        module.trafilatura,
        "extract_metadata",
        lambda markup: type("Meta", (), {"title": "黄历"})(),
    )

    result = await module._fetch_static("https://example.com/2026-08-03", 5.0)

    assert result.ok is True
    assert result.title == "2026年08月03日农历是多少_2026年08月03日星期几-黄历网"
    assert result.extractor == "trafilatura"
