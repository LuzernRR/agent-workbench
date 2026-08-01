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
    state.update(
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
            {"step_id": "step_web", "query": "web query", "channel": "web"},
            {
                "step_id": "step_xhs_1",
                "query": "xiaohongshu one",
                "channel": "xiaohongshu",
            },
            {"step_id": "step_x", "query": "x query", "channel": "x"},
            {
                "step_id": "step_xhs_2",
                "query": "xiaohongshu two",
                "channel": "xiaohongshu",
            },
        ],
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


def running_state() -> SearchState:
    plan_result = PlanResult(
        steps=[{
            "local_id": "official",
            "facet": "官方资料",
            "objective": "读取官方资料",
            "query": "LangGraph Send",
            "channel": "web",
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
    )
    running, selected = start_ready_steps(plan, revision=2)
    pending = requests_for_steps(selected)
    state = initial_state("LangGraph Send", run_id="run_fanout")
    state.update(
        plan=running,
        plan_revision=2,
        plan_ready=False,
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
        plan_step_id=work_item["targets"][0]["plan_step_id"],
        idempotency_key="idempotency_test",
        query=result.query,
        channel="web",
        provider="deterministic",
        status="completed",
        outcome_status="success",
        primary_provider="deterministic",
        effective_provider="deterministic",
        result_count=1,
        evidence_count=1,
        error_code=None,
        retryable=False,
        next_action="none",
        limitation=None,
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
    assert merged["plan"]["steps"][0]["status"] == "done"

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
