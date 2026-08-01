from __future__ import annotations

from copy import deepcopy

import pytest

from app.graph.plan import (
    PlanValidationError,
    build_plan_snapshot,
    public_plan_steps,
    settle_running_steps,
    start_ready_steps,
    validate_plan_snapshot,
)
from app.graph.schemas import PlanResult


def planned_steps() -> list[dict[str, object]]:
    return [
        {
            "local_id": "official",
            "facet": "官方定义",
            "objective": "读取官方定义与发布日期",
            "query": "Agent Workbench 官方定义 2026",
            "channel": "web",
            "depends_on": [],
            "priority": 100,
            "evidence_needed": 1,
            "can_parallelize": False,
        },
        {
            "local_id": "comparison",
            "facet": "差异",
            "objective": "基于官方定义核对差异",
            "query": "Agent Workbench architecture comparison",
            "channel": "web",
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
    )


def test_plan_ids_are_stable_and_public_projection_is_safe() -> None:
    first = build_plan()
    second = build_plan()

    assert first["plan_id"] == second["plan_id"]
    assert [step["step_id"] for step in first["steps"]] == [
        step["step_id"] for step in second["steps"]
    ]
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
            **limits,
        )

    assert error.value.code == code
