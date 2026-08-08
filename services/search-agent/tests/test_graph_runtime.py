from __future__ import annotations

import asyncio
import copy
import json
import re
import time
import uuid
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, get_args

import pytest

from app.config.agent import agent_config
from app.events.runtime import begin_event_scope, end_event_scope
from app.graph import nodes
from app.graph.build import _AGENT_BY_NODE, _novel_public_summary, build_graph
from app.graph.context import RunContext
from app.graph.query_strategy import (
    QueryBrief,
    constraint_signature,
    hard_constraint_ids,
    validate_query_proposal,
)
from app.graph.schemas import (
    ANSWER_MAX_CHARS,
    STRUCTURED_ANSWER_MAX_CHARS,
    IntentResult,
    PlanResult,
    ReflectResult,
    SourcePresentationResult,
    VerifyResult,
)
from app.graph.state import NodeName, initial_state
from app.llm.contracts import (
    ModelRequest,
    ModelUsage,
    StructuredOutputError,
    WriterStreamError,
)
from app.observability.span import Span
from app.observability.trace import RunTracer
from app.persistence.tool_ledger import (
    LedgerDecision,
    ToolLedgerSettlement,
    canonical_payload,
    payload_hash,
    safe_result_payload,
)
from app.tools.channels.base import (
    ChannelProgress,
    ChannelVerificationUpdate,
    SourceProvenance,
    channel_resolution,
)
from app.tools.gateway import ToolGateway
from app.tools.search_tool import (
    PublicSearchResult,
    SearchEvidence,
    SearchExecutionResult,
)
from app.tools.xiaohongshu_verification import XiaohongshuVerificationRegistry


def test_node_name_contract_covers_every_evented_graph_node() -> None:
    graph_nodes = set(build_graph().get_graph().nodes) - {"__start__", "__end__"}
    assert set(get_args(NodeName)) == set(_AGENT_BY_NODE) == graph_nodes


def _checkpoint_query_brief() -> QueryBrief:
    return QueryBrief.model_validate({
        "version": 1,
        "objective": "核验 Product 的官方 API",
        "complexity": "multi_faceted",
        "entities": ["Product"],
        "must": [{
            "constraint_id": "product",
            "text": "Product",
            "terms": ["Product"],
        }],
        "should": [],
        "exclude": [],
        "time_range": None,
        "locations": [],
        "languages": ["en"],
        "required_channels": ["web"],
        "requested_fields": ["API"],
        "evidence_facets": [{
            "facet_id": "official",
            "description": "官方 API",
            "evidence_type": "official",
            "required_fields": ["API"],
        }],
    })


def _pending_collision_fixture(
    collision: str,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    payload = _checkpoint_query_brief().model_dump(mode="json")
    payload["evidence_facets"] = [
        *payload["evidence_facets"],
        {
            "facet_id": "comparison",
            "description": "API 对比信息",
            "evidence_type": "comparison",
            "required_fields": ["API"],
        },
    ]
    query_brief = QueryBrief.model_validate(payload)
    state = initial_state("Product API")
    state["run_id"] = f"run_pending_collision_{collision}"
    state["intent"] = {"channels": ["web"]}
    state["query_brief"] = query_brief.model_dump(mode="json")
    state["round"] = 1
    retained = list(hard_constraint_ids(query_brief))

    def accepted(facet_id: str, query: str, step_id: str) -> dict[str, Any]:
        value = validate_query_proposal(
            query_brief,
            {
                "query": query,
                "channel": "web",
                "facet_id": facet_id,
                "query_terms": query.split(),
                "strategy": "initial_precise",
                "gap_id": None,
                "parent_attempt_id": None,
                "retained_constraint_ids": retained,
                "relaxed_should_ids": [],
            },
            run_id=state["run_id"],
            iteration=1,
            initial=True,
            allowed_channels={"web"},
            prior_attempts=[],
            open_gaps=[],
        )
        return {**value, "step_id": step_id}

    first = accepted("official", "Product API", "step_official")
    if collision == "attempt_id":
        second = {**first, "step_id": "step_comparison"}
    elif collision == "step_id":
        second = accepted("comparison", "Product SDK", first["step_id"])
    else:
        second = accepted("comparison", first["query"], "step_comparison")
    return state, first, second


def test_legacy_checkpoint_request_is_migrated_with_current_query_contract() -> None:
    state = initial_state("legacy checkpoint")
    state["intent"] = {"channels": ["web"]}
    state["round"] = 1

    first = nodes._normalized_search_request(
        state,
        {"query": "legacy query", "channel": "web"},
    )
    second = nodes._normalized_search_request(
        state,
        {"query": "legacy query", "channel": "web"},
    )

    assert first == second
    assert first is not None
    assert first["constraint_signature"] == constraint_signature(
        nodes._state_query_brief(state)
    )
    assert first["retained_constraint_ids"] == list(
        hard_constraint_ids(nodes._state_query_brief(state))
    )
    assert first["attempt_id"].startswith("attempt_")


def test_only_historical_legacy_search_can_recover_without_intent_channel() -> None:
    payload = _checkpoint_query_brief().model_dump(mode="json")
    payload["required_channels"] = []
    state = initial_state("Product API")
    state["intent"] = {"channels": []}
    state["query_brief"] = QueryBrief.model_validate(payload).model_dump(mode="json")
    legacy = {"query": "Product API", "channel": "web"}

    assert nodes._normalized_search_request(state, legacy, historical=True) is not None

    state["pending_searches"] = [legacy]  # type: ignore[list-item]
    assert nodes._pending_searches(state) == []


def test_structured_pending_request_cannot_self_authorize_its_channel() -> None:
    payload = _checkpoint_query_brief().model_dump(mode="json")
    payload["required_channels"] = []
    query_brief = QueryBrief.model_validate(payload)
    state = initial_state("Product API")
    state["run_id"] = "run_pending_channel_scope"
    state["intent"] = {"channels": ["web"]}
    state["query_brief"] = query_brief.model_dump(mode="json")
    state["round"] = 1
    request = validate_query_proposal(
        query_brief,
        {
            "query": "Product API",
            "channel": "x",
            "facet_id": "official",
            "query_terms": ["Product", "API"],
            "strategy": "initial_precise",
            "gap_id": None,
            "parent_attempt_id": None,
            "retained_constraint_ids": list(hard_constraint_ids(query_brief)),
            "relaxed_should_ids": [],
        },
        run_id=state["run_id"],
        iteration=1,
        initial=True,
        allowed_channels={"x"},
        prior_attempts=[],
        open_gaps=[],
    )

    assert nodes._normalized_search_request(state, request) is None
    state["pending_searches"] = [request]  # type: ignore[list-item]
    assert nodes._pending_searches(state) == []
    assert nodes.build_research_work_items(state) == []


@pytest.mark.parametrize("collision", ["attempt_id", "step_id", "query_channel"])
def test_pending_search_batch_fails_closed_on_duplicate_identity(collision: str) -> None:
    state, first, second = _pending_collision_fixture(collision)
    state["pending_searches"] = [first, second]  # type: ignore[list-item]

    assert nodes._pending_searches(state) == []
    assert nodes.build_research_work_items(state) == []


def test_initial_plan_with_distributed_should_constraints_compiles_all_branches() -> None:
    """首轮计划整体覆盖 should 后，每个已批准步骤不得被单请求复核误杀。"""

    brief = QueryBrief.model_validate({
        "version": 1,
        "objective": "比较 Agent 框架的架构与人工审批能力",
        "complexity": "multi_faceted",
        "entities": ["Agent"],
        "must": [],
        "should": [
            {
                "constraint_id": "architecture",
                "text": "架构",
                "terms": ["architecture"],
            },
            {
                "constraint_id": "approval",
                "text": "人工审批",
                "terms": ["approval"],
            },
        ],
        "exclude": [],
        "time_range": None,
        "locations": [],
        "languages": ["en"],
        "required_channels": ["web"],
        "requested_fields": ["architecture", "approval"],
        "evidence_facets": [
            {
                "facet_id": "architecture",
                "description": "官方架构设计",
                "evidence_type": "official",
                "required_fields": ["architecture"],
            },
            {
                "facet_id": "approval",
                "description": "官方人工审批能力",
                "evidence_type": "official",
                "required_fields": ["approval"],
            },
        ],
    })
    state = initial_state("比较 Agent 框架")
    state["run_id"] = "run_distributed_should"
    state["intent"] = {"channels": ["web"]}
    state["query_brief"] = brief.model_dump(mode="json")
    state["round"] = 1
    plan = nodes.build_plan_snapshot(
        run_id=state["run_id"],
        iteration=1,
        revision=1,
        created_at="2026-08-08T00:00:00Z",
        planned_steps=[
            {
                "local_id": "architecture",
                "facet_id": "architecture",
                "facet": "官方架构设计",
                "objective": "核对官方架构设计",
                "query_terms": ["Agent", "architecture"],
                "strategy": "initial_precise",
                "query": "Agent architecture official documentation",
                "channel": "web",
                "gap_id": None,
                "parent_attempt_id": None,
                "retained_constraint_ids": ["architecture"],
                "relaxed_should_ids": [],
                "depends_on": [],
                "priority": 100,
                "evidence_needed": 2,
                "can_parallelize": True,
            },
            {
                "local_id": "approval",
                "facet_id": "approval",
                "facet": "官方人工审批能力",
                "objective": "核对官方人工审批能力",
                "query_terms": ["Agent", "approval"],
                "strategy": "initial_precise",
                "query": "Agent approval official documentation",
                "channel": "web",
                "gap_id": None,
                "parent_attempt_id": None,
                "retained_constraint_ids": ["approval"],
                "relaxed_should_ids": [],
                "depends_on": [],
                "priority": 100,
                "evidence_needed": 2,
                "can_parallelize": True,
            },
        ],
        allowed_channels={"web"},
        max_steps=2,
        max_evidence_per_step=3,
        max_total_evidence=6,
        query_brief=brief,
        prior_attempts=[],
        open_gaps=[],
        initial=True,
    )
    running_plan, selected = nodes.start_ready_steps(plan, revision=2)
    state["plan"] = running_plan
    state["plan_revision"] = running_plan["revision"]
    state["pending_plan_step_ids"] = [item["step_id"] for item in selected]
    state["pending_searches"] = nodes.requests_for_steps(selected)

    assert len(selected) == 2
    assert len(nodes.build_research_work_items(state)) == 2


def test_malformed_query_strategy_checkpoint_is_rejected_before_tool_compilation() -> None:
    query_brief = _checkpoint_query_brief()
    state = initial_state("Product API")
    state["intent"] = {"channels": ["web"]}
    state["query_brief"] = query_brief.model_dump(mode="json")
    state["round"] = 1

    request = {
        "query": "Product API",
        "channel": "web",
        "attempt_id": "attempt_forged",
        "facet_id": "official",
        "gap_id": None,
        "parent_attempt_id": None,
        "strategy": "initial_precise",
        "query_terms": ["Product", "API"],
        "retained_constraint_ids": [],
        "relaxed_should_ids": [],
        "constraint_signature": "signature_forged",
    }

    assert nodes._normalized_search_request(state, request) is None

    state["pending_searches"] = [request]  # type: ignore[list-item]
    state["pending_queries"] = [request["query"]]
    state["query_channels"] = {request["query"]: "web"}
    assert nodes._pending_searches(state) == []
    assert nodes.build_research_work_items(state) == []


def test_historical_search_preserves_its_original_attempt_id_across_rounds() -> None:
    query_brief = _checkpoint_query_brief()
    state = initial_state("Product API")
    state["run_id"] = "run_historical_attempt"
    state["intent"] = {"channels": ["web"]}
    state["query_brief"] = query_brief.model_dump(mode="json")
    accepted = validate_query_proposal(
        query_brief,
        {
            "query": "Product API",
            "channel": "web",
            "facet_id": "official",
            "query_terms": ["Product", "API"],
            "strategy": "initial_precise",
            "gap_id": None,
            "parent_attempt_id": None,
            "retained_constraint_ids": list(hard_constraint_ids(query_brief)),
            "relaxed_should_ids": [],
        },
        run_id=state["run_id"],
        iteration=1,
        initial=True,
        allowed_channels={"web"},
        prior_attempts=[],
        open_gaps=[],
    )
    original_attempt_id = accepted["attempt_id"]
    state["searches"] = [accepted]  # type: ignore[list-item]

    state["round"] = 2
    round_two = nodes._state_searches(state)
    state["searches"] = round_two
    state["round"] = 3
    round_three = nodes._state_searches(state)

    assert round_two[0]["attempt_id"] == original_attempt_id
    assert round_three[0]["attempt_id"] == original_attempt_id


def test_closed_gap_keeps_historical_search_but_rejects_pending_re_admission() -> None:
    query_brief = _checkpoint_query_brief()
    state = initial_state("Product API")
    state["run_id"] = "run_closed_historical_gap"
    state["intent"] = {"channels": ["web"]}
    state["query_brief"] = query_brief.model_dump(mode="json")
    retained = list(hard_constraint_ids(query_brief))
    parent = validate_query_proposal(
        query_brief,
        {
            "query": "Product API",
            "channel": "web",
            "facet_id": "official",
            "query_terms": ["Product", "API"],
            "strategy": "initial_precise",
            "gap_id": None,
            "parent_attempt_id": None,
            "retained_constraint_ids": retained,
            "relaxed_should_ids": [],
        },
        run_id=state["run_id"],
        iteration=1,
        initial=True,
        allowed_channels={"web"},
        prior_attempts=[],
        open_gaps=[],
    )
    open_gap = {
        "gap_id": "gap_product_api",
        "facet_id": "official",
        "kind": "no_results",
        "subject": None,
        "description": "没有候选",
        "missing_constraint_ids": [],
        "required_channel": "web",
        "evidence_type": "official",
        "priority": 100,
        "origin": "attempt_feedback",
        "status": "open",
        "opened_iteration": 1,
        "closed_iteration": None,
        "resolved_by_attempt_id": None,
    }
    follow_up = validate_query_proposal(
        query_brief,
        {
            "query": "Product developer reference",
            "channel": "web",
            "facet_id": "official",
            "query_terms": ["Product", "developer", "reference"],
            "strategy": "terminology_variant",
            "gap_id": open_gap["gap_id"],
            "parent_attempt_id": parent["attempt_id"],
            "retained_constraint_ids": retained,
            "relaxed_should_ids": [],
        },
        run_id=state["run_id"],
        iteration=2,
        initial=False,
        allowed_channels={"web"},
        prior_attempts=[parent],
        open_gaps=[open_gap],
    )
    closed_gap = {
        **open_gap,
        "status": "closed",
        "closed_iteration": 2,
        "resolved_by_attempt_id": follow_up["attempt_id"],
    }
    state["round"] = 2
    state["search_attempts"] = [parent, follow_up]  # type: ignore[list-item]
    state["evidence_gaps"] = [closed_gap]  # type: ignore[list-item]
    state["searches"] = [follow_up]  # type: ignore[list-item]
    state["pending_searches"] = [follow_up]  # type: ignore[list-item]

    historical = nodes._state_searches(state)

    assert historical[0]["attempt_id"] == follow_up["attempt_id"]
    assert nodes._pending_searches(state) == []


def test_remaining_run_seconds_preserves_finalization_budget_signal() -> None:
    state = initial_state("时间预算测试", max_run_seconds=120)
    state["started_at"] = (
        datetime.now(UTC) - timedelta(seconds=75)
    ).isoformat().replace("+00:00", "Z")

    remaining = nodes.remaining_run_seconds(state)

    assert remaining is not None
    assert 44 <= remaining <= 45


def test_xiaohongshu_tool_requires_a_meaningful_window_before_finalization() -> None:
    state = initial_state("时间预算测试", max_run_seconds=120)
    state["started_at"] = (
        datetime.now(UTC) - timedelta(seconds=30)
    ).isoformat().replace("+00:00", "Z")

    assert nodes.tool_timeout_seconds(state, "xiaohongshu") == 0
    web_timeout = nodes.tool_timeout_seconds(state, "web")
    assert web_timeout is not None
    assert 29 <= web_timeout <= 30


def test_explicit_output_contract_requires_markdown_record_hierarchy() -> None:
    question = (
        "请搜索小红书上关于“油敏皮夏季通勤防晒”的近期使用笔记。"
        "只读取可访问正文，按“肤质与场景 / 使用感受 / 防晒产品类型 / "
        "可能不适合的人群 / 来源链接”归纳 3–5 条经验。"
    )
    invalid_answer = (
        "1. **肤质与场景**：高温通勤 [来源1]。\n"
        "2. **使用感受**：肤感清爽 [来源1]。\n"
        "3. **防晒产品类型**：物化结合 [来源2]。\n"
        "4. **可能不适合的人群**：香精敏感者 [来源2]。"
    )
    old_nested_answer = "\n\n".join(
        f"{index}. **肤质与场景**：高温通勤\n"
        "   - **使用感受**：肤感清爽\n"
        "   - **防晒产品类型**：物化结合\n"
        "   - **可能不适合的人群**：香精敏感者\n"
        f"   - **来源链接**：[来源{1 if index < 3 else 2}]"
        for index in range(1, 4)
    )
    valid_answer = "\n\n".join(
        f"### {index}. 通勤防晒记录 {index}\n\n"
        "- **肤质与场景**：高温通勤\n"
        "- **使用感受**：肤感清爽\n"
        "- **防晒产品类型**：物化结合\n"
        "- **可能不适合的人群**：香精敏感者\n"
        f"- **来源链接**：[来源{1 if index < 3 else 2}]"
        for index in range(1, 4)
    )
    inline_answer = "\n\n".join(
        f"{index}. **肤质与场景**：高温通勤。**使用感受**：肤感清爽。"
        "**防晒产品类型**：物化结合。**可能不适合的人群**：香精敏感者。"
        f"**来源链接**：[来源{1 if index < 3 else 2}]"
        for index in range(1, 4)
    )
    incomplete_source_field = valid_answer.replace(
        "**使用感受**：肤感清爽",
        "**使用感受**：肤感清爽 [来源2]",
        1,
    )
    citation_heading = valid_answer.replace(
        "### 1. 通勤防晒记录 1",
        "### 1. 通勤防晒记录 1 [来源1]",
        1,
    )
    no_heading_gap = valid_answer.replace(
        "### 1. 通勤防晒记录 1\n\n-",
        "### 1. 通勤防晒记录 1\n-",
        1,
    )
    nested_fields = valid_answer.replace(
        "- **使用感受**：肤感清爽",
        "   - **使用感受**：肤感清爽",
        1,
    )
    field_name_heading = valid_answer.replace(
        "### 1. 通勤防晒记录 1",
        "### 1. 肤质与场景",
        1,
    )
    table_suffix = valid_answer + "\n\n| 字段 | 值 |\n| --- | --- |\n| 额外 | 内容 |"

    issue = nodes._explicit_output_issue(question, invalid_answer)

    assert issue is not None
    assert "三级标题" in issue
    assert nodes._explicit_output_issue(question, valid_answer) is None
    assert nodes._explicit_output_issue(question, old_nested_answer) is not None
    assert nodes._explicit_output_issue(question, inline_answer) is not None
    assert nodes._explicit_output_issue(question, incomplete_source_field) is not None
    assert nodes._explicit_output_issue(question, citation_heading) is not None
    assert nodes._explicit_output_issue(question, no_heading_gap) is not None
    assert nodes._explicit_output_issue(question, nested_fields) is not None
    assert nodes._explicit_output_issue(question, field_name_heading) is not None
    assert nodes._explicit_output_issue(question, table_suffix) is not None
    instruction = nodes._explicit_output_instruction(question)
    assert instruction is not None
    assert "输出 3 个 Markdown 记录小节" in instruction
    assert "### N. 短标题" in instruction
    assert "短标题由你依据该条已读证据" in instruction
    assert "**肤质与场景**" in instruction
    assert "无缩进的同级列表" in instruction
    assert "相邻记录之间保留一个空行" in instruction
    assert "优先选择对指定字段覆盖最完整的来源" in instruction
    assert "不能用于凑条数" in instruction
    assert "来源链接”字段必须列全" in instruction
    assert "每条必须明确它描述的具体对象" in instruction
    assert "不能只写裸的“未说明”" in instruction
    assert "不得先用用户问题中的筛选词" in instruction
    assert "总回答不超过 1000 字" in instruction
    assert "非医疗建议" not in instruction


def test_field_structured_output_gets_markdown_budget_without_expanding_direct_answer() -> None:
    structured = "请按“项目名称 / 申请资格 / 截止日期 / 来源链接”列出 3 条。"

    assert nodes._answer_delivery_limit(structured) == STRUCTURED_ANSWER_MAX_CHARS
    assert nodes._answer_delivery_limit("你是谁") == ANSWER_MAX_CHARS


def test_explicit_output_contract_uses_current_fields_without_domain_leakage() -> None:
    question = "请按“项目名称 / 申请资格 / 截止日期 / 来源链接”列出 2 条。"
    instruction = nodes._explicit_output_instruction(question)

    assert instruction is not None
    assert "### 1. <模型依据该条已读证据生成的短标题>" in instruction
    assert "- **项目名称**" in instruction
    assert "- **申请资格**" in instruction
    assert "- **截止日期**" in instruction
    assert "- **来源链接**：[来源N]" in instruction
    assert "肤质" not in instruction
    assert "医疗建议" not in instruction


def test_explicit_output_contract_requires_requested_non_medical_boundary() -> None:
    question = "请归纳使用体验，不得把个人体验写成医疗建议。"

    assert nodes._explicit_output_issue(question, "这是个人体验。") is not None
    assert nodes._explicit_output_issue(
        question,
        "> 这些内容是个人体验，不构成医疗建议。",
    ) is None
    assert nodes._explicit_output_issue(
        question,
        "> 这些内容来自个人体验，不构成医疗或护肤建议。",
    ) is None
    instruction = nodes._explicit_output_instruction(question)
    assert instruction is not None
    assert "Markdown 引用块" in instruction
    assert "不得复制固定模板" in instruction


def test_public_summary_requires_model_step_and_recorded_model_call() -> None:
    assert nodes._step(
        "plan_research",
        "deterministic",
        "本地固定计划",
        "test",
    )[0]["summary"] == ""
    assert _novel_public_summary(
        "plan_research",
        "本地固定计划",
        "deterministic",
        True,
        [],
    ) is None
    assert _novel_public_summary(
        "plan_research",
        "伪装成模型但没有调用记录",
        "model",
        False,
        [],
    ) is None
    assert _novel_public_summary(
        "plan_research",
        "真实模型生成的公开计划",
        "model",
        True,
        [],
    ) == "真实模型生成的公开计划"


def test_web_channel_fallback_requires_an_open_typed_platform_gap() -> None:
    gap = {
        "gap_id": "gap_platform",
        "kind": "missing_channel",
        "required_channel": "xiaohongshu",
        "status": "open",
    }

    assert nodes._gap_authorizes_search_channel(
        gap,
        channel="web",
        strategy="channel_fallback",
        historical=False,
    )
    assert not nodes._gap_authorizes_search_channel(
        gap,
        channel="web",
        strategy="facet_expansion",
        historical=False,
    )
    assert not nodes._gap_authorizes_search_channel(
        {**gap, "kind": "missing_claim"},
        channel="web",
        strategy="channel_fallback",
        historical=False,
    )
    assert not nodes._gap_authorizes_search_channel(
        {**gap, "status": "closed"},
        channel="web",
        strategy="channel_fallback",
        historical=False,
    )


@pytest.mark.asyncio
async def test_xiaohongshu_mcp_failure_opens_public_strategy_for_later_query(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(
        supervisor_channels=["xiaohongshu"],
        plans=[["query one", "query two"]],
        channels_by_query={
            "query one": "xiaohongshu",
            "query two": "xiaohongshu",
        },
        evidence_by_query={"query one": True, "query two": True},
        provider_by_query={
            "query one": "xiaohongshu-mcp-fallback[MCP_TIMEOUT]+tavily",
            "query two": "xiaohongshu-mcp-fallback[MCP_CIRCUIT_OPEN]+tavily",
        },
    )

    _output, events = await run_scenario(
        monkeypatch,
        scenario,
        question="只在小红书搜索这些测试笔记",
    )

    assert scenario.tool_execution_public_only == [False, True]
    assert scenario.max_active_tool_calls == 1
    assert len([
        event
        for event in events
        if event["type"] == "node.started" and event["node"] == "research"
    ]) == 1
    assert len([
        event
        for event in events
        if event["type"] == "node.started" and event["node"] == "merge_research"
    ]) == 1


@pytest.mark.asyncio
async def test_xiaohongshu_verification_events_keep_same_tool_and_pause_sla(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    challenge_id = "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789"
    base_update = {
        "challenge_id": challenge_id,
        "expires_at": "2099-08-01T00:04:00Z",
        "retry_after_ms": 2000,
    }
    scenario = Scenario(
        supervisor_channels=["xiaohongshu"],
        channels_by_query={"query one": "xiaohongshu"},
        verification_updates=[
            ChannelVerificationUpdate(
                **base_update,
                status="pending",
                message="等待使用小红书 App 扫码验证工具账号",
            ),
            ChannelVerificationUpdate(
                **base_update,
                status="pending",
                message="等待使用小红书 App 扫码验证工具账号",
            ),
            ChannelVerificationUpdate(
                **base_update,
                status="succeeded",
                message="小红书工具账号验证成功",
            ),
        ],
        interaction_wait_ms=120_000,
    )

    output, events = await run_scenario(
        monkeypatch,
        scenario,
        question="只在小红书搜索油敏皮夏季通勤防晒",
        verification_registry=True,
    )

    verification_events = [
        event for event in events if event["type"].startswith("tool.verification.")
    ]
    assert [event["type"] for event in verification_events] == [
        "tool.verification.required",
        "tool.verification.heartbeat",
        "tool.verification.resolved",
    ]
    assert len({event["toolCallId"] for event in verification_events}) == 1
    assert scenario.verification_request_keys == [
        f"{output['run_id']}:{verification_events[0]['toolCallId']}"
    ]
    assert output["external_wait_seconds"] == 120.0
    assert "qrcode" not in json.dumps(verification_events).lower()
    assert "xiaohongshu-mcp:18060" not in json.dumps(verification_events)


@pytest.mark.asyncio
async def test_zero_evidence_platform_round_keeps_web_fallback_partial(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(
        supervisor_channels=["xiaohongshu"],
        plans=[["xhs query"], ["official web query"]],
        writer_answer="现有 web 补充证据不能代表小红书近期使用笔记 [来源1]。",
        reflects=[
            {
                "sufficient": False,
                "missing": "缺少可读取正文",
                "extra_searches": [{"query": "official web query", "channel": "web"}],
                "source_presentations": [],
            },
            {
                "sufficient": True,
                "missing": "web 资料只能作为补充，仍缺少小红书正文",
                "extra_searches": [],
                "source_presentations": [{
                    "url": "https://example.com/2",
                    "include_in_details": False,
                    "text": "",
                }],
            },
        ],
        evidence_by_query={
            "xhs query": False,
            "official web query": True,
        },
        channels_by_query={
            "xhs query": "xiaohongshu",
            "official web query": "web",
        },
    )

    output, events = await run_scenario(
        monkeypatch,
        scenario,
        question="只在小红书搜索这些测试笔记",
        max_rounds=3,
        no_progress_limit=3,
    )

    assert scenario.tool_execution_searches[:2] == [
        {"query": "xhs query", "channel": "xiaohongshu"},
        {"query": "official web query", "channel": "web"},
    ]
    assert all(
        item["channel"] in {"xiaohongshu", "web"}
        for item in scenario.tool_execution_searches
    )
    assert len(scenario.tool_execution_searches) <= 3
    assert output["plan_fallback_count"] == 1
    assert output["response_status"] == "partial"
    assert output["verification_passed"] is False
    assert output["stop_reason"] == "MAX_ITERATIONS"
    assert "Evidence：xiaohongshu" in output["verification_issue"]
    assert output["answer"] == scenario.writer_answer
    assert output["answer_source"] == "model"
    assert "MISSING_CHANNEL_EVIDENCE" not in output["answer"]
    assert scenario.structured_calls.get("source_curator", 0) == 1
    presented = [event for event in events if event["type"] == "tool.presented"]
    assert len(presented) == 1
    assert presented[0]["sources"][0]["url"] == "https://example.com/2"


def test_public_process_drops_fetch_noise_without_inventing_replacement() -> None:
    for text in (
        "本次搜索渠道降级为公开索引。",
        "其余来源正文均未读取。",
        "仅发现公开候选，未获取内容。",
    ):
        assert nodes._effective_process_text(text) is None

    useful = "现有证据支持 LangChain 与 LangGraph 的区别，仍缺少 LangSmith。"
    assert nodes._effective_process_text(useful) == useful


class MemoryLedger:
    def __init__(self) -> None:
        self.rows: dict[str, LedgerDecision] = {}

    async def begin(self, **kwargs: Any) -> LedgerDecision:
        key = kwargs["idempotency_key"]
        row = self.rows.get(key)
        if row is None:
            row = LedgerDecision(
                "execute",
                "started",
                operation_ref=kwargs["operation_ref"],
                attempt=kwargs["attempt"],
                input_hash=kwargs["input_hash"],
            )
            self.rows[key] = row
            return row
        if row.status in {"completed", "failed"}:
            return LedgerDecision(**{**row.__dict__, "action": "cached"})
        return LedgerDecision(**{
            **row.__dict__,
            "action": "unknown",
            "error_code": row.error_code or "OUTCOME_UNKNOWN",
        })

    async def settle(
        self,
        key: str,
        settlement: ToolLedgerSettlement,
    ) -> LedgerDecision:
        current = self.rows[key]
        result = safe_result_payload(settlement.result)
        assert isinstance(result, dict)
        decision = LedgerDecision(
            "cached",
            settlement.status,
            result=result,
            error_code=settlement.error_code,
            operation_ref=current.operation_ref,
            attempt=current.attempt,
            result_ref=f"tool_result_{current.operation_ref[10:]}_{current.attempt}",
            input_hash=current.input_hash,
            output_hash=payload_hash(result),
            provider=settlement.provider,
            outcome_status=settlement.outcome_status,
            retryable=settlement.retryable,
            next_action=settlement.next_action,
            duration_ms=settlement.duration_ms,
            request_count=settlement.request_count,
            result_count=settlement.result_count,
            evidence_count=settlement.evidence_count,
            page_read_count=settlement.page_read_count,
            output_bytes=len(canonical_payload(result)),
            actual_cost_usd=settlement.actual_cost_usd,
        )
        self.rows[key] = decision
        return decision

    async def mark_unknown(
        self,
        key: str,
        error: str,
        *,
        duration_ms: int = 0,
        request_count: int = 0,
        possible_duplicate_cost_usd: str = "0",
    ) -> LedgerDecision:
        current = self.rows[key]
        decision = LedgerDecision(
            "unknown",
            "unknown",
            error_code=error,
            operation_ref=current.operation_ref,
            attempt=current.attempt,
            input_hash=current.input_hash,
            duration_ms=duration_ms,
            request_count=request_count,
            possible_duplicate_cost_usd=possible_duplicate_cost_usd,
        )
        self.rows[key] = decision
        return decision


@dataclass
class Scenario:
    need_search: bool = True
    supervisor_channels: list[str] = field(default_factory=lambda: ["web"])
    supervisor_use_history: bool = False
    supervisor_evidence_depth: str = "multi_source"
    supervisor_fast_search: dict[str, str] | None = None
    query_brief_override: dict[str, Any] | None = None
    plans: list[list[str]] = field(default_factory=lambda: [["query one"]])
    query_terms_by_query: dict[str, list[str]] = field(default_factory=dict)
    reflects: list[dict[str, Any]] = field(
        default_factory=lambda: [{
            "sufficient": True,
            "missing": "",
            "extra_searches": [],
            "source_presentations": [{
                "url": "https://example.com/1",
                "text": "该来源给出了与测试问题直接相关的可核验做法。",
            }],
        }]
    )
    verifier_actions: list[str] = field(default_factory=lambda: ["pass"])
    writer_answer: str | None = None
    writer_answers: list[str] = field(default_factory=list)
    # Writer 走纯 content 流式，不经结构化输出；这些字段记录流式侧的调用。
    writer_stream_fails: bool = False
    writer_stream_calls: int = 0
    writer_messages: list[Any] = field(default_factory=list)
    writer_stream_chunk_chars: int = 7
    evidence_by_query: dict[str, bool] = field(default_factory=lambda: {"query one": True})
    result_count_by_query: dict[str, int] = field(default_factory=dict)
    default_result_count: int = 1
    limitations_by_query: dict[str, str] = field(default_factory=dict)
    provider_by_query: dict[str, str] = field(default_factory=dict)
    channels_by_query: dict[str, str] = field(default_factory=dict)
    depends_on_by_query: dict[str, list[str]] = field(default_factory=dict)
    evidence_needed_by_query: dict[str, int] = field(default_factory=dict)
    evidence_needed_by_plan: list[int] = field(default_factory=list)
    retained_constraint_ids_by_plan: list[list[str]] = field(default_factory=list)
    facet_ids_by_plan: list[list[str]] = field(default_factory=list)
    structured_calls: dict[str, int] = field(default_factory=dict)
    structured_attempts: dict[str, int] = field(default_factory=dict)
    # 网络重试与格式修复分别记账：attempts 是真实 Provider 尝试数，
    # format_repairs 只统计 schema feedback 修复。
    structured_format_repairs: dict[str, int] = field(default_factory=dict)
    structured_repair_permissions: list[tuple[str, bool]] = field(default_factory=list)
    structured_messages: dict[str, list[Any]] = field(default_factory=dict)
    invalid_structured_roles: set[str] = field(default_factory=set)
    tool_executions: list[str] = field(default_factory=list)
    tool_execution_searches: list[dict[str, str]] = field(default_factory=list)
    tool_execution_public_only: list[bool] = field(default_factory=list)
    tool_delay_seconds: float = 0
    tool_delay_by_query: dict[str, float] = field(default_factory=dict)
    progress_before_delay: bool = False
    active_tool_calls: int = 0
    max_active_tool_calls: int = 0
    tool_completion_order: list[str] = field(default_factory=list)
    tool_started_at_by_query: dict[str, float] = field(default_factory=dict)
    tool_finished_at_by_query: dict[str, float] = field(default_factory=dict)
    tool_call_index: int = 0
    checkpoint_values: dict[str, Any] = field(default_factory=dict)
    verification_updates: list[ChannelVerificationUpdate] = field(default_factory=list)
    verification_request_keys: list[str] = field(default_factory=list)
    interaction_wait_ms: int = 0

    def query_brief(self) -> dict[str, Any] | None:
        if not self.need_search:
            return None
        if self.query_brief_override is not None:
            return copy.deepcopy(self.query_brief_override)
        return {
            "version": 1,
            "objective": "检索测试问题所需的可核验证据",
            "complexity": "multi_faceted",
            "entities": [],
            "must": [],
            "should": [],
            "exclude": [],
            "time_range": None,
            "locations": [],
            "languages": [],
            # Test scenarios exercise channel routing separately. An empty list
            # means the user did not impose an additional hard platform boundary.
            "required_channels": [],
            "requested_fields": [],
            "evidence_facets": [
                {
                    "facet_id": f"facet_{index}",
                    "description": f"测试证据面 {index}",
                    "evidence_type": "independent",
                    "required_fields": ["可核验证据"],
                }
                for index in range(1, 5)
            ],
        }

    @staticmethod
    def _latest_private_ref(messages: list[Any], key: str) -> str | None:
        text = str(messages[-1].content)
        patterns = (
            rf'"{key}"\s*:\s*"([A-Za-z0-9_.:-]+)"',
            rf'"{key.removesuffix("_id")}Id"\s*:\s*"([A-Za-z0-9_.:-]+)"',
        )
        matches: list[str] = []
        for pattern in patterns:
            matches.extend(re.findall(pattern, text))
        return matches[-1] if matches else None

    @staticmethod
    def _hard_constraint_ids(messages: list[Any]) -> list[str]:
        text = str(messages[-1].content)
        match = re.search(
            r"hardConstraintIds[^:：]*[:：](\[[^\r\n]*\])",
            text,
        )
        if match is None:
            return []
        value = json.loads(match.group(1))
        return [str(item) for item in value]

    @staticmethod
    def _gap_kind(messages: list[Any], missing: str) -> str:
        text = str(messages[-1].content)
        result_counts = [int(item) for item in re.findall(r'"resultCount"\s*:\s*(\d+)', text)]
        evidence_counts = [int(item) for item in re.findall(r'"evidenceCount"\s*:\s*(\d+)', text)]
        if result_counts and result_counts[-1] == 0:
            return "no_results"
        if evidence_counts and evidence_counts[-1] == 0:
            return "no_readable_evidence"
        if "冲突" in missing:
            return "conflicting_sources"
        if "字段" in missing:
            return "missing_field"
        if "渠道" in missing or "小红书" in missing or "X " in missing:
            return "missing_channel"
        return "missing_claim"

    @staticmethod
    def _strategy_for_gap(kind: str) -> str:
        return {
            "no_results": "terminology_variant",
            "no_readable_evidence": "channel_fallback",
            "conflicting_sources": "conflict_resolution",
            "missing_channel": "channel_fallback",
            "missing_field": "field_completion",
            "missing_constraint": "facet_expansion",
            "missing_claim": "facet_expansion",
        }[kind]

    def _subject_for_gap(self, facet_id: str, kind: str) -> str | None:
        if kind not in {"missing_claim", "conflicting_sources", "missing_field"}:
            return None
        brief = self.query_brief() or {}
        facet = next(
            (
                item for item in brief.get("evidence_facets", [])
                if item.get("facet_id") == facet_id
            ),
            None,
        )
        fields = list((facet or {}).get("required_fields") or [])
        if not fields:
            fields = list(brief.get("requested_fields") or [])
        return str(fields[0]) if fields else None

    async def generate_structured(
        self,
        request: ModelRequest,
        schema: type[Any],
        *,
        allow_repair: bool = False,
    ) -> tuple[Any, ModelUsage]:
        role = request.task_type
        messages = list(request.messages)
        role_key = "source_curator" if schema is SourcePresentationResult else role
        self.structured_repair_permissions.append((role_key, allow_repair))
        self.structured_messages.setdefault(role_key, []).append(copy.deepcopy(messages))
        index = self.structured_calls.get(role_key, 0)
        self.structured_calls[role_key] = index + 1
        if role_key in self.invalid_structured_roles:
            raise StructuredOutputError(ModelUsage(
                input_tokens=20,
                output_tokens=4,
                total_tokens=24,
                cost_usd=0.000002,
                attempts=2 if allow_repair else 1,
                format_repairs=1 if allow_repair else 0,
            ))
        if schema is SourcePresentationResult:
            urls = re.findall(
                r"URL: (https?://\S+)",
                str(messages[-1].content),
            )
            result = SourcePresentationResult(source_presentations=[
                {
                    "url": url,
                    "include_in_details": True,
                    "text": "该来源正文提供了与用户问题直接相关的有效事实。",
                }
                for url in dict.fromkeys(urls)
            ])
        elif role == "supervisor":
            result = IntentResult(
                task_type="research" if self.need_search else "direct_answer",
                need_search=self.need_search,
                channels=self.supervisor_channels if self.need_search else [],
                use_history=self.supervisor_use_history,
                evidence_depth=self.supervisor_evidence_depth,
                fast_search=self.supervisor_fast_search,
                query_brief=self.query_brief(),
                summary="已判断是否需要联网",
            )
        elif role == "planner":
            queries = self.plans[min(index, len(self.plans) - 1)]
            brief = self.query_brief() or {}
            facet_ids = [
                str(item["facet_id"])
                for item in brief.get("evidence_facets", [])
            ]
            planner_text = str(messages[-1].content)
            is_follow_up = "当前 open gaps" in planner_text
            gap_id = (
                self._latest_private_ref(messages, "gap_id")
                if is_follow_up
                else None
            )
            parent_attempt_id = None
            if is_follow_up:
                parent_attempt_id = self._latest_private_ref(
                    messages,
                    "parent_attempt_id",
                ) or self._latest_private_ref(messages, "attempt_id")
            if gap_id and parent_attempt_id:
                typed_kinds = re.findall(
                    r'"kind"\s*:\s*"([a-z_]+)"',
                    planner_text,
                )
                gap_kind = (
                    typed_kinds[-1]
                    if typed_kinds
                    else self._gap_kind(messages, planner_text)
                )
                strategy = self._strategy_for_gap(gap_kind)
            elif gap_id:
                # Keep the double structurally valid so the production
                # lineage gate proves rejection before tool execution.
                parent_attempt_id = "attempt_missing_parent"
                typed_kinds = re.findall(
                    r'"kind"\s*:\s*"([a-z_]+)"',
                    planner_text,
                )
                strategy = self._strategy_for_gap(
                    typed_kinds[-1] if typed_kinds else "missing_claim"
                )
            else:
                strategy = "initial_precise"
            result = PlanResult(
                steps=[
                    {
                        "local_id": f"search_{position + 1}",
                        "facet_id": (
                            self._latest_private_ref(messages, "facet_id")
                            if is_follow_up
                            else (
                                self.facet_ids_by_plan[
                                    min(index, len(self.facet_ids_by_plan) - 1)
                                ][position]
                                if self.facet_ids_by_plan
                                else facet_ids[position]
                            )
                        ),
                        "facet": f"证据面 {position + 1}",
                        "objective": f"检索 {query}",
                        "query_terms": self.query_terms_by_query.get(
                            query,
                            [query],
                        ),
                        "strategy": strategy,
                        "query": query,
                        "channel": self.channels_by_query.get(query, "web"),
                        "gap_id": gap_id,
                        "parent_attempt_id": parent_attempt_id,
                        "retained_constraint_ids": self._hard_constraint_ids(
                            messages
                        ) if not self.retained_constraint_ids_by_plan else list(
                            self.retained_constraint_ids_by_plan[
                                min(index, len(self.retained_constraint_ids_by_plan) - 1)
                            ]
                        ),
                        "relaxed_should_ids": [],
                        "depends_on": self.depends_on_by_query.get(query, []),
                        "priority": 100 - position,
                        "evidence_needed": (
                            self.evidence_needed_by_plan[
                                min(index, len(self.evidence_needed_by_plan) - 1)
                            ]
                            if self.evidence_needed_by_plan
                            else self.evidence_needed_by_query.get(query, 0)
                        ),
                        "can_parallelize": True,
                    }
                    for position, query in enumerate(queries)
                ],
                summary="已形成检索计划",
            )
        elif role == "reflector":
            data = copy.deepcopy(self.reflects[min(index, len(self.reflects) - 1)])
            data.setdefault("missing", "")
            data.setdefault("extra_searches", [])
            data.setdefault("source_presentations", [])
            sufficient = bool(data.get("sufficient"))
            parent_attempt_id = self._latest_private_ref(messages, "attempt_id")
            facet_id = self._latest_private_ref(messages, "facet_id") or "facet_1"
            gap_kind = self._gap_kind(messages, str(data.get("missing") or ""))
            local_gap_id = f"reflect_gap_{index + 1}"
            data["evidence_gaps"] = (
                []
                if sufficient
                else [{
                    "gap_id": local_gap_id,
                    "facet_id": facet_id,
                    "kind": gap_kind,
                    "subject": self._subject_for_gap(facet_id, gap_kind),
                    "description": str(data.get("missing") or "证据仍不充分"),
                    "missing_constraint_ids": [],
                    "required_channel": (
                        data["extra_searches"][0].get("channel")
                        if data["extra_searches"]
                        else None
                    ),
                    "evidence_type": "independent",
                    "priority": 100,
                }]
            )
            if not sufficient:
                strategy = self._strategy_for_gap(gap_kind)
                data["extra_searches"] = [
                    {
                        **item,
                        "facet_id": facet_id,
                        "query_terms": [item["query"]],
                        "strategy": strategy,
                        "gap_id": local_gap_id,
                        "parent_attempt_id": parent_attempt_id or "attempt_legacy_parent",
                        "retained_constraint_ids": [],
                        "relaxed_should_ids": [],
                    }
                    for item in data["extra_searches"]
                ]
            for presentation in data.get("source_presentations", []):
                presentation.setdefault("include_in_details", True)
            result = ReflectResult(summary="已评估证据覆盖", **data)
        elif role == "verifier":
            action = self.verifier_actions[min(index, len(self.verifier_actions) - 1)]
            parent_attempt_id = self._latest_private_ref(messages, "attempt_id")
            facet_id = self._latest_private_ref(messages, "facet_id") or "facet_1"
            gap_id = f"verify_gap_{index + 1}"
            result = VerifyResult(
                passed=action == "pass",
                action=action,
                issue=(
                    "需要改写"
                    if action == "rewrite"
                    else "回答仍缺少可核验证据"
                    if action == "research_more"
                    else ""
                ),
                extra_searches=(
                    [{
                        "query": "query two",
                        "channel": self.channels_by_query.get("query two", "web"),
                        "facet_id": facet_id,
                        "query_terms": ["query two"],
                        "strategy": "facet_expansion",
                        "gap_id": gap_id,
                        "parent_attempt_id": parent_attempt_id or "attempt_legacy_parent",
                        "retained_constraint_ids": [],
                        "relaxed_should_ids": [],
                    }]
                    if action == "research_more"
                    else []
                ),
                evidence_gaps=(
                    [{
                        "gap_id": gap_id,
                        "facet_id": facet_id,
                        "kind": "missing_claim",
                        "subject": self._subject_for_gap(facet_id, "missing_claim"),
                        "description": "回答仍缺少可核验证据",
                        "missing_constraint_ids": [],
                        "required_channel": self.channels_by_query.get(
                            "query two",
                            "web",
                        ),
                        "evidence_type": "independent",
                        "priority": 100,
                    }]
                    if action == "research_more"
                    else []
                ),
                summary="已完成核验",
            )
        else:  # pragma: no cover - 测试 double 防御
            raise AssertionError(role)
        assert isinstance(result, schema)
        return result, ModelUsage(
            input_tokens=10,
            output_tokens=5,
            total_tokens=15,
            cost_usd=0.000001,
            attempts=self.structured_attempts.get(role, 1),
            format_repairs=self.structured_format_repairs.get(role, 0),
        )

    async def stream_text(
        self,
        request: ModelRequest,
    ) -> Any:
        """模拟 Writer 的 content 流：按 chunk 吐增量，末尾给真实 usage。"""

        messages = list(request.messages)
        self.writer_stream_calls += 1
        self.writer_messages.append(copy.deepcopy(messages))
        if self.writer_stream_fails:
            raise WriterStreamError(ModelUsage(
                input_tokens=10,
                output_tokens=4,
                total_tokens=14,
                cost_usd=0.000002,
                attempts=1,
            ))
        answer = (
            self.writer_answers[min(
                self.writer_stream_calls - 1,
                len(self.writer_answers) - 1,
            )]
            if self.writer_answers
            else self.writer_answer
        ) or ("可核验回答 [来源1]" if self.need_search else "直接回答")
        chunk = max(1, self.writer_stream_chunk_chars)
        for offset in range(0, len(answer), chunk):
            yield answer[offset:offset + chunk]
        yield ModelUsage(
            input_tokens=10,
            output_tokens=len(answer),
            total_tokens=10 + len(answer),
            cost_usd=0.000001,
            attempts=1,
        )

    async def execute_tool(
        self,
        arguments: Any,
        config: Any,
        progress: Any = None,
        *,
        deadline: Any = None,
        xiaohongshu_public_only: bool = False,
        verification_request_key: str | None = None,
        verification: Any = None,
    ) -> SearchExecutionResult:
        del deadline
        query = arguments.query
        self.tool_executions.append(query)
        execution_number = len(self.tool_executions)
        self.tool_execution_searches.append(
            {"query": query, "channel": arguments.channel}
        )
        self.tool_execution_public_only.append(xiaohongshu_public_only)
        self.tool_started_at_by_query[query] = time.perf_counter()
        if verification_request_key is not None:
            self.verification_request_keys.append(verification_request_key)
        if verification is not None:
            for update in self.verification_updates:
                verification(update)
        self.active_tool_calls += 1
        self.max_active_tool_calls = max(
            self.max_active_tool_calls,
            self.active_tool_calls,
        )
        if self.progress_before_delay and progress:
            progress(ChannelProgress(
                provider="deterministic",
                result_count=5,
                evidence_count=0,
            ))
        try:
            delay = self.tool_delay_by_query.get(query, self.tool_delay_seconds)
            if delay:
                await asyncio.sleep(delay)
        finally:
            self.active_tool_calls -= 1
            self.tool_completion_order.append(query)
            self.tool_finished_at_by_query[query] = time.perf_counter()
        has_evidence = self.evidence_by_query.get(query, False)
        result_count = self.result_count_by_query.get(
            query,
            self.default_result_count,
        )
        limitation = self.limitations_by_query.get(query)
        provider = self.provider_by_query.get(query, "deterministic")
        degraded_match = re.search(r"fallback\[([^]]+)]", provider)
        reason_code = degraded_match.group(1) if degraded_match else None
        url = f"https://example.com/{execution_number}"
        return SearchExecutionResult(
            ok=True,
            channel=arguments.channel,
            query=query,
            provider=provider,
            results=[PublicSearchResult(
                channel=arguments.channel,
                provider=provider,
                query=query,
                title=f"Result {query}",
                url=url,
                snippet="candidate only",
                verified=has_evidence,
                limitation=limitation,
                provenance=SourceProvenance(
                    discovery_provider="deterministic",
                    detail_provider="test" if has_evidence else None,
                    source_kind="public_page" if has_evidence else "public_index",
                    observed_at="2026-07-28T00:00:00Z",
                    confidence="high" if has_evidence else "low",
                ),
            )] if result_count else [],
            evidence=[SearchEvidence(
                channel=arguments.channel,
                provider=provider,
                title=f"Evidence {query}",
                url=url,
                text=f"verified evidence for {query}",
                extractor="test",
                query=query,
                captured_at="2026-07-28T00:00:00Z",
                limitation=limitation,
                provenance=SourceProvenance(
                    discovery_provider="deterministic",
                    detail_provider="test",
                    source_kind="public_page",
                    observed_at="2026-07-28T00:00:00Z",
                    confidence="high",
                ),
            )] if has_evidence else [],
            error_code=reason_code,
            error_message=("受控降级" if reason_code else None),
            resolution=channel_resolution(
                status="degraded" if reason_code else "success",
                primary_provider=(
                    "xiaohongshu-mcp"
                    if arguments.channel == "xiaohongshu"
                    else provider
                ),
                effective_provider=provider,
                reason_code=reason_code,
                message="受控降级" if reason_code else None,
            ),
            interaction_wait_ms=self.interaction_wait_ms,
        )


async def run_scenario(
    monkeypatch: pytest.MonkeyPatch,
    scenario: Scenario,
    *,
    question: str | None = None,
    verification_registry: bool = False,
    **state_overrides: Any,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    monkeypatch.setattr(nodes, "execute_search_tool", scenario.execute_tool)

    state = initial_state(
        question or ("需要搜索的测试问题" if scenario.need_search else "解释递归"),
        run_id=f"run_{uuid.uuid4().hex}",
        model_id="deepseek-v4-flash",
        **state_overrides,
    )
    graph = build_graph()
    context = RunContext(
        agent_config(),
        ToolGateway(MemoryLedger()),
        None,
        XiaohongshuVerificationRegistry() if verification_registry else None,
        # 测试 double 通过 ModelGateway port 注入，不 monkeypatch 具体 provider 函数。
        scenario,
    )
    graph_config = {
        "configurable": {"thread_id": f"thread_{uuid.uuid4().hex}"},
        "recursion_limit": 48,
    }
    events: list[dict[str, Any]] = []
    output: dict[str, Any] = {}
    tokens = begin_event_scope(state["run_id"])
    try:
        async for part in graph.astream(
            state,
            config=graph_config,
            context=context,
            stream_mode=["custom", "values"],
            version="v2",
        ):
            if part["type"] == "custom":
                events.append(part["data"])
            elif part["type"] == "values":
                output = part["data"]
    finally:
        end_event_scope(tokens)
    scenario.checkpoint_values = dict((await graph.aget_state(graph_config)).values)
    return output, events


@pytest.mark.parametrize(
    ("question", "expected"),
    [
        ("解释递归", ["web"]),
        ("只查小红书里的 Cursor 讨论", ["xiaohongshu"]),
        ("查看 x.com/Twitter 上的 OpenAI 帖子", ["x"]),
        (
            "比较官网网页、X/Twitter 与小红书上的公开信息",
            ["web", "x", "xiaohongshu"],
        ),
        ("xiaohongshu 和 website 的资料", ["xiaohongshu", "web"]),
    ],
)
def test_forced_search_channels_follow_explicit_platform_words(
    question: str,
    expected: list[str],
) -> None:
    assert nodes._forced_search_channels(question) == expected


def test_answer_compaction_uses_complete_markdown_and_citation_boundaries() -> None:
    answer = "\n".join(
        ["结论先行：这些岗位都强调真实产品协作 [来源1]。"]
        + [
            f"- 要点{i}：需要用户研究、数据分析与跨团队推进能力 [来源1][来源2]。"
            for i in range(1, 10)
        ]
    )

    compacted = nodes._compact_answer_markdown(answer, max_chars=180)

    assert len(compacted) <= 180
    assert answer.startswith(compacted)
    assert compacted.endswith("。")
    assert compacted.count("[") == compacted.count("]")
    assert not re.search(r"\[来源\d*$", compacted)


def test_answer_citations_publish_only_referenced_sources_and_renumber_gaps() -> None:
    evidence = [
        {
            "channel": "xiaohongshu",
            "provider": "xiaohongshu-mcp",
            "query": "油敏皮防晒",
            "url": f"https://www.xiaohongshu.com/explore/note_{index}",
            "title": f"来源 {index}",
            "text": "已读取正文",
            "extractor": "xiaohongshu-mcp-authenticated",
            "captured_at": "2026-08-01T00:00:00Z",
        }
        for index in range(1, 7)
    ]

    answer, citations = nodes._answer_citations(
        "第一条 [来源2]，第二条 [来源6]，再次引用 [来源2]。",
        evidence,
    )

    assert answer == "第一条 [来源1]，第二条 [来源2]，再次引用 [来源1]。"
    assert [citation["label"] for citation in citations] == ["来源 2", "来源 6"]
    assert [citation["url"] for citation in citations] == [
        "https://www.xiaohongshu.com/explore/note_2",
        "https://www.xiaohongshu.com/explore/note_6",
    ]


@pytest.mark.asyncio
async def test_oversized_writer_answer_is_compacted_before_verification(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    writer_answer = "\n".join(
        f"- 第{i}项结论由已读取正文直接支持 [来源1]。"
        for i in range(1, 80)
    )
    scenario = Scenario(writer_answer=writer_answer)

    output, _events = await run_scenario(monkeypatch, scenario)

    assert output["response_status"] == "completed"
    assert output["stop_reason"] == "VERIFIED"
    assert len(output["answer"]) <= ANSWER_MAX_CHARS
    assert writer_answer.startswith(output["answer"])
    assert output["answer"].count("[") == output["answer"].count("]")
    verifier_prompt = scenario.structured_messages["verifier"][-1][-1].content
    assert output["answer"] in verifier_prompt
    assert writer_answer not in verifier_prompt


def _fast_scenario() -> Scenario:
    """单事实快路径场景：Supervisor 语义判定 single_fact 并给出唯一检索请求。"""

    return Scenario(
        supervisor_evidence_depth="single_fact",
        supervisor_channels=["web"],
        supervisor_fast_search={"query": "2026年8月3日 星期几", "channel": "web"},
        plans=[["2026年8月3日 星期几"]],
        evidence_by_query={"2026年8月3日 星期几": True},
        writer_answer="今天是 2026 年 8 月 3 日，星期一 [来源1]。",
    )


@pytest.mark.asyncio
async def test_single_fact_fast_path_uses_one_tool_and_three_model_calls(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = _fast_scenario()
    output, events = await run_scenario(monkeypatch, scenario)

    # A5 / A6：恰好 1 次工具调用、3 次模型调用。
    assert output["tool_calls"] == 1
    assert output["model_calls"] == 3
    # A7：不经过 plan_research 与 reflect。
    assert scenario.structured_calls.get("planner", 0) == 0
    assert scenario.structured_calls.get("reflector", 0) == 0
    visited_nodes = [step["node"] for step in output["steps"]]
    assert "plan_research" not in visited_nodes
    assert "reflect" not in visited_nodes
    assert "plan_fast_search" in visited_nodes
    # A5（继续）：工具调用恰为该唯一检索请求。
    assert scenario.tool_executions == ["2026年8月3日 星期几"]
    assert [s["query"] for s in output["searches"]] == ["2026年8月3日 星期几"]
    # A8：引用非空且全部指向 Evidence。
    assert output["citations"], "快路径必须带来源引用"
    evidence_urls = {item["url"] for item in output["evidence"]}
    assert all(c["url"] in evidence_urls for c in output["citations"])
    assert output["response_status"] == "completed"
    assert output["stop_reason"] == "VERIFIED"
    # 无 plan_research / reflect 事件。
    assert not [e for e in events if e.get("node") == "plan_research"]
    assert not [e for e in events if e.get("node") == "reflect"]


@pytest.mark.asyncio
async def test_single_fact_fast_path_preserves_plan_and_evidence_for_frontend(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = _fast_scenario()
    output, _events = await run_scenario(monkeypatch, scenario)

    plan = output["plan"]
    assert plan is not None
    assert len(plan["steps"]) == 1
    step = plan["steps"][0]
    assert step["status"] == "done"
    assert step["query"] == "2026年8月3日 星期几"
    assert step["channel"] == "web"
    assert step["reason_code"] is None
    evidence = output["evidence"]
    assert len(evidence) == 1
    assert evidence[0]["status"] == "cited"
    assert evidence[0]["query"] == "2026年8月3日 星期几"
    assert evidence[0]["url"] == "https://example.com/1"
    assert scenario.checkpoint_values["fast_path"] is True
    # 思考记录包含唯一确定性快规划步骤。
    fast_steps = [s for s in output["steps"] if s["node"] == "plan_fast_search"]
    assert len(fast_steps) == 1
    assert fast_steps[0]["kind"] == "deterministic"
    assert fast_steps[0]["detail"] == "fast_path_steps=1"


@pytest.mark.asyncio
async def test_single_fact_fast_path_with_zero_evidence_falls_back_to_full_plan(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = _fast_scenario()
    scenario.evidence_by_query = {"2026年8月3日 星期几": False}
    output, _events = await run_scenario(monkeypatch, scenario)

    # 首次检索零已读 → 不视为快路径证据，退回 reflect。
    visited_nodes = [step["node"] for step in output["steps"]]
    assert "reflect" in visited_nodes
    assert "accept_fast_evidence" not in visited_nodes
    # 快路径不凭空产出完成态；证据缺失由完整链路兜底。
    assert scenario.structured_calls.get("reflector", 0) >= 1
    assert scenario.structured_calls.get("planner", 0) >= 1
    assert output["evidence"] == []


@pytest.mark.asyncio
async def test_single_fact_fast_path_downgrades_to_full_plan_on_research_more(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = _fast_scenario()
    # 首次核验判定证据不足，第二次通过。
    scenario.verifier_actions = ["research_more", "pass"]
    # 回退后的 Planner 必须直接采用新的证据缺口查询；快路径原 query
    # 已执行，重复它应由独立的计划门禁拒绝。
    scenario.plans = [["query two"]]
    scenario.evidence_by_query = {
        "2026年8月3日 星期几": True,
        "query two": True,
    }
    output, _events = await run_scenario(monkeypatch, scenario)

    # A9：verify 判 research_more 后退回 plan_research，完整链路继续。
    visited_nodes = [step["node"] for step in output["steps"]]
    assert "plan_fast_search" in visited_nodes
    assert "plan_research" in visited_nodes
    assert scenario.structured_calls.get("planner", 0) == 1
    # 退回后不再当作快路径：reflect 重新参与。
    assert "reflect" in visited_nodes
    assert output["fast_path"] is False
    assert scenario.checkpoint_values["fast_path"] is False
    assert output["tool_calls"] >= 1
    assert scenario.structured_calls.get("verifier", 0) >= 2


def test_realtime_fact_intent_keeps_fast_path_without_freshness_override() -> None:
    # 回归锁定 #31：注入当前日期曾让模型判 need_search=false，schema 随之锁死
    # evidence_depth=multi_source / fast_search=None；再由 _freshness_required()
    # 把 need_search 翻成 true，就造出一个必然退化为完整链路的状态。
    # 修好后模型自己判 single_fact，覆盖分支不再进入。
    intent = IntentResult(
        task_type="fact_lookup",
        need_search=True,
        channels=["web"],
        use_history=False,
        evidence_depth="single_fact",
        fast_search={"query": "2026年8月3日 星期几", "channel": "web"},
        query_brief=Scenario().query_brief(),
        summary="确认今天的日期。",
    ).model_dump()

    # 关键词正则仍会命中「今天」，但模型已判 need_search=true，覆盖分支不进入。
    assert nodes._freshness_required("今天是几号") is True
    request = nodes._fast_search_request({"intent": intent})  # type: ignore[arg-type]
    assert request is not None
    assert request["query"] == "2026年8月3日 星期几"
    assert request["channel"] == "web"


def test_freshness_override_alone_cannot_reach_fast_path() -> None:
    # 覆盖逻辑只能强制搜索，不能凭空造出 fast_search（服务端不得代猜查询），
    # 因此由正则触发的搜索必然走完整链路。这条固定该边界，避免日后误加兜底猜测。
    intent = IntentResult(
        task_type="direct_answer",
        need_search=False,
        channels=[],
        use_history=False,
        evidence_depth="multi_source",
        fast_search=None,
        query_brief=None,
        summary="直接回答。",
    ).model_dump()
    intent["need_search"] = True
    intent["channels"] = ["web"]

    assert nodes._fast_search_request({"intent": intent}) is None  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_writer_stream_empty_returns_structured_failure_without_template_answer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(writer_stream_fails=True)

    output, _events = await run_scenario(monkeypatch, scenario)

    assert output["response_status"] == "partial"
    assert output["stop_reason"] == "OUTPUT_INVALID"
    assert output["verification_passed"] is False
    assert output["answer"] is None
    assert output["answer_source"] == "none"
    assert scenario.writer_stream_calls == 1
    assert scenario.structured_calls.get("verifier", 0) == 0


@pytest.mark.asyncio
async def test_current_direct_intent_bypasses_search_with_stale_research_history(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(
        need_search=False,
        writer_answer="我是当前工作台中的 AI 助手，可以直接回答问题，也会在需要时调用工具。",
    )
    output, events = await run_scenario(
        monkeypatch,
        scenario,
        question="你是谁",
        conversation_context=(
            "用户：请检索英国大学奖学金。\n\n"
            "助手：上一轮整理了 British Council 和英国大学资料。"
        ),
    )

    assert output["need_search"] is False
    assert output["response_status"] == "completed"
    assert output["stop_reason"] == "DIRECT_COMPLETED"
    assert output["answer"] == scenario.writer_answer
    assert output["tool_calls"] == 0
    assert output["evidence"] == []
    assert scenario.tool_executions == []
    assert scenario.structured_calls.get("supervisor", 0) == 1
    assert scenario.structured_calls.get("planner", 0) == 0
    assert scenario.structured_calls.get("reflector", 0) == 0
    assert scenario.writer_stream_calls == 1
    assert output["intent"]["channels"] == []
    assert output["plan"] is None
    assert output["verification_passed"] is False
    assert output["verification_action"] == ""
    classify_step = next(
        step for step in output["steps"] if step["node"] == "classify_intent"
    )
    assert classify_step["kind"] == "model"
    assert not [event for event in events if event["type"].startswith("tool.")]
    assert not [event for event in events if event["type"].startswith("plan.")]
    assert not [event for event in events if event["type"] == "evidence.updated"]
    supervisor_input = scenario.structured_messages["supervisor"][0][-1].content
    assert supervisor_input.index("历史上下文") < supervisor_input.index("当前用户消息")
    assert supervisor_input.rstrip().endswith('"你是谁"')
    writer_input = scenario.writer_messages[0][-1].content
    assert "British Council" not in writer_input
    assert writer_input == "当前用户消息（唯一任务）：你是谁"


@pytest.mark.asyncio
async def test_direct_referential_intent_receives_history_only_when_model_requests_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(
        need_search=False,
        supervisor_use_history=True,
        writer_answer="它指的是上一条消息中的方案。",
    )
    output, _events = await run_scenario(
        monkeypatch,
        scenario,
        question="那它指什么？",
        conversation_context="用户：请解释这个方案。\n\n助手：方案包含两个步骤。",
    )

    assert output["stop_reason"] == "DIRECT_COMPLETED"
    writer_input = scenario.writer_messages[0][-1].content
    assert "用于消解当前消息指代的会话上下文" in writer_input
    assert "方案包含两个步骤" in writer_input
    assert writer_input.rstrip().endswith("当前用户消息（唯一任务）：那它指什么？")


@pytest.mark.asyncio
async def test_explicit_xiaohongshu_topic_uses_real_planner_model_output(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    topic = "油敏皮夏季通勤防晒"
    scenario = Scenario(
        supervisor_channels=["xiaohongshu"],
        plans=[[topic]],
        evidence_by_query={topic: True},
        channels_by_query={topic: "xiaohongshu"},
    )

    output, events = await run_scenario(
        monkeypatch,
        scenario,
        question=(
            "请搜索小红书上关于“油敏皮夏季通勤防晒”的近期使用笔记。"
            "只读取可访问正文。"
        ),
    )

    assert scenario.structured_calls.get("planner", 0) == 1
    assert scenario.tool_execution_searches == [
        {"query": topic, "channel": "xiaohongshu"},
    ]
    plan_step = next(
        step for step in output["steps"] if step["node"] == "plan_research"
    )
    assert plan_step["kind"] == "model"
    completed = next(
        event
        for event in events
        if event["type"] == "node.completed" and event["node"] == "plan_research"
    )
    assert completed["publicSummary"] == "已形成检索计划"
    assert completed["publicSummarySource"] == "model"


def test_presented_xiaohongshu_sources_stop_synonym_search_at_requested_minimum() -> None:
    question = (
        "请搜索小红书上关于“油敏皮夏季通勤防晒”的近期使用笔记，"
        "按“肤质与场景 / 使用感受 / 防晒产品类型 / 可能不适合的人群 / "
        "来源链接”归纳 3–5 条经验。"
    )
    evidence = [
        {
            "channel": "xiaohongshu",
            "url": f"https://www.xiaohongshu.com/explore/note_{index}",
        }
        for index in range(1, 4)
    ]
    presented = {item["url"] for item in evidence}

    assert nodes._presented_sources_satisfy_contract(
        question,
        evidence,  # type: ignore[arg-type]
        presented,
        ["xiaohongshu"],
        "还可补充更多同类描述",
    )
    assert not nodes._presented_sources_satisfy_contract(
        question,
        evidence[:2],  # type: ignore[arg-type]
        {item["url"] for item in evidence[:2]},
        ["xiaohongshu"],
        "条目不足",
    )
    assert not nodes._presented_sources_satisfy_contract(
        question,
        evidence,  # type: ignore[arg-type]
        presented,
        ["xiaohongshu"],
        "来源结论互相冲突",
    )


def test_ineffective_source_text_rejects_short_or_missing_dimension_copy() -> None:
    assert nodes._effective_source_text("正文过短，未展开通勤场景与适用人群。") is None


@pytest.mark.asyncio
async def test_explicit_output_contract_forces_rewrite_when_verifier_misses_format(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    topic = "油敏皮夏季通勤防晒"
    invalid_answer = (
        "1. 肤质与场景：高温通勤 [来源1]。\n"
        "2. 使用感受：肤感清爽 [来源1]。\n"
        "3. 防晒产品类型：物化结合 [来源1]。\n"
        "4. 可能不适合的人群：香精敏感者 [来源1]。"
    )
    valid_answer = "\n\n".join(
        f"### {index}. 高温通勤记录 {index}\n\n"
        "- **肤质与场景**：高温通勤\n"
        "- **使用感受**：肤感清爽\n"
        "- **防晒产品类型**：物化结合\n"
        "- **可能不适合的人群**：香精敏感者\n"
        "- **来源链接**：[来源1]"
        for index in range(1, 4)
    ) + "\n\n> 这些内容来自个人使用体验，不构成医疗建议。"
    scenario = Scenario(
        supervisor_channels=["xiaohongshu"],
        plans=[[topic]],
        evidence_by_query={topic: True},
        channels_by_query={topic: "xiaohongshu"},
        writer_answers=[invalid_answer, valid_answer],
        verifier_actions=["pass", "pass"],
    )

    output, _events = await run_scenario(
        monkeypatch,
        scenario,
        question=(
            "请搜索小红书上关于“油敏皮夏季通勤防晒”的近期使用笔记。"
            "只读取可访问正文，按“肤质与场景 / 使用感受 / 防晒产品类型 / "
            "可能不适合的人群 / 来源链接”归纳 3–5 条经验；"
            "不得把个人体验写成医疗建议，正文不可读时不展示为证据。"
        ),
    )

    assert output["response_status"] == "completed"
    assert output["stop_reason"] == "VERIFIED"
    assert output["answer"] == valid_answer
    assert output["answer_source"] == "model"
    assert output["answer_model_calls"] == 1
    assert scenario.writer_stream_calls == 2
    assert scenario.structured_calls["verifier"] == 2
    first_writer_prompt = scenario.writer_messages[0][-1].content
    assert "输出格式硬约束" in first_writer_prompt
    assert "### N. 短标题" in first_writer_prompt
    assert "**肤质与场景**" in first_writer_prompt


@pytest.mark.asyncio
async def test_invalid_reflector_structure_uses_evidence_and_continues_to_verifier(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(invalid_structured_roles={"reflector"})

    output, events = await run_scenario(monkeypatch, scenario)

    assert output["response_status"] == "completed"
    assert output["verification_passed"] is True
    assert output["stop_reason"] == "VERIFIED"
    assert scenario.structured_calls["reflector"] == 1
    assert scenario.structured_calls["source_curator"] == 1
    assert any(event["type"] == "tool.presented" for event in events)
    reflect_completed = [
        event
        for event in events
        if event["type"] == "node.completed" and event["node"] == "reflect"
    ]
    assert len(reflect_completed) == 1
    assert reflect_completed[0]["publicSummary"] is None


@pytest.mark.asyncio
async def test_schema_repair_is_counted_and_disables_later_node_repair(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # attempts=2 是真实 Provider 尝试；format_repairs=1 才是被计数的 schema 修复。
    scenario = Scenario(
        structured_attempts={"planner": 2},
        structured_format_repairs={"planner": 1},
    )
    output, _events = await run_scenario(monkeypatch, scenario)

    assert output["response_status"] == "completed"
    assert output["schema_repair_count"] == 1
    # Supervisor 真实判断当前意图；Researcher 不再复述 Planner 的固定参数。
    assert output["model_calls"] == 6
    planner_index = scenario.structured_repair_permissions.index(("planner", True))
    assert all(
        not allowed
        for _role, allowed in scenario.structured_repair_permissions[planner_index + 1:]
    )


@pytest.mark.asyncio
async def test_single_search_uses_deterministic_tool_id_and_complete_ledger(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario()
    output, events = await run_scenario(monkeypatch, scenario)

    assert output["response_status"] == "completed"
    assert output["pending_queries"] == []
    assert output["tool_calls"] == 1
    assert len(output["evidence"]) == 1
    assert scenario.tool_executions == ["query one"]

    tool_call_id = output["tool_traces"][0]["tool_call_id"]
    assert tool_call_id.startswith("call_search_")
    assert output["tool_traces"][0]["research_batch_id"].startswith(
        "research_batch_"
    )
    assert output["tool_traces"][0]["research_result_id"].startswith(
        "research_result_"
    )
    assert output["tool_traces"][0]["operation_ref"].startswith("operation_")
    assert output["tool_traces"][0]["attempt"] == 1
    assert len(output["tool_traces"][0]["input_hash"]) == 64
    assert len(output["tool_traces"][0]["output_hash"]) == 64
    assert output["tool_traces"][0]["result_ref"].startswith("tool_result_")
    tool_events = [
        event for event in events if event.get("toolCallId") == tool_call_id
    ]
    assert [
        event["type"]
        for event in tool_events
        if event["type"].startswith("tool.")
    ] == [
        "tool.started",
        "tool.progress",
        "tool.progress",
        "tool.completed",
        "tool.presented",
    ]
    evidence_events = [
        event for event in tool_events if event["type"] == "evidence.updated"
    ]
    assert [event["status"] for event in evidence_events] == [
        "read",
        "accepted",
        "cited",
    ]
    assert [event["reasonCode"] for event in evidence_events] == [
        "BODY_READ",
        "SOURCE_PRESENTED",
        "ANSWER_CITED",
    ]
    assert len({event["evidenceId"] for event in evidence_events}) == 1
    assert len({event["sourceId"] for event in evidence_events}) == 1
    assert len({event["contentHash"] for event in evidence_events}) == 1
    assert not any("text" in event for event in evidence_events)
    assert output["evidence"][0]["status"] == "cited"
    assert [
        (event["resultCount"], event["evidenceCount"])
        for event in tool_events
        if event["type"] == "tool.progress"
    ] == [(1, 0), (1, 1)]
    completed = next(event for event in tool_events if event["type"] == "tool.completed")
    started = next(event for event in tool_events if event["type"] == "tool.started")
    assert started["operationRef"] == output["tool_traces"][0]["operation_ref"]
    assert started["researchBatchId"] == output["tool_traces"][0]["research_batch_id"]
    assert started["researchResultId"] == output["tool_traces"][0]["research_result_id"]
    assert completed["resultRef"] == output["tool_traces"][0]["result_ref"]
    assert completed["outputHash"] == output["tool_traces"][0]["output_hash"]
    assert completed["usage"]["calls"] == 1
    assert completed["usage"]["pageReads"] == 1
    assert completed["status"] == "success"
    assert completed["primaryProvider"] == "deterministic"
    assert completed["effectiveProvider"] == "deterministic"
    assert completed["nextAction"] == "none"
    assert isinstance(completed["durationMs"], int)
    assert completed["durationMs"] >= 0


@pytest.mark.asyncio
async def test_independent_searches_run_concurrently_and_merge_in_plan_order(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(
        plans=[["slow web", "fast x"]],
        supervisor_channels=["web", "x"],
        channels_by_query={"slow web": "web", "fast x": "x"},
        evidence_by_query={"slow web": True, "fast x": True},
        tool_delay_by_query={"slow web": 0.25, "fast x": 0.05},
    )

    output, events = await run_scenario(
        monkeypatch,
        scenario,
        question="同时搜索官网网页和 X/Twitter 的最新信息",
    )
    tool_span = (
        max(scenario.tool_finished_at_by_query.values())
        - min(scenario.tool_started_at_by_query.values())
    )

    assert scenario.max_active_tool_calls == 2
    assert scenario.tool_completion_order[:2] == ["fast x", "slow web"]
    assert tool_span < 0.29
    assert [item["query"] for item in output["candidates"][:2]] == [
        "slow web",
        "fast x",
    ]
    assert [item["query"] for item in output["tool_traces"][:2]] == [
        "slow web",
        "fast x",
    ]
    assert "research_work_item" not in output
    assert output["research_results"] == []
    assert len(output["merged_research_result_ids"]) == 2
    research_starts = [
        event
        for event in events
        if event["type"] == "node.started" and event["node"] == "research"
    ]
    research_completions = [
        event
        for event in events
        if event["type"] == "node.completed" and event["node"] == "research"
    ]
    merge_starts = [
        event
        for event in events
        if event["type"] == "node.started" and event["node"] == "merge_research"
    ]
    assert len(research_starts) == 2
    assert len(research_completions) == 2
    assert len(merge_starts) == 1
    assert max(event["seq"] for event in research_completions) < merge_starts[0]["seq"]


@pytest.mark.asyncio
async def test_dependent_batch_is_dispatched_only_after_prior_merge_checkpoint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(
        plans=[["definition", "comparison"]],
        channels_by_query={"definition": "web", "comparison": "web"},
        depends_on_by_query={"comparison": ["search_1"]},
        evidence_by_query={"definition": True, "comparison": True},
    )

    output, events = await run_scenario(monkeypatch, scenario)

    assert scenario.tool_executions == ["definition", "comparison"]
    merge_completions = [
        event
        for event in events
        if event["type"] == "node.completed" and event["node"] == "merge_research"
    ]
    mark_starts = [
        event
        for event in events
        if event["type"] == "node.started" and event["node"] == "mark_plan_running"
    ]
    research_starts = [
        event
        for event in events
        if event["type"] == "node.started" and event["node"] == "research"
    ]
    assert len(merge_completions) == 2
    assert len(mark_starts) == 2
    assert len(research_starts) == 2
    assert merge_completions[0]["seq"] < mark_starts[1]["seq"]
    assert [step["status"] for step in output["plan"]["steps"]] == ["done", "done"]
    assert output["plan"]["revision"] == 5


@pytest.mark.asyncio
async def test_unmet_dependency_is_blocked_then_reflected_without_false_deadlock(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(
        plans=[["root without body", "dependent follow-up"]],
        depends_on_by_query={"dependent follow-up": ["search_1"]},
        evidence_by_query={"root without body": False, "dependent follow-up": True},
        evidence_needed_by_query={"root without body": 1},
    )

    output, events = await run_scenario(monkeypatch, scenario)

    assert scenario.tool_executions[0] == "root without body"
    assert len(scenario.tool_executions) == 2
    assert scenario.tool_executions[1] != "dependent follow-up"
    assert output["plan_fallback_count"] == 1
    blocked_plan = next(
        plan for plan in output["plan_history"]
        if len(plan["steps"]) == 2
    )
    assert [step["status"] for step in blocked_plan["steps"]] == [
        "blocked",
        "blocked",
    ]
    assert blocked_plan["steps"][1]["reason_code"] == "PLAN_DEPENDENCY_BLOCKED"
    assert output["stop_reason"] != "PLAN_NO_RUNNABLE_STEP"
    assert any(
        event["type"] == "node.started" and event["node"] == "reflect"
        for event in events
    )


@pytest.mark.asyncio
async def test_successful_step_with_some_evidence_is_done_even_below_target(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(
        evidence_by_query={"query one": True},
        evidence_needed_by_query={"query one": 3},
    )

    output, _events = await run_scenario(monkeypatch, scenario)

    assert output["stop_reason"] == "VERIFIED"
    assert output["tool_traces"][0]["evidence_count"] == 1
    assert output["plan"]["steps"][0]["status"] == "done"
    assert output["plan"]["steps"][0]["reason_code"] is None


@pytest.mark.asyncio
async def test_reflector_preserves_time_for_answer_instead_of_starting_dead_plan(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(
        plans=[["query one"], ["query two"]],
        reflects=[{
            "sufficient": False,
            "missing": "仍缺少第二类官方来源",
            "extra_searches": [{"query": "query two", "channel": "web"}],
            "source_presentations": [{
                "url": "https://example.com/1",
                "text": "该正文提供了第一类官方事实。",
            }],
        }],
        evidence_by_query={"query one": True, "query two": True},
    )
    monkeypatch.setattr(
        nodes,
        "remaining_run_seconds",
        lambda state: 70.0 if state.get("evidence") else 120.0,
    )

    output, events = await run_scenario(monkeypatch, scenario)

    assert scenario.tool_executions == ["query one"]
    assert scenario.structured_calls["planner"] == 1
    assert output["stop_reason"] == "RUN_TIME_RESERVE"
    assert output["plan"]["steps"][0]["status"] == "done"
    assert not any(
        event["type"] == "plan.updated" and event["iteration"] == 2
        for event in events
    )


@pytest.mark.asyncio
async def test_reflector_presents_only_current_real_candidate_urls(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(reflects=[{
        "sufficient": True,
        "missing": "",
        "extra_searches": [],
        "source_presentations": [
            {"url": "https://example.com/1", "text": "该来源介绍了与问题相关的可核验做法。"},
            {"url": "https://invented.example/item", "text": "这条 URL 不在真实候选中。"},
        ],
    }])
    output, events = await run_scenario(monkeypatch, scenario)

    presented = [event for event in events if event["type"] == "tool.presented"]
    assert len(presented) == 1
    tool_call_id = output["candidates"][0]["tool_call_id"]
    assert presented[0]["toolCallId"] == tool_call_id
    assert presented[0]["sources"] == [{
        "url": "https://example.com/1",
        "text": "该来源介绍了与问题相关的可核验做法。",
    }]
    assert output["candidates"][0]["tool_call_id"] == tool_call_id
    assert output["candidates"][0]["iteration"] == 1


@pytest.mark.asyncio
async def test_reflector_excludes_read_but_irrelevant_evidence_from_details(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(reflects=[{
        "sufficient": False,
        "missing": "该来源不符合用户限定条件",
        "extra_searches": [],
        "source_presentations": [{
            "url": "https://example.com/1",
            "include_in_details": False,
            "text": "",
        }],
    }])

    output, events = await run_scenario(monkeypatch, scenario)

    assert not [event for event in events if event["type"] == "tool.presented"]
    assert scenario.structured_calls.get("source_curator", 0) == 0
    assert output["evidence"][0]["status"] == "rejected"
    rejected = [event for event in events if event["type"] == "evidence.updated"]
    assert rejected[-1]["status"] == "rejected"
    assert rejected[-1]["reasonCode"] == "SOURCE_EXCLUDED"
    assert "verified evidence for query one" not in "\n".join(
        str(message.content)
        for messages in scenario.structured_messages.get("writer", [])
        for message in messages
    )


@pytest.mark.asyncio
async def test_source_curator_replaces_invalid_presentations_with_agent_output(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(reflects=[{
        "sufficient": True,
        "missing": "",
        "extra_searches": [],
        "source_presentations": [
            {"url": "https://example.com/1", "text": "但帖子详情/正文内容未读取。"},
            {"url": "https://example.com/1", "text": "仅发现公开候选，尚未核验。"},
            {"url": "https://example.com/1", "text": "正文仅包含标签，无有效对比内容。"},
            {
                "url": "https://example.com/1",
                "text": "该教程未涉及 LangChain 与 LangSmith 的区别。",
            },
        ],
    }])

    output, events = await run_scenario(monkeypatch, scenario)

    presented = [event for event in events if event["type"] == "tool.presented"]
    assert scenario.structured_calls["source_curator"] == 1
    assert len(presented) == 1
    assert presented[0]["toolCallId"] == output["tool_traces"][0]["tool_call_id"]
    assert presented[0]["sources"] == [{
        "url": "https://example.com/1",
        "text": "该来源正文提供了与用户问题直接相关的有效事实。",
    }]


@pytest.mark.asyncio
async def test_source_curator_fills_every_missing_current_evidence_presentation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(
        plans=[["query one", "query two"]],
        evidence_by_query={"query one": True, "query two": True},
        reflects=[{
            "sufficient": True,
            "missing": "",
            "extra_searches": [],
            "source_presentations": [{
                "url": "https://example.com/1",
                "text": "第一条来源给出了与问题相关的可核验做法。",
            }],
        }],
    )

    _output, events = await run_scenario(monkeypatch, scenario)

    presented = [event for event in events if event["type"] == "tool.presented"]
    presented_urls = {
        source["url"]
        for event in presented
        for source in event["sources"]
    }
    assert presented_urls == {
        "https://example.com/1",
        "https://example.com/2",
    }
    assert scenario.structured_calls["source_curator"] == 1
    curator_prompt = str(
        scenario.structured_messages["source_curator"][0][-1].content
    )
    assert "https://example.com/2" in curator_prompt
    assert "https://example.com/1" not in curator_prompt


@pytest.mark.asyncio
async def test_supervisor_and_planner_route_x_query_into_real_x_tool_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(
        supervisor_channels=["x"],
        plans=[["OpenAI 最新帖子"]],
        channels_by_query={"OpenAI 最新帖子": "x"},
        evidence_by_query={"OpenAI 最新帖子": True},
    )
    output, events = await run_scenario(
        monkeypatch,
        scenario,
        question="在 X/Twitter 搜索 OpenAI 最新帖子",
    )

    assert output["query_channels"] == {"OpenAI 最新帖子": "x"}
    assert output["candidates"][0]["channel"] == "x"
    started = next(event for event in events if event["type"] == "tool.started")
    assert started["channel"] == "x"
    assert scenario.tool_executions == ["OpenAI 最新帖子"]


@pytest.mark.asyncio
async def test_planner_receives_the_current_date_for_relative_time_queries(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(
        plans=[["OpenAI 近 90 天帖子"]],
        evidence_by_query={"OpenAI 近 90 天帖子": True},
    )

    await run_scenario(monkeypatch, scenario)

    planner_prompt = str(scenario.structured_messages["planner"][0][-1].content)
    assert f"当前日期：{datetime.now(UTC).date().isoformat()}" in planner_prompt


@pytest.mark.asyncio
async def test_planner_cannot_escape_supervisor_channel_scope(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(
        supervisor_channels=["xiaohongshu"],
        plans=[["未授权的网页查询"]],
        channels_by_query={"未授权的网页查询": "web"},
        evidence_by_query={},
    )
    output, events = await run_scenario(
        monkeypatch,
        scenario,
        question="只在小红书搜索测试内容",
    )

    assert output["queries"]
    assert scenario.tool_executions
    assert all(
        item["channel"] == "xiaohongshu"
        for item in scenario.tool_execution_searches
    )
    assert any(event["type"] == "tool.started" for event in events)
    assert output["plan_fallback_count"] >= 1
    assert "未授权的网页查询" not in scenario.tool_executions
    assert output["plan_error_code"] is None
    assert any(
        event["type"] == "plan.updated" and event["planSource"] == "runtime"
        for event in events
    )


@pytest.mark.asyncio
async def test_reflector_replans_then_searches_new_query(monkeypatch: pytest.MonkeyPatch) -> None:
    scenario = Scenario(
        plans=[["query one"], ["query two"]],
        reflects=[
            {
                "sufficient": False,
                "missing": "missing",
                "extra_searches": [{"query": "query two", "channel": "web"}],
            },
            {"sufficient": True, "missing": "", "extra_searches": []},
        ],
        evidence_by_query={"query one": False, "query two": True},
    )
    output, _events = await run_scenario(monkeypatch, scenario, depth="balanced")

    assert output["round"] == 2
    assert output["queries"] == ["query one", "query two"]
    assert scenario.tool_executions == ["query one", "query two"]
    assert output["response_status"] == "completed"
    first, second = output["search_attempts"]
    gap = output["evidence_gaps"][0]
    assert first["gap_id"] is None
    assert second["gap_id"] == gap["gap_id"]
    assert second["parent_attempt_id"] == first["attempt_id"]
    assert second["strategy"] == "channel_fallback"
    assert second["new_evidence_count"] == 1
    assert second["progress"] is True
    assert gap["status"] == "closed"
    assert gap["resolved_by_attempt_id"] == second["attempt_id"]
    second_planner_prompt = str(
        scenario.structured_messages["planner"][1][-1].content
    )
    assert first["attempt_id"] in second_planner_prompt
    assert gap["gap_id"] in second_planner_prompt


@pytest.mark.asyncio
async def test_zero_result_without_suggestion_replans_from_tool_feedback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(
        plans=[["query one"], ["query two"]],
        reflects=[
            {"sufficient": False, "missing": "no evidence", "extra_searches": []},
            {"sufficient": True, "missing": "", "extra_searches": []},
        ],
        result_count_by_query={"query one": 0},
        evidence_by_query={"query one": False, "query two": True},
    )
    output, _events = await run_scenario(monkeypatch, scenario)

    assert output["response_status"] == "completed"
    assert scenario.tool_executions == ["query one", "query two"]
    assert output["tool_traces"][0]["result_count"] == 0
    assert output["tool_traces"][0]["limitation"] == "未找到公开候选"
    second_planner_prompt = scenario.structured_messages["planner"][1][-1].content
    assert all(
        field in second_planner_prompt
        for field in (
            '"channel": "web"',
            '"resultCount": 0',
            '"evidenceCount": 0',
            '"errorCode": null',
            '"limitation": "未找到公开候选"',
        )
    )


@pytest.mark.asyncio
async def test_verifier_does_not_apply_candidate_limitations_to_read_evidence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    limitation = "受单轮详情读取上限限制，其他候选正文未读取"
    scenario = Scenario(
        limitations_by_query={"query one": limitation},
        evidence_by_query={"query one": True},
    )

    output, _events = await run_scenario(monkeypatch, scenario)

    assert output["verification_passed"] is True
    verifier_input = str(
        scenario.structured_messages["verifier"][0][-1].content
    )
    assert limitation not in verifier_input
    assert '"evidenceCount": 1' in verifier_input
    assert "URL: https://example.com/1" in verifier_input
    assert "verified evidence for query one" in verifier_input


@pytest.mark.asyncio
async def test_verifier_cannot_pass_when_a_required_channel_has_no_evidence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(
        supervisor_channels=["web", "x"],
        plans=[["query one"]],
        channels_by_query={"query one": "web"},
        evidence_by_query={"query one": True},
        verifier_actions=["pass"],
    )

    output, _events = await run_scenario(
        monkeypatch,
        scenario,
        question="比较官网网页与 X/Twitter 的公开证据",
        max_rounds=1,
    )

    assert output["verification_passed"] is False
    assert output["response_status"] == "partial"
    assert output["stop_reason"] == "MAX_ITERATIONS"
    assert "Evidence：x" in output["verification_issue"]
    verifier_input = str(
        scenario.structured_messages["verifier"][0][-1].content
    )
    assert '"requiredChannels": ["web", "x"]' in verifier_input
    assert '"evidenceChannels": ["web"]' in verifier_input
    assert '"missingChannels": ["x"]' in verifier_input


@pytest.mark.asyncio
async def test_complementary_channel_does_not_replace_required_channel_evidence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(
        supervisor_channels=["web"],
        plans=[["query one"], ["query x"]],
        channels_by_query={"query one": "web", "query x": "x"},
        reflects=[
            {
                "sufficient": False,
                "missing": "缺少一手讨论",
                "extra_searches": [{"query": "query x", "channel": "x"}],
            },
            {"sufficient": True, "missing": "", "extra_searches": []},
        ],
        evidence_by_query={"query one": False, "query x": True},
    )
    output, _events = await run_scenario(monkeypatch, scenario)

    assert output["response_status"] == "partial"
    assert output["verification_passed"] is False
    assert output["stop_reason"] == "MAX_ITERATIONS"
    assert "Evidence：web" in output["verification_issue"]
    assert scenario.tool_execution_searches == [
        {"query": "query one", "channel": "web"},
        {"query": "query x", "channel": "x"},
    ]
    assert [
        {"query": item["query"], "channel": item["channel"]}
        for item in output["searches"]
    ] == scenario.tool_execution_searches


@pytest.mark.asyncio
async def test_verifier_research_more_keeps_query_and_channel_structured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(
        supervisor_channels=["web"],
        plans=[["query one"], ["query two"]],
        channels_by_query={"query one": "web", "query two": "x"},
        verifier_actions=["research_more", "pass"],
        evidence_by_query={"query one": True, "query two": True},
    )
    output, _events = await run_scenario(monkeypatch, scenario)

    assert output["response_status"] == "completed"
    assert scenario.tool_execution_searches[-1] == {
        "query": "query two",
        "channel": "x",
    }


@pytest.mark.asyncio
async def test_planner_approved_arguments_bypass_redundant_researcher_tool_selection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """计划批准的参数直接执行工具，不经过第二轮模型选参。"""

    scenario = Scenario()
    output, events = await run_scenario(monkeypatch, scenario)

    # Gateway 只被语义节点调用；工具参数不再由额外一次模型选参产生，
    # 因此不会出现参数不合法或未知工具的裁决事件。
    assert set(scenario.structured_calls) <= {
        "supervisor",
        "planner",
        "reflector",
        "verifier",
        "source_curator",
    }
    assert scenario.tool_executions == ["query one"]
    assert output["tool_calls"] == 1
    assert not any(
        event.get("reasonCode") in {"INVALID_ARGUMENTS", "UNKNOWN_TOOL"}
        for event in events
    )


@pytest.mark.asyncio
async def test_planned_searches_never_exceed_tool_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(
        plans=[["query one", "query two"], ["query one"]],
        evidence_by_query={"query one": True, "query two": True},
    )
    output, events = await run_scenario(monkeypatch, scenario, max_tool_calls=1)

    assert output["tool_calls"] == 1
    assert scenario.tool_executions == ["query one"]
    assert output["stop_reason"] == "VERIFIED"
    assert len(output["tool_traces"]) == 1
    assert scenario.structured_calls["planner"] == 2
    assert not any(
        step.get("reasonCode") == "TOOL_CALL_LIMIT"
        for event in events
        if event["type"] == "plan.updated"
        for step in event["steps"]
    )


@pytest.mark.asyncio
async def test_planner_repairs_wide_plan_to_two_evidence_led_steps(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(
        plans=[
            ["query one", "query two", "query three", "query four"],
            ["query one", "query two"],
        ],
        evidence_by_query={"query one": True, "query two": True},
    )

    output, events = await run_scenario(monkeypatch, scenario, max_tool_calls=4)

    assert output["stop_reason"] == "VERIFIED"
    assert scenario.structured_calls["planner"] == 2
    assert scenario.tool_executions == ["query one", "query two"]
    assert len(output["plan"]["steps"]) == 2
    assert not [event for event in events if event["type"] == "plan.rejected"]
    repair_input = scenario.structured_messages["planner"][1][-1].content
    assert "PLAN_TOOL_BUDGET_EXCEEDED" in repair_input
    assert '"maxSteps": 2' in scenario.structured_messages["planner"][0][-1].content


@pytest.mark.asyncio
async def test_planner_repairs_evidence_targets_above_per_call_capacity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(
        plans=[["query one"], ["query one"]],
        evidence_needed_by_plan=[8, 1],
    )

    output, events = await run_scenario(monkeypatch, scenario)

    assert output["stop_reason"] == "VERIFIED"
    assert scenario.structured_calls["planner"] == 2
    assert scenario.tool_executions == ["query one"]
    assert output["plan"]["steps"][0]["evidence_needed"] == 1
    assert not [event for event in events if event["type"] == "plan.rejected"]
    repair_input = scenario.structured_messages["planner"][1][-1].content
    assert "PLAN_EVIDENCE_TARGET_EXCEEDS_CALL_CAPACITY" in repair_input
    assert repair_input.rstrip().endswith('"需要搜索的测试问题"')


@pytest.mark.asyncio
async def test_planner_repairs_query_constraint_metadata_before_execution(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(
        query_brief_override={
            "version": 1,
            "objective": "核验产品 API",
            "complexity": "multi_faceted",
            "entities": ["Product"],
            "must": [{
                "constraint_id": "product",
                "text": "Product",
                "terms": ["Product"],
            }],
            "should": [{
                "constraint_id": "api",
                "text": "API",
                "terms": ["API"],
            }],
            "exclude": [],
            "time_range": None,
            "locations": [],
            "languages": ["en"],
            "required_channels": [],
            "requested_fields": ["API"],
            "evidence_facets": [{
                "facet_id": "facet_1",
                "description": "官方 API",
                "evidence_type": "official",
                "required_fields": ["API"],
            }],
        },
        plans=[["Product"], ["Product API"]],
        retained_constraint_ids_by_plan=[
            ["product"],
            ["product"],
        ],
        evidence_by_query={"Product API": True},
    )

    output, events = await run_scenario(monkeypatch, scenario)

    # 缺失 should 元数据由服务端按 QueryBrief 词项做确定性加法补全，
    # 不需要再调用模型重生成计划。
    assert scenario.structured_calls["planner"] == 1
    assert scenario.tool_executions == ["Product API"]
    assert output["search_attempts"][0]["retained_constraint_ids"] == [
        "product",
        "api",
    ]
    assert not [event for event in events if event["type"] == "plan.rejected"]


@pytest.mark.asyncio
async def test_double_invalid_plan_uses_private_deterministic_fallback_and_searches(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(
        plans=[
            ["Agent frameworks official", "Agent frameworks comparison"],
            ["Agent frameworks official retry", "Agent frameworks comparison retry"],
        ],
        facet_ids_by_plan=[
            ["facet_1", "facet_1"],
            ["facet_1", "facet_1"],
        ],
        reflects=[{
            "sufficient": False,
            "missing": "仍需可核验来源",
            "extra_searches": [],
            "source_presentations": [],
        }],
        evidence_by_query={},
        writer_answer="本次已执行搜索，但没有取得足够的可核验正文。",
    )

    output, events = await run_scenario(monkeypatch, scenario, max_rounds=1)

    assert scenario.structured_calls["planner"] == 2
    repair_input = str(scenario.structured_messages["planner"][1][-1].content)
    assert '"errorCode": "PLAN_INITIAL_FACET_DUPLICATE"' in repair_input
    assert '"fieldPath": "steps[*].facet_id"' in repair_input
    assert '"rejectedPlan"' in repair_input
    assert output["tool_calls"] >= 1
    assert scenario.tool_executions
    assert output["plan_fallback_count"] == 1
    assert any(
        event["type"] == "plan.updated" and event["planSource"] == "runtime"
        for event in events
    )
    public_events = json.dumps(events, ensure_ascii=False)
    assert "rejectedPlan" not in public_events
    assert "fieldPath" not in public_events


@pytest.mark.asyncio
async def test_invalid_plan_without_finalization_reserve_stops_before_tool(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(
        plans=[["Agent frameworks official", "Agent frameworks comparison"]],
        facet_ids_by_plan=[["facet_1", "facet_1"]],
        reflects=[{
            "sufficient": False,
            "missing": "仍需可核验来源",
            "extra_searches": [],
            "source_presentations": [],
        }],
        evidence_by_query={},
        writer_answer="本次已执行搜索，但没有取得足够的可核验正文。",
    )

    output, events = await run_scenario(
        monkeypatch,
        scenario,
        max_model_calls=4,
        max_rounds=1,
    )

    assert scenario.structured_calls["planner"] == 1
    assert output["tool_calls"] == 0
    assert output["plan_repair_count"] == 0
    assert output["plan_fallback_count"] == 1
    assert output["stop_reason"] == "MODEL_CALL_LIMIT"
    assert not any(event["type"] == "tool.started" for event in events)


@pytest.mark.asyncio
async def test_model_limit_stops_with_partial_answer_without_overshoot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(
        reflects=[{"sufficient": False, "missing": "budget", "extra_searches": []}],
        evidence_by_query={},
        writer_answer="本次没有取得可核验正文，暂时无法可靠归纳。",
    )
    output, _events = await run_scenario(monkeypatch, scenario, max_model_calls=4)

    assert output["model_calls"] <= 4
    assert output["response_status"] == "partial"
    assert output["stop_reason"] == "MODEL_CALL_LIMIT"
    assert output["answer"] == scenario.writer_answer
    assert output["answer_source"] == "model"
    assert output["answer_model_calls"] == 1
    assert scenario.writer_stream_calls == 1


@pytest.mark.asyncio
async def test_tool_timeout_preserves_finalization_instead_of_failing_run(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(
        tool_delay_seconds=0.05,
        progress_before_delay=True,
        evidence_by_query={"query one": False},
    )
    monkeypatch.setattr(nodes, "tool_timeout_seconds", lambda _state, _channel: 0.01)

    output, events = await run_scenario(monkeypatch, scenario)

    assert output["response_status"] == "partial"
    assert output["stop_reason"] == "RUN_TIME_RESERVE"
    assert output["tool_traces"][0]["error_code"] == "RUN_TIME_RESERVE"
    tool_call_id = output["tool_traces"][0]["tool_call_id"]
    tool_events = [
        event for event in events if event.get("toolCallId") == tool_call_id
    ]
    assert [event["type"] for event in tool_events] == [
        "tool.started",
        "tool.progress",
        "tool.failed",
    ]
    assert tool_events[-1]["reasonCode"] == "RUN_TIME_RESERVE"
    assert tool_events[-1]["resultCount"] == 5
    assert tool_events[-1]["evidenceCount"] == 0
    assert tool_events[-1]["durationMs"] >= 0


@pytest.mark.asyncio
async def test_max_iterations_has_stable_partial_stop_reason(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(
        reflects=[{
            "sufficient": False,
            "missing": "more research",
            "extra_searches": [{"query": "query two", "channel": "web"}],
        }],
        verifier_actions=["research_more"],
    )
    output, _events = await run_scenario(monkeypatch, scenario, max_rounds=1)
    assert output["response_status"] == "partial"
    assert output["stop_reason"] == "MAX_ITERATIONS"


@pytest.mark.asyncio
async def test_verifier_pass_overrides_soft_search_iteration_stop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(
        reflects=[{
            "sufficient": False,
            "missing": "reflector 仍建议补充，但最终回答已可核验",
            "extra_searches": [{"query": "query two", "channel": "web"}],
        }],
        verifier_actions=["pass"],
    )

    output, _events = await run_scenario(monkeypatch, scenario, max_rounds=1)

    assert output["response_status"] == "completed"
    assert output["verification_passed"] is True
    assert output["stop_reason"] == "VERIFIED"


@pytest.mark.asyncio
async def test_rewrite_can_finish_after_soft_search_iteration_stop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(
        reflects=[{
            "sufficient": False,
            "missing": "只需修正回答措辞",
            "extra_searches": [{"query": "query two", "channel": "web"}],
        }],
        verifier_actions=["rewrite", "pass"],
    )

    output, _events = await run_scenario(monkeypatch, scenario, max_rounds=1)

    assert output["response_status"] == "completed"
    assert output["verification_passed"] is True
    assert output["stop_reason"] == "VERIFIED"
    assert output["repair_count"] == 1


@pytest.mark.asyncio
async def test_rewrite_can_finish_after_tool_call_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(verifier_actions=["rewrite", "pass"])

    output, _events = await run_scenario(
        monkeypatch,
        scenario,
        max_tool_calls=1,
    )

    assert output["response_status"] == "completed"
    assert output["verification_passed"] is True
    assert output["stop_reason"] == "VERIFIED"
    assert output["repair_count"] == 1
    assert output["tool_calls"] == 1


@pytest.mark.asyncio
async def test_no_progress_has_stable_partial_stop_reason(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(
        reflects=[{"sufficient": False, "missing": "unsupported", "extra_searches": []}],
        result_count_by_query={"query one": 0},
        default_result_count=0,
        evidence_by_query={"query one": False},
    )
    output, _events = await run_scenario(monkeypatch, scenario, max_rounds=3)
    assert output["response_status"] == "partial"
    assert output["stop_reason"] == "NO_PROGRESS"


@pytest.mark.asyncio
async def test_rewrite_limit_has_stable_partial_stop_reason(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(verifier_actions=["rewrite", "rewrite"])
    output, _events = await run_scenario(monkeypatch, scenario)
    assert output["response_status"] == "partial"
    assert output["stop_reason"] == "REWRITE_LIMIT"


@pytest.mark.asyncio
async def test_node_run_ids_pair_and_rewrite_runs_are_unique(monkeypatch: pytest.MonkeyPatch) -> None:
    scenario = Scenario(verifier_actions=["rewrite", "pass"])
    output, events = await run_scenario(monkeypatch, scenario)
    assert output["response_status"] == "completed"

    starts = {event["nodeRunId"]: event for event in events if event["type"] == "node.started"}
    completions = [event for event in events if event["type"] == "node.completed"]
    assert completions
    assert all(event["nodeRunId"] in starts for event in completions)
    compose_ids = [event["nodeRunId"] for event in completions if event["node"] == "compose"]
    verify_ids = [event["nodeRunId"] for event in completions if event["node"] == "verify"]
    assert len(compose_ids) == len(set(compose_ids)) == 2
    assert len(verify_ids) == len(set(verify_ids)) == 2
    verification_events = [event for event in events if event["type"] == "verification.completed"]
    assert [event["nodeRunId"] for event in verification_events] == verify_ids
    assert all(
        event["publicSummarySource"] == "model"
        for event in completions
        if event.get("publicSummary")
    )
    assert all(
        event["publicSummarySource"] == "model"
        for event in verification_events
        if event.get("publicSummary")
    )
    assert all(
        event["presentationSource"] == "model"
        for event in events
        if event["type"] == "tool.presented"
    )
    assert [event["seq"] for event in events] == list(range(1, len(events) + 1))
    assert len({event["eventId"] for event in events}) == len(events)


@pytest.mark.asyncio
async def test_private_reasoning_never_crosses_state_checkpoint_or_public_events(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """图层不得把模型内部字段带进 State、checkpoint 或公开事件。

    #46 之后节点只经 ModelGateway 取 ``(parsed, ModelUsage)`` 与纯文本增量，
    契约本身没有承载 ``reasoning_content`` 的通道，图层已无处注入该字段；
    真正剥离 reasoning 的行为断言在 ``test_deepseek_model_adapter.py``。
    本用例保留为结构回归守卫：任何新增的模型内部字段一旦流到公开面就会失败。
    """

    scenario = Scenario()
    output, events = await run_scenario(monkeypatch, scenario)

    serialized = json.dumps(
        {
            "state": output,
            "checkpoint": scenario.checkpoint_values,
            "events": events,
            "terminal": {
                "type": "run.completed",
                "answerMarkdown": output["answer"],
                "responseStatus": output["response_status"],
                "citations": output["citations"],
                "usage": output["usage"],
            },
        },
        ensure_ascii=False,
    )
    assert "reasoning_content" not in serialized
    # reasoning_effort 是请求侧配置，属于公开面；这里只守思维链正文本身。
    assert "chain_of_thought" not in serialized


@pytest.mark.asyncio
async def test_private_query_strategy_stays_out_of_events_spans_and_logs(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    sentinels = {
        "PRIVATE_BRIEF_OBJECTIVE_52",
        "PRIVATE_REQUEST_FIELD_52",
        "PRIVATE_FACET_DESCRIPTION_52",
        "PRIVATE_QUERY_TERM_52_A",
        "PRIVATE_QUERY_TERM_52_B",
        "PRIVATE_GAP_DESCRIPTION_52",
        "facet_private_52",
    }
    query_brief = {
        "version": 1,
        "objective": "PRIVATE_BRIEF_OBJECTIVE_52",
        "complexity": "multi_faceted",
        "entities": [],
        "must": [],
        "should": [],
        "exclude": [],
        "time_range": None,
        "locations": [],
        "languages": ["zh-CN"],
        "required_channels": [],
        "requested_fields": ["PRIVATE_REQUEST_FIELD_52"],
        "evidence_facets": [{
            "facet_id": "facet_private_52",
            "description": "PRIVATE_FACET_DESCRIPTION_52",
            "evidence_type": "independent",
            "required_fields": ["PRIVATE_REQUEST_FIELD_52"],
        }],
    }
    scenario = Scenario(
        query_brief_override=query_brief,
        plans=[["query one"], ["query two"]],
        query_terms_by_query={
            "query one": ["PRIVATE_QUERY_TERM_52_A"],
            "query two": ["PRIVATE_QUERY_TERM_52_B"],
        },
        reflects=[
            {
                "sufficient": False,
                "missing": "PRIVATE_GAP_DESCRIPTION_52",
                "extra_searches": [{"query": "query two", "channel": "web"}],
                "source_presentations": [],
            },
            {
                "sufficient": True,
                "missing": "",
                "extra_searches": [],
                "source_presentations": [{
                    "url": "https://example.com/2",
                    "text": "第二轮正文补足了所需事实。",
                }],
            },
        ],
        evidence_by_query={"query one": False, "query two": True},
    )

    output, events = await run_scenario(monkeypatch, scenario)
    assert output["response_status"] == "completed"
    assert output["verification_passed"] is True
    private_ids = {
        output["search_attempts"][0]["attempt_id"],
        output["search_attempts"][0]["constraint_signature"],
        output["evidence_gaps"][0]["gap_id"],
    }
    private_values = sentinels | private_ids
    encoded_state = json.dumps(output, ensure_ascii=False)
    assert private_values <= {
        value for value in private_values if value in encoded_state
    }

    class RecordingSpanSink:
        def __init__(self) -> None:
            self.spans: list[Span] = []

        def emit(self, span: Span) -> None:
            self.spans.append(span)

        def flush(self) -> None:
            pass

    sink = RecordingSpanSink()
    tracer = RunTracer(output["run_id"], sink=sink)
    for event in events:
        tracer.observe(event)
    tracer.finish()

    public_surfaces = json.dumps(
        {
            "events": events,
            "spans": [asdict(span) for span in sink.spans],
            "logs": caplog.text,
        },
        ensure_ascii=False,
    )
    assert all(value not in public_surfaces for value in private_values)


def _drain_emitter(chunks: list[str], evidence: list[Any], max_chars: int) -> tuple[str, str]:
    """把一串增量喂给 emitter，返回（公开文本, 最终交付 answer）。"""

    emitter = nodes._AnswerStreamEmitter(evidence, max_chars)
    published = ""
    for chunk in chunks:
        published += emitter.push(chunk)
    assert published == emitter.published
    answer = nodes._compact_answer_markdown("".join(chunks), max_chars=max_chars)
    return published, answer


def _stream_evidence(count: int, *, shared_url: bool = False) -> list[Any]:
    return [
        {
            "channel": "web",
            "provider": "tavily",
            "query": "流式测试",
            "url": (
                "https://example.com/shared"
                if shared_url
                else f"https://example.com/source_{index}"
            ),
            "title": f"来源 {index}",
            "text": "已读取正文",
            "extractor": "readability",
            "captured_at": "2026-08-01T00:00:00Z",
        }
        for index in range(1, count + 1)
    ]


def test_streamed_answer_text_is_always_a_prefix_of_the_delivered_answer() -> None:
    # A2：公开流是 append-only 的，必须始终是终稿的前缀，绝不能出现收不回的尾巴。
    evidence = _stream_evidence(2)
    body = "\n".join(
        f"- 要点{index}：这条结论有可核验来源支撑 [来源1][来源2]。"
        for index in range(1, 12)
    )
    chunks = [body[offset:offset + 5] for offset in range(0, len(body), 5)]

    published, answer = _drain_emitter(chunks, evidence, 180)

    assert len(answer) <= 180
    assert published
    assert answer.startswith(published)


def test_streamed_answer_normalizes_sparse_citations_exactly_like_finalize() -> None:
    # A3：公开流按首次出现顺序增量归一 [来源N]，与 finalize 的一次性归一收敛到同一文本。
    evidence = _stream_evidence(4)
    body = "第一段只引用第三个来源 [来源3]。\n第二段引用第一个来源 [来源1]。\n"
    chunks = [body[offset:offset + 3] for offset in range(0, len(body), 3)]

    published, answer = _drain_emitter(chunks, evidence, nodes.ANSWER_MAX_CHARS)
    normalized, citations = nodes._answer_citations(answer, evidence)

    # State 里保留模型原始编号，归一化只在 finalize 发生一次。
    assert "[来源3]" in answer
    # 公开流已提前完成同一映射：3 → 1、1 → 2。
    assert published.startswith("第一段只引用第三个来源 [来源1]。")
    assert "[来源2]" in published
    assert normalized.startswith(published)
    assert [citation["url"] for citation in citations] == [
        "https://example.com/source_3",
        "https://example.com/source_1",
    ]


def test_streamed_answer_merges_duplicate_source_urls_like_finalize() -> None:
    # 同 URL 的多个 Evidence 在 finalize 会合并成一个编号，公开流必须同样合并。
    evidence = _stream_evidence(3, shared_url=True)
    body = "同一来源被引用两次 [来源1] 与 [来源2]。\n后续正文继续展开说明。\n"

    published, answer = _drain_emitter([body], evidence, nodes.ANSWER_MAX_CHARS)
    normalized, citations = nodes._answer_citations(answer, evidence)

    assert published.startswith("同一来源被引用两次 [来源1] 与 [来源1]。")
    assert normalized.startswith(published)
    assert len(citations) == 1


def test_streamed_answer_withholds_text_the_final_answer_would_strip() -> None:
    # A2 边界：终稿会删掉悬空标题与未闭合代码块；这些文本不能先公开。
    evidence = _stream_evidence(1)
    emitter = nodes._AnswerStreamEmitter(evidence, nodes.ANSWER_MAX_CHARS)

    # 悬空的三级标题在后续正文到达前必须一直压住。
    assert emitter.push("### 1. 短标题\n") == ""
    assert emitter.push("- **字段**：正文内容 [来源1]。\n") != ""
    assert emitter.published.startswith("### 1. 短标题")

    # 公开文本不以空白结尾，终稿在边界处 rstrip 不会造成差异。
    assert emitter.published == emitter.published.rstrip()


def test_streamed_answer_never_publishes_beyond_the_delivery_limit() -> None:
    # A2 边界：公开流受同一个交付上限约束，绝不能越过终稿的截断点。
    evidence = _stream_evidence(1)
    body = "".join(f"第{index}句可核验结论 [来源1]。" for index in range(1, 40))

    published, answer = _drain_emitter([body], evidence, 120)

    assert len(published) <= 120
    assert len(answer) <= 120
    assert answer.startswith(published)


@pytest.mark.asyncio
async def test_writer_streams_answer_deltas_before_the_run_terminates(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A1 真流式：正文在 compose 节点内逐块公开，而不是等到 finalize 整段送达。
    answer = "结论先行：这条结论有可核验来源支撑 [来源1]。\n后续补充说明同样来自该来源 [来源1]。"
    scenario = Scenario(writer_answer=answer, writer_stream_chunk_chars=4)

    output, events = await run_scenario(monkeypatch, scenario)

    started = [event for event in events if event["type"] == "answer.started"]
    deltas = [event for event in events if event["type"] == "answer.delta"]
    completed = [event for event in events if event["type"] == "answer.completed"]

    assert len(started) == 1
    assert len(completed) == 1
    assert len(deltas) > 1, "正文必须分多块公开，否则不是真流式"
    # A2：拼接后的公开流是终稿的前缀，且逐块 append 顺序不变。
    streamed = "".join(event["delta"] for event in deltas)
    assert output["answer"].startswith(streamed)
    assert output["answer_source"] == "model"

    # answer.started 必须早于所有 delta，answer.completed 必须晚于所有 delta。
    order = [event["type"] for event in events if event["type"].startswith("answer.")]
    assert order[0] == "answer.started"
    assert order[-1] == "answer.completed"
    assert set(order[1:-1]) == {"answer.delta"}


@pytest.mark.asyncio
async def test_answer_stream_events_carry_no_private_or_raw_model_fields(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A4 无泄露：answer.* 只允许公开正文与 composeRound，不得夹带任何模型内部字段。
    scenario = Scenario(
        writer_answer="可核验回答 [来源1]。\n继续补充一句可核验说明 [来源1]。",
        writer_stream_chunk_chars=3,
    )

    _output, events = await run_scenario(monkeypatch, scenario)

    answer_events = [event for event in events if event["type"].startswith("answer.")]
    assert answer_events
    for event in answer_events:
        extra = set(event) - {
            "type", "version", "eventId", "streamId", "streamSeq", "seq",
            "runId", "createdAt", "composeRound", "delta",
        }
        assert not extra, f"answer.* 出现未审计字段：{sorted(extra)}"
    serialized = json.dumps(answer_events, ensure_ascii=False)
    assert "reasoning" not in serialized
    assert "tool_calls" not in serialized
    assert "arguments" not in serialized


@pytest.mark.asyncio
async def test_rewrite_round_starts_a_new_answer_stream_instead_of_appending(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A7 二次撰写：rewrite 产出的是另一段答案，composeRound 必须递增以便前端换 messageId。
    scenario = Scenario(
        writer_answers=[
            "第一版回答缺少必要说明 [来源1]。\n这一版会被核验要求改写 [来源1]。",
            "第二版回答补齐了必要说明 [来源1]。\n这一版通过核验 [来源1]。",
        ],
        verifier_actions=["rewrite", "pass"],
        writer_stream_chunk_chars=6,
    )

    output, events = await run_scenario(monkeypatch, scenario)

    rounds = [
        event["composeRound"] for event in events if event["type"] == "answer.started"
    ]
    assert rounds == [0, 1], "两轮撰写必须落在不同的 composeRound 上"
    assert scenario.writer_stream_calls == 2
    assert output["repair_count"] == 1

    # 第二轮的公开流只能是第二版答案的前缀，绝不能续写在第一版上。
    second = "".join(
        event["delta"]
        for event in events
        if event["type"] == "answer.delta" and event["composeRound"] == 1
    )
    assert output["answer"].startswith(second)
    assert "第二版回答" in second


@pytest.mark.asyncio
async def test_writer_stream_usage_is_accumulated_into_the_run_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A4 用量：流式路径必须回传真实 usage 并计入运行预算，不能因为改流式而丢账。
    answer = "可核验回答 [来源1]。"
    scenario = Scenario(writer_answer=answer)

    output, _events = await run_scenario(monkeypatch, scenario)

    assert output["answer_model_calls"] == 1
    # fake 流的 completion_tokens 等于正文长度，必须出现在累计用量里。
    assert output["usage"]["output_tokens"] >= len(answer)
    assert output["usage"]["total_tokens"] >= output["usage"]["output_tokens"]


@pytest.mark.asyncio
async def test_failed_writer_stream_emits_no_partial_answer_events(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A6 降级：流式失败时不得留下已公开的半截正文，也不得回落到写死模板。
    scenario = Scenario(writer_stream_fails=True)

    output, events = await run_scenario(monkeypatch, scenario)

    assert not [event for event in events if event["type"].startswith("answer.")]
    assert output["answer"] is None
    assert output["answer_source"] == "none"
    assert output["stop_reason"] == "OUTPUT_INVALID"
