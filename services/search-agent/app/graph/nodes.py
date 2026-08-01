"""LangGraph 多 Agent 节点与真实工具闭环。"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import time
from datetime import UTC, datetime
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.config import get_stream_writer
from langgraph.runtime import Runtime

from app.events.runtime import runtime_event, safe_public_text
from app.graph.context import RunContext
from app.graph.plan import (
    PlanValidationError,
    build_plan_snapshot,
    has_todo_steps,
    requests_for_steps,
    settle_running_steps,
    start_ready_steps,
)
from app.graph.schemas import (
    ANSWER_MAX_CHARS,
    ComposeResult,
    IntentResult,
    PlanResult,
    ReflectResult,
    SourcePresentationResult,
    VerifyResult,
)
from app.graph.state import (
    Candidate,
    Citation,
    Evidence,
    SearchRequest,
    SearchState,
    SearchTrace,
    ThinkStep,
)
from app.llm.deepseek import (
    ModelUsage,
    StructuredOutputError,
    add_usage,
    invoke_structured,
)
from app.prompts.agents import (
    DEGRADED_WRITER_PROMPT,
    DIRECT_WRITER_PROMPT,
    PLANNER_PROMPT,
    REFLECTOR_PROMPT,
    SOURCE_CURATOR_PROMPT,
    SUPERVISOR_PROMPT,
    VERIFIER_PROMPT,
    WRITER_PROMPT,
)
from app.tools.channels.base import ChannelProgress, ChannelVerificationUpdate
from app.tools.search_tool import (
    SearchExecutionResult,
    SearchToolInput,
    execute_search_tool,
)

_RESEARCH_CHANNELS = frozenset({"web", "x", "xiaohongshu"})
_FORCED_CHANNEL_PATTERNS = {
    "xiaohongshu": re.compile(r"小红书|xiaohongshu", re.IGNORECASE),
    "x": re.compile(
        r"twitter|(?<![A-Za-z0-9])x(?:\.com\b|(?![A-Za-z0-9]))",
        re.IGNORECASE,
    ),
    "web": re.compile(
        r"官网|网页|网站|(?<![A-Za-z0-9])web(?:site)?(?![A-Za-z0-9])",
        re.IGNORECASE,
    ),
}
_FINALIZATION_RESERVE_SECONDS = 60
_MIN_TOOL_WINDOW_SECONDS = {
    "web": 10,
    "x": 10,
    "xiaohongshu": 45,
}
_INEFFECTIVE_SOURCE_TEXT = re.compile(
    r"(?:(?:正文|内容).{0,4}(?:过短|太短)|"
    r"未(?:成功)?(?:读取|加载|获取|核验|验证)|"
    r"仅(?:发现|检索到).{0,12}(?:候选|索引)|"
    r"(?:正文|帖子|笔记|详情|原文|内容).{0,12}(?:未|没有).{0,6}"
    r"(?:读取|加载|获取|核验|验证)|受.{0,12}(?:读取|详情).{0,8}上限|"
    r"(?:仅|只).{0,12}(?:标题|标签|话题|关键词)|"
    r"(?:未|没有).{0,6}(?:展开|涉及|提及|覆盖|包含|提供).{0,60}"
    r"(?:对比|区别|内容|信息|说明|细节|证据|场景|人群|肤质|使用感受|产品类型|不适|适用)|"
    r"(?:无|没有|缺少).{0,12}(?:有效|实质|相关).{0,8}"
    r"(?:内容|信息|证据|说明))",
)
_INEFFECTIVE_PROCESS_TEXT = re.compile(
    r"(?:渠道降级|"
    r"未(?:成功)?(?:读取|获取|加载).{0,12}(?:正文|内容|详情)|"
    r"(?:正文|详情).{0,12}未(?:读取|获取|加载)|"
    r"仅(?:发现|检索到).{0,12}(?:候选|索引)|"
    r"其余来源.{0,16}未读取|"
    r"登录态|robots?|机器人协议|MCP|验证码|captcha|"
    r"抓取|爬取|内部超时|渠道.{0,12}(?:不可读|受限)|公开索引)",
    re.IGNORECASE,
)


def _step(node: str, kind: str, summary: str | None, detail: str = "") -> list[ThinkStep]:
    # 确定性节点只能记录结构化内部细节，绝不能携带可被误投影为模型公开摘要的文案。
    public_summary = summary if kind == "model" else None
    return [ThinkStep(node=node, kind=kind, summary=public_summary or "", detail=detail)]


def _usage_after(state: SearchState, usage: ModelUsage) -> dict[str, int | float]:
    return add_usage(state.get("usage"), usage)


def _allow_structured_repair(state: SearchState) -> bool:
    return (
        state.get("schema_repair_count", 0) < 1
        and _remaining_model_calls(state) >= 2
    )


def _structured_usage_patch(state: SearchState, usage: ModelUsage) -> dict[str, Any]:
    repairs = max(0, usage.attempts - 1)
    return {
        "model_calls": state.get("model_calls", 0) + usage.attempts,
        "schema_repair_count": state.get("schema_repair_count", 0) + repairs,
        "usage": _usage_after(state, usage),
    }


def _forced_search_channels(question: str) -> list[str]:
    """从用户明确指定的平台词确定只读渠道；未指定时安全回落到 Web。"""

    matches: list[tuple[int, str]] = []
    for channel, pattern in _FORCED_CHANNEL_PATTERNS.items():
        match = pattern.search(question)
        if match:
            matches.append((match.start(), channel))
    if not matches:
        return ["web"]
    return [channel for _position, channel in sorted(matches)]


def _sum_usage(items: list[ModelUsage]) -> ModelUsage:
    return ModelUsage(
        input_tokens=sum(item.input_tokens for item in items),
        output_tokens=sum(item.output_tokens for item in items),
        total_tokens=sum(item.total_tokens for item in items),
        cost_usd=round(sum(item.cost_usd for item in items), 8),
        attempts=sum(item.attempts for item in items),
    )


def budget_reason(state: SearchState, *, reserve_model_calls: int = 0) -> str | None:
    usage = state.get("usage") or {}
    model_calls = state.get("model_calls", 0)
    max_model_calls = state.get("max_model_calls", 16)
    if (
        (reserve_model_calls and model_calls + reserve_model_calls > max_model_calls)
        or (not reserve_model_calls and model_calls >= max_model_calls)
    ):
        return "MODEL_CALL_LIMIT"
    if int(usage.get("total_tokens") or 0) >= state.get("max_total_tokens", 120_000):
        return "TOKEN_LIMIT"
    if float(usage.get("cost_usd") or 0) >= state.get("max_cost_usd", 0.25):
        return "COST_LIMIT"
    started = state.get("started_at")
    if started:
        elapsed = (
            datetime.now(UTC) - datetime.fromisoformat(started)
        ).total_seconds() - float(state.get("external_wait_seconds") or 0.0)
        if elapsed >= state.get("max_run_seconds", 240):
            return "RUN_TIMEOUT"
    return None


def remaining_run_seconds(state: SearchState) -> float | None:
    """返回硬运行预算的剩余秒数，供外部工具调用预留收尾时间。"""

    started = state.get("started_at")
    if not started:
        return None
    elapsed = (
        datetime.now(UTC) - datetime.fromisoformat(started)
    ).total_seconds() - float(state.get("external_wait_seconds") or 0.0)
    return max(0.0, state.get("max_run_seconds", 240) - elapsed)


def tool_timeout_seconds(state: SearchState, channel: str) -> float | None:
    """为一次外部调用划出硬超时，同时保留图的反思、写作和核验时间。"""

    remaining = remaining_run_seconds(state)
    if remaining is None:
        return None
    available = max(0.0, remaining - _FINALIZATION_RESERVE_SECONDS)
    minimum = _MIN_TOOL_WINDOW_SECONDS.get(channel, 10)
    return available if available >= minimum else 0.0


def _remaining_model_calls(state: SearchState) -> int:
    return max(0, state.get("max_model_calls", 16) - state.get("model_calls", 0))


def _projected_budget_reason(state: SearchState, usages: list[ModelUsage]) -> str | None:
    projected = dict(state)
    combined = _sum_usage(usages)
    projected["model_calls"] = state.get("model_calls", 0) + len(usages)
    projected["usage"] = _usage_after(state, combined)
    return budget_reason(projected)


_COMPLETE_ANSWER_BOUNDARY = re.compile(
    r"(?:\n+(?=\S)|"
    r"[。！？!?；;](?:[”’」』）】])?(?:\s*\[来源\d+\])*(?=\s|$)|"
    r"(?:\[来源\d+\])+(?=\s|$))"
)
_TRAILING_MARKDOWN_HEADING = re.compile(r"^\s{0,3}#{1,6}\s+\S")
_DANGLING_LIST_MARKER = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s*$")
_CITATION_REFERENCE = re.compile(r"\[来源(\d+)\]")
_EXPLICIT_OUTPUT_FIELDS = re.compile(
    r"按\s*[“\"「『]([^\r\n”\"」』]{3,240})[”\"」』]",
)
_REQUESTED_ITEM_RANGE = re.compile(
    r"(?<!\d)(\d{1,2})\s*[–—－~～-]\s*(\d{1,2})\s*条",
)
_REQUESTED_ITEM_COUNT = re.compile(r"(?<![\d–—－~～-])(\d{1,2})\s*条")
_NUMBERED_ANSWER_ITEM = re.compile(r"(?m)^\s*\d{1,2}[.)、]\s+")
_NON_MEDICAL_REQUEST = re.compile(
    r"(?:不得|不要|不能).{0,20}(?:个人体验|使用体验|体验).{0,20}医疗建议|"
    r"(?:不得|不要|不能).{0,20}医疗建议",
)
_NON_MEDICAL_DISCLAIMER = re.compile(r"不构成医疗建议|非医疗建议")
_CONFLICTING_EVIDENCE_GAP = re.compile(r"冲突|矛盾|不一致|相反")


def _clean_answer_prefix(value: str) -> str:
    """移除边界压缩后可能留下的空标题、列表标记或未闭合代码块。"""

    candidate = value.rstrip()
    if candidate.count("```") % 2:
        candidate = candidate[: candidate.rfind("```")].rstrip()
    lines = candidate.splitlines()
    while lines and (
        _TRAILING_MARKDOWN_HEADING.match(lines[-1])
        or _DANGLING_LIST_MARKER.match(lines[-1])
    ):
        lines.pop()
        while lines and not lines[-1].strip():
            lines.pop()
    return "\n".join(lines).rstrip()


def _compact_answer_markdown(
    value: str,
    max_chars: int = ANSWER_MAX_CHARS,
) -> str:
    """在完整句子或 Markdown 行边界内压缩回答，避免截断引用。"""

    answer = value.strip()
    if len(answer) <= max_chars:
        return answer

    window = answer[:max_chars]
    minimum_useful_chars = min(max_chars, max(80, int(max_chars * 0.45)))
    boundaries = [
        match.end()
        for match in _COMPLETE_ANSWER_BOUNDARY.finditer(window)
        if match.end() <= max_chars
    ]
    for boundary in reversed(boundaries):
        candidate = _clean_answer_prefix(answer[:boundary])
        if len(candidate) >= minimum_useful_chars:
            return candidate

    # 极端无标点长段落仍需受控交付；优先回退到空白边界，并避免留下半个引用。
    candidate = window.rstrip()
    whitespace = max(candidate.rfind(" "), candidate.rfind("\n"), candidate.rfind("\t"))
    if whitespace >= minimum_useful_chars:
        candidate = candidate[:whitespace].rstrip()
    if candidate.rfind("[") > candidate.rfind("]"):
        candidate = candidate[: candidate.rfind("[")].rstrip()
    candidate = _clean_answer_prefix(candidate).rstrip("*_`#- ")
    if not re.search(r"[。！？!?；;\]]$", candidate):
        candidate = f"{candidate[: max(0, max_chars - 1)].rstrip()}。"
    return candidate[:max_chars]


def _answer_citations(
    answer: str,
    evidence: list[Evidence],
) -> tuple[str, list[Citation]]:
    """只发布回答实际引用的来源，并把稀疏编号归一为连续编号。"""

    referenced = list(dict.fromkeys(
        int(match.group(1))
        for match in _CITATION_REFERENCE.finditer(answer)
    ))
    if not referenced:
        citations: list[Citation] = []
        seen: set[str] = set()
        for item in evidence:
            if item["url"] in seen:
                continue
            seen.add(item["url"])
            citations.append(Citation(label=item["title"][:160], url=item["url"]))
        return answer, citations

    original_to_normalized: dict[int, int] = {}
    url_to_normalized: dict[str, int] = {}
    citations = []
    for original in referenced:
        index = original - 1
        if index < 0 or index >= len(evidence):
            continue
        item = evidence[index]
        normalized = url_to_normalized.get(item["url"])
        if normalized is None:
            normalized = len(citations) + 1
            url_to_normalized[item["url"]] = normalized
            citations.append(Citation(label=item["title"][:160], url=item["url"]))
        original_to_normalized[original] = normalized

    normalized_answer = _CITATION_REFERENCE.sub(
        lambda match: (
            f"[来源{original_to_normalized[int(match.group(1))]}]"
            if int(match.group(1)) in original_to_normalized
            else match.group(0)
        ),
        answer,
    )
    return normalized_answer, citations


def _freshness_required(question: str) -> bool:
    return bool(
        re.search(
            r"最新|当前|现在|今天|实时|版本|价格|新闻|搜索|查找|检索|来源|链接|官网|官方|"
            r"latest|current|today|recent|price|news|search|source|official|202[4-9]",
            question,
            re.IGNORECASE,
        )
    )


def _safe_error_code(exc: BaseException) -> str:
    name = type(exc).__name__
    return re.sub(r"[^A-Z0-9_]", "_", re.sub(r"(?<!^)(?=[A-Z])", "_", name).upper())[:80]


def _normalize_query(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()[:300]


def _explicit_output_contract(
    question: str,
) -> tuple[int | None, int | None, list[str]] | None:
    """提取用户明确给出的条目数量与斜杠分隔字段。"""

    field_match = _EXPLICIT_OUTPUT_FIELDS.search(question)
    fields: list[str] = []
    if field_match:
        fields = [
            re.sub(r"\s+", " ", value).strip(" *`：:")
            for value in re.split(r"\s*[/／]\s*", field_match.group(1))
        ]
        fields = [value for value in fields if value]
        if len(fields) < 2 or len(fields) > 8 or any(len(value) > 40 for value in fields):
            fields = []

    minimum: int | None = None
    maximum: int | None = None
    range_match = _REQUESTED_ITEM_RANGE.search(question)
    if range_match:
        minimum = int(range_match.group(1))
        maximum = int(range_match.group(2))
        if minimum < 1 or maximum < minimum or maximum > 10:
            minimum = maximum = None
    else:
        count_match = _REQUESTED_ITEM_COUNT.search(question)
        if count_match:
            requested = int(count_match.group(1))
            if 1 <= requested <= 10:
                minimum = maximum = requested

    if not fields and minimum is None:
        return None
    return minimum, maximum, fields


def _explicit_output_instruction(question: str) -> str | None:
    """把自然语言格式要求变成 Writer 可逐项核对的短模板。"""

    contract = _explicit_output_contract(question)
    requires_non_medical = bool(_NON_MEDICAL_REQUEST.search(question))
    if not contract and not requires_non_medical:
        return None
    minimum, maximum, fields = contract or (None, None, [])
    lines = ["输出格式硬约束："]
    if minimum is not None and maximum is not None:
        selected = 3 if minimum <= 3 <= maximum else minimum
        lines.append(
            f"- 输出 {selected} 个编号一级列表项（用户允许范围为 {minimum}–{maximum} 条）。"
        )
    if fields:
        lines.append("- 每个编号项代表一条完整经验；禁止把不同字段拆成不同编号项。")
        lines.append("- 每个编号项都必须按以下顺序逐行包含这些字面字段：")
        for field in fields:
            value = "[来源N]" if field == "来源链接" else "该条经验的证据化内容"
            lines.append(f"  {field}：{value}")
        lines.append("- 每条控制在约 180 个 Unicode 字符内，总回答不超过 680 字。")
    if requires_non_medical:
        lines.append("- 末尾必须保留一句：以上为个人使用体验，非医疗建议。")
    return "\n".join(lines)


def _explicit_output_issue(question: str, answer: str) -> str | None:
    """确定性检查显式格式契约，防止 Verifier 随机漏判。"""

    contract = _explicit_output_contract(question)
    requires_non_medical = bool(_NON_MEDICAL_REQUEST.search(question))
    if not contract and not requires_non_medical:
        return None
    minimum, maximum, fields = contract or (None, None, [])
    markers = list(_NUMBERED_ANSWER_ITEM.finditer(answer))
    blocks = [
        answer[marker.end() : markers[index + 1].start() if index + 1 < len(markers) else len(answer)]
        for index, marker in enumerate(markers)
    ]
    problems: list[str] = []
    if minimum is not None and maximum is not None and not minimum <= len(blocks) <= maximum:
        problems.append(f"编号条目必须为 {minimum}–{maximum} 条，当前为 {len(blocks)} 条")
    if fields:
        invalid_blocks = 0
        missing_citations = 0
        for block in blocks:
            positions = [block.find(field) for field in fields]
            if any(position < 0 for position in positions) or positions != sorted(positions):
                invalid_blocks += 1
                continue
            if "来源链接" in fields:
                source_position = positions[fields.index("来源链接")]
                if not _CITATION_REFERENCE.search(block[source_position:]):
                    missing_citations += 1
        if not blocks or invalid_blocks:
            problems.append(
                "每个编号条目都必须按顺序包含“" + " / ".join(fields) + "”"
            )
        if missing_citations:
            problems.append("每条“来源链接”后都必须使用真实 [来源N] 引用")
    if requires_non_medical and not _NON_MEDICAL_DISCLAIMER.search(answer):
        problems.append("末尾必须明确说明个人体验不构成医疗建议")
    if not problems:
        return None
    return "输出格式不符合用户要求：" + "；".join(problems)


def _presented_sources_satisfy_contract(
    question: str,
    current_evidence: list[Evidence],
    presented_urls: set[str],
    required_channels: list[str],
    missing: str,
) -> bool:
    """已展示正文达到用户条目下限时，避免同义补搜触发平台风控。"""

    contract = _explicit_output_contract(question)
    if not contract or contract[0] is None or _CONFLICTING_EVIDENCE_GAP.search(missing):
        return False
    minimum = contract[0]
    required = set(required_channels)
    eligible = [
        item
        for item in current_evidence
        if item["url"] in presented_urls and item["channel"] in required
    ]
    covered = {item["channel"] for item in eligible}
    return len({item["url"] for item in eligible}) >= minimum and required <= covered


def _search_key(query: str, channel: str) -> tuple[str, str]:
    return _normalize_query(query).casefold(), channel


def _state_searches(state: SearchState) -> list[SearchRequest]:
    searches: list[SearchRequest] = []
    for item in state.get("searches") or []:
        query = _normalize_query(str(item.get("query") or ""))
        channel = str(item.get("channel") or "")
        if query and channel in _RESEARCH_CHANNELS:
            request = SearchRequest(query=query, channel=channel)
            step_id = str(item.get("step_id") or "")
            if step_id:
                request["step_id"] = step_id
            searches.append(request)
    if searches:
        return searches

    # 兼容升级前的内存 checkpoint；新运行始终使用 searches。
    query_channels = state.get("query_channels") or {}
    for query_value in state.get("queries") or []:
        query = _normalize_query(query_value)
        channel = str(query_channels.get(query) or "")
        if query and channel in _RESEARCH_CHANNELS:
            searches.append(SearchRequest(query=query, channel=channel))
    return searches


def _pending_searches(state: SearchState) -> list[SearchRequest]:
    pending: list[SearchRequest] = []
    for item in state.get("pending_searches") or []:
        query = _normalize_query(str(item.get("query") or ""))
        channel = str(item.get("channel") or "")
        if query and channel in _RESEARCH_CHANNELS:
            request = SearchRequest(query=query, channel=channel)
            step_id = str(item.get("step_id") or "")
            if step_id:
                request["step_id"] = step_id
            pending.append(request)
    if pending:
        return pending

    query_channels = state.get("query_channels") or {}
    for query_value in state.get("pending_queries") or []:
        query = _normalize_query(query_value)
        channel = str(query_channels.get(query) or "")
        if query and channel in _RESEARCH_CHANNELS:
            pending.append(SearchRequest(query=query, channel=channel))
    return pending


def _tool_feedback(state: SearchState) -> list[dict[str, Any]]:
    return [
        {
            "query": item["query"],
            "channel": item["channel"],
            "status": item.get("outcome_status", "failed"),
            "primaryProvider": item.get("primary_provider", item["provider"]),
            "effectiveProvider": item.get("effective_provider", item["provider"]),
            "resultCount": item["result_count"],
            "evidenceCount": item["evidence_count"],
            "errorCode": item.get("error_code"),
            "retryable": item.get("retryable", False),
            "nextAction": item.get("next_action", "none"),
            "limitation": item.get("limitation"),
        }
        for item in (state.get("tool_traces") or [])[-12:]
    ]


def _verification_tool_feedback(state: SearchState) -> list[dict[str, Any]]:
    """核验只接收调用级计数，避免把未读候选限制误套到已读 Evidence。"""

    return [
        {
            "query": item["query"],
            "channel": item["channel"],
            "status": item.get("outcome_status", "failed"),
            "resultCount": item["result_count"],
            "evidenceCount": item["evidence_count"],
            "errorCode": item.get("error_code"),
        }
        for item in (state.get("tool_traces") or [])[-12:]
    ]


def _verification_channel_coverage(
    state: SearchState,
) -> tuple[list[str], list[str], list[str]]:
    """返回 Supervisor 要求、Evidence 已覆盖和仍缺失的渠道。"""

    required: list[str] = []
    for value in (state.get("intent") or {}).get("channels") or ["web"]:
        channel = str(value)
        if channel in _RESEARCH_CHANNELS and channel not in required:
            required.append(channel)

    covered: list[str] = []
    for item in state.get("evidence") or []:
        channel = str(item.get("channel") or "")
        if channel in _RESEARCH_CHANNELS and channel not in covered:
            covered.append(channel)

    covered_set = set(covered)
    missing = [channel for channel in required if channel not in covered_set]
    return required, covered, missing


def _fresh_follow_up_searches(
    state: SearchState, items: list[Any]
) -> list[SearchRequest]:
    seen = {
        _search_key(item["query"], item["channel"]) for item in _state_searches(state)
    }
    fresh: list[SearchRequest] = []
    for item in items:
        query = _normalize_query(item.query)
        channel = item.channel
        key = _search_key(query, channel)
        if not query or channel not in _RESEARCH_CHANNELS or key in seen:
            continue
        seen.add(key)
        fresh.append(SearchRequest(query=query, channel=channel))
    return fresh


def _result_limitation(result: SearchExecutionResult) -> str | None:
    values: list[str] = []
    if result.error_message:
        values.append(result.error_message)
    for item in [*result.results, *result.evidence]:
        if item.limitation and item.limitation not in values:
            values.append(item.limitation)
    if result.ok and not result.results and not values:
        values.append("未找到公开候选")
    elif result.ok and result.results and not result.evidence and not values:
        values.append("仅发现公开候选，未读取到可核验正文")
    return safe_public_text("；".join(values), max_chars=500)


def _effective_source_text(value: str | None) -> str | None:
    text = safe_public_text(value, max_chars=180)
    if not text or _INEFFECTIVE_SOURCE_TEXT.search(text):
        return None
    return text


def _effective_process_text(value: str | None) -> str | None:
    """只透传 Agent 的有用公开摘要；不以本地模板替代被拒绝内容。"""

    text = safe_public_text(value, max_chars=80)
    if not text or _INEFFECTIVE_PROCESS_TEXT.search(text):
        return None
    return text


def _group_source_presentations(
    presentations: list[Any],
    current_evidence: list[Evidence],
) -> dict[str, list[dict[str, str]]]:
    evidence_by_url = {item["url"]: item for item in current_evidence}
    by_call: dict[str, list[dict[str, str]]] = {}
    seen: set[str] = set()
    for presentation in presentations:
        if not presentation.include_in_details:
            continue
        evidence_item = evidence_by_url.get(presentation.url)
        public_text = _effective_source_text(presentation.text)
        if not evidence_item or not public_text or presentation.url in seen:
            continue
        seen.add(presentation.url)
        by_call.setdefault(evidence_item["tool_call_id"], []).append({
            "url": presentation.url,
            "text": public_text,
        })
    return by_call


async def load_context(state: SearchState, runtime: Runtime[RunContext]) -> dict[str, Any]:
    question = (state.get("question") or "").strip()
    context = (state.get("conversation_context") or "")[:20_000]
    writer = get_stream_writer()
    recalled = 0
    project_id = state.get("project_id")
    if runtime.context.milvus and project_id:
        health = runtime.context.milvus.health
        if not health.enabled or not health.available:
            writer(runtime_event(
                "memory.status",
                status="degraded",
                reasonCode="MEMORY_DISABLED" if not health.enabled else "MEMORY_UNAVAILABLE",
            ))
        else:
            try:
                memories = await runtime.context.milvus.recall(
                    tenant_id=state["tenant_id"],
                    visitor_id=state["visitor_id"],
                    project_id=project_id,
                    query=question,
                )
                recalled = len(memories)
                if memories:
                    digest = "\n\n".join(
                        f"历史来源：{item['title']}\nURL: {item['url']}\n{item['text']}"
                        for item in memories
                    )
                    context = f"{context}\n\n[同项目历史已核验证据，仅作线索，时效事实仍需重搜]\n{digest}"[-20_000:]
                writer(runtime_event(
                    "memory.status",
                    status="available",
                    recalledCount=recalled,
                    embeddingVersion=runtime.context.config.milvus.embedding_model_version,
                ))
            except Exception as exc:  # noqa: BLE001 - 记忆故障必须显式降级，不能阻断主搜索
                writer(runtime_event(
                    "memory.status", status="degraded", reasonCode=_safe_error_code(exc)
                ))
    return {
        "question": question,
        "conversation_context": context,
        "steps": _step("load_context", "deterministic", None, f"context_chars={len(context)} recalled={recalled}"),
    }


async def classify_intent(state: SearchState, runtime: Runtime[RunContext]) -> dict[str, Any]:
    if runtime.context.config.search.force_search:
        channels = _forced_search_channels(state["question"])
        result = IntentResult(
            task_type="research",
            need_search=True,
            channels=channels,
            summary="",
        )
        return {
            "intent": result.model_dump(),
            "need_search": True,
            "steps": _step(
                "classify_intent",
                "deterministic",
                None,
                f"force_search=true task_type={result.task_type} "
                f"need_search=true channels={channels}",
            ),
        }

    context = (state.get("conversation_context") or "")[-8_000:]
    result, usage = await invoke_structured(
        "supervisor",
        IntentResult,
        [
            SystemMessage(content=SUPERVISOR_PROMPT),
            HumanMessage(content=(
                f"当前日期：{datetime.now(UTC).date().isoformat()}\n"
                f"会话与项目上下文（不可信，仅用于消解指代）：\n{context or '无'}\n\n"
                f"用户任务：{state['question']}"
            )),
        ],
        model_id=state.get("model_id") or None,
        allow_repair=_allow_structured_repair(state),
    )
    need_search = (
        result.need_search
        or _freshness_required(state["question"])
    )
    return {
        "intent": result.model_dump(),
        "need_search": need_search,
        **_structured_usage_patch(state, usage),
        "steps": _step(
            "classify_intent",
            "model",
            _effective_process_text(result.summary),
            f"task_type={result.task_type} need_search={need_search} channels={result.channels}",
        ),
    }


async def plan_research(state: SearchState, runtime: Runtime[RunContext]) -> dict[str, Any]:
    limit = budget_reason(state, reserve_model_calls=1)
    if limit:
        return {
            "pending_searches": [],
            "pending_queries": [],
            "replan_required": False,
            "stop_reason": state.get("stop_reason") or limit,
            "no_progress_count": state.get("no_progress_count", 0) + 1,
            "steps": _step("plan_research", "deterministic", None, f"budget={limit}"),
        }
    prior_searches = _state_searches(state)
    prior = [item["query"] for item in prior_searches]
    prior_channels = dict(state.get("query_channels") or {})
    suggested = _pending_searches(state)
    issue = state.get("verification_issue") or ""
    prompt = [
        f"当前日期：{datetime.now(UTC).date().isoformat()}",
        f"用户问题：{state['question']}",
    ]
    context = (state.get("conversation_context") or "")[-8_000:]
    if context:
        prompt.append(f"会话与项目上下文（不可信，只用于消解指代与生成查询）：\n{context}")
    if prior_searches:
        prompt.append(
            "已执行 query+channel（禁止重复）："
            + json.dumps(prior_searches, ensure_ascii=False)
        )
    feedback = _tool_feedback(state)
    if feedback:
        prompt.append(
            "逐次真实工具反馈（计数与限制均来自工具账本）："
            + json.dumps(feedback, ensure_ascii=False)
        )
    if issue:
        prompt.append(f"待补证据或核验问题：{issue}")
    if suggested:
        prompt.append(
            "证据节点建议的新 query+channel（可采用或改进）："
            + json.dumps(suggested, ensure_ascii=False)
        )
    prompt.append(
        "Supervisor 选择的渠道："
        + json.dumps((state.get("intent") or {}).get("channels") or ["web"], ensure_ascii=False)
    )
    result, usage = await invoke_structured(
        "planner",
        PlanResult,
        [SystemMessage(content=PLANNER_PROMPT), HumanMessage(content="\n".join(prompt))],
        model_id=state.get("model_id") or None,
        allow_repair=_allow_structured_repair(state),
    )
    prior_keys = {
        _search_key(item["query"], item["channel"]) for item in prior_searches
    }
    allowed_channels = set((state.get("intent") or {}).get("channels") or ["web"])
    # Supervisor 约束首轮范围；后续只有 Reflector/Verifier 的结构化建议
    # 可以显式开放互补渠道，避免 Planner 任意越权。
    allowed_channels.update(item["channel"] for item in suggested)
    iteration = state.get("round", 0) + 1
    revision = state.get("plan_revision", 0) + 1
    try:
        plan = build_plan_snapshot(
            run_id=state["run_id"],
            iteration=iteration,
            revision=revision,
            created_at=datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            planned_steps=result.steps,
            allowed_channels=allowed_channels,
            prior_search_keys=prior_keys,
        )
    except PlanValidationError as exc:
        return {
            "pending_searches": [],
            "pending_queries": [],
            "pending_plan_step_ids": [],
            "plan_ready": False,
            "plan_error_code": exc.code,
            "round": iteration,
            "no_progress_count": state.get("no_progress_count", 0) + 1,
            "replan_required": False,
            **_structured_usage_patch(state, usage),
            "steps": _step(
                "plan_research",
                "deterministic",
                None,
                f"rejected={exc.code}",
            ),
        }
    fresh_searches = requests_for_steps(plan["steps"])
    audit_searches = [
        SearchRequest(query=item["query"], channel=item["channel"])
        for item in fresh_searches
    ]
    fresh_channels = {
        item["query"]: item["channel"] for item in fresh_searches
    }
    fresh = [item["query"] for item in fresh_searches]
    history = list(state.get("plan_history") or [])
    current_plan = state.get("plan")
    if current_plan and (
        not history or history[-1]["plan_id"] != current_plan["plan_id"]
    ):
        history.append(current_plan)
    return {
        "searches": prior_searches + audit_searches,
        "pending_searches": [],
        "queries": prior + fresh,
        "query_channels": {**prior_channels, **fresh_channels},
        "pending_queries": [],
        "plan": plan,
        "plan_history": history,
        "plan_revision": revision,
        "plan_ready": True,
        "plan_error_code": None,
        "pending_plan_step_ids": [],
        "round": iteration,
        "no_progress_count": 0,
        "replan_required": False,
        **_structured_usage_patch(state, usage),
        "steps": _step(
            "plan_research",
            "model",
            _effective_process_text(result.summary),
            f"new_searches={len(fresh_searches)}",
        ),
    }


async def mark_plan_running(
    state: SearchState,
    runtime: Runtime[RunContext],
) -> dict[str, Any]:
    """在执行工具前提交可恢复的 running 计划快照。"""

    del runtime
    plan = state.get("plan")
    if not plan:
        return {
            "pending_searches": [],
            "pending_queries": [],
            "pending_plan_step_ids": [],
            "stop_reason": state.get("stop_reason") or "PLAN_MISSING",
            "steps": _step("mark_plan_running", "deterministic", None, "plan_missing"),
        }
    revision = state.get("plan_revision", plan["revision"]) + 1
    next_plan, selected = start_ready_steps(plan, revision=revision)
    pending = requests_for_steps(selected)
    patch: dict[str, Any] = {
        "plan": next_plan,
        "plan_revision": next_plan["revision"],
        "pending_plan_step_ids": [step["step_id"] for step in selected],
        "pending_searches": pending,
        "pending_queries": [item["query"] for item in pending],
        "replan_required": False,
        "plan_ready": False,
        "steps": _step(
            "mark_plan_running",
            "deterministic",
            None,
            f"running_steps={len(selected)}",
        ),
    }
    if not selected:
        patch["stop_reason"] = state.get("stop_reason") or "PLAN_NO_RUNNABLE_STEP"
        patch["no_progress_count"] = state.get("no_progress_count", 0) + 1
    return patch


def _idempotency_key(state: SearchState, arguments: SearchToolInput) -> tuple[str, str]:
    canonical = arguments.model_dump_json()
    input_hash = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    material = (
        f"{state['run_id']}|web_search|{arguments.channel}|"
        f"{arguments.query.casefold().strip()}|{arguments.max_results}"
    )
    return hashlib.sha256(material.encode("utf-8")).hexdigest(), input_hash


async def _run_one_search(
    state: SearchState,
    runtime: Runtime[RunContext],
    tool_call_id: str,
    arguments: SearchToolInput,
    *,
    plan_step_id: str | None = None,
    timeout_seconds: float | None = None,
    xiaohongshu_public_only: bool = False,
) -> tuple[SearchExecutionResult, SearchTrace]:
    writer = get_stream_writer()
    started = time.perf_counter()
    progress_emitted = False
    observed_result_count = 0
    observed_evidence_count = 0
    announced_verifications: set[str] = set()
    tool_ref = {"planStepId": plan_step_id} if plan_step_id else {}

    def stream_progress(update: ChannelProgress) -> None:
        nonlocal observed_evidence_count, observed_result_count, progress_emitted
        progress_emitted = True
        observed_result_count = max(observed_result_count, update.result_count)
        observed_evidence_count = max(observed_evidence_count, update.evidence_count)
        writer(runtime_event(
            "tool.progress",
            toolCallId=tool_call_id,
            **tool_ref,
            toolName="web_search",
            query=arguments.query,
            channel=arguments.channel,
            provider=update.provider,
            resultCount=update.result_count,
            evidenceCount=update.evidence_count,
            source=update.source.model_dump(mode="json") if update.source else None,
        ))

    def stream_verification(update: ChannelVerificationUpdate) -> None:
        registry = runtime.context.xiaohongshu_verifications
        if registry is None:
            raise RuntimeError("xiaohongshu verification registry unavailable")
        registry.bind(
            run_id=state["run_id"],
            tool_call_id=tool_call_id,
            challenge_id=update.challenge_id,
            expires_at=update.expires_at,
        )
        if update.status == "pending":
            event_type = (
                "tool.verification.heartbeat"
                if update.challenge_id in announced_verifications
                else "tool.verification.required"
            )
            announced_verifications.add(update.challenge_id)
        else:
            event_type = "tool.verification.resolved"
        writer(runtime_event(
            event_type,
            toolCallId=tool_call_id,
            **tool_ref,
            challengeId=update.challenge_id,
            status=update.status,
            expiresAt=update.expires_at,
            retryAfterMs=update.retry_after_ms,
            reasonCode=update.reason_code,
            message=update.message,
        ))

    idempotency_key, input_hash = _idempotency_key(state, arguments)
    writer(runtime_event(
        "tool.started",
        toolCallId=tool_call_id,
        **tool_ref,
        toolName="web_search",
        query=arguments.query,
        channel=arguments.channel,
        cached=False,
    ))

    begin_task = asyncio.create_task(runtime.context.ledger.begin(
            idempotency_key=idempotency_key,
            run_id=state["run_id"],
            tool_call_id=tool_call_id,
            visitor_id=state["visitor_id"],
            project_id=state.get("project_id"),
            input_hash=input_hash,
        ))
    try:
        decision = await asyncio.shield(begin_task)
    except asyncio.CancelledError:
        await asyncio.shield(asyncio.gather(begin_task, return_exceptions=True))
        try:
            await asyncio.shield(
                runtime.context.ledger.unknown(idempotency_key, "CANCELLED_OUTCOME_UNKNOWN")
            )
        except Exception:  # noqa: BLE001 - stop endpoint 仍会按 run_id 再次结算
            writer(runtime_event(
                "tool.unknown",
                toolCallId=tool_call_id,
                **tool_ref,
                toolName="web_search",
                query=arguments.query,
                channel=arguments.channel,
                reasonCode="LEDGER_SETTLEMENT_UNKNOWN",
            ))
        raise
    except Exception:  # noqa: BLE001 - 无账本时禁止盲目执行外部调用
        result = SearchExecutionResult(
            ok=False,
            channel=arguments.channel,
            query=arguments.query,
            provider="unknown",
            results=[],
            evidence=[],
            error_code="LEDGER_UNAVAILABLE",
            error_message="工具幂等账本不可用，已停止外部调用",
        )
        writer(runtime_event(
            "tool.unknown",
            toolCallId=tool_call_id,
            **tool_ref,
            toolName="web_search",
            query=arguments.query,
            channel=arguments.channel,
            reasonCode="LEDGER_UNAVAILABLE",
        ))
        return result, SearchTrace(
            tool_call_id=tool_call_id,
            **({"plan_step_id": plan_step_id} if plan_step_id else {}),
            idempotency_key=idempotency_key,
            query=arguments.query,
            channel=arguments.channel,
            provider="unknown",
            status="unknown",
            outcome_status="failed",
            primary_provider="unknown",
            effective_provider="unknown",
            result_count=0,
            evidence_count=0,
            error_code="LEDGER_UNAVAILABLE",
            retryable=False,
            next_action="stop",
            limitation="工具幂等账本不可用，已停止外部调用",
        )

    if decision.action == "unknown":
        result = SearchExecutionResult(
            ok=False,
            channel=arguments.channel,
            query=arguments.query,
            provider="unknown",
            results=[],
            evidence=[],
            error_code=decision.error_code or "OUTCOME_UNKNOWN",
            error_message="上次搜索结果未知，已停止自动重试",
        )
        writer(runtime_event(
            "tool.unknown",
            toolCallId=tool_call_id,
            **tool_ref,
            toolName="web_search",
            query=arguments.query,
            channel=arguments.channel,
            reasonCode=result.error_code,
        ))
        status = "unknown"
    elif decision.action == "cached":
        if not decision.result:
            result = SearchExecutionResult(
                ok=False,
                channel=arguments.channel,
                query=arguments.query,
                provider="unknown",
                results=[],
                evidence=[],
                error_code="CACHED_RESULT_MISSING",
                error_message="幂等账本缺少已结算结果，已停止自动重试",
            )
            writer(runtime_event(
                "tool.unknown",
                toolCallId=tool_call_id,
                **tool_ref,
                toolName="web_search",
                query=arguments.query,
                channel=arguments.channel,
                reasonCode="CACHED_RESULT_MISSING",
            ))
            status = "unknown"
        else:
            result = SearchExecutionResult.model_validate(decision.result)
            status = "cached" if result.ok else "failed"
    else:
        try:
            verification_enabled = (
                arguments.channel == "xiaohongshu"
                and not xiaohongshu_public_only
                and runtime.context.xiaohongshu_verifications is not None
            )
            execution_options: dict[str, Any] = (
                {"xiaohongshu_public_only": True}
                if xiaohongshu_public_only
                else {}
            )
            if verification_enabled:
                execution_options.update({
                    "verification_request_key": (
                        f"{state['run_id']}:{tool_call_id}"
                    ),
                    "verification": stream_verification,
                })
            if timeout_seconds is None:
                result = await execute_search_tool(
                    arguments,
                    runtime.context.config,
                    progress=stream_progress,
                    **execution_options,
                )
            else:
                verification_grace = (
                    runtime.context.config.search.channels.xiaohongshu.verification_timeout_ms
                    / 1000
                    if verification_enabled
                    else 0.0
                )
                async with asyncio.timeout(
                    max(
                        0.001,
                        timeout_seconds
                        + (verification_grace + 10 if verification_enabled else 0),
                    )
                ):
                    result = await execute_search_tool(
                        arguments,
                        runtime.context.config,
                        progress=stream_progress,
                        **execution_options,
                    )
        except TimeoutError:
            code = "RUN_TIME_RESERVE"
            result = SearchExecutionResult(
                ok=False,
                channel=arguments.channel,
                query=arguments.query,
                provider="unknown",
                results=[],
                evidence=[],
                error_code=code,
                error_message="搜索调用已停止，以保留反思、写作和核验时间",
            )
            try:
                await runtime.context.ledger.fail(
                    idempotency_key,
                    result.public_dict(),
                    code,
                )
                status = "failed"
            except Exception:  # noqa: BLE001 - 无法确认结算持久化结果
                result = SearchExecutionResult(
                    ok=False,
                    channel=arguments.channel,
                    query=arguments.query,
                    provider="unknown",
                    results=[],
                    evidence=[],
                    error_code="LEDGER_SETTLEMENT_UNKNOWN",
                    error_message="限时停止搜索后，幂等账本结算结果未知",
                )
                writer(runtime_event(
                    "tool.unknown",
                    toolCallId=tool_call_id,
                    **tool_ref,
                    toolName="web_search",
                    query=arguments.query,
                    channel=arguments.channel,
                    reasonCode="LEDGER_SETTLEMENT_UNKNOWN",
                ))
                status = "unknown"
        except asyncio.CancelledError:
            try:
                await runtime.context.ledger.unknown(idempotency_key, "CANCELLED_OUTCOME_UNKNOWN")
            except Exception:  # noqa: BLE001 - stop endpoint 仍会按 run_id 再次结算 unknown
                writer(runtime_event(
                    "tool.unknown",
                    toolCallId=tool_call_id,
                    **tool_ref,
                    toolName="web_search",
                    query=arguments.query,
                    channel=arguments.channel,
                    reasonCode="LEDGER_SETTLEMENT_UNKNOWN",
                ))
            raise
        except Exception as exc:  # noqa: BLE001 - 转换为稳定、可恢复工具错误
            code = _safe_error_code(exc)
            result = SearchExecutionResult(
                ok=False,
                channel=arguments.channel,
                query=arguments.query,
                provider="unknown",
                results=[],
                evidence=[],
                error_code=code,
                error_message="搜索工具未能完成",
            )
            try:
                await runtime.context.ledger.fail(idempotency_key, result.public_dict(), code)
                status = "failed"
            except Exception:  # noqa: BLE001 - 无法确认结算持久化结果
                result = SearchExecutionResult(
                    ok=False,
                    channel=arguments.channel,
                    query=arguments.query,
                    provider="unknown",
                    results=[],
                    evidence=[],
                    error_code="LEDGER_SETTLEMENT_UNKNOWN",
                    error_message="工具失败且幂等账本结算结果未知",
                )
                writer(runtime_event(
                    "tool.unknown",
                    toolCallId=tool_call_id,
                    **tool_ref,
                    toolName="web_search",
                    query=arguments.query,
                    channel=arguments.channel,
                    reasonCode="LEDGER_SETTLEMENT_UNKNOWN",
                ))
                status = "unknown"
        else:
            try:
                if result.ok:
                    await runtime.context.ledger.complete(idempotency_key, result.public_dict())
                    status = "completed"
                else:
                    await runtime.context.ledger.fail(
                        idempotency_key,
                        result.public_dict(),
                        result.error_code or "SEARCH_FAILED",
                    )
                    status = "failed"
            except Exception:  # noqa: BLE001 - 外部调用已发生但账本结算未知
                result = SearchExecutionResult(
                    ok=False,
                    channel=arguments.channel,
                    query=arguments.query,
                    provider="unknown",
                    results=[],
                    evidence=[],
                    error_code="LEDGER_SETTLEMENT_UNKNOWN",
                    error_message="外部调用已结束，但幂等账本结算结果未知",
                )
                writer(runtime_event(
                    "tool.unknown",
                    toolCallId=tool_call_id,
                    **tool_ref,
                    toolName="web_search",
                    query=arguments.query,
                    channel=arguments.channel,
                    reasonCode="LEDGER_SETTLEMENT_UNKNOWN",
                ))
                status = "unknown"

    if decision.action == "cached" and result.interaction_wait_ms:
        result = result.model_copy(update={"interaction_wait_ms": 0})

    if result.ok and not progress_emitted:
        for result_count in range(1, len(result.results) + 1):
            stream_progress(ChannelProgress(
                provider=result.provider,
                result_count=result_count,
                evidence_count=0,
            ))
        source_by_url = {item.url: item for item in result.results if item.verified}
        for evidence_count, item in enumerate(result.evidence, start=1):
            source = source_by_url.get(item.url)
            stream_progress(ChannelProgress(
                provider=result.provider,
                result_count=len(result.results),
                evidence_count=evidence_count,
                source=(
                    None
                    if source is None
                    else source.model_dump()
                ),
            ))

    public_results = [item.model_dump(mode="json") for item in result.results]
    resolution = result.resolution
    if resolution is None:  # pragma: no cover - Pydantic after-validator 防御
        raise RuntimeError("搜索结果缺少结算状态")
    settled_result_count = max(observed_result_count, len(result.results))
    settled_evidence_count = max(observed_evidence_count, len(result.evidence))
    if result.ok:
        writer(runtime_event(
            "tool.completed",
            toolCallId=tool_call_id,
            **tool_ref,
            toolName="web_search",
            query=arguments.query,
            channel=arguments.channel,
            provider=resolution.effective_provider,
            status=resolution.status,
            primaryProvider=resolution.primary_provider,
            effectiveProvider=resolution.effective_provider,
            reasonCode=resolution.reason_code,
            message=resolution.message,
            retryable=resolution.retryable,
            nextAction=resolution.next_action,
            summary=(
                f"受控降级：保留 {len(result.results)} 条候选，读取 {len(result.evidence)} 个来源"
                if resolution.status == "degraded"
                else f"找到 {len(result.results)} 条结果，读取 {len(result.evidence)} 个来源"
            ),
            resultCount=len(result.results),
            evidenceCount=len(result.evidence),
            results=public_results,
            cached=decision.action == "cached",
            durationMs=max(0, round((time.perf_counter() - started) * 1000)),
        ))
    elif status != "unknown":
        writer(runtime_event(
            "tool.failed",
            toolCallId=tool_call_id,
            **tool_ref,
            toolName="web_search",
            query=arguments.query,
            channel=arguments.channel,
            provider=resolution.effective_provider,
            status=resolution.status,
            primaryProvider=resolution.primary_provider,
            effectiveProvider=resolution.effective_provider,
            reasonCode=resolution.reason_code or result.error_code or "SEARCH_FAILED",
            message=resolution.message or result.error_message or "搜索失败",
            retryable=resolution.retryable,
            nextAction=resolution.next_action,
            resultCount=settled_result_count,
            evidenceCount=settled_evidence_count,
            durationMs=max(0, round((time.perf_counter() - started) * 1000)),
        ))

    trace = SearchTrace(
        tool_call_id=tool_call_id,
        **({"plan_step_id": plan_step_id} if plan_step_id else {}),
        idempotency_key=idempotency_key,
        query=arguments.query,
        channel=arguments.channel,
        provider=resolution.effective_provider,
        status=status,
        outcome_status=resolution.status,
        primary_provider=resolution.primary_provider,
        effective_provider=resolution.effective_provider,
        result_count=len(result.results),
        evidence_count=len(result.evidence),
        error_code=resolution.reason_code or result.error_code,
        retryable=resolution.retryable,
        next_action=resolution.next_action,
        limitation=_result_limitation(result),
    )
    return result, trace


_XIAOHONGSHU_CIRCUIT_CODES = frozenset({
    "AUTH_REQUIRED",
    "CAPTCHA_REQUIRED",
    "MCP_TIMEOUT",
    "MCP_NETWORK_ERROR",
    "MCP_RATE_LIMITED",
    "MCP_UNAVAILABLE",
    "MCP_OUTPUT_INVALID",
    "MCP_CIRCUIT_OPEN",
    "ACCOUNT_MISMATCH",
    "VERIFICATION_CANCELLED",
    "VERIFICATION_FAILED",
    "VERIFICATION_RETRY_FAILED",
    "VERIFICATION_TIMEOUT",
    "VERIFICATION_UNAVAILABLE",
})


def _planned_tool_call_id(
    state: SearchState,
    index: int,
    search: SearchRequest,
) -> str:
    material = (
        f"{state['run_id']}|{state.get('round', 0)}|{index}|"
        f"{search.get('step_id') or 'legacy'}|"
        f"{search['channel']}|{search['query'].casefold().strip()}"
    )
    return f"call_search_{hashlib.sha256(material.encode()).hexdigest()[:24]}"


def _xiaohongshu_circuit_is_open(traces: list[SearchTrace]) -> bool:
    return any(
        trace["channel"] == "xiaohongshu"
        and (
            (trace.get("error_code") or "") in _XIAOHONGSHU_CIRCUIT_CODES
            or trace.get("provider", "").startswith(
                "xiaohongshu-mcp-fallback["
            )
        )
        for trace in traces
    )


def _settle_pending_plan(
    state: SearchState,
    reason_code: str,
) -> dict[str, Any]:
    plan = state.get("plan")
    step_ids = list(state.get("pending_plan_step_ids") or [])
    if not plan or not step_ids:
        return {"pending_plan_step_ids": []}
    revision = state.get("plan_revision", plan["revision"]) + 1
    settled = settle_running_steps(
        plan,
        revision=revision,
        outcomes={step_id: reason_code for step_id in step_ids},
    )
    return {
        "plan": settled,
        "plan_revision": revision,
        "pending_plan_step_ids": [],
    }


async def research(state: SearchState, runtime: Runtime[RunContext]) -> dict[str, Any]:
    """直接执行 Planner 已批准的严格搜索，不再用模型复述固定参数。

    非小红书目标同轮并发；小红书目标在一个串行组内执行，以便首个结构化
    故障立即打开本运行熔断。所有结果最终按 Planner 原顺序归并。
    """

    pending_searches = _pending_searches(state)
    if not pending_searches:
        return {
            "no_progress_count": state.get("no_progress_count", 0),
            "replan_required": False,
            "steps": _step("research", "deterministic", None, "no_pending_searches"),
        }

    remaining = max(0, state.get("max_tool_calls", 6) - state.get("tool_calls", 0))
    if remaining <= 0:
        return {
            "pending_searches": [],
            "pending_queries": [],
            "stop_reason": state.get("stop_reason") or "TOOL_CALL_LIMIT",
            **_settle_pending_plan(state, "TOOL_CALL_LIMIT"),
            "steps": _step("research", "deterministic", None, "tool_budget_exhausted"),
        }
    if _remaining_model_calls(state) < 4:
        return {
            "pending_searches": [],
            "pending_queries": [],
            "stop_reason": state.get("stop_reason") or "MODEL_CALL_LIMIT",
            "no_progress_count": state.get("no_progress_count", 0) + 1,
            "replan_required": False,
            **_settle_pending_plan(state, "MODEL_CALL_LIMIT"),
            "steps": _step("research", "deterministic", None, "finalization_budget_reserved"),
        }

    targets = pending_searches[:remaining]
    projected_limit: str | None = (
        "TOOL_CALL_LIMIT" if len(targets) < len(pending_searches) else None
    )
    scheduled: list[
        tuple[int, str | None, str, SearchToolInput, float | None]
    ] = []
    for index, target in enumerate(targets):
        channel = target["channel"]
        if channel not in _RESEARCH_CHANNELS:
            projected_limit = projected_limit or "INVALID_CHANNEL_PLAN"
            continue
        timeout_seconds = tool_timeout_seconds(state, channel)
        if timeout_seconds is not None and timeout_seconds <= 0:
            projected_limit = projected_limit or "RUN_TIME_RESERVE"
            continue
        scheduled.append((
            index,
            target.get("step_id"),
            _planned_tool_call_id(state, index, target),
            SearchToolInput(query=target["query"], channel=channel, max_results=5),
            timeout_seconds,
        ))

    indexed_results: dict[
        int,
        tuple[str | None, str, SearchExecutionResult, SearchTrace],
    ] = {}

    async def execute_one(
        index: int,
        plan_step_id: str | None,
        tool_call_id: str,
        arguments: SearchToolInput,
        timeout_seconds: float | None,
        *,
        xiaohongshu_public_only: bool = False,
    ) -> None:
        result, trace = await _run_one_search(
            state,
            runtime,
            tool_call_id,
            arguments,
            plan_step_id=plan_step_id,
            timeout_seconds=timeout_seconds,
            xiaohongshu_public_only=xiaohongshu_public_only,
        )
        indexed_results[index] = (plan_step_id, tool_call_id, result, trace)

    xiaohongshu_targets = [
        item for item in scheduled if item[3].channel == "xiaohongshu"
    ]
    other_targets = [
        item for item in scheduled if item[3].channel != "xiaohongshu"
    ]

    async def execute_xiaohongshu_group() -> None:
        public_only = _xiaohongshu_circuit_is_open(
            list(state.get("tool_traces") or [])
        )
        for (
            index,
            plan_step_id,
            tool_call_id,
            arguments,
            timeout_seconds,
        ) in xiaohongshu_targets:
            await execute_one(
                index,
                plan_step_id,
                tool_call_id,
                arguments,
                timeout_seconds,
                xiaohongshu_public_only=public_only,
            )
            trace = indexed_results[index][3]
            if _xiaohongshu_circuit_is_open([trace]):
                public_only = True

    concurrent: list[asyncio.Task[None]] = [
        asyncio.create_task(execute_one(*item)) for item in other_targets
    ]
    if xiaohongshu_targets:
        concurrent.append(asyncio.create_task(execute_xiaohongshu_group()))
    if concurrent:
        await asyncio.gather(*concurrent)

    new_candidates: list[Candidate] = []
    new_evidence: list[Evidence] = []
    traces: list[SearchTrace] = []
    outcomes: dict[str, str | None] = {
        step_id: projected_limit or "PLAN_STEP_NOT_EXECUTED"
        for step_id in state.get("pending_plan_step_ids") or []
    }
    evidence_targets = {
        step["step_id"]: step["evidence_needed"]
        for step in (state.get("plan") or {}).get("steps", [])
    }
    for index in sorted(indexed_results):
        plan_step_id, tool_call_id, result, trace = indexed_results[index]
        traces.append(trace)
        if plan_step_id:
            if trace["status"] not in {"completed", "cached"}:
                outcomes[plan_step_id] = trace.get("error_code") or "SEARCH_FAILED"
            elif trace["evidence_count"] < evidence_targets.get(plan_step_id, 0):
                outcomes[plan_step_id] = "PLAN_EVIDENCE_TARGET_UNMET"
            else:
                outcomes[plan_step_id] = None
        if result.error_code == "RUN_TIME_RESERVE":
            projected_limit = projected_limit or "RUN_TIME_RESERVE"
        for item in result.results:
            new_candidates.append(Candidate(
                channel=item.channel,
                tool_call_id=tool_call_id,
                iteration=state.get("round", 0),
                provider=item.provider,
                url=item.url,
                title=item.title,
                snippet=item.snippet,
                query=result.query,
                author=item.author,
                published_at=item.published_at,
                metrics=item.metrics,
                limitation=item.limitation,
            ))
        for item in result.evidence:
            new_evidence.append(Evidence(
                channel=item.channel,
                tool_call_id=tool_call_id,
                iteration=state.get("round", 0),
                provider=item.provider,
                url=item.url,
                title=item.title,
                text=item.text,
                extractor=item.extractor,
                query=item.query,
                captured_at=item.captured_at,
                author=item.author,
                published_at=item.published_at,
                metrics=item.metrics,
                limitation=item.limitation,
            ))

    seen_candidates = {item["url"] for item in state.get("candidates") or []}
    candidates = list(state.get("candidates") or [])
    for item in new_candidates:
        if item["url"] not in seen_candidates:
            seen_candidates.add(item["url"])
            candidates.append(item)
    seen_evidence = {item["url"] for item in state.get("evidence") or []}
    evidence = list(state.get("evidence") or [])
    for item in new_evidence:
        if item["url"] not in seen_evidence:
            seen_evidence.add(item["url"])
            evidence.append(item)

    executed_tool_calls = len(indexed_results)
    interaction_wait_seconds = sum(
        result.interaction_wait_ms
        for _plan_step_id, _tool_call_id, result, _trace in indexed_results.values()
    ) / 1000
    gained = len(evidence) - len(state.get("evidence") or [])
    plan_patch: dict[str, Any] = {"pending_plan_step_ids": []}
    current_plan = state.get("plan")
    if current_plan and state.get("pending_plan_step_ids"):
        revision = state.get("plan_revision", current_plan["revision"]) + 1
        settled = settle_running_steps(
            current_plan,
            revision=revision,
            outcomes=outcomes,
        )
        plan_patch = {
            "plan": settled,
            "plan_revision": revision,
            "pending_plan_step_ids": [],
        }
    return {
        "candidates": candidates,
        "evidence": evidence,
        "tool_traces": list(state.get("tool_traces") or []) + traces,
        "tool_calls": state.get("tool_calls", 0) + executed_tool_calls,
        "external_wait_seconds": (
            float(state.get("external_wait_seconds") or 0.0)
            + interaction_wait_seconds
        ),
        "pending_searches": [],
        "pending_queries": [],
        **plan_patch,
        "stop_reason": state.get("stop_reason") or projected_limit,
        "no_progress_count": 0 if gained else state.get("no_progress_count", 0) + 1,
        "replan_required": False,
        "steps": _step(
            "research",
            "deterministic",
            None,
            f"executed_searches={executed_tool_calls} new_evidence={gained}",
        ),
    }


async def reflect(state: SearchState, runtime: Runtime[RunContext]) -> dict[str, Any]:
    evidence = state.get("evidence") or []
    current_evidence = [
        item
        for item in evidence
        if item.get("iteration") == state.get("round", 0)
    ]
    current_candidates = [
        item
        for item in state.get("candidates") or []
        if item.get("iteration") == state.get("round", 0)
    ]
    limit = budget_reason(state, reserve_model_calls=1)
    if limit:
        return {
            "sufficient": False,
            "pending_searches": [],
            "pending_queries": [],
            "replan_required": False,
            "verification_issue": "模型预算不足，无法继续评估证据",
            "stop_reason": state.get("stop_reason") or limit,
            "steps": _step("reflect", "deterministic", None, f"budget={limit}"),
        }
    digest = "\n\n".join(
        f"[证据{i + 1}] {item['title']}\n渠道: {item['channel']}\n"
        f"URL: {item['url']}\n{item['text'][:1000]}"
        for i, item in enumerate(evidence)
    ) or "（本轮没有读取到可用证据）"
    candidate_digest = "\n".join(
        json.dumps(
            {
                "url": item["url"],
                "channel": item["channel"],
                "title": item["title"],
                "snippet": item["snippet"],
                "verified": any(
                    evidence_item["url"] == item["url"] for evidence_item in evidence
                ),
                "limitation": item.get("limitation"),
            },
            ensure_ascii=False,
        )
        for item in current_candidates
    ) or "（当前轮没有候选）"
    presentation_digest = "\n\n".join(
        f"[已读来源] {item['title']}\n渠道: {item['channel']}\n"
        f"URL: {item['url']}\n{item['text'][:1000]}"
        for item in current_evidence
    ) or "（当前轮没有已读取来源，不得生成 source_presentations）"
    feedback = _tool_feedback(state)
    structured_failed = False
    try:
        result, usage = await invoke_structured(
            "reflector",
            ReflectResult,
            [
                SystemMessage(content=REFLECTOR_PROMPT),
                HumanMessage(content=(
                    f"用户问题：{state['question']}"
                    f"\n逐次真实工具反馈：{json.dumps(feedback, ensure_ascii=False)}"
                    f"\n已执行 query+channel：{json.dumps(_state_searches(state), ensure_ascii=False)}"
                    f"\n\n当前轮候选反馈（仅用于判断覆盖，不得为未读候选生成来源说明）：\n"
                    f"{candidate_digest}"
                    f"\n\n当前轮已读取来源（source_presentations 只允许使用这些 URL；"
                    f"直接支持问题的来源可展示；跨渠道补充资料必须明确真实渠道）：\n"
                    f"{presentation_digest}"
                    f"\n\n已读取证据：\n{digest}"
                )),
            ],
            model_id=state.get("model_id") or None,
            allow_repair=_allow_structured_repair(state),
        )
    except StructuredOutputError as exc:
        # Reflector 的覆盖判断失败时仍把已读 Evidence 交给独立 Source
        # Curator；否则真实来源计数存在，但详情永远不会产生。
        structured_failed = True
        usage = exc.usage
        result = ReflectResult(
            sufficient=bool(evidence),
            missing="证据评估未返回有效结构，交由后续核验收口",
            extra_searches=[],
            source_presentations=[],
            summary="",
        )
    extra_searches = _fresh_follow_up_searches(state, result.extra_searches)[:2]
    extra = [item["query"] for item in extra_searches]
    sufficient = bool(result.sufficient and evidence)
    usages = [usage]
    presentations_by_call = _group_source_presentations(
        result.source_presentations,
        current_evidence,
    )
    presented_urls = {
        presentation["url"]
        for presentations in presentations_by_call.values()
        for presentation in presentations
    }
    excluded_urls = {
        presentation.url
        for presentation in result.source_presentations
        if not presentation.include_in_details
    }
    required_channels, _, _ = _verification_channel_coverage(state)
    cross_channel_urls = {
        item["url"]
        for item in current_evidence
        if item["channel"] not in required_channels
    }
    missing_evidence = [
        item
        for item in current_evidence
        if item["url"] not in presented_urls
        and (
            item["url"] not in excluded_urls
            or item["url"] in cross_channel_urls
        )
    ]
    curator_rounds = 0
    while missing_evidence and curator_rounds < 2:
        consumed_calls = sum(item.attempts for item in usages)
        remaining_seconds = remaining_run_seconds(state)
        can_curate = (
            _remaining_model_calls(state) >= consumed_calls + 3
            and (remaining_seconds is None or remaining_seconds >= 12)
        )
        if not can_curate:
            break
        curator_input = missing_evidence[:10]
        curator_digest = "\n\n".join(
            f"[已读来源] {item['title']}\n渠道: {item['channel']}\n"
            f"URL: {item['url']}\n{item['text'][:1000]}"
            for item in curator_input
        )
        curator_rounds += 1
        try:
            curated, curator_usage = await invoke_structured(
                "reflector",
                SourcePresentationResult,
                [
                    SystemMessage(content=SOURCE_CURATOR_PROMPT),
                    HumanMessage(content=(
                        f"用户问题：{state['question']}"
                        f"\n\n以下是 {len(curator_input)} 条已读取来源。逐条判断是否直接支持用户"
                        f"当前问题；跨渠道但能支持可分离补充背景的来源也可展示，但说明必须"
                        f"明确其真实渠道且不能冒充用户指定渠道。只为应展示的来源设 include_in_details=true，"
                        f"不应展示的来源设 false 且 text 为空。URL 必须原样复制：\n{curator_digest}"
                    )),
                ],
                model_id=state.get("model_id") or None,
                allow_repair=(
                    _allow_structured_repair(state)
                    and _remaining_model_calls(state) >= consumed_calls + 4
                ),
            )
            usages.append(curator_usage)
            curated_by_call = _group_source_presentations(
                curated.source_presentations,
                curator_input,
            )
            excluded_urls.update(
                presentation.url
                for presentation in curated.source_presentations
                if not presentation.include_in_details
            )
            before = len(presented_urls)
            for tool_call_id, presentations in curated_by_call.items():
                existing = presentations_by_call.setdefault(tool_call_id, [])
                existing_urls = {item["url"] for item in existing}
                for presentation in presentations:
                    if presentation["url"] not in existing_urls:
                        existing.append(presentation)
                        existing_urls.add(presentation["url"])
                        presented_urls.add(presentation["url"])
            if len(presented_urls) == before:
                break
            missing_evidence = [
                item
                for item in current_evidence
                if item["url"] not in presented_urls and item["url"] not in excluded_urls
            ]
        except StructuredOutputError as exc:
            usages.append(exc.usage)
            break
    contract_sufficient = _presented_sources_satisfy_contract(
        state["question"],
        current_evidence,
        presented_urls,
        required_channels,
        result.missing,
    )
    if contract_sufficient:
        sufficient = True
        extra_searches = []
        extra = []
    writer = get_stream_writer()
    for tool_call_id, presentations in presentations_by_call.items():
        for presentation in presentations:
            writer(runtime_event(
                "tool.presented",
                toolCallId=tool_call_id,
                sources=[presentation],
                presentationSource="model",
            ))
    stop_reason = state.get("stop_reason")
    if not sufficient:
        if state.get("round", 0) >= state.get("max_rounds", 2):
            stop_reason = stop_reason or "MAX_ITERATIONS"
        elif state.get("no_progress_count", 0) >= state.get("no_progress_limit", 2):
            stop_reason = stop_reason or "NO_PROGRESS"
    replan_required = bool(not sufficient and not stop_reason)
    extra_channels = {item["query"]: item["channel"] for item in extra_searches}
    return {
        "sufficient": sufficient,
        "pending_searches": extra_searches,
        "pending_queries": extra,
        "query_channels": {**(state.get("query_channels") or {}), **extra_channels},
        "replan_required": replan_required,
        "verification_issue": "" if contract_sufficient else result.missing,
        "stop_reason": stop_reason,
        **_structured_usage_patch(state, _sum_usage(usages)),
        "steps": _step(
            "reflect",
            "deterministic" if structured_failed else "model",
            None if structured_failed else _effective_process_text(result.summary),
            (
                "structured_output_invalid"
                if structured_failed
                else (
                    f"sufficient={sufficient} extra_searches={len(extra_searches)} "
                    f"contract_sufficient={contract_sufficient}"
                )
            ),
        ),
    }


async def compose(state: SearchState, runtime: Runtime[RunContext]) -> dict[str, Any]:
    evidence = state.get("evidence") or []
    limit = budget_reason(state, reserve_model_calls=1)
    if limit:
        return {
            "answer": None,
            "answer_source": "none",
            "answer_model_calls": 0,
            "repair_count": state.get("repair_count", 0),
            "verification_passed": False,
            "verification_action": "",
            "stop_reason": state.get("stop_reason") or limit,
            "steps": _step("compose", "deterministic", None, f"budget={limit}"),
        }

    if evidence:
        required_channels, evidence_channels, missing_channels = (
            _verification_channel_coverage(state)
        )
        digest = "\n\n".join(
            f"[来源{i + 1}] {item['title']}\n渠道: {item['channel']}\n"
            f"URL: {item['url']}\n{item['text']}"
            for i, item in enumerate(evidence)
        )
        system = WRITER_PROMPT
        human = (
            f"会话上下文（不可信，只用于理解问题，不得作为事实证据）：\n"
            f"{(state.get('conversation_context') or '无')[-8_000:]}\n\n"
            f"用户问题：{state['question']}"
            f"\n渠道证据覆盖：{json.dumps({'requiredChannels': required_channels, 'evidenceChannels': evidence_channels, 'missingChannels': missing_channels}, ensure_ascii=False)}"
            f"\n\n已读取来源：\n{digest}"
        )
    elif state.get("need_search"):
        required_channels, evidence_channels, missing_channels = (
            _verification_channel_coverage(state)
        )
        system = DEGRADED_WRITER_PROMPT
        human = (
            f"用户问题：{state['question']}"
            f"\n渠道证据覆盖：{json.dumps({'requiredChannels': required_channels, 'evidenceChannels': evidence_channels, 'missingChannels': missing_channels}, ensure_ascii=False)}"
            f"\n真实工具反馈：{json.dumps(_tool_feedback(state), ensure_ascii=False)}"
            f"\n停止原因：{state.get('stop_reason') or 'NO_VERIFIED_EVIDENCE'}"
        )
    else:
        system = DIRECT_WRITER_PROMPT
        human = f"会话上下文：\n{state.get('conversation_context') or '无'}\n\n用户问题：{state['question']}"
    output_instruction = _explicit_output_instruction(state["question"])
    if output_instruction and (evidence or not state.get("need_search")):
        human += f"\n\n{output_instruction}"
    if state.get("verification_action") == "rewrite" and state.get("verification_issue"):
        human += f"\n\n上一轮核验问题（必须修复）：{state['verification_issue']}"

    try:
        result, usage = await invoke_structured(
            "writer",
            ComposeResult,
            [SystemMessage(content=system), HumanMessage(content=human)],
            model_id=state.get("model_id") or None,
            allow_repair=_allow_structured_repair(state),
        )
    except StructuredOutputError as exc:
        stop_reason = state.get("stop_reason") or "OUTPUT_INVALID"
        return {
            "answer": None,
            "answer_source": "none",
            "answer_model_calls": 0,
            "repair_count": state.get("repair_count", 0),
            "verification_passed": False,
            "verification_action": "",
            "stop_reason": stop_reason,
            **_structured_usage_patch(state, exc.usage),
            "steps": _step(
                "compose",
                "deterministic",
                None,
                "structured_output_invalid",
            ),
        }
    repairing = state.get("verification_action") == "rewrite"
    answer = _compact_answer_markdown(result.answer_markdown)
    return {
        "answer": answer,
        "answer_source": "model",
        "answer_model_calls": usage.attempts,
        "repair_count": state.get("repair_count", 0) + (1 if repairing else 0),
        "verification_passed": False,
        "verification_action": "",
        **_structured_usage_patch(state, usage),
        "steps": _step(
            "compose",
            "model",
            _effective_process_text(result.summary),
            f"answer_chars={len(result.answer_markdown)} delivered_chars={len(answer)} "
            f"sources={len(evidence)}",
        ),
    }


async def verify(state: SearchState, runtime: Runtime[RunContext]) -> dict[str, Any]:
    evidence = state.get("evidence") or []
    answer = state.get("answer") or ""
    required_channels, evidence_channels, missing_channels = (
        _verification_channel_coverage(state)
    )
    format_issue = _explicit_output_issue(state["question"], answer)
    if not state.get("need_search"):
        return {
            "verification_passed": False,
            "verification_action": "pass",
            "verification_issue": "直接回答未执行外部事实核验",
            "replan_required": False,
            "steps": _step("verify", "deterministic", None, "direct_answer_not_externally_verified"),
        }
    if not evidence or not answer:
        return {
            "verification_passed": False,
            "verification_action": "research_more",
            "verification_issue": "缺少可核验的公开来源",
            "replan_required": not bool(state.get("stop_reason")),
            "steps": _step("verify", "deterministic", None, "missing_evidence"),
        }

    limit = budget_reason(state, reserve_model_calls=1)
    if limit:
        return {
            "verification_passed": False,
            "verification_action": "",
            "verification_issue": "模型预算不足，未完成最终核验",
            "replan_required": False,
            "stop_reason": state.get("stop_reason") or limit,
            "steps": _step("verify", "deterministic", None, f"budget={limit}"),
        }

    digest = "\n\n".join(
        f"[来源{i + 1}] {item['title']}\nURL: {item['url']}\n{item['text'][:1200]}"
        for i, item in enumerate(evidence)
    )
    channel_coverage = {
        "requiredChannels": required_channels,
        "evidenceChannels": evidence_channels,
        "missingChannels": missing_channels,
    }
    result, usage = await invoke_structured(
        "verifier",
        VerifyResult,
        [
            SystemMessage(content=VERIFIER_PROMPT),
            HumanMessage(content=(
                f"用户问题：{state['question']}"
                f"\n已执行 query+channel：{json.dumps(_state_searches(state), ensure_ascii=False)}"
                f"\n调用级搜索统计（只表示发现与已读数量，不得据此否定下方已读来源）："
                f"{json.dumps(_verification_tool_feedback(state), ensure_ascii=False)}"
                f"\n渠道证据覆盖（硬门槛）："
                f"{json.dumps(channel_coverage, ensure_ascii=False)}"
                f"\n\n回答：\n{answer}\n\n来源：\n{digest}"
            )),
        ],
        model_id=state.get("model_id") or None,
        allow_repair=_allow_structured_repair(state),
    )
    action = "pass" if result.passed else result.action
    passed = result.passed and action == "pass"
    issue = result.issue
    coverage_compliant = not missing_channels or (
        not result.passed and result.action == "research_more"
    )
    if missing_channels:
        action = "research_more"
        passed = False
        coverage_issue = (
            "缺少用户指定渠道的已读正文 Evidence："
            + "、".join(missing_channels)
        )
        issue = "；".join(value for value in (coverage_issue, issue) if value)
    elif format_issue and action != "research_more":
        action = "rewrite"
        passed = False
        issue = "；".join(value for value in (format_issue, issue) if value)
    extra_searches = (
        _fresh_follow_up_searches(state, result.extra_searches)[:2]
        if action == "research_more"
        else []
    )
    extra = [item["query"] for item in extra_searches]
    stop_reason = state.get("stop_reason")
    soft_search_stop = stop_reason in {"MAX_ITERATIONS", "NO_PROGRESS"}
    if passed:
        # 搜索轮次耗尽只禁止继续检索；独立 Verifier 已确认答案受证据支持时，
        # 不应让此前的软停止原因把已核验结果错误降级为 partial。
        if soft_search_stop:
            stop_reason = None
    else:
        if action == "rewrite" and state.get("repair_count", 0) >= 1:
            stop_reason = "REWRITE_LIMIT"
        elif action == "rewrite" and soft_search_stop:
            # 改写不消耗新的搜索轮次，仍允许使用唯一一次修复机会。
            stop_reason = None
        elif action == "research_more" and state.get("round", 0) >= state.get("max_rounds", 2):
            stop_reason = stop_reason or "MAX_ITERATIONS"
        elif (
            action == "research_more"
            and state.get("no_progress_count", 0) >= state.get("no_progress_limit", 2)
        ):
            stop_reason = stop_reason or "NO_PROGRESS"
    replan_required = bool(
        not passed and action == "research_more" and not stop_reason
    )
    extra_channels = {item["query"]: item["channel"] for item in extra_searches}
    public_summary = _effective_process_text(result.summary) if coverage_compliant else None
    return {
        "verification_passed": passed,
        "verification_action": action,
        "verification_issue": issue,
        "pending_searches": extra_searches,
        "pending_queries": extra,
        "query_channels": {**(state.get("query_channels") or {}), **extra_channels},
        "replan_required": replan_required,
        "stop_reason": stop_reason,
        **_structured_usage_patch(state, usage),
        "steps": _step(
            "verify",
            "model",
            public_summary,
            (
                f"passed={passed} action={action} "
                f"required_channels={required_channels} "
                f"evidence_channels={evidence_channels} "
                f"missing_channels={missing_channels}"
            ),
        ),
    }


async def finalize(state: SearchState, runtime: Runtime[RunContext]) -> dict[str, Any]:
    reason = state.get("stop_reason") or budget_reason(state)
    if not reason:
        if not state.get("need_search"):
            reason = "DIRECT_COMPLETED"
        elif state.get("verification_passed"):
            reason = "VERIFIED"
        elif state.get("need_search") and not state.get("evidence"):
            reason = "SEARCH_UNAVAILABLE"
        else:
            reason = "VERIFICATION_INCOMPLETE"

    # 只有以 VERIFIED 结束的搜索答案才能称为已完成核验或进入长期证据记忆。
    # 工具、时间或模型预算可能在 Verifier 之后耗尽；这时旧状态中的一次通过
    # 结果不能把 partial 运行升级成可交付的已核验结论。
    verification_passed = bool(
        state.get("verification_passed") and reason == "VERIFIED"
    )

    writer = get_stream_writer()
    if (
        verification_passed
        and state.get("project_id")
        and runtime.context.milvus
        and state.get("evidence")
    ):
        health = runtime.context.milvus.health
        if not health.enabled or not health.available:
            writer(runtime_event(
                "memory.status",
                status="degraded",
                reasonCode="MEMORY_DISABLED" if not health.enabled else "MEMORY_UNAVAILABLE",
            ))
        else:
            try:
                stored = await runtime.context.milvus.remember(
                    tenant_id=state["tenant_id"],
                    visitor_id=state["visitor_id"],
                    project_id=state["project_id"],
                    evidence=state["evidence"],
                )
                memory_payload: dict[str, Any] = {
                    "status": "stored" if stored else "degraded",
                    "storedCount": stored,
                    "embeddingVersion": runtime.context.config.milvus.embedding_model_version,
                }
                if not stored:
                    memory_payload["reasonCode"] = "MEMORY_NOT_STORED"
                writer(runtime_event("memory.status", **memory_payload))
            except Exception as exc:  # noqa: BLE001 - 记忆失败不篡改已核验回答
                writer(runtime_event(
                    "memory.status", status="degraded", reasonCode=_safe_error_code(exc)
                ))

    response_status = "completed" if reason in {"VERIFIED", "DIRECT_COMPLETED"} else "partial"
    answer_model_calls = int(state.get("answer_model_calls") or 0)
    answer = (
        state.get("answer")
        if state.get("answer_source") == "model" and answer_model_calls > 0
        else None
    )
    citations: list[Citation] = []
    if answer:
        answer, citations = _answer_citations(answer, state.get("evidence") or [])
    return {
        "stop_reason": reason,
        "citations": citations,
        "answer": answer,
        "answer_source": "model" if answer else "none",
        "answer_model_calls": answer_model_calls if answer else 0,
        "verification_passed": verification_passed,
        "response_status": response_status,
        "steps": _step("finalize", "deterministic", None, f"stop_reason={reason}"),
    }


def route_after_intent(state: SearchState) -> str:
    if not state.get("need_search"):
        return "compose"
    return "compose" if budget_reason(state, reserve_model_calls=2) else "plan_research"


def route_after_plan(state: SearchState) -> str:
    return "mark_plan_running" if state.get("plan_ready") else "reflect"


def route_after_research(state: SearchState) -> str:
    if not state.get("stop_reason") and has_todo_steps(state.get("plan")):
        return "mark_plan_running"
    return "reflect"


def route_after_reflect(state: SearchState) -> str:
    if state.get("sufficient"):
        return "compose"
    if state.get("stop_reason"):
        return "compose"
    if budget_reason(state, reserve_model_calls=2):
        return "compose"
    if state.get("round", 0) >= state.get("max_rounds", 2):
        return "compose"
    if state.get("no_progress_count", 0) >= state.get("no_progress_limit", 2):
        return "compose"
    if not state.get("replan_required") and not _pending_searches(state):
        return "compose"
    return "plan_research"


def route_after_compose(state: SearchState) -> str:
    # MAX_ITERATIONS / NO_PROGRESS 是软搜索停止，Verifier 仍可确认现有回答或要求
    # 一次改写；只有 Writer 协议输出本身无效时才直接交付受控 partial。
    return "finalize" if state.get("stop_reason") == "OUTPUT_INVALID" else "verify"


def route_after_verify(state: SearchState) -> str:
    if state.get("verification_passed"):
        return "finalize"
    if state.get("stop_reason"):
        return "finalize"
    if budget_reason(state, reserve_model_calls=1):
        return "finalize"
    action = state.get("verification_action")
    if (
        action == "research_more"
        and (state.get("replan_required") or _pending_searches(state))
        and state.get("round", 0) < state.get("max_rounds", 2)
    ):
        return "plan_research"
    if action == "rewrite" and state.get("repair_count", 0) < 1:
        return "compose"
    return "finalize"
