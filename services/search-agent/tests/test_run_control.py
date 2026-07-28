from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import HTTPException

from app.api.schemas import SearchRunRequest, validate_run_id
from app.config.agent import agent_config
from app.main import (
    ResumeScopeError,
    _authorize,
    _resolve_graph_input,
    _run_stream,
    stop_run,
)
from app.run_control import RunRegistry


class RecordingLedger:
    def __init__(self) -> None:
        self.unknown_runs: list[tuple[str, str]] = []

    async def unknown_for_run(self, run_id: str, error_code: str) -> None:
        self.unknown_runs.append((run_id, error_code))


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
    })


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
    request = SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(run_registry=registry, ledger=ledger))
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
async def test_resume_uses_existing_checkpoint_without_new_input() -> None:
    class Graph:
        async def aget_state(self, graph_config: dict[str, Any]) -> Any:
            return SimpleNamespace(values={
                "run_id": "run_1",
                "tenant_id": "tenant_1",
                "visitor_id": "visitor_1",
                "project_id": "project_1",
                "thread_id": "thread_1",
                "model_id": "deepseek-v4-flash",
                "answer": "checkpoint",
            })

    result = await _resolve_graph_input(
        Graph(),
        payload(resume=True),
        agent_config(),
        {"configurable": {"thread_id": "run:run_1"}},
    )
    assert result is None


@pytest.mark.asyncio
async def test_resume_rejects_checkpoint_from_another_scope() -> None:
    class Graph:
        async def aget_state(self, graph_config: dict[str, Any]) -> Any:
            return SimpleNamespace(values={
                "run_id": "run_1",
                "tenant_id": "other_tenant",
                "visitor_id": "visitor_1",
                "project_id": "project_1",
                "thread_id": "thread_1",
                "model_id": "deepseek-v4-flash",
            })

    with pytest.raises(ResumeScopeError):
        await _resolve_graph_input(
            Graph(),
            payload(resume=True),
            agent_config(),
            {"configurable": {"thread_id": "run:run_1"}},
        )


@pytest.mark.asyncio
async def test_cancelled_stream_emits_partial_stop_and_marks_unknown() -> None:
    entered = asyncio.Event()

    class Graph:
        async def astream(self, *args: Any, **kwargs: Any):
            entered.set()
            await asyncio.Event().wait()
            yield {"type": "values", "data": {}}

    registry = RunRegistry()
    ledger = RecordingLedger()
    state = SimpleNamespace(
        agent_config=agent_config(),
        graph=Graph(),
        ledger=ledger,
        milvus=None,
        run_registry=registry,
    )

    class Request:
        app = SimpleNamespace(state=state)

        async def is_disconnected(self) -> bool:
            return False

    stream = _run_stream(Request(), payload())
    next_line = asyncio.create_task(anext(stream))
    await entered.wait()
    decision = await registry.stop("run_1")
    assert decision.status == "stopping"
    event = json.loads((await next_line).decode("utf-8"))

    assert event["type"] == "run.stopped"
    assert event["responseStatus"] == "partial"
    assert ledger.unknown_runs == [("run_1", "CANCELLED_OUTCOME_UNKNOWN")]
    await stream.aclose()


@pytest.mark.asyncio
async def test_resume_replays_terminal_event_from_completed_checkpoint() -> None:
    completed = {
        "run_id": "run_1",
        "tenant_id": "tenant_1",
        "visitor_id": "visitor_1",
        "project_id": "project_1",
        "thread_id": "thread_1",
        "model_id": "deepseek-v4-flash",
        "answer": "checkpoint answer",
        "response_status": "completed",
        "citations": [],
        "verification_passed": True,
        "stop_reason": "VERIFIED",
        "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2, "cost_usd": 0.0},
        "model_calls": 1,
        "tool_calls": 1,
        "evidence": [],
    }

    class Graph:
        async def aget_state(self, graph_config: dict[str, Any]) -> Any:
            return SimpleNamespace(values=completed)

        async def astream(self, *args: Any, **kwargs: Any):
            if False:
                yield None

    state = SimpleNamespace(
        agent_config=agent_config(),
        graph=Graph(),
        ledger=RecordingLedger(),
        milvus=None,
        run_registry=RunRegistry(),
    )

    class Request:
        app = SimpleNamespace(state=state)

        async def is_disconnected(self) -> bool:
            return False

    stream = _run_stream(Request(), payload(resume=True))
    event = json.loads((await anext(stream)).decode())
    assert event["type"] == "run.completed"
    assert event["answerMarkdown"] == "checkpoint answer"
    assert event["responseStatus"] == "completed"
    await stream.aclose()


@pytest.mark.parametrize("value", ["bad/id", "", "a" * 129])
def test_invalid_run_id_is_rejected(value: str) -> None:
    with pytest.raises(ValueError):
        validate_run_id(value)
