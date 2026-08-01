"""Evidence 稳定身份与单调生命周期。"""

from __future__ import annotations

import hashlib
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any, Literal

from app.graph.state import Evidence

EvidenceStatus = Literal["read", "accepted", "rejected", "cited"]

_ALLOWED_TRANSITIONS: dict[EvidenceStatus, frozenset[EvidenceStatus]] = {
    "read": frozenset({"accepted", "rejected"}),
    "accepted": frozenset({"cited"}),
    "rejected": frozenset(),
    "cited": frozenset(),
}


class EvidenceStateConflictError(RuntimeError):
    """Evidence 身份或状态发生冲突时 fail-closed。"""

    code = "EVIDENCE_STATE_CONFLICT"


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def evidence_identity(url: str, text: str) -> tuple[str, str, str]:
    """只依据服务端已读 URL 与正文生成稳定身份。"""

    canonical_url = url.strip()
    content_hash = _sha256(text)
    source_id = f"source_{_sha256(canonical_url)[:40]}"
    evidence_id = f"evidence_{_sha256(f'{source_id}\0{content_hash}')[:40]}"
    return source_id, evidence_id, content_hash


def normalize_evidence(item: Mapping[str, Any]) -> Evidence:
    """兼容旧 checkpoint，同时拒绝伪造或漂移的服务端身份。"""

    value = dict(item)
    url = str(value.get("url") or "")
    text = str(value.get("text") or "")
    source_id, evidence_id, content_hash = evidence_identity(url, text)
    expected = {
        "source_id": source_id,
        "evidence_id": evidence_id,
        "content_hash": content_hash,
    }
    for key, generated in expected.items():
        supplied = value.get(key)
        if supplied is not None and supplied != generated:
            raise EvidenceStateConflictError(f"conflicting {key}")
        value[key] = generated
    status = str(value.get("status") or "read")
    if status not in _ALLOWED_TRANSITIONS:
        raise EvidenceStateConflictError("invalid evidence status")
    value["status"] = status
    value["status_reason_code"] = str(
        value.get("status_reason_code") or "BODY_READ"
    )
    value["status_updated_at"] = str(
        value.get("status_updated_at")
        or value.get("captured_at")
        or datetime.now(UTC).isoformat().replace("+00:00", "Z")
    )
    return Evidence(**value)


def transition_evidence(
    item: Mapping[str, Any],
    status: EvidenceStatus,
    reason_code: str,
    *,
    updated_at: str | None = None,
) -> tuple[Evidence, bool]:
    """执行合法单向迁移；同状态重放幂等。"""

    current = normalize_evidence(item)
    current_status = current["status"]
    if current_status == status:
        return current, False
    if status not in _ALLOWED_TRANSITIONS[current_status]:
        raise EvidenceStateConflictError(
            f"invalid transition: {current_status}->{status}"
        )
    transitioned = Evidence(**{
        **current,
        "status": status,
        "status_reason_code": reason_code,
        "status_updated_at": updated_at
        or datetime.now(UTC).isoformat().replace("+00:00", "Z"),
    })
    return transitioned, True


def answerable_evidence(items: list[Evidence]) -> list[Evidence]:
    """只有已采用或已引用 Evidence 可以进入事实写作与核验。"""

    return [
        normalized
        for item in items
        if (normalized := normalize_evidence(item))["status"]
        in {"accepted", "cited"}
    ]


def evidence_event_payload(item: Mapping[str, Any]) -> dict[str, Any]:
    """公开事件白名单；绝不包含正文或模型输入。"""

    evidence = normalize_evidence(item)
    return {
        "evidenceId": evidence["evidence_id"],
        "sourceId": evidence["source_id"],
        "contentHash": evidence["content_hash"],
        "toolCallId": evidence["tool_call_id"],
        "url": evidence["url"],
        "title": evidence["title"],
        "channel": evidence["channel"],
        "status": evidence["status"],
        "reasonCode": evidence["status_reason_code"],
        "updatedAt": evidence["status_updated_at"],
    }
