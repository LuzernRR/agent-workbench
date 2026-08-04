from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.config.runtime import ConfigError, load_runtime_config


def config(models: list[dict[str, object]]) -> dict[str, object]:
    return {
        "provider": {
            "apiKey": "sk-test-key-not-real",
            "endpoint": "https://api.deepseek.com/chat/completions",
            "defaultModel": "primary",
            "models": models,
            "request": {"timeoutMs": 30_000, "maxRetries": 2},
        },
        "generation": {},
        "assistant": {"systemPrompt": "test"},
    }


def write_config(tmp_path: Path, value: dict[str, object]) -> Path:
    path = tmp_path / "runtime.json"
    path.write_text(json.dumps(value), encoding="utf-8")
    return path


def model(
    model_id: str,
    efforts: list[str],
    *,
    fallback: str | None = None,
) -> dict[str, object]:
    value: dict[str, object] = {
        "id": model_id,
        "name": model_id,
        "reasoningEfforts": efforts,
        "defaultReasoningEffort": efforts[0],
    }
    if fallback is not None:
        value["fallbackModel"] = fallback
    return value


def test_explicit_fallback_requires_equal_or_greater_capability(tmp_path: Path) -> None:
    loaded = load_runtime_config(write_config(tmp_path, config([
        model("primary", ["medium", "high"], fallback="stronger"),
        model("stronger", ["medium", "high", "xhigh"]),
    ])))

    assert loaded.model("primary").fallback_model == "stronger"


@pytest.mark.parametrize(
    "models, message",
    [
        ([model("primary", ["high"], fallback="missing")], "另一个已定义模型"),
        ([model("primary", ["high"], fallback="primary")], "另一个已定义模型"),
        (
            [
                model("primary", ["medium", "high"], fallback="weaker"),
                model("weaker", ["medium"]),
            ],
            "推理能力不能低于主模型",
        ),
    ],
)
def test_invalid_fallback_route_fails_closed(
    tmp_path: Path,
    models: list[dict[str, object]],
    message: str,
) -> None:
    with pytest.raises(ConfigError, match=message):
        load_runtime_config(write_config(tmp_path, config(models)))
