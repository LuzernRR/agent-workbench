from __future__ import annotations

import copy
import inspect
import json
from types import SimpleNamespace
from typing import Any, cast

import pytest

from app.config.agent import agent_config
from app.graph import nodes
from app.graph.plan import (
    build_plan_snapshot,
    requests_for_steps,
    start_ready_steps,
)
from app.graph.query_strategy import (
    QueryBrief,
    constraint_signature,
    stable_attempt_id,
)
from app.graph.schemas import PlanResult
from app.graph.state import (
    ResearchBranchResult,
    ResearchResultConflictError,
    SearchState,
    SearchTrace,
    initial_state,
    reduce_research_results,
)
from app.main import graph_definition
from app.persistence.tool_ledger import payload_hash
from app.tools.channels.base import SourceProvenance, channel_resolution
from app.tools.search_tool import (
    PublicSearchResult,
    SearchEvidence,
    SearchExecutionResult,
)


def branch_result(
    result_id: str,
    order: int,
    *,
    batch_id: str = "research_batch_test",
) -> ResearchBranchResult:
    return ResearchBranchResult(
        batch_id=batch_id,
        result_id=result_id,
        order=order,
        executions=[],
    )


def test_research_result_reducer_is_ordered_idempotent_and_fail_closed() -> None:
    first = branch_result("result_first", 0)
    second = branch_result("result_second", 1)

    reverse = reduce_research_results([], [second, first])
    forward = reduce_research_results([], [first, second])
    assert json.dumps(reverse, sort_keys=True) == json.dumps(forward, sort_keys=True)
    assert reduce_research_results(forward, [copy.deepcopy(first)]) == forward
    assert reduce_research_results(forward, []) == []

    conflicting = copy.deepcopy(first)
    conflicting["batch_id"] = "research_batch_conflict"
    with pytest.raises(ResearchResultConflictError) as error:
        reduce_research_results(forward, [conflicting])
    assert error.value.code == "RESEARCH_RESULT_CONFLICT"


def test_research_worker_contains_no_internal_task_fanout() -> None:
    source = inspect.getsource(nodes.research)
    assert "asyncio.create_task" not in source
    assert "asyncio.gather" not in source


@pytest.mark.asyncio
async def test_public_graph_definition_exposes_real_fanout_and_fanin_nodes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("WORKBENCH_INTERNAL_TOKEN", "test-token")
    request = SimpleNamespace(
        app=SimpleNamespace(
            state=SimpleNamespace(agent_config=agent_config()),
        ),
    )

    graph = await graph_definition(
        cast(Any, request),
        x_workbench_token="test-token",
    )

    assert graph["nodes"] == [
        "load_context",
        "classify_intent",
        "plan_research",
        "mark_plan_running",
        "research",
        "merge_research",
        "reflect",
        "compose",
        "verify",
        "finalize",
    ]
    assert "Send(research fan-out)" in graph["flow"]
    assert "merge_research fan-in" in graph["flow"]


def test_work_items_fan_out_regular_steps_and_group_xiaohongshu() -> None:
    state = initial_state("并行计划", max_tool_calls=4)
    query_brief = QueryBrief.model_validate({
        "version": 1,
        "objective": "并行渠道检索",
        "complexity": "multi_faceted",
        "entities": [],
        "must": [],
        "should": [],
        "exclude": [],
        "time_range": None,
        "locations": [],
        "languages": [],
        "required_channels": [],
        "requested_fields": ["可核验证据"],
        "evidence_facets": [{
            "facet_id": "general",
            "description": "并行渠道证据",
            "evidence_type": "independent",
            "required_fields": ["可核验证据"],
        }],
    })
    state.update(
        intent={"channels": ["web", "x", "xiaohongshu"]},
        query_brief=query_brief.model_dump(mode="json"),
        plan={
            "plan_id": "plan_test",
            "revision": 2,
            "iteration": 1,
            "created_at": "2026-08-01T00:00:00Z",
            "steps": [],
        },
        plan_revision=2,
        round=1,
        pending_plan_step_ids=["step_web", "step_xhs_1", "step_x", "step_xhs_2"],
        pending_searches=[
            {
                "step_id": "step_web",
                "attempt_id": "attempt_web",
                "facet_id": "general",
                "gap_id": None,
                "parent_attempt_id": None,
                "strategy": "initial_precise",
                "query_terms": ["web", "query"],
                "retained_constraint_ids": [],
                "relaxed_should_ids": [],
                "constraint_signature": constraint_signature(query_brief),
                "query": "web query",
                "channel": "web",
            },
            {
                "step_id": "step_xhs_1",
                "attempt_id": "attempt_xhs_1",
                "facet_id": "general",
                "gap_id": None,
                "parent_attempt_id": None,
                "strategy": "initial_precise",
                "query_terms": ["xiaohongshu", "one"],
                "retained_constraint_ids": [],
                "relaxed_should_ids": [],
                "constraint_signature": constraint_signature(query_brief),
                "query": "xiaohongshu one",
                "channel": "xiaohongshu",
            },
            {
                "step_id": "step_x",
                "attempt_id": "attempt_x",
                "facet_id": "general",
                "gap_id": None,
                "parent_attempt_id": None,
                "strategy": "initial_precise",
                "query_terms": ["x", "query"],
                "retained_constraint_ids": [],
                "relaxed_should_ids": [],
                "constraint_signature": constraint_signature(query_brief),
                "query": "x query",
                "channel": "x",
            },
            {
                "step_id": "step_xhs_2",
                "attempt_id": "attempt_xhs_2",
                "facet_id": "general",
                "gap_id": None,
                "parent_attempt_id": None,
                "strategy": "initial_precise",
                "query_terms": ["xiaohongshu", "two"],
                "retained_constraint_ids": [],
                "relaxed_should_ids": [],
                "constraint_signature": constraint_signature(query_brief),
                "query": "xiaohongshu two",
                "channel": "xiaohongshu",
            },
        ],
    )

    for item in state["pending_searches"]:
        item["attempt_id"] = stable_attempt_id(
            state["run_id"],
            state["round"],
            item,
        )

    work_items = nodes.build_research_work_items(state)

    assert len(work_items) == 3
    assert [item["order"] for item in work_items] == [0, 1, 2]
    assert [target["query"] for target in work_items[1]["targets"]] == [
        "xiaohongshu one",
        "xiaohongshu two",
    ]
    assert all(
        len(item["targets"]) == 1
        for item in work_items
        if item is not work_items[1]
    )
    web_target = work_items[0]["targets"][0]
    assert {
        "attempt_id": web_target["attempt_id"],
        "facet_id": web_target["facet_id"],
        "gap_id": web_target["gap_id"],
        "parent_attempt_id": web_target["parent_attempt_id"],
        "strategy": web_target["strategy"],
        "query_terms": web_target["query_terms"],
        "retained_constraint_ids": web_target["retained_constraint_ids"],
        "relaxed_should_ids": web_target["relaxed_should_ids"],
        "constraint_signature": web_target["constraint_signature"],
    } == {
        "attempt_id": state["pending_searches"][0]["attempt_id"],
        "facet_id": "general",
        "gap_id": None,
        "parent_attempt_id": None,
        "strategy": "initial_precise",
        "query_terms": ["web", "query"],
        "retained_constraint_ids": [],
        "relaxed_should_ids": [],
        "constraint_signature": constraint_signature(query_brief),
    }


def test_planned_tool_call_id_prioritizes_stable_attempt_id() -> None:
    state = initial_state("stable", run_id="run_stable")
    first = {
        "attempt_id": "attempt_0123456789abcdef01234567",
        "query": "first query",
        "channel": "web",
    }
    changed_non_identity_fields = {
        **first,
        "query": "different query",
        "channel": "x",
    }

    assert nodes._planned_tool_call_id(state, 0, first) == nodes._planned_tool_call_id(
        state,
        9,
        changed_non_identity_fields,
    )


def running_state() -> SearchState:
    query_brief = QueryBrief.model_validate({
        "version": 1,
        "objective": "核验 LangGraph Send 的官方资料",
        "complexity": "simple",
        "entities": ["LangGraph Send"],
        "must": [{
            "constraint_id": "langgraph",
            "text": "必须是 LangGraph",
            "terms": ["LangGraph"],
        }],
        "should": [{
            "constraint_id": "official",
            "text": "优先官方资料",
            "terms": ["official"],
        }],
        "exclude": [],
        "time_range": None,
        "locations": [],
        "languages": ["zh-CN"],
        "required_channels": ["web"],
        "requested_fields": ["说明"],
        "evidence_facets": [{
            "facet_id": "official_docs",
            "description": "官方资料",
            "evidence_type": "official",
            "required_fields": ["说明"],
        }],
    })
    plan_result = PlanResult(
        steps=[{
            "local_id": "official",
            "facet_id": "official_docs",
            "facet": "官方资料",
            "objective": "读取官方资料",
            "query_terms": ["LangGraph", "Send", "official"],
            "strategy": "initial_precise",
            "query": "LangGraph Send official",
            "channel": "web",
            "gap_id": None,
            "parent_attempt_id": None,
            "retained_constraint_ids": [
                "langgraph",
                "required_channel:web",
                "official",
            ],
            "relaxed_should_ids": [],
            "depends_on": [],
            "priority": 100,
            "evidence_needed": 1,
            "can_parallelize": True,
        }],
        summary="读取官方资料",
    )
    plan = build_plan_snapshot(
        run_id="run_fanout",
        iteration=1,
        revision=1,
        created_at="2026-08-01T00:00:00Z",
        planned_steps=plan_result.steps,
        allowed_channels={"web"},
        query_brief=query_brief,
        initial=True,
    )
    running, selected = start_ready_steps(plan, revision=2)
    pending = requests_for_steps(selected)
    state = initial_state("LangGraph Send", run_id="run_fanout")
    state.update(
        intent={"channels": ["web"]},
        plan=running,
        plan_revision=2,
        plan_ready=False,
        query_brief=query_brief.model_dump(mode="json"),
        round=1,
        pending_plan_step_ids=[selected[0]["step_id"]],
        pending_searches=pending,
        pending_queries=[pending[0]["query"]],
    )
    return state


def execution_result(query: str) -> SearchExecutionResult:
    provenance = SourceProvenance(
        discovery_provider="deterministic",
        detail_provider="test",
        source_kind="public_page",
        observed_at="2026-08-01T00:00:00Z",
        confidence="high",
    )
    return SearchExecutionResult(
        ok=True,
        channel="web",
        query=query,
        provider="deterministic",
        results=[PublicSearchResult(
            channel="web",
            provider="deterministic",
            query=query,
            title="LangGraph Send",
            url="https://example.com/send",
            snippet="候选摘要",
            verified=True,
            provenance=provenance,
        )],
        evidence=[SearchEvidence(
            channel="web",
            provider="deterministic",
            title="LangGraph Send",
            url="https://example.com/send",
            text="正文证据",
            extractor="test",
            query=query,
            captured_at="2026-08-01T00:00:00Z",
            provenance=provenance,
        )],
        resolution=channel_resolution(
            status="success",
            primary_provider="deterministic",
            effective_provider="deterministic",
        ),
        interaction_wait_ms=2_000,
    )


@pytest.mark.asyncio
async def test_worker_is_branch_local_and_merge_is_replay_idempotent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state = running_state()
    work_item = nodes.build_research_work_items(state)[0]
    result = execution_result(work_item["targets"][0]["query"])
    trace = SearchTrace(
        tool_call_id=work_item["targets"][0]["tool_call_id"],
        attempt_id=work_item["targets"][0]["attempt_id"],
        plan_step_id=work_item["targets"][0]["plan_step_id"],
        research_batch_id=work_item["batch_id"],
        research_result_id=work_item["result_id"],
        idempotency_key="idempotency_test",
        operation_ref="operation_test",
        attempt=1,
        input_hash="input_hash_test",
        output_hash=payload_hash(result.public_dict()),
        result_ref="result_ref_test",
        query=result.query,
        channel="web",
        provider="deterministic",
        status="completed",
        outcome_status="success",
        primary_provider="deterministic",
        effective_provider="deterministic",
        result_count=9,
        evidence_count=7,
        error_code=None,
        retryable=False,
        next_action="none",
        limitation=None,
        duration_ms=1,
        usage={},
    )

    async def fake_run_one_search(*_args: Any, **_kwargs: Any):
        return result, trace

    monkeypatch.setattr(nodes, "_run_one_search", fake_run_one_search)
    branch_patch = await nodes.research(
        {**state, "research_work_item": work_item},
        cast(Any, None),
    )

    assert set(branch_patch) == {"research_results"}
    assert not {
        "candidates",
        "evidence",
        "tool_traces",
        "tool_calls",
        "external_wait_seconds",
        "plan",
    } & set(branch_patch)

    branch_result_value = branch_patch["research_results"][0]
    merge_input = {**state, "research_results": [branch_result_value]}
    merged = await nodes.merge_research(merge_input, cast(Any, None))
    assert merged["tool_calls"] == 1
    assert merged["external_wait_seconds"] == 2.0
    assert len(merged["tool_traces"]) == 1
    assert len(merged["candidates"]) == 1
    assert len(merged["evidence"]) == 1
    assert len(merged["search_attempts"]) == 1
    attempt = merged["search_attempts"][0]
    assert attempt == {
        "attempt_id": work_item["targets"][0]["attempt_id"],
        "tool_call_id": work_item["targets"][0]["tool_call_id"],
        "plan_step_id": work_item["targets"][0]["plan_step_id"],
        "facet_id": "official_docs",
        "gap_id": None,
        "parent_attempt_id": None,
        "strategy": "initial_precise",
        "query_terms": ["LangGraph", "Send", "official"],
        "query": "LangGraph Send official",
        "channel": "web",
        "retained_constraint_ids": [
            "langgraph",
            "required_channel:web",
            "official",
        ],
        "relaxed_should_ids": [],
        "constraint_signature": work_item["targets"][0]["constraint_signature"],
        "status": "completed",
        "result_count": 1,
        "evidence_count": 1,
        "unique_source_domains": ["example.com"],
        "new_candidate_count": 1,
        "new_evidence_count": 1,
        "new_constraint_ids": ["langgraph", "required_channel:web"],
        "progress": True,
        "error_code": None,
    }
    assert merged["no_progress_count"] == 0
    assert merged["plan"]["steps"][0]["status"] == "done"
    assert set(merged["merged_research_result_hashes"]) == {
        branch_result_value["result_id"]
    }

    replay_input = {
        **merge_input,
        **merged,
        "research_results": [branch_result_value],
    }
    replayed = await nodes.merge_research(replay_input, cast(Any, None))
    assert replayed["tool_calls"] == 1
    assert replayed["external_wait_seconds"] == 2.0
    assert len(replayed["tool_traces"]) == 1
    assert len(replayed["candidates"]) == 1
    assert len(replayed["evidence"]) == 1
    assert replayed["search_attempts"] == merged["search_attempts"]
    assert replayed["no_progress_count"] == 0

    conflicting_replay = copy.deepcopy(branch_result_value)
    conflicting_replay["order"] += 1
    with pytest.raises(
        ResearchResultConflictError,
        match="conflicting merged research result",
    ):
        await nodes.merge_research(
            {
                **merge_input,
                **merged,
                "research_results": [conflicting_replay],
            },
            cast(Any, None),
        )


@pytest.mark.asyncio
async def test_merge_counts_no_progress_and_rejects_conflicting_attempt() -> None:
    state = running_state()
    work_item = nodes.build_research_work_items(state)[0]
    target = work_item["targets"][0]
    empty_result = SearchExecutionResult(
        ok=True,
        channel="web",
        query=target["query"],
        provider="deterministic",
        results=[],
        evidence=[],
        resolution=channel_resolution(
            status="success",
            primary_provider="deterministic",
            effective_provider="deterministic",
        ),
    )
    trace = SearchTrace(
        tool_call_id=target["tool_call_id"],
        attempt_id=target["attempt_id"],
        plan_step_id=target["plan_step_id"],
        research_batch_id=work_item["batch_id"],
        research_result_id=work_item["result_id"],
        idempotency_key="idempotency_empty",
        operation_ref="operation_empty",
        attempt=1,
        input_hash="input_hash_empty",
        output_hash=payload_hash(empty_result.public_dict()),
        result_ref="result_ref_empty",
        query=target["query"],
        channel="web",
        provider="deterministic",
        status="completed",
        outcome_status="success",
        primary_provider="deterministic",
        effective_provider="deterministic",
        result_count=0,
        evidence_count=0,
        error_code=None,
        retryable=False,
        next_action="none",
        limitation=None,
        duration_ms=1,
        usage={},
    )
    execution = {
        "order": target["order"],
        "plan_step_id": target["plan_step_id"],
        "attempt_id": target["attempt_id"],
        "facet_id": target["facet_id"],
        "gap_id": target["gap_id"],
        "parent_attempt_id": target["parent_attempt_id"],
        "strategy": target["strategy"],
        "query_terms": target["query_terms"],
        "retained_constraint_ids": target["retained_constraint_ids"],
        "relaxed_should_ids": target["relaxed_should_ids"],
        "constraint_signature": target["constraint_signature"],
        "tool_call_id": target["tool_call_id"],
        "query": target["query"],
        "channel": target["channel"],
        "result": empty_result.public_dict(),
        "trace": trace,
        "reason_code": None,
    }
    branch = ResearchBranchResult(
        batch_id=work_item["batch_id"],
        result_id=work_item["result_id"],
        order=work_item["order"],
        executions=[execution],  # type: ignore[list-item]
    )

    merged = await nodes.merge_research(
        {**state, "research_results": [branch]},
        cast(Any, None),
    )
    assert merged["search_attempts"][0]["progress"] is False
    assert merged["no_progress_count"] == 1

    replay = copy.deepcopy(branch)
    replay["result_id"] = "research_result_exact_attempt_replay"
    replayed = await nodes.merge_research(
        {
            **state,
            "search_attempts": merged["search_attempts"],
            "tool_traces": merged["tool_traces"],
            "candidates": merged["candidates"],
            "evidence": merged["evidence"],
            "tool_calls": merged["tool_calls"],
            "no_progress_count": merged["no_progress_count"],
            "external_wait_seconds": merged["external_wait_seconds"],
            "merged_research_result_ids": merged["merged_research_result_ids"],
            "merged_research_result_hashes": merged[
                "merged_research_result_hashes"
            ],
            "research_results": [replay],
        },
        cast(Any, None),
    )
    assert replayed["search_attempts"] == merged["search_attempts"]
    assert replayed["tool_calls"] == merged["tool_calls"]
    assert replayed["no_progress_count"] == merged["no_progress_count"]

    conflicting = copy.deepcopy(branch)
    conflicting["result_id"] = "research_result_conflicting_attempt"
    conflicting["executions"][0]["strategy"] = "source_targeting"
    with pytest.raises(ResearchResultConflictError, match="conflicting search attempt"):
        await nodes.merge_research(
            {
                **state,
                "search_attempts": merged["search_attempts"],
                "tool_traces": merged["tool_traces"],
                "candidates": merged["candidates"],
                "evidence": merged["evidence"],
                "tool_calls": merged["tool_calls"],
                "no_progress_count": merged["no_progress_count"],
                "external_wait_seconds": merged["external_wait_seconds"],
                "merged_research_result_ids": merged[
                    "merged_research_result_ids"
                ],
                "merged_research_result_hashes": merged[
                    "merged_research_result_hashes"
                ],
                "research_results": [conflicting],
            },
            cast(Any, None),
        )
