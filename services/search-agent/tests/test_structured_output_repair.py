from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from langchain_core.messages import HumanMessage
from pydantic import BaseModel, ConfigDict

from app.llm import deepseek
from app.observability.trace import RunTracer, bind_tracer, unbind_tracer


class DemoResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    value: str


class RawMessage:
    def __init__(self, input_tokens: int, output_tokens: int) -> None:
        self.usage_metadata = {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "total_tokens": input_tokens + output_tokens,
        }


class FakeRunnable:
    def __init__(self, responses: list[dict[str, Any]]) -> None:
        self.responses = responses
        self.messages: list[list[Any]] = []

    async def ainvoke(self, messages: list[Any]) -> dict[str, Any]:
        self.messages.append(messages)
        return self.responses[len(self.messages) - 1]


class FakeModel:
    def __init__(self, runnable: FakeRunnable) -> None:
        self.runnable = runnable

    def with_structured_output(self, schema: type[BaseModel], **kwargs: Any) -> FakeRunnable:
        assert schema is DemoResult
        assert kwargs == {
            "method": "function_calling",
            "strict": True,
            "include_raw": True,
        }
        return self.runnable


def install_fake_model(monkeypatch: pytest.MonkeyPatch, runnable: FakeRunnable) -> None:
    config = SimpleNamespace(model=lambda _model_id: SimpleNamespace(id="test-model"))
    monkeypatch.setattr(deepseek, "runtime_config", lambda: config)
    monkeypatch.setattr(deepseek, "_structured_chat_model", lambda _role, _model_id: FakeModel(runnable))


@pytest.mark.asyncio
async def test_structured_output_repairs_once_and_counts_both_attempts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runnable = FakeRunnable([
        {
            "parsed": None,
            "raw": RawMessage(10, 2),
            "parsing_error": ValueError("invalid schema"),
        },
        {
            "parsed": DemoResult(value="ok"),
            "raw": RawMessage(20, 3),
            "parsing_error": None,
        },
    ])
    install_fake_model(monkeypatch, runnable)

    result, usage = await deepseek.invoke_structured(
        "supervisor",
        DemoResult,
        [HumanMessage(content="return structured data")],
        allow_repair=True,
    )

    assert result == DemoResult(value="ok")
    assert usage.input_tokens == 30
    assert usage.output_tokens == 5
    assert usage.total_tokens == 35
    assert usage.attempts == 2
    assert len(runnable.messages) == 2
    assert len(runnable.messages[0]) == 1
    assert len(runnable.messages[1]) == 2
    assert "Schema" in str(runnable.messages[1][-1].content)


@pytest.mark.asyncio
async def test_structured_output_does_not_retry_without_run_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runnable = FakeRunnable([{
        "parsed": None,
        "raw": RawMessage(10, 2),
        "parsing_error": ValueError("invalid schema"),
    }])
    install_fake_model(monkeypatch, runnable)

    with pytest.raises(deepseek.StructuredOutputError, match="结构化输出校验失败") as raised:
        await deepseek.invoke_structured(
            "supervisor",
            DemoResult,
            [HumanMessage(content="return structured data")],
            allow_repair=False,
        )

    assert len(runnable.messages) == 1
    assert raised.value.usage == deepseek.ModelUsage(
        input_tokens=10,
        output_tokens=2,
        total_tokens=12,
        cost_usd=0.0,
        attempts=1,
    )


class RecordingSink:
    def __init__(self) -> None:
        self.spans: list[Any] = []

    def emit(self, span: Any) -> None:
        self.spans.append(span)

    def flush(self) -> None:
        return None


@pytest.mark.asyncio
async def test_structured_call_emits_one_model_span_covering_all_attempts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """一次 invoke_structured 只产生一个 model span，repair 的 attempts 合并计入。"""
    runnable = FakeRunnable([
        {"parsed": None, "raw": RawMessage(10, 2), "parsing_error": ValueError("bad")},
        {"parsed": DemoResult(value="ok"), "raw": RawMessage(20, 3), "parsing_error": None},
    ])
    install_fake_model(monkeypatch, runnable)
    sink = RecordingSink()
    tracer = RunTracer("run_1", sink=sink)
    previous = bind_tracer(tracer)
    try:
        await deepseek.invoke_structured(
            "supervisor",
            DemoResult,
            [HumanMessage(content="q")],
            allow_repair=True,
        )
    finally:
        unbind_tracer(previous)

    model_spans = [span for span in sink.spans if span.kind == "model"]
    assert len(model_spans) == 1
    span = model_spans[0]
    assert span.name == "model:supervisor"
    assert span.status == "ok"
    assert span.attributes["modelId"] == "test-model"
    assert span.attributes["inputTokens"] == 30
    assert span.attributes["outputTokens"] == 5
    assert span.attributes["attempts"] == 2


@pytest.mark.asyncio
async def test_failed_structured_call_emits_an_error_model_span(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runnable = FakeRunnable([
        {"parsed": None, "raw": RawMessage(10, 2), "parsing_error": ValueError("bad")},
    ])
    install_fake_model(monkeypatch, runnable)
    sink = RecordingSink()
    previous = bind_tracer(RunTracer("run_1", sink=sink))
    try:
        with pytest.raises(deepseek.StructuredOutputError):
            await deepseek.invoke_structured(
                "supervisor",
                DemoResult,
                [HumanMessage(content="q")],
                allow_repair=False,
            )
    finally:
        unbind_tracer(previous)

    span = next(item for item in sink.spans if item.kind == "model")
    assert span.status == "error"
    assert span.attributes["attempts"] == 1


@pytest.mark.asyncio
async def test_structured_call_produces_no_span_when_tracing_is_off(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """未绑定 tracer 时模型层不取时间戳、不记录 span，行为与开启前完全一致。"""
    runnable = FakeRunnable([
        {"parsed": DemoResult(value="ok"), "raw": RawMessage(10, 2), "parsing_error": None},
    ])
    install_fake_model(monkeypatch, runnable)
    calls: list[object] = []
    monkeypatch.setattr(deepseek, "record_model_call", lambda **kw: calls.append(kw))

    previous = bind_tracer(None)
    try:
        result, usage = await deepseek.invoke_structured(
            "supervisor",
            DemoResult,
            [HumanMessage(content="q")],
        )
    finally:
        unbind_tracer(previous)

    assert result == DemoResult(value="ok")
    assert usage.attempts == 1
    assert calls == []
