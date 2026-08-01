from __future__ import annotations

import pytest

from app.graph.evidence import (
    EvidenceStateConflictError,
    answerable_evidence,
    evidence_event_payload,
    evidence_identity,
    normalize_evidence,
    transition_evidence,
)


def raw_evidence(*, text: str = "已读取正文") -> dict[str, object]:
    return {
        "tool_call_id": "call_one",
        "query": "公开查询",
        "channel": "web",
        "provider": "test",
        "title": "公开标题",
        "url": "https://example.com/source",
        "text": text,
        "captured_at": "2026-08-01T00:00:00Z",
        "author": None,
        "published_at": None,
        "metrics": {},
        "provenance": {},
    }


def test_identity_is_stable_and_content_sensitive() -> None:
    first = evidence_identity("https://example.com/source", "正文一")
    replay = evidence_identity("https://example.com/source", "正文一")
    changed = evidence_identity("https://example.com/source", "正文二")

    assert first == replay
    assert first[0] == changed[0]
    assert first[1] != changed[1]
    assert first[2] != changed[2]


def test_valid_lifecycle_is_monotonic_and_idempotent() -> None:
    read = normalize_evidence(raw_evidence())
    accepted, accepted_changed = transition_evidence(
        read, "accepted", "SOURCE_PRESENTED", updated_at="2026-08-01T00:00:01Z"
    )
    replay, replay_changed = transition_evidence(
        accepted, "accepted", "SOURCE_PRESENTED", updated_at="2026-08-01T00:00:02Z"
    )
    cited, cited_changed = transition_evidence(
        replay, "cited", "ANSWER_CITED", updated_at="2026-08-01T00:00:03Z"
    )

    assert read["status"] == "read"
    assert accepted_changed is True
    assert replay_changed is False
    assert replay == accepted
    assert cited_changed is True
    assert cited["status"] == "cited"
    assert answerable_evidence([read, accepted, cited]) == [accepted, cited]


def test_rejected_evidence_is_terminal_and_not_answerable() -> None:
    rejected, changed = transition_evidence(
        raw_evidence(), "rejected", "SOURCE_IRRELEVANT"
    )
    assert changed is True
    assert answerable_evidence([rejected]) == []
    with pytest.raises(EvidenceStateConflictError) as error:
        transition_evidence(rejected, "accepted", "SOURCE_PRESENTED")
    assert error.value.code == "EVIDENCE_STATE_CONFLICT"


@pytest.mark.parametrize(
    ("initial", "target"),
    [("accepted", "rejected"), ("cited", "accepted"), ("rejected", "cited")],
)
def test_invalid_transition_fails_closed(initial: str, target: str) -> None:
    item = normalize_evidence(raw_evidence())
    if initial == "accepted":
        item, _ = transition_evidence(item, "accepted", "SOURCE_PRESENTED")
    elif initial == "cited":
        item, _ = transition_evidence(item, "accepted", "SOURCE_PRESENTED")
        item, _ = transition_evidence(item, "cited", "ANSWER_CITED")
    else:
        item, _ = transition_evidence(item, "rejected", "SOURCE_IRRELEVANT")

    with pytest.raises(EvidenceStateConflictError):
        transition_evidence(item, target, "INVALID")  # type: ignore[arg-type]


def test_forged_identity_is_rejected() -> None:
    with pytest.raises(EvidenceStateConflictError):
        normalize_evidence({**raw_evidence(), "evidence_id": "evidence_forged"})


def test_public_event_payload_is_body_free_whitelist() -> None:
    item = normalize_evidence(raw_evidence())
    payload = evidence_event_payload(item)

    assert set(payload) == {
        "evidenceId",
        "sourceId",
        "contentHash",
        "toolCallId",
        "url",
        "title",
        "channel",
        "status",
        "reasonCode",
        "updatedAt",
    }
    assert payload["status"] == "read"
    assert not {"text", "query", "provider", "author", "metrics"}.intersection(payload)
