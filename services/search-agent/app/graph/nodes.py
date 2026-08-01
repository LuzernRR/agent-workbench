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
from app.graph.evidence import (
    EvidenceStateConflictError,
    answerable_evidence,
    evidence_event_payload,
    normalize_evidence,
    transition_evidence,
)
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
    STRUCTURED_ANSWER_MAX_CHARS,
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
    MemoryCandidate,
    PlanSnapshot,
    ResearchBranchResult,
    ResearchExecution,
    ResearchResultConflictError,
    ResearchTarget,
    ResearchWorkItem,
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
from app.persistence.tool_ledger import ToolLedgerSettlement
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
from app.tools.gateway import (
    ToolGatewayCall,
    ToolGatewayCancelled,
    ToolGatewayExecution,
    ToolOperationOutcome,
    usage_payload,
)
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
# 重新规划还会消耗一次模型调用；在工具保留窗口之上再留出规划余量，
# 避免生成一个随后必然因时间不足而全部 blocked 的新计划。
_REPLAN_RESERVE_SECONDS = 80
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
_NUMBERED_ANSWER_ITEM = re.compile(r"(?m)^[ \t]*\d{1,2}[.)、][ \t]+")
_NON_MEDICAL_REQUEST = re.compile(
    r"(?:不得|不要|不能).{0,20}(?:个人体验|使用体验|体验).{0,20}医疗建议|"
    r"(?:不得|不要|不能).{0,20}医疗建议",
)
_NON_MEDICAL_DISCLAIMER = re.compile(r"不构成医疗建议|非医疗建议")
_CONFLICTING_EVIDENCE_GAP = re.compile(r"冲突|矛盾|不一致|相反")


def _event_writer() -> Any:
    """图外单元测试不具有 stream writer；状态语义不依赖事件旁路。"""

    try:
        return get_stream_writer()
    except RuntimeError:
        return lambda _event: None


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
        return answer, []

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


def _referenced_evidence(answer: str, evidence: list[Evidence]) -> list[Evidence]:
    """按 Writer 的 [来源N] 解析实际引用，不把未引用来源伪标 cited。"""

    referenced = list(dict.fromkeys(
        int(match.group(1))
        for match in _CITATION_REFERENCE.finditer(answer)
    ))
    selected: list[Evidence] = []
    seen_ids: set[str] = set()
    for original in referenced:
        index = original - 1
        if index < 0 or index >= len(evidence):
            continue
        item = evidence[index]
        if item["evidence_id"] in seen_ids:
            continue
        seen_ids.add(item["evidence_id"])
        selected.append(item)
    return selected


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
    """把当前问题的自然语言格式要求变成 Writer 可逐项核对的短契约。"""

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
        lines.append("- 使用真正的 Markdown 编号一级列表；每个编号项代表一条完整记录。")
        lines.append("- 第一字段写在编号项首行；其余字段写成缩进子列表，字段名加粗且每个字段独占一行。")
        lines.append("- 相邻编号记录之间保留一个空行；禁止把多个字段挤在同一段，也不要改用表格。")
        lines.append("- 严格使用下面由当前问题动态生成的字段顺序与 Markdown 结构：")
        first, *remaining = fields
        first_value = "[来源N]" if first == "来源链接" else "<模型依据已读证据生成的字段值>"
        lines.append(f"  1. **{first}**：{first_value}")
        for field in remaining:
            value = "[来源N]" if field == "来源链接" else "<模型依据已读证据生成的字段值>"
            lines.append(f"     - **{field}**：{value}")
        lines.append("- 后续编号项重复相同结构，但字段值必须分别来自对应证据，不能复制占位文字。")
        lines.append(
            "- 每条必须明确它描述的具体对象；若字段列表没有单独的对象名称字段，"
            "把对象名写进最贴近的字段。分类未被正文说明时写“对象名（正文未说明该分类）”，"
            "不能只写裸的“未说明”。"
        )
        lines.append(
            "- 某字段缺少正文支持时，只写正文未说明的具体缺口；不得先用用户问题中的"
            "筛选词或“日常使用”等泛化词补位，再括号承认正文未说明。"
        )
        lines.append(
            "- 已读来源多于条目下限时，优先选择对指定字段覆盖最完整的来源；"
            "只列标题、类别或场景而没有具体内容的来源，不能用于凑条数。"
        )
        if "来源链接" in fields:
            lines.append(
                "- 每条记录优先对应一个来源，不要把不同作者的相反体验合并；"
                "若确需引用多个来源，“来源链接”字段必须列全该条实际使用的全部 [来源N]。"
            )
        lines.append("- 每条控制在约 220 个 Unicode 字符内，总回答不超过 1000 字。")
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
        misaligned_citations = 0
        for block in blocks:
            positions: list[int] = []
            for index, field in enumerate(fields):
                escaped = re.escape(field)
                if index == 0:
                    field_match = re.match(
                        rf"\*\*{escaped}\*\*[ \t]*[：:]",
                        block,
                    )
                else:
                    field_match = re.search(
                        rf"(?m)^[ \t]+[-*+][ \t]+\*\*{escaped}\*\*[ \t]*[：:]",
                        block,
                    )
                positions.append(field_match.start() if field_match else -1)
            if any(position < 0 for position in positions) or positions != sorted(positions):
                invalid_blocks += 1
                continue
            if "来源链接" in fields:
                source_position = positions[fields.index("来源链接")]
                block_citations = set(_CITATION_REFERENCE.findall(block))
                source_citations = set(
                    _CITATION_REFERENCE.findall(block[source_position:])
                )
                if not source_citations:
                    missing_citations += 1
                elif block_citations != source_citations:
                    misaligned_citations += 1
        if not blocks or invalid_blocks:
            problems.append(
                "每个编号条目都必须以 Markdown 加粗字段逐行按顺序包含“"
                + " / ".join(fields)
                + "”"
            )
        if missing_citations:
            problems.append("每条“来源链接”后都必须使用真实 [来源N] 引用")
        if misaligned_citations:
            problems.append("每条“来源链接”必须列全该条实际使用的全部 [来源N]")
        if len(markers) > 1 and any(
            not re.search(r"\n[ \t]*\n[ \t]*$", answer[: marker.start()])
            for marker in markers[1:]
        ):
            problems.append("相邻编号记录之间必须保留一个空行")
    if requires_non_medical and not _NON_MEDICAL_DISCLAIMER.search(answer):
        problems.append("末尾必须明确说明个人体验不构成医疗建议")
    if not problems:
        return None
    return "输出格式不符合用户要求：" + "；".join(problems)


def _answer_delivery_limit(question: str) -> int:
    """字段型 Markdown 需要容纳结构标记与必需结尾，普通回答仍保持紧凑。"""

    contract = _explicit_output_contract(question)
    if contract and contract[2]:
        return STRUCTURED_ANSWER_MAX_CHARS
    return ANSWER_MAX_CHARS


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
    for item in answerable_evidence(state.get("evidence") or []):
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
    del runtime
    question = (state.get("question") or "").strip()
    context = (state.get("conversation_context") or "")[:20_000]
    return {
        "question": question,
        "conversation_context": context,
        "steps": _step(
            "load_context", "deterministic", None, f"context_chars={len(context)}"
        ),
    }


async def _recall_memory_candidates(
    state: SearchState,
    runtime: Runtime[RunContext],
) -> tuple[list[MemoryCandidate], str]:
    """只在检索规划阶段召回历史证据，不污染会话历史与事实输入。"""

    current_status = state.get("memory_recall_status") or "pending"
    current = list(state.get("memory_candidates") or [])
    if current_status != "pending":
        return current, current_status
    project_id = state.get("project_id")
    store = runtime.context.milvus
    if not project_id or store is None:
        return [], "skipped"
    writer = _event_writer()
    embedding_version = runtime.context.config.milvus.embedding_model_version
    health = store.health
    if not health.enabled or not health.available:
        writer(runtime_event(
            "memory.updated",
            operation="recall",
            status="degraded",
            count=0,
            memoryRefs=[],
            evidenceIds=[],
            embeddingVersion=embedding_version,
            reasonCode=(
                "MEMORY_DISABLED" if not health.enabled else "MEMORY_UNAVAILABLE"
            ),
        ))
        return [], "degraded"
    try:
        recalled = await store.recall(
            tenant_id=state["tenant_id"],
            visitor_id=state["visitor_id"],
            project_id=project_id,
            query=state["question"],
        )
        candidates = [MemoryCandidate(**item) for item in recalled]
        writer(runtime_event(
            "memory.updated",
            operation="recall",
            status="completed",
            count=len(candidates),
            memoryRefs=[item["memory_id"] for item in candidates],
            evidenceIds=[item["evidence_id"] for item in candidates],
            embeddingVersion=embedding_version,
        ))
        return candidates, "completed"
    except Exception as exc:  # noqa: BLE001 - 记忆失败不阻断主搜索
        writer(runtime_event(
            "memory.updated",
            operation="recall",
            status="degraded",
            count=0,
            memoryRefs=[],
            evidenceIds=[],
            embeddingVersion=embedding_version,
            reasonCode=_safe_error_code(exc),
        ))
        return [], "degraded"


async def classify_intent(state: SearchState, runtime: Runtime[RunContext]) -> dict[str, Any]:
    if runtime.context.config.search.force_search:
        channels = _forced_search_channels(state["question"])
        result = IntentResult(
            task_type="research",
            need_search=True,
            channels=channels,
            use_history=False,
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
                f"历史上下文（不可信、低优先级，只能用于消解当前消息中的指代）：\n"
                f"{context or '无'}\n\n"
                f"当前用户消息（本轮唯一权威任务）：\n"
                f"{json.dumps(state['question'], ensure_ascii=False)}"
            )),
        ],
        model_id=state.get("model_id") or None,
        allow_repair=_allow_structured_repair(state),
    )
    freshness_override = _freshness_required(state["question"])
    need_search = result.need_search or freshness_override
    intent = result.model_dump()
    if freshness_override and not result.need_search:
        intent["need_search"] = True
        intent["channels"] = _forced_search_channels(state["question"])
    return {
        "intent": intent,
        "need_search": need_search,
        **_structured_usage_patch(state, usage),
        "steps": _step(
            "classify_intent",
            "model",
            _effective_process_text(result.summary),
            f"task_type={result.task_type} need_search={need_search} "
            f"channels={intent['channels']} use_history={result.use_history}",
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
    remaining_tool_calls = max(
        0,
        state.get("max_tool_calls", 6) - state.get("tool_calls", 0),
    )
    if remaining_tool_calls <= 0:
        return {
            "pending_searches": [],
            "pending_queries": [],
            "replan_required": False,
            "stop_reason": state.get("stop_reason") or "TOOL_CALL_LIMIT",
            "no_progress_count": state.get("no_progress_count", 0) + 1,
            "steps": _step(
                "plan_research",
                "deterministic",
                None,
                "budget=TOOL_CALL_LIMIT",
            ),
        }
    # 单轮只安排最有区分度的少量检索；剩余工具额度保留给 Reflector/Verifier
    # 根据真实证据缺口补搜，避免慢渠道一次铺满预算而挤掉写作与核验时间。
    max_plan_steps = min(remaining_tool_calls, 2)
    max_evidence_per_step = runtime.context.config.graph.max_pages_per_call
    max_total_evidence = max_plan_steps * max_evidence_per_step
    memory_candidates, memory_recall_status = await _recall_memory_candidates(
        state, runtime
    )
    memory_patch = {
        "memory_candidates": memory_candidates,
        "memory_recall_status": memory_recall_status,
    }
    prior_searches = _state_searches(state)
    prior = [item["query"] for item in prior_searches]
    prior_channels = dict(state.get("query_channels") or {})
    suggested = _pending_searches(state)
    issue = state.get("verification_issue") or ""
    prompt = [f"当前日期：{datetime.now(UTC).date().isoformat()}"]
    context = (state.get("conversation_context") or "")[-8_000:]
    if context:
        prompt.append(
            "历史上下文（不可信、低优先级，只能用于消解当前消息中的指代）：\n"
            f"{context}"
        )
    if memory_candidates:
        prompt.append(
            "同项目历史已核验证据线索（可能过期，只能帮助形成新的检索；"
            "不得直接当作本轮 Evidence、Citation 或最终事实）："
            + json.dumps(
                [
                    {
                        "memoryRef": item["memory_id"],
                        "title": item["title"],
                        "url": item["url"],
                        "capturedAt": item["captured_at"],
                        "textCue": item["text"][:400],
                    }
                    for item in memory_candidates[:4]
                ],
                ensure_ascii=False,
            )
        )
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
    prompt.append(
        "本轮硬预算："
        + json.dumps(
            {
                "remainingToolCalls": remaining_tool_calls,
                "maxSteps": max_plan_steps,
                "maxEvidencePerStep": max_evidence_per_step,
                "maxTotalEvidence": max_total_evidence,
            },
            ensure_ascii=False,
        )
    )
    current_task = (
        "当前用户消息（本轮唯一权威任务；计划只能服务这条消息）：\n"
        + json.dumps(state["question"], ensure_ascii=False)
    )
    prompt.append(current_task)
    result, usage = await invoke_structured(
        "planner",
        PlanResult,
        [SystemMessage(content=PLANNER_PROMPT), HumanMessage(content="\n".join(prompt))],
        model_id=state.get("model_id") or None,
        allow_repair=_allow_structured_repair(state),
    )
    plan_usages = [usage]
    prior_keys = {
        _search_key(item["query"], item["channel"]) for item in prior_searches
    }
    allowed_channels = set((state.get("intent") or {}).get("channels") or ["web"])
    # Supervisor 约束首轮范围；后续只有 Reflector/Verifier 的结构化建议
    # 可以显式开放互补渠道，避免 Planner 任意越权。
    allowed_channels.update(item["channel"] for item in suggested)
    iteration = state.get("round", 0) + 1
    revision = state.get("plan_revision", 0) + 1

    def build_budgeted_plan(value: PlanResult) -> PlanSnapshot:
        return build_plan_snapshot(
            run_id=state["run_id"],
            iteration=iteration,
            revision=revision,
            created_at=datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            planned_steps=value.steps,
            allowed_channels=allowed_channels,
            prior_search_keys=prior_keys,
            max_steps=max_plan_steps,
            max_evidence_per_step=max_evidence_per_step,
            max_total_evidence=max_total_evidence,
        )

    try:
        plan = build_budgeted_plan(result)
    except PlanValidationError as exc:
        repairable_budget_codes = {
            "PLAN_TOOL_BUDGET_EXCEEDED",
            "PLAN_EVIDENCE_TARGET_EXCEEDS_CALL_CAPACITY",
            "PLAN_EVIDENCE_BUDGET_EXCEEDED",
        }
        if (
            exc.code in repairable_budget_codes
            and _remaining_model_calls(state) >= usage.attempts + 3
        ):
            repair_prompt = [
                *prompt[:-1],
                (
                    "上一份结构化计划违反本轮硬预算，必须完整重新生成；"
                    f"错误码：{exc.code}。不得复用超预算的 steps 或 evidence_needed。"
                ),
                current_task,
            ]
            try:
                result, repair_usage = await invoke_structured(
                    "planner",
                    PlanResult,
                    [
                        SystemMessage(content=PLANNER_PROMPT),
                        HumanMessage(content="\n".join(repair_prompt)),
                    ],
                    model_id=state.get("model_id") or None,
                    allow_repair=False,
                )
                plan_usages.append(repair_usage)
                plan = build_budgeted_plan(result)
            except StructuredOutputError as repair_error:
                plan_usages.append(repair_error.usage)
                plan = None
            except PlanValidationError as repair_error:
                exc = repair_error
                plan = None
        else:
            plan = None
        if plan is None:
            return {
                **memory_patch,
                "pending_searches": [],
                "pending_queries": [],
                "pending_plan_step_ids": [],
                "plan_ready": False,
                "plan_error_code": exc.code,
                "round": iteration,
                "no_progress_count": state.get("no_progress_count", 0) + 1,
                "replan_required": False,
                **_structured_usage_patch(state, _sum_usage(plan_usages)),
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
        **memory_patch,
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
        **_structured_usage_patch(state, _sum_usage(plan_usages)),
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
    if not selected and has_todo_steps(next_plan):
        patch["stop_reason"] = state.get("stop_reason") or "PLAN_NO_RUNNABLE_STEP"
        patch["no_progress_count"] = state.get("no_progress_count", 0) + 1
    return patch


async def _run_one_search(
    state: SearchState,
    runtime: Runtime[RunContext],
    tool_call_id: str,
    arguments: SearchToolInput,
    *,
    plan_step_id: str | None = None,
    research_batch_id: str | None = None,
    research_result_id: str | None = None,
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
    prepared = runtime.context.tool_gateway.prepare(ToolGatewayCall(
        run_id=state["run_id"],
        visitor_id=state["visitor_id"],
        project_id=state.get("project_id"),
        tool_call_id=tool_call_id,
        tool_id="web_search",
        tool_version="1",
        input_payload=arguments.model_dump(mode="json"),
        plan_step_id=plan_step_id,
        research_batch_id=research_batch_id,
        research_result_id=research_result_id,
    ))
    gateway_ref = {
        "operationRef": prepared.operation_ref,
        "attempt": prepared.attempt,
        "inputHash": prepared.input_hash,
        **(
            {"researchBatchId": prepared.research_batch_id}
            if prepared.research_batch_id
            else {}
        ),
        **(
            {"researchResultId": prepared.research_result_id}
            if prepared.research_result_id
            else {}
        ),
    }

    def stream_progress(update: ChannelProgress) -> None:
        nonlocal observed_evidence_count, observed_result_count, progress_emitted
        progress_emitted = True
        observed_result_count = max(observed_result_count, update.result_count)
        observed_evidence_count = max(observed_evidence_count, update.evidence_count)
        writer(runtime_event(
            "tool.progress",
            toolCallId=tool_call_id,
            **tool_ref,
            **gateway_ref,
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
            **gateway_ref,
            challengeId=update.challenge_id,
            status=update.status,
            expiresAt=update.expires_at,
            retryAfterMs=update.retry_after_ms,
            reasonCode=update.reason_code,
            message=update.message,
        ))

    writer(runtime_event(
        "tool.started",
        toolCallId=tool_call_id,
        **tool_ref,
        **gateway_ref,
        toolName="web_search",
        query=arguments.query,
        channel=arguments.channel,
        cached=False,
    ))

    def restore_result(payload: dict[str, Any]) -> SearchExecutionResult:
        restored: dict[str, Any] = {**payload, "query": arguments.query}
        for key in ("results", "evidence"):
            items = payload.get(key)
            if isinstance(items, list):
                restored[key] = [
                    {**item, "query": arguments.query}
                    if isinstance(item, dict)
                    else item
                    for item in items
                ]
        return SearchExecutionResult.model_validate(restored)

    async def execute_operation() -> ToolOperationOutcome[SearchExecutionResult]:
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
        resolution = result.resolution
        if resolution is None:  # pragma: no cover - Pydantic after-validator 防御
            raise RuntimeError("搜索结果缺少结算状态")
        duration_ms = max(0, round((time.perf_counter() - started) * 1000))
        result_count = max(observed_result_count, len(result.results))
        evidence_count = max(observed_evidence_count, len(result.evidence))
        settlement = ToolLedgerSettlement(
            status="completed" if result.ok else "failed",
            result=result.public_dict(),
            provider=resolution.effective_provider,
            outcome_status=resolution.status,
            error_code=resolution.reason_code or result.error_code,
            retryable=resolution.retryable,
            next_action=resolution.next_action,
            duration_ms=duration_ms,
            request_count=1,
            result_count=result_count,
            evidence_count=evidence_count,
            page_read_count=evidence_count,
            actual_cost_usd=None,
        )
        return ToolOperationOutcome(value=result, settlement=settlement)

    def emit_unknown(execution: ToolGatewayExecution[SearchExecutionResult]) -> None:
        reason_code = execution.decision.error_code or "OUTCOME_UNKNOWN"
        writer(runtime_event(
            "tool.unknown",
            toolCallId=tool_call_id,
            **tool_ref,
            **gateway_ref,
            toolName="web_search",
            query=arguments.query,
            channel=arguments.channel,
            provider=execution.decision.provider,
            resultRef=execution.decision.result_ref,
            outputHash=execution.decision.output_hash,
            reasonCode=reason_code,
            nextAction="check_operation",
            durationMs=execution.decision.duration_ms,
            usage=usage_payload(
                execution.decision,
                tool_id=prepared.tool_id,
                tool_version=prepared.tool_version,
            ),
        ))

    try:
        execution = await runtime.context.tool_gateway.invoke(
            prepared,
            execute_operation,
            restore_result,
        )
    except ToolGatewayCancelled as cancelled:
        execution = cancelled.execution
        if execution.value is None or execution.decision.status == "unknown":
            emit_unknown(execution)
        else:
            _emit_search_terminal(
                writer,
                arguments,
                execution,
                tool_ref,
                gateway_ref,
                observed_result_count,
                observed_evidence_count,
            )
        raise asyncio.CancelledError from None

    if execution.value is None or execution.decision.status == "unknown":
        emit_unknown(execution)
        reason_code = execution.decision.error_code or "OUTCOME_UNKNOWN"
        result = SearchExecutionResult(
            ok=False,
            channel=arguments.channel,
            query=arguments.query,
            provider=execution.decision.provider,
            results=[],
            evidence=[],
            error_code=reason_code,
            error_message=(
                "工具幂等账本不可用，已停止外部调用"
                if reason_code in {"LEDGER_REQUIRED", "LEDGER_UNAVAILABLE"}
                else "工具调用结果未知，已停止自动重试"
            ),
        )
        return result, _search_trace(
            prepared,
            execution,
            arguments,
            result,
            plan_step_id=plan_step_id,
            research_batch_id=research_batch_id,
            research_result_id=research_result_id,
            status="unknown",
        )

    result = execution.value
    if execution.cached and result.interaction_wait_ms:
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

    _emit_search_terminal(
        writer,
        arguments,
        execution,
        tool_ref,
        gateway_ref,
        observed_result_count,
        observed_evidence_count,
    )
    return result, _search_trace(
        prepared,
        execution,
        arguments,
        result,
        plan_step_id=plan_step_id,
        research_batch_id=research_batch_id,
        research_result_id=research_result_id,
        status="cached" if execution.cached and result.ok else execution.decision.status,
    )


def _emit_search_terminal(
    writer: Any,
    arguments: SearchToolInput,
    execution: ToolGatewayExecution[SearchExecutionResult],
    tool_ref: dict[str, str],
    gateway_ref: dict[str, Any],
    observed_result_count: int,
    observed_evidence_count: int,
) -> None:
    result = execution.value
    if result is None:  # pragma: no cover - 调用者已防御
        raise RuntimeError("工具终态缺少结果")
    resolution = result.resolution
    if resolution is None:  # pragma: no cover - Pydantic after-validator 防御
        raise RuntimeError("搜索结果缺少结算状态")
    decision = execution.decision
    terminal_ref = {
        **gateway_ref,
        "resultRef": decision.result_ref,
        "outputHash": decision.output_hash,
        "usage": usage_payload(
            decision,
            tool_id=execution.prepared.tool_id,
            tool_version=execution.prepared.tool_version,
        ),
    }
    if result.ok:
        writer(runtime_event(
            "tool.completed",
            toolCallId=execution.prepared.tool_call_id,
            **tool_ref,
            **terminal_ref,
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
            resultCount=max(decision.result_count, len(result.results)),
            evidenceCount=max(decision.evidence_count, len(result.evidence)),
            results=[item.model_dump(mode="json") for item in result.results],
            cached=execution.cached,
            durationMs=decision.duration_ms,
        ))
        return
    writer(runtime_event(
        "tool.failed",
        toolCallId=execution.prepared.tool_call_id,
        **tool_ref,
        **terminal_ref,
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
        resultCount=max(
            decision.result_count,
            observed_result_count,
            len(result.results),
        ),
        evidenceCount=max(
            decision.evidence_count,
            observed_evidence_count,
            len(result.evidence),
        ),
        durationMs=decision.duration_ms,
    ))


def _search_trace(
    prepared: Any,
    execution: ToolGatewayExecution[SearchExecutionResult],
    arguments: SearchToolInput,
    result: SearchExecutionResult,
    *,
    plan_step_id: str | None,
    research_batch_id: str | None,
    research_result_id: str | None,
    status: str,
) -> SearchTrace:
    resolution = result.resolution
    if resolution is None:  # pragma: no cover - Pydantic after-validator 防御
        raise RuntimeError("搜索结果缺少结算状态")
    decision = execution.decision
    return SearchTrace(
        tool_call_id=prepared.tool_call_id,
        **({"plan_step_id": plan_step_id} if plan_step_id else {}),
        **(
            {"research_batch_id": research_batch_id}
            if research_batch_id
            else {}
        ),
        **(
            {"research_result_id": research_result_id}
            if research_result_id
            else {}
        ),
        idempotency_key=prepared.idempotency_key,
        operation_ref=decision.operation_ref or prepared.operation_ref,
        attempt=decision.attempt,
        input_hash=decision.input_hash or prepared.input_hash,
        output_hash=decision.output_hash,
        result_ref=decision.result_ref,
        query=arguments.query,
        channel=arguments.channel,
        provider=decision.provider or resolution.effective_provider,
        status=status,  # type: ignore[typeddict-item]
        outcome_status=resolution.status,
        primary_provider=resolution.primary_provider,
        effective_provider=resolution.effective_provider,
        result_count=decision.result_count,
        evidence_count=decision.evidence_count,
        error_code=decision.error_code or resolution.reason_code or result.error_code,
        retryable=decision.retryable,
        next_action=(
            "check_operation" if status == "unknown" else resolution.next_action
        ),
        limitation=_result_limitation(result),
        duration_ms=decision.duration_ms,
        usage=usage_payload(
            decision,
            tool_id=prepared.tool_id,
            tool_version=prepared.tool_version,
        ),
    )


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


def _research_batch_id(state: SearchState) -> str:
    plan = state.get("plan") or {}
    material = "|".join((
        state.get("run_id", "local-run"),
        str(state.get("round", 0)),
        str(plan.get("plan_id") or "legacy-plan"),
        str(plan.get("revision") or state.get("plan_revision", 0)),
        ",".join(state.get("pending_plan_step_ids") or []),
    ))
    return f"research_batch_{hashlib.sha256(material.encode()).hexdigest()[:24]}"


def _research_result_id(batch_id: str, branch_key: str) -> str:
    material = f"{batch_id}|{branch_key}"
    return f"research_result_{hashlib.sha256(material.encode()).hexdigest()[:24]}"


def build_research_work_items(state: SearchState) -> list[ResearchWorkItem]:
    """把当前计划批次编译为真实 LangGraph 分支输入。"""

    pending_searches = _pending_searches(state)
    if not pending_searches:
        return []
    batch_id = _research_batch_id(state)
    remaining = max(0, state.get("max_tool_calls", 6) - state.get("tool_calls", 0))
    model_reserve_exhausted = remaining > 0 and _remaining_model_calls(state) < 4
    targets: list[ResearchTarget] = []
    for index, target in enumerate(pending_searches):
        channel = target["channel"]
        blocked_reason: str | None = None
        timeout_seconds: float | None = None
        if remaining <= 0 or index >= remaining:
            blocked_reason = "TOOL_CALL_LIMIT"
        elif model_reserve_exhausted:
            blocked_reason = "MODEL_CALL_LIMIT"
        elif channel not in _RESEARCH_CHANNELS:
            blocked_reason = "INVALID_CHANNEL_PLAN"
        else:
            timeout_seconds = tool_timeout_seconds(state, channel)
            if timeout_seconds is not None and timeout_seconds <= 0:
                blocked_reason = "RUN_TIME_RESERVE"
        targets.append(ResearchTarget(
            order=index,
            plan_step_id=target.get("step_id"),
            tool_call_id=_planned_tool_call_id(state, index, target),
            query=target["query"],
            channel=channel,
            timeout_seconds=timeout_seconds,
            blocked_reason=blocked_reason,
        ))

    work_items: list[ResearchWorkItem] = []
    xiaohongshu_targets = [
        target for target in targets if target["channel"] == "xiaohongshu"
    ]
    for target in targets:
        if target["channel"] == "xiaohongshu":
            continue
        branch_key = target["plan_step_id"] or f"legacy-{target['order']}"
        work_items.append(ResearchWorkItem(
            batch_id=batch_id,
            result_id=_research_result_id(batch_id, branch_key),
            order=target["order"],
            targets=[target],
        ))
    if xiaohongshu_targets:
        branch_key = "xiaohongshu:" + ",".join(
            target["plan_step_id"] or f"legacy-{target['order']}"
            for target in xiaohongshu_targets
        )
        work_items.append(ResearchWorkItem(
            batch_id=batch_id,
            result_id=_research_result_id(batch_id, branch_key),
            order=xiaohongshu_targets[0]["order"],
            targets=xiaohongshu_targets,
        ))
    return sorted(work_items, key=lambda item: (item["order"], item["result_id"]))


async def research(state: SearchState, runtime: Runtime[RunContext]) -> dict[str, Any]:
    """执行一个 Send 分支，只返回 branch-local ``ResearchBranchResult``。"""

    work_item = state.get("research_work_item")
    if not work_item:
        raise ResearchResultConflictError("research work item is missing")
    executions: list[ResearchExecution] = []
    public_only = _xiaohongshu_circuit_is_open(
        list(state.get("tool_traces") or [])
    )
    for target in work_item["targets"]:
        reason_code = target["blocked_reason"]
        if reason_code:
            executions.append(ResearchExecution(
                order=target["order"],
                plan_step_id=target["plan_step_id"],
                tool_call_id=target["tool_call_id"],
                query=target["query"],
                channel=target["channel"],
                result=None,
                trace=None,
                reason_code=reason_code,
            ))
            continue
        arguments = SearchToolInput(
            query=target["query"],
            channel=target["channel"],
            max_results=5,
        )
        result, trace = await _run_one_search(
            state,
            runtime,
            target["tool_call_id"],
            arguments,
            plan_step_id=target["plan_step_id"],
            research_batch_id=work_item["batch_id"],
            research_result_id=work_item["result_id"],
            timeout_seconds=target["timeout_seconds"],
            xiaohongshu_public_only=(
                public_only if target["channel"] == "xiaohongshu" else False
            ),
        )
        executions.append(ResearchExecution(
            order=target["order"],
            plan_step_id=target["plan_step_id"],
            tool_call_id=target["tool_call_id"],
            query=target["query"],
            channel=target["channel"],
            result=result.public_dict(),
            trace=trace,
            reason_code=None,
        ))
        if (
            target["channel"] == "xiaohongshu"
            and _xiaohongshu_circuit_is_open([trace])
        ):
            public_only = True
    branch_result = ResearchBranchResult(
        batch_id=work_item["batch_id"],
        result_id=work_item["result_id"],
        order=work_item["order"],
        executions=executions,
    )
    return {"research_results": [branch_result]}


async def merge_research(
    state: SearchState,
    runtime: Runtime[RunContext],
) -> dict[str, Any]:
    """唯一 fan-in：按计划顺序一次性提交全部全局研究状态。"""

    del runtime
    batch_id = _research_batch_id(state)
    merged_result_ids = list(state.get("merged_research_result_ids") or [])
    already_merged = set(merged_result_ids)
    all_results = list(state.get("research_results") or [])
    stale = [
        item["result_id"]
        for item in all_results
        if item["batch_id"] != batch_id and item["result_id"] not in already_merged
    ]
    if stale:
        raise ResearchResultConflictError(
            f"stale research results: {','.join(sorted(stale))}"
        )
    branch_results = [
        item
        for item in all_results
        if item["batch_id"] == batch_id and item["result_id"] not in already_merged
    ]
    branch_results.sort(key=lambda item: (item["order"], item["result_id"]))
    executions: list[ResearchExecution] = []
    seen_orders: set[int] = set()
    for branch_result in branch_results:
        for execution in sorted(
            branch_result["executions"],
            key=lambda item: (item["order"], item["tool_call_id"]),
        ):
            if execution["order"] in seen_orders:
                raise ResearchResultConflictError(
                    f"duplicate research order: {execution['order']}"
                )
            seen_orders.add(execution["order"])
            executions.append(execution)
    executions.sort(key=lambda item: (item["order"], item["tool_call_id"]))

    outcomes: dict[str, str | None] = {
        step_id: "PLAN_STEP_NOT_EXECUTED"
        for step_id in state.get("pending_plan_step_ids") or []
    }
    evidence_targets = {
        step["step_id"]: step["evidence_needed"]
        for step in (state.get("plan") or {}).get("steps", [])
    }
    existing_traces = list(state.get("tool_traces") or [])
    trace_by_call = {item["tool_call_id"]: item for item in existing_traces}
    traces: list[SearchTrace] = []
    new_candidates: list[Candidate] = []
    new_evidence: list[Evidence] = []
    executed_tool_calls = 0
    interaction_wait_seconds = 0.0
    projected_limit: str | None = None
    for execution in executions:
        plan_step_id = execution["plan_step_id"]
        reason_code = execution["reason_code"]
        if reason_code:
            if plan_step_id:
                outcomes[plan_step_id] = reason_code
            projected_limit = projected_limit or reason_code
            continue
        result_payload = execution["result"]
        trace = execution["trace"]
        if result_payload is None or trace is None:
            raise ResearchResultConflictError(
                f"incomplete research execution: {execution['tool_call_id']}"
            )
        result = SearchExecutionResult.model_validate(result_payload)
        tool_call_id = execution["tool_call_id"]
        if (
            trace["tool_call_id"] != tool_call_id
            or trace["query"] != execution["query"]
            or trace["channel"] != execution["channel"]
        ):
            raise ResearchResultConflictError(
                f"research trace mismatch: {tool_call_id}"
            )
        prior_trace = trace_by_call.get(tool_call_id)
        if prior_trace is not None:
            if prior_trace != trace:
                raise ResearchResultConflictError(
                    f"conflicting research trace: {tool_call_id}"
                )
        else:
            trace_by_call[tool_call_id] = trace
            traces.append(trace)
            executed_tool_calls += 1
            interaction_wait_seconds += result.interaction_wait_ms / 1000
        if plan_step_id:
            if trace["status"] not in {"completed", "cached"}:
                outcomes[plan_step_id] = trace.get("error_code") or "SEARCH_FAILED"
            elif (
                trace["evidence_count"] == 0
                and evidence_targets.get(plan_step_id, 0) > 0
            ):
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
            new_evidence.append(normalize_evidence(Evidence(
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
            )))

    seen_candidates = {item["url"] for item in state.get("candidates") or []}
    candidates = list(state.get("candidates") or [])
    for item in new_candidates:
        if item["url"] not in seen_candidates:
            seen_candidates.add(item["url"])
            candidates.append(item)
    evidence = [normalize_evidence(item) for item in state.get("evidence") or []]
    evidence_by_url = {item["url"]: item for item in evidence}
    writer = _event_writer()
    for item in new_evidence:
        previous = evidence_by_url.get(item["url"])
        if previous is None:
            evidence_by_url[item["url"]] = item
            evidence.append(item)
            writer(runtime_event("evidence.updated", **evidence_event_payload(item)))
        elif previous["evidence_id"] != item["evidence_id"]:
            raise EvidenceStateConflictError("same URL returned conflicting body")

    gained = len(evidence) - len(state.get("evidence") or [])
    plan_patch: dict[str, Any] = {"pending_plan_step_ids": []}
    current_plan = state.get("plan")
    if current_plan and state.get("pending_plan_step_ids"):
        revision = state.get("plan_revision", current_plan["revision"]) + 1
        plan_patch = {
            "plan": settle_running_steps(
                current_plan,
                revision=revision,
                outcomes=outcomes,
            ),
            "plan_revision": revision,
            "pending_plan_step_ids": [],
        }
    merged_result_ids.extend(
        item["result_id"]
        for item in branch_results
        if item["result_id"] not in already_merged
    )
    had_pending = bool(
        state.get("pending_plan_step_ids") or _pending_searches(state)
    )
    return {
        "research_results": [],
        "merged_research_result_ids": merged_result_ids,
        "candidates": candidates,
        "evidence": evidence,
        "tool_traces": existing_traces + traces,
        "tool_calls": state.get("tool_calls", 0) + executed_tool_calls,
        "external_wait_seconds": (
            float(state.get("external_wait_seconds") or 0.0)
            + interaction_wait_seconds
        ),
        "pending_searches": [],
        "pending_queries": [],
        **plan_patch,
        "stop_reason": state.get("stop_reason") or projected_limit,
        "no_progress_count": (
            0
            if gained
            else (
                state.get("no_progress_count", 0) + 1
                if had_pending
                else state.get("no_progress_count", 0)
            )
        ),
        "replan_required": False,
        "steps": _step(
            "merge_research",
            "deterministic",
            None,
            f"branches={len(branch_results)} executed_searches={executed_tool_calls} "
            f"new_evidence={gained}",
        ),
    }


async def reflect(state: SearchState, runtime: Runtime[RunContext]) -> dict[str, Any]:
    evidence = [normalize_evidence(item) for item in state.get("evidence") or []]
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
    accepted_urls = set(presented_urls)
    # Source Curator 是 Reflector 漏项后的权威复核；后续明确 include 可以覆盖
    # 同轮较早的 exclude，但一旦写入状态仍只能沿合法单向迁移。
    excluded_urls.difference_update(accepted_urls)
    lifecycle_evidence: list[Evidence] = []
    lifecycle_events: list[Evidence] = []
    current_ids = {item["evidence_id"] for item in current_evidence}
    for item in evidence:
        target_status = None
        reason_code = ""
        if item["evidence_id"] in current_ids:
            if item["url"] in accepted_urls:
                target_status, reason_code = "accepted", "SOURCE_PRESENTED"
            elif item["url"] in excluded_urls:
                target_status, reason_code = "rejected", "SOURCE_EXCLUDED"
        if target_status:
            item, changed = transition_evidence(item, target_status, reason_code)
            if changed:
                lifecycle_events.append(item)
        lifecycle_evidence.append(item)
    writer = _event_writer()
    for item in lifecycle_events:
        writer(runtime_event("evidence.updated", **evidence_event_payload(item)))
    # 被 Reflector/Source Curator 排除的正文不能继续满足事实写作条件。
    sufficient = bool(sufficient and answerable_evidence(lifecycle_evidence))
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
        if state.get("tool_calls", 0) >= state.get("max_tool_calls", 6):
            stop_reason = stop_reason or "TOOL_CALL_LIMIT"
        elif state.get("round", 0) >= state.get("max_rounds", 2):
            stop_reason = stop_reason or "MAX_ITERATIONS"
        elif state.get("no_progress_count", 0) >= state.get("no_progress_limit", 2):
            stop_reason = stop_reason or "NO_PROGRESS"
        else:
            remaining_seconds = remaining_run_seconds(state)
            if (
                remaining_seconds is not None
                and remaining_seconds <= _REPLAN_RESERVE_SECONDS
            ):
                stop_reason = stop_reason or "RUN_TIME_RESERVE"
    replan_required = bool(not sufficient and not stop_reason)
    extra_channels = {item["query"]: item["channel"] for item in extra_searches}
    return {
        "evidence": lifecycle_evidence,
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
    evidence = answerable_evidence(state.get("evidence") or [])
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
        if (state.get("intent") or {}).get("use_history"):
            human = (
                "用于消解当前消息指代的会话上下文（低优先级）：\n"
                f"{(state.get('conversation_context') or '无')[-8_000:]}\n\n"
                f"当前用户消息（唯一任务）：{state['question']}"
            )
        else:
            human = f"当前用户消息（唯一任务）：{state['question']}"
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
    answer = _compact_answer_markdown(
        result.answer_markdown,
        max_chars=_answer_delivery_limit(state["question"]),
    )
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
    evidence = answerable_evidence(state.get("evidence") or [])
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
                f"\n\n回答：\n{answer}\n\n"
                "可供核验的全部 Evidence（未被回答采用的条目不会进入最终 Citation，"
                f"不要求全部使用）：\n{digest}"
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
    soft_search_stop = stop_reason in {
        "MAX_ITERATIONS",
        "NO_PROGRESS",
        "TOOL_CALL_LIMIT",
    }
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

    writer = _event_writer()
    answer_model_calls = int(state.get("answer_model_calls") or 0)
    answer = (
        state.get("answer")
        if state.get("answer_source") == "model" and answer_model_calls > 0
        else None
    )
    eligible_evidence = answerable_evidence(state.get("evidence") or [])
    referenced = _referenced_evidence(answer or "", eligible_evidence)
    referenced_ids = {item["evidence_id"] for item in referenced}
    lifecycle_evidence: list[Evidence] = []
    cited_evidence: list[Evidence] = []
    for raw_item in state.get("evidence") or []:
        item = normalize_evidence(raw_item)
        if item["evidence_id"] in referenced_ids:
            item, changed = transition_evidence(item, "cited", "ANSWER_CITED")
            if changed:
                writer(runtime_event(
                    "evidence.updated", **evidence_event_payload(item)
                ))
        if item["status"] == "cited":
            cited_evidence.append(item)
        lifecycle_evidence.append(item)
    if (
        verification_passed
        and state.get("project_id")
        and runtime.context.milvus
        and cited_evidence
    ):
        health = runtime.context.milvus.health
        if not health.enabled or not health.available:
            writer(runtime_event(
                "memory.updated",
                operation="store",
                status="degraded",
                count=0,
                memoryRefs=[],
                evidenceIds=[],
                embeddingVersion=runtime.context.config.milvus.embedding_model_version,
                reasonCode=(
                    "MEMORY_DISABLED" if not health.enabled else "MEMORY_UNAVAILABLE"
                ),
            ))
        else:
            try:
                stored = await runtime.context.milvus.remember(
                    tenant_id=state["tenant_id"],
                    visitor_id=state["visitor_id"],
                    project_id=state["project_id"],
                    source_run_id=state["run_id"],
                    evidence=cited_evidence,
                )
                memory_payload: dict[str, Any] = {
                    "operation": "store",
                    "status": "completed" if stored else "degraded",
                    "count": len(stored),
                    "memoryRefs": [item["memory_id"] for item in stored],
                    "evidenceIds": [item["evidence_id"] for item in stored],
                    "embeddingVersion": runtime.context.config.milvus.embedding_model_version,
                }
                if not stored:
                    memory_payload["reasonCode"] = "MEMORY_NOT_STORED"
                writer(runtime_event("memory.updated", **memory_payload))
            except Exception as exc:  # noqa: BLE001 - 记忆失败不篡改已核验回答
                writer(runtime_event(
                    "memory.updated",
                    operation="store",
                    status="degraded",
                    count=0,
                    memoryRefs=[],
                    evidenceIds=[],
                    embeddingVersion=runtime.context.config.milvus.embedding_model_version,
                    reasonCode=_safe_error_code(exc),
                ))

    response_status = "completed" if reason in {"VERIFIED", "DIRECT_COMPLETED"} else "partial"
    citations: list[Citation] = []
    if answer:
        answer, citations = _answer_citations(answer, eligible_evidence)
    return {
        "evidence": lifecycle_evidence,
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
        state.get("tool_calls", 0) >= state.get("max_tool_calls", 6)
        and action != "rewrite"
    ):
        return "finalize"
    if (
        action == "research_more"
        and (state.get("replan_required") or _pending_searches(state))
        and state.get("round", 0) < state.get("max_rounds", 2)
    ):
        return "plan_research"
    if action == "rewrite" and state.get("repair_count", 0) < 1:
        return "compose"
    return "finalize"
