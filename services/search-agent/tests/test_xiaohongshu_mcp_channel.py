from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
from pydantic import SecretStr

from app.config.agent import agent_config
from app.tools.channels import xiaohongshu_mcp as xiaohongshu_mcp_module
from app.tools.channels.base import (
    ChannelOutcome,
    ChannelResult,
    SourceProvenance,
)
from app.tools.channels.xiaohongshu_mcp import (
    XiaohongshuMcpChannel,
    XiaohongshuMcpClient,
    XiaohongshuMcpError,
    XiaohongshuMcpPolicyError,
)

ORIGIN = "http://xiaohongshu-mcp:18060"
CHALLENGE_ID = "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789"


def verification_response(
    status: str,
    *,
    reason_code: str | None = None,
    message: str | None = None,
) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "success": True,
            "data": {
                "challenge_id": CHALLENGE_ID,
                "status": status,
                "expires_at": (
                    datetime.now(UTC) + timedelta(minutes=4)
                ).isoformat().replace("+00:00", "Z"),
                "retry_after_ms": 100,
                **({"reason_code": reason_code} if reason_code else {}),
                "message": message or "等待使用小红书 App 扫码验证工具账号",
            },
        },
    )


def logged_in_response() -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "success": True,
            "data": {"is_logged_in": True},
        },
    )


@pytest.mark.asyncio
async def test_authenticated_search_reads_details_without_exposing_tokens() -> None:
    requests: list[tuple[str, str, dict[str, Any]]] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else {}
        requests.append((request.method, request.url.path, body))
        if request.url.path == "/api/v1/login/status":
            return logged_in_response()
        if request.url.path == "/api/v1/feeds/search":
            assert body == {"keyword": "LangGraph"}
            return httpx.Response(
                200,
                json={
                    "success": True,
                    "data": {
                        "feeds": [
                            {
                                "id": "feed_123",
                                "xsecToken": "signed-token-secret-123",
                                "modelType": "note",
                                "noteCard": {
                                    "displayTitle": "LangGraph 实践",
                                    "user": {
                                        "userId": "user_123",
                                        "nickname": "测试作者",
                                    },
                                    "interactInfo": {
                                        "likedCount": "12",
                                        "collectedCount": "4",
                                    },
                                },
                            }
                        ],
                        "count": 1,
                    },
                },
            )
        if request.url.path == "/api/v1/feeds/detail":
            assert body == {
                "feed_id": "feed_123",
                "xsec_token": "signed-token-secret-123",
                "xsec_source": "pc_search",
                "load_all_comments": False,
            }
            return httpx.Response(
                200,
                json={
                    "success": True,
                    "data": {
                        "feed_id": "feed_123",
                        "data": {
                            "note": {
                                "noteId": "feed_123",
                                "title": "LangGraph 实践",
                                "desc": "用状态图组织多轮搜索与核验。",
                                "time": 1_753_718_400_000,
                                "user": {
                                    "userId": "user_123",
                                    "nickname": "测试作者",
                                },
                                "interactInfo": {
                                    "likedCount": "12",
                                    "collectedCount": "4",
                                    "commentCount": "3",
                                },
                            }
                        },
                    },
                },
            )
        raise AssertionError(f"unexpected request: {request.method} {request.url}")

    channel = XiaohongshuMcpChannel(
        agent_config(),
        origin=ORIGIN,
        transport=httpx.MockTransport(handler),
    )
    progress_events: list[Any] = []
    outcome = await channel.search(
        "LangGraph",
        5,
        progress=progress_events.append,
    )

    assert outcome.ok is True
    assert outcome.provider == "xiaohongshu-mcp"
    assert outcome.resolution is not None
    assert outcome.resolution.status == "success"
    assert len(outcome.results) == 1
    assert outcome.results[0].verified is True
    assert outcome.results[0].url == "https://www.xiaohongshu.com/explore/feed_123"
    assert outcome.results[0].provenance.source_kind == "authenticated_page"
    assert len(outcome.evidence) == 1
    assert outcome.evidence[0].extractor == "xiaohongshu-mcp-authenticated"
    public_payload = outcome.model_dump_json()
    assert "signed-token-secret-123" not in public_payload
    assert "xsec" not in public_payload.casefold()
    assert [
        (item.result_count, item.evidence_count)
        for item in progress_events
    ] == [(1, 0), (1, 1)]
    assert progress_events[0].source is None
    assert progress_events[1].source is not None
    assert "signed-token-secret-123" not in json.dumps(
        [item.model_dump(mode="json") for item in progress_events]
    )
    assert [item[:2] for item in requests] == [
        ("POST", "/api/v1/feeds/search"),
        ("POST", "/api/v1/feeds/detail"),
    ]


@pytest.mark.asyncio
async def test_title_and_topic_tags_do_not_count_as_substantive_evidence() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/login/status":
            return logged_in_response()
        if request.url.path == "/api/v1/feeds/search":
            return httpx.Response(
                200,
                json={
                    "success": True,
                    "data": {
                        "feeds": [{
                            "id": "feed_tags_only",
                            "xsecToken": "signed-token-tags-only",
                            "modelType": "note",
                            "noteCard": {
                                "displayTitle": "LangGraph 教程",
                                "user": {"nickname": "测试作者"},
                            },
                        }],
                        "count": 1,
                    },
                },
            )
        if request.url.path == "/api/v1/feeds/detail":
            return httpx.Response(
                200,
                json={
                    "success": True,
                    "data": {
                        "feed_id": "feed_tags_only",
                        "data": {
                            "note": {
                                "noteId": "feed_tags_only",
                                "title": "LangGraph 教程",
                                "desc": (
                                    "#LangGraph[话题]# #AI Agent[话题]# "
                                    "#大模型[话题]# @科技薯"
                                ),
                                "user": {"nickname": "测试作者"},
                            },
                        },
                    },
                },
            )
        raise AssertionError(f"unexpected path: {request.url.path}")

    channel = XiaohongshuMcpChannel(
        agent_config(),
        origin=ORIGIN,
        transport=httpx.MockTransport(handler),
    )
    progress_events: list[Any] = []
    outcome = await channel.search(
        "LangGraph",
        5,
        progress=progress_events.append,
    )

    assert len(outcome.results) == 1
    assert outcome.results[0].verified is False
    assert outcome.evidence == []
    assert outcome.results[0].limitation == "登录态详情缺少可用于回答的实质正文"
    assert outcome.error_code == "MCP_OUTPUT_INVALID"
    assert outcome.resolution is not None
    assert outcome.resolution.status == "degraded"
    assert [
        (item.result_count, item.evidence_count)
        for item in progress_events
    ] == [(1, 0)]


@pytest.mark.asyncio
async def test_infrastructure_detail_failure_keeps_candidates_and_stops_requests() -> None:
    paths: list[str] = []
    fallback_calls = 0

    class PublicFallback:
        async def search(self, query: str, max_results: int) -> ChannelOutcome:
            nonlocal fallback_calls
            fallback_calls += 1
            return ChannelOutcome(
                ok=True,
                channel="xiaohongshu",
                provider="test-public-index",
                query=query,
                results=[],
                evidence=[],
            )

    async def handler(request: httpx.Request) -> httpx.Response:
        paths.append(request.url.path)
        if request.url.path == "/api/v1/login/status":
            return logged_in_response()
        if request.url.path == "/api/v1/feeds/search":
            return httpx.Response(
                200,
                json={
                    "success": True,
                    "data": {
                        "feeds": [
                            {
                                "id": "feed_001",
                                "xsecToken": "signed-token-detail-001",
                                "modelType": "note",
                                "noteCard": {"displayTitle": "第一条"},
                            },
                            {
                                "id": "feed_002",
                                "xsecToken": "signed-token-detail-002",
                                "modelType": "note",
                                "noteCard": {"displayTitle": "第二条"},
                            },
                        ],
                        "count": 2,
                    },
                },
            )
        if request.url.path == "/api/v1/feeds/detail":
            return httpx.Response(500, json={"error": "temporary browser failure"})
        raise AssertionError(f"unexpected path: {request.url.path}")

    channel = XiaohongshuMcpChannel(
        agent_config(),
        origin=ORIGIN,
        transport=httpx.MockTransport(handler),
        public_fallback=PublicFallback(),  # type: ignore[arg-type]
    )

    outcome = await channel.search("油敏皮通勤防晒", 5)

    assert outcome.ok is True
    assert outcome.provider == "xiaohongshu-mcp"
    assert len(outcome.results) == 2
    assert outcome.evidence == []
    assert outcome.error_code == "MCP_UNAVAILABLE"
    assert outcome.resolution is not None
    assert outcome.resolution.status == "degraded"
    assert outcome.resolution.primary_provider == "xiaohongshu-mcp"
    assert outcome.resolution.effective_provider == "xiaohongshu-mcp"
    assert outcome.resolution.retryable is True
    assert outcome.resolution.next_action == "use_fallback"
    assert fallback_calls == 0
    assert paths == [
        "/api/v1/feeds/search",
        "/api/v1/feeds/detail",
    ]


@pytest.mark.asyncio
async def test_write_operations_are_rejected_before_network() -> None:
    network_requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        network_requests.append(request)
        return httpx.Response(200, json={"success": True, "data": {}})

    client = XiaohongshuMcpClient(
        ORIGIN,
        timeout_ms=10_000,
        transport=httpx.MockTransport(handler),
    )
    for operation in (
        "publish",
        "publish_video",
        "post_comment",
        "reply_comment",
        "like",
        "favorite",
        "delete_cookies",
        "/api/v1/feeds/like",
    ):
        with pytest.raises(XiaohongshuMcpPolicyError) as raised:
            await client._request(operation, body={"content": "never sent"})
        assert raised.value.code == "MCP_WRITE_DENIED"

    assert network_requests == []


@pytest.mark.asyncio
async def test_login_required_degrades_to_public_fallback() -> None:
    paths: list[str] = []

    class PublicFallback:
        async def search(self, query: str, max_results: int) -> ChannelOutcome:
            return ChannelOutcome(
                ok=True,
                channel="xiaohongshu",
                provider="test-public-index",
                query=query,
                results=[
                    ChannelResult(
                        channel="xiaohongshu",
                        provider="test-public-index",
                        query=query,
                        url="https://www.xiaohongshu.com/explore/public_123",
                        title="公开索引候选",
                        snippet="",
                        verified=False,
                        limitation="仅发现公开索引",
                        provenance=SourceProvenance(
                            discovery_provider="test-public-index",
                            source_kind="public_index",
                            observed_at="2026-07-29T00:00:00Z",
                            confidence="low",
                        ),
                    )
                ],
            )

    async def handler(request: httpx.Request) -> httpx.Response:
        paths.append(request.url.path)
        return httpx.Response(
            401,
            json={"error": "authorization required"},
        )

    channel = XiaohongshuMcpChannel(
        agent_config(),
        origin=ORIGIN,
        transport=httpx.MockTransport(handler),
        public_fallback=PublicFallback(),  # type: ignore[arg-type]
    )
    outcome = await channel.search("旅行攻略", 5)

    assert outcome.ok is True
    assert outcome.provider == (
        "xiaohongshu-mcp-fallback[AUTH_REQUIRED]+test-public-index"
    )
    assert len(outcome.results) == 1
    assert "AUTH_REQUIRED" in (outcome.results[0].limitation or "")
    assert outcome.results[0].verified is False
    assert outcome.evidence == []
    assert paths == ["/api/v1/feeds/search"]


@pytest.mark.asyncio
async def test_search_auth_failure_degrades_without_detail_reads() -> None:
    paths: list[str] = []

    class PublicFallback:
        async def search(self, query: str, max_results: int) -> ChannelOutcome:
            return ChannelOutcome(
                ok=True,
                channel="xiaohongshu",
                provider="test-public-index",
                query=query,
            )

    async def handler(request: httpx.Request) -> httpx.Response:
        paths.append(request.url.path)
        return httpx.Response(
            401,
            json={
                "error": "小红书登录状态已失效，需要重新扫码",
                "code": "AUTH_REQUIRED",
                "retryable": False,
                "nextAction": "reconnect_account",
            },
        )

    channel = XiaohongshuMcpChannel(
        agent_config(),
        origin=ORIGIN,
        transport=httpx.MockTransport(handler),
        public_fallback=PublicFallback(),  # type: ignore[arg-type]
    )

    outcome = await channel.search("旅行攻略", 5)

    assert outcome.provider == (
        "xiaohongshu-mcp-fallback[AUTH_REQUIRED]+test-public-index"
    )
    assert paths == ["/api/v1/feeds/search"]


@pytest.mark.asyncio
async def test_transient_search_failure_is_retried_without_status_preflight() -> None:
    paths: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        paths.append(request.url.path)
        if len(paths) == 1:
            return httpx.Response(500, json={"error": "temporary browser failure"})
        return httpx.Response(
            200,
            json={"success": True, "data": {"feeds": [], "count": 0}},
        )

    client = XiaohongshuMcpClient(
        ORIGIN,
        timeout_ms=10_000,
        max_attempts=2,
        transport=httpx.MockTransport(handler),
    )

    assert await client.search_feeds("重试测试", 5) == []
    assert paths == ["/api/v1/feeds/search", "/api/v1/feeds/search"]


@pytest.mark.asyncio
async def test_slow_server_failure_falls_back_without_expensive_retry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.01)
        return httpx.Response(500, json={"error": "slow browser failure"})

    monkeypatch.setattr(
        xiaohongshu_mcp_module,
        "_MAX_RETRYABLE_ATTEMPT_SECONDS",
        0.0,
    )
    client = XiaohongshuMcpClient(
        ORIGIN,
        timeout_ms=10_000,
        max_attempts=2,
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(XiaohongshuMcpError) as raised:
        await client.search_feeds("慢失败测试", 5)

    assert raised.value.code == "MCP_UNAVAILABLE"
    assert calls == 1


@pytest.mark.asyncio
async def test_page_deadline_failure_is_classified_and_not_retried() -> None:
    calls = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(
            500,
            json={
                "error": "搜索Feeds失败",
                "code": "SEARCH_FEEDS_FAILED",
                "details": "context.deadlineExceededError",
            },
        )

    client = XiaohongshuMcpClient(
        ORIGIN,
        timeout_ms=10_000,
        max_attempts=2,
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(XiaohongshuMcpError) as raised:
        await client.search_feeds("超时测试", 5)

    assert raised.value.code == "MCP_TIMEOUT"
    assert calls == 1


@pytest.mark.asyncio
async def test_captcha_failure_is_classified_and_not_retried() -> None:
    calls = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(
            500,
            json={
                "error": "搜索Feeds失败",
                "code": "SEARCH_FEEDS_FAILED",
                "details": "小红书要求安全验证",
            },
        )

    client = XiaohongshuMcpClient(
        ORIGIN,
        timeout_ms=10_000,
        max_attempts=2,
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(XiaohongshuMcpError) as raised:
        await client.search_feeds("安全验证测试", 5)

    assert raised.value.code == "CAPTCHA_REQUIRED"
    assert calls == 1


@pytest.mark.asyncio
async def test_structured_captcha_conflict_preserves_reason_code() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            409,
            json={
                "error": "小红书当前要求安全验证",
                "code": "CAPTCHA_REQUIRED",
                "retryable": False,
                "nextAction": "use_alternative_channel",
            },
        )

    client = XiaohongshuMcpClient(
        ORIGIN,
        timeout_ms=10_000,
        max_attempts=2,
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(XiaohongshuMcpError) as raised:
        await client.search_feeds("安全验证测试", 5)

    assert raised.value.code == "CAPTCHA_REQUIRED"


@pytest.mark.asyncio
async def test_public_strategy_after_failure_does_not_touch_mcp_again() -> None:
    class PublicFallback:
        async def search(self, query: str, max_results: int) -> ChannelOutcome:
            return ChannelOutcome(
                ok=True,
                channel="xiaohongshu",
                provider="test-public-index",
                query=query,
            )

    async def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"MCP circuit should be open: {request.url.path}")

    channel = XiaohongshuMcpChannel(
        agent_config(),
        origin=ORIGIN,
        transport=httpx.MockTransport(handler),
        public_fallback=PublicFallback(),  # type: ignore[arg-type]
    )

    outcome = await channel.search_public_after_mcp_failure("旅行攻略", 5)

    assert outcome.provider == (
        "xiaohongshu-mcp-fallback[MCP_CIRCUIT_OPEN]+test-public-index"
    )


@pytest.mark.asyncio
async def test_complete_browser_search_sessions_are_serialized() -> None:
    active = 0
    peak = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal active, peak
        if request.url.path == "/api/v1/login/status":
            return logged_in_response()
        assert request.url.path == "/api/v1/feeds/search"
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0.02)
        active -= 1
        return httpx.Response(
            200,
            json={"success": True, "data": {"feeds": [], "count": 0}},
        )

    first = XiaohongshuMcpChannel(
        agent_config(),
        origin=ORIGIN,
        transport=httpx.MockTransport(handler),
    )
    second = XiaohongshuMcpChannel(
        agent_config(),
        origin=ORIGIN,
        transport=httpx.MockTransport(handler),
    )

    outcomes = await asyncio.gather(
        first.search("并发测试一", 5),
        second.search("并发测试二", 5),
    )

    assert peak == 1
    assert all(outcome.ok for outcome in outcomes)


@pytest.mark.asyncio
async def test_detail_failure_is_not_retried_inside_one_source_read() -> None:
    calls = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(500, json={"error": "temporary browser failure"})

    client = XiaohongshuMcpClient(
        ORIGIN,
        timeout_ms=10_000,
        max_attempts=2,
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(XiaohongshuMcpError) as raised:
        await client.read_feed_detail(
            "feed_123",
            SecretStr("signed-token-secret-123"),
        )

    assert raised.value.code == "MCP_UNAVAILABLE"
    assert calls == 1


@pytest.mark.asyncio
async def test_qrcode_is_secret_and_profile_is_sanitized() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/login/qrcode":
            return httpx.Response(
                200,
                json={
                    "success": True,
                    "data": {
                        "is_logged_in": False,
                        "timeout": "4m0s",
                        "img": "data:image/png;base64,c2VjcmV0LWltYWdl",
                    },
                },
            )
        if request.url.path == "/api/v1/user/profile":
            body = json.loads(request.content)
            assert body == {
                "user_id": "user_123",
                "xsec_token": "signed-token-secret-123",
            }
            return httpx.Response(
                200,
                json={
                    "success": True,
                    "data": {
                        "data": {
                            "userBasicInfo": {
                                "nickname": "测试作者",
                                "desc": "只读主页简介",
                                "redId": "red_123",
                            },
                            "interactions": [
                                {"type": "fans", "count": "42"},
                            ],
                        }
                    },
                },
            )
        raise AssertionError(f"unexpected path: {request.url.path}")

    client = XiaohongshuMcpClient(
        ORIGIN,
        timeout_ms=10_000,
        transport=httpx.MockTransport(handler),
    )
    qrcode = await client.get_login_qrcode()
    assert qrcode.image is not None
    assert qrcode.image.get_secret_value().endswith("c2VjcmV0LWltYWdl")
    assert "c2VjcmV0LWltYWdl" not in qrcode.model_dump_json()
    assert "c2VjcmV0LWltYWdl" not in repr(qrcode)

    profile = await client.read_user_profile(
        "user_123",
        SecretStr("signed-token-secret-123"),
    )
    assert profile.nickname == "测试作者"
    assert profile.interactions == {"fans": 42}
    assert "signed-token-secret-123" not in profile.model_dump_json()


@pytest.mark.asyncio
async def test_unavailable_mcp_degrades_to_public_fallback() -> None:
    class PublicFallback:
        async def search(self, query: str, max_results: int) -> ChannelOutcome:
            return ChannelOutcome(
                ok=True,
                channel="xiaohongshu",
                provider="test-public-index",
                query=query,
            )

    async def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("offline", request=request)

    channel = XiaohongshuMcpChannel(
        agent_config(),
        origin=ORIGIN,
        transport=httpx.MockTransport(handler),
        public_fallback=PublicFallback(),  # type: ignore[arg-type]
    )
    outcome = await channel.search("旅行攻略", 5)

    assert outcome.ok is True
    assert outcome.provider == (
        "xiaohongshu-mcp-fallback[MCP_UNAVAILABLE]+test-public-index"
    )
    assert outcome.results == []
    assert outcome.evidence == []


@pytest.mark.asyncio
async def test_detail_reads_respect_configured_page_budget() -> None:
    detail_paths: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/login/status":
            return logged_in_response()
        if request.url.path == "/api/v1/feeds/search":
            feeds = [
                {
                    "id": f"feed_{index}",
                    "xsecToken": f"signed-token-{index:05d}",
                    "modelType": "note",
                    "noteCard": {
                        "displayTitle": f"候选 {index}",
                        "user": {"nickname": "作者"},
                    },
                }
                for index in range(5)
            ]
            return httpx.Response(
                200,
                json={
                    "success": True,
                    "data": {"feeds": feeds, "count": 5},
                },
            )
        if request.url.path == "/api/v1/feeds/detail":
            body = json.loads(request.content)
            detail_paths.append(body["feed_id"])
            return httpx.Response(
                200,
                json={
                    "success": True,
                    "data": {
                        "feed_id": body["feed_id"],
                        "data": {
                            "note": {
                                "noteId": body["feed_id"],
                                "title": f"详情 {body['feed_id']}",
                                "desc": "这是一段已经读取且可用于验证的正文内容。",
                                "user": {"nickname": "作者"},
                            }
                        },
                    },
                },
            )
        raise AssertionError(f"unexpected path: {request.url.path}")

    config = agent_config()
    channel = XiaohongshuMcpChannel(
        config,
        origin=ORIGIN,
        transport=httpx.MockTransport(handler),
    )
    outcome = await channel.search("预算测试", 5)

    assert len(outcome.results) == 5
    assert len(outcome.evidence) == config.graph.max_pages_per_call
    assert len(detail_paths) == config.graph.max_pages_per_call
    assert all(item.verified for item in outcome.results[: len(detail_paths)])
    assert all(not item.verified for item in outcome.results[len(detail_paths) :])
    assert "读取上限" in (outcome.results[-1].limitation or "")


@pytest.mark.asyncio
async def test_content_invalid_detail_is_replaced_until_evidence_target() -> None:
    detail_paths: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/login/status":
            return logged_in_response()
        if request.url.path == "/api/v1/feeds/search":
            feeds = [
                {
                    "id": f"feed_{index}",
                    "xsecToken": f"signed-token-{index:05d}",
                    "modelType": "note",
                    "noteCard": {"displayTitle": f"候选 {index}"},
                }
                for index in range(5)
            ]
            return httpx.Response(
                200,
                json={
                    "success": True,
                    "data": {"feeds": feeds, "count": 5},
                },
            )
        if request.url.path == "/api/v1/feeds/detail":
            body = json.loads(request.content)
            feed_id = body["feed_id"]
            detail_paths.append(feed_id)
            if feed_id == "feed_0":
                return httpx.Response(
                    503,
                    json={
                        "error": "小红书只读响应缺少有效内容",
                        "code": "MCP_OUTPUT_INVALID",
                        "retryable": False,
                        "nextAction": "use_alternative_channel",
                    },
                )
            return httpx.Response(
                200,
                json={
                    "success": True,
                    "data": {
                        "feed_id": feed_id,
                        "data": {
                            "note": {
                                "noteId": feed_id,
                                "title": f"详情 {feed_id}",
                                "desc": "这是一段已经读取且可用于验证的正文内容。",
                            }
                        },
                    },
                },
            )
        raise AssertionError(f"unexpected path: {request.url.path}")

    config = agent_config()
    channel = XiaohongshuMcpChannel(
        config,
        origin=ORIGIN,
        transport=httpx.MockTransport(handler),
    )
    outcome = await channel.search("油敏皮夏季通勤防晒", 5)

    assert detail_paths == ["feed_0", "feed_1", "feed_2", "feed_3"]
    assert len(outcome.evidence) == config.graph.max_pages_per_call
    assert [item.url.rsplit("/", 1)[-1] for item in outcome.evidence] == [
        "feed_1",
        "feed_2",
        "feed_3",
    ]
    assert outcome.resolution is not None
    assert outcome.resolution.status == "degraded"
    assert outcome.error_code == "MCP_OUTPUT_INVALID"


@pytest.mark.asyncio
async def test_infrastructure_detail_failure_opens_circuit_without_request_pileup() -> None:
    detail_paths: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/feeds/search":
            return httpx.Response(
                200,
                json={
                    "success": True,
                    "data": {
                        "feeds": [
                            {
                                "id": f"feed_{index}",
                                "xsecToken": f"signed-token-{index:05d}",
                                "modelType": "note",
                                "noteCard": {"displayTitle": f"候选 {index}"},
                            }
                            for index in range(5)
                        ],
                        "count": 5,
                    },
                },
            )
        if request.url.path == "/api/v1/feeds/detail":
            body = json.loads(request.content)
            detail_paths.append(body["feed_id"])
            return httpx.Response(
                503,
                json={
                    "error": "小红书只读服务当前不可用",
                    "code": "MCP_UNAVAILABLE",
                    "retryable": True,
                    "nextAction": "retry_later",
                },
            )
        raise AssertionError(f"unexpected path: {request.url.path}")

    channel = XiaohongshuMcpChannel(
        agent_config(),
        origin=ORIGIN,
        transport=httpx.MockTransport(handler),
    )
    outcome = await channel.search("油敏皮夏季通勤防晒", 5)

    assert detail_paths == ["feed_0"]
    assert not outcome.evidence
    assert outcome.error_code == "MCP_UNAVAILABLE"
    assert outcome.resolution is not None
    assert outcome.resolution.status == "degraded"


@pytest.mark.asyncio
async def test_verification_client_uses_only_bound_session_routes_and_png() -> None:
    requests: list[tuple[str, str, dict[str, Any]]] = []
    png = b"\x89PNG\r\n\x1a\nverification"

    async def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else {}
        requests.append((request.method, request.url.path, body))
        if request.url.path == "/api/v1/login/verification":
            return verification_response("pending")
        if request.url.path.endswith("/status"):
            return verification_response(
                "succeeded",
                message="小红书工具账号验证成功",
            )
        if request.url.path.endswith("/qrcode"):
            return httpx.Response(200, content=png, headers={"content-type": "image/png"})
        if request.method == "DELETE":
            return httpx.Response(
                200,
                json={"success": True, "data": {"status": "cancelled"}},
            )
        raise AssertionError(f"unexpected path: {request.url.path}")

    client = XiaohongshuMcpClient(
        ORIGIN,
        timeout_ms=10_000,
        transport=httpx.MockTransport(handler),
    )
    started = await client.start_login_verification("run-one:tool-one")
    status = await client.login_verification_status(CHALLENGE_ID)
    image = await client.login_verification_qrcode(CHALLENGE_ID)
    await client.cancel_login_verification(CHALLENGE_ID)

    assert started.status == "pending"
    assert status.status == "succeeded"
    assert image == png
    assert requests == [
        ("POST", "/api/v1/login/verification", {"request_key": "run-one:tool-one"}),
        ("GET", f"/api/v1/login/verification/{CHALLENGE_ID}/status", {}),
        ("GET", f"/api/v1/login/verification/{CHALLENGE_ID}/qrcode", {}),
        ("DELETE", f"/api/v1/login/verification/{CHALLENGE_ID}", {}),
    ]


@pytest.mark.asyncio
async def test_captcha_waits_for_bound_verification_then_retries_original_search_once() -> None:
    paths: list[str] = []
    updates: list[str] = []
    search_calls = 0

    async def no_wait(_seconds: float) -> None:
        return None

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal search_calls
        paths.append(request.url.path)
        if request.url.path == "/api/v1/feeds/search":
            search_calls += 1
            assert json.loads(request.content) == {
                "keyword": "油敏皮夏季通勤防晒",
                "verification_request_key": "run-one:tool-one",
            }
            if search_calls == 1:
                return httpx.Response(
                    409,
                    json={"error": "需要安全验证", "code": "CAPTCHA_REQUIRED"},
                )
            return httpx.Response(
                200,
                json={
                    "success": True,
                    "data": {
                        "feeds": [{
                            "id": "feed_verified",
                            "xsecToken": "signed-token-verified",
                            "modelType": "note",
                            "noteCard": {"displayTitle": "油敏皮通勤防晒记录"},
                        }],
                        "count": 1,
                    },
                },
            )
        if request.url.path == "/api/v1/login/verification":
            assert json.loads(request.content) == {"request_key": "run-one:tool-one"}
            return verification_response("pending")
        if request.url.path.endswith("/status"):
            return verification_response(
                "succeeded",
                message="小红书工具账号验证成功",
            )
        if request.url.path == "/api/v1/feeds/detail":
            return httpx.Response(
                200,
                json={
                    "success": True,
                    "data": {
                        "feed_id": "feed_verified",
                        "data": {"note": {
                            "noteId": "feed_verified",
                            "title": "油敏皮通勤防晒记录",
                            "desc": "油敏皮夏季通勤时使用轻薄防晒，成膜后不明显泛油，正文信息完整可读。",
                        }},
                    },
                },
            )
        raise AssertionError(f"unexpected path: {request.url.path}")

    channel = XiaohongshuMcpChannel(
        agent_config(),
        origin=ORIGIN,
        transport=httpx.MockTransport(handler),
        verification_sleep=no_wait,
    )
    outcome = await channel.search(
        "油敏皮夏季通勤防晒",
        5,
        verification_request_key="run-one:tool-one",
        verification=lambda update: updates.append(update.status),
    )

    assert updates == ["pending", "succeeded"]
    assert search_calls == 2
    assert len(outcome.evidence) == 1
    assert outcome.evidence[0].url.endswith("/feed_verified")
    assert outcome.interaction_wait_ms >= 0
    assert paths[:4] == [
        "/api/v1/feeds/search",
        "/api/v1/login/verification",
        f"/api/v1/login/verification/{CHALLENGE_ID}/status",
        "/api/v1/feeds/search",
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status", "reason_code", "expected_code"),
    [
        ("expired", "VERIFICATION_TIMEOUT", "VERIFICATION_TIMEOUT"),
        ("account_mismatch", "ACCOUNT_MISMATCH", "ACCOUNT_MISMATCH"),
        ("cancelled", "USER_CANCELLED", "USER_CANCELLED"),
    ],
)
async def test_verification_terminal_state_returns_structured_degradation(
    status: str,
    reason_code: str,
    expected_code: str,
) -> None:
    search_calls = 0
    starts = 0

    class PublicFallback:
        async def search(
            self,
            query: str,
            max_results: int,
            progress: Any = None,
        ) -> ChannelOutcome:
            return ChannelOutcome(
                ok=True,
                channel="xiaohongshu",
                provider="public-index",
                query=query,
            )

    async def no_wait(_seconds: float) -> None:
        return None

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal search_calls, starts
        if request.url.path == "/api/v1/feeds/search":
            search_calls += 1
            return httpx.Response(
                409,
                json={"error": "需要安全验证", "code": "CAPTCHA_REQUIRED"},
            )
        if request.url.path == "/api/v1/login/verification":
            starts += 1
            return verification_response("pending")
        if request.url.path.endswith("/status"):
            return verification_response(
                status,
                reason_code=reason_code,
                message="验证会话已结束",
            )
        raise AssertionError(f"unexpected path: {request.url.path}")

    channel = XiaohongshuMcpChannel(
        agent_config(),
        origin=ORIGIN,
        transport=httpx.MockTransport(handler),
        public_fallback=PublicFallback(),  # type: ignore[arg-type]
        verification_sleep=no_wait,
    )
    outcome = await channel.search(
        "油敏皮夏季通勤防晒",
        5,
        verification_request_key="run-one:tool-one",
        verification=lambda _update: None,
    )

    assert outcome.ok is True
    assert outcome.resolution is not None
    assert outcome.resolution.status == "degraded"
    assert outcome.error_code == expected_code
    assert search_calls == 1
    assert starts == 1


@pytest.mark.asyncio
async def test_successful_verification_never_creates_a_second_challenge() -> None:
    search_calls = 0
    starts = 0

    class PublicFallback:
        async def search(
            self,
            query: str,
            max_results: int,
            progress: Any = None,
        ) -> ChannelOutcome:
            return ChannelOutcome(
                ok=True,
                channel="xiaohongshu",
                provider="public-index",
                query=query,
            )

    async def no_wait(_seconds: float) -> None:
        return None

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal search_calls, starts
        if request.url.path == "/api/v1/feeds/search":
            search_calls += 1
            return httpx.Response(
                409,
                json={"error": "需要安全验证", "code": "CAPTCHA_REQUIRED"},
            )
        if request.url.path == "/api/v1/login/verification":
            starts += 1
            return verification_response("pending")
        if request.url.path.endswith("/status"):
            return verification_response(
                "succeeded",
                message="小红书工具账号验证成功",
            )
        raise AssertionError(f"unexpected path: {request.url.path}")

    channel = XiaohongshuMcpChannel(
        agent_config(),
        origin=ORIGIN,
        transport=httpx.MockTransport(handler),
        public_fallback=PublicFallback(),  # type: ignore[arg-type]
        verification_sleep=no_wait,
    )
    outcome = await channel.search(
        "油敏皮夏季通勤防晒",
        5,
        verification_request_key="run-one:tool-one",
        verification=lambda _update: None,
    )

    assert search_calls == 2
    assert starts == 1
    assert outcome.error_code == "VERIFICATION_RETRY_FAILED"
    assert outcome.resolution is not None
    assert outcome.resolution.next_action == "use_fallback"
