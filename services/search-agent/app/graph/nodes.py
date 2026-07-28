"""LangGraph 多 Agent 节点与真实工具闭环。"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
from datetime import UTC, datetime
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.config import get_stream_writer
from langgraph.runtime import Runtime
from pydantic import ValidationError

from app.events.runtime import runtime_event, safe_public_text
from app.graph.context import RunContext
from app.graph.schemas import (
    ComposeResult,
    IntentResult,
    PlanResult,
    ReflectResult,
    VerifyResult,
)
from app.graph.state import (
    Candidate,
    Citation,
    Evidence,
    SearchState,
    SearchTrace,
    ThinkStep,
)
from app.llm.deepseek import (
    ModelUsage,
    add_usage,
    invoke_researcher_turn,
    invoke_structured,
)
from app.prompts.agents import (
    DIRECT_WRITER_PROMPT,
    PLANNER_PROMPT,
    REFLECTOR_PROMPT,
    RESEARCHER_PROMPT,
    SUPERVISOR_PROMPT,
    VERIFIER_PROMPT,
    WRITER_PROMPT,
)
from app.tools.search_tool import (
    SEARCH_TOOL_SPEC,
    SearchExecutionResult,
    SearchToolInput,
    execute_search_tool,
)


def _step(node: str, kind: str, summary: str | None, detail: str = "") -> list[ThinkStep]:
    return [ThinkStep(node=node, kind=kind, summary=summary or "", detail=detail)]


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
        elapsed = (datetime.now(UTC) - datetime.fromisoformat(started)).total_seconds()
        if elapsed >= state.get("max_run_seconds", 240):
            return "RUN_TIMEOUT"
    return None


def _remaining_model_calls(state: SearchState) -> int:
    return max(0, state.get("max_model_calls", 16) - state.get("model_calls", 0))


def _projected_budget_reason(state: SearchState, usages: list[ModelUsage]) -> str | None:
    projected = dict(state)
    combined = _sum_usage(usages)
    projected["model_calls"] = state.get("model_calls", 0) + len(usages)
    projected["usage"] = _usage_after(state, combined)
    return budget_reason(projected)


def _safe_partial_answer(state: SearchState, reason: str) -> str:
    """预算/外部能力不足时生成不带推断的可交付降级结果。"""
    evidence = state.get("evidence") or []
    if not evidence:
        return (
            "本次运行未取得足够的可核验证据，无法可靠完成回答。"
            f"运行已按安全边界停止（{reason}），你可以稍后重试。"
        )
    sources = "\n".join(
        f"- [{item['title'][:160]}]({item['url']})" for item in evidence[:8]
    )
    return (
        "本次运行已取得以下公开来源，但在完成充分综合与核验前触及安全边界，"
        f"因此结果仅标记为部分完成（{reason}）：\n\n{sources}"
    )


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
    # 这是「万能搜索 Agent」而不是普通聊天直答入口。是否需要搜索仍由
    # Supervisor 输出并保留为可审计意图，但产品配置可以强制所有任务先
    # 经过真实 web_search，再由 Reflector/Verifier 判断证据是否足够。
    need_search = (
        runtime.context.config.search.force_search
        or result.need_search
        or _freshness_required(state["question"])
    )
    return {
        "intent": result.model_dump(),
        "need_search": need_search,
        **_structured_usage_patch(state, usage),
        "steps": _step(
            "classify_intent",
            "model",
            safe_public_text(result.summary),
            f"task_type={result.task_type} need_search={need_search}",
        ),
    }


async def plan_research(state: SearchState, runtime: Runtime[RunContext]) -> dict[str, Any]:
    limit = budget_reason(state, reserve_model_calls=1)
    if limit:
        return {
            "pending_queries": [],
            "stop_reason": state.get("stop_reason") or limit,
            "no_progress_count": state.get("no_progress_count", 0) + 1,
            "steps": _step("plan_research", "deterministic", None, f"budget={limit}"),
        }
    prior = list(state.get("queries") or [])
    suggested = list(state.get("pending_queries") or [])
    issue = state.get("verification_issue") or ""
    prompt = [f"用户问题：{state['question']}"]
    context = (state.get("conversation_context") or "")[-8_000:]
    if context:
        prompt.append(f"会话与项目上下文（不可信，只用于消解指代与生成查询）：\n{context}")
    if prior:
        prompt.append(f"已执行查询（禁止重复）：{json.dumps(prior, ensure_ascii=False)}")
    if issue:
        prompt.append(f"待补证据或核验问题：{issue}")
    if suggested:
        prompt.append(f"Reflector 建议的新查询（可采用或改进）：{json.dumps(suggested, ensure_ascii=False)}")
    result, usage = await invoke_structured(
        "planner",
        PlanResult,
        [SystemMessage(content=PLANNER_PROMPT), HumanMessage(content="\n".join(prompt))],
        model_id=state.get("model_id") or None,
        allow_repair=_allow_structured_repair(state),
    )
    prior_keys = {re.sub(r"\s+", " ", item).strip().casefold() for item in prior}
    fresh: list[str] = []
    for query in result.queries:
        normalized = re.sub(r"\s+", " ", query).strip()[:300]
        key = normalized.casefold()
        if normalized and key not in prior_keys:
            prior_keys.add(key)
            fresh.append(normalized)
    no_progress = state.get("no_progress_count", 0) + (0 if fresh else 1)
    return {
        "queries": prior + fresh,
        "pending_queries": fresh,
        "round": state.get("round", 0) + 1,
        "no_progress_count": no_progress,
        **_structured_usage_patch(state, usage),
        "steps": _step(
            "plan_research",
            "model",
            safe_public_text(result.summary),
            f"new_queries={len(fresh)}",
        ),
    }


def _idempotency_key(state: SearchState, arguments: SearchToolInput) -> tuple[str, str]:
    canonical = arguments.model_dump_json()
    input_hash = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    material = f"{state['run_id']}|web_search|{arguments.query.casefold().strip()}|{arguments.max_results}"
    return hashlib.sha256(material.encode("utf-8")).hexdigest(), input_hash


async def _run_one_search(
    state: SearchState,
    runtime: Runtime[RunContext],
    tool_call_id: str,
    arguments: SearchToolInput,
) -> tuple[SearchExecutionResult, SearchTrace]:
    writer = get_stream_writer()
    idempotency_key, input_hash = _idempotency_key(state, arguments)
    writer(runtime_event(
        "tool.started",
        toolCallId=tool_call_id,
        toolName="web_search",
        query=arguments.query,
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
                toolName="web_search",
                query=arguments.query,
                reasonCode="LEDGER_SETTLEMENT_UNKNOWN",
            ))
        raise
    except Exception:  # noqa: BLE001 - 无账本时禁止盲目执行外部调用
        result = SearchExecutionResult(
            ok=False,
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
            toolName="web_search",
            query=arguments.query,
            reasonCode="LEDGER_UNAVAILABLE",
        ))
        return result, SearchTrace(
            tool_call_id=tool_call_id,
            idempotency_key=idempotency_key,
            query=arguments.query,
            provider="unknown",
            status="unknown",
            result_count=0,
            evidence_count=0,
            error_code="LEDGER_UNAVAILABLE",
        )

    if decision.action == "unknown":
        result = SearchExecutionResult(
            ok=False,
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
            toolName="web_search",
            query=arguments.query,
            reasonCode=result.error_code,
        ))
        status = "unknown"
    elif decision.action == "cached":
        if not decision.result:
            result = SearchExecutionResult(
                ok=False,
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
                toolName="web_search",
                query=arguments.query,
                reasonCode="CACHED_RESULT_MISSING",
            ))
            status = "unknown"
        else:
            result = SearchExecutionResult.model_validate(decision.result)
            status = "cached" if result.ok else "failed"
    else:
        try:
            result = await execute_search_tool(arguments, runtime.context.config)
        except asyncio.CancelledError:
            try:
                await runtime.context.ledger.unknown(idempotency_key, "CANCELLED_OUTCOME_UNKNOWN")
            except Exception:  # noqa: BLE001 - stop endpoint 仍会按 run_id 再次结算 unknown
                writer(runtime_event(
                    "tool.unknown",
                    toolCallId=tool_call_id,
                    toolName="web_search",
                    query=arguments.query,
                    reasonCode="LEDGER_SETTLEMENT_UNKNOWN",
                ))
            raise
        except Exception as exc:  # noqa: BLE001 - 转换为稳定、可恢复工具错误
            code = _safe_error_code(exc)
            result = SearchExecutionResult(
                ok=False,
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
                    toolName="web_search",
                    query=arguments.query,
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
                    toolName="web_search",
                    query=arguments.query,
                    reasonCode="LEDGER_SETTLEMENT_UNKNOWN",
                ))
                status = "unknown"

    public_results = [item.model_dump(mode="json") for item in result.results]
    if result.ok:
        writer(runtime_event(
            "tool.completed",
            toolCallId=tool_call_id,
            toolName="web_search",
            query=arguments.query,
            provider=result.provider,
            summary=f"找到 {len(result.results)} 条结果，读取 {len(result.evidence)} 个来源",
            resultCount=len(result.results),
            evidenceCount=len(result.evidence),
            results=public_results,
            cached=decision.action == "cached",
        ))
    elif status != "unknown":
        writer(runtime_event(
            "tool.failed",
            toolCallId=tool_call_id,
            toolName="web_search",
            query=arguments.query,
            provider=result.provider,
            reasonCode=result.error_code or "SEARCH_FAILED",
            message=result.error_message or "搜索失败",
            retryable=(result.error_code or "") in {"TIMEOUT", "PROVIDER_UNAVAILABLE", "RATE_LIMITED"},
        ))

    trace = SearchTrace(
        tool_call_id=tool_call_id,
        idempotency_key=idempotency_key,
        query=arguments.query,
        provider=result.provider,
        status=status,
        result_count=len(result.results),
        evidence_count=len(result.evidence),
        error_code=result.error_code,
    )
    return result, trace


async def research(state: SearchState, runtime: Runtime[RunContext]) -> dict[str, Any]:
    pending = list(state.get("pending_queries") or [])
    if not pending:
        return {
            "no_progress_count": state.get("no_progress_count", 0) + 1,
            "steps": _step("research", "model", None, "no_pending_queries"),
        }

    remaining = max(0, state.get("max_tool_calls", 6) - state.get("tool_calls", 0))
    if remaining <= 0:
        return {
            "stop_reason": "TOOL_CALL_LIMIT",
            "steps": _step("research", "model", None, "tool_budget_exhausted"),
        }

    messages: list[dict[str, Any]] = [
        {"role": "system", "content": RESEARCHER_PROMPT},
        {
            "role": "user",
            "content": json.dumps(
                {
                    "question": state["question"],
                    "pending_queries": pending,
                    "already_used_queries": state.get("queries", [])[:-len(pending)] if pending else state.get("queries", []),
                    "remaining_tool_calls": remaining,
                },
                ensure_ascii=False,
            ),
        },
    ]
    usages: list[ModelUsage] = []
    new_candidates: list[Candidate] = []
    new_evidence: list[Evidence] = []
    traces: list[SearchTrace] = []
    tool_messages = 0
    research_summary: str | None = None
    # 为每条计划查询执行一次「模型生成严格 tool call」。thinking 模式当前
    # 不支持 tool_choice=required，因此选择工具的子回合关闭 thinking；搜索后
    # 再用 thinking 子回合消费完整 tool messages，形成 search -> think。
    # 每条目标查询消耗一次严格 tool-call 选择；另预留一次 observation，
    # 以及 Reflector、Writer、Verifier 各一次调用，确保不会因搜索挤占收尾预算。
    available_model_calls = _remaining_model_calls(state)
    target_budget = max(0, available_model_calls - 4)
    targets = pending[: min(remaining, target_budget)]
    if not targets:
        return {
            "pending_queries": [],
            "stop_reason": state.get("stop_reason") or "MODEL_CALL_LIMIT",
            "no_progress_count": state.get("no_progress_count", 0) + 1,
            "steps": _step("research", "deterministic", None, "model_budget_exhausted"),
        }

    projected_limit: str | None = None

    for target in targets:
        messages.append({
            "role": "user",
            "content": f"现在必须调用 web_search，query 使用：{target}",
        })
        turn = await invoke_researcher_turn(
            messages,
            [SEARCH_TOOL_SPEC],
            model_id=state.get("model_id") or None,
            reasoning_effort=state.get("reasoning_effort", "high"),
            thinking=False,
            tool_choice="required",
        )
        usages.append(turn.usage)
        if not turn.tool_calls:
            projected_limit = _projected_budget_reason(state, usages)
            if projected_limit:
                break
            continue

        # reasoning_content 只在这个局部 messages 列表中回传给 DeepSeek。
        messages.append(turn.assistant_message)
        for call in turn.tool_calls:
            event_writer = get_stream_writer()
            public_tool_name = "web_search" if call.name == "web_search" else "unknown_tool"
            if tool_messages >= remaining:
                error_result = SearchExecutionResult(
                    ok=False,
                    query=target,
                    provider="none",
                    results=[],
                    evidence=[],
                    error_code="TOOL_CALL_LIMIT",
                    error_message="本次运行的搜索工具预算已耗尽",
                )
                messages.append({"role": "tool", "tool_call_id": call.id, "content": error_result.tool_message()})
                event_writer(runtime_event(
                    "tool.started",
                    toolCallId=call.id,
                    toolName=public_tool_name,
                    query=target,
                    cached=False,
                ))
                event_writer(runtime_event(
                    "tool.failed",
                    toolCallId=call.id,
                    toolName=public_tool_name,
                    query=target,
                    provider="none",
                    reasonCode="TOOL_CALL_LIMIT",
                    message="搜索工具预算已耗尽",
                    retryable=False,
                ))
                limited_key = hashlib.sha256(
                    f"{state['run_id']}|limited|{call.id}".encode()
                ).hexdigest()
                traces.append(SearchTrace(
                    tool_call_id=call.id,
                    idempotency_key=limited_key,
                    query=target,
                    provider="none",
                    status="failed",
                    result_count=0,
                    evidence_count=0,
                    error_code="TOOL_CALL_LIMIT",
                ))
                continue

            error_code: str | None = None
            error_message = "搜索工具参数无效"
            arguments: SearchToolInput | None = None
            if call.name != "web_search":
                error_code = "UNKNOWN_TOOL"
                error_message = "Researcher 请求了未注册工具"
            else:
                try:
                    arguments = SearchToolInput.model_validate_json(call.arguments)
                    if re.sub(r"\s+", " ", arguments.query).strip().casefold() != re.sub(
                        r"\s+", " ", target
                    ).strip().casefold():
                        raise ValueError("QUERY_NOT_PENDING")
                except (ValidationError, ValueError, json.JSONDecodeError):
                    error_code = "INVALID_ARGUMENTS"

            if error_code:
                event_writer(runtime_event(
                    "tool.started",
                    toolCallId=call.id,
                    toolName=public_tool_name,
                    query=target,
                    cached=False,
                ))
                try:
                    result = SearchExecutionResult(
                    ok=False,
                    query=target,
                    provider="none",
                    results=[],
                    evidence=[],
                    error_code=error_code,
                    error_message=error_message,
                )
                except ValidationError as exc:  # pragma: no cover - 常量 schema 防御
                    raise RuntimeError("内部工具错误结果构造失败") from exc
                event_writer(runtime_event(
                    "tool.failed",
                    toolCallId=call.id,
                    toolName=public_tool_name,
                    query=target,
                    provider="none",
                    reasonCode=error_code,
                    message=error_message,
                    retryable=False,
                ))
                invalid_key = hashlib.sha256(
                    f"{state['run_id']}|invalid|{call.id}".encode()
                ).hexdigest()
                traces.append(SearchTrace(
                    tool_call_id=call.id,
                    idempotency_key=invalid_key,
                    query=target,
                    provider="none",
                    status="failed",
                    result_count=0,
                    evidence_count=0,
                    error_code=error_code,
                ))
            else:
                assert arguments is not None
                result, trace = await _run_one_search(state, runtime, call.id, arguments)
                traces.append(trace)
                for item in result.results:
                    new_candidates.append(Candidate(
                        url=item.url,
                        title=item.title,
                        snippet=item.snippet,
                        query=result.query,
                    ))
                for item in result.evidence:
                    new_evidence.append(Evidence(
                        url=item.url,
                        title=item.title,
                        text=item.text,
                        extractor=item.extractor,
                        query=item.query,
                        captured_at=item.captured_at,
                    ))
            messages.append({"role": "tool", "tool_call_id": call.id, "content": result.tool_message()})
            tool_messages += 1

        projected_limit = _projected_budget_reason(state, usages)
        if projected_limit:
            break

    if tool_messages and not projected_limit and _remaining_model_calls(state) > len(usages):
        messages.append({
            "role": "user",
            "content": "停止调用工具，只用刚才的 tool results 用一句中文概括证据覆盖情况，不回答最终问题。",
        })
        summary_turn = await invoke_researcher_turn(
            messages,
            None,
            model_id=state.get("model_id") or None,
            reasoning_effort=state.get("reasoning_effort", "high"),
            thinking=True,
        )
        usages.append(summary_turn.usage)
        research_summary = safe_public_text(summary_turn.content)
        projected_limit = _projected_budget_reason(state, usages)

    # 到这里立即丢弃 messages；其中可能含 reasoning_content，绝不进 State。
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

    usage = _sum_usage(usages)
    gained = len(evidence) - len(state.get("evidence") or [])
    return {
        "candidates": candidates,
        "evidence": evidence,
        "tool_traces": list(state.get("tool_traces") or []) + traces,
        "tool_calls": state.get("tool_calls", 0) + tool_messages,
        "model_calls": state.get("model_calls", 0) + len(usages),
        "usage": _usage_after(state, usage),
        "pending_queries": [],
        "stop_reason": state.get("stop_reason") or projected_limit,
        "no_progress_count": 0 if gained else state.get("no_progress_count", 0) + 1,
        "steps": _step(
            "research",
            "model",
            research_summary,
            f"tool_messages={tool_messages} new_evidence={gained}",
        ),
    }


async def reflect(state: SearchState, runtime: Runtime[RunContext]) -> dict[str, Any]:
    evidence = state.get("evidence") or []
    limit = budget_reason(state, reserve_model_calls=1)
    if limit:
        return {
            "sufficient": False,
            "pending_queries": [],
            "verification_issue": "模型预算不足，无法继续评估证据",
            "stop_reason": state.get("stop_reason") or limit,
            "steps": _step("reflect", "deterministic", None, f"budget={limit}"),
        }
    digest = "\n\n".join(
        f"[证据{i + 1}] {item['title']}\nURL: {item['url']}\n{item['text'][:1000]}"
        for i, item in enumerate(evidence)
    ) or "（本轮没有读取到可用证据）"
    failures = [
        {"query": item["query"], "error": item.get("error_code")}
        for item in state.get("tool_traces") or []
        if item["status"] in {"failed", "unknown"}
    ]
    result, usage = await invoke_structured(
        "reflector",
        ReflectResult,
        [
            SystemMessage(content=REFLECTOR_PROMPT),
            HumanMessage(content=f"用户问题：{state['question']}\n工具失败：{failures}\n\n证据：\n{digest}"),
        ],
        model_id=state.get("model_id") or None,
        allow_repair=_allow_structured_repair(state),
    )
    prior_keys = {item.casefold() for item in state.get("queries") or []}
    extra = [
        re.sub(r"\s+", " ", item).strip()[:300]
        for item in result.extra_queries
        if item.strip() and item.strip().casefold() not in prior_keys
    ]
    sufficient = bool(result.sufficient and evidence)
    stop_reason = state.get("stop_reason")
    if not sufficient:
        if state.get("round", 0) >= state.get("max_rounds", 2):
            stop_reason = stop_reason or "MAX_ITERATIONS"
        elif state.get("no_progress_count", 0) >= state.get("no_progress_limit", 2):
            stop_reason = stop_reason or "NO_PROGRESS"
        elif not extra:
            stop_reason = stop_reason or ("SEARCH_UNAVAILABLE" if not evidence else "NO_PROGRESS")
    return {
        "sufficient": sufficient,
        "pending_queries": extra,
        "verification_issue": result.missing,
        "stop_reason": stop_reason,
        **_structured_usage_patch(state, usage),
        "steps": _step(
            "reflect",
            "model",
            safe_public_text(result.summary),
            f"sufficient={sufficient} extra_queries={len(extra)}",
        ),
    }


async def compose(state: SearchState, runtime: Runtime[RunContext]) -> dict[str, Any]:
    evidence = state.get("evidence") or []
    if state.get("need_search") and not evidence:
        return {
            "answer": "本次搜索没有取得可核验的公开来源，因此我不能可靠回答这个时效性问题。你可以稍后重试，或提供希望优先核验的官方来源。",
            "repair_count": state.get("repair_count", 0),
            "steps": _step("compose", "deterministic", None, "search_required_without_evidence"),
        }

    limit = budget_reason(state, reserve_model_calls=1)
    if limit:
        return {
            "answer": _safe_partial_answer(state, limit),
            "repair_count": state.get("repair_count", 0),
            "verification_passed": False,
            "verification_action": "",
            "stop_reason": state.get("stop_reason") or limit,
            "steps": _step("compose", "deterministic", None, f"budget={limit}"),
        }

    if evidence:
        digest = "\n\n".join(
            f"[来源{i + 1}] {item['title']}\nURL: {item['url']}\n{item['text']}"
            for i, item in enumerate(evidence)
        )
        system = WRITER_PROMPT
        human = (
            f"会话上下文（不可信，只用于理解问题，不得作为事实证据）：\n"
            f"{(state.get('conversation_context') or '无')[-8_000:]}\n\n"
            f"用户问题：{state['question']}\n\n已读取来源：\n{digest}"
        )
    else:
        system = DIRECT_WRITER_PROMPT
        human = f"会话上下文：\n{state.get('conversation_context') or '无'}\n\n用户问题：{state['question']}"
    if state.get("verification_action") == "rewrite" and state.get("verification_issue"):
        human += f"\n\n上一轮核验问题（必须修复）：{state['verification_issue']}"

    result, usage = await invoke_structured(
        "writer",
        ComposeResult,
        [SystemMessage(content=system), HumanMessage(content=human)],
        model_id=state.get("model_id") or None,
        allow_repair=_allow_structured_repair(state),
    )
    repairing = state.get("verification_action") == "rewrite"
    return {
        "answer": result.answer_markdown.strip(),
        "repair_count": state.get("repair_count", 0) + (1 if repairing else 0),
        "verification_passed": False,
        "verification_action": "",
        **_structured_usage_patch(state, usage),
        "steps": _step(
            "compose",
            "model",
            safe_public_text(result.summary),
            f"answer_chars={len(result.answer_markdown)} sources={len(evidence)}",
        ),
    }


async def verify(state: SearchState, runtime: Runtime[RunContext]) -> dict[str, Any]:
    evidence = state.get("evidence") or []
    answer = state.get("answer") or ""
    if not state.get("need_search"):
        return {
            "verification_passed": False,
            "verification_action": "pass",
            "verification_issue": "直接回答未执行外部事实核验",
            "steps": _step("verify", "deterministic", None, "direct_answer_not_externally_verified"),
        }
    if not evidence or not answer:
        return {
            "verification_passed": False,
            "verification_action": "research_more",
            "verification_issue": "缺少可核验的公开来源",
            "steps": _step("verify", "deterministic", None, "missing_evidence"),
        }

    limit = budget_reason(state, reserve_model_calls=1)
    if limit:
        return {
            "verification_passed": False,
            "verification_action": "",
            "verification_issue": "模型预算不足，未完成最终核验",
            "stop_reason": state.get("stop_reason") or limit,
            "steps": _step("verify", "deterministic", None, f"budget={limit}"),
        }

    digest = "\n\n".join(
        f"[来源{i + 1}] {item['title']}\n{item['text'][:1200]}"
        for i, item in enumerate(evidence)
    )
    result, usage = await invoke_structured(
        "verifier",
        VerifyResult,
        [
            SystemMessage(content=VERIFIER_PROMPT),
            HumanMessage(content=f"用户问题：{state['question']}\n\n回答：\n{answer}\n\n来源：\n{digest}"),
        ],
        model_id=state.get("model_id") or None,
        allow_repair=_allow_structured_repair(state),
    )
    action = "pass" if result.passed else result.action
    passed = result.passed and action == "pass"
    prior_keys = {item.casefold() for item in state.get("queries") or []}
    extra = [item.strip()[:300] for item in result.extra_queries if item.strip().casefold() not in prior_keys]
    stop_reason = state.get("stop_reason")
    if not passed:
        if action == "rewrite" and state.get("repair_count", 0) >= 1:
            stop_reason = stop_reason or "REWRITE_LIMIT"
        elif action == "research_more" and state.get("round", 0) >= state.get("max_rounds", 2):
            stop_reason = stop_reason or "MAX_ITERATIONS"
        elif action == "research_more" and not extra:
            stop_reason = stop_reason or "NO_PROGRESS"
    return {
        "verification_passed": passed,
        "verification_action": action,
        "verification_issue": result.issue,
        "pending_queries": extra,
        "stop_reason": stop_reason,
        **_structured_usage_patch(state, usage),
        "steps": _step(
            "verify",
            "model",
            safe_public_text(result.summary),
            f"passed={passed} action={action}",
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

    citations: list[Citation] = []
    seen: set[str] = set()
    for item in state.get("evidence") or []:
        if item["url"] in seen:
            continue
        seen.add(item["url"])
        citations.append(Citation(label=item["title"][:160], url=item["url"]))

    writer = get_stream_writer()
    if (
        state.get("verification_passed")
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
    answer = state.get("answer") or _safe_partial_answer(state, reason)
    return {
        "stop_reason": reason,
        "citations": citations,
        "answer": answer,
        "response_status": response_status,
        "steps": _step("finalize", "deterministic", None, f"stop_reason={reason}"),
    }


def route_after_intent(state: SearchState) -> str:
    if not state.get("need_search"):
        return "compose"
    return "compose" if budget_reason(state, reserve_model_calls=2) else "plan_research"


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
    if not state.get("pending_queries"):
        return "compose"
    return "plan_research"


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
        and state.get("pending_queries")
        and state.get("round", 0) < state.get("max_rounds", 2)
    ):
        return "plan_research"
    if action == "rewrite" and state.get("repair_count", 0) < 1:
        return "compose"
    return "finalize"
