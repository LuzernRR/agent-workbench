from __future__ import annotations

from copy import deepcopy

import pytest

from app.graph.plan import (
    PlanValidationError,
    build_deterministic_fallback_steps,
    build_plan_snapshot,
    plan_validation_feedback,
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


def test_deterministic_initial_fallback_is_stable_distinct_and_constraint_complete() -> None:
    brief = query_brief()
    arguments = {
        "query_brief": brief,
        "allowed_channels": {"web"},
        "prior_attempts": [],
        "open_gaps": [],
        "max_steps": 2,
        "max_evidence_per_step": 2,
        "initial": True,
    }

    first = build_deterministic_fallback_steps(**arguments)
    second = build_deterministic_fallback_steps(**arguments)

    assert first == second
    assert [step["facet_id"] for step in first] == ["official", "comparison"]
    assert len({(step["query"].casefold(), step["channel"]) for step in first}) == 2
    assert all("中文" in step["query"] for step in first)
    assert all("English" in step["query"] for step in first)
    assert "official" in first[0]["query"].casefold()
    assert "官方定义" in first[0]["query"]
    assert "comparison" in first[1]["query"].casefold()
    assert "架构差异" in first[1]["query"]

    plan = build_plan_snapshot(
        run_id="run_deterministic_initial",
        iteration=1,
        revision=1,
        created_at="2026-08-08T00:00:00Z",
        planned_steps=first,
        allowed_channels={"web"},
        query_brief=brief,
        prior_attempts=[],
        open_gaps=[],
        initial=True,
        max_steps=2,
        max_evidence_per_step=2,
        max_total_evidence=4,
    )
    assert all(
        set(hard_constraint_ids(brief)) <= set(step["retained_constraint_ids"])
        for step in plan["steps"]
    )


@pytest.mark.parametrize(
    ("code", "field_path"),
    [
        ("PLAN_CHANNEL_NOT_ALLOWED", "steps[*].channel"),
        ("QUERY_OPERATOR_UNSUPPORTED", "steps[*].query"),
        ("QUERY_FOLLOW_UP_LINEAGE_REQUIRED", "steps[*].parent_attempt_id"),
        ("QUERY_CONSTRAINT_SIGNATURE_DROPPED", "steps[*].retained_constraint_ids"),
    ],
)
def test_plan_validation_feedback_identifies_repairable_field(
    code: str,
    field_path: str,
) -> None:
    feedback = plan_validation_feedback(
        PlanValidationError(code, "rejected"),
        {"steps": []},
    )

    assert feedback["errorCode"] == code
    assert feedback["fieldPath"] == field_path
    assert feedback["rejectedPlan"] == {"steps": []}


def test_deterministic_web_fallback_covers_official_and_primary_agent_sources() -> None:
    payload = query_brief().model_dump(mode="json")
    payload["objective"] = "核验 Agent frameworks 的官方架构与学术评估"
    payload["entities"] = ["Agent frameworks"]
    payload["must"] = [{
        "constraint_id": "topic",
        "text": "Agent frameworks",
        "terms": ["Agent frameworks"],
    }]
    payload["evidence_facets"] = [
        {
            "facet_id": "official",
            "description": "官方架构文档",
            "evidence_type": "official",
            "required_fields": ["架构"],
        },
        {
            "facet_id": "academic",
            "description": "学术评估与基准",
            "evidence_type": "primary",
            "required_fields": ["评估方法"],
        },
    ]
    brief = QueryBrief.model_validate(payload)

    steps = build_deterministic_fallback_steps(
        query_brief=brief,
        allowed_channels={"web"},
        prior_attempts=[],
        open_gaps=[],
        max_steps=2,
        max_evidence_per_step=2,
        initial=True,
    )

    assert "official documentation" in steps[0]["query"]
    assert "primary source" in steps[1]["query"]
    assert {step["facet_id"] for step in steps} == {"official", "academic"}
    assert len({step["query"].casefold() for step in steps}) == 2


def test_excluded_latin_token_does_not_remove_official_source_hint_by_substring() -> None:
    payload = query_brief().model_dump(mode="json")
    payload["exclude"] = [{
        "constraint_id": "exclude_tat",
        "text": "排除 TAT",
        "terms": ["TAT"],
    }]
    payload["evidence_facets"] = [{
        "facet_id": "official",
        "description": "官方资料",
        "evidence_type": "official",
        "required_fields": ["官方定义"],
    }]
    brief = QueryBrief.model_validate(payload)

    steps = build_deterministic_fallback_steps(
        query_brief=brief,
        allowed_channels={"web"},
        prior_attempts=[],
        open_gaps=[],
        max_steps=1,
        max_evidence_per_step=2,
        initial=True,
    )

    assert "official documentation" in steps[0]["query"]
    assert "-TAT" in steps[0]["query"]


def test_deterministic_scholarship_fallback_preserves_date_region_and_fields() -> None:
    payload = query_brief().model_dump(mode="json")
    payload.update({
        "objective": "核验英国 Clarendon Scholarship 申请资格与截止日期",
        "entities": ["Clarendon Scholarship"],
        "must": [{
            "constraint_id": "scholarship",
            "text": "Clarendon Scholarship",
            "terms": ["Clarendon Scholarship"],
        }],
        "exclude": [],
        "time_range": {
            "start_date": "2026-01-01",
            "end_date": "2026-12-31",
            "source_text": "2026 年",
            "resolved_on": "2026-08-08",
        },
        "locations": ["英国"],
        "languages": ["zh-CN", "en"],
        "required_channels": ["web"],
        "requested_fields": ["申请资格", "截止日期"],
        "evidence_facets": [{
            "facet_id": "official",
            "description": "官方申请规则",
            "evidence_type": "official",
            "required_fields": ["申请资格", "截止日期"],
        }],
    })
    brief = QueryBrief.model_validate(payload)

    steps = build_deterministic_fallback_steps(
        query_brief=brief,
        allowed_channels={"web"},
        prior_attempts=[],
        open_gaps=[],
        max_steps=1,
        max_evidence_per_step=2,
        initial=True,
    )
    query = steps[0]["query"]

    assert "Clarendon Scholarship" in query
    assert "英国" in query
    assert "after:2026-01-01" in query
    assert "before:2026-12-31" in query
    assert "申请资格" in query
    assert "截止日期" in query
    build_plan_snapshot(
        run_id="run_scholarship_region_date",
        iteration=1,
        revision=1,
        created_at="2026-08-08T00:00:00Z",
        planned_steps=steps,
        allowed_channels={"web"},
        query_brief=brief,
        prior_attempts=[],
        open_gaps=[],
        initial=True,
        max_steps=1,
        max_evidence_per_step=2,
        max_total_evidence=2,
    )


def test_deterministic_x_fallback_preserves_90_day_window_and_one_language() -> None:
    payload = query_brief().model_dump(mode="json")
    payload.update({
        "objective": "核验 OpenAI Agents SDK 近 90 天的官方动态",
        "entities": ["OpenAI Agents SDK"],
        "must": [{
            "constraint_id": "product",
            "text": "OpenAI Agents SDK",
            "terms": ["OpenAI Agents SDK"],
        }],
        "time_range": {
            "start_date": "2026-05-11",
            "end_date": "2026-08-08",
            "source_text": "近 90 天",
            "resolved_on": "2026-08-08",
        },
        "languages": ["zh-CN", "en"],
        "required_channels": ["x"],
        "evidence_facets": [{
            "facet_id": "announcement",
            "description": "官方发布与更新",
            "evidence_type": "social",
            "required_fields": ["发布日期", "更新内容"],
        }],
    })
    brief = QueryBrief.model_validate(payload)

    steps = build_deterministic_fallback_steps(
        query_brief=brief,
        allowed_channels={"x"},
        prior_attempts=[],
        open_gaps=[],
        max_steps=1,
        max_evidence_per_step=2,
        initial=True,
    )
    query = steps[0]["query"]

    assert "since:2026-05-11" in query
    assert "until:2026-08-08" in query
    assert sum(token.startswith("lang:") for token in query.split()) == 1
    build_plan_snapshot(
        run_id="run_x_90_days",
        iteration=1,
        revision=1,
        created_at="2026-08-08T00:00:00Z",
        planned_steps=steps,
        allowed_channels={"x"},
        query_brief=brief,
        prior_attempts=[],
        open_gaps=[],
        initial=True,
        max_steps=1,
        max_evidence_per_step=2,
        max_total_evidence=2,
    )


def test_deterministic_xiaohongshu_fallback_stays_natural_and_bounded() -> None:
    payload = query_brief().model_dump(mode="json")
    payload.update({
        "objective": "搜索油敏皮夏季通勤防晒的真实使用体验",
        "entities": ["油敏皮", "通勤防晒"],
        "must": [{
            "constraint_id": "topic",
            "text": "通勤防晒",
            "terms": ["通勤防晒"],
        }],
        "exclude": [{
            "constraint_id": "exclude_ad",
            "text": "排除广告",
            "terms": ["广告"],
        }],
        "languages": ["zh-CN"],
        "required_channels": ["xiaohongshu"],
        "evidence_facets": [{
            "facet_id": "experience",
            "description": "肤质、场景与使用感受",
            "evidence_type": "social",
            "required_fields": ["肤质", "使用感受"],
        }],
    })
    brief = QueryBrief.model_validate(payload)

    steps = build_deterministic_fallback_steps(
        query_brief=brief,
        allowed_channels={"xiaohongshu"},
        prior_attempts=[],
        open_gaps=[],
        max_steps=1,
        max_evidence_per_step=2,
        initial=True,
    )
    query = steps[0]["query"]

    assert len(query) <= 80
    assert "广告" not in query
    assert not any(token.startswith("-") for token in query.split())
    assert not any(operator in query for operator in ("site:", "since:", "until:"))
    build_plan_snapshot(
        run_id="run_xhs_natural",
        iteration=1,
        revision=1,
        created_at="2026-08-08T00:00:00Z",
        planned_steps=steps,
        allowed_channels={"xiaohongshu"},
        query_brief=brief,
        prior_attempts=[],
        open_gaps=[],
        initial=True,
        max_steps=1,
        max_evidence_per_step=2,
        max_total_evidence=2,
    )


def test_xiaohongshu_fallback_without_entities_keeps_objective_topic_cue() -> None:
    payload = query_brief().model_dump(mode="json")
    payload.update({
        "objective": "搜索 Cursor Rules 编排经验与常见踩坑",
        "entities": [],
        "must": [],
        "exclude": [],
        "languages": ["zh-CN"],
        "required_channels": ["xiaohongshu"],
        "evidence_facets": [{
            "facet_id": "experience",
            "description": "验证配置方法与真实体验",
            "evidence_type": "independent",
            "required_fields": ["配置方法"],
        }],
    })
    brief = QueryBrief.model_validate(payload)

    steps = build_deterministic_fallback_steps(
        query_brief=brief,
        allowed_channels={"xiaohongshu"},
        prior_attempts=[],
        open_gaps=[],
        max_steps=1,
        max_evidence_per_step=2,
        initial=True,
    )
    query = steps[0]["query"]

    assert "Cursor Rules" in query
    assert "independent analysis" not in query
    assert "独立评测" in query


@pytest.mark.parametrize(
    ("gap_kind", "expected_strategy", "expected_relaxed"),
    [
        ("no_results", "broaden_should", ["architecture"]),
        ("conflicting_sources", "conflict_resolution", []),
    ],
)
def test_deterministic_follow_up_matches_zero_result_and_conflict_gaps(
    gap_kind: str,
    expected_strategy: str,
    expected_relaxed: list[str],
) -> None:
    payload = query_brief().model_dump(mode="json")
    payload["should"] = [{
        "constraint_id": "architecture",
        "text": "架构",
        "terms": ["architecture"],
    }]
    brief = QueryBrief.model_validate(payload)
    initial_steps = build_deterministic_fallback_steps(
        query_brief=brief,
        allowed_channels={"web"},
        prior_attempts=[],
        open_gaps=[],
        max_steps=1,
        max_evidence_per_step=2,
        initial=True,
    )
    initial_plan = build_plan_snapshot(
        run_id=f"run_{gap_kind}",
        iteration=1,
        revision=1,
        created_at="2026-08-08T00:00:00Z",
        planned_steps=initial_steps,
        allowed_channels={"web"},
        query_brief=brief,
        prior_attempts=[],
        open_gaps=[],
        initial=True,
        max_steps=1,
        max_evidence_per_step=2,
        max_total_evidence=2,
    )
    request = requests_for_steps(initial_plan["steps"])[0]
    parent = {
        **request,
        "status": "completed",
        "result_count": 0,
        "evidence_count": 0,
        "progress": False,
    }
    gap = {
        "gap_id": f"gap_{gap_kind}",
        "facet_id": request["facet_id"],
        "kind": gap_kind,
        "subject": "架构差异" if gap_kind == "conflicting_sources" else None,
        "description": "需要按真实缺口补搜",
        "missing_constraint_ids": [],
        "required_channel": "web",
        "evidence_type": "official",
        "priority": 100,
        "origin": "attempt_feedback",
        "status": "open",
        "opened_iteration": 1,
    }

    steps = build_deterministic_fallback_steps(
        query_brief=brief,
        allowed_channels={"web"},
        prior_attempts=[parent],
        open_gaps=[gap],
        max_steps=1,
        max_evidence_per_step=2,
        initial=False,
    )
    follow_up = build_plan_snapshot(
        run_id=f"run_{gap_kind}",
        iteration=2,
        revision=2,
        created_at="2026-08-08T00:01:00Z",
        planned_steps=steps,
        allowed_channels={"web"},
        prior_search_keys={(parent["query"].casefold(), "web")},
        query_brief=brief,
        prior_attempts=[parent],
        open_gaps=[gap],
        initial=False,
        max_steps=1,
        max_evidence_per_step=2,
        max_total_evidence=2,
    )["steps"][0]

    assert follow_up["strategy"] == expected_strategy
    assert follow_up["relaxed_should_ids"] == expected_relaxed
    assert follow_up["parent_attempt_id"] == parent["attempt_id"]
    assert follow_up["query"].casefold() != parent["query"].casefold()


def test_deterministic_follow_up_fallback_uses_real_gap_parent_and_new_query() -> None:
    brief = query_brief()
    initial_plan = build_plan()
    request = requests_for_steps(initial_plan["steps"])[0]
    parent = {
        **request,
        "tool_call_id": "tool_parent",
        "plan_step_id": request["step_id"],
        "status": "completed",
        "result_count": 0,
        "evidence_count": 0,
        "unique_source_domains": [],
        "new_candidate_count": 0,
        "new_evidence_count": 0,
        "new_constraint_ids": [],
        "progress": False,
    }
    gap = {
        "gap_id": "gap_no_results",
        "facet_id": "official",
        "kind": "no_results",
        "subject": None,
        "description": "官方分面没有返回候选",
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

    steps = build_deterministic_fallback_steps(
        query_brief=brief,
        allowed_channels={"web"},
        prior_attempts=[parent],
        open_gaps=[gap],
        max_steps=1,
        max_evidence_per_step=2,
        initial=False,
    )
    plan = build_plan_snapshot(
        run_id="run_deterministic_follow_up",
        iteration=2,
        revision=2,
        created_at="2026-08-08T00:01:00Z",
        planned_steps=steps,
        allowed_channels={"web"},
        prior_search_keys={(parent["query"].casefold(), "web")},
        query_brief=brief,
        prior_attempts=[parent],
        open_gaps=[gap],
        initial=False,
        max_steps=1,
        max_evidence_per_step=2,
        max_total_evidence=2,
    )

    step = plan["steps"][0]
    assert step["gap_id"] == gap["gap_id"]
    assert step["parent_attempt_id"] == parent["attempt_id"]
    assert step["strategy"] == "terminology_variant"
    assert step["query"].casefold() != parent["query"].casefold()
    assert step["constraint_signature"] == parent["constraint_signature"]


def test_zero_attempt_resumed_gap_recovers_as_initial_without_fake_lineage() -> None:
    brief = query_brief()
    legacy_gap = {
        "gap_id": "gap_legacy_without_attempt",
        "facet_id": "comparison",
        "kind": "missing_claim",
        "subject": "架构差异",
        "description": "旧 checkpoint 只有 gap，没有 SearchAttempt",
        "missing_constraint_ids": [],
        "required_channel": "web",
        "evidence_type": "comparison",
        "priority": 100,
        "origin": "facet_discovery",
        "status": "open",
        "opened_iteration": 1,
    }

    steps = build_deterministic_fallback_steps(
        query_brief=brief,
        allowed_channels={"web"},
        prior_attempts=[],
        open_gaps=[legacy_gap],
        max_steps=1,
        max_evidence_per_step=2,
        initial=True,
    )
    plan = build_plan_snapshot(
        run_id="run_resumed_without_attempt",
        iteration=2,
        revision=2,
        created_at="2026-08-08T00:01:00Z",
        planned_steps=steps,
        allowed_channels={"web"},
        query_brief=brief,
        prior_attempts=[],
        open_gaps=[legacy_gap],
        initial=True,
        max_steps=1,
        max_evidence_per_step=2,
        max_total_evidence=2,
    )

    step = plan["steps"][0]
    assert step["facet_id"] == "comparison"
    assert step["strategy"] == "initial_precise"
    assert step["gap_id"] is None
    assert step["parent_attempt_id"] is None


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
