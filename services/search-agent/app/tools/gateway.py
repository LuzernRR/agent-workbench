"""显式、可复用的真实工具执行与持久结算边界。"""

from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Protocol

from app.persistence.tool_ledger import LedgerDecision, ToolLedgerSettlement


class GatewayLedger(Protocol):
    async def begin(self, **kwargs: Any) -> LedgerDecision: ...

    async def settle(
        self,
        idempotency_key: str,
        settlement: ToolLedgerSettlement,
    ) -> LedgerDecision: ...

    async def mark_unknown(
        self,
        idempotency_key: str,
        error_code: str,
        *,
        duration_ms: int = 0,
        request_count: int = 0,
        possible_duplicate_cost_usd: str = "0",
    ) -> LedgerDecision: ...


@dataclass(frozen=True)
class ToolGatewayCall:
    run_id: str
    visitor_id: str
    project_id: str | None
    tool_call_id: str
    tool_id: str
    tool_version: str
    input_payload: dict[str, Any]
    plan_step_id: str | None = None
    research_batch_id: str | None = None
    research_result_id: str | None = None
    attempt: int = 1


@dataclass(frozen=True)
class PreparedToolCall:
    run_id: str
    visitor_id: str
    project_id: str | None
    tool_call_id: str
    tool_id: str
    tool_version: str
    plan_step_id: str | None
    research_batch_id: str | None
    research_result_id: str | None
    attempt: int
    input_hash: str
    idempotency_key: str
    operation_ref: str


@dataclass(frozen=True)
class ToolOperationOutcome[T]:
    value: T
    settlement: ToolLedgerSettlement


@dataclass(frozen=True)
class ToolGatewayExecution[T]:
    prepared: PreparedToolCall
    decision: LedgerDecision
    value: T | None
    cached: bool


class ToolGatewayCancelled(asyncio.CancelledError):
    """取消时携带已持久结算的真实工具终态，供事件层先收口再传播。"""

    def __init__(self, execution: ToolGatewayExecution[Any]) -> None:
        super().__init__("tool gateway cancelled")
        self.execution = execution


def _canonical_input(value: dict[str, Any]) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def usage_payload(decision: LedgerDecision, *, tool_id: str, tool_version: str) -> dict[str, Any]:
    """与 contracts/v2 ToolUsage 同语义的安全计量投影。"""

    return {
        "toolId": tool_id,
        "toolVersion": tool_version,
        "provider": decision.provider,
        "pricingVersion": "unpriced-v1",
        "currency": "USD",
        "calls": decision.request_count,
        "attempts": decision.attempt,
        "units": decision.result_count,
        "bytes": decision.output_bytes,
        "resultCount": decision.result_count,
        "searchQueries": decision.request_count,
        "pageReads": decision.page_read_count,
        "estimatedCostUsd": decision.estimated_cost_usd,
        "actualCostUsd": decision.actual_cost_usd,
        "possibleDuplicateCostUsd": decision.possible_duplicate_cost_usd,
    }


class ToolGateway:
    """统一工具身份、幂等恢复、调用 attempt 与终态持久化。"""

    def __init__(self, ledger: GatewayLedger) -> None:
        self._ledger = ledger

    @property
    def ledger(self) -> GatewayLedger:
        return self._ledger

    def prepare(self, call: ToolGatewayCall) -> PreparedToolCall:
        canonical = _canonical_input(call.input_payload)
        input_hash = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        material = "|".join((
            call.run_id,
            call.tool_id,
            call.tool_version,
            call.tool_call_id,
            str(call.attempt),
            input_hash,
        ))
        idempotency_key = hashlib.sha256(material.encode("utf-8")).hexdigest()
        return PreparedToolCall(
            run_id=call.run_id,
            visitor_id=call.visitor_id,
            project_id=call.project_id,
            tool_call_id=call.tool_call_id,
            tool_id=call.tool_id,
            tool_version=call.tool_version,
            plan_step_id=call.plan_step_id,
            research_batch_id=call.research_batch_id,
            research_result_id=call.research_result_id,
            attempt=call.attempt,
            input_hash=input_hash,
            idempotency_key=idempotency_key,
            operation_ref=f"operation_{idempotency_key[:32]}",
        )

    async def invoke[T](
        self,
        prepared: PreparedToolCall,
        operation: Callable[[], Awaitable[ToolOperationOutcome[T]]],
        restore: Callable[[dict[str, Any]], T],
    ) -> ToolGatewayExecution[T]:
        begin_task = asyncio.create_task(self._ledger.begin(
            idempotency_key=prepared.idempotency_key,
            operation_ref=prepared.operation_ref,
            run_id=prepared.run_id,
            tool_call_id=prepared.tool_call_id,
            visitor_id=prepared.visitor_id,
            project_id=prepared.project_id,
            tool_id=prepared.tool_id,
            tool_version=prepared.tool_version,
            plan_step_id=prepared.plan_step_id,
            research_batch_id=prepared.research_batch_id,
            research_result_id=prepared.research_result_id,
            attempt=prepared.attempt,
            input_hash=prepared.input_hash,
        ))
        try:
            decision = await asyncio.shield(begin_task)
        except asyncio.CancelledError:
            await asyncio.shield(asyncio.gather(begin_task, return_exceptions=True))
            if begin_task.cancelled() or begin_task.exception() is not None:
                decision = self._synthetic_unknown(
                    prepared, "LEDGER_UNAVAILABLE"
                )
            else:
                decision = begin_task.result()
            execution = await self._cancelled_after_begin(
                prepared, decision, restore
            )
            raise ToolGatewayCancelled(execution) from None
        except Exception:  # noqa: BLE001 - ledger fail-closed
            return ToolGatewayExecution(
                prepared=prepared,
                decision=self._synthetic_unknown(prepared, "LEDGER_UNAVAILABLE"),
                value=None,
                cached=False,
            )

        if decision.action == "unknown":
            return ToolGatewayExecution(
                prepared=prepared,
                decision=decision,
                value=None,
                cached=False,
            )
        if decision.action == "cached":
            if not decision.result:
                missing = LedgerDecision(
                    action="unknown",
                    status="unknown",
                    error_code="CACHED_RESULT_MISSING",
                    operation_ref=decision.operation_ref,
                    attempt=decision.attempt,
                    input_hash=decision.input_hash,
                    provider=decision.provider,
                    duration_ms=decision.duration_ms,
                )
                return ToolGatewayExecution(prepared, missing, None, True)
            try:
                value = restore(decision.result)
            except Exception:  # noqa: BLE001 - cached payload fail-closed
                invalid = LedgerDecision(
                    action="unknown",
                    status="unknown",
                    error_code="CACHED_RESULT_INVALID",
                    operation_ref=decision.operation_ref,
                    attempt=decision.attempt,
                    input_hash=decision.input_hash,
                    provider=decision.provider,
                    duration_ms=decision.duration_ms,
                )
                return ToolGatewayExecution(prepared, invalid, None, True)
            return ToolGatewayExecution(prepared, decision, value, True)

        try:
            outcome = await operation()
        except asyncio.CancelledError:
            unknown = await self._mark_unknown(
                prepared,
                "CANCELLED_OUTCOME_UNKNOWN",
                request_count=1,
            )
            raise ToolGatewayCancelled(
                ToolGatewayExecution(prepared, unknown, None, False)
            ) from None

        settle_task = asyncio.create_task(
            self._ledger.settle(prepared.idempotency_key, outcome.settlement)
        )
        try:
            settled = await asyncio.shield(settle_task)
        except asyncio.CancelledError:
            await asyncio.shield(asyncio.gather(settle_task, return_exceptions=True))
            if settle_task.cancelled() or settle_task.exception() is not None:
                settled = await self._mark_unknown(
                    prepared,
                    "LEDGER_SETTLEMENT_UNKNOWN",
                    duration_ms=outcome.settlement.duration_ms,
                    request_count=outcome.settlement.request_count,
                )
                value: T | None = None
            else:
                settled = settle_task.result()
                value = outcome.value
            raise ToolGatewayCancelled(
                ToolGatewayExecution(prepared, settled, value, False)
            ) from None
        except Exception:  # noqa: BLE001 - external call happened; no blind retry
            unknown = await self._mark_unknown(
                prepared,
                "LEDGER_SETTLEMENT_UNKNOWN",
                duration_ms=outcome.settlement.duration_ms,
                request_count=outcome.settlement.request_count,
            )
            return ToolGatewayExecution(prepared, unknown, None, False)
        return ToolGatewayExecution(prepared, settled, outcome.value, False)

    async def _cancelled_after_begin[T](
        self,
        prepared: PreparedToolCall,
        decision: LedgerDecision,
        restore: Callable[[dict[str, Any]], T],
    ) -> ToolGatewayExecution[T]:
        if decision.action == "cached" and decision.result:
            try:
                return ToolGatewayExecution(
                    prepared, decision, restore(decision.result), True
                )
            except Exception:  # noqa: BLE001 - cached payload fail-closed
                return ToolGatewayExecution(
                    prepared,
                    self._synthetic_unknown(prepared, "CACHED_RESULT_INVALID"),
                    None,
                    True,
                )
        if decision.action == "execute":
            decision = await self._mark_unknown(
                prepared, "CANCELLED_OUTCOME_UNKNOWN"
            )
        return ToolGatewayExecution(prepared, decision, None, False)

    async def _mark_unknown(
        self,
        prepared: PreparedToolCall,
        error_code: str,
        *,
        duration_ms: int = 0,
        request_count: int = 0,
    ) -> LedgerDecision:
        try:
            return await asyncio.shield(self._ledger.mark_unknown(
                prepared.idempotency_key,
                error_code,
                duration_ms=duration_ms,
                request_count=request_count,
            ))
        except Exception:  # noqa: BLE001 - event still reports persistence uncertainty
            return self._synthetic_unknown(
                prepared, "LEDGER_SETTLEMENT_UNKNOWN", duration_ms, request_count
            )

    @staticmethod
    def _synthetic_unknown(
        prepared: PreparedToolCall,
        error_code: str,
        duration_ms: int = 0,
        request_count: int = 0,
    ) -> LedgerDecision:
        return LedgerDecision(
            action="unknown",
            status="unknown",
            error_code=error_code,
            operation_ref=prepared.operation_ref,
            attempt=prepared.attempt,
            input_hash=prepared.input_hash,
            provider="unknown",
            outcome_status="failed",
            retryable=False,
            next_action="stop",
            duration_ms=max(0, duration_ms),
            request_count=max(0, request_count),
            actual_cost_usd=None,
        )
