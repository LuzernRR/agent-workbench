"""网页搜索工具。

搜索只负责「发现候选」，不产出证据。项目文档 10.1 节明确要求：
搜索结果的 title/snippet 不能当作事实，必须经 fetch_page 读取原文后
才能进入证据链。因此本模块只返回候选 URL 列表。

Provider 策略：
- 配置了 Tavily API Key 时走 Tavily（项目文档指定的首选）。
- 未配置 Key 时回退到 DuckDuckGo HTML 端点，保证链路无 Key 也能真实运行。

回退不是「假搜索」：它发出真实 HTTP 请求并解析真实结果。
但结果质量与稳定性弱于商业 API，因此 `provider` 字段会如实标注来源，
供上层判断与展示。
"""

from __future__ import annotations

import asyncio
import json
import os
import pathlib
import re
from dataclasses import dataclass, field
from urllib.parse import parse_qs, unquote, urlparse

import httpx
from selectolax.parser import HTMLParser

from app.tools.url_policy import is_fetchable

# DuckDuckGo 的无 JS HTML 端点。不需要 Key，但会限流，
# 因此仅作为兜底而非主路径。
_DDG_ENDPOINT = "https://html.duckduckgo.com/html/"
_TAVILY_ENDPOINT = "https://api.tavily.com/search"

_UA = "Mozilla/5.0 (compatible; AgentWorkbench-SearchAgent/0.1)"

_TIMEOUT = httpx.Timeout(connect=5.0, read=15.0, write=10.0, pool=5.0)


@dataclass(frozen=True)
class SearchHit:
    """一条搜索候选。

    这是「候选」而非「证据」：`snippet` 来自搜索引擎，
    未经原文核实，不能直接用于回答。
    """

    url: str
    title: str
    snippet: str
    rank: int


@dataclass(frozen=True)
class SearchOutcome:
    """一次搜索的结果。"""

    ok: bool
    query: str
    provider: str
    hits: list[SearchHit] = field(default_factory=list)
    error: str | None = None
    error_category: str | None = None

    @property
    def urls(self) -> list[str]:
        return [hit.url for hit in self.hits]


def _tavily_key() -> str | None:
    """读取 Tavily Key。

    优先级：环境变量 TAVILY_API_KEY（便于临时覆盖）> config/search.local.json。
    该配置文件已被 .gitignore（config/*.local.json）忽略；Key 只在进程内持有，
    不写入日志、事件或返回给浏览器的内容。
    """
    env_key = os.environ.get("TAVILY_API_KEY", "").strip()
    if env_key:
        return env_key

    # search-agent/app/tools/web_search.py -> 上溯到仓库根的 config/
    repo_root = pathlib.Path(__file__).resolve().parents[4]
    config_file = repo_root / "config" / "search.local.json"
    if not config_file.is_file():
        return None
    try:
        data = json.loads(config_file.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    key = (
        (data.get("search") or {})
        .get("providers", {})
        .get("tavily", {})
        .get("apiKey", "")
    )
    key = key.strip() if isinstance(key, str) else ""
    return key or None


def _clean_ddg_url(raw: str) -> str | None:
    """还原 DuckDuckGo 的跳转链接。

    DDG 的结果链接形如 `//duckduckgo.com/l/?uddg=<encoded>`，
    需要取出真实目标 URL。
    """
    if raw.startswith("//"):
        raw = f"https:{raw}"
    parsed = urlparse(raw)
    if "duckduckgo.com" in parsed.netloc and parsed.path.startswith("/l/"):
        target = parse_qs(parsed.query).get("uddg", [])
        if not target:
            return None
        raw = unquote(target[0])
    return raw if raw.startswith(("http://", "https://")) else None


def _collapse(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


async def _filter_fetchable_hits(hits: list[SearchHit], limit: int) -> list[SearchHit]:
    """在线程池并发解析候选 DNS，避免阻塞 Agent 事件循环与取消。"""
    semaphore = asyncio.Semaphore(5)

    async def allowed(hit: SearchHit) -> bool:
        async with semaphore:
            try:
                async with asyncio.timeout(4):
                    return await asyncio.to_thread(is_fetchable, hit.url)
            except TimeoutError:
                return False

    flags = await asyncio.gather(*(allowed(hit) for hit in hits))
    return [hit for hit, keep in zip(hits, flags, strict=True) if keep][:limit]


async def _search_tavily(query: str, max_results: int, key: str) -> SearchOutcome:
    """调用 Tavily 搜索 API。"""
    payload = {
        "api_key": key,
        "query": query,
        "max_results": max_results,
        "search_depth": "basic",
    }
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        response = await client.post(_TAVILY_ENDPOINT, json=payload)
        if response.status_code == 401:
            return SearchOutcome(
                ok=False, query=query, provider="tavily",
                error="Tavily 认证失败", error_category="auth_required",
            )
        if response.status_code == 429:
            return SearchOutcome(
                ok=False, query=query, provider="tavily",
                error="Tavily 请求过于频繁", error_category="rate_limited",
            )
        response.raise_for_status()
        data = response.json()

    raw_hits: list[SearchHit] = []
    for index, item in enumerate(data.get("results") or [], start=1):
        url = str(item.get("url") or "")
        if not url.startswith(("http://", "https://")):
            continue
        raw_hits.append(
            SearchHit(
                url=url,
                title=_collapse(str(item.get("title") or ""))[:300],
                snippet=_collapse(str(item.get("content") or ""))[:500],
                rank=index,
            )
        )
    hits = await _filter_fetchable_hits(raw_hits, max_results)
    return SearchOutcome(ok=True, query=query, provider="tavily", hits=hits)


async def _search_duckduckgo(query: str, max_results: int) -> SearchOutcome:
    """DuckDuckGo HTML 端点兜底搜索。"""
    async with httpx.AsyncClient(
        timeout=_TIMEOUT,
        follow_redirects=True,
        headers={"User-Agent": _UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"},
    ) as client:
        response = await client.post(_DDG_ENDPOINT, data={"q": query})
        if response.status_code == 429:
            return SearchOutcome(
                ok=False, query=query, provider="duckduckgo",
                error="搜索请求过于频繁", error_category="rate_limited",
            )
        response.raise_for_status()
        html = response.text

    tree = HTMLParser(html)
    raw_hits: list[SearchHit] = []
    seen: set[str] = set()

    for node in tree.css("div.result, div.web-result"):
        if len(raw_hits) >= max_results * 4:
            break
        link = node.css_first("a.result__a")
        if link is None:
            continue
        url = _clean_ddg_url(link.attributes.get("href") or "")
        if not url or url in seen:
            continue
        seen.add(url)
        snippet_node = node.css_first(".result__snippet")
        raw_hits.append(
            SearchHit(
                url=url,
                title=_collapse(link.text())[:300],
                snippet=_collapse(snippet_node.text() if snippet_node else "")[:500],
                rank=len(raw_hits) + 1,
            )
        )

    hits = await _filter_fetchable_hits(raw_hits, max_results)

    return SearchOutcome(ok=True, query=query, provider="duckduckgo", hits=hits)


async def _search_provider_with_retries(
    query: str,
    max_results: int,
    provider: str,
    key: str | None,
    max_attempts: int,
) -> SearchOutcome:
    last_error: SearchOutcome | None = None
    for attempt in range(max_attempts):
        try:
            if provider == "tavily":
                assert key
                outcome = await _search_tavily(query, max_results, key)
            else:
                outcome = await _search_duckduckgo(query, max_results)
            if outcome.ok:
                return outcome
            last_error = outcome
            if outcome.error_category in {"auth_required", "rate_limited"}:
                break
        except httpx.TimeoutException:
            last_error = SearchOutcome(
                ok=False, query=query, provider=provider,
                error="搜索请求超时", error_category="timeout",
            )
        except httpx.HTTPError as exc:
            last_error = SearchOutcome(
                ok=False, query=query, provider=provider,
                error=f"搜索服务不可用：{type(exc).__name__}",
                error_category="provider_unavailable",
            )

        if attempt < max_attempts - 1:
            await asyncio.sleep(0.5 * (2 ** attempt))

    return last_error or SearchOutcome(
        ok=False, query=query, provider=provider,
        error="搜索失败", error_category="provider_unavailable",
    )


async def web_search(
    query: str,
    max_results: int = 8,
    max_attempts: int = 3,
    *,
    default_provider: str = "tavily",
    allow_duckduckgo_fallback: bool = True,
) -> SearchOutcome:
    """执行一次网页搜索。

    返回候选列表。空结果是合法结果，不构造伪候选
    （项目文档 9.5 节：禁止在搜索失败时制造占位结果）。

    对瞬时网络错误（超时、连接失败、5xx）做指数退避重试。
    DuckDuckGo 兜底端点实测失败率约三分之一，重试后接近全成功；
    有 Key 的 Tavily 稳定得多，但同一重试逻辑同样适用。
    """
    query = (query or "").strip()
    if not query:
        return SearchOutcome(
            ok=False, query=query, provider="none",
            error="搜索词为空", error_category="invalid_arguments",
        )

    key = _tavily_key()
    if default_provider == "duckduckgo":
        return await _search_provider_with_retries(
            query, max_results, "duckduckgo", None, max_attempts
        )

    if not key:
        if not allow_duckduckgo_fallback:
            return SearchOutcome(
                ok=False,
                query=query,
                provider="tavily",
                error="Tavily 未配置且 DuckDuckGo 回退已停用",
                error_category="auth_required",
            )
        return await _search_provider_with_retries(
            query, max_results, "duckduckgo", None, max_attempts
        )

    primary = await _search_provider_with_retries(
        query, max_results, "tavily", key, max_attempts
    )
    if primary.ok or not allow_duckduckgo_fallback:
        return primary
    return await _search_provider_with_retries(
        query, max_results, "duckduckgo", None, max_attempts
    )


async def search_many(queries: list[str], max_results: int = 8) -> list[SearchOutcome]:
    """并发执行多条查询，用于计划中的多个分面。"""
    if not queries:
        return []
    semaphore = asyncio.Semaphore(3)

    async def one(q: str) -> SearchOutcome:
        async with semaphore:
            return await web_search(q, max_results)

    return list(await asyncio.gather(*(one(q) for q in queries)))
