from __future__ import annotations

import asyncio

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


@pytest.mark.asyncio
async def test_different_origins_load_policies_concurrently(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """锁按 origin 分片，a 站的 robots.txt 不得阻塞 b 站。

    只断言并发度，不断言墙钟时间：后者在 CI 上会因调度抖动而不稳定。
    """
    module.clear_robots_cache()
    active = 0
    max_active = 0

    async def slow(url: str, timeout: float) -> httpx.Response:
        nonlocal active, max_active
        del timeout
        active += 1
        max_active = max(max_active, active)
        await asyncio.sleep(0.02)
        active -= 1
        return response(404)

    monkeypatch.setattr(module, "_pinned_robots_get", slow)
    origins = [f"https://source{index}.example/page" for index in range(3)]

    decisions = await asyncio.gather(*(module.check_robots(url) for url in origins))

    assert max_active == 3
    assert all(item.allowed for item in decisions)


@pytest.mark.asyncio
async def test_same_origin_concurrency_still_loads_the_policy_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """去重是分片锁必须守住的语义：同 origin 并发只抓一次。"""
    module.clear_robots_cache()
    loads = 0

    async def counted(url: str, timeout: float) -> httpx.Response:
        nonlocal loads
        del timeout
        loads += 1
        await asyncio.sleep(0.02)
        return response(200, "User-agent: *\nDisallow: /private\n")

    monkeypatch.setattr(module, "_pinned_robots_get", counted)

    decisions = await asyncio.gather(
        *(module.check_robots("https://one.example/public") for _ in range(5))
    )

    assert loads == 1
    assert all(item.allowed for item in decisions)
    # 同一份缓存策略仍然按路径判定，去重没有把结果压成同一个答案。
    assert (await module.check_robots("https://one.example/private")).allowed is False
    assert loads == 1


@pytest.mark.asyncio
async def test_clearing_the_cache_also_releases_origin_locks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """锁字典不得在清缓存后留下无主条目，否则会无界增长。"""
    module.clear_robots_cache()

    async def missing(url: str, timeout: float) -> httpx.Response:
        del timeout
        return response(404)

    monkeypatch.setattr(module, "_pinned_robots_get", missing)
    await module.check_robots("https://a.example/page")
    await module.check_robots("https://b.example/page")
    assert len(module._ORIGIN_LOCKS) == 2

    module.clear_robots_cache()
    assert module._ORIGIN_LOCKS == {}
    assert module._CACHE == {}
