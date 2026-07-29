"""实时 robots.txt 门禁。

所有项目自有的公开页面读取都先检查目标源站策略。策略缺失（404/410）
按 RFC 语义允许；拒绝、限流、服务异常、重定向或无法安全解析时一律
fail closed。缓存只减少同一运行进程内的重复读取，不绕过实时策略。
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from urllib.parse import urlsplit, urlunsplit
from urllib.robotparser import RobotFileParser

import httpx

from app.tools.url_policy import UrlPolicyError, resolve_fetchable

ROBOTS_USER_AGENT = "agent-workbench-search"
ROBOTS_CACHE_SECONDS = 600
MAX_ROBOTS_BYTES = 512 * 1024

_HEADERS = {
    "user-agent": (
        "agent-workbench-search/0.2 "
        "(+https://github.com/LuzernRR/agent-workbench)"
    ),
    "accept": "text/plain,text/*;q=0.9",
    "accept-encoding": "identity",
}


@dataclass(frozen=True, slots=True)
class RobotsDecision:
    allowed: bool
    reason: str
    policy_url: str
    status: int | None


@dataclass(slots=True)
class _CachedPolicy:
    expires_at: float
    parser: RobotFileParser | None
    status: int | None
    failure_reason: str | None = None
    missing: bool = False


_CACHE: dict[str, _CachedPolicy] = {}
_CACHE_LOCK = asyncio.Lock()


def _origin_and_policy_url(url: str) -> tuple[str, str]:
    parts = urlsplit(url)
    origin = urlunsplit((parts.scheme, parts.netloc, "", "", ""))
    return origin, f"{origin}/robots.txt"


async def _pinned_robots_get(url: str, timeout: float) -> httpx.Response:
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
                    declared = response.headers.get("content-length")
                    if declared and int(declared) > MAX_ROBOTS_BYTES:
                        raise ValueError("ROBOTS_TOO_LARGE")
                    body = bytearray()
                    async for chunk in response.aiter_bytes():
                        body.extend(chunk)
                        if len(body) > MAX_ROBOTS_BYTES:
                            raise ValueError("ROBOTS_TOO_LARGE")
                finally:
                    await response.aclose()
            return httpx.Response(
                response.status_code,
                headers=response.headers,
                content=bytes(body),
                request=request,
            )
        except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
            last_error = exc
    if last_error:
        raise last_error
    raise httpx.ConnectError("没有可连接的 robots.txt 公网地址")


async def _load_policy(policy_url: str, timeout: float) -> _CachedPolicy:
    try:
        response = await _pinned_robots_get(policy_url, timeout)
    except UrlPolicyError:
        return _CachedPolicy(0, None, None, "ROBOTS_POLICY_REJECTED")
    except httpx.TimeoutException:
        return _CachedPolicy(0, None, None, "ROBOTS_TIMEOUT")
    except (httpx.HTTPError, UnicodeDecodeError, ValueError):
        return _CachedPolicy(0, None, None, "ROBOTS_UNAVAILABLE")

    if response.is_redirect:
        return _CachedPolicy(0, None, response.status_code, "ROBOTS_REDIRECTED")
    if response.status_code in {404, 410}:
        return _CachedPolicy(0, None, response.status_code, missing=True)
    if response.status_code in {401, 403}:
        return _CachedPolicy(0, None, response.status_code, "ROBOTS_DENIED")
    if response.status_code >= 400:
        return _CachedPolicy(0, None, response.status_code, "ROBOTS_UNAVAILABLE")
    content_type = response.headers.get("content-type", "").split(";", 1)[0].lower()
    if content_type and not content_type.startswith("text/"):
        return _CachedPolicy(0, None, response.status_code, "ROBOTS_OUTPUT_INVALID")
    try:
        text = response.content.decode("utf-8-sig", errors="strict")
        if "\x00" in text:
            raise ValueError("NUL")
        parser = RobotFileParser(policy_url)
        parser.parse(text.splitlines())
    except (UnicodeDecodeError, ValueError):
        return _CachedPolicy(0, None, response.status_code, "ROBOTS_OUTPUT_INVALID")
    return _CachedPolicy(0, parser, response.status_code)


async def check_robots(
    url: str,
    *,
    user_agent: str = ROBOTS_USER_AGENT,
    timeout: float = 10.0,
) -> RobotsDecision:
    """返回目标 URL 的实时 robots 决策；任何不确定状态都拒绝读取。"""
    origin, policy_url = _origin_and_policy_url(url)
    now = time.monotonic()
    async with _CACHE_LOCK:
        policy = _CACHE.get(origin)
        if not policy or policy.expires_at <= now:
            policy = await _load_policy(policy_url, timeout)
            policy.expires_at = now + ROBOTS_CACHE_SECONDS
            _CACHE[origin] = policy

    if policy.failure_reason:
        return RobotsDecision(False, policy.failure_reason, policy_url, policy.status)
    if policy.missing:
        return RobotsDecision(True, "ROBOTS_MISSING", policy_url, policy.status)
    if policy.parser is None:
        return RobotsDecision(False, "ROBOTS_OUTPUT_INVALID", policy_url, policy.status)
    allowed = policy.parser.can_fetch(user_agent, url)
    return RobotsDecision(
        allowed,
        "ROBOTS_ALLOWED" if allowed else "ROBOTS_DENIED",
        policy_url,
        policy.status,
    )


def clear_robots_cache() -> None:
    """测试和运维刷新入口；不会修改外部状态。"""
    _CACHE.clear()
