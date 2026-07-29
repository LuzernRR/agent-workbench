from __future__ import annotations

import httpx
import pytest

from app.tools import robots_policy as module


def response(status: int, text: str = "") -> httpx.Response:
    request = httpx.Request("GET", "https://example.com/robots.txt")
    return httpx.Response(
        status,
        request=request,
        headers={"content-type": "text/plain; charset=utf-8"},
        text=text,
    )


@pytest.mark.asyncio
async def test_robots_longest_available_policy_denies_target(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module.clear_robots_cache()

    async def get(url: str, timeout: float) -> httpx.Response:
        return response(200, "User-agent: *\nDisallow: /private\nAllow: /public\n")

    monkeypatch.setattr(module, "_pinned_robots_get", get)
    denied = await module.check_robots("https://example.com/private/item")
    allowed = await module.check_robots("https://example.com/public/item")

    assert denied.allowed is False
    assert denied.reason == "ROBOTS_DENIED"
    assert allowed.allowed is True


@pytest.mark.asyncio
async def test_missing_robots_allows_and_transport_failure_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module.clear_robots_cache()

    async def missing(url: str, timeout: float) -> httpx.Response:
        return response(404)

    monkeypatch.setattr(module, "_pinned_robots_get", missing)
    assert (await module.check_robots("https://example.com/page")).allowed is True

    module.clear_robots_cache()

    async def unavailable(url: str, timeout: float) -> httpx.Response:
        raise httpx.ConnectError("offline")

    monkeypatch.setattr(module, "_pinned_robots_get", unavailable)
    decision = await module.check_robots("https://example.com/page")
    assert decision.allowed is False
    assert decision.reason == "ROBOTS_UNAVAILABLE"


@pytest.mark.asyncio
async def test_named_live_user_agent_can_have_separate_policy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module.clear_robots_cache()

    async def get(url: str, timeout: float) -> httpx.Response:
        return response(
            200,
            "User-agent: ChatGPT-User\nAllow: /\n\nUser-agent: *\nDisallow: /\n",
        )

    monkeypatch.setattr(module, "_pinned_robots_get", get)
    assert (
        await module.check_robots(
            "https://example.com/page", user_agent="ChatGPT-User"
        )
    ).allowed is True
    assert (await module.check_robots("https://example.com/page")).allowed is False
