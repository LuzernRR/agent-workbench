from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from langchain_core.messages import HumanMessage
from pydantic import BaseModel, ConfigDict

from app.llm import deepseek


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

    with pytest.raises(RuntimeError, match="结构化输出校验失败"):
        await deepseek.invoke_structured(
            "supervisor",
            DemoResult,
            [HumanMessage(content="return structured data")],
            allow_repair=False,
        )

    assert len(runnable.messages) == 1
