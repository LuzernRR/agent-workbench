"""Span sink 接口与本地结构化实现；失败降级为计数器。"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import IO, Protocol

from app.observability.span import Span


class SpanSink(Protocol):
    """Span 持久化合同；实现必须 fail-safe。"""

    def emit(self, span: Span) -> None:
        """写入一个已完成 span；失败只允许内部计数，不得传播异常。"""
        ...

    def flush(self) -> None:
        """刷新缓冲区；失败只允许内部计数，不得传播异常。"""
        ...


class NoopSink:
    """禁用 tracing 时的空实现。"""

    def emit(self, span: Span) -> None:
        pass

    def flush(self) -> None:
        pass


class LocalStructuredSink:
    """本地 NDJSON sink；每个 run 一个文件。"""

    def __init__(self, output_dir: Path) -> None:
        self._output_dir = output_dir
        self._files: dict[str, IO[str]] = {}
        self._error_count = 0
        self._success_count = 0

    def emit(self, span: Span) -> None:
        try:
            trace_id = span.trace_id
            if trace_id not in self._files:
                self._output_dir.mkdir(parents=True, exist_ok=True)
                path = self._output_dir / f"{trace_id}.ndjson"
                self._files[trace_id] = path.open("a", encoding="utf-8")
            serialized = json.dumps(
                {
                    "spanId": span.span_id,
                    "parentSpanId": span.parent_span_id,
                    "traceId": span.trace_id,
                    "kind": span.kind,
                    "name": span.name,
                    "startedAt": span.started_at,
                    "endedAt": span.ended_at,
                    "status": span.status,
                    "attributes": span.attributes,
                    "events": span.events,
                },
                ensure_ascii=False,
                separators=(",", ":"),
            )
            self._files[trace_id].write(serialized)
            self._files[trace_id].write("\n")
            self._success_count += 1
        except Exception:  # noqa: BLE001
            self._error_count += 1

    def flush(self) -> None:
        try:
            for handle in self._files.values():
                try:
                    handle.flush()
                except Exception:  # noqa: BLE001
                    self._error_count += 1
        except Exception:  # noqa: BLE001
            self._error_count += 1

    @property
    def error_count(self) -> int:
        return self._error_count

    @property
    def success_count(self) -> int:
        return self._success_count


class FanOutSink:
    """把 span 广播给多个 sink；单个 sink 故障不影响其它 sink。"""

    def __init__(self, sinks: list[SpanSink]) -> None:
        self._sinks = sinks
        self._error_count = 0

    def emit(self, span: Span) -> None:
        for sink in self._sinks:
            try:
                sink.emit(span)
            except Exception:  # noqa: BLE001
                self._error_count += 1

    def flush(self) -> None:
        for sink in self._sinks:
            try:
                sink.flush()
            except Exception:  # noqa: BLE001
                self._error_count += 1

    @property
    def error_count(self) -> int:
        return self._error_count


def sink_from_env() -> SpanSink | None:
    """从环境变量构造 sink；未显式开启返回 None，使 tracing 完全不介入。"""
    sinks: list[SpanSink] = []
    enabled = os.environ.get("SEARCH_AGENT_TRACING_ENABLED", "").lower() in {
        "1",
        "true",
        "yes",
    }
    if enabled:
        output_dir = os.environ.get(
            "SEARCH_AGENT_TRACING_OUTPUT_DIR",
            ".observability/traces",
        )
        sinks.append(LocalStructuredSink(Path(output_dir)))

    from app.observability.langsmith_sink import langsmith_sink_from_env

    langsmith = langsmith_sink_from_env()
    if langsmith is not None:
        sinks.append(langsmith)

    if not sinks:
        return None
    if len(sinks) == 1:
        return sinks[0]
    return FanOutSink(sinks)
