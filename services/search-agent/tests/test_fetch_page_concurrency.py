from __future__ import annotations

import asyncio

import pytest

from app.tools import fetch_page as module
from app.tools.fetch_page import FetchResult


@pytest.mark.asyncio
async def test_same_domain_uses_two_bounded_workers_instead_of_full_serialization(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    active = 0
    max_active = 0
    sequence: list[str] = []

    async def fetch(url: str, timeout: float = 20.0, allow_dynamic: bool = False):
        nonlocal active, max_active
        del timeout, allow_dynamic
        active += 1
        max_active = max(max_active, active)
        sequence.append(f"start:{url}")
        await asyncio.sleep(0.02)
        sequence.append(f"end:{url}")
        active -= 1
        return FetchResult(url=url, ok=True, text="正文", extractor="test")

    monkeypatch.setattr(module, "fetch_page", fetch)
    urls = [f"https://example.com/{index}" for index in range(3)]

    results = await module.fetch_pages(urls, concurrency=9, timeout=1)

    assert [item.url for item in results] == urls
    assert max_active == module.MAX_PER_DOMAIN_CONCURRENCY == 2
    assert sequence.index(f"start:{urls[2]}") > min(
        sequence.index(f"end:{urls[0]}"),
        sequence.index(f"end:{urls[1]}"),
    )


@pytest.mark.asyncio
async def test_different_domains_never_exceed_global_fetch_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    active = 0
    max_active = 0

    async def fetch(url: str, timeout: float = 20.0, allow_dynamic: bool = False):
        nonlocal active, max_active
        del timeout, allow_dynamic
        active += 1
        max_active = max(max_active, active)
        await asyncio.sleep(0.02)
        active -= 1
        return FetchResult(url=url, ok=True, text="正文", extractor="test")

    monkeypatch.setattr(module, "fetch_page", fetch)
    urls = [f"https://source{index}.example/page" for index in range(5)]

    await module.fetch_pages(urls, concurrency=20, timeout=1)

    assert max_active == module.MAX_FETCH_CONCURRENCY == 3


@pytest.mark.asyncio
async def test_single_page_deadline_covers_all_static_fetch_stages(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def slow_static(url: str, timeout: float) -> FetchResult:
        del timeout
        await asyncio.sleep(0.05)
        return FetchResult(url=url, ok=True, text="迟到正文", extractor="test")

    monkeypatch.setattr(module, "_fetch_static", slow_static)

    result = await module.fetch_page("https://slow.example/page", timeout=0.01)

    assert result.ok is False
    assert result.error_category == "timeout"
    assert result.error == "抓取超过单页总时限"


@pytest.mark.asyncio
async def test_slow_page_does_not_discard_other_completed_bodies(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def mixed_static(url: str, timeout: float) -> FetchResult:
        del timeout
        if "slow" in url:
            await asyncio.sleep(0.05)
        return FetchResult(url=url, ok=True, text=f"正文：{url}", extractor="test")

    monkeypatch.setattr(module, "_fetch_static", mixed_static)
    urls = [
        "https://one.example/fast",
        "https://two.example/slow",
        "https://three.example/fast",
    ]

    results = await module.fetch_pages(urls, concurrency=3, timeout=0.01)

    assert [item.ok for item in results] == [True, False, True]
    assert results[1].error_category == "timeout"
    assert results[0].text.startswith("正文：")
    assert results[2].text.startswith("正文：")


@pytest.mark.asyncio
async def test_external_cancellation_is_not_converted_into_page_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    started = asyncio.Event()

    async def blocked_static(url: str, timeout: float) -> FetchResult:
        del timeout
        started.set()
        await asyncio.sleep(10)
        return FetchResult(url=url, ok=True, text="不会返回", extractor="test")

    monkeypatch.setattr(module, "_fetch_static", blocked_static)
    task = asyncio.create_task(
        module.fetch_page("https://cancel.example/page", timeout=20)
    )
    await started.wait()
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task
