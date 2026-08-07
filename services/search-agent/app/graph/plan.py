"""结构化计划的稳定 ID、DAG 校验与生命周期转换。"""

from __future__ import annotations

import copy
import hashlib
import json
from collections.abc import Iterable, Sequence
from typing import Any

from app.graph.query_strategy import (
    QueryBrief,
    QueryGateError,
    complete_initial_plan_should_metadata,
    complete_query_constraint_terms,
    complete_query_lineage,
    stable_attempt_id,
    validate_query_proposal,
)
from app.graph.state import PlanSnapshot, PlanStep, SearchRequest
from app.tools.channels.base import ChannelName


class PlanValidationError(ValueError):
    """携带稳定公开 reason code 的计划错误。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _normalized_query(value: str) -> str:
    return " ".join(value.casefold().split())


def _stable_id(prefix: str, material: str, *, size: int = 24) -> str:
    digest = hashlib.sha256(material.encode("utf-8")).hexdigest()[:size]
    return f"{prefix}_{digest}"


def build_plan_snapshot(
    *,
    run_id: str,
    iteration: int,
    revision: int,
    created_at: str,
    planned_steps: Sequence[Any],
    allowed_channels: set[ChannelName],
    prior_search_keys: set[tuple[str, ChannelName]] | None = None,
    max_steps: int | None = None,
    max_evidence_per_step: int | None = None,
    max_total_evidence: int | None = None,
    query_brief: QueryBrief | None = None,
    prior_attempts: Sequence[dict[str, Any]] = (),
    open_gaps: Sequence[dict[str, Any]] = (),
    initial: bool | None = None,
) -> PlanSnapshot:
    """把模型局部步骤转换为稳定、严格的运行时计划。"""

    raw_steps = [
        step.model_dump() if hasattr(step, "model_dump") else dict(step)
        for step in planned_steps
    ]
    is_initial = iteration == 1 if initial is None else initial
    if query_brief is not None:
        raw_steps = [
            complete_query_lineage(
                complete_query_constraint_terms(
                    query_brief,
                    raw,
                    complete_all_should=not is_initial,
                ),
                prior_attempts=prior_attempts,
                open_gaps=open_gaps,
            )
            for raw in raw_steps
        ]
        if is_initial:
            raw_steps = complete_initial_plan_should_metadata(query_brief, raw_steps)
    if max_steps is not None and len(raw_steps) > max_steps:
        raise PlanValidationError(
            "PLAN_TOOL_BUDGET_EXCEEDED",
            "计划步骤超过本轮剩余工具调用数",
        )
    if is_initial and len(raw_steps) > 2:
        raise PlanValidationError(
            "PLAN_INITIAL_QUERY_LIMIT",
            "首轮计划最多允许两个互补查询",
        )
    if is_initial:
        facet_ids = [str(raw.get("facet_id") or "") for raw in raw_steps]
        if len(facet_ids) != len(set(facet_ids)):
            raise PlanValidationError(
                "PLAN_INITIAL_FACET_DUPLICATE",
                "首轮查询必须覆盖不同证据分面",
            )
    evidence_targets = [int(raw.get("evidence_needed") or 0) for raw in raw_steps]
    if (
        max_evidence_per_step is not None
        and any(target > max_evidence_per_step for target in evidence_targets)
    ):
        raise PlanValidationError(
            "PLAN_EVIDENCE_TARGET_EXCEEDS_CALL_CAPACITY",
            "计划单步证据目标超过一次工具调用的正文读取容量",
        )
    if (
        max_total_evidence is not None
        and sum(evidence_targets) > max_total_evidence
    ):
        raise PlanValidationError(
            "PLAN_EVIDENCE_BUDGET_EXCEEDED",
            "计划总证据目标超过本轮可用容量",
        )
    canonical = json.dumps(raw_steps, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    plan_id = _stable_id("plan", f"{run_id}|{iteration}|{canonical}")
    local_to_step: dict[str, str] = {}
    for raw in raw_steps:
        local_id = str(raw.get("local_id") or "")
        if local_id in local_to_step:
            raise PlanValidationError("PLAN_DUPLICATE_STEP_ID", "计划步骤标识重复")
        local_to_step[local_id] = _stable_id("step", f"{plan_id}|{local_id}")

    steps: list[PlanStep] = []
    prior = prior_search_keys or set()
    admitted_attempts = [dict(item) for item in prior_attempts]
    for raw in raw_steps:
        local_id = str(raw["local_id"])
        channel = str(raw["channel"])
        if channel not in allowed_channels:
            raise PlanValidationError("PLAN_CHANNEL_NOT_ALLOWED", "计划使用了未授权渠道")
        query = " ".join(str(raw["query"]).split())
        query_key = (_normalized_query(query), channel)
        if query_key in prior:
            raise PlanValidationError(
                "PLAN_QUERY_ALREADY_EXECUTED",
                "计划重复了已经执行或接受的 query+channel",
            )
        if query_brief is not None:
            try:
                accepted = validate_query_proposal(
                    query_brief,
                    raw,
                    run_id=run_id,
                    iteration=iteration,
                    initial=is_initial,
                    allowed_channels={str(item) for item in allowed_channels},
                    prior_attempts=admitted_attempts,
                    open_gaps=open_gaps,
                    require_complete_should_accounting=not is_initial,
                )
            except QueryGateError as exc:
                raise PlanValidationError(exc.code, str(exc)) from exc
        else:
            accepted = {
                "facet_id": str(raw.get("facet_id") or raw.get("local_id") or "legacy"),
                "query_terms": list(raw.get("query_terms") or [query]),
                "strategy": str(raw.get("strategy") or "initial_precise"),
                "query": query,
                "channel": channel,
                "gap_id": raw.get("gap_id"),
                "parent_attempt_id": raw.get("parent_attempt_id"),
                "retained_constraint_ids": list(raw.get("retained_constraint_ids") or []),
                "relaxed_should_ids": list(raw.get("relaxed_should_ids") or []),
                "constraint_signature": "legacy",
            }
            accepted["attempt_id"] = stable_attempt_id(run_id, iteration, accepted)
        admitted_attempts.append(accepted)
        dependencies: list[str] = []
        for dependency in raw.get("depends_on") or []:
            target = local_to_step.get(str(dependency))
            if target is None:
                raise PlanValidationError("PLAN_DEPENDENCY_MISSING", "计划包含未知依赖")
            dependencies.append(target)
        steps.append(PlanStep(
            step_id=local_to_step[local_id],
            attempt_id=accepted["attempt_id"],
            facet_id=accepted["facet_id"],
            facet=" ".join(str(raw["facet"]).split()),
            objective=" ".join(str(raw["objective"]).split()),
            query_terms=list(accepted["query_terms"]),
            strategy=accepted["strategy"],
            query=accepted["query"],
            channel=accepted["channel"],  # type: ignore[typeddict-item]
            gap_id=accepted["gap_id"],
            parent_attempt_id=accepted["parent_attempt_id"],
            retained_constraint_ids=list(accepted["retained_constraint_ids"]),
            relaxed_should_ids=list(accepted["relaxed_should_ids"]),
            constraint_signature=accepted["constraint_signature"],
            depends_on=dependencies,
            priority=int(raw["priority"]),
            evidence_needed=int(raw["evidence_needed"]),
            can_parallelize=bool(raw["can_parallelize"]),
            status="todo",
            reason_code=None,
        ))
    if query_brief is not None and is_initial:
        should_ids = {item.constraint_id for item in query_brief.should}
        accounted_should_ids = {
            constraint_id
            for step in steps
            for constraint_id in step["retained_constraint_ids"]
            if constraint_id in should_ids
        }
        if accounted_should_ids != should_ids:
            raise PlanValidationError(
                "QUERY_SHOULD_CONSTRAINT_UNACCOUNTED",
                "首轮互补计划整体必须显式保留每个 QueryBrief.should",
            )
    snapshot = PlanSnapshot(
        plan_id=plan_id,
        revision=revision,
        iteration=iteration,
        created_at=created_at,
        steps=steps,
    )
    validate_plan_snapshot(snapshot, allowed_channels=allowed_channels)
    return snapshot


def validate_plan_snapshot(
    plan: PlanSnapshot,
    *,
    allowed_channels: set[ChannelName] | None = None,
) -> None:
    """验证稳定 ID、原子查询、依赖和可执行根步骤。"""

    steps = plan.get("steps") or []
    if not 1 <= len(steps) <= 4:
        raise PlanValidationError("PLAN_STEP_COUNT_INVALID", "计划步骤数量必须在 1 到 4 之间")
    ids = [step["step_id"] for step in steps]
    if len(ids) != len(set(ids)):
        raise PlanValidationError("PLAN_DUPLICATE_STEP_ID", "计划步骤标识重复")
    known = set(ids)
    attempt_ids = [str(step.get("attempt_id") or "") for step in steps]
    if any(not item for item in attempt_ids) or len(attempt_ids) != len(set(attempt_ids)):
        raise PlanValidationError(
            "PLAN_ATTEMPT_ID_INVALID",
            "计划步骤 attemptId 缺失或重复",
        )
    dependencies: dict[str, list[str]] = {}
    query_keys: set[tuple[str, str]] = set()
    roots = 0
    for step in steps:
        if not 0 <= step["priority"] <= 100:
            raise PlanValidationError("PLAN_PRIORITY_INVALID", "计划优先级越界")
        if not 0 <= step["evidence_needed"] <= 10:
            raise PlanValidationError("PLAN_EVIDENCE_TARGET_INVALID", "计划证据目标越界")
        if allowed_channels is not None and step["channel"] not in allowed_channels:
            raise PlanValidationError("PLAN_CHANNEL_NOT_ALLOWED", "计划使用了未授权渠道")
        depends_on = step["depends_on"]
        if len(depends_on) != len(set(depends_on)):
            raise PlanValidationError("PLAN_DEPENDENCY_DUPLICATE", "计划步骤依赖重复")
        if step["step_id"] in depends_on:
            raise PlanValidationError("PLAN_DEPENDENCY_CYCLE", "计划步骤依赖自身")
        if any(dependency not in known for dependency in depends_on):
            raise PlanValidationError("PLAN_DEPENDENCY_MISSING", "计划包含未知依赖")
        roots += int(not depends_on)
        dependencies[step["step_id"]] = depends_on
        query_key = (_normalized_query(step["query"]), step["channel"])
        if query_key in query_keys:
            raise PlanValidationError("PLAN_DUPLICATE_QUERY", "计划重复 query+channel")
        query_keys.add(query_key)
    visiting: set[str] = set()
    visited: set[str] = set()

    def has_cycle(step_id: str) -> bool:
        if step_id in visiting:
            return True
        if step_id in visited:
            return False
        visiting.add(step_id)
        if any(has_cycle(dependency) for dependency in dependencies[step_id]):
            return True
        visiting.remove(step_id)
        visited.add(step_id)
        return False

    if any(has_cycle(step_id) for step_id in ids):
        raise PlanValidationError("PLAN_DEPENDENCY_CYCLE", "计划依赖图包含环")
    if roots == 0:
        raise PlanValidationError("PLAN_NO_RUNNABLE_ROOT", "计划没有可运行根步骤")


def start_ready_steps(
    plan: PlanSnapshot,
    *,
    revision: int,
) -> tuple[PlanSnapshot, list[PlanStep]]:
    """阻塞不可达步骤，并把下一批可执行步骤标记为 running。"""

    next_plan = copy.deepcopy(plan)
    by_id = {step["step_id"]: step for step in next_plan["steps"]}
    changed = True
    while changed:
        changed = False
        for step in next_plan["steps"]:
            if step["status"] != "todo":
                continue
            dependency_states = [by_id[item]["status"] for item in step["depends_on"]]
            if any(status in {"blocked", "skipped"} for status in dependency_states):
                step["status"] = "blocked"
                step["reason_code"] = "PLAN_DEPENDENCY_BLOCKED"
                changed = True

    ready = [
        step
        for step in next_plan["steps"]
        if step["status"] == "todo"
        and all(by_id[item]["status"] == "done" for item in step["depends_on"])
    ]
    ready.sort(key=lambda item: (-item["priority"], next_plan["steps"].index(item)))
    selected: list[PlanStep]
    if not ready:
        selected = []
    elif not ready[0]["can_parallelize"]:
        selected = [ready[0]]
    else:
        selected = [step for step in ready if step["can_parallelize"]]
    for step in selected:
        step["status"] = "running"
        step["reason_code"] = None
    if selected or next_plan != plan:
        next_plan["revision"] = revision
    return next_plan, selected


def settle_running_steps(
    plan: PlanSnapshot,
    *,
    revision: int,
    outcomes: dict[str, str | None],
) -> PlanSnapshot:
    """按真实工具终态把 running 步骤结算为 done 或 blocked。"""

    next_plan = copy.deepcopy(plan)
    for step in next_plan["steps"]:
        if step["status"] != "running":
            continue
        reason_code = outcomes.get(step["step_id"], "PLAN_STEP_NOT_EXECUTED")
        step["status"] = "done" if reason_code is None else "blocked"
        step["reason_code"] = reason_code
    next_plan["revision"] = revision
    return next_plan


def has_todo_steps(plan: PlanSnapshot | None) -> bool:
    return bool(plan and any(step["status"] == "todo" for step in plan["steps"]))


def requests_for_steps(steps: Iterable[PlanStep]) -> list[SearchRequest]:
    requests: list[SearchRequest] = []
    for step in steps:
        request = SearchRequest(
            step_id=step["step_id"],
            query=step["query"],
            channel=step["channel"],
        )
        for key in (
            "attempt_id",
            "facet_id",
            "gap_id",
            "parent_attempt_id",
            "strategy",
            "query_terms",
            "retained_constraint_ids",
            "relaxed_should_ids",
            "constraint_signature",
        ):
            if key in step:
                request[key] = copy.deepcopy(step[key])  # type: ignore[literal-required]
        requests.append(request)
    return requests


def public_plan_steps(plan: PlanSnapshot) -> list[dict[str, Any]]:
    """生成只含公开结构字段的 camelCase 事件快照。"""

    return [
        {
            "stepId": step["step_id"],
            "facet": step["facet"],
            "objective": step["objective"],
            "query": step["query"],
            "channel": step["channel"],
            "dependsOn": list(step["depends_on"]),
            "priority": step["priority"],
            "evidenceNeeded": step["evidence_needed"],
            "canParallelize": step["can_parallelize"],
            "status": step["status"],
            "reasonCode": step["reason_code"],
        }
        for step in plan["steps"]
    ]
