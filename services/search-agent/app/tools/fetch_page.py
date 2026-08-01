"""网页抓取工具：静态快路径 + 动态降级。

分层策略取自项目文档 10.1 节：
1. 静态层 httpx + trafilatura —— 默认路径，成本低、延迟小。
2. 动态层 Crawl4AI + Playwright —— 仅当静态正文不足时升级。

抓取前一律走 `url_policy` 校验，禁止绕过。
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from urllib.parse import urlsplit

import httpx
import trafilatura

from app.tools.robots_policy import check_robots
from app.tools.url_policy import UrlPolicyError, resolve_fetchable

# 静态正文视为「足够」的最小可见字符数。
# 项目文档 21.2 节给的起点是 400；低于此值才升级动态抓取。
# 长度只是信号：短公告或 API 文档也可能有效，因此仅用于决定是否升级，
# 不用于判定内容无效。
MIN_STATIC_TEXT = 400

# 单页响应体上限，防止超大页面拖垮内存。
MAX_RESPONSE_BYTES = 5 * 1024 * 1024

# 正文截断上限。证据片段无需整页，过长内容会挤占模型上下文。
MAX_TEXT_CHARS = 20_000

# 公开正文读取必须有界：全局最多 3 页，同一域名最多 2 页。
# 这既避免三个同域候选完全串行，也不会向单站点发起无界并发。
MAX_FETCH_CONCURRENCY = 3
MAX_PER_DOMAIN_CONCURRENCY = 2

_ALLOWED_CONTENT_TYPES = (
    "text/html",
    "application/xhtml+xml",
    "application/xml",
    "text/xml",
    "text/plain",
)

_HEADERS = {
    # 如实标识自己，便于站点识别与限流，不伪装成普通浏览器。
    "user-agent": "agent-workbench-search/0.1 (+https://github.com/LuzernRR/agent-workbench)",
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    # 搜索来源常由 CDN 返回 brotli/zstd。容器中的可选解码器组合可能与
    # httpx 广告能力不一致，曾导致官方 LangGraph 页面抛 DecodingError。
    # 抓取正文优先保证可审计与稳定，明确请求 identity 避免无意义解码失败。
    "accept-encoding": "identity",
}


@dataclass(slots=True)
class FetchResult:
    """一次抓取的结果。

    `extractor` 记录正文由哪一层产出，便于审计与排查。
    """

    url: str
    ok: bool
    status: int | None = None
    title: str | None = None
    text: str = ""
    extractor: str = "none"
    error: str | None = None
    error_category: str | None = None

    @property
    def char_count(self) -> int:
        return len(self.text)


class ResponsePolicyError(RuntimeError):
    def __init__(self, message: str, category: str = "output_invalid") -> None:
        super().__init__(message)
        self.category = category


def _truncate(text: str) -> str:
    text = text.strip()
    if len(text) <= MAX_TEXT_CHARS:
        return text
    return text[:MAX_TEXT_CHARS] + "\n…（正文已截断）"


async def _fetch_static(url: str, timeout: float) -> FetchResult:
    """静态抓取：httpx 拉取 HTML，trafilatura 抽取正文。"""
    try:
        robots = await check_robots(url, timeout=min(timeout, 10.0))
        if not robots.allowed:
            return FetchResult(
                url=url,
                ok=False,
                error=f"robots.txt 拒绝或无法安全确认：{robots.reason}",
                error_category="robots_denied",
            )
        response, url = await _pinned_get(url, timeout)

        # 逐跳重新解析、校验并固定目标 IP，最多 3 跳。
        hops = 0
        while response.is_redirect and hops < 3:
            location = response.headers.get("location")
            if not location:
                break
            target = str(httpx.URL(url).join(location))
            robots = await check_robots(target, timeout=min(timeout, 10.0))
            if not robots.allowed:
                return FetchResult(
                    url=target,
                    ok=False,
                    error=f"重定向目标的 robots.txt 拒绝或无法安全确认：{robots.reason}",
                    error_category="robots_denied",
                )
            response, url = await _pinned_get(target, timeout)
            hops += 1

        if response.is_redirect:
            return FetchResult(url=url, ok=False, error="重定向次数过多", error_category="too_many_redirects")

        if response.status_code >= 400:
            return FetchResult(
                url=url,
                ok=False,
                status=response.status_code,
                error=f"HTTP {response.status_code}",
                error_category="not_found" if response.status_code == 404 else "provider_unavailable",
            )

        if len(response.content) > MAX_RESPONSE_BYTES:
            return FetchResult(url=url, ok=False, status=response.status_code,
                               error="响应体超出上限", error_category="output_invalid")

        text = trafilatura.extract(response.text, url=url) or ""
        title = None
        meta = trafilatura.extract_metadata(response.text)
        if meta is not None:
            title = getattr(meta, "title", None)

        return FetchResult(
            url=url,
            ok=bool(text),
            status=response.status_code,
            title=title,
            text=_truncate(text),
            extractor="trafilatura",
            error=None if text else "静态提取未获得正文",
            error_category=None if text else "empty_result",
        )
    except httpx.TimeoutException:
        return FetchResult(url=url, ok=False, error="抓取超时", error_category="timeout")
    except UrlPolicyError as exc:
        return FetchResult(url=url, ok=False, error=f"URL 被安全策略拒绝：{exc.reason}",
                           error_category="permission_denied")
    except ResponsePolicyError as exc:
        return FetchResult(url=url, ok=False, error=str(exc), error_category=exc.category)
    except httpx.HTTPError as exc:
        return FetchResult(url=url, ok=False, error=f"网络错误：{type(exc).__name__}",
                           error_category="provider_unavailable")


async def _pinned_get(url: str, timeout: float) -> tuple[httpx.Response, str]:
    """校验 DNS 后直接连接固定公网 IP，同时保留原 Host 与 TLS SNI。"""
    target = await asyncio.to_thread(resolve_fetchable, url)
    authority = urlsplit(target.url).netloc
    last_error: httpx.HTTPError | None = None
    for address in target.addresses:
        connect_url = httpx.URL(target.url).copy_with(host=address)
        headers = {**_HEADERS, "host": authority}
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(timeout, connect=5.0),
                follow_redirects=False,
                trust_env=False,
            ) as client:
                request = client.build_request("GET", connect_url, headers=headers)
                request.extensions["sni_hostname"] = target.hostname
                response = await client.send(request, stream=True)
                try:
                    if response.is_redirect:
                        content = b""
                    else:
                        content_type = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
                        if response.status_code < 400 and content_type not in _ALLOWED_CONTENT_TYPES:
                            raise ResponsePolicyError(
                                f"不支持的响应类型：{content_type or 'missing'}"
                            )
                        declared = response.headers.get("content-length")
                        if declared:
                            try:
                                if int(declared) > MAX_RESPONSE_BYTES:
                                    raise ResponsePolicyError("响应体超出上限")
                            except ValueError as exc:
                                raise ResponsePolicyError("Content-Length 格式无效") from exc
                        body = bytearray()
                        async for chunk in response.aiter_bytes():
                            body.extend(chunk)
                            if len(body) > MAX_RESPONSE_BYTES:
                                raise ResponsePolicyError("响应体超出上限")
                        content = bytes(body)
                finally:
                    await response.aclose()
            return httpx.Response(
                response.status_code,
                headers=response.headers,
                content=content,
                request=request,
                extensions=response.extensions,
            ), target.url
        except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
            last_error = exc
    if last_error:
        raise last_error
    raise httpx.ConnectError("没有可连接的固定公网地址")


async def _fetch_dynamic(url: str) -> FetchResult:
    """动态浏览器抓取须由隔离网络代理实现；当前进程 fail closed。"""
    return FetchResult(
        url=url,
        ok=False,
        error="动态抓取尚未配置隔离网络策略",
        error_category="permission_denied",
    )


async def fetch_page(url: str, timeout: float = 20.0, allow_dynamic: bool = False) -> FetchResult:
    """抓取单页正文；timeout 覆盖 robots、解析、重定向和正文的总生命周期。"""

    try:
        async with asyncio.timeout(max(0.001, timeout)):
            static = await _fetch_static(url, timeout)
            if static.ok and static.char_count >= MIN_STATIC_TEXT:
                return static

            if not allow_dynamic:
                return static

            dynamic = await _fetch_dynamic(url)
            # 动态失败时保留静态结果：短正文也胜过没有正文。
            if not dynamic.ok and static.ok:
                return static
            return dynamic
    except TimeoutError:
        return FetchResult(
            url=url,
            ok=False,
            error="抓取超过单页总时限",
            error_category="timeout",
        )


async def fetch_pages(urls: list[str], concurrency: int = 3, timeout: float = 20.0) -> list[FetchResult]:
    """并发抓取多页。

    并发上限对应项目文档 21.2 节的单域限制，避免给目标站点造成压力。
    """
    global_limit = max(1, min(concurrency, MAX_FETCH_CONCURRENCY))
    domain_limit = min(global_limit, MAX_PER_DOMAIN_CONCURRENCY)
    semaphore = asyncio.Semaphore(global_limit)
    domain_semaphores: dict[str, asyncio.Semaphore] = {}

    async def one(url: str) -> FetchResult:
        domain = (urlsplit(url).hostname or "").lower()
        domain_semaphore = domain_semaphores.setdefault(
            domain,
            asyncio.Semaphore(domain_limit),
        )
        async with semaphore, domain_semaphore:
            return await fetch_page(url, timeout=timeout)

    return list(await asyncio.gather(*(one(url) for url in urls)))
