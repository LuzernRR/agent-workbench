"""结构化计划的稳定 ID、DAG 校验与生命周期转换。"""

from __future__ import annotations

import copy
import hashlib
import json
import re
from collections.abc import Iterable, Mapping, Sequence
from typing import Any

from app.graph.query_strategy import (
    EvidenceFacet,
    QueryBrief,
    QueryGateError,
    complete_initial_plan_should_metadata,
    complete_query_constraint_terms,
    complete_query_lineage,
    hard_constraint_ids,
    stable_attempt_id,
    validate_channel_query,
    validate_query_proposal,
)
from app.graph.state import PlanSnapshot, PlanStep, SearchRequest
from app.tools.channels.base import ChannelName


class PlanValidationError(ValueError):
    """携带稳定公开 reason code 的计划错误。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


_PLAN_ERROR_FIELD_PATHS = {
    "PLAN_TOOL_BUDGET_EXCEEDED": "steps",
    "PLAN_INITIAL_QUERY_LIMIT": "steps",
    "PLAN_INITIAL_FACET_DUPLICATE": "steps[*].facet_id",
    "PLAN_EVIDENCE_TARGET_EXCEEDS_CALL_CAPACITY": "steps[*].evidence_needed",
    "PLAN_EVIDENCE_BUDGET_EXCEEDED": "steps[*].evidence_needed",
    "PLAN_DUPLICATE_STEP_ID": "steps[*].local_id",
    "PLAN_CHANNEL_NOT_ALLOWED": "steps[*].channel",
    "PLAN_QUERY_ALREADY_EXECUTED": "steps[*].query",
    "PLAN_DUPLICATE_QUERY": "steps[*].query",
    "PLAN_DEPENDENCY_MISSING": "steps[*].depends_on",
    "PLAN_DEPENDENCY_DUPLICATE": "steps[*].depends_on",
    "PLAN_DEPENDENCY_CYCLE": "steps[*].depends_on",
    "PLAN_NO_RUNNABLE_ROOT": "steps[*].depends_on",
    "QUERY_FOLLOW_UP_LINEAGE_REQUIRED": "steps[*].parent_attempt_id",
    "QUERY_PARENT_ATTEMPT_UNKNOWN": "steps[*].parent_attempt_id",
    "QUERY_PARENT_ATTEMPT_FACET_MISMATCH": "steps[*].parent_attempt_id",
    "QUERY_GAP_NOT_OPEN": "steps[*].gap_id",
    "QUERY_GAP_FACET_MISMATCH": "steps[*].facet_id",
    "QUERY_FACET_UNKNOWN": "steps[*].facet_id",
    "QUERY_CHANNEL_INVALID": "steps[*].channel",
    "QUERY_CHANNEL_NOT_ALLOWED": "steps[*].channel",
    "QUERY_TEXT_INVALID": "steps[*].query",
    "QUERY_LENGTH_INVALID": "steps[*].query",
    "QUERY_TOO_LONG_FOR_CHANNEL": "steps[*].query",
    "QUERY_OPERATOR_UNSUPPORTED": "steps[*].query",
    "QUERY_MUST_CONSTRAINT_DROPPED": "steps[*].query",
    "QUERY_SHOULD_CONSTRAINT_DROPPED": "steps[*].query",
    "QUERY_LOCATION_DROPPED": "steps[*].query",
    "QUERY_TIME_RANGE_DROPPED": "steps[*].query",
    "QUERY_EXCLUSION_DROPPED": "steps[*].query",
    "QUERY_REQUIRED_CHANNEL_DROPPED": "steps[*].query",
    "QUERY_TERMS_INVALID": "steps[*].query_terms",
    "QUERY_INITIAL_LINEAGE_INVALID": "steps[*].gap_id",
    "QUERY_STRATEGY_GAP_MISMATCH": "steps[*].strategy",
    "QUERY_RELAXATION_NOT_ALLOWED": "steps[*].relaxed_should_ids",
    "QUERY_NEAR_DUPLICATE": "steps[*].query",
    "QUERY_CONSTRAINT_SIGNATURE_DROPPED": "steps[*].retained_constraint_ids",
    "QUERY_CONSTRAINT_SIGNATURE_INVALID": "steps[*].retained_constraint_ids",
    "QUERY_SHOULD_CONSTRAINT_CONFLICT": "steps[*].retained_constraint_ids",
    "QUERY_SHOULD_CONSTRAINT_UNACCOUNTED": "steps[*].retained_constraint_ids",
}

_CHANNEL_ORDER: tuple[ChannelName, ...] = ("web", "x", "xiaohongshu")
_CHANNEL_BY_NAME: dict[str, ChannelName] = {
    channel: channel for channel in _CHANNEL_ORDER
}
_EVIDENCE_TYPE_HINTS = {
    "official": "official documentation",
    "primary": "primary source",
    "independent": "independent analysis",
    "social": "user experience",
    "comparison": "comparison",
    "field": "field evidence",
}
_XIAOHONGSHU_EVIDENCE_TYPE_HINTS = {
    "official": "官方资料",
    "primary": "一手资料",
    "independent": "独立评测",
    "social": "用户体验",
    "comparison": "真实对比",
    "field": "实地证据",
}
_QUERY_VARIANTS = {
    "web": ("source", "documentation", "reference", "case study", "analysis", "evidence"),
    "x": ("announcement", "update", "thread", "discussion", "source", "evidence"),
    "xiaohongshu": ("实测", "体验", "攻略", "对比", "测评", "案例"),
}
_STRATEGY_BY_GAP = {
    "no_results": "terminology_variant",
    "no_readable_evidence": "source_targeting",
    "missing_claim": "facet_expansion",
    "missing_constraint": "facet_expansion",
    "missing_channel": "source_targeting",
    "conflicting_sources": "conflict_resolution",
    "missing_field": "field_completion",
}


def plan_validation_feedback(
    error: PlanValidationError,
    rejected_plan: Any,
) -> dict[str, Any]:
    """Return bounded private feedback for one semantic planner repair.

    This payload is sent only back to the planner model.  It is deliberately
    separate from AgentEvent/public summaries so invalid queries, lineage and
    private QueryBrief-derived metadata never become UI text.
    """

    payload = (
        rejected_plan.model_dump(mode="json")
        if hasattr(rejected_plan, "model_dump")
        else dict(rejected_plan)
        if isinstance(rejected_plan, Mapping)
        else {"steps": []}
    )
    return {
        "errorCode": error.code,
        "fieldPath": _PLAN_ERROR_FIELD_PATHS.get(error.code, "steps"),
        "message": str(error)[:240],
        "rejectedPlan": payload,
    }


def _ordered_channels(
    brief: QueryBrief,
    allowed_channels: set[ChannelName],
) -> list[ChannelName]:
    required = [
        channel
        for channel in brief.required_channels
        if channel in allowed_channels
    ]
    return [
        *required,
        *(
            channel
            for channel in _CHANNEL_ORDER
            if channel in allowed_channels and channel not in required
        ),
    ]


def _contains_excluded_term(brief: QueryBrief, value: str) -> bool:
    normalized = _normalized_query(value).strip('"')
    for constraint in brief.exclude:
        for term in constraint.terms:
            target = _normalized_query(term).strip('"')
            if not target:
                continue
            if re.search(r"[a-z0-9]", target):
                if re.search(
                    rf"(?<![a-z0-9_]){re.escape(target)}(?![a-z0-9_])",
                    normalized,
                ):
                    return True
            elif target in normalized:
                return True
    return False


def _language_markers(
    brief: QueryBrief,
    channel: ChannelName,
    *,
    variant_index: int,
) -> list[str]:
    markers: list[str] = []
    for language in brief.languages:
        normalized = language.casefold()
        base = normalized.split("-", 1)[0]
        if channel == "x":
            marker = f"lang:{base}"
        elif base == "zh":
            marker = "中文"
        elif base == "en":
            marker = "English"
        else:
            marker = language
        if marker not in markers:
            markers.append(marker)
    # X treats repeated lang: operators as an intersection, so a bilingual
    # brief must distribute languages across attempts instead of generating an
    # impossible `lang:zh lang:en` query. Other channels accept natural
    # language cues together.
    if channel == "x" and markers:
        return [markers[variant_index % len(markers)]]
    return markers


def _bounded_query_chunks(
    brief: QueryBrief,
    candidates: Iterable[str],
    *,
    maximum_chars: int,
) -> list[str]:
    chunks: list[str] = []
    normalized_seen: set[str] = set()
    for candidate in candidates:
        value = " ".join(str(candidate).split())
        if not value or _contains_excluded_term(brief, value):
            continue
        # query_terms has an 80-character item cap.  Keeping the same bound on
        # chunks also prevents a single verbose objective from crowding out the
        # facet, language and source-tier markers.
        value = value[:80].rstrip()
        key = _normalized_query(value)
        if not value or key in normalized_seen:
            continue
        prospective = " ".join([*chunks, value])
        if len(prospective) > maximum_chars:
            continue
        chunks.append(value)
        normalized_seen.add(key)
    return chunks


def _query_terms(value: str) -> list[str]:
    terms: list[str] = []
    seen: set[str] = set()
    for raw in value.split():
        term = raw.strip('"')[:80]
        key = term.casefold()
        if not term or key in seen:
            continue
        terms.append(term)
        seen.add(key)
        if len(terms) == 12:
            break
    return terms or ["evidence"]


def _fallback_query_proposal(
    brief: QueryBrief,
    *,
    facet: EvidenceFacet,
    channel: ChannelName,
    strategy: str,
    variant_index: int,
    gap_id: str | None,
    parent_attempt_id: str | None,
    relaxed_should_ids: list[str],
) -> dict[str, Any]:
    variant_values = _QUERY_VARIANTS[channel]
    variant = variant_values[variant_index % len(variant_values)]
    evidence_hint = (
        _XIAOHONGSHU_EVIDENCE_TYPE_HINTS.get(facet.evidence_type, "可核验证据")
        if channel == "xiaohongshu"
        else _EVIDENCE_TYPE_HINTS.get(facet.evidence_type, "evidence")
    )
    anchors = [
        *brief.entities[:4],
        *(item.terms[0] for item in brief.must),
    ]
    objective_cue = (
        brief.objective[:20].rstrip()
        if channel == "xiaohongshu"
        else brief.objective
    )
    candidates = [
        *anchors,
        *([objective_cue] if not anchors else []),
        *facet.required_fields[:3],
        evidence_hint,
        *_language_markers(
            brief,
            channel,
            variant_index=variant_index,
        ),
        variant,
        facet.description,
        *([brief.objective] if anchors else []),
    ]
    maximum_seed_chars = 44 if channel == "xiaohongshu" else 180
    chunks = _bounded_query_chunks(
        brief,
        candidates,
        maximum_chars=maximum_seed_chars,
    )
    if not chunks:
        chunks = ["公开证据" if channel == "xiaohongshu" else "public evidence"]
    raw = {
        "facet_id": facet.facet_id,
        "query_terms": chunks[:12],
        "strategy": strategy,
        "query": " ".join(chunks),
        "channel": channel,
        "gap_id": gap_id,
        "parent_attempt_id": parent_attempt_id,
        "retained_constraint_ids": list(hard_constraint_ids(brief)),
        "relaxed_should_ids": relaxed_should_ids,
    }
    repaired = complete_query_constraint_terms(
        brief,
        raw,
        complete_all_should=strategy != "initial_precise",
    )
    try:
        repaired["query"] = validate_channel_query(repaired["query"], channel)
    except QueryGateError as exc:
        raise PlanValidationError(exc.code, str(exc)) from exc
    repaired["query_terms"] = _query_terms(repaired["query"])
    return repaired


def _fallback_parent(
    gap: Mapping[str, Any],
    prior_attempts: Sequence[dict[str, Any]],
) -> dict[str, Any] | None:
    facet_id = str(gap.get("facet_id") or "")
    facet_attempts = [
        item
        for item in prior_attempts
        if str(item.get("facet_id") or "") == facet_id
        and str(item.get("attempt_id") or "")
    ]
    if facet_attempts:
        return facet_attempts[-1]
    if gap.get("origin") == "facet_discovery":
        return next(
            (
                item
                for item in reversed(prior_attempts)
                if str(item.get("attempt_id") or "")
            ),
            None,
        )
    return None


def build_deterministic_fallback_steps(
    *,
    query_brief: QueryBrief,
    allowed_channels: set[ChannelName],
    prior_attempts: Sequence[dict[str, Any]],
    open_gaps: Sequence[dict[str, Any]],
    max_steps: int,
    max_evidence_per_step: int,
    initial: bool,
) -> list[dict[str, Any]]:
    """Build a stable executable plan after bounded model repair is exhausted."""

    channels = _ordered_channels(query_brief, allowed_channels)
    if max_steps < 1 or not channels:
        raise PlanValidationError(
            "PLAN_FALLBACK_UNAVAILABLE",
            "确定性计划没有可用步骤预算或授权渠道",
        )
    facets = {item.facet_id: item for item in query_brief.evidence_facets}
    evidence_needed = min(1, max(0, max_evidence_per_step))
    steps: list[dict[str, Any]] = []

    if initial:
        gap_facets = [
            str(item.get("facet_id") or "")
            for item in open_gaps
            if item.get("status") == "open"
            and str(item.get("facet_id") or "") in facets
        ]
        ordered_facet_ids = list(dict.fromkeys([
            *gap_facets,
            *(item.facet_id for item in query_brief.evidence_facets),
        ]))
        for index, facet_id in enumerate(ordered_facet_ids[: min(max_steps, 2)]):
            facet = facets[facet_id]
            channel = channels[index % len(channels)]
            proposal = _fallback_query_proposal(
                query_brief,
                facet=facet,
                channel=channel,
                strategy="initial_precise",
                variant_index=index,
                gap_id=None,
                parent_attempt_id=None,
                relaxed_should_ids=[],
            )
            steps.append({
                "local_id": f"fallback_initial_{index + 1}",
                "facet_id": facet.facet_id,
                "facet": facet.description[:200],
                "objective": query_brief.objective,
                **proposal,
                "depends_on": [],
                "priority": 100 - index,
                "evidence_needed": evidence_needed,
                "can_parallelize": len(ordered_facet_ids) > 1,
            })
        return steps

    ordered_gaps = sorted(
        (
            item
            for item in open_gaps
            if item.get("status") == "open"
            and str(item.get("facet_id") or "") in facets
        ),
        key=lambda item: (
            -int(item.get("priority") or 0),
            int(item.get("opened_iteration") or 0),
            str(item.get("gap_id") or ""),
        ),
    )
    for gap in ordered_gaps:
        parent = _fallback_parent(gap, prior_attempts)
        if parent is None:
            continue
        facet = facets[str(gap["facet_id"])]
        required_channel = str(gap.get("required_channel") or "")
        parent_channel = str(parent.get("channel") or "")
        channel = next(
            (
                _CHANNEL_BY_NAME[item]
                for item in (required_channel, parent_channel, *channels)
                if item in _CHANNEL_BY_NAME
                and _CHANNEL_BY_NAME[item] in allowed_channels
            ),
            channels[0],
        )
        kind = str(gap.get("kind") or "missing_claim")
        strategy = _STRATEGY_BY_GAP.get(kind, "facet_expansion")
        if kind == "no_results" and query_brief.should:
            strategy = "broaden_should"
        if (
            kind in {"missing_channel", "no_readable_evidence"}
            and channel == "web"
            and parent_channel in {"x", "xiaohongshu"}
        ):
            strategy = "channel_fallback"
        relaxed_should_ids = (
            [item.constraint_id for item in query_brief.should]
            if strategy == "broaden_should"
            else []
        )
        same_scope_attempts = sum(
            1
            for item in prior_attempts
            if str(item.get("facet_id") or "") == facet.facet_id
            and str(item.get("channel") or "") == channel
        )
        proposal = _fallback_query_proposal(
            query_brief,
            facet=facet,
            channel=channel,
            strategy=strategy,
            variant_index=same_scope_attempts,
            gap_id=str(gap["gap_id"]),
            parent_attempt_id=str(parent["attempt_id"]),
            relaxed_should_ids=relaxed_should_ids,
        )
        steps.append({
            "local_id": f"fallback_follow_up_{len(steps) + 1}",
            "facet_id": facet.facet_id,
            "facet": facet.description[:200],
            "objective": str(gap.get("description") or query_brief.objective)[:500],
            **proposal,
            "depends_on": [],
            "priority": 100 - len(steps),
            "evidence_needed": evidence_needed,
            "can_parallelize": False,
        })
        if len(steps) >= max_steps:
            break
    if not steps:
        raise PlanValidationError(
            "PLAN_FALLBACK_LINEAGE_UNAVAILABLE",
            "确定性补搜没有可绑定的真实 open gap 与父尝试",
        )
    return steps


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
