from __future__ import annotations

from copy import deepcopy

import pytest

from app.graph.plan import (
    PlanValidationError,
    build_plan_snapshot,
    public_plan_steps,
    requests_for_steps,
    settle_running_steps,
    start_ready_steps,
    validate_plan_snapshot,
)
from app.graph.query_strategy import QueryBrief, hard_constraint_ids
from app.graph.schemas import PlanResult


def query_brief() -> QueryBrief:
    return QueryBrief.model_validate({
        "version": 1,
        "objective": "核验 Agent Workbench 的官方定义并比较架构",
        "complexity": "multi_faceted",
        "entities": ["Agent Workbench"],
        "must": [
            {
                "constraint_id": "product",
                "text": "Agent Workbench",
                "terms": ["Agent Workbench"],
            }
        ],
        "should": [],
        "exclude": [],
        "time_range": None,
        "locations": [],
        "languages": ["zh-CN", "en"],
        "required_channels": ["web"],
        "requested_fields": ["官方定义", "架构差异"],
        "evidence_facets": [
            {
                "facet_id": "official",
                "description": "官方定义与发布日期",
                "evidence_type": "official",
                "required_fields": ["官方定义"],
            },
            {
                "facet_id": "comparison",
                "description": "架构差异",
                "evidence_type": "comparison",
                "required_fields": ["架构差异"],
            },
        ],
    })


def planned_steps() -> list[dict[str, object]]:
    return [
        {
            "local_id": "official",
            "facet_id": "official",
            "facet": "官方定义",
            "objective": "读取官方定义与发布日期",
            "query_terms": ["Agent Workbench", "官方定义", "2026"],
            "strategy": "initial_precise",
            "query": "Agent Workbench 官方定义 2026",
            "channel": "web",
            "gap_id": None,
            "parent_attempt_id": None,
            "retained_constraint_ids": ["product", "required_channel:web"],
            "relaxed_should_ids": [],
            "depends_on": [],
            "priority": 100,
            "evidence_needed": 1,
            "can_parallelize": False,
        },
        {
            "local_id": "comparison",
            "facet_id": "comparison",
            "facet": "差异",
            "objective": "基于官方定义核对差异",
            "query_terms": ["Agent Workbench", "architecture", "comparison"],
            "strategy": "initial_precise",
            "query": "Agent Workbench architecture comparison",
            "channel": "web",
            "gap_id": None,
            "parent_attempt_id": None,
            "retained_constraint_ids": ["product", "required_channel:web"],
            "relaxed_should_ids": [],
            "depends_on": ["official"],
            "priority": 80,
            "evidence_needed": 1,
            "can_parallelize": False,
        },
    ]


def build_plan():
    result = PlanResult(steps=planned_steps(), summary="先核对定义，再比较架构差异")
    return build_plan_snapshot(
        run_id="run_plan",
        iteration=1,
        revision=1,
        created_at="2026-08-01T00:00:00Z",
        planned_steps=result.steps,
        allowed_channels={"web"},
        query_brief=query_brief(),
        prior_attempts=[],
        open_gaps=[],
        initial=True,
    )


def test_plan_ids_are_stable_and_public_projection_is_safe() -> None:
    first = build_plan()
    second = build_plan()

    assert first["plan_id"] == second["plan_id"]
    assert [step["step_id"] for step in first["steps"]] == [
        step["step_id"] for step in second["steps"]
    ]
    assert [step["attempt_id"] for step in first["steps"]] == [
        step["attempt_id"] for step in second["steps"]
    ]
    assert first["steps"][0]["constraint_signature"]
    public = public_plan_steps(first)
    assert public[0]["objective"] == "读取官方定义与发布日期"
    assert public[0]["dependsOn"] == []
    assert set(public[0]) == {
        "stepId",
        "facet",
        "objective",
        "query",
        "channel",
        "dependsOn",
        "priority",
        "evidenceNeeded",
        "canParallelize",
        "status",
        "reasonCode",
    }
    assert not {
        "attemptId",
        "queryTerms",
        "constraintSignature",
        "gapId",
        "parentAttemptId",
    }.intersection(public[0])

    requests = requests_for_steps(first["steps"])
    assert requests[0]["attempt_id"] == first["steps"][0]["attempt_id"]
    assert requests[0]["facet_id"] == "official"
    assert requests[0]["retained_constraint_ids"] == list(
        hard_constraint_ids(query_brief())
    )


def test_initial_complementary_queries_account_for_should_constraints_as_a_plan() -> None:
    payload = query_brief().model_dump(mode="json")
    payload["should"] = [
        {
            "constraint_id": "definition",
            "text": "官方定义",
            "terms": ["官方定义"],
        },
        {
            "constraint_id": "architecture",
            "text": "架构",
            "terms": ["architecture"],
        },
        {
            "constraint_id": "release",
            "text": "release",
            "terms": ["release"],
        },
    ]
    brief = QueryBrief.model_validate(payload)
    result = PlanResult(steps=planned_steps(), summary="互补覆盖定义与架构")

    plan = build_plan_snapshot(
        run_id="run_complementary_should",
        iteration=1,
        revision=1,
        created_at="2026-08-01T00:00:00Z",
        planned_steps=result.steps,
        allowed_channels={"web"},
        query_brief=brief,
        prior_attempts=[],
        open_gaps=[],
        initial=True,
    )

    assert plan["steps"][0]["retained_constraint_ids"] == [
        *hard_constraint_ids(brief),
        "definition",
        "release",
    ]
    assert "release" in plan["steps"][0]["query"]
    assert plan["steps"][1]["retained_constraint_ids"] == [
        *hard_constraint_ids(brief),
        "architecture",
    ]


def test_initial_plan_adds_a_declared_should_term_missing_from_the_query() -> None:
    payload = query_brief().model_dump(mode="json")
    payload["should"] = [{
        "constraint_id": "product_type",
        "text": "产品类型",
        "terms": ["防晒霜", "防晒乳"],
    }]
    payload["must"] = [{
        "constraint_id": "topic",
        "text": "油敏皮通勤防晒",
        "terms": ["油敏皮", "通勤防晒"],
    }]
    payload["required_channels"] = ["xiaohongshu"]
    payload["time_range"] = None
    brief = QueryBrief.model_validate(payload)
    steps = planned_steps()[:1]
    steps[0].update({
        "facet_id": "official",
        "query": "油敏皮 通勤防晒",
        "query_terms": ["油敏皮", "通勤防晒"],
        "channel": "xiaohongshu",
        "retained_constraint_ids": [
            *hard_constraint_ids(brief),
            "product_type",
        ],
    })

    plan = build_plan_snapshot(
        run_id="run_declared_should_repair",
        iteration=1,
        revision=1,
        created_at="2026-08-07T00:00:00Z",
        planned_steps=PlanResult(steps=steps, summary="检索使用体验").steps,
        allowed_channels={"xiaohongshu"},
        query_brief=brief,
        prior_attempts=[],
        open_gaps=[],
        initial=True,
    )

    assert "防晒霜" in plan["steps"][0]["query"]
    assert "防晒霜" in plan["steps"][0]["query_terms"]


def test_plan_lifecycle_respects_dependencies_and_revisions() -> None:
    plan = build_plan()

    running_one, selected_one = start_ready_steps(plan, revision=2)
    assert running_one["revision"] == 2
    assert [step["facet"] for step in selected_one] == ["官方定义"]
    assert [step["status"] for step in running_one["steps"]] == ["running", "todo"]

    settled_one = settle_running_steps(
        running_one,
        revision=3,
        outcomes={selected_one[0]["step_id"]: None},
    )
    running_two, selected_two = start_ready_steps(settled_one, revision=4)
    assert [step["facet"] for step in selected_two] == ["差异"]
    assert [step["status"] for step in running_two["steps"]] == ["done", "running"]


def test_plan_lifecycle_propagates_blocked_dependency_without_false_todo() -> None:
    plan = build_plan()
    running, selected = start_ready_steps(plan, revision=2)
    blocked_root = settle_running_steps(
        running,
        revision=3,
        outcomes={selected[0]["step_id"]: "PLAN_EVIDENCE_TARGET_UNMET"},
    )

    propagated, next_selected = start_ready_steps(blocked_root, revision=4)

    assert next_selected == []
    assert [step["status"] for step in propagated["steps"]] == [
        "blocked",
        "blocked",
    ]
    assert propagated["steps"][1]["reason_code"] == "PLAN_DEPENDENCY_BLOCKED"


@pytest.mark.parametrize(
    ("mutate", "code"),
    [
        (
            lambda plan: plan["steps"].__setitem__(1, deepcopy(plan["steps"][0])),
            "PLAN_DUPLICATE_STEP_ID",
        ),
        (
            lambda plan: plan["steps"][1].__setitem__("depends_on", ["step_unknown"]),
            "PLAN_DEPENDENCY_MISSING",
        ),
        (
            lambda plan: plan["steps"][0].__setitem__(
                "depends_on", [plan["steps"][1]["step_id"]]
            ),
            "PLAN_DEPENDENCY_CYCLE",
        ),
        (
            lambda plan: plan["steps"][0].__setitem__("priority", 101),
            "PLAN_PRIORITY_INVALID",
        ),
        (
            lambda plan: plan["steps"][1].update({
                "query": plan["steps"][0]["query"],
                "channel": plan["steps"][0]["channel"],
            }),
            "PLAN_DUPLICATE_QUERY",
        ),
    ],
)
def test_plan_validation_rejects_invalid_graphs(mutate, code: str) -> None:
    plan = build_plan()
    mutate(plan)

    with pytest.raises(PlanValidationError) as error:
        validate_plan_snapshot(plan, allowed_channels={"web"})

    assert error.value.code == code


def test_plan_rejects_previously_accepted_query_channel() -> None:
    result = PlanResult(steps=planned_steps()[:1], summary="读取官方定义")

    with pytest.raises(PlanValidationError) as error:
        build_plan_snapshot(
            run_id="run_plan",
            iteration=2,
            revision=4,
            created_at="2026-08-01T00:00:00Z",
            planned_steps=result.steps,
            allowed_channels={"web"},
            prior_search_keys={("agent workbench 官方定义 2026", "web")},
            query_brief=query_brief(),
            prior_attempts=[],
            open_gaps=[],
            initial=False,
        )

    assert error.value.code == "PLAN_QUERY_ALREADY_EXECUTED"


@pytest.mark.parametrize(
    ("limits", "code"),
    [
        ({"max_steps": 1}, "PLAN_TOOL_BUDGET_EXCEEDED"),
        (
            {"max_steps": 2, "max_evidence_per_step": 0},
            "PLAN_EVIDENCE_TARGET_EXCEEDS_CALL_CAPACITY",
        ),
        (
            {"max_steps": 2, "max_evidence_per_step": 2, "max_total_evidence": 1},
            "PLAN_EVIDENCE_BUDGET_EXCEEDED",
        ),
    ],
)
def test_plan_rejects_targets_outside_runtime_budget(
    limits: dict[str, int],
    code: str,
) -> None:
    result = PlanResult(steps=planned_steps(), summary="预算内计划")

    with pytest.raises(PlanValidationError) as error:
        build_plan_snapshot(
            run_id="run_budget",
            iteration=1,
            revision=1,
            created_at="2026-08-01T00:00:00Z",
            planned_steps=result.steps,
            allowed_channels={"web"},
            query_brief=query_brief(),
            prior_attempts=[],
            open_gaps=[],
            initial=True,
            **limits,
        )

    assert error.value.code == code


def test_first_round_rejects_more_than_two_or_duplicate_facets() -> None:
    base = planned_steps()[0]
    three = [
        {**base, "local_id": f"step_{index}", "query": f"Agent Workbench source {index}"}
        for index in range(3)
    ]
    result = PlanResult(steps=three, summary="无界首轮")

    with pytest.raises(PlanValidationError) as count_error:
        build_plan_snapshot(
            run_id="run_first_round",
            iteration=1,
            revision=1,
            created_at="2026-08-01T00:00:00Z",
            planned_steps=result.steps,
            allowed_channels={"web"},
            query_brief=query_brief(),
            prior_attempts=[],
            open_gaps=[],
            initial=True,
        )
    assert count_error.value.code == "PLAN_INITIAL_QUERY_LIMIT"

    duplicate_facet = PlanResult(
        steps=[
            planned_steps()[0],
            {
                **planned_steps()[1],
                "facet_id": "official",
            },
        ],
        summary="重复证据面",
    )
    with pytest.raises(PlanValidationError) as facet_error:
        build_plan_snapshot(
            run_id="run_first_round",
            iteration=1,
            revision=1,
            created_at="2026-08-01T00:00:00Z",
            planned_steps=duplicate_facet.steps,
            allowed_channels={"web"},
            query_brief=query_brief(),
            prior_attempts=[],
            open_gaps=[],
            initial=True,
        )
    assert facet_error.value.code == "PLAN_INITIAL_FACET_DUPLICATE"


def test_follow_up_plan_keeps_gap_parent_and_new_stable_attempt() -> None:
    initial_plan = build_plan()
    parent = {
        **requests_for_steps(initial_plan["steps"])[0],
        "result_count": 0,
        "evidence_count": 0,
        "status": "completed",
        "progress": False,
    }
    gap = {
        "gap_id": "gap_no_results",
        "facet_id": "official",
        "kind": "no_results",
        "status": "open",
    }
    follow_up = {
        **planned_steps()[0],
        "local_id": "official_retry",
        "strategy": "terminology_variant",
        "query": "Agent Workbench official documentation",
        "query_terms": ["Agent Workbench", "official", "documentation"],
        "gap_id": "gap_no_results",
        "parent_attempt_id": parent["attempt_id"],
    }
    result = PlanResult(steps=[follow_up], summary="调整术语补搜")

    plan = build_plan_snapshot(
        run_id="run_plan",
        iteration=2,
        revision=4,
        created_at="2026-08-01T00:01:00Z",
        planned_steps=result.steps,
        allowed_channels={"web"},
        query_brief=query_brief(),
        prior_attempts=[parent],
        open_gaps=[gap],
        initial=False,
    )

    step = plan["steps"][0]
    assert step["gap_id"] == "gap_no_results"
    assert step["parent_attempt_id"] == parent["attempt_id"]
    assert step["attempt_id"] != parent["attempt_id"]
