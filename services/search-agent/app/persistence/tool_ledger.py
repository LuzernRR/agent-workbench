"""搜索工具的 PostgreSQL 幂等账本。"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from psycopg import Connection
from psycopg.rows import dict_row


@dataclass(frozen=True)
class LedgerDecision:
    action: Literal["execute", "cached", "unknown"]
    status: str
    result: dict[str, Any] | None = None
    error_code: str | None = None


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
        migration = (
            Path(__file__).resolve().parents[4]
            / "database"
            / "migrations"
            / "002_search_agent_runtime.sql"
        )
        sql = migration.read_text(encoding="utf-8")
        with Connection.connect(self.database_url, autocommit=True) as conn:
            conn.execute(sql)

    async def begin(
        self,
        *,
        idempotency_key: str,
        run_id: str,
        tool_call_id: str,
        visitor_id: str,
        project_id: str | None,
        input_hash: str,
    ) -> LedgerDecision:
        if not self.database_url:
            # 真实外部工具在没有持久幂等账本时必须 fail closed；否则进程重启或
            # checkpoint 恢复会盲目重放已经产生费用但结果未知的请求。
            return LedgerDecision(
                action="unknown",
                status="disabled",
                error_code="LEDGER_REQUIRED",
            )
        return await asyncio.to_thread(
            self._begin_sync,
            idempotency_key,
            run_id,
            tool_call_id,
            visitor_id,
            project_id,
            input_hash,
        )

    def _begin_sync(
        self,
        idempotency_key: str,
        run_id: str,
        tool_call_id: str,
        visitor_id: str,
        project_id: str | None,
        input_hash: str,
    ) -> LedgerDecision:
        assert self.database_url
        with Connection.connect(
            self.database_url, autocommit=True, row_factory=dict_row
        ) as conn:
            inserted = conn.execute(
                """
                INSERT INTO search_agent_tool_operations
                  (idempotency_key, run_id, tool_call_id, visitor_id, project_id, input_hash, status)
                VALUES (%s, %s, %s, %s, %s, %s, 'started')
                ON CONFLICT DO NOTHING
                RETURNING status
                """,
                (idempotency_key, run_id, tool_call_id, visitor_id, project_id, input_hash),
            )
            if inserted.fetchone():
                return LedgerDecision(action="execute", status="started")

            existing = conn.execute(
                """
                SELECT status, result, error_code, input_hash, run_id, visitor_id, project_id
                FROM search_agent_tool_operations
                WHERE idempotency_key = %s
                """,
                (idempotency_key,),
            )
            row = existing.fetchone()
            if not row:
                return LedgerDecision(action="unknown", status="unknown")
            if (
                row.get("input_hash") != input_hash
                or row.get("run_id") != run_id
                or row.get("visitor_id") != visitor_id
                or row.get("project_id") != project_id
            ):
                return LedgerDecision(
                    action="unknown",
                    status="scope_mismatch",
                    error_code="LEDGER_SCOPE_MISMATCH",
                )
            result = row.get("result")
            if isinstance(result, str):
                result = json.loads(result)
            if row["status"] in {"completed", "failed"}:
                if not isinstance(result, dict):
                    return LedgerDecision(
                        action="unknown",
                        status=row["status"],
                        error_code="CACHED_RESULT_MISSING",
                    )
                return LedgerDecision(
                    action="cached",
                    status=row["status"],
                    result=result,
                    error_code=row.get("error_code"),
                )
            # started/unknown 可能表示上次在外部请求之后崩溃；不盲重放。
            return LedgerDecision(
                action="unknown",
                status=row["status"],
                result=result if isinstance(result, dict) else None,
                error_code=row.get("error_code") or "OUTCOME_UNKNOWN",
            )

    async def complete(self, idempotency_key: str, result: dict[str, Any]) -> None:
        await self._settle(idempotency_key, "completed", result, None)

    async def fail(
        self, idempotency_key: str, result: dict[str, Any], error_code: str
    ) -> None:
        await self._settle(idempotency_key, "failed", result, error_code)

    async def unknown(self, idempotency_key: str, error_code: str) -> None:
        await self._settle(idempotency_key, "unknown", None, error_code)

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
                SET status = 'unknown', result = NULL, error_code = %s, updated_at = now()
                WHERE run_id = %s AND status = 'started'
                """,
                (error_code, run_id),
            )

    async def _settle(
        self,
        idempotency_key: str,
        status: Literal["completed", "failed", "unknown"],
        result: dict[str, Any] | None,
        error_code: str | None,
    ) -> None:
        if not self.database_url:
            return
        await asyncio.to_thread(
            self._settle_sync, idempotency_key, status, result, error_code
        )

    def _settle_sync(
        self,
        idempotency_key: str,
        status: Literal["completed", "failed", "unknown"],
        result: dict[str, Any] | None,
        error_code: str | None,
    ) -> None:
        assert self.database_url
        with Connection.connect(self.database_url, autocommit=True) as conn:
            conn.execute(
                """
                UPDATE search_agent_tool_operations
                SET status = %s, result = %s::jsonb, error_code = %s, updated_at = now()
                WHERE idempotency_key = %s AND status IN ('started', 'unknown')
                """,
                (
                    status,
                    json.dumps(result, ensure_ascii=False) if result is not None else None,
                    error_code,
                    idempotency_key,
                ),
            )
