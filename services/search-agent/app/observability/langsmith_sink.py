"""可选的 LangSmith span 导出。

仅在显式配置 `SEARCH_AGENT_LANGSMITH_ENABLED` 且 `LANGSMITH_API_KEY` 存在时启用。
导出内容限于已通过隐私门控的 span attributes：不含 Prompt、Provider 报文、
推理过程、问题原文、Cookie 或任何密钥。任何导出故障都被吞掉并计数，
绝不影响 run 本身。
"""

from __future__ import annotations

import os
import uuid
from datetime import datetime
from typing import Any

from app.observability.span import Span

# LangSmith run 需要 UUID；用固定命名空间把 span_id 稳定映射过去。
_NAMESPACE = uuid.UUID("6f1d4d4e-6d1a-5f3b-9c2e-6a1b7d8e9f01")

_RUN_TYPE_BY_KIND = {
    "run": "chain",
    "node": "chain",
    "tool": "tool",
    "model": "llm",
}


def _run_uuid(span_id: str) -> uuid.UUID:
    return uuid.uuid5(_NAMESPACE, span_id)


def _parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


class LangSmithSink:
    """把已完成 span 推送到 LangSmith；失败降级为计数。"""

    def __init__(self, client: Any, *, project_name: str) -> None:
        self._client = client
        self._project_name = project_name
        self._error_count = 0
        self._exported_count = 0

    @property
    def error_count(self) -> int:
        return self._error_count

    @property
    def exported_count(self) -> int:
        return self._exported_count

    def emit(self, span: Span) -> None:
        try:
            self._client.create_run(
                name=span.name,
                # 输入侧一律为空：问题原文与 Prompt 不得离开本进程。
                inputs={},
                run_type=_RUN_TYPE_BY_KIND.get(span.kind, "chain"),
                run_id=_run_uuid(span.span_id),
                parent_run_id=(
                    _run_uuid(span.parent_span_id) if span.parent_span_id else None
                ),
                trace_id=_run_uuid(span.trace_id),
                project_name=self._project_name,
                start_time=_parse_time(span.started_at),
                end_time=_parse_time(span.ended_at),
                outputs={"status": span.status, **span.attributes},
                extra={"metadata": {"spanKind": span.kind, "traceRef": span.trace_id}},
                events=list(span.events),
                error=span.status if span.status == "error" else None,
            )
            self._exported_count += 1
        except Exception:  # noqa: BLE001 - 导出故障不得影响运行
            self._error_count += 1

    def flush(self) -> None:
        try:
            flusher = getattr(self._client, "flush", None)
            if callable(flusher):
                flusher()
        except Exception:  # noqa: BLE001
            self._error_count += 1


def langsmith_sink_from_env() -> LangSmithSink | None:
    """未显式开启或依赖缺失时返回 None，保持 fail-safe off。"""
    enabled = os.environ.get("SEARCH_AGENT_LANGSMITH_ENABLED", "").lower() in {
        "1",
        "true",
        "yes",
    }
    if not enabled:
        return None
    if not os.environ.get("LANGSMITH_API_KEY", "").strip():
        return None
    try:
        from langsmith import Client
    except ImportError:
        return None
    project_name = (
        os.environ.get("SEARCH_AGENT_LANGSMITH_PROJECT", "").strip() or "search-agent"
    )
    try:
        client = Client()
    except Exception:  # noqa: BLE001 - 客户端构造失败同样降级为不导出
        return None
    return LangSmithSink(client, project_name=project_name)
