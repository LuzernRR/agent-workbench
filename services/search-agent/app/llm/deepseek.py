"""DeepSeek 模型接入层。

结构化语义节点使用关闭思考的 strict function calling；Researcher 的
工具子回合使用官方 OpenAI 兼容客户端和 thinking mode。后者必须在同一
节点内保留并回传 ``reasoning_content``，节点结束前立即丢弃，绝不进入
LangGraph State、checkpoint、事件或业务日志。
"""

from __future__ import annotations

import time
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass
from functools import cache
from typing import Any

import httpx
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI
from openai import (
    APIConnectionError,
    APIStatusError,
    APITimeoutError,
    AsyncOpenAI,
    BadRequestError,
)
from pydantic import BaseModel

from app.config.agent import agent_config
from app.config.runtime import runtime_config
from app.llm.contracts import (
    ModelErrorKind,
    ModelMessage,
    ModelRequest,
    ModelResult,
    ModelRole,
    ModelUsage,
    StrictSchemaError,
    StructuredOutputError,
    StructuredProviderRequestError,
    WriterStreamError,
)
from app.llm.contracts import add_usage as _add_usage
from app.llm.gateway import ModelProviderError
from app.observability.trace import (
    OTHER_GEN_AI_SYSTEM,
    gen_ai_system,
    record_model_call,
    span_now,
    tracing_enabled,
)
from app.reliability.retry import parse_retry_after

WRITER_MAX_TOKENS = 2048


def add_usage(
    current: dict[str, Any] | None,
    addition: ModelUsage,
) -> dict[str, int | float]:
    """兼容旧导入；业务节点迁移后应直接使用 provider 无关契约。"""
    return _add_usage(current, addition)

_ROLE_TEMPERATURE: dict[str, float] = {
    "supervisor": 0.0,
    "planner": 0.1,
    "reflector": 0.0,
    "writer": 0.2,
    "verifier": 0.0,
}

_ROLE_MAX_TOKENS: dict[str, int] = {
    "supervisor": 1024,
    "planner": 1600,
    "reflector": 1200,
    "writer": WRITER_MAX_TOKENS,
    "verifier": 1400,
}


@dataclass(frozen=True)
class ResearchToolCall:
    id: str
    name: str
    arguments: str


@dataclass(frozen=True)
class ResearcherTurn:
    # assistant_message may contain reasoning_content. It is deliberately
    # private to the in-node tool loop and must never be serialized elsewhere.
    assistant_message: dict[str, Any]
    tool_calls: tuple[ResearchToolCall, ...]
    content: str
    usage: ModelUsage
    finish_reason: str | None


def _beta_base_url(base_url: str) -> str:
    return f"{base_url.rstrip('/')}/beta"


def _cost(model_id: str, input_tokens: int, output_tokens: int) -> float:
    price = agent_config().pricing.models.get(model_id)
    if not price:
        # 未配置价格时不伪造费用；调用数与 Token 硬门禁仍生效。
        return 0.0
    return round(
        input_tokens * price.input_cache_miss_usd_per_million / 1_000_000
        + output_tokens * price.output_usd_per_million / 1_000_000,
        8,
    )


def _usage_from_langchain(message: object, model_id: str) -> ModelUsage:
    metadata = getattr(message, "usage_metadata", None) or {}
    input_tokens = int(metadata.get("input_tokens") or 0)
    output_tokens = int(metadata.get("output_tokens") or 0)
    total = int(metadata.get("total_tokens") or (input_tokens + output_tokens))
    return ModelUsage(
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        total_tokens=total,
        cost_usd=_cost(model_id, input_tokens, output_tokens),
    )


@cache
def validate_strict_schema(schema: type[BaseModel]) -> None:
    """递归验证 strict tool schema，避免把必然被拒绝的请求发给 Provider。"""

    document = schema.model_json_schema()

    def visit(value: Any, path: str) -> None:
        if isinstance(value, dict):
            if value.get("type") == "object":
                properties = set((value.get("properties") or {}).keys())
                required = set(value.get("required") or [])
                if value.get("additionalProperties") is not False:
                    raise StrictSchemaError(
                        f"{schema.__name__} strict object allows extra fields at {path}"
                    )
                if properties != required:
                    raise StrictSchemaError(
                        f"{schema.__name__} strict object has optional fields at {path}"
                    )
            for key, child in value.items():
                visit(child, f"{path}.{key}")
        elif isinstance(value, list):
            for index, child in enumerate(value):
                visit(child, f"{path}[{index}]")

    visit(document, "$")


@cache
def _structured_chat_model(role: ModelRole, model_id: str | None = None) -> ChatOpenAI:
    config = runtime_config()
    model = config.model(model_id)
    return ChatOpenAI(
        model=model.id,
        api_key=config.api_key,
        base_url=_beta_base_url(config.base_url),
        temperature=_ROLE_TEMPERATURE[role],
        max_tokens=_ROLE_MAX_TOKENS[role],
        timeout=config.timeout_seconds,
        max_retries=0,
        extra_body={"thinking": {"type": "disabled"}},
    )


def _gen_ai_system() -> str:
    """按 OTel 约定判定 gen_ai.system；配置不可读时降级，观测绝不影响模型调用。"""
    try:
        return gen_ai_system(runtime_config().base_url)
    except Exception:  # noqa: BLE001 - 观测属性取不到时降级为 _OTHER
        return OTHER_GEN_AI_SYSTEM


def _provider_error(exc: BaseException) -> ModelProviderError:
    """把 SDK/httpx 异常收敛为 Gateway 可判定的稳定类别。"""
    if isinstance(exc, (APITimeoutError, httpx.TimeoutException, TimeoutError)):
        return ModelProviderError(ModelErrorKind.TIMEOUT, "模型请求超时")

    status = getattr(exc, "status_code", None)
    response = getattr(exc, "response", None)
    headers = getattr(response, "headers", {}) if response is not None else {}
    retry_after = parse_retry_after(headers.get("Retry-After"))
    if status == 429:
        return ModelProviderError(
            ModelErrorKind.RATE_LIMIT,
            "模型请求受限",
            retry_after_seconds=retry_after,
        )
    if status == 408 or (isinstance(status, int) and status >= 500):
        return ModelProviderError(
            ModelErrorKind.TRANSIENT,
            "模型服务暂时不可用",
            retry_after_seconds=retry_after,
        )
    if isinstance(exc, (APIConnectionError, httpx.RequestError)):
        return ModelProviderError(ModelErrorKind.TRANSIENT, "模型网络不可用")
    if isinstance(exc, APIStatusError):
        return ModelProviderError(ModelErrorKind.PERMANENT, "模型请求被拒绝")
    return ModelProviderError(ModelErrorKind.PERMANENT, "模型调用失败")


def _to_langchain_messages(messages: tuple[ModelMessage, ...]) -> list[BaseMessage]:
    converted: list[BaseMessage] = []
    for message in messages:
        if message.role == "system":
            converted.append(SystemMessage(content=message.content))
        elif message.role == "user":
            converted.append(HumanMessage(content=message.content))
        elif message.role == "assistant":
            converted.append(AIMessage(content=message.content))
        else:
            raise ModelProviderError(
                ModelErrorKind.PERMANENT,
                "当前结构化模型请求不接受 tool message",
            )
    return converted


class DeepSeekProviderAdapter:
    """只执行一次 Provider 网络尝试；重试与 fallback 全部由 Gateway 管理。"""

    provider_name = "deepseek"

    @property
    def gen_ai_system(self) -> str:
        return _gen_ai_system()

    async def generate_structured(
        self,
        request: ModelRequest,
        schema: type[BaseModel],
        *,
        model_id: str,
    ) -> ModelResult:
        validate_strict_schema(schema)
        runnable = _structured_chat_model(
            request.task_type,
            model_id,
        ).with_structured_output(
            schema,
            method="function_calling",
            strict=True,
            include_raw=True,
        )
        started_at = time.monotonic()
        try:
            response = await runnable.ainvoke(_to_langchain_messages(request.messages))
        except BadRequestError as exc:
            raise StructuredProviderRequestError() from exc
        except Exception as exc:
            raise _provider_error(exc) from exc

        parsed = response.get("parsed") if isinstance(response, dict) else None
        raw = response.get("raw") if isinstance(response, dict) else None
        parsing_error = (
            response.get("parsing_error") if isinstance(response, dict) else None
        )
        usage = _usage_from_langchain(raw, model_id)
        metadata = getattr(raw, "response_metadata", None) or {}
        return ModelResult(
            provider=self.provider_name,
            model=model_id,
            output=(
                parsed.model_dump(mode="json")
                if not parsing_error and isinstance(parsed, schema)
                else None
            ),
            finish_reason=metadata.get("finish_reason"),
            input_tokens=usage.input_tokens,
            output_tokens=usage.output_tokens,
            cost_usd=usage.cost_usd,
            latency_ms=max(0, int((time.monotonic() - started_at) * 1000)),
            request_id=metadata.get("request_id"),
        )

    async def stream_text(
        self,
        request: ModelRequest,
        *,
        model_id: str,
    ) -> AsyncIterator[str | ModelResult]:
        payload = [message.model_dump() for message in request.messages]
        started_at = time.monotonic()
        input_tokens = 0
        output_tokens = 0
        total_tokens = 0
        produced = False
        try:
            stream = await _research_client().chat.completions.create(
                model=model_id,
                messages=payload,  # type: ignore[arg-type]
                max_tokens=request.max_output_tokens,
                temperature=_ROLE_TEMPERATURE[request.task_type],
                stream=True,
                stream_options={"include_usage": True},
                extra_body={
                    "thinking": {"type": "enabled" if request.thinking else "disabled"}
                },
            )
            async for chunk in stream:
                usage = getattr(chunk, "usage", None)
                if usage is not None:
                    input_tokens = int(getattr(usage, "prompt_tokens", 0) or 0)
                    output_tokens = int(getattr(usage, "completion_tokens", 0) or 0)
                    total_tokens = int(
                        getattr(usage, "total_tokens", 0)
                        or (input_tokens + output_tokens)
                    )
                if not chunk.choices:
                    continue
                delta = getattr(chunk.choices[0], "delta", None)
                text = getattr(delta, "content", None) if delta is not None else None
                if text:
                    produced = True
                    yield text
        except Exception as exc:
            raise _provider_error(exc) from exc

        yield ModelResult(
            provider=self.provider_name,
            model=model_id,
            output="streamed" if produced else None,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cost_usd=_cost(model_id, input_tokens, output_tokens),
            latency_ms=max(0, int((time.monotonic() - started_at) * 1000)),
            finish_reason="stop" if total_tokens or produced else None,
        )


def _record_model_span(
    role: str,
    model_id: str,
    started_at: str,
    status: str,
    usages: list[ModelUsage],
) -> None:
    """把一次模型调用（含全部 attempts）记为 model span；未开启 tracing 时为空操作。"""
    if not started_at:
        return
    record_model_call(
        role=role,
        model_id=model_id,
        system=_gen_ai_system(),
        started_at=started_at,
        ended_at=span_now(),
        status=status,  # type: ignore[arg-type]
        attributes={
            "inputTokens": sum(item.input_tokens for item in usages),
            "outputTokens": sum(item.output_tokens for item in usages),
            "totalTokens": sum(item.total_tokens for item in usages),
            "costUsd": round(sum(item.cost_usd for item in usages), 8),
            "attempts": len(usages),
        },
    )


async def invoke_structured[SchemaT: BaseModel](
    role: ModelRole,
    schema: type[SchemaT],
    messages: Sequence[BaseMessage],
    *,
    model_id: str | None = None,
    allow_repair: bool = False,
) -> tuple[SchemaT, ModelUsage]:
    """调用 strict 结构化节点，并对一次协议漂移执行有界修复。

    repair 只重新请求严格函数输出，不使用本地默认值伪造语义结果。调用方
    负责在 run state 中限制全程最多一次 repair；这里返回聚合后的真实 usage
    与 attempts，使失败后的成功调用也完整计入预算。
    """
    validate_strict_schema(schema)
    resolved_model = runtime_config().model(model_id).id
    runnable = _structured_chat_model(role, resolved_model).with_structured_output(
        schema,
        method="function_calling",
        strict=True,
        include_raw=True,
    )
    usages: list[ModelUsage] = []
    request_messages = list(messages)
    max_attempts = 2 if allow_repair else 1
    started_at = span_now() if tracing_enabled() else ""
    for attempt in range(max_attempts):
        try:
            result = await runnable.ainvoke(request_messages)
        except BadRequestError as exc:
            _record_model_span(role, resolved_model, started_at, "error", usages)
            raise StructuredProviderRequestError() from exc
        parsed = result.get("parsed") if isinstance(result, dict) else None
        raw = result.get("raw") if isinstance(result, dict) else None
        parsing_error = result.get("parsing_error") if isinstance(result, dict) else None
        usages.append(_usage_from_langchain(raw, resolved_model))
        if not parsing_error and isinstance(parsed, schema):
            _record_model_span(role, resolved_model, started_at, "ok", usages)
            return parsed, ModelUsage(
                input_tokens=sum(item.input_tokens for item in usages),
                output_tokens=sum(item.output_tokens for item in usages),
                total_tokens=sum(item.total_tokens for item in usages),
                cost_usd=round(sum(item.cost_usd for item in usages), 8),
                attempts=len(usages),
            )
        if attempt + 1 < max_attempts:
            request_messages = [
                *messages,
                HumanMessage(content=(
                    "上一轮没有返回可通过 Schema 校验的函数结果。"
                    "请只调用已提供的结构化输出函数，并严格满足所有字段、类型与枚举约束。"
                )),
            ]
    _record_model_span(role, resolved_model, started_at, "error", usages)
    raise StructuredOutputError(ModelUsage(
        input_tokens=sum(item.input_tokens for item in usages),
        output_tokens=sum(item.output_tokens for item in usages),
        total_tokens=sum(item.total_tokens for item in usages),
        cost_usd=round(sum(item.cost_usd for item in usages), 8),
        attempts=len(usages),
    ))


@cache
def _research_client() -> AsyncOpenAI:
    config = runtime_config()
    return AsyncOpenAI(
        api_key=config.api_key,
        base_url=_beta_base_url(config.base_url),
        timeout=config.timeout_seconds,
        max_retries=0,
    )


def _reasoning_effort(value: str) -> str:
    if value in {"xhigh", "max"}:
        return "max"
    return "high"


async def invoke_researcher_turn(
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None,
    *,
    model_id: str | None = None,
    reasoning_effort: str = "high",
    thinking: bool = True,
    tool_choice: str | None = None,
) -> ResearcherTurn:
    """执行一个 thinking + tool-calling 子回合。

    DeepSeek 当前不接受 thinking mode 下的 ``tool_choice=required``。
    调用方因此在工具选择子回合关闭 thinking 并强制 required，在收到真实
    tool message 后再开启 thinking 完成 observation。
    """
    config = runtime_config()
    resolved_model = config.model(model_id).id
    request: dict[str, Any] = {
        "model": resolved_model,
        "messages": messages,
        "max_tokens": 3072,
        "extra_body": {"thinking": {"type": "enabled" if thinking else "disabled"}},
    }
    if thinking:
        request["extra_body"]["reasoning_effort"] = _reasoning_effort(reasoning_effort)
    if tools:
        request["tools"] = tools
        request["parallel_tool_calls"] = False
    if tool_choice is not None:
        request["tool_choice"] = tool_choice
    started_at = span_now() if tracing_enabled() else ""
    try:
        response = await _research_client().chat.completions.create(
            **request,
        )
    except Exception:
        _record_model_span("researcher", resolved_model, started_at, "error", [])
        raise
    choice = response.choices[0]
    assistant = choice.message.model_dump(exclude_none=True)
    calls = tuple(
        ResearchToolCall(
            id=call.id,
            name=call.function.name,
            arguments=call.function.arguments,
        )
        for call in (choice.message.tool_calls or [])
    )
    usage = response.usage
    input_tokens = int(getattr(usage, "prompt_tokens", 0) or 0)
    output_tokens = int(getattr(usage, "completion_tokens", 0) or 0)
    turn_usage = ModelUsage(
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        total_tokens=int(getattr(usage, "total_tokens", 0) or (input_tokens + output_tokens)),
        cost_usd=_cost(resolved_model, input_tokens, output_tokens),
    )
    _record_model_span("researcher", resolved_model, started_at, "ok", [turn_usage])
    return ResearcherTurn(
        assistant_message=assistant,
        tool_calls=calls,
        content=choice.message.content or "",
        usage=turn_usage,
        finish_reason=choice.finish_reason,
    )


async def stream_writer_answer(
    messages: Sequence[BaseMessage],
    *,
    model_id: str | None = None,
) -> AsyncIterator[str | ModelUsage]:
    """流式生成面向用户的回答正文。

    Writer 产出的是给人看的自然语言，不承载任何工具调用语义，因此这里走
    纯 content 流式而非 strict function calling：``delta.content`` 本身就是
    可直接显示的文本，无需增量解析 JSON，也不依赖字段输出顺序。

    先产出若干 ``str`` 增量，最后产出一个 ``ModelUsage`` 作为终结项。
    调用方据此拼接正文并累加真实用量。
    """
    config = runtime_config()
    resolved_model = config.model(model_id).id
    payload: list[dict[str, str]] = []
    for message in messages:
        role = "system" if isinstance(message, SystemMessage) else "user"
        payload.append({"role": role, "content": str(message.content)})
    started_at = span_now() if tracing_enabled() else ""
    input_tokens = 0
    output_tokens = 0
    total_tokens = 0
    produced = False
    try:
        stream = await _research_client().chat.completions.create(
            model=resolved_model,
            messages=payload,  # type: ignore[arg-type]
            max_tokens=_ROLE_MAX_TOKENS["writer"],
            temperature=_ROLE_TEMPERATURE["writer"],
            stream=True,
            stream_options={"include_usage": True},
            extra_body={"thinking": {"type": "disabled"}},
        )
        async for chunk in stream:
            usage = getattr(chunk, "usage", None)
            if usage is not None:
                input_tokens = int(getattr(usage, "prompt_tokens", 0) or 0)
                output_tokens = int(getattr(usage, "completion_tokens", 0) or 0)
                total_tokens = int(
                    getattr(usage, "total_tokens", 0) or (input_tokens + output_tokens)
                )
            if not chunk.choices:
                continue
            delta = getattr(chunk.choices[0], "delta", None)
            text = getattr(delta, "content", None) if delta is not None else None
            if text:
                produced = True
                yield text
    except Exception:
        _record_model_span("writer", resolved_model, started_at, "error", [])
        raise
    stream_usage = ModelUsage(
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        total_tokens=total_tokens or (input_tokens + output_tokens),
        cost_usd=_cost(resolved_model, input_tokens, output_tokens),
    )
    if not produced:
        _record_model_span("writer", resolved_model, started_at, "error", [stream_usage])
        raise WriterStreamError(stream_usage)
    _record_model_span("writer", resolved_model, started_at, "ok", [stream_usage])
    yield stream_usage
