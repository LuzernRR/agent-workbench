"""DeepSeek 模型接入层。

结构化语义节点使用关闭思考的 strict function calling；Researcher 的
工具子回合使用官方 OpenAI 兼容客户端和 thinking mode。后者必须在同一
节点内保留并回传 ``reasoning_content``，节点结束前立即丢弃，绝不进入
LangGraph State、checkpoint、事件或业务日志。
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from functools import cache
from typing import Any, Literal

from langchain_core.messages import BaseMessage, HumanMessage
from langchain_openai import ChatOpenAI
from openai import AsyncOpenAI, BadRequestError
from pydantic import BaseModel

from app.config.agent import agent_config
from app.config.runtime import runtime_config

ModelRole = Literal["supervisor", "planner", "reflector", "writer", "verifier"]
WRITER_MAX_TOKENS = 2048

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
class ModelUsage:
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    cost_usd: float = 0.0
    attempts: int = 1

    def as_dict(self) -> dict[str, int | float]:
        return {
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "total_tokens": self.total_tokens,
            "cost_usd": self.cost_usd,
        }


class StructuredOutputError(RuntimeError):
    """严格函数输出在有界修复后仍无法通过 Schema。"""

    def __init__(self, usage: ModelUsage) -> None:
        super().__init__("模型结构化输出校验失败")
        self.usage = usage


class StrictSchemaError(RuntimeError):
    """生产 strict function Schema 不满足 Provider 的静态约束。"""

    code = "STRICT_SCHEMA_INVALID"


class StructuredProviderRequestError(RuntimeError):
    """Provider 在生成前拒绝 strict structured-output 请求。"""

    code = "MODEL_STRUCTURED_REQUEST_INVALID"

    def __init__(self) -> None:
        super().__init__("模型结构化请求未被 Provider 接受")


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
        max_retries=config.max_retries,
        extra_body={"thinking": {"type": "disabled"}},
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
    for attempt in range(max_attempts):
        try:
            result = await runnable.ainvoke(request_messages)
        except BadRequestError as exc:
            raise StructuredProviderRequestError() from exc
        parsed = result.get("parsed") if isinstance(result, dict) else None
        raw = result.get("raw") if isinstance(result, dict) else None
        parsing_error = result.get("parsing_error") if isinstance(result, dict) else None
        usages.append(_usage_from_langchain(raw, resolved_model))
        if not parsing_error and isinstance(parsed, schema):
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
        max_retries=config.max_retries,
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
    response = await _research_client().chat.completions.create(
        **request,
    )
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
    return ResearcherTurn(
        assistant_message=assistant,
        tool_calls=calls,
        content=choice.message.content or "",
        usage=ModelUsage(
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            total_tokens=int(getattr(usage, "total_tokens", 0) or (input_tokens + output_tokens)),
            cost_usd=_cost(resolved_model, input_tokens, output_tokens),
        ),
        finish_reason=choice.finish_reason,
    )


def add_usage(current: dict[str, Any] | None, addition: ModelUsage) -> dict[str, int | float]:
    current = current or {}
    return {
        "input_tokens": int(current.get("input_tokens") or 0) + addition.input_tokens,
        "output_tokens": int(current.get("output_tokens") or 0) + addition.output_tokens,
        "total_tokens": int(current.get("total_tokens") or 0) + addition.total_tokens,
        "cost_usd": round(float(current.get("cost_usd") or 0) + addition.cost_usd, 8),
    }
