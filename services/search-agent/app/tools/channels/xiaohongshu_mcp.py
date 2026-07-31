"""受限的小红书登录态读取渠道。

该适配器只连接部署内的 ``xiaohongshu-mcp`` 服务，并把上游宽泛 API
收口为五类只读操作：登录状态、登录二维码、搜索、笔记详情和用户主页。
发布、评论、点赞、收藏、删除 Cookie 等操作在发起网络请求前即被拒绝。

搜索事件只包含规范化后的公开来源和正文；二维码、Cookie、xsec_token
不会进入 ``ChannelOutcome``、日志或模型工具消息。
"""

from __future__ import annotations

import asyncio
import os
import re
import time
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any
from urllib.parse import urlsplit
from weakref import WeakKeyDictionary

import httpx
from pydantic import BaseModel, ConfigDict, Field, SecretStr

from app.config.agent import AgentConfig
from app.tools.channels.base import (
    ChannelEvidence,
    ChannelOutcome,
    ChannelProgressReporter,
    ChannelResult,
    SourceProvenance,
    channel_resolution,
    report_progress,
)
from app.tools.channels.xiaohongshu_public import XiaohongshuPublicChannel

_MCP_PROVIDER = "xiaohongshu-mcp"
_MCP_HOST = "xiaohongshu-mcp"
_MCP_PORT = 18060
_MAX_RESPONSE_BYTES = 4 * 1024 * 1024
_MAX_EVIDENCE_CHARS = 2_400
_MAX_RETRYABLE_ATTEMPT_SECONDS = 3.0
_MAX_DETAIL_TOTAL_SECONDS = 24.0
_MIN_SUBSTANTIVE_DESCRIPTION_CHARS = 12
_SAFE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{3,96}$")
_SAFE_TOKEN_RE = re.compile(r"^[^\s]{8,4096}$")
_TOPIC_TAG_RE = re.compile(r"#[^#]{1,80}(?:\[话题\])?#")
_SEARCH_LOCKS: WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Lock] = (
    WeakKeyDictionary()
)
_FALLBACK_ERROR_CODES = {
    "AUTH_REQUIRED",
    "CAPTCHA_REQUIRED",
    "MCP_NETWORK_ERROR",
    "MCP_TIMEOUT",
    "MCP_UNAVAILABLE",
    "MCP_OUTPUT_INVALID",
    "MCP_RATE_LIMITED",
}


def _server_failure_code(response: httpx.Response) -> str:
    """把受控 MCP 500 响应细分为稳定错误码，不泄露上游详情。"""

    try:
        payload = response.json()
    except ValueError:
        return "MCP_UNAVAILABLE"
    raw = _dict(payload)
    stable_code = _safe_text(raw.get("code"), 80).upper()
    if stable_code in _FALLBACK_ERROR_CODES:
        return stable_code
    detail = _safe_text(raw.get("details"), 500).casefold()
    if any(
        marker in detail
        for marker in (
            "安全验证",
            "captcha",
        )
    ):
        return "CAPTCHA_REQUIRED"
    if any(
        marker in detail
        for marker in (
            "deadline exceeded",
            "deadlineexceeded",
            "timeout",
            "timed out",
        )
    ):
        return "MCP_TIMEOUT"
    if any(
        marker in detail
        for marker in (
            "net.operror",
            "connection reset",
            "connection refused",
            "network is unreachable",
            "tls handshake",
        )
    ):
        return "MCP_NETWORK_ERROR"
    return "MCP_UNAVAILABLE"


def _search_lock() -> asyncio.Lock:
    """同一进程内串行化完整的小红书浏览器检索会话。

    上游每次搜索和详情读取都会启动浏览器。并发运行会互相争用浏览器与
    平台会话，原本数十秒的调用可能拖到运行硬超时。按事件循环维护锁，
    既覆盖不同 ``ChannelRegistry`` 实例，也避免测试事件循环之间串锁。
    """

    loop = asyncio.get_running_loop()
    lock = _SEARCH_LOCKS.get(loop)
    if lock is None:
        lock = asyncio.Lock()
        _SEARCH_LOCKS[loop] = lock
    return lock


class StrictMcpModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class XiaohongshuMcpOperation(StrEnum):
    LOGIN_STATUS = "login_status"
    LOGIN_QRCODE = "login_qrcode"
    SEARCH_FEEDS = "search_feeds"
    FEED_DETAIL = "feed_detail"
    USER_PROFILE = "user_profile"


_RETRYABLE_OPERATIONS = {
    XiaohongshuMcpOperation.SEARCH_FEEDS,
}


_READ_ONLY_ROUTES: dict[XiaohongshuMcpOperation, tuple[str, str]] = {
    XiaohongshuMcpOperation.LOGIN_STATUS: ("GET", "/api/v1/login/status"),
    XiaohongshuMcpOperation.LOGIN_QRCODE: ("GET", "/api/v1/login/qrcode"),
    XiaohongshuMcpOperation.SEARCH_FEEDS: ("POST", "/api/v1/feeds/search"),
    XiaohongshuMcpOperation.FEED_DETAIL: ("POST", "/api/v1/feeds/detail"),
    XiaohongshuMcpOperation.USER_PROFILE: ("POST", "/api/v1/user/profile"),
}


class XiaohongshuMcpError(RuntimeError):
    """对外只保留稳定错误码和不含上游响应的安全说明。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class XiaohongshuMcpPolicyError(XiaohongshuMcpError):
    pass


class XiaohongshuLoginStatus(StrictMcpModel):
    is_logged_in: bool
    username: str | None = None
    user_id: str | None = None


class XiaohongshuLoginQrcode(StrictMcpModel):
    """仅供未来的受认证服务端登录端点使用。

    ``image`` 在 repr 和序列化中均排除，避免被事件、日志或普通 API
    响应意外带出。服务端若要显示二维码，必须显式读取 SecretStr。
    """

    is_logged_in: bool
    timeout: str
    image: SecretStr | None = Field(default=None, exclude=True, repr=False)


class XiaohongshuFeedCandidate(StrictMcpModel):
    feed_id: str
    xsec_token: SecretStr = Field(exclude=True, repr=False)
    title: str
    author: str | None = None
    author_id: str | None = None
    metrics: dict[str, int | float | str] = Field(default_factory=dict)


class XiaohongshuFeedDetail(StrictMcpModel):
    feed_id: str
    title: str
    description: str
    author: str | None = None
    author_id: str | None = None
    published_at: str | None = None
    metrics: dict[str, int | float | str] = Field(default_factory=dict)


class XiaohongshuUserProfile(StrictMcpModel):
    user_id: str
    nickname: str | None = None
    description: str = ""
    red_id: str | None = None
    interactions: dict[str, int | float | str] = Field(default_factory=dict)


def _safe_text(value: Any, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    return re.sub(r"\s+", " ", value).strip()[:limit]


def _safe_optional(value: Any, limit: int) -> str | None:
    text = _safe_text(value, limit)
    return text or None


def _substantive_description(value: str) -> str:
    """标题、话题标签和表情不单独算作可供回答的正文证据。"""

    text = _safe_text(value, _MAX_EVIDENCE_CHARS)
    without_topics = _TOPIC_TAG_RE.sub(" ", text)
    without_mentions = re.sub(r"(?<!\w)@[^\s#]+", " ", without_topics)
    informative = re.findall(r"[\u3400-\u9fffA-Za-z0-9]", without_mentions)
    return (
        text
        if len(informative) >= _MIN_SUBSTANTIVE_DESCRIPTION_CHARS
        else ""
    )


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _metrics(value: Any) -> dict[str, int | float | str]:
    raw = _dict(value)
    result: dict[str, int | float | str] = {}
    for source, target in (
        ("likedCount", "likes"),
        ("collectedCount", "collections"),
        ("commentCount", "comments"),
        ("sharedCount", "shares"),
    ):
        item = raw.get(source)
        if isinstance(item, (int, float, str)) and not isinstance(item, bool):
            safe = str(item).strip()[:40]
            if safe:
                result[target] = int(safe) if safe.isdigit() else safe
    return result


def _published_at(value: Any) -> str | None:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or value <= 0:
        return None
    seconds = float(value) / 1000 if value > 10_000_000_000 else float(value)
    try:
        return datetime.fromtimestamp(seconds, tz=UTC).isoformat().replace("+00:00", "Z")
    except (OSError, OverflowError, ValueError):
        return None


def _validate_internal_origin(origin: str) -> str:
    try:
        parts = urlsplit(origin.strip())
        port = parts.port
    except ValueError as exc:
        raise XiaohongshuMcpPolicyError(
            "MCP_ORIGIN_DENIED",
            "小红书登录态服务地址未通过内部网络策略",
        ) from exc
    if (
        parts.scheme != "http"
        or (parts.hostname or "").casefold() != _MCP_HOST
        or port != _MCP_PORT
        or parts.username
        or parts.password
        or parts.path not in {"", "/"}
        or parts.query
        or parts.fragment
    ):
        raise XiaohongshuMcpPolicyError(
            "MCP_ORIGIN_DENIED",
            "小红书登录态服务只能使用固定 Docker 内部地址",
        )
    return f"http://{_MCP_HOST}:{_MCP_PORT}"


class XiaohongshuMcpClient:
    """固定主机、固定路由、固定方法的最小只读 HTTP 客户端。"""

    def __init__(
        self,
        origin: str,
        *,
        timeout_ms: int,
        detail_timeout_ms: int | None = None,
        max_attempts: int = 2,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.origin = _validate_internal_origin(origin)
        self.timeout = httpx.Timeout(timeout_ms / 1000, connect=5.0)
        effective_detail_timeout = min(
            timeout_ms,
            detail_timeout_ms if detail_timeout_ms is not None else timeout_ms,
        )
        self.detail_timeout = httpx.Timeout(
            effective_detail_timeout / 1000,
            connect=min(5.0, effective_detail_timeout / 1000),
        )
        self.max_attempts = max(1, min(max_attempts, 3))
        self.transport = transport

    async def _request(
        self,
        operation: XiaohongshuMcpOperation | str,
        *,
        body: dict[str, Any] | None = None,
        timeout: httpx.Timeout | None = None,
    ) -> Any:
        try:
            approved = XiaohongshuMcpOperation(operation)
        except ValueError as exc:
            raise XiaohongshuMcpPolicyError(
                "MCP_WRITE_DENIED",
                "小红书适配器拒绝非只读操作",
            ) from exc
        route = _READ_ONLY_ROUTES.get(approved)
        if route is None:
            raise XiaohongshuMcpPolicyError(
                "MCP_WRITE_DENIED",
                "小红书适配器拒绝非只读操作",
            )
        method, path = route
        attempts = self.max_attempts if approved in _RETRYABLE_OPERATIONS else 1
        response: httpx.Response | None = None
        for attempt in range(attempts):
            attempt_started = time.monotonic()
            try:
                async with httpx.AsyncClient(
                    base_url=self.origin,
                    timeout=timeout or self.timeout,
                    follow_redirects=False,
                    trust_env=False,
                    transport=self.transport,
                    headers={
                        "Accept": "application/json",
                        "Content-Type": "application/json",
                        "User-Agent": "agent-workbench-search/0.2",
                    },
                ) as client:
                    response = await client.request(method, path, json=body)
            except httpx.TimeoutException as exc:
                elapsed = time.monotonic() - attempt_started
                if (
                    attempt + 1 < attempts
                    and elapsed < _MAX_RETRYABLE_ATTEMPT_SECONDS
                ):
                    await asyncio.sleep(0.5 * (attempt + 1))
                    continue
                raise XiaohongshuMcpError(
                    "MCP_TIMEOUT",
                    "小红书登录态读取超时",
                ) from exc
            except httpx.HTTPError as exc:
                elapsed = time.monotonic() - attempt_started
                if (
                    attempt + 1 < attempts
                    and elapsed < _MAX_RETRYABLE_ATTEMPT_SECONDS
                ):
                    await asyncio.sleep(0.5 * (attempt + 1))
                    continue
                raise XiaohongshuMcpError(
                    "MCP_UNAVAILABLE",
                    "小红书登录态服务当前不可用",
                ) from exc

            server_failure = (
                _server_failure_code(response)
                if response.status_code >= 500
                else ""
            )
            elapsed = time.monotonic() - attempt_started
            # 页面级 deadline 或安全验证已经给出确定结果，再重试只会成倍
            # 消耗 LangGraph 运行预算；只有快速返回的网络瞬断和未分类 5xx
            # 才保留一次受限重试，慢失败直接交给公开渠道和图内重规划。
            if (
                response.status_code >= 500
                and server_failure not in {"CAPTCHA_REQUIRED", "MCP_TIMEOUT"}
                and attempt + 1 < attempts
                and elapsed < _MAX_RETRYABLE_ATTEMPT_SECONDS
            ):
                await asyncio.sleep(0.5 * (attempt + 1))
                continue
            break

        if response is None:
            raise XiaohongshuMcpError(
                "MCP_UNAVAILABLE",
                "小红书登录态服务当前不可用",
            )

        if len(response.content) > _MAX_RESPONSE_BYTES:
            raise XiaohongshuMcpError(
                "MCP_OUTPUT_INVALID",
                "小红书登录态服务响应超过大小上限",
            )
        if response.status_code == 429:
            raise XiaohongshuMcpError(
                "MCP_RATE_LIMITED",
                "小红书登录态服务请求过于频繁",
            )
        if response.status_code in {401, 403}:
            raise XiaohongshuMcpError(
                "AUTH_REQUIRED",
                "小红书登录状态已失效，需要重新扫码",
            )
        if response.status_code >= 500:
            code = _server_failure_code(response)
            message = {
                "CAPTCHA_REQUIRED": "小红书搜索需要安全验证",
                "MCP_TIMEOUT": "小红书登录态搜索超时",
                "MCP_NETWORK_ERROR": "小红书登录态搜索网络异常",
            }.get(code, "小红书登录态服务读取失败")
            raise XiaohongshuMcpError(
                code,
                message,
            )
        if response.status_code >= 400:
            raise XiaohongshuMcpError(
                "MCP_OUTPUT_INVALID",
                f"小红书登录态服务拒绝只读请求（HTTP {response.status_code}）",
            )
        try:
            payload = response.json()
        except ValueError as exc:
            raise XiaohongshuMcpError(
                "MCP_OUTPUT_INVALID",
                "小红书登录态服务返回的不是有效 JSON",
            ) from exc
        if not isinstance(payload, dict) or payload.get("success") is not True:
            raise XiaohongshuMcpError(
                "MCP_OUTPUT_INVALID",
                "小红书登录态服务返回结构无效",
            )
        return payload.get("data")

    async def check_login_status(self) -> XiaohongshuLoginStatus:
        data = await self._request(XiaohongshuMcpOperation.LOGIN_STATUS)
        raw = _dict(data)
        logged_in = raw.get("is_logged_in")
        if not isinstance(logged_in, bool):
            raise XiaohongshuMcpError(
                "MCP_OUTPUT_INVALID",
                "小红书登录状态响应缺少有效状态",
            )
        return XiaohongshuLoginStatus(
            is_logged_in=logged_in,
            username=_safe_optional(raw.get("username"), 160),
            user_id=_safe_optional(raw.get("user_id"), 96),
        )

    async def get_login_qrcode(self) -> XiaohongshuLoginQrcode:
        data = await self._request(XiaohongshuMcpOperation.LOGIN_QRCODE)
        raw = _dict(data)
        logged_in = raw.get("is_logged_in")
        if not isinstance(logged_in, bool):
            raise XiaohongshuMcpError(
                "MCP_OUTPUT_INVALID",
                "小红书登录二维码响应缺少有效状态",
            )
        image = _safe_optional(raw.get("img"), _MAX_RESPONSE_BYTES)
        if image and not image.startswith("data:image/png;base64,"):
            raise XiaohongshuMcpError(
                "MCP_OUTPUT_INVALID",
                "小红书登录二维码格式无效",
            )
        return XiaohongshuLoginQrcode(
            is_logged_in=logged_in,
            timeout=_safe_text(raw.get("timeout"), 40),
            image=SecretStr(image) if image else None,
        )

    async def search_feeds(
        self,
        query: str,
        max_results: int,
    ) -> list[XiaohongshuFeedCandidate]:
        data = await self._request(
            XiaohongshuMcpOperation.SEARCH_FEEDS,
            body={"keyword": query},
        )
        feeds = _list(_dict(data).get("feeds"))
        results: list[XiaohongshuFeedCandidate] = []
        for item in feeds:
            raw = _dict(item)
            feed_id = _safe_text(raw.get("id"), 96)
            token = raw.get("xsecToken")
            if (
                raw.get("modelType") != "note"
                or not _SAFE_ID_RE.fullmatch(feed_id)
                or not isinstance(token, str)
                or not _SAFE_TOKEN_RE.fullmatch(token)
            ):
                continue
            note = _dict(raw.get("noteCard"))
            user = _dict(note.get("user"))
            results.append(
                XiaohongshuFeedCandidate(
                    feed_id=feed_id,
                    xsec_token=SecretStr(token),
                    title=_safe_text(note.get("displayTitle"), 300)
                    or "小红书公开笔记",
                    author=_safe_optional(
                        user.get("nickname") or user.get("nickName"),
                        160,
                    ),
                    author_id=_safe_optional(user.get("userId"), 96),
                    metrics=_metrics(note.get("interactInfo")),
                )
            )
            if len(results) >= max_results:
                break
        return results

    async def read_feed_detail(
        self,
        feed_id: str,
        xsec_token: SecretStr,
    ) -> XiaohongshuFeedDetail:
        if not _SAFE_ID_RE.fullmatch(feed_id):
            raise XiaohongshuMcpPolicyError(
                "MCP_INPUT_INVALID",
                "小红书笔记 ID 格式无效",
            )
        token = xsec_token.get_secret_value()
        if not _SAFE_TOKEN_RE.fullmatch(token):
            raise XiaohongshuMcpPolicyError(
                "MCP_INPUT_INVALID",
                "小红书笔记访问令牌格式无效",
            )
        data = await self._request(
            XiaohongshuMcpOperation.FEED_DETAIL,
            body={
                "feed_id": feed_id,
                "xsec_token": token,
                "xsec_source": "pc_search",
                "load_all_comments": False,
            },
            timeout=self.detail_timeout,
        )
        note = _dict(_dict(_dict(data).get("data")).get("note"))
        note_id = _safe_text(note.get("noteId"), 96)
        if note_id and note_id != feed_id:
            raise XiaohongshuMcpError(
                "MCP_OUTPUT_INVALID",
                "小红书笔记详情与请求 ID 不匹配",
            )
        user = _dict(note.get("user"))
        title = _safe_text(note.get("title"), 300)
        description = _safe_text(note.get("desc"), 12_000)
        if not title and not description:
            raise XiaohongshuMcpError(
                "MCP_OUTPUT_INVALID",
                "小红书笔记详情没有可用正文",
            )
        return XiaohongshuFeedDetail(
            feed_id=feed_id,
            title=title,
            description=description,
            author=_safe_optional(
                user.get("nickname") or user.get("nickName"),
                160,
            ),
            author_id=_safe_optional(user.get("userId"), 96),
            published_at=_published_at(note.get("time")),
            metrics=_metrics(note.get("interactInfo")),
        )

    async def read_user_profile(
        self,
        user_id: str,
        xsec_token: SecretStr,
    ) -> XiaohongshuUserProfile:
        if not _SAFE_ID_RE.fullmatch(user_id):
            raise XiaohongshuMcpPolicyError(
                "MCP_INPUT_INVALID",
                "小红书用户 ID 格式无效",
            )
        token = xsec_token.get_secret_value()
        if not _SAFE_TOKEN_RE.fullmatch(token):
            raise XiaohongshuMcpPolicyError(
                "MCP_INPUT_INVALID",
                "小红书主页访问令牌格式无效",
            )
        data = await self._request(
            XiaohongshuMcpOperation.USER_PROFILE,
            body={"user_id": user_id, "xsec_token": token},
        )
        profile = _dict(_dict(data).get("data"))
        basic = _dict(profile.get("userBasicInfo"))
        interactions: dict[str, int | float | str] = {}
        for item in _list(profile.get("interactions")):
            raw = _dict(item)
            name = _safe_text(raw.get("type"), 40)
            count = raw.get("count")
            if name and isinstance(count, (int, float, str)) and not isinstance(
                count,
                bool,
            ):
                safe = str(count).strip()[:40]
                if safe:
                    interactions[name] = int(safe) if safe.isdigit() else safe
        return XiaohongshuUserProfile(
            user_id=user_id,
            nickname=_safe_optional(basic.get("nickname"), 160),
            description=_safe_text(basic.get("desc"), 1_000),
            red_id=_safe_optional(basic.get("redId"), 96),
            interactions=interactions,
        )


class XiaohongshuMcpChannel:
    name = "xiaohongshu"

    def __init__(
        self,
        config: AgentConfig,
        *,
        origin: str | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
        public_fallback: XiaohongshuPublicChannel | None = None,
    ) -> None:
        self.config = config
        self.settings = config.search.channels.xiaohongshu
        configured_origin = (
            origin
            if origin is not None
            else os.environ.get("XIAOHONGSHU_MCP_ORIGIN", "")
        )
        self.client = (
            XiaohongshuMcpClient(
                configured_origin,
                timeout_ms=self.settings.request_timeout_ms,
                detail_timeout_ms=self.settings.detail_timeout_ms,
                max_attempts=self.settings.max_attempts,
                transport=transport,
            )
            if configured_origin
            else None
        )
        self.public_fallback = public_fallback or XiaohongshuPublicChannel(config)

    async def _fallback(
        self,
        query: str,
        max_results: int,
        original_error: XiaohongshuMcpError,
        progress: ChannelProgressReporter | None = None,
    ) -> ChannelOutcome:
        outcome = (
            await self.public_fallback.search(query, max_results)
            if progress is None
            else await self.public_fallback.search(
                query,
                max_results,
                progress=progress,
            )
        )
        if not outcome.ok:
            return ChannelOutcome(
                ok=False,
                channel="xiaohongshu",
                provider=_MCP_PROVIDER,
                query=query,
                error_code=original_error.code,
                error_message=str(original_error),
                resolution=channel_resolution(
                    status="failed",
                    primary_provider=_MCP_PROVIDER,
                    effective_provider=outcome.provider,
                    reason_code=original_error.code,
                    message=str(original_error),
                ),
            )
        limitation = (
            f"登录态渠道未就绪（{original_error.code}），已降级为公开索引读取"
        )
        for result in outcome.results:
            result.provider = (
                f"{_MCP_PROVIDER}-fallback[{original_error.code}]+{result.provider}"
            )
            result.limitation = (
                f"{limitation}；{result.limitation}"
                if result.limitation
                else limitation
            )
        for evidence in outcome.evidence:
            evidence.provider = (
                f"{_MCP_PROVIDER}-fallback[{original_error.code}]+{evidence.provider}"
            )
            evidence.limitation = (
                f"{limitation}；{evidence.limitation}"
                if evidence.limitation
                else limitation
            )
        outcome.provider = (
            f"{_MCP_PROVIDER}-fallback[{original_error.code}]+{outcome.provider}"
        )
        outcome.error_code = original_error.code
        outcome.error_message = str(original_error)
        outcome.resolution = channel_resolution(
            status="degraded",
            primary_provider=_MCP_PROVIDER,
            effective_provider=outcome.provider,
            reason_code=original_error.code,
            message=str(original_error),
        )
        return outcome

    async def search(
        self,
        query: str,
        max_results: int,
        progress: ChannelProgressReporter | None = None,
    ) -> ChannelOutcome:
        async with _search_lock():
            return await self._search_serialized(query, max_results, progress)

    async def search_public_after_mcp_failure(
        self,
        query: str,
        max_results: int,
        progress: ChannelProgressReporter | None = None,
    ) -> ChannelOutcome:
        """本次 LangGraph 运行已观察到 MCP 故障时直接切换公开策略。"""

        return await self._fallback(
            query,
            max_results,
            XiaohongshuMcpError(
                "MCP_CIRCUIT_OPEN",
                "本次运行已切换到小红书公开检索策略",
            ),
            progress,
        )

    async def _search_serialized(
        self,
        query: str,
        max_results: int,
        progress: ChannelProgressReporter | None = None,
    ) -> ChannelOutcome:
        if self.client is None:
            return await self._fallback(
                query,
                max_results,
                XiaohongshuMcpError(
                    "MCP_UNAVAILABLE",
                    "小红书登录态服务当前未配置",
                ),
                progress,
            )

        try:
            login = await self.client.check_login_status()
            if not login.is_logged_in:
                raise XiaohongshuMcpError(
                    "AUTH_REQUIRED",
                    "小红书登录状态已失效，需要重新扫码",
                )
            candidates = await self.client.search_feeds(query, max_results)
        except XiaohongshuMcpError as exc:
            if exc.code in _FALLBACK_ERROR_CODES:
                return await self._fallback(query, max_results, exc, progress)
            return ChannelOutcome(
                ok=False,
                channel="xiaohongshu",
                provider=_MCP_PROVIDER,
                query=query,
                error_code=exc.code,
                error_message=str(exc),
                resolution=channel_resolution(
                    status="failed",
                    primary_provider=_MCP_PROVIDER,
                    reason_code=exc.code,
                    message=str(exc),
                ),
            )

        observed_at = datetime.now(UTC).isoformat().replace("+00:00", "Z")
        results: list[ChannelResult] = []
        evidence: list[ChannelEvidence] = []
        max_details = min(
            max_results,
            self.config.graph.max_pages_per_call,
        )
        visible_candidates = candidates[:max_results]
        detail_deadline = time.monotonic() + _MAX_DETAIL_TOTAL_SECONDS
        first_detail_error: XiaohongshuMcpError | None = None
        detail_circuit_error: XiaohongshuMcpError | None = None
        for result_count in range(1, len(visible_candidates) + 1):
            report_progress(
                progress,
                provider=_MCP_PROVIDER,
                result_count=result_count,
                evidence_count=0,
            )
        for index, candidate in enumerate(visible_candidates):
            detail: XiaohongshuFeedDetail | None = None
            detail_error: XiaohongshuMcpError | None = None
            if index < max_details and detail_circuit_error is None:
                remaining_detail_seconds = detail_deadline - time.monotonic()
                if remaining_detail_seconds <= 0:
                    detail_error = XiaohongshuMcpError(
                        "MCP_TIMEOUT",
                        "小红书详情读取达到本次预算上限",
                    )
                    detail_circuit_error = detail_error
                    first_detail_error = first_detail_error or detail_error
                else:
                    try:
                        async with asyncio.timeout(remaining_detail_seconds):
                            detail = await self.client.read_feed_detail(
                                candidate.feed_id,
                                candidate.xsec_token,
                            )
                    except TimeoutError:
                        detail_error = XiaohongshuMcpError(
                            "MCP_TIMEOUT",
                            "小红书详情读取达到本次预算上限",
                        )
                    except XiaohongshuMcpError as exc:
                        detail_error = exc
                    if detail_error is not None:
                        first_detail_error = first_detail_error or detail_error
                        # 认证和安全验证属于会话级结论；其余详情错误可能只影响
                        # 单篇笔记，保留真实候选并在总预算内尝试下一篇。
                        if detail_error.code in {
                            "AUTH_REQUIRED",
                            "CAPTCHA_REQUIRED",
                        }:
                            detail_circuit_error = detail_error
            elif detail_circuit_error is not None:
                detail_error = detail_circuit_error

            url = f"https://www.xiaohongshu.com/explore/{candidate.feed_id}"
            title = (detail.title if detail and detail.title else candidate.title)[:300]
            author = detail.author if detail and detail.author else candidate.author
            metrics = detail.metrics if detail and detail.metrics else candidate.metrics
            description = (
                _substantive_description(detail.description)
                if detail
                else ""
            )
            body = ""
            if detail and description:
                body = "\n".join(
                    part
                    for part in (detail.title, description)
                    if part
                )[:_MAX_EVIDENCE_CHARS]
            verified = bool(body)
            limitation = (
                "通过用户授权登录态读取笔记详情；未加载评论"
                if verified
                else (
                    str(detail_error)
                    if detail_error
                    else (
                        "登录态详情缺少可用于回答的实质正文"
                        if detail
                        else (
                            "登录态搜索已发现笔记，但受单轮详情读取上限限制，"
                            "未读取正文"
                        )
                    )
                )
            )
            provenance = SourceProvenance(
                discovery_provider=_MCP_PROVIDER,
                detail_provider=_MCP_PROVIDER if verified else None,
                source_kind="authenticated_page",
                observed_at=observed_at,
                confidence="high" if verified else "medium",
            )
            result = ChannelResult(
                channel="xiaohongshu",
                provider=_MCP_PROVIDER,
                query=query,
                url=url,
                title=title,
                snippet=detail.description[:500] if detail else "",
                verified=verified,
                author=author,
                published_at=detail.published_at if detail else None,
                metrics=metrics,
                limitation=limitation,
                provenance=provenance,
            )
            results.append(result)
            if verified:
                evidence.append(
                    ChannelEvidence(
                        channel="xiaohongshu",
                        provider=_MCP_PROVIDER,
                        query=query,
                        url=url,
                        title=title,
                        text=body,
                        extractor="xiaohongshu-mcp-authenticated",
                        captured_at=observed_at,
                        author=author,
                        published_at=detail.published_at if detail else None,
                        metrics=metrics,
                        limitation=limitation,
                        provenance=provenance,
                    )
                )
                report_progress(
                    progress,
                    provider=_MCP_PROVIDER,
                    result_count=len(visible_candidates),
                    evidence_count=len(evidence),
                    source=result,
                )
        if first_detail_error is None and results and not evidence:
            first_detail_error = XiaohongshuMcpError(
                "MCP_OUTPUT_INVALID",
                "小红书笔记详情缺少可用于回答的实质正文",
            )
        return ChannelOutcome(
            ok=True,
            channel="xiaohongshu",
            provider=_MCP_PROVIDER,
            query=query,
            results=results,
            evidence=evidence,
            error_code=(first_detail_error.code if first_detail_error else None),
            error_message=(str(first_detail_error) if first_detail_error else None),
            resolution=(
                channel_resolution(
                    status="degraded",
                    primary_provider=_MCP_PROVIDER,
                    effective_provider=_MCP_PROVIDER,
                    reason_code=first_detail_error.code,
                    message=str(first_detail_error),
                )
                if first_detail_error
                else channel_resolution(
                    status="success",
                    primary_provider=_MCP_PROVIDER,
                )
            ),
        )
