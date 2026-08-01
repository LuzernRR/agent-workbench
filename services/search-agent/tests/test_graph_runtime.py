from __future__ import annotations

import asyncio
import copy
import json
import re
import time
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from app.config.agent import agent_config
from app.events.runtime import begin_event_scope, end_event_scope
from app.graph import nodes
from app.graph.build import _novel_public_summary, build_graph
from app.graph.context import RunContext
from app.graph.schemas import (
    ANSWER_MAX_CHARS,
    ComposeResult,
    IntentResult,
    PlanResult,
    ReflectResult,
    SourcePresentationResult,
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
from app.tools.channels.base import (
    ChannelProgress,
    ChannelVerificationUpdate,
    SourceProvenance,
    channel_resolution,
)
from app.tools.search_tool import (
    PublicSearchResult,
    SearchEvidence,
    SearchExecutionResult,
)
from app.tools.xiaohongshu_verification import XiaohongshuVerificationRegistry


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


def test_explicit_output_contract_requires_every_field_in_each_numbered_item() -> None:
    question = (
        "请搜索小红书上关于“油敏皮夏季通勤防晒”的近期使用笔记。"
        "只读取可访问正文，按“肤质与场景 / 使用感受 / 防晒产品类型 / "
        "可能不适合的人群 / 来源链接”归纳 3–5 条经验。"
    )
    invalid_answer = (
        "1. **肤质与场景**：高温通勤 [来源1]。\n"
        "2. **使用感受**：肤感清爽 [来源1]。\n"
        "3. **防晒产品类型**：物化结合 [来源2]。\n"
        "4. **可能不适合的人群**：香精敏感者 [来源2]。"
    )
    valid_answer = "\n".join(
        f"{index}. 肤质与场景：高温通勤\n"
        "使用感受：肤感清爽\n"
        "防晒产品类型：物化结合\n"
        "可能不适合的人群：香精敏感者\n"
        f"来源链接：[来源{1 if index < 3 else 2}]"
        for index in range(1, 4)
    )

    issue = nodes._explicit_output_issue(question, invalid_answer)

    assert issue is not None
    assert "每个编号条目都必须按顺序包含" in issue
    assert nodes._explicit_output_issue(question, valid_answer) is None
    instruction = nodes._explicit_output_instruction(question)
    assert instruction is not None
    assert "输出 3 个编号一级列表项" in instruction
    assert "禁止把不同字段拆成不同编号项" in instruction
    assert "总回答不超过 680 字" in instruction
    assert "非医疗建议" not in instruction


def test_explicit_output_contract_requires_requested_non_medical_boundary() -> None:
    question = "请归纳使用体验，不得把个人体验写成医疗建议。"

    assert nodes._explicit_output_issue(question, "这是个人体验。") is not None
    assert nodes._explicit_output_issue(
        question,
        "这是个人体验，非医疗建议。",
    ) is None
    instruction = nodes._explicit_output_instruction(question)
    assert instruction is not None
    assert "以上为个人使用体验，非医疗建议" in instruction


def test_public_summary_requires_model_step_and_recorded_model_call() -> None:
    assert nodes._step(
        "plan_research",
        "deterministic",
        "本地固定计划",
        "test",
    )[0]["summary"] == ""
    assert _novel_public_summary(
        "plan_research",
        "本地固定计划",
        "deterministic",
        True,
        [],
    ) is None
    assert _novel_public_summary(
        "plan_research",
        "伪装成模型但没有调用记录",
        "model",
        False,
        [],
    ) is None
    assert _novel_public_summary(
        "plan_research",
        "真实模型生成的公开计划",
        "model",
        True,
        [],
    ) == "真实模型生成的公开计划"


@pytest.mark.asyncio
async def test_xiaohongshu_mcp_failure_opens_public_strategy_for_later_query(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(
        supervisor_channels=["xiaohongshu"],
        plans=[["query one", "query two"]],
        channels_by_query={
            "query one": "xiaohongshu",
            "query two": "xiaohongshu",
        },
        evidence_by_query={"query one": True, "query two": True},
        provider_by_query={
            "query one": "xiaohongshu-mcp-fallback[MCP_TIMEOUT]+tavily",
            "query two": "xiaohongshu-mcp-fallback[MCP_CIRCUIT_OPEN]+tavily",
        },
    )

    _output, events = await run_scenario(
        monkeypatch,
        scenario,
        question="只在小红书搜索这些测试笔记",
    )

    assert scenario.tool_execution_public_only == [False, True]
    assert scenario.max_active_tool_calls == 1
    assert len([
        event
        for event in events
        if event["type"] == "node.started" and event["node"] == "research"
    ]) == 1
    assert len([
        event
        for event in events
        if event["type"] == "node.started" and event["node"] == "merge_research"
    ]) == 1


@pytest.mark.asyncio
async def test_xiaohongshu_verification_events_keep_same_tool_and_pause_sla(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    challenge_id = "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789"
    base_update = {
        "challenge_id": challenge_id,
        "expires_at": "2099-08-01T00:04:00Z",
        "retry_after_ms": 2000,
    }
    scenario = Scenario(
        supervisor_channels=["xiaohongshu"],
        channels_by_query={"query one": "xiaohongshu"},
        verification_updates=[
            ChannelVerificationUpdate(
                **base_update,
                status="pending",
                message="等待使用小红书 App 扫码验证工具账号",
            ),
            ChannelVerificationUpdate(
                **base_update,
                status="pending",
                message="等待使用小红书 App 扫码验证工具账号",
            ),
            ChannelVerificationUpdate(
                **base_update,
                status="succeeded",
                message="小红书工具账号验证成功",
            ),
        ],
        interaction_wait_ms=120_000,
    )

    output, events = await run_scenario(
        monkeypatch,
        scenario,
        question="只在小红书搜索油敏皮夏季通勤防晒",
        verification_registry=True,
    )

    verification_events = [
        event for event in events if event["type"].startswith("tool.verification.")
    ]
    assert [event["type"] for event in verification_events] == [
        "tool.verification.required",
        "tool.verification.heartbeat",
        "tool.verification.resolved",
    ]
    assert len({event["toolCallId"] for event in verification_events}) == 1
    assert scenario.verification_request_keys == [
        f"{output['run_id']}:{verification_events[0]['toolCallId']}"
    ]
    assert output["external_wait_seconds"] == 120.0
    assert "qrcode" not in json.dumps(verification_events).lower()
    assert "xiaohongshu-mcp:18060" not in json.dumps(verification_events)


@pytest.mark.asyncio
async def test_zero_evidence_platform_round_keeps_web_fallback_partial(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(
        supervisor_channels=["xiaohongshu"],
        plans=[["xhs query"], ["official web query"]],
        writer_answer="现有 web 补充证据不能代表小红书近期使用笔记 [来源1]。",
        reflects=[
            {
                "sufficient": False,
                "missing": "缺少可读取正文",
                "extra_searches": [{"query": "official web query", "channel": "web"}],
                "source_presentations": [],
            },
            {
                "sufficient": True,
                "missing": "web 资料只能作为补充，仍缺少小红书正文",
                "extra_searches": [],
                "source_presentations": [{
                    "url": "https://example.com/2",
                    "include_in_details": False,
                    "text": "",
                }],
            },
        ],
        evidence_by_query={
            "xhs query": False,
            "official web query": True,
        },
        channels_by_query={
            "xhs query": "xiaohongshu",
            "official web query": "web",
        },
    )

    output, events = await run_scenario(
        monkeypatch,
        scenario,
        question="只在小红书搜索这些测试笔记",
        max_rounds=3,
        no_progress_limit=3,
    )

    assert scenario.tool_execution_searches == [
        {"query": "xhs query", "channel": "xiaohongshu"},
        {"query": "official web query", "channel": "web"},
    ]
    assert output["response_status"] == "partial"
    assert output["verification_passed"] is False
    assert output["stop_reason"] == "MAX_ITERATIONS"
    assert "Evidence：xiaohongshu" in output["verification_issue"]
    assert output["answer"] == scenario.writer_answer
    assert output["answer_source"] == "model"
    assert "MISSING_CHANNEL_EVIDENCE" not in output["answer"]
    assert scenario.structured_calls.get("source_curator", 0) == 1
    presented = [event for event in events if event["type"] == "tool.presented"]
    assert len(presented) == 1
    assert presented[0]["sources"][0]["url"] == "https://example.com/2"


def test_public_process_drops_fetch_noise_without_inventing_replacement() -> None:
    for text in (
        "本次搜索渠道降级为公开索引。",
        "其余来源正文均未读取。",
        "仅发现公开候选，未获取内容。",
    ):
        assert nodes._effective_process_text(text) is None

    useful = "现有证据支持 LangChain 与 LangGraph 的区别，仍缺少 LangSmith。"
    assert nodes._effective_process_text(useful) == useful


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
        default_factory=lambda: [{
            "sufficient": True,
            "missing": "",
            "extra_searches": [],
            "source_presentations": [{
                "url": "https://example.com/1",
                "text": "该来源给出了与测试问题直接相关的可核验做法。",
            }],
        }]
    )
    verifier_actions: list[str] = field(default_factory=lambda: ["pass"])
    writer_answer: str | None = None
    writer_answers: list[str] = field(default_factory=list)
    researcher_mode: str = "valid"
    include_reasoning: bool = False
    evidence_by_query: dict[str, bool] = field(default_factory=lambda: {"query one": True})
    result_count_by_query: dict[str, int] = field(default_factory=dict)
    limitations_by_query: dict[str, str] = field(default_factory=dict)
    provider_by_query: dict[str, str] = field(default_factory=dict)
    channels_by_query: dict[str, str] = field(default_factory=dict)
    depends_on_by_query: dict[str, list[str]] = field(default_factory=dict)
    structured_calls: dict[str, int] = field(default_factory=dict)
    structured_attempts: dict[str, int] = field(default_factory=dict)
    structured_repair_permissions: list[tuple[str, bool]] = field(default_factory=list)
    structured_messages: dict[str, list[Any]] = field(default_factory=dict)
    invalid_structured_roles: set[str] = field(default_factory=set)
    researcher_messages: list[list[dict[str, Any]]] = field(default_factory=list)
    tool_executions: list[str] = field(default_factory=list)
    tool_execution_searches: list[dict[str, str]] = field(default_factory=list)
    tool_execution_public_only: list[bool] = field(default_factory=list)
    tool_delay_seconds: float = 0
    tool_delay_by_query: dict[str, float] = field(default_factory=dict)
    progress_before_delay: bool = False
    active_tool_calls: int = 0
    max_active_tool_calls: int = 0
    tool_completion_order: list[str] = field(default_factory=list)
    tool_started_at_by_query: dict[str, float] = field(default_factory=dict)
    tool_finished_at_by_query: dict[str, float] = field(default_factory=dict)
    tool_call_index: int = 0
    checkpoint_values: dict[str, Any] = field(default_factory=dict)
    verification_updates: list[ChannelVerificationUpdate] = field(default_factory=list)
    verification_request_keys: list[str] = field(default_factory=list)
    interaction_wait_ms: int = 0

    async def structured(
        self,
        role: str,
        schema: type[Any],
        messages: Any,
        *,
        model_id: str | None = None,
        allow_repair: bool = False,
    ) -> tuple[Any, ModelUsage]:
        role_key = "source_curator" if schema is SourcePresentationResult else role
        self.structured_repair_permissions.append((role_key, allow_repair))
        self.structured_messages.setdefault(role_key, []).append(copy.deepcopy(messages))
        index = self.structured_calls.get(role_key, 0)
        self.structured_calls[role_key] = index + 1
        if role_key in self.invalid_structured_roles:
            raise StructuredOutputError(ModelUsage(
                20,
                4,
                24,
                0.000002,
                attempts=2 if allow_repair else 1,
            ))
        if schema is SourcePresentationResult:
            urls = re.findall(
                r"URL: (https?://\S+)",
                str(messages[-1].content),
            )
            result = SourcePresentationResult(source_presentations=[
                {
                    "url": url,
                    "include_in_details": True,
                    "text": "该来源正文提供了与用户问题直接相关的有效事实。",
                }
                for url in dict.fromkeys(urls)
            ])
        elif role == "supervisor":
            result = IntentResult(
                task_type="research" if self.need_search else "direct_answer",
                need_search=self.need_search,
                channels=self.supervisor_channels,
                summary="已判断是否需要联网",
            )
        elif role == "planner":
            queries = self.plans[min(index, len(self.plans) - 1)]
            result = PlanResult(
                steps=[
                    {
                        "local_id": f"search_{position + 1}",
                        "facet": f"证据面 {position + 1}",
                        "objective": f"检索 {query}",
                        "query": query,
                        "channel": self.channels_by_query.get(query, "web"),
                        "depends_on": self.depends_on_by_query.get(query, []),
                        "priority": 100 - position,
                        "evidence_needed": 0,
                        "can_parallelize": True,
                    }
                    for position, query in enumerate(queries)
                ],
                summary="已形成检索计划",
            )
        elif role == "reflector":
            data = copy.deepcopy(self.reflects[min(index, len(self.reflects) - 1)])
            for presentation in data.get("source_presentations", []):
                presentation.setdefault("include_in_details", True)
            result = ReflectResult(summary="已评估证据覆盖", **data)
        elif role == "writer":
            writer_answer = (
                self.writer_answers[min(index, len(self.writer_answers) - 1)]
                if self.writer_answers
                else self.writer_answer
            )
            result = ComposeResult(
                answer_markdown=(
                    writer_answer
                    or ("可核验回答 [来源1]" if self.need_search else "直接回答")
                ),
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

    async def execute_tool(
        self,
        arguments: Any,
        config: Any,
        progress: Any = None,
        *,
        xiaohongshu_public_only: bool = False,
        verification_request_key: str | None = None,
        verification: Any = None,
    ) -> SearchExecutionResult:
        query = arguments.query
        self.tool_executions.append(query)
        execution_number = len(self.tool_executions)
        self.tool_execution_searches.append(
            {"query": query, "channel": arguments.channel}
        )
        self.tool_execution_public_only.append(xiaohongshu_public_only)
        self.tool_started_at_by_query[query] = time.perf_counter()
        if verification_request_key is not None:
            self.verification_request_keys.append(verification_request_key)
        if verification is not None:
            for update in self.verification_updates:
                verification(update)
        self.active_tool_calls += 1
        self.max_active_tool_calls = max(
            self.max_active_tool_calls,
            self.active_tool_calls,
        )
        if self.progress_before_delay and progress:
            progress(ChannelProgress(
                provider="deterministic",
                result_count=5,
                evidence_count=0,
            ))
        try:
            delay = self.tool_delay_by_query.get(query, self.tool_delay_seconds)
            if delay:
                await asyncio.sleep(delay)
        finally:
            self.active_tool_calls -= 1
            self.tool_completion_order.append(query)
            self.tool_finished_at_by_query[query] = time.perf_counter()
        has_evidence = self.evidence_by_query.get(query, False)
        result_count = self.result_count_by_query.get(query, 1)
        limitation = self.limitations_by_query.get(query)
        provider = self.provider_by_query.get(query, "deterministic")
        degraded_match = re.search(r"fallback\[([^]]+)]", provider)
        reason_code = degraded_match.group(1) if degraded_match else None
        url = f"https://example.com/{execution_number}"
        return SearchExecutionResult(
            ok=True,
            channel=arguments.channel,
            query=query,
            provider=provider,
            results=[PublicSearchResult(
                channel=arguments.channel,
                provider=provider,
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
                provider=provider,
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
            error_code=reason_code,
            error_message=("受控降级" if reason_code else None),
            resolution=channel_resolution(
                status="degraded" if reason_code else "success",
                primary_provider=(
                    "xiaohongshu-mcp"
                    if arguments.channel == "xiaohongshu"
                    else provider
                ),
                effective_provider=provider,
                reason_code=reason_code,
                message="受控降级" if reason_code else None,
            ),
            interaction_wait_ms=self.interaction_wait_ms,
        )


async def run_scenario(
    monkeypatch: pytest.MonkeyPatch,
    scenario: Scenario,
    *,
    question: str | None = None,
    verification_registry: bool = False,
    **state_overrides: Any,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    monkeypatch.setattr(nodes, "invoke_structured", scenario.structured)
    monkeypatch.setattr(nodes, "execute_search_tool", scenario.execute_tool)

    state = initial_state(
        question or ("需要搜索的测试问题" if scenario.need_search else "解释递归"),
        run_id=f"run_{uuid.uuid4().hex}",
        model_id="deepseek-v4-flash",
        **state_overrides,
    )
    graph = build_graph()
    context = RunContext(
        agent_config(),
        MemoryLedger(),
        None,
        XiaohongshuVerificationRegistry() if verification_registry else None,
    )
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


@pytest.mark.parametrize(
    ("question", "expected"),
    [
        ("解释递归", ["web"]),
        ("只查小红书里的 Cursor 讨论", ["xiaohongshu"]),
        ("查看 x.com/Twitter 上的 OpenAI 帖子", ["x"]),
        (
            "比较官网网页、X/Twitter 与小红书上的公开信息",
            ["web", "x", "xiaohongshu"],
        ),
        ("xiaohongshu 和 website 的资料", ["xiaohongshu", "web"]),
    ],
)
def test_forced_search_channels_follow_explicit_platform_words(
    question: str,
    expected: list[str],
) -> None:
    assert nodes._forced_search_channels(question) == expected


def test_answer_compaction_uses_complete_markdown_and_citation_boundaries() -> None:
    answer = "\n".join(
        ["结论先行：这些岗位都强调真实产品协作 [来源1]。"]
        + [
            f"- 要点{i}：需要用户研究、数据分析与跨团队推进能力 [来源1][来源2]。"
            for i in range(1, 10)
        ]
    )

    compacted = nodes._compact_answer_markdown(answer, max_chars=180)

    assert len(compacted) <= 180
    assert answer.startswith(compacted)
    assert compacted.endswith("。")
    assert compacted.count("[") == compacted.count("]")
    assert not re.search(r"\[来源\d*$", compacted)


def test_answer_citations_publish_only_referenced_sources_and_renumber_gaps() -> None:
    evidence = [
        {
            "channel": "xiaohongshu",
            "provider": "xiaohongshu-mcp",
            "query": "油敏皮防晒",
            "url": f"https://www.xiaohongshu.com/explore/note_{index}",
            "title": f"来源 {index}",
            "text": "已读取正文",
            "extractor": "xiaohongshu-mcp-authenticated",
            "captured_at": "2026-08-01T00:00:00Z",
        }
        for index in range(1, 7)
    ]

    answer, citations = nodes._answer_citations(
        "第一条 [来源2]，第二条 [来源6]，再次引用 [来源2]。",
        evidence,
    )

    assert answer == "第一条 [来源1]，第二条 [来源2]，再次引用 [来源1]。"
    assert [citation["label"] for citation in citations] == ["来源 2", "来源 6"]
    assert [citation["url"] for citation in citations] == [
        "https://www.xiaohongshu.com/explore/note_2",
        "https://www.xiaohongshu.com/explore/note_6",
    ]


@pytest.mark.asyncio
async def test_oversized_writer_answer_is_compacted_before_verification(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    writer_answer = "\n".join(
        f"- 第{i}项结论由已读取正文直接支持 [来源1]。"
        for i in range(1, 80)
    )
    scenario = Scenario(writer_answer=writer_answer)

    output, _events = await run_scenario(monkeypatch, scenario)

    assert output["response_status"] == "completed"
    assert output["stop_reason"] == "VERIFIED"
    assert len(output["answer"]) <= ANSWER_MAX_CHARS
    assert writer_answer.startswith(output["answer"])
    assert output["answer"].count("[") == output["answer"].count("]")
    verifier_prompt = scenario.structured_messages["verifier"][-1][-1].content
    assert output["answer"] in verifier_prompt
    assert writer_answer not in verifier_prompt


@pytest.mark.asyncio
async def test_writer_output_invalid_returns_structured_failure_without_template_answer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(invalid_structured_roles={"writer"})

    output, _events = await run_scenario(monkeypatch, scenario)

    assert output["response_status"] == "partial"
    assert output["stop_reason"] == "OUTPUT_INVALID"
    assert output["verification_passed"] is False
    assert output["answer"] is None
    assert output["answer_source"] == "none"
    assert scenario.structured_calls.get("verifier", 0) == 0


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
    assert scenario.structured_calls.get("supervisor", 0) == 0
    assert output["intent"]["channels"] == ["web"]
    classify_step = next(
        step for step in output["steps"] if step["node"] == "classify_intent"
    )
    assert classify_step["kind"] == "deterministic"
    assert [event["type"] for event in events if event["type"].startswith("tool.")] == [
        "tool.started",
        "tool.progress",
        "tool.progress",
        "tool.completed",
        "tool.presented",
    ]
    plan_events = [event for event in events if event["type"] == "plan.updated"]
    assert [event["revision"] for event in plan_events] == [1, 2, 3]
    assert [event["steps"][0]["status"] for event in plan_events] == [
        "todo",
        "running",
        "done",
    ]
    started = next(event for event in events if event["type"] == "tool.started")
    assert started["planStepId"] == plan_events[1]["steps"][0]["stepId"]
    assert output["plan"]["revision"] == 3
    assert output["tool_traces"][0]["plan_step_id"] == started["planStepId"]


@pytest.mark.asyncio
async def test_explicit_xiaohongshu_topic_uses_real_planner_model_output(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    topic = "油敏皮夏季通勤防晒"
    scenario = Scenario(
        supervisor_channels=["xiaohongshu"],
        plans=[[topic]],
        evidence_by_query={topic: True},
        channels_by_query={topic: "xiaohongshu"},
    )

    output, events = await run_scenario(
        monkeypatch,
        scenario,
        question=(
            "请搜索小红书上关于“油敏皮夏季通勤防晒”的近期使用笔记。"
            "只读取可访问正文。"
        ),
    )

    assert scenario.structured_calls.get("planner", 0) == 1
    assert scenario.tool_execution_searches == [
        {"query": topic, "channel": "xiaohongshu"},
    ]
    plan_step = next(
        step for step in output["steps"] if step["node"] == "plan_research"
    )
    assert plan_step["kind"] == "model"
    completed = next(
        event
        for event in events
        if event["type"] == "node.completed" and event["node"] == "plan_research"
    )
    assert completed["publicSummary"] == "已形成检索计划"
    assert completed["publicSummarySource"] == "model"


def test_presented_xiaohongshu_sources_stop_synonym_search_at_requested_minimum() -> None:
    question = (
        "请搜索小红书上关于“油敏皮夏季通勤防晒”的近期使用笔记，"
        "按“肤质与场景 / 使用感受 / 防晒产品类型 / 可能不适合的人群 / "
        "来源链接”归纳 3–5 条经验。"
    )
    evidence = [
        {
            "channel": "xiaohongshu",
            "url": f"https://www.xiaohongshu.com/explore/note_{index}",
        }
        for index in range(1, 4)
    ]
    presented = {item["url"] for item in evidence}

    assert nodes._presented_sources_satisfy_contract(
        question,
        evidence,  # type: ignore[arg-type]
        presented,
        ["xiaohongshu"],
        "还可补充更多同类描述",
    )
    assert not nodes._presented_sources_satisfy_contract(
        question,
        evidence[:2],  # type: ignore[arg-type]
        {item["url"] for item in evidence[:2]},
        ["xiaohongshu"],
        "条目不足",
    )
    assert not nodes._presented_sources_satisfy_contract(
        question,
        evidence,  # type: ignore[arg-type]
        presented,
        ["xiaohongshu"],
        "来源结论互相冲突",
    )


def test_ineffective_source_text_rejects_short_or_missing_dimension_copy() -> None:
    assert nodes._effective_source_text("正文过短，未展开通勤场景与适用人群。") is None


@pytest.mark.asyncio
async def test_explicit_output_contract_forces_rewrite_when_verifier_misses_format(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    topic = "油敏皮夏季通勤防晒"
    invalid_answer = (
        "1. 肤质与场景：高温通勤 [来源1]。\n"
        "2. 使用感受：肤感清爽 [来源1]。\n"
        "3. 防晒产品类型：物化结合 [来源1]。\n"
        "4. 可能不适合的人群：香精敏感者 [来源1]。"
    )
    valid_answer = "\n\n".join(
        f"{index}. 肤质与场景：高温通勤\n"
        "使用感受：肤感清爽\n"
        "防晒产品类型：物化结合\n"
        "可能不适合的人群：香精敏感者\n"
        "来源链接：[来源1]"
        for index in range(1, 4)
    ) + "\n\n以上为个人使用体验，非医疗建议。"
    scenario = Scenario(
        supervisor_channels=["xiaohongshu"],
        plans=[[topic]],
        evidence_by_query={topic: True},
        channels_by_query={topic: "xiaohongshu"},
        writer_answers=[invalid_answer, valid_answer],
        verifier_actions=["pass", "pass"],
    )

    output, _events = await run_scenario(
        monkeypatch,
        scenario,
        question=(
            "请搜索小红书上关于“油敏皮夏季通勤防晒”的近期使用笔记。"
            "只读取可访问正文，按“肤质与场景 / 使用感受 / 防晒产品类型 / "
            "可能不适合的人群 / 来源链接”归纳 3–5 条经验；"
            "不得把个人体验写成医疗建议，正文不可读时不展示为证据。"
        ),
    )

    assert output["response_status"] == "completed"
    assert output["stop_reason"] == "VERIFIED"
    assert output["answer"] == valid_answer
    assert output["answer_source"] == "model"
    assert output["answer_model_calls"] == 1
    assert scenario.structured_calls["writer"] == 2
    assert scenario.structured_calls["verifier"] == 2
    first_writer_prompt = scenario.structured_messages["writer"][0][-1].content
    assert "输出格式硬约束" in first_writer_prompt
    assert "每个编号项代表一条完整经验" in first_writer_prompt


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
    assert scenario.structured_calls["source_curator"] == 1
    assert any(event["type"] == "tool.presented" for event in events)
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
    # 强制搜索不调用 Supervisor，Researcher 也不再复述 Planner 的固定参数。
    assert output["model_calls"] == 5
    planner_index = scenario.structured_repair_permissions.index(("planner", True))
    assert all(
        not allowed
        for _role, allowed in scenario.structured_repair_permissions[planner_index + 1:]
    )


@pytest.mark.asyncio
async def test_single_search_uses_deterministic_tool_id_and_complete_ledger(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario()
    output, events = await run_scenario(monkeypatch, scenario)

    assert output["response_status"] == "completed"
    assert output["pending_queries"] == []
    assert output["tool_calls"] == 1
    assert len(output["evidence"]) == 1
    assert scenario.tool_executions == ["query one"]

    assert scenario.researcher_messages == []
    tool_call_id = output["tool_traces"][0]["tool_call_id"]
    assert tool_call_id.startswith("call_search_")
    tool_events = [
        event for event in events if event.get("toolCallId") == tool_call_id
    ]
    assert [event["type"] for event in tool_events] == [
        "tool.started",
        "tool.progress",
        "tool.progress",
        "tool.completed",
        "tool.presented",
    ]
    assert [
        (event["resultCount"], event["evidenceCount"])
        for event in tool_events
        if event["type"] == "tool.progress"
    ] == [(1, 0), (1, 1)]
    completed = next(event for event in tool_events if event["type"] == "tool.completed")
    assert completed["status"] == "success"
    assert completed["primaryProvider"] == "deterministic"
    assert completed["effectiveProvider"] == "deterministic"
    assert completed["nextAction"] == "none"
    assert isinstance(completed["durationMs"], int)
    assert completed["durationMs"] >= 0


@pytest.mark.asyncio
async def test_independent_searches_run_concurrently_and_merge_in_plan_order(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(
        plans=[["slow web", "fast x"]],
        supervisor_channels=["web", "x"],
        channels_by_query={"slow web": "web", "fast x": "x"},
        evidence_by_query={"slow web": True, "fast x": True},
        tool_delay_by_query={"slow web": 0.25, "fast x": 0.05},
    )

    output, events = await run_scenario(
        monkeypatch,
        scenario,
        question="同时搜索官网网页和 X/Twitter 的最新信息",
    )
    tool_span = (
        max(scenario.tool_finished_at_by_query.values())
        - min(scenario.tool_started_at_by_query.values())
    )

    assert scenario.max_active_tool_calls == 2
    assert scenario.tool_completion_order[:2] == ["fast x", "slow web"]
    assert tool_span < 0.29
    assert [item["query"] for item in output["candidates"][:2]] == [
        "slow web",
        "fast x",
    ]
    assert [item["query"] for item in output["tool_traces"][:2]] == [
        "slow web",
        "fast x",
    ]
    assert "research_work_item" not in output
    assert output["research_results"] == []
    assert len(output["merged_research_result_ids"]) == 2
    research_starts = [
        event
        for event in events
        if event["type"] == "node.started" and event["node"] == "research"
    ]
    research_completions = [
        event
        for event in events
        if event["type"] == "node.completed" and event["node"] == "research"
    ]
    merge_starts = [
        event
        for event in events
        if event["type"] == "node.started" and event["node"] == "merge_research"
    ]
    assert len(research_starts) == 2
    assert len(research_completions) == 2
    assert len(merge_starts) == 1
    assert max(event["seq"] for event in research_completions) < merge_starts[0]["seq"]


@pytest.mark.asyncio
async def test_dependent_batch_is_dispatched_only_after_prior_merge_checkpoint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(
        plans=[["definition", "comparison"]],
        channels_by_query={"definition": "web", "comparison": "web"},
        depends_on_by_query={"comparison": ["search_1"]},
        evidence_by_query={"definition": True, "comparison": True},
    )

    output, events = await run_scenario(monkeypatch, scenario)

    assert scenario.tool_executions == ["definition", "comparison"]
    merge_completions = [
        event
        for event in events
        if event["type"] == "node.completed" and event["node"] == "merge_research"
    ]
    mark_starts = [
        event
        for event in events
        if event["type"] == "node.started" and event["node"] == "mark_plan_running"
    ]
    research_starts = [
        event
        for event in events
        if event["type"] == "node.started" and event["node"] == "research"
    ]
    assert len(merge_completions) == 2
    assert len(mark_starts) == 2
    assert len(research_starts) == 2
    assert merge_completions[0]["seq"] < mark_starts[1]["seq"]
    assert [step["status"] for step in output["plan"]["steps"]] == ["done", "done"]
    assert output["plan"]["revision"] == 5


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
    tool_call_id = output["candidates"][0]["tool_call_id"]
    assert presented[0]["toolCallId"] == tool_call_id
    assert presented[0]["sources"] == [{
        "url": "https://example.com/1",
        "text": "该来源介绍了与问题相关的可核验做法。",
    }]
    assert output["candidates"][0]["tool_call_id"] == tool_call_id
    assert output["candidates"][0]["iteration"] == 1


@pytest.mark.asyncio
async def test_reflector_excludes_read_but_irrelevant_evidence_from_details(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(reflects=[{
        "sufficient": False,
        "missing": "该来源不符合用户限定条件",
        "extra_searches": [],
        "source_presentations": [{
            "url": "https://example.com/1",
            "include_in_details": False,
            "text": "",
        }],
    }])

    _output, events = await run_scenario(monkeypatch, scenario)

    assert not [event for event in events if event["type"] == "tool.presented"]
    assert scenario.structured_calls.get("source_curator", 0) == 0


@pytest.mark.asyncio
async def test_source_curator_replaces_invalid_presentations_with_agent_output(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(reflects=[{
        "sufficient": True,
        "missing": "",
        "extra_searches": [],
        "source_presentations": [
            {"url": "https://example.com/1", "text": "但帖子详情/正文内容未读取。"},
            {"url": "https://example.com/1", "text": "仅发现公开候选，尚未核验。"},
            {"url": "https://example.com/1", "text": "正文仅包含标签，无有效对比内容。"},
            {
                "url": "https://example.com/1",
                "text": "该教程未涉及 LangChain 与 LangSmith 的区别。",
            },
        ],
    }])

    output, events = await run_scenario(monkeypatch, scenario)

    presented = [event for event in events if event["type"] == "tool.presented"]
    assert scenario.structured_calls["source_curator"] == 1
    assert len(presented) == 1
    assert presented[0]["toolCallId"] == output["tool_traces"][0]["tool_call_id"]
    assert presented[0]["sources"] == [{
        "url": "https://example.com/1",
        "text": "该来源正文提供了与用户问题直接相关的有效事实。",
    }]


@pytest.mark.asyncio
async def test_source_curator_fills_every_missing_current_evidence_presentation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(
        plans=[["query one", "query two"]],
        evidence_by_query={"query one": True, "query two": True},
        reflects=[{
            "sufficient": True,
            "missing": "",
            "extra_searches": [],
            "source_presentations": [{
                "url": "https://example.com/1",
                "text": "第一条来源给出了与问题相关的可核验做法。",
            }],
        }],
    )

    _output, events = await run_scenario(monkeypatch, scenario)

    presented = [event for event in events if event["type"] == "tool.presented"]
    presented_urls = {
        source["url"]
        for event in presented
        for source in event["sources"]
    }
    assert presented_urls == {
        "https://example.com/1",
        "https://example.com/2",
    }
    assert scenario.structured_calls["source_curator"] == 1
    curator_prompt = str(
        scenario.structured_messages["source_curator"][0][-1].content
    )
    assert "https://example.com/2" in curator_prompt
    assert "https://example.com/1" not in curator_prompt


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
    output, events = await run_scenario(
        monkeypatch,
        scenario,
        question="在 X/Twitter 搜索 OpenAI 最新帖子",
    )

    assert output["query_channels"] == {"OpenAI 最新帖子": "x"}
    assert output["candidates"][0]["channel"] == "x"
    started = next(event for event in events if event["type"] == "tool.started")
    assert started["channel"] == "x"
    assert scenario.tool_executions == ["OpenAI 最新帖子"]


@pytest.mark.asyncio
async def test_planner_receives_the_current_date_for_relative_time_queries(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(
        plans=[["OpenAI 近 90 天帖子"]],
        evidence_by_query={"OpenAI 近 90 天帖子": True},
    )

    await run_scenario(monkeypatch, scenario)

    planner_prompt = str(scenario.structured_messages["planner"][0][-1].content)
    assert f"当前日期：{datetime.now(UTC).date().isoformat()}" in planner_prompt


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
    output, events = await run_scenario(
        monkeypatch,
        scenario,
        question="只在小红书搜索测试内容",
    )

    assert output["queries"] == []
    assert scenario.tool_executions == []
    assert not any(event["type"] == "tool.started" for event in events)
    rejected = [event for event in events if event["type"] == "plan.rejected"]
    assert rejected
    assert {event["reasonCode"] for event in rejected} == {"PLAN_CHANNEL_NOT_ALLOWED"}


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
async def test_verifier_does_not_apply_candidate_limitations_to_read_evidence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    limitation = "受单轮详情读取上限限制，其他候选正文未读取"
    scenario = Scenario(
        limitations_by_query={"query one": limitation},
        evidence_by_query={"query one": True},
    )

    output, _events = await run_scenario(monkeypatch, scenario)

    assert output["verification_passed"] is True
    verifier_input = str(
        scenario.structured_messages["verifier"][0][-1].content
    )
    assert limitation not in verifier_input
    assert '"evidenceCount": 1' in verifier_input
    assert "URL: https://example.com/1" in verifier_input
    assert "verified evidence for query one" in verifier_input


@pytest.mark.asyncio
async def test_verifier_cannot_pass_when_a_required_channel_has_no_evidence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(
        supervisor_channels=["web", "x"],
        plans=[["query one"]],
        channels_by_query={"query one": "web"},
        evidence_by_query={"query one": True},
        verifier_actions=["pass"],
    )

    output, _events = await run_scenario(
        monkeypatch,
        scenario,
        question="比较官网网页与 X/Twitter 的公开证据",
        max_rounds=1,
    )

    assert output["verification_passed"] is False
    assert output["response_status"] == "partial"
    assert output["stop_reason"] == "MAX_ITERATIONS"
    assert "Evidence：x" in output["verification_issue"]
    verifier_input = str(
        scenario.structured_messages["verifier"][0][-1].content
    )
    assert '"requiredChannels": ["web", "x"]' in verifier_input
    assert '"evidenceChannels": ["web"]' in verifier_input
    assert '"missingChannels": ["x"]' in verifier_input


@pytest.mark.asyncio
async def test_complementary_channel_does_not_replace_required_channel_evidence(
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

    assert output["response_status"] == "partial"
    assert output["verification_passed"] is False
    assert output["stop_reason"] == "MAX_ITERATIONS"
    assert "Evidence：web" in output["verification_issue"]
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


@pytest.mark.asyncio
async def test_planner_approved_arguments_bypass_redundant_researcher_tool_selection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(
        researcher_mode="bad_args",
    )
    output, events = await run_scenario(monkeypatch, scenario)

    assert scenario.researcher_messages == []
    assert scenario.tool_executions == ["query one"]
    assert output["tool_calls"] == 1
    assert not any(
        event.get("reasonCode") in {"INVALID_ARGUMENTS", "UNKNOWN_TOOL"}
        for event in events
    )


@pytest.mark.asyncio
async def test_planned_searches_never_exceed_tool_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(
        plans=[["query one", "query two"]],
        evidence_by_query={"query one": True, "query two": True},
    )
    output, _events = await run_scenario(monkeypatch, scenario, max_tool_calls=1)

    assert output["tool_calls"] == 1
    assert scenario.tool_executions == ["query one"]
    assert output["stop_reason"] == "TOOL_CALL_LIMIT"
    assert len(output["tool_traces"]) == 1


@pytest.mark.asyncio
async def test_model_limit_stops_with_partial_answer_without_overshoot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(
        reflects=[{"sufficient": False, "missing": "budget", "extra_searches": []}],
        evidence_by_query={},
        writer_answer="本次没有取得可核验正文，暂时无法可靠归纳。",
    )
    output, _events = await run_scenario(monkeypatch, scenario, max_model_calls=4)

    assert output["model_calls"] <= 4
    assert output["response_status"] == "partial"
    assert output["stop_reason"] == "MODEL_CALL_LIMIT"
    assert output["answer"] == scenario.writer_answer
    assert output["answer_source"] == "model"
    assert output["answer_model_calls"] == 1
    assert scenario.structured_calls["writer"] == 1


@pytest.mark.asyncio
async def test_tool_timeout_preserves_finalization_instead_of_failing_run(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(
        tool_delay_seconds=0.05,
        progress_before_delay=True,
        evidence_by_query={"query one": False},
    )
    monkeypatch.setattr(nodes, "tool_timeout_seconds", lambda _state, _channel: 0.01)

    output, events = await run_scenario(monkeypatch, scenario)

    assert output["response_status"] == "partial"
    assert output["stop_reason"] == "RUN_TIME_RESERVE"
    assert output["tool_traces"][0]["error_code"] == "RUN_TIME_RESERVE"
    tool_call_id = output["tool_traces"][0]["tool_call_id"]
    tool_events = [
        event for event in events if event.get("toolCallId") == tool_call_id
    ]
    assert [event["type"] for event in tool_events] == [
        "tool.started",
        "tool.progress",
        "tool.failed",
    ]
    assert tool_events[-1]["reasonCode"] == "RUN_TIME_RESERVE"
    assert tool_events[-1]["resultCount"] == 5
    assert tool_events[-1]["evidenceCount"] == 0
    assert tool_events[-1]["durationMs"] >= 0


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
        verifier_actions=["research_more"],
    )
    output, _events = await run_scenario(monkeypatch, scenario, max_rounds=1)
    assert output["response_status"] == "partial"
    assert output["stop_reason"] == "MAX_ITERATIONS"


@pytest.mark.asyncio
async def test_verifier_pass_overrides_soft_search_iteration_stop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(
        reflects=[{
            "sufficient": False,
            "missing": "reflector 仍建议补充，但最终回答已可核验",
            "extra_searches": [{"query": "query two", "channel": "web"}],
        }],
        verifier_actions=["pass"],
    )

    output, _events = await run_scenario(monkeypatch, scenario, max_rounds=1)

    assert output["response_status"] == "completed"
    assert output["verification_passed"] is True
    assert output["stop_reason"] == "VERIFIED"


@pytest.mark.asyncio
async def test_rewrite_can_finish_after_soft_search_iteration_stop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(
        reflects=[{
            "sufficient": False,
            "missing": "只需修正回答措辞",
            "extra_searches": [{"query": "query two", "channel": "web"}],
        }],
        verifier_actions=["rewrite", "pass"],
    )

    output, _events = await run_scenario(monkeypatch, scenario, max_rounds=1)

    assert output["response_status"] == "completed"
    assert output["verification_passed"] is True
    assert output["stop_reason"] == "VERIFIED"
    assert output["repair_count"] == 1


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
    assert all(
        event["publicSummarySource"] == "model"
        for event in completions
        if event.get("publicSummary")
    )
    assert all(
        event["publicSummarySource"] == "model"
        for event in verification_events
        if event.get("publicSummary")
    )
    assert all(
        event["presentationSource"] == "model"
        for event in events
        if event["type"] == "tool.presented"
    )
    assert [event["seq"] for event in events] == list(range(1, len(events) + 1))
    assert len({event["eventId"] for event in events}) == len(events)


@pytest.mark.asyncio
async def test_private_reasoning_never_crosses_state_checkpoint_or_public_events(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = Scenario(include_reasoning=True)
    output, events = await run_scenario(monkeypatch, scenario)
    assert scenario.researcher_messages == []

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
