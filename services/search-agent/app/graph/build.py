"""真实搜索 StateGraph 装配。

主图：Supervisor -> Planner -> Researcher(tool loop) -> Reflector ->
replan|Writer -> Verifier -> research_more|rewrite|finalize。
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

from app.events.runtime import runtime_event
from app.graph.context import RunContext
from app.graph.nodes import (
    classify_intent,
    compose,
    finalize,
    load_context,
    plan_research,
    reflect,
    research,
    route_after_compose,
    route_after_intent,
    route_after_reflect,
    route_after_verify,
    verify,
)
from app.graph.state import SearchState

Node = Callable[[SearchState, Runtime[RunContext]], Awaitable[dict[str, Any]]]

_AGENT_BY_NODE = {
    "load_context": "supervisor",
    "classify_intent": "supervisor",
    "plan_research": "planner",
    "research": "researcher",
    "reflect": "reflector",
    "compose": "writer",
    "verify": "verifier",
    "finalize": "supervisor",
}

_PUBLIC_SUMMARY_NODES = frozenset({"plan_research", "reflect", "verify"})


def _novel_public_summary(
    name: str,
    summary: str | None,
    prior_steps: list[dict[str, Any]],
) -> str | None:
    if name not in _PUBLIC_SUMMARY_NODES or not summary:
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
            writer(runtime_event(
                "node.failed",
                node=name,
                nodeRunId=node_run_id,
                agent=_AGENT_BY_NODE[name],
                iteration=iteration,
                reasonCode=type(exc).__name__.upper()[:80],
            ))
            raise
        steps = patch.get("steps") or []
        raw_summary = steps[-1].get("summary") if steps else None
        public_summary = _novel_public_summary(
            name,
            raw_summary,
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
        ))
        if name == "plan_research" and patch.get("pending_queries"):
            writer(runtime_event(
                "plan.updated",
                iteration=patch.get("round", iteration),
                queries=patch["pending_queries"],
            ))
        if name == "verify":
            writer(runtime_event(
                "verification.completed",
                nodeRunId=node_run_id,
                passed=bool(patch.get("verification_passed")),
                action=patch.get("verification_action") or "research_more",
                publicSummary=public_summary or None,
            ))
        return patch

    return wrapped


def build_graph(checkpointer: object | None = None):
    graph = StateGraph(SearchState, context_schema=RunContext)
    graph.add_node("load_context", _evented("load_context", load_context))
    graph.add_node("classify_intent", _evented("classify_intent", classify_intent))
    graph.add_node("plan_research", _evented("plan_research", plan_research))
    graph.add_node("research", _evented("research", research))
    graph.add_node("reflect", _evented("reflect", reflect))
    graph.add_node("compose", _evented("compose", compose))
    graph.add_node("verify", _evented("verify", verify))
    graph.add_node("finalize", _evented("finalize", finalize))

    graph.add_edge(START, "load_context")
    graph.add_edge("load_context", "classify_intent")
    graph.add_conditional_edges(
        "classify_intent",
        route_after_intent,
        {"plan_research": "plan_research", "compose": "compose"},
    )
    graph.add_edge("plan_research", "research")
    graph.add_edge("research", "reflect")
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
