"""运行时配置读取。

复用前端已有的 `config/agent-runtime.local.json`，不复制密钥、不新增配置文件。
该文件已被 `.gitignore` 忽略；本模块只在进程内持有密钥，
不写入日志、事件、trace 或任何返回给浏览器的内容。
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path


class ConfigError(RuntimeError):
    """配置缺失或非法。消息中不得包含密钥内容。"""


def config_path() -> Path:
    """定位统一配置文件。

    优先使用 `AGENT_RUNTIME_CONFIG_PATH`，与前端 `runtime-config.ts` 的
    覆盖方式保持一致；否则从本服务目录向上回溯到仓库根的 `config/`。
    """
    override = os.environ.get("AGENT_RUNTIME_CONFIG_PATH")
    if override:
        return Path(override).resolve()
    # app/config/runtime.py -> app/config -> app -> search-agent -> services -> 仓库根
    repo_root = Path(__file__).resolve().parents[4]
    return repo_root / "config" / "agent-runtime.local.json"


@dataclass(frozen=True)
class ModelDefinition:
    id: str
    name: str
    reasoning_efforts: tuple[str, ...]
    default_reasoning_effort: str


@dataclass(frozen=True)
class RuntimeConfig:
    """只暴露本服务需要的字段。"""

    api_key: str
    base_url: str
    default_model: str
    models: tuple[ModelDefinition, ...]
    timeout_ms: int
    max_retries: int
    temperature: float
    max_tokens: int
    thinking_enabled: bool
    system_prompt: str
    database_url: str | None

    def model(self, model_id: str | None = None) -> ModelDefinition:
        target = model_id or self.default_model
        for candidate in self.models:
            if candidate.id == target:
                return candidate
        raise ConfigError("请求的模型未在配置中定义")

    @property
    def timeout_seconds(self) -> float:
        return self.timeout_ms / 1000


def _chat_completions_to_base_url(endpoint: str) -> str:
    """把 `.../chat/completions` 还原成 OpenAI 兼容 base_url。

    配置里存的是完整聊天端点（前端直接 POST 它），
    而 langchain-openai 需要的是 base_url，由它自己补 `/chat/completions`。
    """
    trimmed = endpoint.rstrip("/")
    suffix = "/chat/completions"
    if not trimmed.endswith(suffix):
        raise ConfigError("模型接口必须指向 chat/completions")
    return trimmed[: -len(suffix)]


def load_runtime_config(path: Path | None = None) -> RuntimeConfig:
    target = path or config_path()
    if not target.is_file():
        raise ConfigError(f"统一配置文件不存在：{target}")

    raw = json.loads(target.read_text(encoding="utf-8"))
    provider = raw.get("provider") or {}
    generation = raw.get("generation") or {}
    request = provider.get("request") or {}

    api_key = provider.get("apiKey")
    if not isinstance(api_key, str) or not api_key.strip():
        raise ConfigError("缺少模型 API Key")

    models = tuple(
        ModelDefinition(
            id=item["id"],
            name=item.get("name", item["id"]),
            reasoning_efforts=tuple(item.get("reasoningEfforts", ())),
            default_reasoning_effort=item.get("defaultReasoningEffort", "medium"),
        )
        for item in provider.get("models", ())
        if isinstance(item, dict) and "id" in item
    )
    if not models:
        raise ConfigError("配置中没有可用模型")

    default_model = provider.get("defaultModel") or models[0].id
    if all(item.id != default_model for item in models):
        raise ConfigError("默认模型未在模型列表中定义")

    database = raw.get("database") or {}

    return RuntimeConfig(
        api_key=api_key,
        base_url=_chat_completions_to_base_url(provider.get("endpoint", "")),
        default_model=default_model,
        models=models,
        timeout_ms=int(request.get("timeoutMs", 120_000)),
        max_retries=int(request.get("maxRetries", 2)),
        temperature=float(generation.get("temperature", 0.6)),
        max_tokens=int(generation.get("maxTokens", 4096)),
        thinking_enabled=bool(generation.get("thinkingEnabled", True)),
        system_prompt=(raw.get("assistant") or {}).get("systemPrompt", ""),
        database_url=os.environ.get("SEARCH_AGENT_DATABASE_URL") or database.get("url"),
    )


@lru_cache(maxsize=1)
def runtime_config() -> RuntimeConfig:
    """进程级缓存。配置在启动时固定，运行中不热重载。"""
    return load_runtime_config()
