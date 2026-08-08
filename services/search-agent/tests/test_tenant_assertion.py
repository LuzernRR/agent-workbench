from __future__ import annotations

import hashlib
import hmac

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.api.schemas import SearchRunRequest
from app.main import _authorize_tenant, _validate_security_configuration

TOKEN = "internal-transport-token"
SECRET = "0123456789abcdef0123456789abcdef"


def payload(
    *,
    tenant_id: str = "tenant_1",
    run_id: str = "run_1",
    visitor_id: str = "visitor_1",
    resume: bool = False,
) -> SearchRunRequest:
    return SearchRunRequest.model_validate({
        "version": 1,
        "runId": run_id,
        "tenantId": tenant_id,
        "visitorId": visitor_id,
        "projectId": "project_1",
        "threadId": "thread_1",
        "question": "测试问题",
        "modelId": "deepseek-v4-flash",
        "reasoningEffort": "high",
        "resume": resume,
        "checkpointId": "checkpoint_1" if resume else None,
        "checkpointNs": "research/subgraph" if resume else None,
        "checkpointSessionId": "checkpoint_session_1",
    })


def assertion_for(request: SearchRunRequest, *, secret: str = SECRET) -> str:
    parts = (request.tenant_id, request.run_id, request.visitor_id)
    body = "".join(f"{len(part.encode('utf-8'))}:{part}" for part in parts)
    mac = hmac.new(secret.encode("utf-8"), body.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"v1:{mac}"


def test_shared_vector_matches_the_web_signer(monkeypatch: pytest.MonkeyPatch) -> None:
    """Known-answer vectors also pinned in apps/web/.../tenant-assertion.test.ts.

    Two implementations of one MAC can drift silently; changing the payload
    format on either side has to break both suites, not just one.
    """
    monkeypatch.setenv("WORKBENCH_INTERNAL_TOKEN", TOKEN)
    monkeypatch.setenv("WORKBENCH_TENANT_ASSERTION_SECRET", SECRET)
    _authorize_tenant(
        "v1:d0cc50732b3b1a5892d4dee8613bd7093fc9c264feaa6d671a2e8719059aae34",
        payload(tenant_id="tenant_1", run_id="run_1", visitor_id="visitor_1"),
    )


def test_scope_ids_cannot_carry_the_payload_separator() -> None:
    """The length prefix is defence in depth; the schema is the first gate.

    A colon in any scope ID never reaches the MAC, so boundary-shifting is
    unreachable through the public API. This pins that gate.
    """
    for field, value in (("runId", "run_1:a"), ("tenantId", "tenant:a"), ("visitorId", "visitor:a")):
        with pytest.raises(ValidationError):
            payload_dict = {
                "version": 1,
                "runId": "run_1",
                "tenantId": "tenant_1",
                "visitorId": "visitor_1",
                "projectId": "project_1",
                "threadId": "thread_1",
                "question": "测试问题",
                "modelId": "deepseek-v4-flash",
                "reasoningEffort": "high",
                "checkpointSessionId": "checkpoint_session_1",
            }
            payload_dict[field] = value
            SearchRunRequest.model_validate(payload_dict)


def test_valid_assertion_is_accepted(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WORKBENCH_INTERNAL_TOKEN", TOKEN)
    monkeypatch.setenv("WORKBENCH_TENANT_ASSERTION_SECRET", SECRET)
    request = payload()
    _validate_security_configuration()
    _authorize_tenant(assertion_for(request), request)


def test_body_tenant_cannot_be_rebound_without_a_matching_signature(monkeypatch: pytest.MonkeyPatch) -> None:
    """A caller holding the transport token still cannot claim another tenant."""
    monkeypatch.setenv("WORKBENCH_INTERNAL_TOKEN", TOKEN)
    monkeypatch.setenv("WORKBENCH_TENANT_ASSERTION_SECRET", SECRET)
    signed = assertion_for(payload(tenant_id="tenant_1"))
    with pytest.raises(HTTPException) as error:
        _authorize_tenant(signed, payload(tenant_id="tenant_2"))
    assert error.value.status_code == 403


def test_replaying_an_assertion_onto_another_run_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WORKBENCH_INTERNAL_TOKEN", TOKEN)
    monkeypatch.setenv("WORKBENCH_TENANT_ASSERTION_SECRET", SECRET)
    signed = assertion_for(payload(run_id="run_1"))
    with pytest.raises(HTTPException) as error:
        _authorize_tenant(signed, payload(run_id="run_2"))
    assert error.value.status_code == 403


def test_assertion_signed_with_another_secret_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WORKBENCH_INTERNAL_TOKEN", TOKEN)
    monkeypatch.setenv("WORKBENCH_TENANT_ASSERTION_SECRET", SECRET)
    request = payload()
    with pytest.raises(HTTPException):
        _authorize_tenant(assertion_for(request, secret="other-token"), request)


@pytest.mark.parametrize("assertion", ["v1:abc", "v2:" + "0" * 64, "v1:" + "密" * 64])
def test_malformed_assertion_is_a_controlled_rejection(
    monkeypatch: pytest.MonkeyPatch,
    assertion: str,
) -> None:
    monkeypatch.setenv("WORKBENCH_INTERNAL_TOKEN", TOKEN)
    monkeypatch.setenv("WORKBENCH_TENANT_ASSERTION_SECRET", SECRET)

    with pytest.raises(HTTPException) as error:
        _authorize_tenant(assertion, payload())

    assert error.value.status_code == 403


def test_missing_assertion_fails_closed_when_a_secret_is_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WORKBENCH_INTERNAL_TOKEN", TOKEN)
    monkeypatch.setenv("WORKBENCH_TENANT_ASSERTION_SECRET", SECRET)
    with pytest.raises(HTTPException) as error:
        _authorize_tenant(None, payload())
    assert error.value.status_code == 401


def test_only_knowing_the_internal_token_cannot_forge_an_assertion(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("WORKBENCH_INTERNAL_TOKEN", TOKEN)
    monkeypatch.setenv("WORKBENCH_TENANT_ASSERTION_SECRET", SECRET)
    request = payload()

    with pytest.raises(HTTPException) as error:
        _authorize_tenant(assertion_for(request, secret=TOKEN), request)

    assert error.value.status_code == 403


def test_missing_weak_or_reused_assertion_secret_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("WORKBENCH_INTERNAL_TOKEN", TOKEN)
    monkeypatch.delenv("WORKBENCH_TENANT_ASSERTION_SECRET", raising=False)
    monkeypatch.delenv("SEARCH_AGENT_ALLOW_INSECURE_LOOPBACK", raising=False)

    with pytest.raises(HTTPException) as missing:
        _authorize_tenant(None, payload())
    assert missing.value.status_code == 503

    monkeypatch.setenv("WORKBENCH_TENANT_ASSERTION_SECRET", "too-short")
    with pytest.raises(HTTPException) as weak:
        _authorize_tenant(None, payload())
    assert weak.value.status_code == 503

    monkeypatch.setenv("WORKBENCH_INTERNAL_TOKEN", SECRET)
    monkeypatch.setenv("WORKBENCH_TENANT_ASSERTION_SECRET", SECRET)
    with pytest.raises(HTTPException) as reused:
        _authorize_tenant(None, payload())
    assert reused.value.status_code == 503


def test_startup_validation_rejects_missing_weak_or_reused_secret(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("WORKBENCH_INTERNAL_TOKEN", TOKEN)
    monkeypatch.delenv("WORKBENCH_TENANT_ASSERTION_SECRET", raising=False)
    monkeypatch.delenv("SEARCH_AGENT_ALLOW_INSECURE_LOOPBACK", raising=False)
    with pytest.raises(RuntimeError, match="WORKBENCH_TENANT_ASSERTION_SECRET"):
        _validate_security_configuration()

    monkeypatch.setenv("WORKBENCH_TENANT_ASSERTION_SECRET", "too-short")
    with pytest.raises(RuntimeError, match="32"):
        _validate_security_configuration()

    monkeypatch.setenv("WORKBENCH_INTERNAL_TOKEN", SECRET)
    monkeypatch.setenv("WORKBENCH_TENANT_ASSERTION_SECRET", SECRET)
    with pytest.raises(RuntimeError, match="独立"):
        _validate_security_configuration()


def test_secret_strength_counts_utf8_bytes(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WORKBENCH_INTERNAL_TOKEN", TOKEN)
    unicode_secret = "密" * 11
    assert len(unicode_secret) == 11
    assert len(unicode_secret.encode("utf-8")) == 33
    monkeypatch.setenv("WORKBENCH_TENANT_ASSERTION_SECRET", unicode_secret)

    _authorize_tenant(assertion_for(payload(), secret=unicode_secret), payload())


def test_unconfigured_secret_requires_explicit_loopback_mode(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("WORKBENCH_TENANT_ASSERTION_SECRET", raising=False)
    monkeypatch.setenv("WORKBENCH_INTERNAL_TOKEN", TOKEN)
    monkeypatch.setenv("SEARCH_AGENT_ALLOW_INSECURE_LOOPBACK", "1")
    monkeypatch.setenv("SEARCH_AGENT_HOST", "127.0.0.1")
    _authorize_tenant(None, payload())

    monkeypatch.setenv("SEARCH_AGENT_HOST", "0.0.0.0")
    with pytest.raises(HTTPException) as error:
        _authorize_tenant(None, payload())
    assert error.value.status_code == 503


def test_recovery_keeps_the_same_scope_but_replay_cannot_change_run_or_visitor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("WORKBENCH_INTERNAL_TOKEN", TOKEN)
    monkeypatch.setenv("WORKBENCH_TENANT_ASSERTION_SECRET", SECRET)
    request = payload(resume=True)
    signed = assertion_for(request)

    _authorize_tenant(signed, request)
    with pytest.raises(HTTPException):
        _authorize_tenant(signed, payload(run_id="run_2", resume=True))
    with pytest.raises(HTTPException):
        _authorize_tenant(signed, payload(visitor_id="visitor_2", resume=True))
