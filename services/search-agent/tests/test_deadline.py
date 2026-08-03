from __future__ import annotations

import pytest

from app.reliability.deadline import DeadlineBudget


def test_deadline_uses_injected_monotonic_clock() -> None:
    now = 10.0
    deadline = DeadlineBudget.after(5, clock=lambda: now)

    assert deadline.expires_at == 15.0
    assert deadline.remaining_seconds() == 5.0

    now = 13.5
    assert deadline.remaining_seconds() == 1.5

    now = 16.0
    assert deadline.remaining_seconds() == 0.0
    assert deadline.expired is True


def test_bounded_deadline_never_extends_parent() -> None:
    now = 20.0
    parent = DeadlineBudget.after(5, clock=lambda: now)

    assert parent.bounded(30).expires_at == 25.0
    assert parent.bounded(2).expires_at == 22.0


@pytest.mark.parametrize("seconds", [0, -1, float("inf"), float("nan")])
def test_deadline_rejects_invalid_timeout(seconds: float) -> None:
    with pytest.raises(ValueError, match="timeout_seconds"):
        DeadlineBudget.after(seconds)
