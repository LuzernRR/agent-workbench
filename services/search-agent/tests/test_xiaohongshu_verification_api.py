from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.main import (
    xiaohongshu_verification_qrcode,
    xiaohongshu_verification_status,
)
from app.tools.channels.xiaohongshu_mcp import XiaohongshuLoginVerification
from app.tools.xiaohongshu_verification import XiaohongshuVerificationRegistry

CHALLENGE_ID = "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789"


class VerificationClient:
    async def login_verification_status(
        self,
        challenge_id: str,
    ) -> XiaohongshuLoginVerification:
        return XiaohongshuLoginVerification(
            challenge_id=challenge_id,
            status="pending",
            expires_at=(
                datetime.now(UTC) + timedelta(minutes=4)
            ).isoformat().replace("+00:00", "Z"),
            retry_after_ms=2000,
            message="等待使用小红书 App 扫码验证工具账号",
        )

    async def login_verification_qrcode(self, challenge_id: str) -> bytes:
        assert challenge_id == CHALLENGE_ID
        return b"\x89PNG\r\n\x1a\nverification"


def request_scope() -> SimpleNamespace:
    registry = XiaohongshuVerificationRegistry()
    registry.bind(
        run_id="run_one",
        tool_call_id="call_one",
        challenge_id=CHALLENGE_ID,
        expires_at=(
            datetime.now(UTC) + timedelta(minutes=4)
        ).isoformat().replace("+00:00", "Z"),
    )
    state = SimpleNamespace(
        xiaohongshu_verifications=registry,
        xiaohongshu_client=VerificationClient(),
    )
    return SimpleNamespace(app=SimpleNamespace(state=state))


@pytest.mark.asyncio
async def test_internal_verification_api_returns_status_and_no_store_png(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("WORKBENCH_INTERNAL_TOKEN", "internal-token")
    request = request_scope()

    status = await xiaohongshu_verification_status(
        "run_one",
        CHALLENGE_ID,
        request,  # type: ignore[arg-type]
        "internal-token",
    )
    image = await xiaohongshu_verification_qrcode(
        "run_one",
        CHALLENGE_ID,
        request,  # type: ignore[arg-type]
        "internal-token",
    )

    assert status["status"] == "pending"
    assert status["challengeId"] == CHALLENGE_ID
    assert image.media_type == "image/png"
    assert image.headers["cache-control"] == "no-store"
    assert image.body.startswith(b"\x89PNG")


@pytest.mark.asyncio
async def test_internal_verification_api_rejects_wrong_run_scope(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("WORKBENCH_INTERNAL_TOKEN", "internal-token")

    with pytest.raises(HTTPException) as raised:
        await xiaohongshu_verification_status(
            "run_other",
            CHALLENGE_ID,
            request_scope(),  # type: ignore[arg-type]
            "internal-token",
        )

    assert raised.value.status_code == 404
