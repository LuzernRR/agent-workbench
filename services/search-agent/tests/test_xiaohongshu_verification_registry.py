from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from app.tools.xiaohongshu_verification import XiaohongshuVerificationRegistry

CHALLENGE_ID = "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789"


def expiry() -> str:
    return (datetime.now(UTC) + timedelta(minutes=4)).isoformat().replace(
        "+00:00",
        "Z",
    )


def test_registry_binds_challenge_to_exact_run_and_tool() -> None:
    registry = XiaohongshuVerificationRegistry()
    grant = registry.bind(
        run_id="run_one",
        tool_call_id="call_one",
        challenge_id=CHALLENGE_ID,
        expires_at=expiry(),
    )

    assert grant.run_id == "run_one"
    assert registry.owns(run_id="run_one", challenge_id=CHALLENGE_ID) is True
    assert registry.owns(run_id="run_two", challenge_id=CHALLENGE_ID) is False


def test_registry_rejects_challenge_rebinding_and_invalid_identifiers() -> None:
    registry = XiaohongshuVerificationRegistry()
    registry.bind(
        run_id="run_one",
        tool_call_id="call_one",
        challenge_id=CHALLENGE_ID,
        expires_at=expiry(),
    )

    with pytest.raises(ValueError, match="scope mismatch"):
        registry.bind(
            run_id="run_two",
            tool_call_id="call_two",
            challenge_id=CHALLENGE_ID,
            expires_at=expiry(),
        )
    assert registry.owns(run_id="../run", challenge_id=CHALLENGE_ID) is False
    assert registry.owns(run_id="run_one", challenge_id="short") is False
