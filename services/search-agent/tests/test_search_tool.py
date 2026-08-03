from __future__ import annotations

from typing import Any

import pytest

from app.config.agent import agent_config
from app.reliability.deadline import DeadlineBudget
from app.tools import search_tool as tool_module
from app.tools.channels import web as module
from app.tools.channels.base import ChannelOutcome
from app.tools.channels.registry import ChannelRegistry
from app.tools.channels.web import WebChannel
from app.tools.fetch_page import FetchResult
from app.tools.search_tool import SearchToolInput, execute_search_tool
from app.tools.web_search import SearchHit, SearchOutcome


@pytest.mark.asyncio
async def test_redirected_fetch_uses_the_exact_verified_source_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original = "https://example.com/old"
    final = "https://example.com/new"

    async def search(*args: Any, **kwargs: Any) -> SearchOutcome:
        return SearchOutcome(
            ok=True,
            query="query",
            provider="test",
            hits=[SearchHit(original, "Original", "candidate", 1)],
        )

    async def fetch(*args: Any, **kwargs: Any) -> list[FetchResult]:
        return [FetchResult(
            url=final,
            ok=True,
            status=200,
            title="Final",
            text="verified page text",
            extractor="test",
        )]

    monkeypatch.setattr(module, "web_search", search)
    monkeypatch.setattr(module, "fetch_pages", fetch)
    progress: list[Any] = []
    result = await WebChannel(agent_config()).search("query", 5, progress.append)

    assert result.results[0].url == final
    assert result.results[0].verified is True
    assert result.evidence[0].url == final
    assert progress[-1].source.url == final


@pytest.mark.asyncio
async def test_web_discovery_and_fetch_share_remaining_deadline(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = 0.0
    deadline = DeadlineBudget.after(10, clock=lambda: now)
    fetch_timeouts: list[float] = []

    async def search(*args: Any, **kwargs: Any) -> SearchOutcome:
        nonlocal now
        assert kwargs["deadline"] is deadline
        now += 4
        return SearchOutcome(
            ok=True,
            query="query",
            provider="test",
            hits=[SearchHit("https://example.com/page", "Title", "snippet", 1)],
        )

    async def fetch(*args: Any, **kwargs: Any) -> list[FetchResult]:
        fetch_timeouts.append(kwargs["timeout"])
        return [FetchResult(
            url="https://example.com/page",
            ok=False,
            error="test",
            error_category="timeout",
        )]

    monkeypatch.setattr(module, "web_search", search)
    monkeypatch.setattr(module, "fetch_pages", fetch)
    await WebChannel(agent_config()).search("query", 5, deadline=deadline)

    assert fetch_timeouts == [6.0]


@pytest.mark.asyncio
async def test_web_channel_does_not_fetch_after_deadline(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = 0.0
    deadline = DeadlineBudget.after(5, clock=lambda: now)

    async def search(*args: Any, **kwargs: Any) -> SearchOutcome:
        nonlocal now
        now += 5
        return SearchOutcome(
            ok=True,
            query="query",
            provider="test",
            hits=[SearchHit("https://example.com/page", "Title", "snippet", 1)],
        )

    async def unexpected_fetch(*args: Any, **kwargs: Any) -> list[FetchResult]:
        raise AssertionError("deadline 耗尽后不得启动正文抓取")

    monkeypatch.setattr(module, "web_search", search)
    monkeypatch.setattr(module, "fetch_pages", unexpected_fetch)
    result = await WebChannel(agent_config()).search(
        "query",
        5,
        deadline=deadline,
    )

    assert result.ok is True
    assert result.results[0].verified is False
    assert result.evidence == []


@pytest.mark.asyncio
async def test_search_tool_forwards_deadline_to_registry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    deadline = DeadlineBudget.after(10)

    class Registry:
        def __init__(self, config: Any) -> None:
            self.config = config

        async def execute(self, *args: Any, **kwargs: Any) -> ChannelOutcome:
            assert kwargs["deadline"] is deadline
            return ChannelOutcome(
                ok=True,
                channel="web",
                query="query",
                provider="test",
            )

    monkeypatch.setattr(tool_module, "ChannelRegistry", Registry)
    result = await execute_search_tool(
        SearchToolInput(query="query", channel="web", max_results=5),
        agent_config(),
        deadline=deadline,
    )

    assert result.ok is True


@pytest.mark.asyncio
async def test_registry_forwards_deadline_only_to_web_channel() -> None:
    deadline = DeadlineBudget.after(10)
    registry = ChannelRegistry(agent_config())

    class Adapter:
        async def search(self, *args: Any, **kwargs: Any) -> ChannelOutcome:
            assert kwargs["deadline"] is deadline
            return ChannelOutcome(
                ok=True,
                channel="web",
                query="query",
                provider="test",
            )

    registry._channels["web"] = Adapter()  # type: ignore[assignment]
    outcome = await registry.execute("web", "query", 5, deadline=deadline)

    assert outcome.ok is True
