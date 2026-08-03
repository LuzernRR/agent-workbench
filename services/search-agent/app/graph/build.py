"""真实搜索 StateGraph 装配。

主图：Supervisor -> Planner -> mark running -> Send(Research branches) ->
merge fan-in -> Reflector -> replan|Writer -> Verifier ->
research_more|rewrite|finalize。
"""

from __future__ import annotations

import functools
import time
import uuid
from collections.abc import Awaitable, Callable
from difflib import SequenceMatcher
from typing import Any

from langgraph.checkpoint.memory import InMemorySaver
from langgraph.config import get_stream_writer
from langgraph.graph import END, START, StateGraph
from langgraph.runtime import Runtime
from langgraph.types import Send

from app.events.runtime import runtime_event
from app.graph.context import RunContext
from app.graph.nodes import (
    accept_fast_evidence,
    build_research_work_items,
    classify_intent,
    compose,
    finalize,
    load_context,
    mark_plan_running,
    merge_research,
    plan_fast_search,
    plan_research,
    reflect,
    research,
    route_after_compose,
    route_after_fast_plan,
    route_after_intent,
    route_after_plan,
    route_after_reflect,
    route_after_research,
    route_after_verify,
    verify,
)
from app.graph.plan import public_plan_steps
from app.graph.state import SearchState

Node = Callable[[SearchState, Runtime[RunContext]], Awaitable[dict[str, Any]]]

_AGENT_BY_NODE = {
    "load_context": "supervisor",
    "classify_intent": "supervisor",
    "plan_research": "planner",
    "plan_fast_search": "planner",
    "mark_plan_running": "planner",
    "research": "researcher",
    "merge_research": "researcher",
    "accept_fast_evidence": "reflector",
    "reflect": "reflector",
    "compose": "writer",
    "verify": "verifier",
    "finalize": "supervisor",
}

_PUBLIC_SUMMARY_NODES = frozenset({"plan_research", "reflect", "verify"})


def _novel_public_summary(
    name: str,
    summary: str | None,
    source: str | None,
    model_call_recorded: bool,
    prior_steps: list[dict[str, Any]],
) -> str | None:
    if (
        name not in _PUBLIC_SUMMARY_NODES
        or source != "model"
        or not model_call_recorded
        or not summary
    ):
        return None
    normalized = "".join(summary.split()).casefold()
    if not normalized:
        return None
    for step in reversed(prior_steps[-8:]):
        prior = "".join(str(step.get("summary") or "").split()).casefold()
        if not prior:
            continue
        if normalized == prior or SequenceMatcher(None, normalized, prior).ratio() >= 0.82:
            return None
    return summary


def _evented(name: str, function: Node) -> Node:
    @functools.wraps(function)
    async def wrapped(state: SearchState, runtime: Runtime[RunContext]) -> dict[str, Any]:
        writer = get_stream_writer()
        iteration = state.get("round", 0)
        node_run_id = f"{name}_{uuid.uuid4().hex}"
        started = time.perf_counter()
        writer(runtime_event(
            "node.started",
            node=name,
            nodeRunId=node_run_id,
            agent=_AGENT_BY_NODE[name],
            iteration=iteration,
        ))
        try:
            patch = await function(state, runtime)
        except Exception as exc:
            reason_code = str(getattr(exc, "code", "") or "").strip()
            if not reason_code:
                reason_code = type(exc).__name__.upper()[:80]
            writer(runtime_event(
                "node.failed",
                node=name,
                nodeRunId=node_run_id,
                agent=_AGENT_BY_NODE[name],
                iteration=iteration,
                reasonCode=reason_code,
            ))
            raise
        steps = patch.get("steps") or []
        latest_step = steps[-1] if steps else {}
        raw_summary = latest_step.get("summary")
        prior_model_calls = int(state.get("model_calls") or 0)
        current_model_calls = int(patch.get("model_calls", prior_model_calls) or 0)
        model_call_recorded = current_model_calls > prior_model_calls
        public_summary = _novel_public_summary(
            name,
            raw_summary,
            latest_step.get("kind"),
            model_call_recorded,
            list(state.get("steps") or []),
        )
        writer(runtime_event(
            "node.completed",
            node=name,
            nodeRunId=node_run_id,
            agent=_AGENT_BY_NODE[name],
            iteration=iteration,
            durationMs=round((time.perf_counter() - started) * 1000),
            publicSummary=public_summary or None,
            publicSummarySource="model" if public_summary else None,
        ))
        plan = patch.get("plan")
        if (
            plan
            and int(plan.get("revision") or 0) > int(state.get("plan_revision") or 0)
        ):
            writer(runtime_event(
                "plan.updated",
                planId=plan["plan_id"],
                revision=plan["revision"],
                iteration=plan["iteration"],
                steps=public_plan_steps(plan),
                planSource="model" if name == "plan_research" else "runtime",
            ))
        plan_error_code = str(patch.get("plan_error_code") or "")
        if (
            name == "plan_research"
            and plan_error_code
            and plan_error_code != str(state.get("plan_error_code") or "")
        ):
            writer(runtime_event(
                "plan.rejected",
                iteration=patch.get("round", iteration),
                reasonCode=plan_error_code,
                planSource="model",
            ))
        if name == "verify":
            writer(runtime_event(
                "verification.completed",
                nodeRunId=node_run_id,
                passed=bool(patch.get("verification_passed")),
                action=patch.get("verification_action") or "research_more",
                publicSummary=public_summary or None,
                publicSummarySource="model" if public_summary else None,
            ))
        return patch

    return wrapped


def _dispatch_research(state: SearchState) -> str | list[Send]:
    """把计划批次 fan-out 为独立图任务；小红书组保持单分支串行。"""

    work_items = build_research_work_items(state)
    if not work_items:
        return "merge_research"
    return [
        Send("research", {**state, "research_work_item": work_item})
        for work_item in work_items
    ]


def build_graph(checkpointer: object | None = None):
    graph = StateGraph(SearchState, context_schema=RunContext)
    graph.add_node("load_context", _evented("load_context", load_context))
    graph.add_node("classify_intent", _evented("classify_intent", classify_intent))
    graph.add_node("plan_research", _evented("plan_research", plan_research))
    graph.add_node(
        "plan_fast_search",
        _evented("plan_fast_search", plan_fast_search),
    )
    graph.add_node(
        "mark_plan_running",
        _evented("mark_plan_running", mark_plan_running),
    )
    graph.add_node("research", _evented("research", research))
    graph.add_node(
        "merge_research",
        _evented("merge_research", merge_research),
    )
    graph.add_node(
        "accept_fast_evidence",
        _evented("accept_fast_evidence", accept_fast_evidence),
    )
    graph.add_node("reflect", _evented("reflect", reflect))
    graph.add_node("compose", _evented("compose", compose))
    graph.add_node("verify", _evented("verify", verify))
    graph.add_node("finalize", _evented("finalize", finalize))

    graph.add_edge(START, "load_context")
    graph.add_edge("load_context", "classify_intent")
    graph.add_conditional_edges(
        "classify_intent",
        route_after_intent,
        {
            "plan_research": "plan_research",
            "plan_fast_search": "plan_fast_search",
            "compose": "compose",
        },
    )
    graph.add_conditional_edges(
        "plan_fast_search",
        route_after_fast_plan,
        {"mark_plan_running": "mark_plan_running", "plan_research": "plan_research"},
    )
    graph.add_conditional_edges(
        "plan_research",
        route_after_plan,
        {"mark_plan_running": "mark_plan_running", "reflect": "reflect"},
    )
    graph.add_conditional_edges("mark_plan_running", _dispatch_research)
    graph.add_edge("research", "merge_research")
    graph.add_conditional_edges(
        "merge_research",
        route_after_research,
        {
            "mark_plan_running": "mark_plan_running",
            "reflect": "reflect",
            "accept_fast_evidence": "accept_fast_evidence",
        },
    )
    graph.add_edge("accept_fast_evidence", "compose")
    graph.add_conditional_edges(
        "reflect",
        route_after_reflect,
        {"plan_research": "plan_research", "compose": "compose"},
    )
    graph.add_conditional_edges(
        "compose",
        route_after_compose,
        {"verify": "verify", "finalize": "finalize"},
    )
    graph.add_conditional_edges(
        "verify",
        route_after_verify,
        {"plan_research": "plan_research", "compose": "compose", "finalize": "finalize"},
    )
    graph.add_edge("finalize", END)

    return graph.compile(checkpointer=checkpointer or InMemorySaver())
