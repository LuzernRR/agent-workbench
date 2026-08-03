from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from app.reliability.retry import ErrorKind, RetryPolicy, next_delay, parse_retry_after


def test_parse_retry_after_accepts_delta_seconds() -> None:
    assert parse_retry_after("2.5") == 2.5
    assert parse_retry_after("-3") == 0.0


def test_parse_retry_after_accepts_http_date_and_clamps_past_date() -> None:
    now = datetime(2026, 8, 4, 10, 0, tzinfo=UTC)

    assert parse_retry_after(
        "Tue, 04 Aug 2026 10:00:05 GMT",
        now=now,
    ) == 5.0
    assert parse_retry_after(
        "Tue, 04 Aug 2026 09:59:59 GMT",
        now=now,
    ) == 0.0


@pytest.mark.parametrize("value", [None, "", "not-a-date", "NaN", "Infinity"])
def test_parse_retry_after_rejects_invalid_values(value: str | None) -> None:
    assert parse_retry_after(value) is None


def test_next_delay_uses_full_jitter_and_caps_exponential_backoff() -> None:
    policy = RetryPolicy(
        max_attempts=5,
        max_elapsed_seconds=30,
        initial_delay_seconds=2,
        max_delay_seconds=3,
        multiplier=2,
    )

    assert next_delay(
        policy,
        error_kind=ErrorKind.TRANSIENT,
        attempt=1,
        elapsed_seconds=0,
        random_value=0.25,
    ) == 0.5
    assert next_delay(
        policy,
        error_kind=ErrorKind.TRANSIENT,
        attempt=3,
        elapsed_seconds=0,
        random_value=0.5,
    ) == 1.5


def test_next_delay_prefers_retry_after_but_keeps_hard_limits() -> None:
    policy = RetryPolicy(
        max_attempts=3,
        max_elapsed_seconds=10,
        max_delay_seconds=4,
    )

    assert next_delay(
        policy,
        error_kind=ErrorKind.RATE_LIMIT,
        attempt=1,
        elapsed_seconds=1,
        random_value=0,
        retry_after_seconds=8,
    ) == 4
    assert next_delay(
        policy,
        error_kind=ErrorKind.RATE_LIMIT,
        attempt=1,
        elapsed_seconds=7,
        random_value=0,
        retry_after_seconds=8,
    ) is None


def test_next_delay_stops_for_permanent_error_attempt_limit_and_deadline() -> None:
    policy = RetryPolicy(max_attempts=2, max_elapsed_seconds=5)

    assert next_delay(
        policy,
        error_kind=ErrorKind.PERMANENT,
        attempt=1,
        elapsed_seconds=0,
        random_value=0,
    ) is None
    assert next_delay(
        policy,
        error_kind=ErrorKind.TIMEOUT,
        attempt=2,
        elapsed_seconds=0,
        random_value=0,
    ) is None
    assert next_delay(
        policy,
        error_kind=ErrorKind.TIMEOUT,
        attempt=1,
        elapsed_seconds=5,
        random_value=0,
    ) is None


def test_retry_after_http_date_is_independent_of_local_timezone() -> None:
    now = datetime(2026, 8, 4, 10, 0, tzinfo=UTC) + timedelta(hours=0)

    assert parse_retry_after("Tue, 04 Aug 2026 10:00:01 GMT", now=now) == 1.0


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"max_attempts": 0}, "max_attempts"),
        ({"max_elapsed_seconds": 0}, "max_elapsed_seconds"),
        ({"initial_delay_seconds": -1}, "initial_delay_seconds"),
        ({"max_delay_seconds": -1}, "max_delay_seconds"),
        ({"multiplier": 0.5}, "multiplier"),
    ],
)
def test_retry_policy_rejects_invalid_limits(
    kwargs: dict[str, int | float],
    message: str,
) -> None:
    with pytest.raises(ValueError, match=message):
        RetryPolicy(**kwargs)
