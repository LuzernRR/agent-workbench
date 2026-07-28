from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any

import pytest
from langgraph.errors import GraphRecursionError

from app.api.schemas import SearchRunRequest
from app.config.agent import agent_config
from app.graph.nodes import budget_reason, route_after_reflect
from app.graph.state import initial_state
from app.main import _run_stream
from app.run_control import RunRegistry


def test_token_cost_model_and_runtime_limits_are_explicit() -> None:
    base = initial_state("q")

    model = dict(base, model_calls=base["max_model_calls"])
    assert budget_reason(model) == "MODEL_CALL_LIMIT"

    token = dict(base, usage={**base["usage"], "total_tokens": base["max_total_tokens"]})
    assert budget_reason(token) == "TOKEN_LIMIT"

    cost = dict(base, usage={**base["usage"], "cost_usd": base["max_cost_usd"]})
    assert budget_reason(cost) == "COST_LIMIT"

    old = (datetime.now(UTC) - timedelta(seconds=base["max_run_seconds"] + 1)).isoformat()
    runtime = dict(base, started_at=old)
    assert budget_reason(runtime) == "RUN_TIMEOUT"


def test_no_progress_and_round_limits_end_research_loop() -> None:
    base = initial_state("q", max_rounds=2, no_progress_limit=2)
    assert route_after_reflect(dict(base, pending_queries=["q2"], no_progress_count=2)) == "compose"
    assert route_after_reflect(dict(base, pending_queries=["q2"], round=2)) == "compose"
    assert route_after_reflect(dict(base, pending_queries=[])) == "compose"


class RecordingLedger:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    async def unknown_for_run(self, run_id: str, code: str) -> None:
        self.calls.append((run_id, code))


def payload(run_id: str) -> SearchRunRequest:
    return SearchRunRequest.model_validate({
        "version": 1,
        "runId": run_id,
        "tenantId": "tenant_1",
        "visitorId": "visitor_1",
        "projectId": "project_1",
        "threadId": "thread_1",
        "question": "q",
        "modelId": "deepseek-v4-flash",
        "reasoningEffort": "high",
    })


class Request:
    def __init__(self, graph: Any, ledger: RecordingLedger) -> None:
        self.app = SimpleNamespace(state=SimpleNamespace(
            agent_config=agent_config(),
            graph=graph,
            ledger=ledger,
            milvus=None,
            run_registry=RunRegistry(),
        ))

    async def is_disconnected(self) -> bool:
        return False


@pytest.mark.asyncio
async def test_graph_recursion_error_becomes_stable_public_event() -> None:
    class Graph:
        async def astream(self, *args: Any, **kwargs: Any):
            raise GraphRecursionError("limit")
            yield  # pragma: no cover

    stream = _run_stream(Request(Graph(), RecordingLedger()), payload("run_recursion"))
    event = json.loads((await anext(stream)).decode())
    assert event["type"] == "run.failed"
    assert event["reasonCode"] == "RECURSION_LIMIT"
    await stream.aclose()


@pytest.mark.asyncio
async def test_timeout_marks_ledger_unknown_and_emits_stable_event() -> None:
    class Graph:
        async def astream(self, *args: Any, **kwargs: Any):
            raise TimeoutError
            yield  # pragma: no cover

    ledger = RecordingLedger()
    stream = _run_stream(Request(Graph(), ledger), payload("run_timeout"))
    event = json.loads((await anext(stream)).decode())
    assert event["type"] == "run.failed"
    assert event["reasonCode"] == "RUN_TIMEOUT"
    assert ledger.calls == [("run_timeout", "RUN_TIMEOUT_OUTCOME_UNKNOWN")]
    await stream.aclose()
