from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import HTTPException

from app.api.schemas import SearchRunRequest, validate_run_id
from app.config.agent import agent_config
from app.harness.runner import HarnessDependencies, HarnessRunner
from app.main import _authorize, _run_stream, stop_run
from app.run_control import RunRegistry


class RecordingLedger:
    def __init__(self) -> None:
        self.unknown_runs: list[tuple[str, str]] = []

    async def unknown_for_run(self, run_id: str, error_code: str) -> None:
        self.unknown_runs.append((run_id, error_code))


class NoopGraph:
    async def aget_state(self, config: dict[str, Any]) -> Any:
        return SimpleNamespace(values={})

    async def astream(self, *args: Any, **kwargs: Any):
        if False:
            yield None


def payload(*, run_id: str = "run_1", resume: bool = False) -> SearchRunRequest:
    return SearchRunRequest.model_validate({
        "version": 1,
        "runId": run_id,
        "tenantId": "tenant_1",
        "visitorId": "visitor_1",
        "projectId": "project_1",
        "threadId": "thread_1",
        "question": "测试问题",
        "modelId": "deepseek-v4-flash",
        "reasoningEffort": "high",
        "resume": resume,
        "checkpointId": "checkpoint_1" if resume else None,
        "checkpointNs": "" if resume else None,
        "checkpointSessionId": "checkpoint_session_1",
    })


def request_data(**overrides: Any) -> dict[str, Any]:
    data: dict[str, Any] = {
        "version": 1,
        "runId": "run_1",
        "tenantId": "tenant_1",
        "visitorId": "visitor_1",
        "projectId": "project_1",
        "threadId": "thread_1",
        "question": "测试问题",
        "modelId": "deepseek-v4-flash",
        "reasoningEffort": "high",
        "resume": False,
        "checkpointId": None,
        "checkpointNs": None,
        "checkpointSessionId": "checkpoint_session_1",
    }
    data.update(overrides)
    return data


@pytest.mark.parametrize(
    "overrides",
    [
        {"checkpointSessionId": None},
        {"checkpointSessionId": "bad/session"},
        {"resume": False, "checkpointId": "checkpoint_1"},
        {"resume": False, "checkpointNs": ""},
        {"resume": True, "checkpointId": None},
        {"resume": True, "checkpointId": "checkpoint_1", "checkpointNs": None},
        {"resume": True, "checkpointId": "bad/checkpoint"},
        {"resume": True, "checkpointId": "checkpoint_1", "checkpointNs": "bad\nnamespace"},
    ],
)
def test_checkpoint_resume_contract_fails_closed(overrides: dict[str, Any]) -> None:
    with pytest.raises(ValueError):
        SearchRunRequest.model_validate(request_data(**overrides))


def test_checkpoint_resume_contract_accepts_an_exact_authority() -> None:
    request = SearchRunRequest.model_validate(request_data(
        resume=True,
        checkpointId="checkpoint_1",
        checkpointNs="research/subgraph",
    ))

    assert request.resume is True
    assert request.checkpoint_id == "checkpoint_1"
    assert request.checkpoint_ns == "research/subgraph"
    assert request.checkpoint_session_id == "checkpoint_session_1"


def test_internal_auth_fails_closed_without_token_or_explicit_loopback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("WORKBENCH_INTERNAL_TOKEN", raising=False)
    monkeypatch.delenv("SEARCH_AGENT_ALLOW_INSECURE_LOOPBACK", raising=False)
    with pytest.raises(HTTPException) as error:
        _authorize(None)
    assert error.value.status_code == 503


def test_internal_auth_accepts_matching_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WORKBENCH_INTERNAL_TOKEN", "expected")
    _authorize("expected")
    with pytest.raises(HTTPException) as error:
        _authorize("wrong")
    assert error.value.status_code == 401


@pytest.mark.asyncio
async def test_run_registry_stop_is_idempotent() -> None:
    registry = RunRegistry()
    started = asyncio.Event()

    async def sleeper() -> None:
        started.set()
        await asyncio.Event().wait()

    task = asyncio.create_task(sleeper())
    await started.wait()
    assert await registry.register("run_1", task) is True

    first = await registry.stop("run_1")
    second = await registry.stop("run_1")
    assert first.status == "stopping"
    assert first.task_cancelled is True
    assert second.status == "already_stopped"
    with pytest.raises(asyncio.CancelledError):
        await task
    await registry.finish("run_1", task)


@pytest.mark.asyncio
async def test_stop_endpoint_marks_started_ledger_unknown(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("WORKBENCH_INTERNAL_TOKEN", raising=False)
    monkeypatch.setenv("SEARCH_AGENT_ALLOW_INSECURE_LOOPBACK", "1")
    monkeypatch.setenv("SEARCH_AGENT_HOST", "127.0.0.1")
    registry = RunRegistry()
    ledger = RecordingLedger()
    task = asyncio.create_task(asyncio.Event().wait())
    await registry.register("run_1", task)
    runner = HarnessRunner(HarnessDependencies(
        config=agent_config(),
        graph=NoopGraph(),
        ledger=ledger,
        milvus=None,
        run_registry=registry,
    ))
    request = SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(runner=runner))
    )

    first = await stop_run("run_1", request, None)
    second = await stop_run("run_1", request, None)
    assert first["status"] == "stopping"
    assert second["status"] == "already_stopped"
    assert ledger.unknown_runs == [
        ("run_1", "CANCELLED_OUTCOME_UNKNOWN"),
        ("run_1", "CANCELLED_OUTCOME_UNKNOWN"),
    ]
    with pytest.raises(asyncio.CancelledError):
        await task


@pytest.mark.asyncio
async def test_http_stream_adapter_only_encodes_runner_events() -> None:
    class Runner:
        async def stream(self, request_payload: SearchRunRequest, **kwargs: Any):
            assert request_payload.run_id == "run_1"
            assert callable(kwargs["is_disconnected"])
            yield {
                "version": 1,
                "eventId": "event_1",
                "streamId": "stream_1",
                "streamSeq": 1,
                "seq": 1,
                "type": "run.completed",
                "createdAt": "2026-08-01T00:00:00Z",
                "answerMarkdown": "checkpoint answer",
            }

    class Request:
        app = SimpleNamespace(state=SimpleNamespace(runner=Runner()))

        async def is_disconnected(self) -> bool:
            return False

    stream = _run_stream(Request(), payload(resume=True))
    event = json.loads((await anext(stream)).decode())
    assert event["type"] == "run.completed"
    assert event["answerMarkdown"] == "checkpoint answer"
    await stream.aclose()


@pytest.mark.parametrize("value", ["bad/id", "", "a" * 129])
def test_invalid_run_id_is_rejected(value: str) -> None:
    with pytest.raises(ValueError):
        validate_run_id(value)
