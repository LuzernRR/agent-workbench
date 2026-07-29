from __future__ import annotations

import asyncio
import copy
import json
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from app.config.agent import agent_config
from app.events.runtime import begin_event_scope, end_event_scope
from app.graph import nodes
from app.graph.build import build_graph
from app.graph.context import RunContext
from app.graph.schemas import (
    ComposeResult,
    IntentResult,
    PlanResult,
    ReflectResult,
    VerifyResult,
)
from app.graph.state import initial_state
from app.llm.deepseek import (
    ModelUsage,
    ResearcherTurn,
    ResearchToolCall,
    StructuredOutputError,
)
from app.persistence.tool_ledger import LedgerDecision
from app.tools.channels.base import SourceProvenance
from app.tools.search_tool import (
    PublicSearchResult,
    SearchEvidence,
    SearchExecutionResult,
)


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


class MemoryLedger:
    def __init__(self) -> None:
        self.rows: dict[str, tuple[str, dict[str, Any] | None, str | None]] = {}

    async def begin(self, **kwargs: Any) -> LedgerDecision:
        key = kwargs["idempotency_key"]
        row = self.rows.get(key)
        if row is None:
            self.rows[key] = ("started", None, None)
            return LedgerDecision("execute", "started")
        status, result, error = row
        if status in {"completed", "failed"}:
            return LedgerDecision("cached", status, result, error)
        return LedgerDecision("unknown", status, result, error or "OUTCOME_UNKNOWN")

    async def complete(self, key: str, result: dict[str, Any]) -> None:
        self.rows[key] = ("completed", result, None)

    async def fail(self, key: str, result: dict[str, Any], error: str) -> None:
        self.rows[key] = ("failed", result, error)

    async def unknown(self, key: str, error: str) -> None:
        self.rows[key] = ("unknown", None, error)


@dataclass
class Scenario:
    need_search: bool = True
    supervisor_channels: list[str] = field(default_factory=lambda: ["web"])
    plans: list[list[str]] = field(default_factory=lambda: [["query one"]])
    reflects: list[dict[str, Any]] = field(
        default_factory=lambda: [{"sufficient": True, "missing": "", "extra_searches": []}]
    )
    verifier_actions: list[str] = field(default_factory=lambda: ["pass"])
    researcher_mode: str = "valid"
    include_reasoning: bool = False
    evidence_by_query: dict[str, bool] = field(default_factory=lambda: {"query one": True})
    result_count_by_query: dict[str, int] = field(default_factory=dict)
    limitations_by_query: dict[str, str] = field(default_factory=dict)
    channels_by_query: dict[str, str] = field(default_factory=dict)
    structured_calls: dict[str, int] = field(default_factory=dict)
    structured_attempts: dict[str, int] = field(default_factory=dict)
    structured_repair_permissions: list[tuple[str, bool]] = field(default_factory=list)
    structured_messages: dict[str, list[Any]] = field(default_factory=dict)
    invalid_structured_roles: set[str] = field(default_factory=set)
    researcher_messages: list[list[dict[str, Any]]] = field(default_factory=list)
    tool_executions: list[str] = field(default_factory=list)
    tool_execution_searches: list[dict[str, str]] = field(default_factory=list)
    tool_delay_seconds: float = 0
    tool_call_index: int = 0
    checkpoint_values: dict[str, Any] = field(default_factory=dict)

    async def structured(
        self,
        role: str,
        schema: type[Any],
        messages: Any,
        *,
        model_id: str | None = None,
        allow_repair: bool = False,
    ) -> tuple[Any, ModelUsage]:
        self.structured_repair_permissions.append((role, allow_repair))
        self.structured_messages.setdefault(role, []).append(copy.deepcopy(messages))
        index = self.structured_calls.get(role, 0)
        self.structured_calls[role] = index + 1
        if role in self.invalid_structured_roles:
            raise StructuredOutputError(ModelUsage(
                20,
                4,
                24,
                0.000002,
                attempts=2 if allow_repair else 1,
            ))
        if role == "supervisor":
            result = IntentResult(
                task_type="research" if self.need_search else "direct_answer",
                need_search=self.need_search,
                channels=self.supervisor_channels,
                summary="已判断是否需要联网",
            )
        elif role == "planner":
            queries = self.plans[min(index, len(self.plans) - 1)]
            result = PlanResult(
                searches=[
                    {
                        "query": query,
                        "channel": self.channels_by_query.get(query, "web"),
                    }
                    for query in queries
                ],
                summary="已形成检索计划",
            )
        elif role == "reflector":
            data = self.reflects[min(index, len(self.reflects) - 1)]
            result = ReflectResult(summary="已评估证据覆盖", **data)
        elif role == "writer":
            result = ComposeResult(
                answer_markdown="可核验回答 [来源1]" if self.need_search else "直接回答",
                summary="已组织回答",
            )
        elif role == "verifier":
            action = self.verifier_actions[min(index, len(self.verifier_actions) - 1)]
            result = VerifyResult(
                passed=action == "pass",
                action=action,
                issue="需要改写" if action == "rewrite" else "",
                extra_searches=(
                    [{
                        "query": "query two",
                        "channel": self.channels_by_query.get("query two", "web"),
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
            10,
            5,
            15,
            0.000001,
            attempts=self.structured_attempts.get(role, 1),
        )

    async def researcher(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None,
        **kwargs: Any,
    ) -> ResearcherTurn:
        self.researcher_messages.append(copy.deepcopy(messages))
        if kwargs.get("thinking"):
            return ResearcherTurn(
                assistant_message={"role": "assistant", "content": "证据观察完成"},
                tool_calls=(),
                content="已读取并评估本轮证据",
                usage=ModelUsage(10, 5, 15, 0.000001),
                finish_reason="stop",
            )

        requested = json.loads(str(messages[-1]["content"]).split("：", 1)[-1])
        target = requested["query"]
        channel = requested["channel"]
        self.tool_call_index += 1
        call_id = f"call_{self.tool_call_index}"
        if self.researcher_mode == "bad_args":
            calls = (ResearchToolCall(call_id, "web_search", '{"query":1}'),)
        elif self.researcher_mode == "unknown_tool":
            calls = (ResearchToolCall(call_id, "shell", "{}"),)
        elif self.researcher_mode == "multiple":
            calls = (
                ResearchToolCall(
                    call_id,
                    "web_search",
                    json.dumps({"query": target, "channel": channel, "max_results": 5}),
                ),
                ResearchToolCall(
                    f"{call_id}_extra",
                    "web_search",
                    json.dumps({"query": target, "channel": channel, "max_results": 5}),
                ),
            )
        else:
            calls = (ResearchToolCall(
                call_id,
                "web_search",
                json.dumps({"query": target, "channel": channel, "max_results": 5}),
            ),)
        assistant_message = {
            "role": "assistant",
            "tool_calls": [
                {
                    "id": call.id,
                    "type": "function",
                    "function": {"name": call.name, "arguments": call.arguments},
                }
                for call in calls
            ],
        }
        if self.include_reasoning:
            assistant_message["reasoning_content"] = "PRIVATE_CHAIN_OF_THOUGHT_SENTINEL"
        return ResearcherTurn(
            assistant_message=assistant_message,
            tool_calls=calls,
            content="",
            usage=ModelUsage(10, 5, 15, 0.000001),
            finish_reason="tool_calls",
        )

    async def execute_tool(self, arguments: Any, config: Any) -> SearchExecutionResult:
        if self.tool_delay_seconds:
            await asyncio.sleep(self.tool_delay_seconds)
        query = arguments.query
        self.tool_executions.append(query)
        self.tool_execution_searches.append(
            {"query": query, "channel": arguments.channel}
        )
        has_evidence = self.evidence_by_query.get(query, False)
        result_count = self.result_count_by_query.get(query, 1)
        limitation = self.limitations_by_query.get(query)
        url = f"https://example.com/{len(self.tool_executions)}"
        return SearchExecutionResult(
            ok=True,
            channel=arguments.channel,
            query=query,
            provider="deterministic",
            results=[PublicSearchResult(
                channel=arguments.channel,
                provider="deterministic",
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
                provider="deterministic",
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
        )


async def run_scenario(
    monkeypatch: pytest.MonkeyPatch,
    scenario: Scenario,
    **state_overrides: Any,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    monkeypatch.setattr(nodes, "invoke_structured", scenario.structured)
    monkeypatch.setattr(nodes, "invoke_researcher_turn", scenario.researcher)
    monkeypatch.setattr(nodes, "execute_search_tool", scenario.execute_tool)

    state = initial_state(
        "需要搜索的测试问题" if scenario.need_search else "解释递归",
        run_id=f"run_{uuid.uuid4().hex}",
        model_id="deepseek-v4-flash",
        **state_overrides,
    )
    graph = build_graph()
    context = RunContext(agent_config(), MemoryLedger(), None)
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


@pytest.mark.asyncio
async def test_force_search_runs_real_tool_even_when_supervisor_suggests_direct(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(need_search=False)
    output, events = await run_scenario(monkeypatch, scenario)

    assert output["need_search"] is True
    assert output["response_status"] == "completed"
    assert output["stop_reason"] == "VERIFIED"
    assert output["tool_calls"] == 1
    assert scenario.tool_executions == ["query one"]
    assert [event["type"] for event in events if event["type"].startswith("tool.")] == [
        "tool.started",
        "tool.completed",
    ]


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
    assert not any(event["type"] == "tool.presented" for event in events)
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
    scenario = Scenario(structured_attempts={"planner": 2})
    output, _events = await run_scenario(monkeypatch, scenario)

    assert output["response_status"] == "completed"
    assert output["schema_repair_count"] == 1
    assert output["model_calls"] == 8
    planner_index = scenario.structured_repair_permissions.index(("planner", True))
    assert all(
        not allowed
        for _role, allowed in scenario.structured_repair_permissions[planner_index + 1:]
    )


@pytest.mark.asyncio
async def test_single_search_runs_think_search_observe_and_pairs_ids(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario()
    output, events = await run_scenario(monkeypatch, scenario)

    assert output["response_status"] == "completed"
    assert output["pending_queries"] == []
    assert output["tool_calls"] == 1
    assert len(output["evidence"]) == 1
    assert scenario.tool_executions == ["query one"]

    observation_messages = scenario.researcher_messages[-1]
    assistant_ids = {
        call["id"]
        for message in observation_messages
        if message.get("role") == "assistant"
        for call in message.get("tool_calls", [])
    }
    tool_ids = {
        message["tool_call_id"]
        for message in observation_messages
        if message.get("role") == "tool"
    }
    assert assistant_ids == tool_ids == {"call_1"}

    tool_events = [event for event in events if event.get("toolCallId") == "call_1"]
    assert [event["type"] for event in tool_events] == ["tool.started", "tool.completed"]


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
    assert presented[0]["toolCallId"] == "call_1"
    assert presented[0]["sources"] == [{
        "url": "https://example.com/1",
        "text": "该来源介绍了与问题相关的可核验做法。",
    }]
    assert output["candidates"][0]["tool_call_id"] == "call_1"
    assert output["candidates"][0]["iteration"] == 1


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
    output, events = await run_scenario(monkeypatch, scenario)

    assert output["query_channels"] == {"OpenAI 最新帖子": "x"}
    assert output["candidates"][0]["channel"] == "x"
    started = next(event for event in events if event["type"] == "tool.started")
    assert started["channel"] == "x"
    assert scenario.tool_executions == ["OpenAI 最新帖子"]


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
    output, events = await run_scenario(monkeypatch, scenario)

    assert output["queries"] == []
    assert scenario.tool_executions == []
    assert not any(event["type"] == "tool.started" for event in events)


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
async def test_reflector_can_open_a_complementary_channel_after_source_gap(
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

    assert output["response_status"] == "completed"
    assert scenario.tool_execution_searches == [
        {"query": "query one", "channel": "web"},
        {"query": "query x", "channel": "x"},
    ]
    assert output["searches"] == scenario.tool_execution_searches


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


@pytest.mark.parametrize("mode,code", [("bad_args", "INVALID_ARGUMENTS"), ("unknown_tool", "UNKNOWN_TOOL")])
@pytest.mark.asyncio
async def test_rejected_tool_calls_still_emit_started_then_failed(
    monkeypatch: pytest.MonkeyPatch,
    mode: str,
    code: str,
) -> None:
    scenario = Scenario(
        researcher_mode=mode,
        reflects=[{"sufficient": False, "missing": "tool failed", "extra_searches": []}],
        evidence_by_query={},
    )
    output, events = await run_scenario(monkeypatch, scenario)

    call_events = [event for event in events if event.get("toolCallId") == "call_1"]
    assert [event["type"] for event in call_events] == ["tool.started", "tool.failed"]
    assert call_events[-1]["reasonCode"] == code
    expected_tool = "unknown_tool" if mode == "unknown_tool" else "web_search"
    assert {event["toolName"] for event in call_events} == {expected_tool}
    assert output["tool_traces"][0]["error_code"] == code


@pytest.mark.asyncio
async def test_extra_parallel_call_is_paired_but_never_exceeds_tool_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(researcher_mode="multiple")
    output, events = await run_scenario(monkeypatch, scenario, max_tool_calls=1)

    assert output["tool_calls"] == 1
    assert scenario.tool_executions == ["query one"]
    extra = [event for event in events if event.get("toolCallId") == "call_1_extra"]
    assert [event["type"] for event in extra] == ["tool.started", "tool.failed"]
    assert extra[-1]["reasonCode"] == "TOOL_CALL_LIMIT"


@pytest.mark.asyncio
async def test_model_limit_stops_with_partial_answer_without_overshoot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(
        reflects=[{"sufficient": False, "missing": "budget", "extra_searches": []}],
        evidence_by_query={},
    )
    output, _events = await run_scenario(monkeypatch, scenario, max_model_calls=4)

    assert output["model_calls"] <= 4
    assert output["response_status"] == "partial"
    assert output["stop_reason"] == "MODEL_CALL_LIMIT"


@pytest.mark.asyncio
async def test_tool_timeout_preserves_finalization_instead_of_failing_run(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(
        tool_delay_seconds=0.05,
        evidence_by_query={"query one": False},
    )
    monkeypatch.setattr(nodes, "tool_timeout_seconds", lambda _state, _channel: 0.01)

    output, events = await run_scenario(monkeypatch, scenario)

    assert output["response_status"] == "partial"
    assert output["stop_reason"] == "RUN_TIME_RESERVE"
    assert output["tool_traces"][0]["error_code"] == "RUN_TIME_RESERVE"
    tool_events = [event for event in events if event.get("toolCallId") == "call_1"]
    assert [event["type"] for event in tool_events] == [
        "tool.started",
        "tool.failed",
    ]
    assert tool_events[-1]["reasonCode"] == "RUN_TIME_RESERVE"


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
    )
    output, _events = await run_scenario(monkeypatch, scenario, max_rounds=1)
    assert output["response_status"] == "partial"
    assert output["stop_reason"] == "MAX_ITERATIONS"


@pytest.mark.asyncio
async def test_no_progress_has_stable_partial_stop_reason(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(
        reflects=[{"sufficient": False, "missing": "unsupported", "extra_searches": []}],
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
    assert [event["seq"] for event in events] == list(range(1, len(events) + 1))
    assert len({event["eventId"] for event in events}) == len(events)


@pytest.mark.asyncio
async def test_private_reasoning_never_crosses_state_checkpoint_or_public_events(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(include_reasoning=True)
    output, events = await run_scenario(monkeypatch, scenario)
    assert any(
        "reasoning_content" in message
        for turn in scenario.researcher_messages
        for message in turn
    )

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
    assert "PRIVATE_CHAIN_OF_THOUGHT_SENTINEL" not in serialized
