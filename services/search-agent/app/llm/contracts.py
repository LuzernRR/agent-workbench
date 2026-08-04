"""Provider 无关的模型调用契约与稳定错误。"""

from __future__ import annotations

from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

type ModelRole = Literal["supervisor", "planner", "reflector", "writer", "verifier"]


class ModelErrorKind(StrEnum):
    RATE_LIMIT = "rate_limit"
    TIMEOUT = "timeout"
    TRANSIENT = "transient"
    PERMANENT = "permanent"
    INVALID_OUTPUT = "invalid_output"


class ModelMessage(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    role: Literal["system", "user", "assistant", "tool"]
    content: str


class ModelRequest(BaseModel):
    """一次业务模型请求；只包含可路由、可预算的内部字段。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    task_type: ModelRole
    tenant_id: str = Field(min_length=1, max_length=128)
    trace_id: str = Field(min_length=1, max_length=160)
    model_id: str = Field(min_length=1, max_length=160)
    messages: tuple[ModelMessage, ...] = Field(min_length=1)
    response_schema: dict[str, Any] | None = None
    tools: tuple[dict[str, Any], ...] = ()
    latency_slo_ms: int = Field(ge=1, le=600_000)
    max_output_tokens: int = Field(ge=1, le=65_536)
    cost_budget_usd: float = Field(ge=0, le=10_000)
    max_provider_attempts: int = Field(ge=1, le=64)
    reasoning_effort: str | None = Field(default=None, max_length=32)
    thinking: bool = False


class ModelAttempt(BaseModel):
    """安全的调用事实；不含消息、响应正文、Header 或凭据。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    attempt: int = Field(ge=1)
    provider: str = Field(min_length=1, max_length=80)
    model: str = Field(min_length=1, max_length=160)
    phase: Literal["primary", "network_retry", "format_repair", "fallback"]
    status: Literal["ok", "error", "invalid_output"]
    error_kind: ModelErrorKind | None = None
    latency_ms: int = Field(ge=0)


class ModelResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    provider: str = Field(min_length=1, max_length=80)
    model: str = Field(min_length=1, max_length=160)
    output: dict[str, Any] | str | None
    finish_reason: str | None = Field(default=None, max_length=80)
    input_tokens: int = Field(default=0, ge=0)
    output_tokens: int = Field(default=0, ge=0)
    cached_tokens: int = Field(default=0, ge=0)
    cost_usd: float = Field(default=0.0, ge=0)
    latency_ms: int = Field(default=0, ge=0)
    request_id: str | None = Field(default=None, max_length=200)


class ModelUsage(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    input_tokens: int = Field(default=0, ge=0)
    output_tokens: int = Field(default=0, ge=0)
    total_tokens: int = Field(default=0, ge=0)
    cost_usd: float = Field(default=0.0, ge=0)
    attempts: int = Field(default=1, ge=0)
    network_retries: int = Field(default=0, ge=0)
    format_repairs: int = Field(default=0, ge=0)
    fallbacks: int = Field(default=0, ge=0)
    primary_model: str | None = None
    effective_model: str | None = None
    attempt_details: tuple[ModelAttempt, ...] = ()

    def as_dict(self) -> dict[str, int | float]:
        return {
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "total_tokens": self.total_tokens,
            "cost_usd": self.cost_usd,
        }


class StructuredOutputError(RuntimeError):
    """严格结构化输出在一次受控修复后仍不合法。"""

    def __init__(self, usage: ModelUsage) -> None:
        super().__init__("模型结构化输出校验失败")
        self.usage = usage


class StrictSchemaError(RuntimeError):
    code = "STRICT_SCHEMA_INVALID"


class StructuredProviderRequestError(RuntimeError):
    code = "MODEL_STRUCTURED_REQUEST_INVALID"

    def __init__(self) -> None:
        super().__init__("模型结构化请求未被 Provider 接受")


class WriterStreamError(RuntimeError):
    code = "WRITER_STREAM_FAILED"

    def __init__(self, usage: ModelUsage) -> None:
        super().__init__("模型流式回答生成失败")
        self.usage = usage


def add_usage(
    current: dict[str, Any] | None,
    addition: ModelUsage,
) -> dict[str, int | float]:
    current = current or {}
    return {
        "input_tokens": int(current.get("input_tokens") or 0) + addition.input_tokens,
        "output_tokens": int(current.get("output_tokens") or 0) + addition.output_tokens,
        "total_tokens": int(current.get("total_tokens") or 0) + addition.total_tokens,
        "cost_usd": round(float(current.get("cost_usd") or 0) + addition.cost_usd, 8),
    }
