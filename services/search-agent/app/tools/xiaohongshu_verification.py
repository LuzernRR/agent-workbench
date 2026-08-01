"""小红书工具账号验证挑战与 Agent Run 的短期绑定。"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from threading import RLock

_IDENTIFIER = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
_CHALLENGE = re.compile(r"^[A-Za-z0-9_-]{43}$")


@dataclass(frozen=True)
class XiaohongshuVerificationGrant:
    run_id: str
    tool_call_id: str
    challenge_id: str
    expires_at: datetime


class XiaohongshuVerificationRegistry:
    """只保存不可猜测挑战与公开 Run 标识的短期关系。

    二维码和任何登录材料始终留在隔离的 xiaohongshu-mcp 服务中。
    """

    def __init__(self) -> None:
        self._lock = RLock()
        self._grants: dict[str, XiaohongshuVerificationGrant] = {}

    def bind(
        self,
        *,
        run_id: str,
        tool_call_id: str,
        challenge_id: str,
        expires_at: str,
    ) -> XiaohongshuVerificationGrant:
        if not _IDENTIFIER.fullmatch(run_id) or not _IDENTIFIER.fullmatch(tool_call_id):
            raise ValueError("invalid verification scope")
        if not _CHALLENGE.fullmatch(challenge_id):
            raise ValueError("invalid verification challenge")
        try:
            expires = datetime.fromisoformat(expires_at)
        except ValueError as exc:
            raise ValueError("invalid verification expiry") from exc
        if expires.tzinfo is None:
            raise ValueError("invalid verification expiry")
        grant = XiaohongshuVerificationGrant(
            run_id=run_id,
            tool_call_id=tool_call_id,
            challenge_id=challenge_id,
            expires_at=expires.astimezone(UTC),
        )
        with self._lock:
            self._cleanup_locked(datetime.now(UTC))
            existing = self._grants.get(challenge_id)
            if existing and (
                existing.run_id != run_id
                or existing.tool_call_id != tool_call_id
            ):
                raise ValueError("verification challenge scope mismatch")
            self._grants[challenge_id] = grant
        return grant

    def owns(self, *, run_id: str, challenge_id: str) -> bool:
        if not _IDENTIFIER.fullmatch(run_id) or not _CHALLENGE.fullmatch(challenge_id):
            return False
        with self._lock:
            now = datetime.now(UTC)
            self._cleanup_locked(now)
            grant = self._grants.get(challenge_id)
            return bool(grant and grant.run_id == run_id)

    def _cleanup_locked(self, now: datetime) -> None:
        expired = [
            challenge_id
            for challenge_id, grant in self._grants.items()
            if now >= grant.expires_at + timedelta(minutes=10)
        ]
        for challenge_id in expired:
            self._grants.pop(challenge_id, None)
