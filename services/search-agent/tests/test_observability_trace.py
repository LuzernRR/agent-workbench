"""可观测性 trace 边界测试：span 派生、隐私门控、fail-safe 与事件流不变性。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from app.events.runtime import begin_event_scope, end_event_scope
from app.observability.sink import LocalStructuredSink, NoopSink, sink_from_env
from app.observability.span import Span
from app.observability.trace import (
    RunTracer,
    TracerFactory,
    bind_tracer,
    gen_ai_system,
    record_model_call,
    span_now,
    tracing_enabled,
    unbind_tracer,
)


class RecordingSink:
    def __init__(self) -> None:
        self.spans: list[Span] = []
        self.flushes = 0

    def emit(self, span: Span) -> None:
        self.spans.append(span)

    def flush(self) -> None:
        self.flushes += 1


class BrokenSink:
    def emit(self, span: Span) -> None:
        raise RuntimeError("sink down")

    def flush(self) -> None:
        raise RuntimeError("flush down")


def event(event_type: str, created_at: str = "2026-08-01T00:00:00Z", **payload: Any) -> dict[str, Any]:
    return {"type": event_type, "createdAt": created_at, **payload}


def test_tracer_derives_node_spans_from_started_and_completed() -> None:
    sink = RecordingSink()
    tracer = RunTracer("run_1", sink=sink)

    tracer.observe(event("node.started", node="plan_research", nodeRunId="n1", agent="planner", iteration=0))
    tracer.observe(
        event(
            "node.completed",
            created_at="2026-08-01T00:00:01Z",
            node="plan_research",
            nodeRunId="n1",
            agent="planner",
            iteration=0,
            durationMs=1000,
        )
    )
    root = tracer.finish()

    node_spans = [span for span in sink.spans if span.kind == "node"]
    assert len(node_spans) == 1
    span = node_spans[0]
    assert span.name == "plan_research"
    assert span.status == "ok"
    assert span.parent_span_id == root.span_id
    assert span.trace_id == "run_1"
    assert span.started_at == "2026-08-01T00:00:00Z"
    assert span.ended_at == "2026-08-01T00:00:01Z"
    assert span.attributes["durationMs"] == 1000
    assert span.attributes["gen_ai.agent.name"] == "planner"
    assert span.attributes["gen_ai.operation.name"] == "invoke_agent"


def test_tracer_marks_failed_node_span_as_error_with_reason_code() -> None:
    sink = RecordingSink()
    tracer = RunTracer("run_1", sink=sink)

    tracer.observe(event("node.started", node="verify", nodeRunId="n1", agent="verifier"))
    tracer.observe(
        event("node.failed", node="verify", nodeRunId="n1", agent="verifier", reasonCode="SCHEMA_INVALID")
    )
    tracer.finish()

    span = next(item for item in sink.spans if item.kind == "node")
    assert span.status == "error"
    assert span.attributes["reasonCode"] == "SCHEMA_INVALID"


def test_tracer_derives_tool_spans_and_terminal_status() -> None:
    sink = RecordingSink()
    tracer = RunTracer("run_1", sink=sink)

    for index, (terminal, expected) in enumerate(
        [
            ("tool.completed", "ok"),
            ("tool.failed", "error"),
            ("tool.unknown", "unknown"),
        ]
    ):
        call_id = f"call_{index}"
        tracer.observe(
            event("tool.started", toolCallId=call_id, toolName="web_search", channel="web", query="q")
        )
        tracer.observe(
            event(terminal, toolCallId=call_id, toolName="web_search", channel="web", reasonCode="R")
        )
        span = sink.spans[-1]
        assert span.kind == "tool"
        assert span.name == "web_search"
        assert span.status == expected
        assert span.attributes["gen_ai.tool.name"] == "web_search"
        assert span.attributes["gen_ai.tool.call.id"] == call_id
        assert span.attributes["gen_ai.operation.name"] == "execute_tool"
        assert "toolName" not in span.attributes
        assert "toolCallId" not in span.attributes


@pytest.mark.parametrize(
    ("base_url", "expected"),
    [
        ("https://api.deepseek.com/v1", "deepseek"),
        ("https://api.openai.com/v1", "openai"),
        ("https://api.anthropic.com", "anthropic"),
        # 自建网关、代理或未收录厂商按 OTel 约定记 _OTHER，绝不猜测。
        ("https://llm-gateway.internal.corp/v1", "_OTHER"),
        ("http://127.0.0.1:8000/v1", "_OTHER"),
        ("", "_OTHER"),
        # 后缀必须落在域名边界上，不能被仿冒域命中。
        ("https://api.deepseek.com.evil.example/v1", "_OTHER"),
        ("https://notdeepseek.com/v1", "_OTHER"),
    ],
)
def test_gen_ai_system_is_derived_from_base_url_host(base_url: str, expected: str) -> None:
    assert gen_ai_system(base_url) == expected


def test_run_span_carries_no_gen_ai_operation_name() -> None:
    # run 是本项目的编排根，不对应任何 OTel GenAI 操作类型；不硬塞一个值。
    sink = RecordingSink()
    tracer = RunTracer("run_1", sink=sink)
    tracer.observe(event("run.completed", responseStatus="completed"))
    root = tracer.finish()
    assert "gen_ai.operation.name" not in root.attributes


def test_tracer_never_copies_query_text_or_result_payloads_into_attributes() -> None:
    sink = RecordingSink()
    tracer = RunTracer("run_1", sink=sink)

    tracer.observe(event("tool.started", toolCallId="c1", toolName="web_search", query="敏感查询原文"))
    tracer.observe(
        event(
            "tool.completed",
            toolCallId="c1",
            toolName="web_search",
            query="敏感查询原文",
            summary="找到 3 条结果",
            results=[{"url": "https://example.com", "title": "标题"}],
            resultCount=3,
        )
    )
    tracer.finish()

    span = next(item for item in sink.spans if item.kind == "tool")
    assert "query" not in span.attributes
    assert "results" not in span.attributes
    assert "summary" not in span.attributes
    assert span.attributes["resultCount"] == 3


def test_tracer_rejects_forbidden_attribute_keys() -> None:
    tracer = RunTracer("run_1", sink=RecordingSink())
    with pytest.raises(ValueError, match="公开事件包含禁止字段"):
        tracer.observe(event("node.started", node="compose", nodeRunId="n1", usage={"apiKey": "sk-secret"}))


def test_tracer_attaches_non_span_events_to_nearest_open_parent() -> None:
    sink = RecordingSink()
    tracer = RunTracer("run_1", sink=sink)

    tracer.observe(event("node.started", node="research", nodeRunId="n1", agent="researcher"))
    tracer.observe(event("tool.started", toolCallId="c1", toolName="web_search"))
    tracer.observe(event("tool.progress", toolCallId="c1", provider="tavily", resultCount=2))
    tracer.observe(event("evidence.updated", nodeRunId="n1", status="read"))
    tracer.observe(event("plan.updated", planId="p1", revision=2))
    tracer.observe(event("tool.completed", toolCallId="c1", toolName="web_search"))
    tracer.observe(event("node.completed", node="research", nodeRunId="n1", agent="researcher"))
    root = tracer.finish()

    tool_span = next(item for item in sink.spans if item.kind == "tool")
    node_span = next(item for item in sink.spans if item.kind == "node")
    assert [item["type"] for item in tool_span.events] == ["tool.progress"]
    assert [item["type"] for item in node_span.events] == ["evidence.updated"]
    assert [item["type"] for item in root.events] == ["plan.updated"]
    assert root.events[0]["revision"] == 2


def test_tracer_records_run_terminal_status_and_counters() -> None:
    sink = RecordingSink()
    tracer = RunTracer("run_1", sink=sink)

    tracer.observe(event("node.started", node="compose", nodeRunId="n1", agent="composer"))
    tracer.observe(event("node.completed", node="compose", nodeRunId="n1", agent="composer"))
    tracer.observe(
        event(
            "run.completed",
            created_at="2026-08-01T00:00:09Z",
            responseStatus="completed",
            stopReason="SUFFICIENT",
            modelCalls=4,
            toolCalls=2,
            verificationPassed=True,
        )
    )
    root = tracer.finish()

    assert root.kind == "run"
    assert root.status == "ok"
    assert root.ended_at == "2026-08-01T00:00:09Z"
    assert root.attributes["stopReason"] == "SUFFICIENT"
    assert root.attributes["modelCalls"] == 4
    assert root.attributes["eventCounts"]["node.started"] == 1
    assert root.attributes["eventCounts"]["run.completed"] == 1
    assert root.attributes["sinkFailures"] == 0
    assert tracer.event_counts["node.completed"] == 1


@pytest.mark.parametrize(
    ("terminal", "expected"),
    [("run.completed", "ok"), ("run.failed", "error"), ("run.stopped", "unknown")],
)
def test_tracer_maps_every_run_terminal(terminal: str, expected: str) -> None:
    tracer = RunTracer("run_1", sink=RecordingSink())
    tracer.observe(event(terminal, reasonCode="X"))
    assert tracer.finish().status == expected


def test_tracer_closes_unfinished_spans_as_unknown() -> None:
    sink = RecordingSink()
    tracer = RunTracer("run_1", sink=sink)

    tracer.observe(event("node.started", node="research", nodeRunId="n1", agent="researcher"))
    tracer.observe(event("tool.started", toolCallId="c1", toolName="web_search"))
    tracer.finish()

    assert {span.kind: span.status for span in sink.spans} == {
        "node": "unknown",
        "tool": "unknown",
        "run": "unknown",
    }


def test_tracer_swallows_sink_failures_and_counts_them() -> None:
    tracer = RunTracer("run_1", sink=BrokenSink())

    tracer.observe(event("node.started", node="compose", nodeRunId="n1", agent="composer"))
    tracer.observe(event("node.completed", node="compose", nodeRunId="n1", agent="composer"))
    tracer.observe(event("run.completed", responseStatus="completed"))
    root = tracer.finish()

    # 1 次 node span emit + 1 次 root emit + 1 次 flush 均失败。
    assert tracer.sink_failures == 3
    # root 的 attributes 在自身 emit 之前快照，只能记录此前已知的 1 次失败。
    assert root.attributes["sinkFailures"] == 1


def test_tracer_ignores_duplicate_started_and_unknown_terminals() -> None:
    sink = RecordingSink()
    tracer = RunTracer("run_1", sink=sink)

    tracer.observe(event("node.started", node="research", nodeRunId="n1", agent="researcher"))
    tracer.observe(event("node.started", node="research", nodeRunId="n1", agent="researcher"))
    tracer.observe(event("node.completed", node="research", nodeRunId="n1", agent="researcher"))
    tracer.observe(event("node.completed", node="research", nodeRunId="n1", agent="researcher"))
    tracer.observe(event("tool.completed", toolCallId="never_started", toolName="web_search"))
    tracer.finish()

    assert len([span for span in sink.spans if span.kind == "node"]) == 1


def test_tracer_ignores_events_without_type() -> None:
    sink = RecordingSink()
    tracer = RunTracer("run_1", sink=sink)
    tracer.observe({"createdAt": "2026-08-01T00:00:00Z"})
    assert tracer.event_counts == {}


def test_local_structured_sink_writes_one_ndjson_file_per_trace(tmp_path: Path) -> None:
    sink = LocalStructuredSink(tmp_path)
    tracer = RunTracer("run_abc", sink=sink)

    tracer.observe(event("node.started", node="compose", nodeRunId="n1", agent="composer"))
    tracer.observe(event("node.completed", node="compose", nodeRunId="n1", agent="composer"))
    tracer.observe(event("run.completed", responseStatus="completed"))
    tracer.finish()

    path = tmp_path / "run_abc.ndjson"
    lines = path.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 2
    records = [json.loads(line) for line in lines]
    assert records[0]["kind"] == "node"
    assert records[1]["kind"] == "run"
    assert records[1]["traceId"] == "run_abc"
    assert sink.error_count == 0
    assert sink.success_count == 2


def test_local_structured_sink_counts_errors_without_raising(tmp_path: Path) -> None:
    # 用文件占位目录名，使 mkdir 失败。
    blocked = tmp_path / "blocked"
    blocked.write_text("not a directory", encoding="utf-8")
    sink = LocalStructuredSink(blocked)
    tracer = RunTracer("run_1", sink=sink)

    tracer.observe(event("run.completed", responseStatus="completed"))
    tracer.finish()

    assert sink.error_count >= 1
    assert sink.success_count == 0


def test_noop_sink_and_default_factory_are_inert() -> None:
    factory = TracerFactory()
    assert factory("run_1") is None

    sink = NoopSink()
    span = Span(
        span_id="s1",
        parent_span_id=None,
        trace_id="t1",
        kind="run",
        name="run:t1",
        started_at="2026-08-01T00:00:00Z",
        ended_at=None,
        status="ok",
    )
    assert sink.emit(span) is None
    assert sink.flush() is None


def test_tracer_factory_builds_tracer_when_sink_configured() -> None:
    sink = RecordingSink()
    factory = TracerFactory(sink)
    tracer = factory("run_9")
    assert tracer is not None
    assert tracer.trace_id == "run_9"


def test_sink_from_env_defaults_to_disabled_and_opts_in_explicitly(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("SEARCH_AGENT_TRACING_ENABLED", raising=False)
    assert sink_from_env() is None

    monkeypatch.setenv("SEARCH_AGENT_TRACING_ENABLED", "false")
    assert sink_from_env() is None

    monkeypatch.setenv("SEARCH_AGENT_TRACING_ENABLED", "true")
    monkeypatch.setenv("SEARCH_AGENT_TRACING_OUTPUT_DIR", str(tmp_path / "traces"))
    assert isinstance(sink_from_env(), LocalStructuredSink)

    # 未开启时工厂不构造 tracer，运行路径完全不受影响。
    monkeypatch.setenv("SEARCH_AGENT_TRACING_ENABLED", "0")
    assert TracerFactory(sink_from_env())("run_1") is None


# --- model span：模型调用层不发事件，只能经 contextvar 记录 ---


def test_model_span_is_recorded_under_the_bound_tracer() -> None:
    sink = RecordingSink()
    tracer = RunTracer("run_1", sink=sink)
    previous = bind_tracer(tracer)
    try:
        record_model_call(
            role="planner",
            model_id="deepseek-v4",
            started_at="2026-08-01T00:00:00Z",
            ended_at="2026-08-01T00:00:02Z",
            status="ok",
            attributes={"inputTokens": 10, "outputTokens": 5, "attempts": 1},
        )
    finally:
        unbind_tracer(previous)
    root = tracer.finish()

    span = next(item for item in sink.spans if item.kind == "model")
    assert span.name == "model:planner"
    assert span.parent_span_id == root.span_id
    assert span.status == "ok"
    assert span.started_at == "2026-08-01T00:00:00Z"
    assert span.ended_at == "2026-08-01T00:00:02Z"
    assert span.attributes["gen_ai.request.model"] == "deepseek-v4"
    assert span.attributes["gen_ai.usage.input_tokens"] == 10
    assert span.attributes["gen_ai.usage.output_tokens"] == 5
    assert span.attributes["gen_ai.operation.name"] == "chat"
    # 未显式传 system 时按 OTel 约定降级为 _OTHER，不猜测厂商。
    assert span.attributes["gen_ai.system"] == "_OTHER"
    assert span.attributes["attempts"] == 1
    # 旧的自定义名不得再出现，否则后端会同时看到两套 schema。
    assert "modelId" not in span.attributes
    assert "inputTokens" not in span.attributes


def test_model_span_recording_is_a_noop_when_no_tracer_is_bound() -> None:
    previous = bind_tracer(None)
    try:
        assert record_model_call(
            role="writer",
            model_id="m",
            started_at="2026-08-01T00:00:00Z",
            ended_at="2026-08-01T00:00:01Z",
            status="ok",
            attributes={"inputTokens": 1},
        ) is None
    finally:
        unbind_tracer(previous)


def test_model_span_drops_attributes_outside_the_allowlist() -> None:
    sink = RecordingSink()
    tracer = RunTracer("run_1", sink=sink)
    tracer.record_model_call(
        role="writer",
        model_id="m",
        system="deepseek",
        started_at="2026-08-01T00:00:00Z",
        ended_at="2026-08-01T00:00:01Z",
        status="ok",
        attributes={"inputTokens": 3, "messages": ["系统提示"], "summary": "正文"},
    )

    span = sink.spans[-1]
    assert span.attributes["gen_ai.usage.input_tokens"] == 3
    assert span.attributes["gen_ai.system"] == "deepseek"
    assert "messages" not in span.attributes
    assert "summary" not in span.attributes


def test_model_span_failures_never_reach_the_model_layer() -> None:
    tracer = RunTracer("run_1", sink=BrokenSink())
    previous = bind_tracer(tracer)
    try:
        assert record_model_call(
            role="planner",
            model_id="m",
            started_at="2026-08-01T00:00:00Z",
            ended_at="2026-08-01T00:00:01Z",
            status="ok",
            attributes={},
        ) is None
        # sink 抛出被 _emit 吞下并计数，模型层什么也感知不到。
        assert tracer.sink_failures == 1

        # 属性违规发生在 emit 之前，同样只计数不外泄。
        # 允许键携带嵌套禁止字段时由 _assert_public 拦截（允许列表本身挡不住这种情况）。
        assert record_model_call(
            role="planner",
            model_id="m",
            started_at="2026-08-01T00:00:00Z",
            ended_at="2026-08-01T00:00:01Z",
            status="ok",
            attributes={"reasonCode": {"apiKey": "sk-secret"}},
        ) is None
        assert tracer.sink_failures == 2
    finally:
        unbind_tracer(previous)


def test_tracing_enabled_reflects_the_bound_tracer() -> None:
    previous = bind_tracer(None)
    try:
        assert tracing_enabled() is False
        inner = bind_tracer(RunTracer("run_1", sink=RecordingSink()))
        assert tracing_enabled() is True
        unbind_tracer(inner)
        assert tracing_enabled() is False
    finally:
        unbind_tracer(previous)


def test_span_now_follows_the_injected_event_clock() -> None:
    previous = begin_event_scope("run_1", stream_id="s1", clock=lambda: "2026-08-01T12:00:00Z")
    try:
        assert span_now() == "2026-08-01T12:00:00Z"
    finally:
        end_event_scope(previous)
