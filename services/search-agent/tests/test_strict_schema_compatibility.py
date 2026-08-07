from __future__ import annotations

import pytest
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

_DEEPSEEK_STRICT_FORMATS = {"email", "hostname", "ipv4", "ipv6", "uuid"}


def _schema_formats(value: object) -> set[str]:
    if isinstance(value, dict):
        current = {value["format"]} if isinstance(value.get("format"), str) else set()
        return current | set().union(*(_schema_formats(item) for item in value.values()))
    if isinstance(value, list):
        return set().union(*(_schema_formats(item) for item in value))
    return set()


def query_brief_payload() -> dict[str, object]:
    return {
        "version": 1,
        "objective": "核验 LangGraph Send API",
        "complexity": "multi_faceted",
        "entities": ["LangGraph", "Send"],
        "must": [
            {
                "constraint_id": "langgraph",
                "text": "LangGraph",
                "terms": ["LangGraph"],
            }
        ],
        "should": [],
        "exclude": [],
        "time_range": None,
        "locations": [],
        "languages": ["en"],
        "required_channels": ["web"],
        "requested_fields": ["API 用法"],
        "evidence_facets": [
            {
                "facet_id": "official",
                "description": "官方 API 文档",
                "evidence_type": "official",
                "required_fields": ["API 用法"],
            }
        ],
    }


@pytest.mark.parametrize("schema", PRODUCTION_STRUCTURED_SCHEMAS)
def test_every_production_structured_schema_is_provider_strict(schema) -> None:
    deepseek.validate_strict_schema(schema)


@pytest.mark.parametrize("schema", PRODUCTION_STRUCTURED_SCHEMAS)
def test_production_schemas_only_use_deepseek_supported_string_formats(schema) -> None:
    unsupported = _schema_formats(schema.model_json_schema()) - _DEEPSEEK_STRICT_FORMATS

    assert unsupported == set()


def test_semantically_empty_fields_are_required_and_must_be_explicit() -> None:
    step = {
        "local_id": "source_a",
        "facet_id": "official",
        "facet": "官方信息",
        "objective": "读取官方信息",
        "query_terms": ["LangGraph", "Send"],
        "strategy": "initial_precise",
        "query": "LangGraph Send API",
        "channel": "web",
        "gap_id": None,
        "parent_attempt_id": None,
        "retained_constraint_ids": ["langgraph", "required_channel:web"],
        "relaxed_should_ids": [],
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
        evidence_gaps=[],
        source_presentations=[],
        summary="证据充分",
    )
    verified = VerifyResult(
        passed=True,
        action="pass",
        issue="",
        extra_searches=[],
        evidence_gaps=[],
        summary="核验通过",
    )

    assert plan.steps[0].depends_on == []
    assert reflected.missing == ""
    assert reflected.extra_searches == []
    assert reflected.source_presentations == []
    assert verified.issue == ""
    assert verified.extra_searches == []


@pytest.mark.parametrize(
    "payload",
    [
        {
            "passed": True,
            "action": "rewrite",
            "issue": "需要改写",
            "extra_searches": [],
            "evidence_gaps": [],
            "summary": "状态矛盾",
        },
        {
            "passed": False,
            "action": "pass",
            "issue": "仍有问题",
            "extra_searches": [],
            "evidence_gaps": [],
            "summary": "状态矛盾",
        },
        {
            "passed": False,
            "action": "rewrite",
            "issue": "   ",
            "extra_searches": [],
            "evidence_gaps": [],
            "summary": "未说明失败原因",
        },
        {
            "passed": True,
            "action": "pass",
            "issue": "不应携带问题",
            "extra_searches": [],
            "evidence_gaps": [],
            "summary": "状态矛盾",
        },
        {
            "passed": True,
            "action": "research_more",
            "issue": "仍缺证据",
            "extra_searches": [{
                "query": "LangGraph Send official reference",
                "channel": "web",
                "facet_id": "official",
                "query_terms": ["LangGraph", "Send", "official"],
                "strategy": "terminology_variant",
                "gap_id": "gap_more",
                "parent_attempt_id": "attempt_parent",
                "retained_constraint_ids": ["langgraph", "required_channel:web"],
                "relaxed_should_ids": [],
            }],
            "evidence_gaps": [{
                "gap_id": "gap_more",
                "facet_id": "official",
                "kind": "no_results",
                "subject": None,
                "description": "仍缺官方候选",
                "missing_constraint_ids": [],
                "required_channel": "web",
                "evidence_type": "official",
                "priority": 100,
            }],
            "summary": "状态矛盾",
        },
    ],
)
def test_verify_result_rejects_contradictory_pass_state(payload: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        VerifyResult.model_validate(payload)


def test_intent_route_requires_channels_only_for_research() -> None:
    direct = IntentResult(
        task_type="direct_answer",
        need_search=False,
        channels=[],
        use_history=False,
        evidence_depth="multi_source",
        fast_search=None,
        query_brief=None,
        summary="直接回答当前问题",
    )
    research = IntentResult(
        task_type="research",
        need_search=True,
        channels=["web"],
        use_history=False,
        evidence_depth="multi_source",
        fast_search=None,
        query_brief=query_brief_payload(),
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
            query_brief=None,
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
            query_brief=query_brief_payload(),
            summary="无效搜索路由",
        )


def test_single_fact_requires_fast_search_and_single_channel() -> None:
    base = {
        "task_type": "research",
        "need_search": True,
        "use_history": False,
        "query_brief": query_brief_payload(),
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
            query_brief=None,
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
            query_brief=None,
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
        query_brief=query_brief_payload(),
        summary="检索今天星期几",
    )
    assert result.evidence_depth == "single_fact"
    assert result.fast_search is not None
    assert result.fast_search.query == "2026年8月3日 星期几"
    assert result.fast_search.channel == "web"


def test_research_intent_requires_private_query_brief_and_direct_route_forbids_it() -> None:
    with pytest.raises(ValidationError, match="query_brief"):
        IntentResult(
            task_type="research",
            need_search=True,
            channels=["web"],
            use_history=False,
            evidence_depth="multi_source",
            fast_search=None,
            query_brief=None,
            summary="缺少查询简报",
        )

    with pytest.raises(ValidationError, match="query_brief"):
        IntentResult(
            task_type="direct_answer",
            need_search=False,
            channels=[],
            use_history=False,
            evidence_depth="multi_source",
            fast_search=None,
            query_brief=query_brief_payload(),
            summary="直接回答不得携带查询简报",
        )


def test_follow_up_search_requires_typed_gap_and_lineage() -> None:
    gap = {
        "gap_id": "gap_zero",
        "facet_id": "official",
        "kind": "no_results",
        "subject": None,
        "description": "首轮没有候选",
        "missing_constraint_ids": [],
        "required_channel": "web",
        "evidence_type": "official",
        "priority": 100,
    }
    follow_up = {
        "query": "LangGraph Send official documentation",
        "channel": "web",
        "facet_id": "official",
        "query_terms": ["LangGraph", "Send", "official"],
        "strategy": "terminology_variant",
        "gap_id": "gap_zero",
        "parent_attempt_id": "attempt_0123456789abcdef01234567",
        "retained_constraint_ids": ["langgraph", "required_channel:web"],
        "relaxed_should_ids": [],
    }

    reflected = ReflectResult(
        sufficient=False,
        missing="首轮没有候选",
        extra_searches=[follow_up],
        evidence_gaps=[gap],
        source_presentations=[],
        summary="调整术语继续检索",
    )

    assert reflected.extra_searches[0].gap_id == "gap_zero"
    assert reflected.evidence_gaps[0].kind == "no_results"
    with pytest.raises(ValidationError):
        ReflectResult(
            sufficient=False,
            missing="首轮没有候选",
            extra_searches=[{key: value for key, value in follow_up.items() if key != "gap_id"}],
            evidence_gaps=[gap],
            source_presentations=[],
            summary="无效补搜",
        )
    with pytest.raises(ValidationError, match="gap_id 不得重复"):
        ReflectResult(
            sufficient=False,
            missing="存在两个不同缺口",
            extra_searches=[follow_up],
            evidence_gaps=[
                gap,
                {
                    **gap,
                    "description": "同一局部 ID 的另一个缺口",
                },
            ],
            source_presentations=[],
            summary="无效重复缺口",
        )


def test_preflight_rejects_optional_properties_before_provider_call() -> None:
    class OptionalResult(BaseModel):
        model_config = ConfigDict(extra="forbid")

        value: str = ""

    with pytest.raises(deepseek.StrictSchemaError) as error:
        deepseek.validate_strict_schema(OptionalResult)
    assert error.value.code == "STRICT_SCHEMA_INVALID"
    assert "optional fields" in str(error.value)
