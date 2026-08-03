from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from langchain_core.messages import HumanMessage
from openai import BadRequestError
from pydantic import BaseModel, ConfigDict, ValidationError

from app.graph.schemas import (
    IntentResult,
    PlanResult,
    ReflectResult,
    SourcePresentationResult,
    VerifyResult,
)
from app.llm import deepseek

# 结构化输出只服务于 Agent 的工具调用与内部决策；Writer 产出的是面向用户的
# 自然语言，走纯 content 流式，因此不在这里登记任何撰写用 schema。
PRODUCTION_STRUCTURED_SCHEMAS = (
    IntentResult,
    PlanResult,
    ReflectResult,
    SourcePresentationResult,
    VerifyResult,
)


@pytest.mark.parametrize("schema", PRODUCTION_STRUCTURED_SCHEMAS)
def test_every_production_structured_schema_is_provider_strict(schema) -> None:
    deepseek.validate_strict_schema(schema)


def test_semantically_empty_fields_are_required_and_must_be_explicit() -> None:
    step = {
        "local_id": "source_a",
        "facet": "官方信息",
        "objective": "读取官方信息",
        "query": "LangGraph Send API",
        "channel": "web",
        "priority": 100,
        "evidence_needed": 1,
        "can_parallelize": True,
    }
    with pytest.raises(ValidationError):
        PlanResult(steps=[step], summary="读取官方信息")
    with pytest.raises(ValidationError):
        ReflectResult(sufficient=True, summary="证据充分")
    with pytest.raises(ValidationError):
        VerifyResult(passed=True, action="pass", summary="核验通过")

    plan = PlanResult(
        steps=[{**step, "depends_on": []}],
        summary="读取官方信息",
    )
    reflected = ReflectResult(
        sufficient=True,
        missing="",
        extra_searches=[],
        source_presentations=[],
        summary="证据充分",
    )
    verified = VerifyResult(
        passed=True,
        action="pass",
        issue="",
        extra_searches=[],
        summary="核验通过",
    )

    assert plan.steps[0].depends_on == []
    assert reflected.missing == ""
    assert reflected.extra_searches == []
    assert reflected.source_presentations == []
    assert verified.issue == ""
    assert verified.extra_searches == []


def test_intent_route_requires_channels_only_for_research() -> None:
    direct = IntentResult(
        task_type="direct_answer",
        need_search=False,
        channels=[],
        use_history=False,
        evidence_depth="multi_source",
        fast_search=None,
        summary="直接回答当前问题",
    )
    research = IntentResult(
        task_type="research",
        need_search=True,
        channels=["web"],
        use_history=False,
        evidence_depth="multi_source",
        fast_search=None,
        summary="检索当前资料",
    )

    assert direct.channels == []
    assert research.channels == ["web"]
    with pytest.raises(ValidationError):
        IntentResult(
            task_type="direct_answer",
            need_search=False,
            channels=["web"],
            use_history=False,
            evidence_depth="multi_source",
            fast_search=None,
            summary="无效直接路由",
        )
    with pytest.raises(ValidationError):
        IntentResult(
            task_type="research",
            need_search=True,
            channels=[],
            use_history=False,
            evidence_depth="multi_source",
            fast_search=None,
            summary="无效搜索路由",
        )


def test_single_fact_requires_fast_search_and_single_channel() -> None:
    base = {
        "task_type": "research",
        "need_search": True,
        "use_history": False,
        "summary": "检索当前日期",
    }
    # A1：single_fact 未给出 fast_search 必须被拒绝。
    with pytest.raises(ValidationError, match="fast_search"):
        IntentResult(**base, channels=["web"], evidence_depth="single_fact", fast_search=None)
    # A2：single_fact 只允许一个渠道。
    with pytest.raises(ValidationError, match="一个渠道"):
        IntentResult(
            **base,
            channels=["web", "x"],
            evidence_depth="single_fact",
            fast_search={"query": "今天几号", "channel": "web"},
        )
    # A3：fast_search 渠道必须在 channels 内。
    with pytest.raises(ValidationError, match="channels 内"):
        IntentResult(
            **base,
            channels=["web"],
            evidence_depth="single_fact",
            fast_search={"query": "今天几号", "channel": "x"},
        )
    # A4：need_search=false 时 single_fact 与 fast_search 均不得出现。
    with pytest.raises(ValidationError, match="multi_source"):
        IntentResult(
            task_type="direct_answer",
            need_search=False,
            channels=[],
            use_history=False,
            evidence_depth="single_fact",
            fast_search=None,
            summary="直接回答",
        )
    with pytest.raises(ValidationError, match="fast_search"):
        IntentResult(
            task_type="direct_answer",
            need_search=False,
            channels=[],
            use_history=False,
            evidence_depth="multi_source",
            fast_search={"query": "今天几号", "channel": "web"},
            summary="直接回答",
        )


def test_single_fact_valid_combination_is_accepted() -> None:
    result = IntentResult(
        task_type="research",
        need_search=True,
        channels=["web"],
        use_history=False,
        evidence_depth="single_fact",
        fast_search={"query": "2026年8月3日 星期几", "channel": "web"},
        summary="检索今天星期几",
    )
    assert result.evidence_depth == "single_fact"
    assert result.fast_search is not None
    assert result.fast_search.query == "2026年8月3日 星期几"
    assert result.fast_search.channel == "web"


def test_preflight_rejects_optional_properties_before_provider_call() -> None:
    class OptionalResult(BaseModel):
        model_config = ConfigDict(extra="forbid")

        value: str = ""

    with pytest.raises(deepseek.StrictSchemaError) as error:
        deepseek.validate_strict_schema(OptionalResult)
    assert error.value.code == "STRICT_SCHEMA_INVALID"
    assert "optional fields" in str(error.value)


class ValidResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    value: str


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
        assert schema is ValidResult
        assert kwargs["strict"] is True
        return RejectingRunnable()


@pytest.mark.asyncio
async def test_provider_bad_request_becomes_stable_safe_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = SimpleNamespace(model=lambda _model_id: SimpleNamespace(id="test-model"))
    monkeypatch.setattr(deepseek, "runtime_config", lambda: config)
    monkeypatch.setattr(
        deepseek,
        "_structured_chat_model",
        lambda _role, _model_id: RejectingModel(),
    )

    with pytest.raises(deepseek.StructuredProviderRequestError) as error:
        await deepseek.invoke_structured(
            "planner",
            ValidResult,
            [HumanMessage(content="return structured data")],
        )

    assert error.value.code == "MODEL_STRUCTURED_REQUEST_INVALID"
    assert "PRIVATE_PROVIDER_BODY_SENTINEL" not in str(error.value)
