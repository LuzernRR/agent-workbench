from __future__ import annotations

import ast
import asyncio
import json
import pathlib
from collections.abc import AsyncIterator
from typing import Any

import pytest
from pydantic import BaseModel, ConfigDict

from app.llm.contracts import (
    ModelErrorKind,
    ModelMessage,
    ModelRequest,
    ModelResult,
    StructuredOutputError,
    WriterStreamError,
)
from app.llm.gateway import DefaultModelGateway, ModelProviderError
from app.observability.span import Span
from app.observability.trace import RunTracer, bind_tracer, unbind_tracer
from app.reliability.retry import RetryPolicy


class DemoResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    value: str


def request(*, model_id: str = "primary", max_attempts: int = 6) -> ModelRequest:
    return ModelRequest(
        task_type="supervisor",
        tenant_id="tenant_test",
        trace_id="run_test",
        model_id=model_id,
        messages=(ModelMessage(role="user", content="return data"),),
        response_schema=DemoResult.model_json_schema(),
        latency_slo_ms=5_000,
        max_output_tokens=100,
        cost_budget_usd=1.0,
        max_provider_attempts=max_attempts,
    )


def result(
    output: dict[str, Any] | None,
    *,
    model: str = "primary",
    input_tokens: int = 10,
    output_tokens: int = 2,
) -> ModelResult:
    return ModelResult(
        provider="test",
        model=model,
        output=output,
        finish_reason="stop",
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        latency_ms=1,
    )


class FakeClock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


class FakeProvider:
    provider_name = "test"
    gen_ai_system = "_OTHER"

    def __init__(self, structured: list[object]) -> None:
        self.structured = structured
        self.calls: list[tuple[str, ModelRequest]] = []
        self.stream_calls: list[str] = []
        self.stream_factory: Any = None

    async def generate_structured(
        self,
        call: ModelRequest,
        schema: type[BaseModel],
        *,
        model_id: str,
    ) -> ModelResult:
        assert schema is DemoResult
        self.calls.append((model_id, call))
        item = self.structured.pop(0)
        if callable(item):
            item = item()
        if isinstance(item, BaseException):
            raise item
        assert isinstance(item, ModelResult)
        return item.model_copy(update={"model": model_id})

    async def stream_text(
        self,
        call: ModelRequest,
        *,
        model_id: str,
    ) -> AsyncIterator[str | ModelResult]:
        self.stream_calls.append(model_id)
        assert self.stream_factory is not None
        async for item in self.stream_factory(call, model_id):
            yield item


def gateway(
    provider: FakeProvider,
    clock: FakeClock,
    *,
    fallback_models: dict[str, tuple[str, ...]] | None = None,
    sleeper: Any = None,
) -> DefaultModelGateway:
    return DefaultModelGateway(
        provider,
        retry_policy=RetryPolicy(
            max_attempts=3,
            max_elapsed_seconds=5,
            initial_delay_seconds=1,
            max_delay_seconds=4,
        ),
        fallback_models=fallback_models or {},
        sleeper=sleeper,
        clock=clock,
        random_source=lambda: 0.5,
    )


@pytest.mark.asyncio
async def test_rate_limit_retry_after_is_owned_and_counted_by_gateway() -> None:
    clock = FakeClock()
    waits: list[float] = []

    async def sleep(delay: float) -> None:
        waits.append(delay)
        clock.now += delay

    provider = FakeProvider([
        ModelProviderError(
            ModelErrorKind.RATE_LIMIT,
            "模型请求受限",
            retry_after_seconds=2,
        ),
        result({"value": "ok"}),
    ])
    parsed, usage = await gateway(provider, clock, sleeper=sleep).generate_structured(
        request(),
        DemoResult,
    )

    assert parsed == DemoResult(value="ok")
    assert [model for model, _call in provider.calls] == ["primary", "primary"]
    assert waits == [2]
    assert usage.attempts == 2
    assert usage.network_retries == 1
    assert usage.format_repairs == 0
    assert [item.error_kind for item in usage.attempt_details] == [
        ModelErrorKind.RATE_LIMIT,
        None,
    ]


@pytest.mark.asyncio
async def test_permanent_error_is_never_retried_or_fallbacked() -> None:
    clock = FakeClock()
    provider = FakeProvider([
        ModelProviderError(ModelErrorKind.PERMANENT, "模型请求无效"),
    ])

    with pytest.raises(ModelProviderError, match="模型请求无效"):
        await gateway(
            provider,
            clock,
            fallback_models={"primary": ("fallback",)},
        ).generate_structured(request(), DemoResult)

    assert [model for model, _call in provider.calls] == ["primary"]


@pytest.mark.asyncio
async def test_retryable_failure_uses_only_explicit_fallback() -> None:
    clock = FakeClock()

    async def sleep(delay: float) -> None:
        clock.now += delay

    provider = FakeProvider([
        ModelProviderError(ModelErrorKind.TRANSIENT, "provider down"),
        ModelProviderError(ModelErrorKind.TRANSIENT, "provider down"),
        result({"value": "fallback ok"}, model="fallback"),
    ])
    parsed, usage = await gateway(
        provider,
        clock,
        fallback_models={"primary": ("fallback",)},
        sleeper=sleep,
    ).generate_structured(request(), DemoResult)

    assert parsed.value == "fallback ok"
    assert [model for model, _call in provider.calls] == [
        "primary",
        "primary",
        "fallback",
    ]
    assert usage.attempts == 3
    assert usage.network_retries == 1
    assert usage.fallbacks == 1
    assert usage.primary_model == "primary"
    assert usage.effective_model == "fallback"


@pytest.mark.asyncio
async def test_exhausted_deadline_stops_retry_and_fallback() -> None:
    clock = FakeClock()

    def consume_deadline() -> ModelProviderError:
        clock.now = 5.0
        return ModelProviderError(ModelErrorKind.TRANSIENT, "late failure")

    provider = FakeProvider([consume_deadline])
    with pytest.raises(ModelProviderError, match="late failure"):
        await gateway(
            provider,
            clock,
            fallback_models={"primary": ("fallback",)},
        ).generate_structured(request(), DemoResult)

    assert [model for model, _call in provider.calls] == ["primary"]


@pytest.mark.asyncio
async def test_schema_repair_is_separate_from_network_retry() -> None:
    clock = FakeClock()
    provider = FakeProvider([
        result(None, input_tokens=4, output_tokens=1),
        result({"value": "repaired"}, input_tokens=6, output_tokens=2),
    ])
    parsed, usage = await gateway(provider, clock).generate_structured(
        request(),
        DemoResult,
        allow_repair=True,
    )

    assert parsed.value == "repaired"
    assert len(provider.calls) == 2
    assert len(provider.calls[0][1].messages) == 1
    assert len(provider.calls[1][1].messages) == 2
    assert usage.attempts == 2
    assert usage.network_retries == 0
    assert usage.format_repairs == 1
    assert usage.input_tokens == 10
    assert usage.output_tokens == 3


@pytest.mark.asyncio
async def test_schema_repair_failure_stays_invalid_output() -> None:
    clock = FakeClock()
    provider = FakeProvider([result(None), result(None)])

    with pytest.raises(StructuredOutputError) as raised:
        await gateway(provider, clock).generate_structured(
            request(),
            DemoResult,
            allow_repair=True,
        )

    assert raised.value.usage.attempts == 2
    assert raised.value.usage.format_repairs == 1
    assert raised.value.usage.network_retries == 0


@pytest.mark.asyncio
async def test_schema_violation_without_repair_budget_fails_on_first_attempt() -> None:
    """AC5：run 预算不允许修复时，格式不合法必须一次失败，不得偷偷重发。"""

    clock = FakeClock()
    provider = FakeProvider([result(None, input_tokens=10, output_tokens=2)])

    with pytest.raises(StructuredOutputError) as raised:
        await gateway(provider, clock).generate_structured(
            request(),
            DemoResult,
            allow_repair=False,
        )

    assert len(provider.calls) == 1
    assert raised.value.usage.attempts == 1
    assert raised.value.usage.format_repairs == 0
    assert raised.value.usage.network_retries == 0
    assert raised.value.usage.input_tokens == 10


@pytest.mark.asyncio
async def test_stream_failure_after_first_delta_never_retries_or_fallbacks() -> None:
    clock = FakeClock()
    provider = FakeProvider([])

    async def broken_stream(
        call: ModelRequest,
        model_id: str,
    ) -> AsyncIterator[str | ModelResult]:
        del call, model_id
        yield "prefix"
        raise ModelProviderError(ModelErrorKind.TRANSIENT, "stream broke")

    provider.stream_factory = broken_stream
    items: list[str] = []
    with pytest.raises(WriterStreamError) as raised:
        async for item in gateway(
            provider,
            clock,
            fallback_models={"primary": ("fallback",)},
        ).stream_text(request()):
            if isinstance(item, str):
                items.append(item)

    assert items == ["prefix"]
    assert provider.stream_calls == ["primary"]
    assert raised.value.usage.attempts == 1


@pytest.mark.asyncio
async def test_external_cancellation_escapes_gateway() -> None:
    clock = FakeClock()
    provider = FakeProvider([asyncio.CancelledError()])

    with pytest.raises(asyncio.CancelledError):
        await gateway(provider, clock).generate_structured(request(), DemoResult)

    assert len(provider.calls) == 1


@pytest.mark.asyncio
async def test_timeout_retries_with_full_jitter_backoff() -> None:
    """AC3/AC8：超时属可恢复错误；无 Retry-After 时按 full jitter 退避。"""

    clock = FakeClock()
    waits: list[float] = []

    async def sleep(delay: float) -> None:
        waits.append(delay)
        clock.now += delay

    provider = FakeProvider([
        ModelProviderError(ModelErrorKind.TIMEOUT, "模型请求超时"),
        result({"value": "ok"}),
    ])
    _parsed, usage = await gateway(provider, clock, sleeper=sleep).generate_structured(
        request(),
        DemoResult,
    )

    # initial_delay=1、multiplier=2、random_source=0.5 → full jitter 取 0.5×1。
    assert waits == [0.5]
    assert usage.attempts == 2
    assert usage.network_retries == 1
    assert usage.fallbacks == 0


@pytest.mark.asyncio
async def test_missing_fallback_config_fails_closed() -> None:
    """AC6：没有显式配置备用模型时不得按名称或顺序猜测降级。"""

    clock = FakeClock()

    async def sleep(delay: float) -> None:
        clock.now += delay

    provider = FakeProvider([
        ModelProviderError(ModelErrorKind.TRANSIENT, "provider down"),
        ModelProviderError(ModelErrorKind.TRANSIENT, "provider down"),
        ModelProviderError(ModelErrorKind.TRANSIENT, "provider down"),
    ])
    with pytest.raises(ModelProviderError, match="provider down"):
        await gateway(provider, clock, sleeper=sleep).generate_structured(
            request(),
            DemoResult,
        )

    # 未配置备用模型时，attempt 预算全部留给主模型，不会凭空出现第二个模型 ID。
    assert [model for model, _call in provider.calls] == [
        "primary",
        "primary",
        "primary",
    ]


def test_graph_nodes_never_import_the_concrete_provider_adapter() -> None:
    """AC1：业务节点只依赖 ModelGateway port，不得静态耦合 DeepSeek adapter。"""

    source = (
        pathlib.Path(__file__).resolve().parents[1]
        / "app"
        / "graph"
        / "nodes.py"
    ).read_text(encoding="utf-8")
    tree = ast.parse(source)

    imported: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.append(node.module)

    assert not [name for name in imported if name.startswith("app.llm.deepseek")]
    assert "app.llm.ports" in imported


class SpanRecorder:
    def __init__(self) -> None:
        self.spans: list[Span] = []

    def emit(self, span: Span) -> None:
        self.spans.append(span)

    def flush(self) -> None:
        return None


def model_spans(recorder: SpanRecorder) -> list[Span]:
    return [span for span in recorder.spans if span.kind == "model"]


@pytest.mark.asyncio
async def test_model_span_separates_primary_from_effective_model() -> None:
    """AC6：span 必须能区分请求的模型、真正应答的模型与 fallback 次数。"""

    clock = FakeClock()

    async def sleep(delay: float) -> None:
        clock.now += delay

    provider = FakeProvider([
        ModelProviderError(ModelErrorKind.TRANSIENT, "provider down"),
        ModelProviderError(ModelErrorKind.TRANSIENT, "provider down"),
        result({"value": "fallback ok"}, model="fallback"),
    ])
    recorder = SpanRecorder()
    previous = bind_tracer(RunTracer("run_span", sink=recorder))
    try:
        await gateway(
            provider,
            clock,
            fallback_models={"primary": ("fallback",)},
            sleeper=sleep,
        ).generate_structured(request(), DemoResult)
    finally:
        unbind_tracer(previous)

    spans = model_spans(recorder)
    assert len(spans) == 1
    span = spans[0]
    assert span.name == "model:supervisor"
    assert span.status == "ok"
    assert span.attributes["gen_ai.request.model"] == "primary"
    assert span.attributes["gen_ai.response.model"] == "fallback"
    assert span.attributes["attempts"] == 3
    assert span.attributes["networkRetries"] == 1
    assert span.attributes["fallbacks"] == 1
    assert span.attributes["formatRepairs"] == 0


@pytest.mark.asyncio
async def test_failed_call_records_a_span_with_the_stable_error_kind() -> None:
    clock = FakeClock()
    provider = FakeProvider([
        ModelProviderError(ModelErrorKind.PERMANENT, "模型请求无效"),
    ])
    recorder = SpanRecorder()
    previous = bind_tracer(RunTracer("run_span", sink=recorder))
    try:
        with pytest.raises(ModelProviderError):
            await gateway(provider, clock).generate_structured(request(), DemoResult)
    finally:
        unbind_tracer(previous)

    span = model_spans(recorder)[0]
    assert span.status == "error"
    assert span.attributes["reasonCode"] == ModelErrorKind.PERMANENT.value
    assert span.attributes["fallbacks"] == 0


@pytest.mark.asyncio
async def test_external_cancellation_still_records_a_span_and_propagates() -> None:
    """AC3/AC4：取消必须原样传播，同时不丢掉已发生尝试的观测记录。"""

    clock = FakeClock()
    provider = FakeProvider([asyncio.CancelledError()])
    recorder = SpanRecorder()
    previous = bind_tracer(RunTracer("run_span", sink=recorder))
    try:
        with pytest.raises(asyncio.CancelledError):
            await gateway(provider, clock).generate_structured(request(), DemoResult)
    finally:
        unbind_tracer(previous)

    assert model_spans(recorder)[0].status == "error"


@pytest.mark.asyncio
async def test_no_span_is_recorded_when_tracing_is_off() -> None:
    """未绑定 tracer 时不取时间戳、不上报 span，行为与开启观测前完全一致。"""

    clock = FakeClock()
    provider = FakeProvider([result({"value": "ok"})])
    calls: list[dict[str, Any]] = []

    previous = bind_tracer(None)
    try:
        with pytest.MonkeyPatch.context() as patch:
            patch.setattr(
                "app.llm.gateway.record_model_call",
                lambda **kwargs: calls.append(kwargs),
            )
            _parsed, usage = await gateway(provider, clock).generate_structured(
                request(),
                DemoResult,
            )
    finally:
        unbind_tracer(previous)

    assert usage.attempts == 1
    assert calls == []


@pytest.mark.asyncio
async def test_stream_span_never_leaks_prompt_or_provider_body() -> None:
    """AC4：span 属性只允许受控标量，Prompt 与 Provider 正文不得进入观测。"""

    clock = FakeClock()
    provider = FakeProvider([])

    async def good_stream(
        call: ModelRequest,
        model_id: str,
    ) -> AsyncIterator[str | ModelResult]:
        del call
        yield "hello"
        yield result({"value": "ignored"}, model=model_id)

    provider.stream_factory = good_stream
    recorder = SpanRecorder()
    previous = bind_tracer(RunTracer("run_span", sink=recorder))
    try:
        async for _item in gateway(provider, clock).stream_text(request()):
            pass
    finally:
        unbind_tracer(previous)

    span = model_spans(recorder)[0]
    assert span.status == "ok"
    assert span.attributes["gen_ai.response.model"] == "primary"
    serialized = json.dumps(span.attributes, ensure_ascii=False)
    assert "return data" not in serialized
    assert not [key for key in span.attributes if "prompt" in key.lower()]
