from __future__ import annotations

from typing import Any

import pytest

from app.config.agent import agent_config
from app.tools.channels import x_public as module
from app.tools.channels.x_public import (
    XProviderError,
    XPublicChannel,
    _canonical_x_candidate,
)
from app.tools.robots_policy import RobotsDecision
from app.tools.web_search import SearchHit, SearchOutcome


@pytest.mark.asyncio
async def test_fx_api_obeys_robots_before_network(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    channel = XPublicChannel(agent_config())

    async def denied(url: str, **kwargs: Any) -> RobotsDecision:
        return RobotsDecision(False, "ROBOTS_DENIED", "https://api.fxtwitter.com/robots.txt", 200)

    monkeypatch.setattr(module, "check_robots", denied)
    with pytest.raises(XProviderError) as raised:
        await channel._get_json("/2/search")
    assert raised.value.code == "ROBOTS_DENIED"


@pytest.mark.asyncio
async def test_profile_route_returns_verified_public_api_evidence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    channel = XPublicChannel(agent_config())

    async def get(path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        assert path == "/2/profile/OpenAI/statuses"
        return {
            "results": [{
                "url": "https://x.com/OpenAI/status/123456789",
                "text": "A public update",
                "created_at": "2026-07-28T00:00:00Z",
                "likes": 10,
                "author": {"screen_name": "OpenAI", "name": "OpenAI"},
            }]
        }

    async def no_discovery(query: str, max_results: int) -> SearchOutcome:
        return SearchOutcome(ok=True, query=query, provider="test-index", hits=[])

    monkeypatch.setattr(channel, "_get_json", get)
    monkeypatch.setattr(channel, "_discover_index", no_discovery)
    outcome = await channel.search("@OpenAI", 5)

    assert outcome.ok is True
    assert len(outcome.results) == 1
    assert len(outcome.evidence) == 1
    assert outcome.results[0].channel == "x"
    assert outcome.results[0].author == "OpenAI"
    assert outcome.results[0].metrics == {"likes": 10}
    assert "第三方公共 API" in (outcome.results[0].limitation or "")


@pytest.mark.asyncio
async def test_denied_api_degrades_to_real_index_candidates(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    channel = XPublicChannel(agent_config())

    async def get(path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        raise XProviderError("ROBOTS_DENIED", "API robots denied")

    async def discover(query: str, max_results: int) -> SearchOutcome:
        return SearchOutcome(
            ok=True,
            query=query,
            provider="test-index",
            hits=[SearchHit(
                "https://x.com/example/status/123456789",
                "Example post",
                "Indexed snippet",
                1,
            )],
        )

    monkeypatch.setattr(channel, "_get_json", get)
    monkeypatch.setattr(channel, "_discover_index", discover)
    outcome = await channel.search("LangGraph discussion", 5)

    assert outcome.ok is True
    assert len(outcome.results) == 1
    assert outcome.results[0].verified is False
    assert outcome.evidence == []
    assert "详情未成功读取" in (outcome.results[0].limitation or "")


@pytest.mark.asyncio
async def test_exact_status_url_is_preserved_when_detail_is_blocked(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    channel = XPublicChannel(agent_config())

    async def get(path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        raise XProviderError("ROBOTS_DENIED", "API robots denied")

    monkeypatch.setattr(channel, "_get_json", get)
    outcome = await channel.search("https://twitter.com/example/status/123456789", 5)

    assert outcome.ok is True
    assert outcome.results[0].url == "https://x.com/example/status/123456789"
    assert outcome.results[0].verified is False
    assert outcome.evidence == []


@pytest.mark.asyncio
async def test_handle_discovery_prefers_account_status_index(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    channel = XPublicChannel(agent_config())
    queries: list[str] = []

    async def search(query: str, max_results: int, **kwargs: Any) -> SearchOutcome:
        queries.append(query)
        return SearchOutcome(
            ok=True,
            query=query,
            provider="test-index",
            hits=[SearchHit(
                "https://x.com/OpenAI/status/2047376561205325845",
                "OpenAI post",
                "Indexed snippet",
                1,
            )],
        )

    monkeypatch.setattr(module, "web_search", search)
    outcome = await channel._discover_index("@OpenAI latest public posts", 1)

    assert queries == ["OpenAI latest public posts site:x.com/OpenAI/status"]
    assert outcome.hits[0].url == "https://x.com/OpenAI/status/2047376561205325845"


@pytest.mark.asyncio
async def test_denied_api_keeps_real_profile_as_unverified_candidate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    channel = XPublicChannel(agent_config())

    async def get(path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        raise XProviderError("ROBOTS_DENIED", "API robots denied")

    async def discover(query: str, max_results: int) -> SearchOutcome:
        return SearchOutcome(
            ok=True,
            query=query,
            provider="test-index",
            hits=[SearchHit("https://x.com/OpenAI", "OpenAI", "Profile snippet", 1)],
        )

    monkeypatch.setattr(channel, "_get_json", get)
    monkeypatch.setattr(channel, "_discover_index", discover)
    outcome = await channel.search("@OpenAI latest public posts", 5)

    assert outcome.ok is True
    assert [item.url for item in outcome.results] == ["https://x.com/OpenAI"]
    assert outcome.results[0].verified is False
    assert outcome.evidence == []
    assert "账号主页" in (outcome.results[0].limitation or "")


@pytest.mark.asyncio
async def test_exact_profile_is_preserved_without_duplicate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    channel = XPublicChannel(agent_config())

    async def get(path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        raise XProviderError("ROBOTS_DENIED", "API robots denied")

    async def discover(query: str, max_results: int) -> SearchOutcome:
        return SearchOutcome(
            ok=True,
            query=query,
            provider="test-index",
            hits=[SearchHit("https://twitter.com/OpenAI/", "OpenAI", "Profile", 1)],
        )

    monkeypatch.setattr(channel, "_get_json", get)
    monkeypatch.setattr(channel, "_discover_index", discover)
    outcome = await channel.search("https://twitter.com/OpenAI", 5)

    assert [item.url for item in outcome.results] == ["https://x.com/OpenAI"]
    assert outcome.results[0].verified is False
    assert outcome.evidence == []


def test_x_candidate_allowlist_rejects_internal_and_extra_paths() -> None:
    assert _canonical_x_candidate("https://x.com/OpenAI") == (
        "https://x.com/OpenAI", "profile", "OpenAI", None,
    )
    assert _canonical_x_candidate("https://twitter.com/OpenAI/status/123") == (
        "https://x.com/OpenAI/status/123", "status", "OpenAI", "123",
    )
    assert _canonical_x_candidate("https://x.com/search?q=OpenAI") is None
    assert _canonical_x_candidate("https://x.com/OpenAI/likes") is None
    assert _canonical_x_candidate("https://x.com/i/status/123") is None
    assert _canonical_x_candidate("https://example.com/OpenAI/status/123") is None
