"""可选 LangSmith 导出测试：fail-safe off、安全字段边界、故障降级。"""

from __future__ import annotations

import uuid
from typing import Any

import pytest

from app.observability.langsmith_sink import LangSmithSink, langsmith_sink_from_env
from app.observability.sink import FanOutSink, sink_from_env
from app.observability.span import Span
from app.observability.trace import RunTracer


class RecordingClient:
    def __init__(self, *, fail: bool = False) -> None:
        self.runs: list[dict[str, Any]] = []
        self.flushes = 0
        self._fail = fail

    def create_run(self, **kwargs: Any) -> None:
        if self._fail:
            raise RuntimeError("langsmith unreachable")
        self.runs.append(kwargs)

    def flush(self) -> None:
        self.flushes += 1


def span(
    *,
    span_id: str = "s1",
    parent_span_id: str | None = None,
    kind: str = "node",
    status: str = "ok",
    attributes: dict[str, Any] | None = None,
) -> Span:
    return Span(
        span_id=span_id,
        parent_span_id=parent_span_id,
        trace_id="run_1",
        kind=kind,  # type: ignore[arg-type]
        name="plan_research",
        started_at="2026-08-01T00:00:00Z",
        ended_at="2026-08-01T00:00:01Z",
        status=status,  # type: ignore[arg-type]
        attributes=attributes or {"durationMs": 12, "agent": "planner"},
    )


def test_langsmith_sink_exports_safe_metadata_only() -> None:
    client = RecordingClient()
    sink = LangSmithSink(client, project_name="search-agent")

    sink.emit(span(parent_span_id="root"))

    assert sink.exported_count == 1
    record = client.runs[0]
    # 输入侧必须为空：问题原文与 Prompt 不出进程。
    assert record["inputs"] == {}
    assert record["run_type"] == "chain"
    assert record["project_name"] == "search-agent"
    assert record["outputs"]["status"] == "ok"
    assert record["outputs"]["durationMs"] == 12
    assert record["error"] is None
    assert isinstance(record["run_id"], uuid.UUID)
    assert isinstance(record["parent_run_id"], uuid.UUID)
    assert record["start_time"] is not None
    assert record["end_time"] is not None


def test_langsmith_sink_maps_span_kind_to_run_type() -> None:
    client = RecordingClient()
    sink = LangSmithSink(client, project_name="p")

    for kind, expected in [
        ("run", "chain"),
        ("node", "chain"),
        ("tool", "tool"),
        ("model", "llm"),
    ]:
        sink.emit(span(kind=kind))
        assert client.runs[-1]["run_type"] == expected


def test_langsmith_sink_derives_stable_ids_from_span_ids() -> None:
    first = RecordingClient()
    second = RecordingClient()
    LangSmithSink(first, project_name="p").emit(span(span_id="abc"))
    LangSmithSink(second, project_name="p").emit(span(span_id="abc"))

    assert first.runs[0]["run_id"] == second.runs[0]["run_id"]
    assert first.runs[0]["trace_id"] == second.runs[0]["trace_id"]


def test_langsmith_sink_reports_error_status() -> None:
    client = RecordingClient()
    LangSmithSink(client, project_name="p").emit(span(status="error"))
    assert client.runs[0]["error"] == "error"


def test_langsmith_sink_swallows_export_failures() -> None:
    client = RecordingClient(fail=True)
    sink = LangSmithSink(client, project_name="p")

    sink.emit(span())
    sink.flush()

    assert sink.error_count == 1
    assert sink.exported_count == 0


def test_langsmith_sink_tolerates_client_without_flush() -> None:
    class NoFlushClient:
        def create_run(self, **kwargs: Any) -> None:
            pass

    sink = LangSmithSink(NoFlushClient(), project_name="p")
    sink.flush()
    assert sink.error_count == 0


def test_langsmith_sink_handles_unparsable_timestamps() -> None:
    client = RecordingClient()
    sink = LangSmithSink(client, project_name="p")
    broken = span()
    broken.started_at = "not-a-timestamp"
    broken.ended_at = None

    sink.emit(broken)

    assert client.runs[0]["start_time"] is None
    assert client.runs[0]["end_time"] is None


def test_langsmith_disabled_without_explicit_opt_in(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LANGSMITH_API_KEY", "ls-secret")
    monkeypatch.delenv("SEARCH_AGENT_LANGSMITH_ENABLED", raising=False)
    assert langsmith_sink_from_env() is None

    monkeypatch.setenv("SEARCH_AGENT_LANGSMITH_ENABLED", "false")
    assert langsmith_sink_from_env() is None


def test_langsmith_disabled_without_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SEARCH_AGENT_LANGSMITH_ENABLED", "true")
    monkeypatch.delenv("LANGSMITH_API_KEY", raising=False)
    assert langsmith_sink_from_env() is None

    monkeypatch.setenv("LANGSMITH_API_KEY", "   ")
    assert langsmith_sink_from_env() is None


def test_langsmith_enabled_builds_sink_with_project(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SEARCH_AGENT_LANGSMITH_ENABLED", "true")
    monkeypatch.setenv("LANGSMITH_API_KEY", "ls-secret")
    monkeypatch.setenv("SEARCH_AGENT_LANGSMITH_PROJECT", "my-project")
    monkeypatch.setenv("LANGSMITH_TRACING", "false")

    sink = langsmith_sink_from_env()

    assert isinstance(sink, LangSmithSink)
    assert sink._project_name == "my-project"


def test_fan_out_sink_isolates_failures() -> None:
    class GoodSink:
        def __init__(self) -> None:
            self.spans: list[Span] = []
            self.flushes = 0

        def emit(self, item: Span) -> None:
            self.spans.append(item)

        def flush(self) -> None:
            self.flushes += 1

    class BadSink:
        def emit(self, item: Span) -> None:
            raise RuntimeError("down")

        def flush(self) -> None:
            raise RuntimeError("down")

    good = GoodSink()
    fan = FanOutSink([BadSink(), good])

    fan.emit(span())
    fan.flush()

    assert len(good.spans) == 1
    assert good.flushes == 1
    assert fan.error_count == 2


def test_sink_from_env_combines_local_and_langsmith(
    tmp_path: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SEARCH_AGENT_TRACING_ENABLED", "true")
    monkeypatch.setenv("SEARCH_AGENT_TRACING_OUTPUT_DIR", str(tmp_path))
    monkeypatch.setenv("SEARCH_AGENT_LANGSMITH_ENABLED", "true")
    monkeypatch.setenv("LANGSMITH_API_KEY", "ls-secret")
    monkeypatch.setenv("LANGSMITH_TRACING", "false")

    sink = sink_from_env()

    assert isinstance(sink, FanOutSink)


def test_langsmith_export_never_carries_forbidden_fields_from_a_real_trace() -> None:
    client = RecordingClient()
    tracer = RunTracer("run_1", sink=LangSmithSink(client, project_name="p"))

    tracer.observe({
        "type": "tool.started",
        "createdAt": "2026-08-01T00:00:00Z",
        "toolCallId": "c1",
        "toolName": "web_search",
        "query": "敏感查询原文",
    })
    tracer.observe({
        "type": "tool.completed",
        "createdAt": "2026-08-01T00:00:02Z",
        "toolCallId": "c1",
        "toolName": "web_search",
        "query": "敏感查询原文",
        "results": [{"url": "https://example.com"}],
        "resultCount": 1,
    })
    tracer.observe({
        "type": "run.completed",
        "createdAt": "2026-08-01T00:00:03Z",
        "answerMarkdown": "最终答案正文",
        "responseStatus": "completed",
    })
    tracer.finish()

    serialized = repr(client.runs)
    assert "敏感查询原文" not in serialized
    assert "最终答案正文" not in serialized
    assert "example.com" not in serialized
    assert "resultCount" in serialized
