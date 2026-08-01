from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from app.config.agent import agent_config
from app.graph import nodes
from app.graph.context import RunContext
from app.graph.state import initial_state
from app.persistence.tool_ledger import (
    LedgerDecision,
    ToolLedgerSettlement,
    ToolOperationLedger,
    canonical_payload,
    payload_hash,
    safe_result_payload,
)
from app.tools.gateway import ToolGateway
from app.tools.search_tool import SearchExecutionResult, SearchToolInput


class Ledger:
    def __init__(self) -> None:
        self.rows: dict[str, LedgerDecision] = {}

    async def begin(self, **kwargs: Any) -> LedgerDecision:
        key = kwargs["idempotency_key"]
        if key not in self.rows:
            decision = LedgerDecision(
                "execute",
                "started",
                operation_ref=kwargs["operation_ref"],
                attempt=kwargs["attempt"],
                input_hash=kwargs["input_hash"],
            )
            self.rows[key] = decision
            return decision
        decision = self.rows[key]
        if decision.status in {"completed", "failed"}:
            return LedgerDecision(**{**decision.__dict__, "action": "cached"})
        return LedgerDecision(**{
            **decision.__dict__,
            "action": "unknown",
            "error_code": decision.error_code or "OUTCOME_UNKNOWN",
        })

    async def settle(
        self,
        key: str,
        settlement: ToolLedgerSettlement,
    ) -> LedgerDecision:
        current = self.rows[key]
        result = safe_result_payload(settlement.result)
        assert isinstance(result, dict)
        output_hash = payload_hash(result)
        decision = LedgerDecision(
            "cached",
            settlement.status,
            result=result,
            error_code=settlement.error_code,
            operation_ref=current.operation_ref,
            attempt=current.attempt,
            result_ref=f"tool_result_{current.operation_ref[10:]}_{current.attempt}",
            input_hash=current.input_hash,
            output_hash=output_hash,
            provider=settlement.provider,
            outcome_status=settlement.outcome_status,
            retryable=settlement.retryable,
            next_action=settlement.next_action,
            duration_ms=settlement.duration_ms,
            request_count=settlement.request_count,
            result_count=settlement.result_count,
            evidence_count=settlement.evidence_count,
            page_read_count=settlement.page_read_count,
            output_bytes=len(canonical_payload(result)),
            actual_cost_usd=settlement.actual_cost_usd,
        )
        self.rows[key] = decision
        return decision

    async def mark_unknown(
        self,
        key: str,
        error: str,
        *,
        duration_ms: int = 0,
        request_count: int = 0,
        possible_duplicate_cost_usd: str = "0",
    ) -> LedgerDecision:
        current = self.rows[key]
        decision = LedgerDecision(
            "unknown",
            "unknown",
            error_code=error,
            operation_ref=current.operation_ref,
            attempt=current.attempt,
            input_hash=current.input_hash,
            duration_ms=duration_ms,
            request_count=request_count,
            possible_duplicate_cost_usd=possible_duplicate_cost_usd,
        )
        self.rows[key] = decision
        return decision


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


def test_safe_result_payload_removes_inputs_and_private_provider_fields() -> None:
    sanitized = safe_result_payload({
        "query": "完整用户查询",
        "results": [{
            "query": "嵌套查询",
            "title": "公开标题",
            "providerBody": {"cookie": "secret"},
        }],
        "evidence": [{"text": "可持久化的已读取正文", "reasoning_content": "private"}],
        "prompt": "private prompt",
    })

    assert sanitized == {
        "results": [{"title": "公开标题"}],
        "evidence": [{"text": "可持久化的已读取正文"}],
    }


@pytest.mark.asyncio
async def test_completed_tool_operation_is_reused_without_provider_replay(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ledger = Ledger()
    executions = 0
    events: list[dict[str, Any]] = []

    async def execute(
        arguments: SearchToolInput,
        config: Any,
        progress: Any = None,
    ) -> SearchExecutionResult:
        nonlocal executions
        executions += 1
        return SearchExecutionResult(
            ok=True,
            channel=arguments.channel,
            query=arguments.query,
            provider="test",
            results=[],
            evidence=[],
        )

    monkeypatch.setattr(nodes, "execute_search_tool", execute)
    monkeypatch.setattr(nodes, "get_stream_writer", lambda: events.append)
    runtime = SimpleNamespace(
        context=RunContext(agent_config(), ToolGateway(ledger), None)
    )
    arguments = SearchToolInput(query="query one", channel="web", max_results=5)

    _first, first_trace = await nodes._run_one_search(
        state(), runtime, "call_1", arguments
    )
    _second, second_trace = await nodes._run_one_search(
        state(), runtime, "call_1", arguments
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
    assert events[0]["operationRef"] == first_trace["operation_ref"]
    assert events[0]["attempt"] == 1
    assert events[0]["inputHash"] == first_trace["input_hash"]
    assert events[1]["resultRef"] == first_trace["result_ref"]
    assert events[1]["outputHash"] == first_trace["output_hash"]
    assert events[1]["usage"]["calls"] == 1
    assert events[1]["usage"]["actualCostUsd"] is None
    persisted = next(iter(ledger.rows.values())).result
    assert persisted is not None
    assert "query one" not in str(persisted)
    completed_events = [event for event in events if event["type"] == "tool.completed"]
    assert all(isinstance(event["durationMs"], int) for event in completed_events)
    assert all(event["durationMs"] >= 0 for event in completed_events)


@pytest.mark.asyncio
async def test_concurrent_replay_never_duplicates_provider_attempt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ledger = Ledger()
    executions = 0

    async def execute(
        arguments: SearchToolInput,
        config: Any,
        progress: Any = None,
    ) -> SearchExecutionResult:
        nonlocal executions
        executions += 1
        await asyncio.sleep(0.02)
        return SearchExecutionResult(
            ok=True,
            channel=arguments.channel,
            query=arguments.query,
            provider="test",
            results=[],
            evidence=[],
        )

    monkeypatch.setattr(nodes, "execute_search_tool", execute)
    monkeypatch.setattr(nodes, "get_stream_writer", lambda: (lambda event: None))
    runtime = SimpleNamespace(
        context=RunContext(agent_config(), ToolGateway(ledger), None)
    )
    arguments = SearchToolInput(query="query one", channel="web", max_results=5)

    first, second = await asyncio.gather(
        nodes._run_one_search(state(), runtime, "call_concurrent", arguments),
        nodes._run_one_search(state(), runtime, "call_concurrent", arguments),
    )

    assert executions == 1
    assert sorted((first[1]["status"], second[1]["status"])) == [
        "completed",
        "unknown",
    ]
    assert next(iter(ledger.rows.values())).attempt == 1


@pytest.mark.asyncio
async def test_failed_provider_operation_records_elapsed_time(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ledger = Ledger()
    events: list[dict[str, Any]] = []

    async def execute(
        arguments: SearchToolInput,
        config: Any,
        progress: Any = None,
    ) -> SearchExecutionResult:
        await asyncio.sleep(0.02)
        return SearchExecutionResult(
            ok=False,
            channel=arguments.channel,
            query=arguments.query,
            provider="test",
            results=[],
            evidence=[],
            error_code="PROVIDER_UNAVAILABLE",
            error_message="测试渠道不可用",
        )

    monkeypatch.setattr(nodes, "execute_search_tool", execute)
    monkeypatch.setattr(nodes, "get_stream_writer", lambda: events.append)
    runtime = SimpleNamespace(
        context=RunContext(agent_config(), ToolGateway(ledger), None)
    )

    result, trace = await nodes._run_one_search(
        state(),
        runtime,
        "call_failed",
        SearchToolInput(query="query one", channel="web", max_results=5),
    )

    assert result.ok is False
    assert trace["status"] == "failed"
    failed = next(event for event in events if event["type"] == "tool.failed")
    assert failed["durationMs"] >= 10


@pytest.mark.asyncio
async def test_cancellation_marks_inflight_tool_operation_unknown(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ledger = Ledger()
    entered = asyncio.Event()

    async def execute(
        arguments: SearchToolInput,
        config: Any,
        progress: Any = None,
    ) -> SearchExecutionResult:
        entered.set()
        await asyncio.Event().wait()
        raise AssertionError("unreachable")

    monkeypatch.setattr(nodes, "execute_search_tool", execute)
    monkeypatch.setattr(nodes, "get_stream_writer", lambda: (lambda event: None))
    runtime = SimpleNamespace(
        context=RunContext(agent_config(), ToolGateway(ledger), None)
    )
    task = asyncio.create_task(nodes._run_one_search(
        state(), runtime, "call_cancel", SearchToolInput(query="query one", channel="web", max_results=5)
    ))
    await entered.wait()
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task
    cancelled = next(iter(ledger.rows.values()))
    assert cancelled.status == "unknown"
    assert cancelled.error_code == "CANCELLED_OUTCOME_UNKNOWN"


@pytest.mark.asyncio
async def test_cached_status_without_result_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class MissingResultLedger(Ledger):
        async def begin(self, **kwargs: Any) -> LedgerDecision:
            return LedgerDecision(
                "cached",
                "completed",
                operation_ref=kwargs["operation_ref"],
                attempt=kwargs["attempt"],
                input_hash=kwargs["input_hash"],
            )

    executions = 0
    events: list[dict[str, Any]] = []

    async def execute(
        arguments: SearchToolInput,
        config: Any,
        progress: Any = None,
    ) -> SearchExecutionResult:
        nonlocal executions
        executions += 1
        raise AssertionError("provider must not be replayed")

    monkeypatch.setattr(nodes, "execute_search_tool", execute)
    monkeypatch.setattr(nodes, "get_stream_writer", lambda: events.append)
    runtime = SimpleNamespace(
        context=RunContext(
            agent_config(), ToolGateway(MissingResultLedger()), None
        )
    )
    result, trace = await nodes._run_one_search(
        state(), runtime, "call_missing", SearchToolInput(query="query one", channel="web", max_results=5)
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
        async def settle(
            self,
            key: str,
            settlement: ToolLedgerSettlement,
        ) -> LedgerDecision:
            raise RuntimeError("database down")

    async def execute(
        arguments: SearchToolInput,
        config: Any,
        progress: Any = None,
    ) -> SearchExecutionResult:
        return SearchExecutionResult(
            ok=True,
            channel=arguments.channel,
            query=arguments.query,
            provider="test",
            results=[],
            evidence=[],
        )

    events: list[dict[str, Any]] = []
    monkeypatch.setattr(nodes, "execute_search_tool", execute)
    monkeypatch.setattr(nodes, "get_stream_writer", lambda: events.append)
    runtime = SimpleNamespace(
        context=RunContext(
            agent_config(), ToolGateway(SettlementFails()), None
        )
    )
    result, trace = await nodes._run_one_search(
        state(), runtime, "call_settle", SearchToolInput(query="query one", channel="web", max_results=5)
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
            return await super().begin(**kwargs)

    ledger = SlowBegin()
    monkeypatch.setattr(nodes, "get_stream_writer", lambda: (lambda event: None))
    runtime = SimpleNamespace(
        context=RunContext(agent_config(), ToolGateway(ledger), None)
    )
    task = asyncio.create_task(nodes._run_one_search(
        state(), runtime, "call_begin_cancel", SearchToolInput(query="query one", channel="web", max_results=5)
    ))
    await ledger.entered.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    cancelled = next(iter(ledger.rows.values()))
    assert cancelled.status == "unknown"
    assert cancelled.error_code == "CANCELLED_OUTCOME_UNKNOWN"
