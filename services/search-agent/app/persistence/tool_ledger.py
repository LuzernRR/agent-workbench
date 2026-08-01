"""搜索工具的 PostgreSQL 幂等账本。

账本只保存调用身份、哈希、引用、计数和稳定结算状态。可重放的安全工具
结果单独存入 ``search_agent_tool_results``，并在写入前递归移除 query、Prompt、
凭据和 Provider 原始字段。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Literal

from psycopg import Connection
from psycopg.rows import dict_row

_PRIVATE_RESULT_KEYS = frozenset({
    "authorization",
    "apikey",
    "cookie",
    "headers",
    "messages",
    "prompt",
    "providerbody",
    "query",
    "rawrequest",
    "rawresponse",
    "reasoning",
    "reasoningcontent",
    "token",
    "toolarguments",
})


def _normalized_key(value: object) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value).lower())


def safe_result_payload(value: Any) -> Any:
    """移除不应进入持久工具结果的输入正文和私有 Provider 字段。"""

    if isinstance(value, dict):
        return {
            str(key): safe_result_payload(child)
            for key, child in value.items()
            if _normalized_key(key) not in _PRIVATE_RESULT_KEYS
        }
    if isinstance(value, list):
        return [safe_result_payload(child) for child in value]
    return value


def canonical_payload(value: dict[str, Any]) -> bytes:
    return json.dumps(
        safe_result_payload(value),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def payload_hash(value: dict[str, Any]) -> str:
    return hashlib.sha256(canonical_payload(value)).hexdigest()


def _money_text(value: object) -> str:
    try:
        amount = Decimal(str(value or 0))
    except (InvalidOperation, ValueError):
        return "0"
    if amount < 0:
        return "0"
    rendered = format(amount, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    return rendered or "0"


@dataclass(frozen=True)
class LedgerDecision:
    action: Literal["execute", "cached", "unknown"]
    status: str
    result: dict[str, Any] | None = None
    error_code: str | None = None
    operation_ref: str = ""
    attempt: int = 1
    result_ref: str | None = None
    input_hash: str = ""
    output_hash: str | None = None
    provider: str = "unknown"
    outcome_status: str | None = None
    retryable: bool = False
    next_action: str = "stop"
    duration_ms: int = 0
    request_count: int = 0
    result_count: int = 0
    evidence_count: int = 0
    page_read_count: int = 0
    output_bytes: int = 0
    estimated_cost_usd: str = "0"
    actual_cost_usd: str | None = None
    possible_duplicate_cost_usd: str = "0"


@dataclass(frozen=True)
class ToolLedgerSettlement:
    status: Literal["completed", "failed"]
    result: dict[str, Any]
    provider: str
    outcome_status: Literal["success", "degraded", "failed"]
    error_code: str | None
    retryable: bool
    next_action: str
    duration_ms: int
    request_count: int
    result_count: int
    evidence_count: int
    page_read_count: int
    estimated_cost_usd: str = "0"
    actual_cost_usd: str | None = None
    possible_duplicate_cost_usd: str = "0"


class LedgerSettlementConflict(RuntimeError):
    """同一逻辑调用出现互相冲突的持久终态。"""


class ToolOperationLedger:
    """工具恢复时先查账本，禁止盲目重复产生搜索费用。"""

    def __init__(self, database_url: str | None) -> None:
        self.database_url = database_url

    @property
    def enabled(self) -> bool:
        return bool(self.database_url)

    async def setup(self) -> None:
        if not self.database_url:
            return
        await asyncio.to_thread(self._setup_sync)

    def _setup_sync(self) -> None:
        assert self.database_url
        migrations = Path(__file__).resolve().parents[4] / "database" / "migrations"
        with Connection.connect(self.database_url, autocommit=True) as conn:
            for name in ("002_search_agent_runtime.sql", "003_tool_gateway_ledger.sql"):
                conn.execute((migrations / name).read_text(encoding="utf-8"))
        self._backfill_legacy_results_sync()

    def _backfill_legacy_results_sync(self) -> None:
        """把旧表内联结果迁移到引用表，并清除 query 等输入正文。"""

        assert self.database_url
        with Connection.connect(
            self.database_url, row_factory=dict_row
        ) as conn:
            rows = conn.execute(
                """
                SELECT idempotency_key, operation_ref, run_id, tool_call_id,
                       visitor_id, project_id, attempt, result
                FROM search_agent_tool_operations
                WHERE result IS NOT NULL AND result_ref IS NULL
                FOR UPDATE
                """
            ).fetchall()
            for row in rows:
                raw = row["result"]
                if isinstance(raw, str):
                    raw = json.loads(raw)
                if not isinstance(raw, dict):
                    continue
                result = safe_result_payload(raw)
                if not isinstance(result, dict):
                    continue
                encoded = canonical_payload(result)
                output_hash = hashlib.sha256(encoded).hexdigest()
                result_ref = (
                    f"tool_result_{row['operation_ref'].removeprefix('operation_')}"
                    f"_{row['attempt']}"
                )
                conn.execute(
                    """
                    INSERT INTO search_agent_tool_results
                      (result_ref, run_id, tool_call_id, visitor_id, project_id,
                       attempt, output_hash, payload)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s::jsonb)
                    ON CONFLICT (result_ref) DO NOTHING
                    """,
                    (
                        result_ref,
                        row["run_id"],
                        row["tool_call_id"],
                        row["visitor_id"],
                        row["project_id"],
                        row["attempt"],
                        output_hash,
                        encoded.decode("utf-8"),
                    ),
                )
                conn.execute(
                    """
                    UPDATE search_agent_tool_operations
                    SET result = NULL, result_ref = %s, output_hash = %s,
                        output_bytes = %s
                    WHERE idempotency_key = %s
                    """,
                    (result_ref, output_hash, len(encoded), row["idempotency_key"]),
                )
            conn.commit()

    async def begin(
        self,
        *,
        idempotency_key: str,
        run_id: str,
        tool_call_id: str,
        visitor_id: str,
        project_id: str | None,
        input_hash: str,
        operation_ref: str | None = None,
        tool_id: str = "web_search",
        tool_version: str = "1",
        plan_step_id: str | None = None,
        research_batch_id: str | None = None,
        research_result_id: str | None = None,
        attempt: int = 1,
    ) -> LedgerDecision:
        operation_ref = operation_ref or f"operation_{idempotency_key[:32]}"
        if not self.database_url:
            return LedgerDecision(
                action="unknown",
                status="disabled",
                error_code="LEDGER_REQUIRED",
                operation_ref=operation_ref,
                attempt=attempt,
                input_hash=input_hash,
            )
        return await asyncio.to_thread(
            self._begin_sync,
            idempotency_key,
            run_id,
            tool_call_id,
            visitor_id,
            project_id,
            input_hash,
            operation_ref,
            tool_id,
            tool_version,
            plan_step_id,
            research_batch_id,
            research_result_id,
            attempt,
        )

    def _begin_sync(
        self,
        idempotency_key: str,
        run_id: str,
        tool_call_id: str,
        visitor_id: str,
        project_id: str | None,
        input_hash: str,
        operation_ref: str,
        tool_id: str,
        tool_version: str,
        plan_step_id: str | None,
        research_batch_id: str | None,
        research_result_id: str | None,
        attempt: int,
    ) -> LedgerDecision:
        assert self.database_url
        with Connection.connect(
            self.database_url, autocommit=True, row_factory=dict_row
        ) as conn:
            inserted = conn.execute(
                """
                INSERT INTO search_agent_tool_operations
                  (idempotency_key, operation_ref, run_id, tool_call_id,
                   visitor_id, project_id, tool_id, tool_version, plan_step_id,
                   research_batch_id, research_result_id, attempt, input_hash,
                   status, started_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                        'started', now())
                ON CONFLICT DO NOTHING
                RETURNING status
                """,
                (
                    idempotency_key,
                    operation_ref,
                    run_id,
                    tool_call_id,
                    visitor_id,
                    project_id,
                    tool_id,
                    tool_version,
                    plan_step_id,
                    research_batch_id,
                    research_result_id,
                    attempt,
                    input_hash,
                ),
            )
            if inserted.fetchone():
                return LedgerDecision(
                    action="execute",
                    status="started",
                    operation_ref=operation_ref,
                    attempt=attempt,
                    input_hash=input_hash,
                )

            row = conn.execute(
                """
                SELECT operation.status, operation.error_code,
                       operation.operation_ref, operation.attempt,
                       operation.result_ref, operation.input_hash,
                       operation.output_hash, operation.provider,
                       operation.outcome_status, operation.retryable,
                       operation.next_action, operation.duration_ms,
                       operation.request_count, operation.result_count,
                       operation.evidence_count, operation.page_read_count,
                       operation.output_bytes, operation.estimated_cost_usd,
                       operation.actual_cost_usd,
                       operation.possible_duplicate_cost_usd,
                       operation.run_id, operation.tool_call_id,
                       operation.visitor_id, operation.project_id,
                       result.payload AS result_payload
                FROM search_agent_tool_operations operation
                LEFT JOIN search_agent_tool_results result
                  ON result.result_ref = operation.result_ref
                WHERE operation.idempotency_key = %s
                """,
                (idempotency_key,),
            ).fetchone()
            if not row:
                return LedgerDecision(
                    action="unknown",
                    status="unknown",
                    error_code="OUTCOME_UNKNOWN",
                    operation_ref=operation_ref,
                    attempt=attempt,
                    input_hash=input_hash,
                )
            if (
                row.get("input_hash") != input_hash
                or row.get("run_id") != run_id
                or row.get("tool_call_id") != tool_call_id
                or row.get("visitor_id") != visitor_id
                or row.get("project_id") != project_id
                or row.get("operation_ref") != operation_ref
                or row.get("attempt") != attempt
            ):
                return LedgerDecision(
                    action="unknown",
                    status="scope_mismatch",
                    error_code="LEDGER_SCOPE_MISMATCH",
                    operation_ref=operation_ref,
                    attempt=attempt,
                    input_hash=input_hash,
                )
            result = row.get("result_payload")
            if isinstance(result, str):
                result = json.loads(result)
            common = {
                "operation_ref": row["operation_ref"],
                "attempt": row["attempt"],
                "result_ref": row.get("result_ref"),
                "input_hash": row["input_hash"],
                "output_hash": row.get("output_hash"),
                "provider": row.get("provider") or "unknown",
                "outcome_status": row.get("outcome_status"),
                "retryable": bool(row.get("retryable")),
                "next_action": row.get("next_action") or "stop",
                "duration_ms": row.get("duration_ms") or 0,
                "request_count": row.get("request_count") or 0,
                "result_count": row.get("result_count") or 0,
                "evidence_count": row.get("evidence_count") or 0,
                "page_read_count": row.get("page_read_count") or 0,
                "output_bytes": row.get("output_bytes") or 0,
                "estimated_cost_usd": _money_text(row.get("estimated_cost_usd")),
                "actual_cost_usd": (
                    _money_text(row["actual_cost_usd"])
                    if row.get("actual_cost_usd") is not None
                    else None
                ),
                "possible_duplicate_cost_usd": _money_text(
                    row.get("possible_duplicate_cost_usd")
                ),
            }
            if row["status"] in {"completed", "failed"}:
                if not isinstance(result, dict):
                    return LedgerDecision(
                        action="unknown",
                        status=row["status"],
                        error_code="CACHED_RESULT_MISSING",
                        **common,
                    )
                return LedgerDecision(
                    action="cached",
                    status=row["status"],
                    result=result,
                    error_code=row.get("error_code"),
                    **common,
                )
            return LedgerDecision(
                action="unknown",
                status=row["status"],
                result=result if isinstance(result, dict) else None,
                error_code=row.get("error_code") or "OUTCOME_UNKNOWN",
                **common,
            )

    async def settle(
        self,
        idempotency_key: str,
        settlement: ToolLedgerSettlement,
    ) -> LedgerDecision:
        if not self.database_url:
            raise RuntimeError("tool ledger is disabled")
        return await asyncio.to_thread(
            self._settle_sync, idempotency_key, settlement
        )

    def _settle_sync(
        self,
        idempotency_key: str,
        settlement: ToolLedgerSettlement,
    ) -> LedgerDecision:
        assert self.database_url
        result = safe_result_payload(settlement.result)
        if not isinstance(result, dict):
            raise TypeError("tool result must be an object")
        encoded = canonical_payload(result)
        output_hash = hashlib.sha256(encoded).hexdigest()
        with Connection.connect(
            self.database_url, row_factory=dict_row
        ) as conn:
            operation = conn.execute(
                """
                SELECT operation_ref, run_id, tool_call_id, visitor_id,
                       project_id, attempt, input_hash, status, output_hash
                FROM search_agent_tool_operations
                WHERE idempotency_key = %s
                FOR UPDATE
                """,
                (idempotency_key,),
            ).fetchone()
            if not operation:
                raise LedgerSettlementConflict("tool operation is missing")
            result_ref = (
                f"tool_result_{operation['operation_ref'].removeprefix('operation_')}"
                f"_{operation['attempt']}"
            )
            if operation["status"] in {"completed", "failed"}:
                if (
                    operation["status"] == settlement.status
                    and operation.get("output_hash") == output_hash
                ):
                    conn.commit()
                    return LedgerDecision(
                        action="cached",
                        status=operation["status"],
                        result=result,
                        error_code=settlement.error_code,
                        operation_ref=operation["operation_ref"],
                        attempt=operation["attempt"],
                        result_ref=result_ref,
                        input_hash=operation["input_hash"],
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
                        output_bytes=len(encoded),
                        estimated_cost_usd=settlement.estimated_cost_usd,
                        actual_cost_usd=settlement.actual_cost_usd,
                        possible_duplicate_cost_usd=(
                            settlement.possible_duplicate_cost_usd
                        ),
                    )
                raise LedgerSettlementConflict("tool operation terminal conflict")
            if operation["status"] != "started":
                raise LedgerSettlementConflict("tool operation is no longer active")
            conn.execute(
                """
                INSERT INTO search_agent_tool_results
                  (result_ref, run_id, tool_call_id, visitor_id, project_id,
                   attempt, output_hash, payload)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s::jsonb)
                ON CONFLICT (result_ref) DO NOTHING
                """,
                (
                    result_ref,
                    operation["run_id"],
                    operation["tool_call_id"],
                    operation["visitor_id"],
                    operation["project_id"],
                    operation["attempt"],
                    output_hash,
                    encoded.decode("utf-8"),
                ),
            )
            stored = conn.execute(
                """
                SELECT output_hash, run_id, tool_call_id, visitor_id, project_id,
                       attempt
                FROM search_agent_tool_results
                WHERE result_ref = %s
                """,
                (result_ref,),
            ).fetchone()
            if not stored or any((
                stored["output_hash"] != output_hash,
                stored["run_id"] != operation["run_id"],
                stored["tool_call_id"] != operation["tool_call_id"],
                stored["visitor_id"] != operation["visitor_id"],
                stored["project_id"] != operation["project_id"],
                stored["attempt"] != operation["attempt"],
            )):
                raise LedgerSettlementConflict("tool result reference conflict")
            updated = conn.execute(
                """
                UPDATE search_agent_tool_operations
                SET status = %s, result = NULL, error_code = %s,
                    provider = %s, output_hash = %s, result_ref = %s,
                    outcome_status = %s, retryable = %s, next_action = %s,
                    duration_ms = %s, request_count = %s, result_count = %s,
                    evidence_count = %s, page_read_count = %s,
                    output_bytes = %s, estimated_cost_usd = %s,
                    actual_cost_usd = %s, possible_duplicate_cost_usd = %s,
                    completed_at = now(), updated_at = now()
                WHERE idempotency_key = %s AND status = 'started'
                """,
                (
                    settlement.status,
                    settlement.error_code,
                    settlement.provider,
                    output_hash,
                    result_ref,
                    settlement.outcome_status,
                    settlement.retryable,
                    settlement.next_action,
                    settlement.duration_ms,
                    settlement.request_count,
                    settlement.result_count,
                    settlement.evidence_count,
                    settlement.page_read_count,
                    len(encoded),
                    settlement.estimated_cost_usd,
                    settlement.actual_cost_usd,
                    settlement.possible_duplicate_cost_usd,
                    idempotency_key,
                ),
            )
            if updated.rowcount != 1:
                raise LedgerSettlementConflict("tool operation settlement lost race")
            conn.commit()
        return LedgerDecision(
            action="cached",
            status=settlement.status,
            result=result,
            error_code=settlement.error_code,
            operation_ref=operation["operation_ref"],
            attempt=operation["attempt"],
            result_ref=result_ref,
            input_hash=operation["input_hash"],
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
            output_bytes=len(encoded),
            estimated_cost_usd=settlement.estimated_cost_usd,
            actual_cost_usd=settlement.actual_cost_usd,
            possible_duplicate_cost_usd=settlement.possible_duplicate_cost_usd,
        )

    async def mark_unknown(
        self,
        idempotency_key: str,
        error_code: str,
        *,
        duration_ms: int = 0,
        request_count: int = 0,
        possible_duplicate_cost_usd: str = "0",
    ) -> LedgerDecision:
        if not self.database_url:
            return LedgerDecision(
                action="unknown", status="disabled", error_code=error_code
            )
        return await asyncio.to_thread(
            self._mark_unknown_sync,
            idempotency_key,
            error_code,
            duration_ms,
            request_count,
            possible_duplicate_cost_usd,
        )

    def _mark_unknown_sync(
        self,
        idempotency_key: str,
        error_code: str,
        duration_ms: int,
        request_count: int,
        possible_duplicate_cost_usd: str,
    ) -> LedgerDecision:
        assert self.database_url
        with Connection.connect(
            self.database_url, autocommit=True, row_factory=dict_row
        ) as conn:
            row = conn.execute(
                """
                UPDATE search_agent_tool_operations
                SET status = 'unknown', result = NULL, result_ref = NULL,
                    output_hash = NULL, error_code = %s, outcome_status = 'failed',
                    retryable = false, next_action = 'stop', duration_ms = %s,
                    request_count = GREATEST(request_count, %s),
                    actual_cost_usd = NULL,
                    possible_duplicate_cost_usd = %s,
                    completed_at = now(), updated_at = now()
                WHERE idempotency_key = %s AND status = 'started'
                RETURNING operation_ref, attempt, input_hash, provider,
                          duration_ms, request_count, result_count,
                          evidence_count, page_read_count, output_bytes,
                          estimated_cost_usd, possible_duplicate_cost_usd
                """,
                (
                    error_code,
                    max(0, duration_ms),
                    max(0, request_count),
                    possible_duplicate_cost_usd,
                    idempotency_key,
                ),
            ).fetchone()
            if not row:
                row = conn.execute(
                    """
                    SELECT operation_ref, attempt, input_hash, provider,
                           duration_ms, request_count, result_count,
                           evidence_count, page_read_count, output_bytes,
                           estimated_cost_usd, possible_duplicate_cost_usd,
                           status, error_code
                    FROM search_agent_tool_operations
                    WHERE idempotency_key = %s
                    """,
                    (idempotency_key,),
                ).fetchone()
            if not row:
                raise LedgerSettlementConflict("tool operation is missing")
            if row.get("status") in {"completed", "failed"}:
                raise LedgerSettlementConflict("tool operation already settled")
            return LedgerDecision(
                action="unknown",
                status="unknown",
                error_code=row.get("error_code") or error_code,
                operation_ref=row["operation_ref"],
                attempt=row["attempt"],
                input_hash=row["input_hash"],
                provider=row.get("provider") or "unknown",
                outcome_status="failed",
                retryable=False,
                next_action="stop",
                duration_ms=row.get("duration_ms") or 0,
                request_count=row.get("request_count") or 0,
                result_count=row.get("result_count") or 0,
                evidence_count=row.get("evidence_count") or 0,
                page_read_count=row.get("page_read_count") or 0,
                output_bytes=row.get("output_bytes") or 0,
                estimated_cost_usd=_money_text(row.get("estimated_cost_usd")),
                actual_cost_usd=None,
                possible_duplicate_cost_usd=_money_text(
                    row.get("possible_duplicate_cost_usd")
                ),
            )

    async def complete(self, idempotency_key: str, result: dict[str, Any]) -> None:
        """兼容旧测试/调用；生产代码使用 ``ToolGateway``。"""

        await self.settle(
            idempotency_key,
            ToolLedgerSettlement(
                status="completed",
                result=result,
                provider="unknown",
                outcome_status="success",
                error_code=None,
                retryable=False,
                next_action="stop",
                duration_ms=0,
                request_count=1,
                result_count=0,
                evidence_count=0,
                page_read_count=0,
            ),
        )

    async def fail(
        self, idempotency_key: str, result: dict[str, Any], error_code: str
    ) -> None:
        """兼容旧测试/调用；生产代码使用 ``ToolGateway``。"""

        await self.settle(
            idempotency_key,
            ToolLedgerSettlement(
                status="failed",
                result=result,
                provider="unknown",
                outcome_status="failed",
                error_code=error_code,
                retryable=False,
                next_action="stop",
                duration_ms=0,
                request_count=1,
                result_count=0,
                evidence_count=0,
                page_read_count=0,
            ),
        )

    async def unknown(self, idempotency_key: str, error_code: str) -> None:
        await self.mark_unknown(idempotency_key, error_code)

    async def unknown_for_run(self, run_id: str, error_code: str) -> None:
        """把一次取消运行中尚未结算的外部调用统一标为结果未知。"""

        if not self.database_url:
            return
        await asyncio.to_thread(self._unknown_for_run_sync, run_id, error_code)

    def _unknown_for_run_sync(self, run_id: str, error_code: str) -> None:
        assert self.database_url
        with Connection.connect(self.database_url, autocommit=True) as conn:
            conn.execute(
                """
                UPDATE search_agent_tool_operations
                SET status = 'unknown', result = NULL, result_ref = NULL,
                    output_hash = NULL, error_code = %s,
                    outcome_status = 'failed', retryable = false,
                    next_action = 'stop', actual_cost_usd = NULL,
                    completed_at = now(), updated_at = now()
                WHERE run_id = %s AND status = 'started'
                """,
                (error_code, run_id),
            )
