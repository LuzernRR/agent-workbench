from __future__ import annotations

import httpx
import pytest

from app.reliability.deadline import DeadlineBudget
from app.reliability.retry import RetryPolicy
from app.tools import web_search as module
from app.tools.web_search import SearchHit, SearchOutcome


@pytest.fixture(autouse=True)
def reset_tavily_key_state() -> None:
    module._reset_tavily_key_state()


@pytest.mark.asyncio
async def test_single_key_rate_limit_retries_with_retry_after(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
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
            retry_after_seconds=0,
        )

    monkeypatch.setattr(module, "_tavily_keys", lambda: ("test-key",))
    monkeypatch.setattr(module, "_search_tavily", limited)
    outcome = await module.web_search(
        "query", max_attempts=3, allow_duckduckgo_fallback=False
    )

    assert calls == 3
    assert outcome.error_category == "rate_limited"


@pytest.mark.asyncio
async def test_timeout_retries_until_success(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = 0
    waits: list[float] = []

    async def flaky(query: str, max_results: int, key: str) -> SearchOutcome:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise httpx.TimeoutException("timeout")
        return SearchOutcome(ok=True, query=query, provider="tavily")

    async def sleeper(delay: float) -> None:
        waits.append(delay)

    monkeypatch.setattr(module, "_search_tavily", flaky)
    outcome = await module._search_provider_with_retries(
        "query",
        5,
        "tavily",
        "test-key",
        3,
        retry_policy=RetryPolicy(initial_delay_seconds=2),
        sleeper=sleeper,
        random_source=lambda: 0.25,
    )

    assert outcome.ok is True
    assert calls == 2
    assert waits == [0.5]


@pytest.mark.asyncio
async def test_network_error_retries(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = 0

    async def flaky(query: str, max_results: int, key: str) -> SearchOutcome:
        nonlocal calls
        calls += 1
        if calls == 1:
            request = httpx.Request("POST", "https://api.example.test/search")
            raise httpx.ConnectError("connection reset", request=request)
        return SearchOutcome(ok=True, query=query, provider="tavily")

    async def sleeper(delay: float) -> None:
        return None

    monkeypatch.setattr(module, "_search_tavily", flaky)
    outcome = await module._search_provider_with_retries(
        "query",
        5,
        "tavily",
        "test-key",
        2,
        sleeper=sleeper,
        random_source=lambda: 0,
    )

    assert outcome.ok is True
    assert calls == 2


@pytest.mark.asyncio
async def test_retryable_503_retries_but_400_does_not(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    statuses = [503, 200]
    waits: list[float] = []

    async def status_response(
        query: str,
        max_results: int,
        key: str,
    ) -> SearchOutcome:
        status = statuses.pop(0)
        if status == 200:
            return SearchOutcome(ok=True, query=query, provider="tavily")
        request = httpx.Request("POST", "https://api.example.test/search")
        response = httpx.Response(status, request=request)
        raise httpx.HTTPStatusError(str(status), request=request, response=response)

    async def sleeper(delay: float) -> None:
        waits.append(delay)

    monkeypatch.setattr(module, "_search_tavily", status_response)
    retryable = await module._search_provider_with_retries(
        "query",
        5,
        "tavily",
        "test-key",
        3,
        sleeper=sleeper,
        random_source=lambda: 0,
    )
    statuses[:] = [400, 200]
    permanent = await module._search_provider_with_retries(
        "query",
        5,
        "tavily",
        "test-key",
        3,
        sleeper=sleeper,
        random_source=lambda: 0,
    )

    assert retryable.ok is True
    assert permanent.ok is False
    assert statuses == [200]
    assert len(waits) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("category", ["auth_required", "quota_exhausted"])
async def test_credential_failure_does_not_retry(
    monkeypatch: pytest.MonkeyPatch,
    category: str,
) -> None:
    calls = 0

    async def rejected(query: str, max_results: int, key: str) -> SearchOutcome:
        nonlocal calls
        calls += 1
        return SearchOutcome(
            ok=False,
            query=query,
            provider="tavily",
            error="rejected",
            error_category=category,
        )

    monkeypatch.setattr(module, "_search_tavily", rejected)
    outcome = await module._search_provider_with_retries(
        "query",
        5,
        "tavily",
        "test-key",
        3,
        sleeper=lambda delay: None,
        random_source=lambda: 0,
    )

    assert outcome.ok is False
    assert calls == 1


@pytest.mark.asyncio
async def test_retry_budget_stops_before_waiting_past_deadline(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = 0
    now = 0.0
    waits: list[float] = []

    async def limited(query: str, max_results: int, key: str) -> SearchOutcome:
        nonlocal calls, now
        calls += 1
        now += 4
        return SearchOutcome(
            ok=False,
            query=query,
            provider="tavily",
            error="limited",
            error_category="rate_limited",
            retry_after_seconds=2,
        )

    async def sleeper(delay: float) -> None:
        waits.append(delay)

    monkeypatch.setattr(module, "_search_tavily", limited)
    outcome = await module._search_provider_with_retries(
        "query",
        5,
        "tavily",
        "test-key",
        3,
        retry_policy=RetryPolicy(max_attempts=3, max_elapsed_seconds=5),
        sleeper=sleeper,
        clock=lambda: now,
        random_source=lambda: 0,
    )

    assert outcome.error_category == "rate_limited"
    assert calls == 1
    assert waits == []


@pytest.mark.asyncio
async def test_max_attempts_is_a_hard_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = 0

    async def unavailable(query: str, max_results: int, key: str) -> SearchOutcome:
        nonlocal calls
        calls += 1
        return SearchOutcome(
            ok=False,
            query=query,
            provider="tavily",
            error="down",
            error_category="provider_unavailable",
        )

    async def sleeper(delay: float) -> None:
        return None

    monkeypatch.setattr(module, "_search_tavily", unavailable)
    await module._search_provider_with_retries(
        "query",
        5,
        "tavily",
        "test-key",
        2,
        sleeper=sleeper,
        random_source=lambda: 0,
    )

    assert calls == 2


@pytest.mark.asyncio
async def test_tavily_keys_consume_one_shared_deadline(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = 0.0
    remaining_at_call: list[float] = []
    deadline = DeadlineBudget.after(5, clock=lambda: now)

    async def search(query: str, max_results: int, key: str) -> SearchOutcome:
        nonlocal now
        remaining_at_call.append(deadline.remaining_seconds())
        if key == "one":
            now += 3
            return SearchOutcome(
                ok=False,
                query=query,
                provider="tavily",
                error="down",
                error_category="provider_unavailable",
            )
        return SearchOutcome(ok=True, query=query, provider="tavily")

    monkeypatch.setattr(module, "_tavily_keys", lambda: ("one", "two"))
    monkeypatch.setattr(module, "_search_tavily", search)
    outcome = await module.web_search(
        "query",
        deadline=deadline,
        allow_duckduckgo_fallback=False,
    )

    assert outcome.ok is True
    assert remaining_at_call == [5.0, 2.0]


@pytest.mark.asyncio
async def test_exhausted_deadline_does_not_start_next_key_or_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = 0.0
    calls: list[str] = []
    deadline = DeadlineBudget.after(5, clock=lambda: now)

    async def unavailable(
        query: str,
        max_results: int,
        key: str,
    ) -> SearchOutcome:
        nonlocal now
        calls.append(key)
        now += 5
        return SearchOutcome(
            ok=False,
            query=query,
            provider="tavily",
            error="down",
            error_category="provider_unavailable",
        )

    async def unexpected_fallback(query: str, max_results: int) -> SearchOutcome:
        calls.append("duckduckgo")
        raise AssertionError("deadline 耗尽后不得启动 fallback")

    monkeypatch.setattr(module, "_tavily_keys", lambda: ("one", "two"))
    monkeypatch.setattr(module, "_search_tavily", unavailable)
    monkeypatch.setattr(module, "_search_duckduckgo", unexpected_fallback)
    outcome = await module.web_search("query", deadline=deadline)

    assert outcome.ok is False
    assert outcome.provider == "tavily"
    assert calls == ["one"]


@pytest.mark.asyncio
async def test_expired_deadline_never_starts_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    deadline = DeadlineBudget(expires_at=0, clock=lambda: 0)

    async def unexpected(
        query: str,
        max_results: int,
        key: str,
    ) -> SearchOutcome:
        raise AssertionError("已到期 deadline 不得启动 Provider")

    monkeypatch.setattr(module, "_tavily_keys", lambda: ("one",))
    monkeypatch.setattr(module, "_search_tavily", unexpected)
    outcome = await module.web_search(
        "query",
        deadline=deadline,
    )

    assert outcome.ok is False
    assert outcome.error_category == "timeout"


@pytest.mark.asyncio
async def test_cancellation_still_escapes_shared_deadline(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    entered = module.asyncio.Event()

    async def blocked(query: str, max_results: int) -> SearchOutcome:
        entered.set()
        await module.asyncio.Event().wait()
        raise AssertionError("unreachable")

    monkeypatch.setattr(module, "_search_duckduckgo", blocked)
    task = module.asyncio.create_task(module.web_search(
        "query",
        deadline=DeadlineBudget.after(30),
        default_provider="duckduckgo",
    ))
    await entered.wait()
    task.cancel()

    with pytest.raises(module.asyncio.CancelledError):
        await task


@pytest.mark.asyncio
async def test_timeout_maps_to_stable_category(monkeypatch: pytest.MonkeyPatch) -> None:
    async def timeout(query: str, max_results: int, key: str) -> SearchOutcome:
        raise httpx.TimeoutException("timeout")

    monkeypatch.setattr(module, "_tavily_keys", lambda: ("test-key",))
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

    monkeypatch.setattr(module, "_tavily_keys", lambda: ("test-key",))
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
    monkeypatch.setattr(module, "_tavily_keys", lambda: ())
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

    monkeypatch.setattr(module, "_tavily_keys", lambda: ("test-key",))
    monkeypatch.setattr(module, "_search_tavily", unavailable)
    monkeypatch.setattr(module, "_search_duckduckgo", fallback)
    outcome = await module.web_search("query", max_attempts=1)
    assert outcome.ok is True
    assert outcome.provider == "duckduckgo"


def test_tavily_config_key_order_is_priority_legacy_then_fallback() -> None:
    keys = module._tavily_keys_from_config(
        {
            "search": {
                "providers": {
                    "tavily": {
                        "apiKeys": ["priority-one", "priority-two", "priority-one"],
                        "apiKey": "legacy",
                        "fallbackApiKeys": ["fallback", "  "],
                    }
                }
            }
        }
    )
    assert keys == ("priority-one", "priority-two", "legacy", "fallback")


def test_tavily_cursor_never_moves_backwards() -> None:
    keys = ("priority", "secondary")
    assert module._tavily_key_candidates(keys)[0][0] == 0

    module._select_tavily_key(keys, 1)
    module._select_tavily_key(keys, 0)

    assert module._tavily_key_candidates(keys) == ((1, "secondary"),)


@pytest.mark.asyncio
async def test_rate_limited_key_switches_and_keeps_successful_cursor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    async def search(query: str, max_results: int, key: str) -> SearchOutcome:
        calls.append(key)
        if key == "priority":
            return SearchOutcome(
                ok=False,
                query=query,
                provider="tavily",
                error="limited",
                error_category="rate_limited",
            )
        return SearchOutcome(ok=True, query=query, provider="tavily")

    monkeypatch.setattr(module, "_tavily_keys", lambda: ("priority", "secondary"))
    monkeypatch.setattr(module, "_search_tavily", search)

    first = await module.web_search(
        "query", max_attempts=3, allow_duckduckgo_fallback=False
    )
    second = await module.web_search(
        "query", max_attempts=3, allow_duckduckgo_fallback=False
    )

    assert first.ok is True
    assert second.ok is True
    assert calls == ["priority", "secondary", "secondary"]


@pytest.mark.asyncio
async def test_all_credential_failures_exhaust_pool_before_duckduckgo(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    async def exhausted(query: str, max_results: int, key: str) -> SearchOutcome:
        calls.append(key)
        return SearchOutcome(
            ok=False,
            query=query,
            provider="tavily",
            error="exhausted",
            error_category="quota_exhausted",
        )

    async def fallback(query: str, max_results: int) -> SearchOutcome:
        return SearchOutcome(ok=True, query=query, provider="duckduckgo")

    monkeypatch.setattr(module, "_tavily_keys", lambda: ("one", "two", "three"))
    monkeypatch.setattr(module, "_search_tavily", exhausted)
    monkeypatch.setattr(module, "_search_duckduckgo", fallback)

    outcome = await module.web_search("query", max_attempts=3)

    assert calls == ["one", "two", "three"]
    assert outcome.ok is True
    assert outcome.provider == "duckduckgo"


@pytest.mark.asyncio
async def test_provider_outage_switches_once_then_uses_duckduckgo(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    async def unavailable(query: str, max_results: int, key: str) -> SearchOutcome:
        calls.append(key)
        return SearchOutcome(
            ok=False,
            query=query,
            provider="tavily",
            error="down",
            error_category="provider_unavailable",
        )

    async def fallback(query: str, max_results: int) -> SearchOutcome:
        return SearchOutcome(ok=True, query=query, provider="duckduckgo")

    monkeypatch.setattr(module, "_tavily_keys", lambda: ("one", "two", "three"))
    monkeypatch.setattr(module, "_search_tavily", unavailable)
    monkeypatch.setattr(module, "_search_duckduckgo", fallback)

    outcome = await module.web_search("query", max_attempts=3)

    assert calls == ["one", "two"]
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
