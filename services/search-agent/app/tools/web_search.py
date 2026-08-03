"""网页搜索工具。

搜索只负责「发现候选」，不产出证据。项目文档 10.1 节明确要求：
搜索结果的 title/snippet 不能当作事实，必须经 fetch_page 读取原文后
才能进入证据链。因此本模块只返回候选 URL 列表。

Provider 策略：
- 配置了 Tavily API Key 池时走 Tavily（项目文档指定的首选）。
- 当前 Key 认证失败、限流、额度耗尽或不可用时，按配置顺序切换下一把 Key。
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
import random
import re
import threading
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from urllib.parse import parse_qs, unquote, urlparse

import httpx
from selectolax.parser import HTMLParser

from app.reliability.retry import ErrorKind, RetryPolicy, next_delay, parse_retry_after
from app.tools.url_policy import is_fetchable

# DuckDuckGo 的无 JS HTML 端点。不需要 Key，但会限流，
# 因此仅作为兜底而非主路径。
_DDG_ENDPOINT = "https://html.duckduckgo.com/html/"
_TAVILY_ENDPOINT = "https://api.tavily.com/search"

_UA = "Mozilla/5.0 (compatible; AgentWorkbench-SearchAgent/0.1)"

_TIMEOUT = httpx.Timeout(connect=5.0, read=15.0, write=10.0, pool=5.0)

_TAVILY_CREDENTIAL_FAILURES = frozenset(
    {"auth_required", "rate_limited", "quota_exhausted"}
)
_RETRYABLE_HTTP_STATUSES = frozenset({500, 502, 503, 504})
_DEFAULT_MAX_ELAPSED_SECONDS = 30.0
_TAVILY_PROVIDER_FAILURE_KEY_LIMIT = 2
_TAVILY_KEY_STATE_LOCK = threading.Lock()
_tavily_key_state_signature: tuple[str, ...] = ()
_tavily_key_state_index = 0


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
    # 仅供 Provider 重试层使用，不投影到公共 AgentEvent 协议。
    retry_after_seconds: float | None = field(default=None, repr=False, compare=False)

    @property
    def urls(self) -> list[str]:
        return [hit.url for hit in self.hits]


def _deduplicate_keys(values: list[object]) -> tuple[str, ...]:
    keys: list[str] = []
    seen: set[str] = set()
    for value in values:
        if not isinstance(value, str):
            continue
        key = value.strip()
        if not key or key in seen:
            continue
        seen.add(key)
        keys.append(key)
    return tuple(keys)


def _split_env_keys(value: str) -> list[str]:
    return re.split(r"[,;\r\n]+", value)


def _tavily_keys_from_config(data: object) -> tuple[str, ...]:
    """按优先池、旧单 Key、末级备用池的顺序解析私密配置。"""
    if not isinstance(data, dict):
        return ()
    search = data.get("search")
    if not isinstance(search, dict):
        return ()
    providers = search.get("providers")
    if not isinstance(providers, dict):
        return ()
    tavily = providers.get("tavily")
    if not isinstance(tavily, dict):
        return ()

    priority = tavily.get("apiKeys")
    fallback = tavily.get("fallbackApiKeys")
    values: list[object] = []
    if isinstance(priority, list):
        values.extend(priority)
    values.append(tavily.get("apiKey"))
    if isinstance(fallback, list):
        values.extend(fallback)
    return _deduplicate_keys(values)


def _tavily_keys() -> tuple[str, ...]:
    """读取有序 Tavily Key 池。

    优先级：服务端环境变量 > config/search.local.json。环境变量支持
    ``TAVILY_API_KEYS``（逗号、分号或换行分隔）、兼容旧
    ``TAVILY_API_KEY``，以及末级 ``TAVILY_FALLBACK_API_KEYS``。

    本地配置顺序为 ``apiKeys`` 优先池 > 兼容旧 ``apiKey`` >
    ``fallbackApiKeys`` 末级备用池。
    该配置文件已被 .gitignore（config/*.local.json）忽略；Key 只在进程内持有，
    不写入日志、事件或返回给浏览器的内容。
    """
    env_values = [
        *_split_env_keys(os.environ.get("TAVILY_API_KEYS", "")),
        os.environ.get("TAVILY_API_KEY", ""),
        *_split_env_keys(os.environ.get("TAVILY_FALLBACK_API_KEYS", "")),
    ]
    env_keys = _deduplicate_keys(env_values)
    if env_keys:
        return env_keys

    # search-agent/app/tools/web_search.py -> 上溯到仓库根的 config/
    repo_root = pathlib.Path(__file__).resolve().parents[4]
    config_file = repo_root / "config" / "search.local.json"
    if not config_file.is_file():
        return ()
    try:
        data = json.loads(config_file.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return ()
    return _tavily_keys_from_config(data)


def _reset_tavily_key_state() -> None:
    """重置进程内游标，供配置变化和确定性测试使用。"""
    global _tavily_key_state_index, _tavily_key_state_signature
    with _TAVILY_KEY_STATE_LOCK:
        _tavily_key_state_signature = ()
        _tavily_key_state_index = 0


def _tavily_key_candidates(keys: tuple[str, ...]) -> tuple[tuple[int, str], ...]:
    """从当前进程游标返回剩余 Key，不在请求或日志中暴露索引对应值。"""
    global _tavily_key_state_index, _tavily_key_state_signature
    with _TAVILY_KEY_STATE_LOCK:
        if _tavily_key_state_signature != keys:
            _tavily_key_state_signature = keys
            _tavily_key_state_index = 0
        start = min(_tavily_key_state_index, max(len(keys) - 1, 0))
    return tuple(enumerate(keys[start:], start=start))


def _select_tavily_key(keys: tuple[str, ...], index: int) -> None:
    """将后续请求游标推进到成功 Key 或当前失败 Key 的下一位。"""
    global _tavily_key_state_index
    if not keys:
        return
    with _TAVILY_KEY_STATE_LOCK:
        if _tavily_key_state_signature != keys:
            return
        _tavily_key_state_index = min(
            max(_tavily_key_state_index, index, 0),
            len(keys) - 1,
        )


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
        if response.status_code in {401, 403}:
            return SearchOutcome(
                ok=False, query=query, provider="tavily",
                error="Tavily 认证失败", error_category="auth_required",
            )
        if response.status_code == 429:
            return SearchOutcome(
                ok=False, query=query, provider="tavily",
                error="Tavily 请求过于频繁", error_category="rate_limited",
                retry_after_seconds=parse_retry_after(
                    response.headers.get("Retry-After")
                ),
            )
        if response.status_code == 432:
            return SearchOutcome(
                ok=False, query=query, provider="tavily",
                error="Tavily 额度已用尽", error_category="quota_exhausted",
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
                retry_after_seconds=parse_retry_after(
                    response.headers.get("Retry-After")
                ),
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


def _error_kind_for_outcome(outcome: SearchOutcome) -> ErrorKind:
    if outcome.error_category == "rate_limited":
        return ErrorKind.RATE_LIMIT
    if outcome.error_category == "timeout":
        return ErrorKind.TIMEOUT
    if outcome.error_category == "provider_unavailable":
        return ErrorKind.TRANSIENT
    return ErrorKind.PERMANENT


async def _search_provider_with_retries(
    query: str,
    max_results: int,
    provider: str,
    key: str | None,
    max_attempts: int,
    *,
    max_elapsed_seconds: float = _DEFAULT_MAX_ELAPSED_SECONDS,
    retry_policy: RetryPolicy | None = None,
    sleeper: Callable[[float], Awaitable[None]] | None = None,
    clock: Callable[[], float] | None = None,
    random_source: Callable[[], float] | None = None,
) -> SearchOutcome:
    """在次数与累计耗时双重预算内调用单个 Provider。"""
    policy = retry_policy or RetryPolicy(
        max_attempts=max_attempts,
        max_elapsed_seconds=max_elapsed_seconds,
    )
    sleep = sleeper or asyncio.sleep
    monotonic = clock or time.monotonic
    rng = random_source or random.random
    started_at = monotonic()
    last_error: SearchOutcome | None = None
    for attempt in range(1, policy.max_attempts + 1):
        elapsed = max(0.0, monotonic() - started_at)
        remaining = policy.max_elapsed_seconds - elapsed
        if remaining <= 0:
            break

        error_kind = ErrorKind.PERMANENT
        try:
            async with asyncio.timeout(remaining):
                if provider == "tavily":
                    assert key
                    outcome = await _search_tavily(query, max_results, key)
                else:
                    outcome = await _search_duckduckgo(query, max_results)
            if outcome.ok:
                return outcome
            last_error = outcome
            error_kind = _error_kind_for_outcome(outcome)
        except (TimeoutError, httpx.TimeoutException):
            last_error = SearchOutcome(
                ok=False, query=query, provider=provider,
                error="搜索请求超时", error_category="timeout",
            )
            error_kind = ErrorKind.TIMEOUT
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            last_error = SearchOutcome(
                ok=False, query=query, provider=provider,
                error=f"搜索服务不可用：HTTP {status}",
                error_category="provider_unavailable",
                retry_after_seconds=parse_retry_after(
                    exc.response.headers.get("Retry-After")
                ),
            )
            error_kind = (
                ErrorKind.TRANSIENT
                if status in _RETRYABLE_HTTP_STATUSES
                else ErrorKind.PERMANENT
            )
        except httpx.RequestError as exc:
            last_error = SearchOutcome(
                ok=False, query=query, provider=provider,
                error=f"搜索网络不可用：{type(exc).__name__}",
                error_category="provider_unavailable",
            )
            error_kind = ErrorKind.TRANSIENT
        except httpx.HTTPError as exc:
            last_error = SearchOutcome(
                ok=False, query=query, provider=provider,
                error=f"搜索服务不可用：{type(exc).__name__}",
                error_category="provider_unavailable",
            )
            error_kind = ErrorKind.PERMANENT

        elapsed = max(0.0, monotonic() - started_at)
        delay = next_delay(
            policy,
            error_kind=error_kind,
            attempt=attempt,
            elapsed_seconds=elapsed,
            random_value=rng(),
            retry_after_seconds=(
                last_error.retry_after_seconds if last_error is not None else None
            ),
        )
        if delay is None:
            break
        await sleep(delay)

    return last_error or SearchOutcome(
        ok=False, query=query, provider=provider,
        error="搜索失败", error_category="provider_unavailable",
    )


async def _search_tavily_key_pool(
    query: str,
    max_results: int,
    keys: tuple[str, ...],
    max_attempts: int,
    max_elapsed_seconds: float,
) -> SearchOutcome:
    """按进程内游标尝试 Key；凭据故障可遍历全池，服务故障最多换两把。"""
    candidates = _tavily_key_candidates(keys)
    last_error: SearchOutcome | None = None
    provider_failures = 0
    attempts_per_key = max_attempts if len(candidates) <= 1 else 1

    for index, key in candidates:
        outcome = await _search_provider_with_retries(
            query,
            max_results,
            "tavily",
            key,
            attempts_per_key,
            max_elapsed_seconds=max_elapsed_seconds,
        )
        if outcome.ok:
            _select_tavily_key(keys, index)
            return outcome

        last_error = outcome
        if outcome.error_category in _TAVILY_CREDENTIAL_FAILURES:
            _select_tavily_key(keys, index + 1)
            continue

        provider_failures += 1
        if provider_failures >= min(_TAVILY_PROVIDER_FAILURE_KEY_LIMIT, len(candidates)):
            break

    return last_error or SearchOutcome(
        ok=False,
        query=query,
        provider="tavily",
        error="Tavily Key 池不可用",
        error_category="auth_required",
    )


async def web_search(
    query: str,
    max_results: int = 8,
    max_attempts: int = 3,
    *,
    max_elapsed_seconds: float = _DEFAULT_MAX_ELAPSED_SECONDS,
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

    if default_provider == "duckduckgo":
        return await _search_provider_with_retries(
            query,
            max_results,
            "duckduckgo",
            None,
            max_attempts,
            max_elapsed_seconds=max_elapsed_seconds,
        )

    keys = _tavily_keys()
    if not keys:
        if not allow_duckduckgo_fallback:
            return SearchOutcome(
                ok=False,
                query=query,
                provider="tavily",
                error="Tavily 未配置且 DuckDuckGo 回退已停用",
                error_category="auth_required",
            )
        return await _search_provider_with_retries(
            query,
            max_results,
            "duckduckgo",
            None,
            max_attempts,
            max_elapsed_seconds=max_elapsed_seconds,
        )

    primary = await _search_tavily_key_pool(
        query,
        max_results,
        keys,
        max_attempts,
        max_elapsed_seconds,
    )
    if primary.ok or not allow_duckduckgo_fallback:
        return primary
    return await _search_provider_with_retries(
        query,
        max_results,
        "duckduckgo",
        None,
        max_attempts,
        max_elapsed_seconds=max_elapsed_seconds,
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
