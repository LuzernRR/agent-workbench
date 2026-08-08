from __future__ import annotations

import hashlib
import hmac

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.api.schemas import SearchRunRequest
from app.main import _authorize_tenant

SECRET = "secret-token"


def payload(*, tenant_id: str = "tenant_1", run_id: str = "run_1", visitor_id: str = "visitor_1") -> SearchRunRequest:
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
    monkeypatch.setenv("WORKBENCH_INTERNAL_TOKEN", "golden-secret")
    _authorize_tenant(
        "v1:246dd156b8524e835ff30c6dae169aec7d3dccff0fb4a703f3acb8f44572abd0",
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
    monkeypatch.setenv("WORKBENCH_INTERNAL_TOKEN", SECRET)
    request = payload()
    _authorize_tenant(assertion_for(request), request)


def test_body_tenant_cannot_be_rebound_without_a_matching_signature(monkeypatch: pytest.MonkeyPatch) -> None:
    """A caller holding the shared token still cannot claim another tenant."""
    monkeypatch.setenv("WORKBENCH_INTERNAL_TOKEN", SECRET)
    signed = assertion_for(payload(tenant_id="tenant_1"))
    with pytest.raises(HTTPException) as error:
        _authorize_tenant(signed, payload(tenant_id="tenant_2"))
    assert error.value.status_code == 403


def test_replaying_an_assertion_onto_another_run_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WORKBENCH_INTERNAL_TOKEN", SECRET)
    signed = assertion_for(payload(run_id="run_1"))
    with pytest.raises(HTTPException) as error:
        _authorize_tenant(signed, payload(run_id="run_2"))
    assert error.value.status_code == 403


def test_assertion_signed_with_another_secret_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WORKBENCH_INTERNAL_TOKEN", SECRET)
    request = payload()
    with pytest.raises(HTTPException):
        _authorize_tenant(assertion_for(request, secret="other-token"), request)


def test_missing_assertion_fails_closed_when_a_secret_is_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WORKBENCH_INTERNAL_TOKEN", SECRET)
    with pytest.raises(HTTPException) as error:
        _authorize_tenant(None, payload())
    assert error.value.status_code == 401


def test_unconfigured_secret_defers_to_the_loopback_auth_decision(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("WORKBENCH_INTERNAL_TOKEN", raising=False)
    _authorize_tenant(None, payload())
