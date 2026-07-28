from __future__ import annotations

import httpx
import pytest

from app.tools import web_search as module
from app.tools.web_search import SearchHit, SearchOutcome


@pytest.mark.asyncio
async def test_rate_limit_is_stable_and_not_retried(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = 0

    async def limited(query: str, max_results: int, key: str) -> SearchOutcome:
        nonlocal calls
        calls += 1
        return SearchOutcome(
            ok=False,
            query=query,
            provider="tavily",
            error="rate limited",
            error_category="rate_limited",
        )

    monkeypatch.setattr(module, "_tavily_key", lambda: "test-key")
    monkeypatch.setattr(module, "_search_tavily", limited)
    outcome = await module.web_search(
        "query", max_attempts=3, allow_duckduckgo_fallback=False
    )

    assert calls == 1
    assert outcome.error_category == "rate_limited"


@pytest.mark.asyncio
async def test_timeout_maps_to_stable_category(monkeypatch: pytest.MonkeyPatch) -> None:
    async def timeout(query: str, max_results: int, key: str) -> SearchOutcome:
        raise httpx.TimeoutException("timeout")

    monkeypatch.setattr(module, "_tavily_key", lambda: "test-key")
    monkeypatch.setattr(module, "_search_tavily", timeout)
    outcome = await module.web_search(
        "query", max_attempts=1, allow_duckduckgo_fallback=False
    )

    assert outcome.ok is False
    assert outcome.error_category == "timeout"


@pytest.mark.asyncio
async def test_provider_5xx_maps_to_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    async def unavailable(query: str, max_results: int, key: str) -> SearchOutcome:
        request = httpx.Request("POST", "https://api.example.test/search")
        response = httpx.Response(503, request=request)
        raise httpx.HTTPStatusError("503", request=request, response=response)

    monkeypatch.setattr(module, "_tavily_key", lambda: "test-key")
    monkeypatch.setattr(module, "_search_tavily", unavailable)
    outcome = await module.web_search(
        "query", max_attempts=1, allow_duckduckgo_fallback=False
    )

    assert outcome.ok is False
    assert outcome.error_category == "provider_unavailable"


@pytest.mark.asyncio
async def test_missing_tavily_key_fails_closed_when_fallback_disabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(module, "_tavily_key", lambda: None)
    outcome = await module.web_search(
        "query",
        max_attempts=1,
        default_provider="tavily",
        allow_duckduckgo_fallback=False,
    )
    assert outcome.provider == "tavily"
    assert outcome.error_category == "auth_required"


@pytest.mark.asyncio
async def test_tavily_failure_uses_configured_duckduckgo_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def unavailable(query: str, max_results: int, key: str) -> SearchOutcome:
        return SearchOutcome(
            ok=False,
            query=query,
            provider="tavily",
            error="down",
            error_category="provider_unavailable",
        )

    async def fallback(query: str, max_results: int) -> SearchOutcome:
        return SearchOutcome(ok=True, query=query, provider="duckduckgo")

    monkeypatch.setattr(module, "_tavily_key", lambda: "test-key")
    monkeypatch.setattr(module, "_search_tavily", unavailable)
    monkeypatch.setattr(module, "_search_duckduckgo", fallback)
    outcome = await module.web_search("query", max_attempts=1)
    assert outcome.ok is True
    assert outcome.provider == "duckduckgo"


@pytest.mark.asyncio
async def test_candidate_dns_filter_runs_before_public_projection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        module,
        "is_fetchable",
        lambda url: not url.endswith("blocked"),
    )
    hits = [
        SearchHit("https://example.com/ok", "ok", "", 1),
        SearchHit("https://example.com/blocked", "blocked", "", 2),
    ]
    filtered = await module._filter_fetchable_hits(hits, 5)
    assert [hit.url for hit in filtered] == ["https://example.com/ok"]
