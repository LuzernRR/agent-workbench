from __future__ import annotations

import ast
import pathlib
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from openai import BadRequestError
from pydantic import BaseModel, ConfigDict

from app.llm import deepseek
from app.llm.contracts import ModelErrorKind, ModelMessage, ModelRequest


class DemoResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    value: str


def runtime() -> SimpleNamespace:
    return SimpleNamespace(
        api_key="sk-test-key-not-real",
        base_url="https://api.deepseek.com",
        timeout_seconds=30,
        model=lambda model_id: SimpleNamespace(id=model_id or "primary"),
    )


def adapter_request(*, task_type: str = "planner") -> ModelRequest:
    return ModelRequest(
        task_type=task_type,
        tenant_id="tenant_test",
        trace_id="run_test",
        model_id="test-model",
        messages=(ModelMessage(role="user", content="return structured data"),),
        response_schema=DemoResult.model_json_schema(),
        latency_slo_ms=5_000,
        max_output_tokens=100,
        cost_budget_usd=1.0,
        max_provider_attempts=1,
    )


def test_structured_sdk_client_has_no_hidden_retries(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    class Chat:
        def __init__(self, **kwargs: Any) -> None:
            captured.update(kwargs)

    deepseek._structured_chat_model.cache_clear()
    monkeypatch.setattr(deepseek, "runtime_config", runtime)
    monkeypatch.setattr(deepseek, "ChatOpenAI", Chat)

    deepseek._structured_chat_model("supervisor", "primary")

    assert captured["max_retries"] == 0
    assert captured["timeout"] == 30
    deepseek._structured_chat_model.cache_clear()


def test_streaming_sdk_client_has_no_hidden_retries(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    class Client:
        def __init__(self, **kwargs: Any) -> None:
            captured.update(kwargs)

    deepseek._research_client.cache_clear()
    monkeypatch.setattr(deepseek, "runtime_config", runtime)
    monkeypatch.setattr(deepseek, "AsyncOpenAI", Client)

    deepseek._research_client()

    assert captured["max_retries"] == 0
    assert captured["timeout"] == 30
    deepseek._research_client.cache_clear()


@pytest.mark.parametrize(
    "error, expected",
    [
        (httpx.TimeoutException("late"), ModelErrorKind.TIMEOUT),
        (
            SimpleNamespace(
                status_code=429,
                response=SimpleNamespace(headers={"Retry-After": "3"}),
            ),
            ModelErrorKind.RATE_LIMIT,
        ),
        (
            SimpleNamespace(status_code=503, response=SimpleNamespace(headers={})),
            ModelErrorKind.TRANSIENT,
        ),
        (
            SimpleNamespace(status_code=400, response=SimpleNamespace(headers={})),
            ModelErrorKind.PERMANENT,
        ),
    ],
)
def test_provider_errors_are_classified_without_exposing_bodies(
    error: BaseException | SimpleNamespace,
    expected: ModelErrorKind,
) -> None:
    normalized = deepseek._provider_error(error)  # type: ignore[arg-type]

    assert normalized.kind is expected
    assert "PRIVATE_PROVIDER_BODY" not in str(normalized)


def test_retry_after_is_preserved_for_gateway_budgeting() -> None:
    error = SimpleNamespace(
        status_code=429,
        response=SimpleNamespace(headers={"Retry-After": "4"}),
    )

    normalized = deepseek._provider_error(error)  # type: ignore[arg-type]

    assert normalized.retry_after_seconds == 4


class RejectingRunnable:
    async def ainvoke(self, _messages: list[Any]) -> dict[str, Any]:
        request = httpx.Request("POST", "https://provider.invalid/chat/completions")
        response = httpx.Response(400, request=request)
        raise BadRequestError(
            "PRIVATE_PROVIDER_BODY_SENTINEL",
            response=response,
            body={"error": {"message": "PRIVATE_PROVIDER_BODY_SENTINEL"}},
        )


class RejectingModel:
    def with_structured_output(
        self,
        schema: type[BaseModel],
        **kwargs: Any,
    ) -> RejectingRunnable:
        assert schema is DemoResult
        assert kwargs["strict"] is True
        return RejectingRunnable()


@pytest.mark.asyncio
async def test_provider_bad_request_becomes_stable_safe_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """400 归一为稳定错误码，Provider 正文绝不出现在异常文本里。"""

    monkeypatch.setattr(deepseek, "runtime_config", runtime)
    monkeypatch.setattr(
        deepseek,
        "_structured_chat_model",
        lambda _role, _model_id: RejectingModel(),
    )

    with pytest.raises(deepseek.StructuredProviderRequestError) as error:
        await deepseek.DeepSeekProviderAdapter().generate_structured(
            adapter_request(),
            DemoResult,
            model_id="test-model",
        )

    assert error.value.code == "MODEL_STRUCTURED_REQUEST_INVALID"
    assert "PRIVATE_PROVIDER_BODY_SENTINEL" not in str(error.value)


class UnparsableRunnable:
    def __init__(self) -> None:
        self.messages: list[list[Any]] = []

    async def ainvoke(self, messages: list[Any]) -> dict[str, Any]:
        self.messages.append(messages)
        return {
            "parsed": None,
            "raw": SimpleNamespace(
                usage_metadata={
                    "input_tokens": 10,
                    "output_tokens": 2,
                    "total_tokens": 12,
                },
                response_metadata={"finish_reason": "stop"},
            ),
            "parsing_error": ValueError("invalid schema"),
        }


@pytest.mark.asyncio
async def test_adapter_reports_schema_violation_as_empty_output_without_retrying(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """adapter 只做一次尝试：Schema 不合法时返回 output=None，由 Gateway 决定是否修复。"""

    runnable = UnparsableRunnable()
    monkeypatch.setattr(deepseek, "runtime_config", runtime)
    monkeypatch.setattr(
        deepseek,
        "_structured_chat_model",
        lambda _role, _model_id: SimpleNamespace(
            with_structured_output=lambda _schema, **_kwargs: runnable
        ),
    )

    result = await deepseek.DeepSeekProviderAdapter().generate_structured(
        adapter_request(),
        DemoResult,
        model_id="test-model",
    )

    # adapter 不自带修复循环，因此只有一次请求；真实 usage 仍如实回传。
    assert len(runnable.messages) == 1
    assert result.output is None
    assert result.input_tokens == 10
    assert result.output_tokens == 2


class ReasoningStream:
    """模拟开启 thinking 时的流：reasoning 增量与正文增量混在同一条流里。"""

    def __init__(self) -> None:
        self.chunks = [
            SimpleNamespace(
                usage=None,
                choices=[
                    SimpleNamespace(
                        delta=SimpleNamespace(
                            content=None,
                            reasoning_content="PRIVATE_CHAIN_OF_THOUGHT_SENTINEL",
                        )
                    )
                ],
            ),
            SimpleNamespace(
                usage=None,
                choices=[
                    SimpleNamespace(
                        delta=SimpleNamespace(
                            content="公开回答",
                            reasoning_content="PRIVATE_CHAIN_OF_THOUGHT_SENTINEL",
                        )
                    )
                ],
            ),
            SimpleNamespace(
                usage=SimpleNamespace(
                    prompt_tokens=11,
                    completion_tokens=4,
                    total_tokens=15,
                ),
                choices=[],
            ),
        ]

    def __aiter__(self) -> ReasoningStream:
        self._iterator = iter(self.chunks)
        return self

    async def __anext__(self) -> Any:
        try:
            return next(self._iterator)
        except StopIteration:
            raise StopAsyncIteration from None


@pytest.mark.asyncio
async def test_stream_never_forwards_reasoning_content_to_the_gateway(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """reasoning 增量在 adapter 边界被丢弃，绝不进入 Gateway、State 或事件。"""

    async def create(**_kwargs: Any) -> ReasoningStream:
        return ReasoningStream()

    monkeypatch.setattr(
        deepseek,
        "_research_client",
        lambda: SimpleNamespace(
            chat=SimpleNamespace(completions=SimpleNamespace(create=create))
        ),
    )

    deltas: list[str] = []
    final: Any = None
    request = adapter_request(task_type="writer")
    async for item in deepseek.DeepSeekProviderAdapter().stream_text(
        request,
        model_id="test-model",
    ):
        if isinstance(item, str):
            deltas.append(item)
        else:
            final = item

    # 只有 delta.content 被转发；reasoning_content 一个字符都不出现。
    assert deltas == ["公开回答"]
    assert "PRIVATE_CHAIN_OF_THOUGHT_SENTINEL" not in "".join(deltas)
    assert final is not None
    assert final.output == "streamed"
    assert "PRIVATE_CHAIN_OF_THOUGHT_SENTINEL" not in final.model_dump_json()
    # usage 仍如实回传，剥离 reasoning 不影响记账。
    assert final.input_tokens == 11
    assert final.output_tokens == 4


def test_adapter_emits_no_model_span_of_its_own(monkeypatch: pytest.MonkeyPatch) -> None:
    """model span 的唯一来源是 Gateway；adapter 内不得再有一套上报。"""

    source = pathlib.Path(deepseek.__file__).read_text(encoding="utf-8")

    assert "record_model_call" not in source
    assert "_record_model_span" not in source


def test_provider_network_calls_only_exist_inside_the_adapter() -> None:
    """守住单一模型路径：网络调用不得搬到 DeepSeekProviderAdapter 之外。"""

    path = pathlib.Path(deepseek.__file__)
    tree = ast.parse(path.read_text(encoding="utf-8"))

    adapter = next(
        node
        for node in tree.body
        if isinstance(node, ast.ClassDef) and node.name == "DeepSeekProviderAdapter"
    )
    inside_adapter = {id(node) for node in ast.walk(adapter)}

    network_calls: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
            continue
        attribute = node.func.attr
        if attribute not in {"ainvoke", "create"}:
            continue
        if id(node) not in inside_adapter:
            network_calls.append(f"{attribute} at line {node.lineno}")

    assert network_calls == []


def test_module_exposes_no_legacy_model_entry_points() -> None:
    """#43 遗留的第二条模型路径必须彻底消失，而不是靠调用方自觉不用。"""

    for name in (
        "invoke_structured",
        "stream_writer_answer",
        "invoke_researcher_turn",
        "_record_model_span",
        "ResearcherTurn",
        "ResearchToolCall",
    ):
        assert not hasattr(deepseek, name), name
