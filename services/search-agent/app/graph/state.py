"""LangGraph 图状态与节点产出结构。

State 只保存小型结构化数据：意图、计划、候选、证据摘要、预算和思考记录。
网页全文不进 State（放在 evidence 的截断正文里，且有长度上限），
避免 checkpoint 膨胀（项目文档 7.1 节）。

每个模型节点产出一条 `ThinkStep`，其 `summary` 就是最终显示在对话框中的
「思考摘要」——单段、简短、面向用户，不含私有思维链。
"""

from __future__ import annotations

import operator
from datetime import UTC, datetime
from typing import Annotated, Literal, TypedDict

from app.prompts.agents import PROMPT_VERSION
from app.tools.channels.base import ChannelName

# 节点角色，与 llm.deepseek.ModelRole 对应。
NodeName = Literal[
    "load_context",
    "classify_intent",
    "plan_research",
    "research",
    "reflect",
    "compose",
    "verify",
    "finalize",
]


class ThinkStep(TypedDict):
    """一个节点的可审计产出。

    summary 是面向用户的一句话摘要（思考摘要），必须满足契约的
    publicText 规则：单段、1–500 字符、无换行、无 Markdown 结构标记。
    """

    node: NodeName
    kind: Literal["model", "deterministic"]
    summary: str  # 显示在对话框的思考摘要
    detail: str  # 内部细节，可含结构化数据，不发给前端 publicText


class Candidate(TypedDict):
    """搜索发现的候选，未经原文核实。"""

    channel: ChannelName
    tool_call_id: str
    iteration: int
    provider: str
    url: str
    title: str
    snippet: str
    query: str
    author: str | None
    published_at: str | None
    metrics: dict[str, int | float | str]
    limitation: str | None


class Evidence(TypedDict):
    """已读取原文的证据片段。"""

    channel: ChannelName
    tool_call_id: str
    iteration: int
    provider: str
    url: str
    title: str
    text: str  # 已截断的正文
    extractor: str
    query: str
    captured_at: str
    author: str | None
    published_at: str | None
    metrics: dict[str, int | float | str]
    limitation: str | None


class SearchTrace(TypedDict):
    """安全的工具账本；不含原始 Provider body 或模型思维链。"""

    tool_call_id: str
    idempotency_key: str
    query: str
    channel: ChannelName
    provider: str
    status: Literal["completed", "failed", "unknown", "cached"]
    result_count: int
    evidence_count: int
    error_code: str | None
    limitation: str | None


class SearchRequest(TypedDict):
    """Planner、Reflector 与 Verifier 共享的结构化检索请求。"""

    query: str
    channel: ChannelName


class Citation(TypedDict):
    label: str
    url: str


class UsageTotals(TypedDict):
    input_tokens: int
    output_tokens: int
    total_tokens: int
    cost_usd: float


class SearchState(TypedDict, total=False):
    """搜索 Agent 的图状态。"""

    # 输入
    question: str
    run_id: str
    tenant_id: str
    visitor_id: str
    project_id: str | None
    thread_id: str
    model_id: str
    reasoning_effort: str
    conversation_context: str
    started_at: str
    prompt_version: str

    # 各节点产出
    intent: dict  # 意图分类结果
    need_search: bool
    searches: list[SearchRequest]  # 已接受的查询+渠道历史；去重以二者组合为准
    pending_searches: list[SearchRequest]  # 当前轮待执行的结构化查询；完成后清空
    queries: list[str]  # 兼容审计视图；同一查询可因渠道不同重复出现
    query_channels: dict[str, ChannelName]  # 兼容旧 checkpoint；新流程使用 searches
    pending_queries: list[str]  # 兼容旧 checkpoint；新流程使用 pending_searches
    candidates: list[Candidate]  # 搜索候选
    evidence: list[Evidence]  # 已读证据
    tool_traces: list[SearchTrace]
    citations: list[Citation]

    # 思考记录：每个节点 append 一条。用 operator.add 合并。
    steps: Annotated[list[ThinkStep], operator.add]

    # 循环控制
    round: int  # 当前研究轮次
    sufficient: bool  # 证据是否充分
    stop_reason: str | None
    no_progress_count: int
    replan_required: bool
    verification_passed: bool
    verification_action: str
    verification_issue: str
    repair_count: int
    schema_repair_count: int

    # 预算（硬边界，模型不能修改）
    model_calls: int
    max_model_calls: int
    max_rounds: int
    tool_calls: int
    max_tool_calls: int
    max_run_seconds: int
    max_total_tokens: int
    max_cost_usd: float
    no_progress_limit: int
    usage: UsageTotals

    # 最终产出
    answer: str | None
    response_status: Literal["completed", "partial"]


def initial_state(
    question: str,
    *,
    run_id: str = "local-run",
    tenant_id: str = "local",
    visitor_id: str = "local-visitor",
    project_id: str | None = None,
    thread_id: str = "local-thread",
    model_id: str = "",
    reasoning_effort: str = "high",
    conversation_context: str = "",
    depth: str = "balanced",
    max_model_calls: int | None = None,
    max_rounds: int | None = None,
    max_tool_calls: int = 6,
    max_run_seconds: int = 240,
    max_total_tokens: int = 120_000,
    max_cost_usd: float = 0.25,
    no_progress_limit: int = 2,
) -> SearchState:
    """构造初始状态，并按深度设置硬边界。

    预算取自项目文档 13.3 节的循环控制表。
    """
    budgets = {
        "quick": (8, 1),
        "balanced": (16, 2),
        "deep": (32, 3),
    }
    budget_calls, budget_rounds = budgets.get(depth, budgets["balanced"])
    resolved_calls = min(max_model_calls or budget_calls, 32)
    resolved_rounds = min(max_rounds or budget_rounds, 3)
    return SearchState(
        question=question,
        run_id=run_id,
        tenant_id=tenant_id,
        visitor_id=visitor_id,
        project_id=project_id,
        thread_id=thread_id,
        model_id=model_id,
        reasoning_effort=reasoning_effort,
        conversation_context=conversation_context[:20_000],
        started_at=datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        prompt_version=PROMPT_VERSION,
        steps=[],
        round=0,
        sufficient=False,
        stop_reason=None,
        candidates=[],
        evidence=[],
        searches=[],
        pending_searches=[],
        queries=[],
        query_channels={},
        pending_queries=[],
        tool_traces=[],
        citations=[],
        model_calls=0,
        max_model_calls=resolved_calls,
        max_rounds=resolved_rounds,
        tool_calls=0,
        max_tool_calls=min(max_tool_calls, 12),
        max_run_seconds=min(max_run_seconds, 600),
        max_total_tokens=min(max_total_tokens, 500_000),
        max_cost_usd=min(max_cost_usd, 5.0),
        no_progress_limit=min(max(no_progress_limit, 1), 3),
        no_progress_count=0,
        replan_required=False,
        verification_passed=False,
        verification_action="",
        verification_issue="",
        repair_count=0,
        schema_repair_count=0,
        usage=UsageTotals(input_tokens=0, output_tokens=0, total_tokens=0, cost_usd=0.0),
        answer=None,
        response_status="partial",
    )
