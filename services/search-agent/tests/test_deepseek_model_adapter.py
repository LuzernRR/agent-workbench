from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from app.llm import deepseek
from app.llm.contracts import ModelErrorKind


def runtime() -> SimpleNamespace:
    return SimpleNamespace(
        api_key="sk-test-key-not-real",
        base_url="https://api.deepseek.com",
        timeout_seconds=30,
        model=lambda model_id: SimpleNamespace(id=model_id or "primary"),
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
