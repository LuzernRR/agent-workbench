from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from app.config.agent import agent_config
from app.graph import nodes
from app.graph.context import RunContext
from app.graph.state import initial_state
from app.persistence.tool_ledger import LedgerDecision, ToolOperationLedger
from app.tools.search_tool import SearchExecutionResult, SearchToolInput


class Ledger:
    def __init__(self) -> None:
        self.rows: dict[str, tuple[str, dict[str, Any] | None, str | None]] = {}

    async def begin(self, **kwargs: Any) -> LedgerDecision:
        key = kwargs["idempotency_key"]
        if key not in self.rows:
            self.rows[key] = ("started", None, None)
            return LedgerDecision("execute", "started")
        status, result, error = self.rows[key]
        if status in {"completed", "failed"}:
            return LedgerDecision("cached", status, result, error)
        return LedgerDecision("unknown", status, result, error or "OUTCOME_UNKNOWN")

    async def complete(self, key: str, result: dict[str, Any]) -> None:
        self.rows[key] = ("completed", result, None)

    async def fail(self, key: str, result: dict[str, Any], error: str) -> None:
        self.rows[key] = ("failed", result, error)

    async def unknown(self, key: str, error: str) -> None:
        self.rows[key] = ("unknown", None, error)


def state() -> dict[str, Any]:
    return initial_state(
        "question",
        run_id="run_idempotent",
        visitor_id="visitor_1",
        project_id="project_1",
    )


@pytest.mark.asyncio
async def test_real_tool_ledger_fails_closed_without_postgres() -> None:
    decision = await ToolOperationLedger(None).begin(
        idempotency_key="key",
        run_id="run",
        tool_call_id="call",
        visitor_id="visitor",
        project_id="project",
        input_hash="hash",
    )
    assert decision.action == "unknown"
    assert decision.error_code == "LEDGER_REQUIRED"


@pytest.mark.asyncio
async def test_completed_tool_operation_is_reused_without_provider_replay(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ledger = Ledger()
    executions = 0
    events: list[dict[str, Any]] = []

    async def execute(arguments: SearchToolInput, config: Any) -> SearchExecutionResult:
        nonlocal executions
        executions += 1
        return SearchExecutionResult(
            ok=True,
            query=arguments.query,
            provider="test",
            results=[],
            evidence=[],
        )

    monkeypatch.setattr(nodes, "execute_search_tool", execute)
    monkeypatch.setattr(nodes, "get_stream_writer", lambda: events.append)
    runtime = SimpleNamespace(context=RunContext(agent_config(), ledger, None))
    arguments = SearchToolInput(query="query one", max_results=5)

    _first, first_trace = await nodes._run_one_search(
        state(), runtime, "call_1", arguments
    )
    _second, second_trace = await nodes._run_one_search(
        state(), runtime, "call_2", arguments
    )

    assert executions == 1
    assert first_trace["status"] == "completed"
    assert second_trace["status"] == "cached"
    assert [event["type"] for event in events] == [
        "tool.started",
        "tool.completed",
        "tool.started",
        "tool.completed",
    ]
    assert events[-1]["cached"] is True


@pytest.mark.asyncio
async def test_cancellation_marks_inflight_tool_operation_unknown(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ledger = Ledger()
    entered = asyncio.Event()

    async def execute(arguments: SearchToolInput, config: Any) -> SearchExecutionResult:
        entered.set()
        await asyncio.Event().wait()
        raise AssertionError("unreachable")

    monkeypatch.setattr(nodes, "execute_search_tool", execute)
    monkeypatch.setattr(nodes, "get_stream_writer", lambda: (lambda event: None))
    runtime = SimpleNamespace(context=RunContext(agent_config(), ledger, None))
    task = asyncio.create_task(nodes._run_one_search(
        state(), runtime, "call_cancel", SearchToolInput(query="query one", max_results=5)
    ))
    await entered.wait()
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task
    assert next(iter(ledger.rows.values())) == (
        "unknown",
        None,
        "CANCELLED_OUTCOME_UNKNOWN",
    )


@pytest.mark.asyncio
async def test_cached_status_without_result_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class MissingResultLedger(Ledger):
        async def begin(self, **kwargs: Any) -> LedgerDecision:
            return LedgerDecision("cached", "completed", None, None)

    executions = 0
    events: list[dict[str, Any]] = []

    async def execute(arguments: SearchToolInput, config: Any) -> SearchExecutionResult:
        nonlocal executions
        executions += 1
        raise AssertionError("provider must not be replayed")

    monkeypatch.setattr(nodes, "execute_search_tool", execute)
    monkeypatch.setattr(nodes, "get_stream_writer", lambda: events.append)
    runtime = SimpleNamespace(
        context=RunContext(agent_config(), MissingResultLedger(), None)
    )
    result, trace = await nodes._run_one_search(
        state(), runtime, "call_missing", SearchToolInput(query="query one", max_results=5)
    )

    assert executions == 0
    assert result.error_code == "CACHED_RESULT_MISSING"
    assert trace["status"] == "unknown"
    assert [event["type"] for event in events] == ["tool.started", "tool.unknown"]


@pytest.mark.asyncio
async def test_ledger_settlement_failure_closes_tool_as_unknown(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class SettlementFails(Ledger):
        async def complete(self, key: str, result: dict[str, Any]) -> None:
            raise RuntimeError("database down")

    async def execute(arguments: SearchToolInput, config: Any) -> SearchExecutionResult:
        return SearchExecutionResult(
            ok=True,
            query=arguments.query,
            provider="test",
            results=[],
            evidence=[],
        )

    events: list[dict[str, Any]] = []
    monkeypatch.setattr(nodes, "execute_search_tool", execute)
    monkeypatch.setattr(nodes, "get_stream_writer", lambda: events.append)
    runtime = SimpleNamespace(context=RunContext(agent_config(), SettlementFails(), None))
    result, trace = await nodes._run_one_search(
        state(), runtime, "call_settle", SearchToolInput(query="query one", max_results=5)
    )
    assert result.error_code == "LEDGER_SETTLEMENT_UNKNOWN"
    assert trace["status"] == "unknown"
    assert [event["type"] for event in events] == ["tool.started", "tool.unknown"]


@pytest.mark.asyncio
async def test_cancellation_during_ledger_begin_waits_then_marks_unknown(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class SlowBegin(Ledger):
        entered = asyncio.Event()

        async def begin(self, **kwargs: Any) -> LedgerDecision:
            self.entered.set()
            await asyncio.sleep(0.02)
            self.rows[kwargs["idempotency_key"]] = ("started", None, None)
            return LedgerDecision("execute", "started")

    ledger = SlowBegin()
    monkeypatch.setattr(nodes, "get_stream_writer", lambda: (lambda event: None))
    runtime = SimpleNamespace(context=RunContext(agent_config(), ledger, None))
    task = asyncio.create_task(nodes._run_one_search(
        state(), runtime, "call_begin_cancel", SearchToolInput(query="query one", max_results=5)
    ))
    await ledger.entered.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert next(iter(ledger.rows.values())) == (
        "unknown",
        None,
        "CANCELLED_OUTCOME_UNKNOWN",
    )
