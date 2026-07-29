from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import pytest
from pydantic import SecretStr

from app.config.agent import agent_config
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


@pytest.mark.asyncio
async def test_authenticated_search_reads_details_without_exposing_tokens() -> None:
    requests: list[tuple[str, str, dict[str, Any]]] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else {}
        requests.append((request.method, request.url.path, body))
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
    outcome = await channel.search("LangGraph", 5)

    assert outcome.ok is True
    assert outcome.provider == "xiaohongshu-mcp"
    assert len(outcome.results) == 1
    assert outcome.results[0].verified is True
    assert outcome.results[0].url == "https://www.xiaohongshu.com/explore/feed_123"
    assert outcome.results[0].provenance.source_kind == "authenticated_page"
    assert len(outcome.evidence) == 1
    assert outcome.evidence[0].extractor == "xiaohongshu-mcp-authenticated"
    public_payload = outcome.model_dump_json()
    assert "signed-token-secret-123" not in public_payload
    assert "xsec" not in public_payload.casefold()
    assert [item[:2] for item in requests] == [
        ("POST", "/api/v1/feeds/search"),
        ("POST", "/api/v1/feeds/detail"),
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
async def test_complete_browser_search_sessions_are_serialized() -> None:
    active = 0
    peak = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal active, peak
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
                                "desc": "已读取正文",
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
