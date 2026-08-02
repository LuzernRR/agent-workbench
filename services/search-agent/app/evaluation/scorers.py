"""确定性 scorers：只读观测结果，不调用模型，不访问网络。

每个 scorer 输入一个 `CaseRun`，输出 `ScoreResult`。判定全部基于可枚举规则，
同一输入必然得到同一结论；本轮不引入 LLM-as-judge。
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from app.evaluation.runner import CaseRun
from app.events.runtime import _FORBIDDEN_KEYS, _assert_public

# 证据状态机的合法迁移；起点只能是 read。
_LEGAL_EVIDENCE_TRANSITIONS = {
    "read": {"accepted", "rejected"},
    "accepted": {"cited", "rejected"},
    "cited": set(),
    "rejected": set(),
}

_TERMINAL_TYPES = {"run.completed", "run.failed", "run.stopped"}


@dataclass
class ScoreResult:
    """单个维度的判定结果。"""

    name: str
    passed: bool
    detail: str
    failures: list[str] = field(default_factory=list)


Scorer = Callable[[CaseRun], ScoreResult]


def _terminal_events(run: CaseRun) -> list[dict[str, Any]]:
    return [
        event
        for event in run.events
        if str(event.get("type", "")) in _TERMINAL_TYPES
    ]


def score_terminal_uniqueness(run: CaseRun) -> ScoreResult:
    """终态必须唯一、位于流末尾，且与 Gold 期望一致。"""
    failures: list[str] = []
    terminals = _terminal_events(run)
    if len(terminals) != 1:
        failures.append(f"终态事件数量为 {len(terminals)}，应为 1")
    elif run.events[-1] is not terminals[0]:
        failures.append("终态事件不是事件流的最后一条")

    if terminals:
        terminal = terminals[-1]
        expected = run.case.expect
        actual_type = str(terminal.get("type"))
        if actual_type != expected.terminal_type:
            failures.append(f"终态类型 {actual_type} != 期望 {expected.terminal_type}")
        if expected.reason_code is not None:
            actual_reason = str(terminal.get("reasonCode") or "")
            if actual_reason != expected.reason_code:
                failures.append(
                    f"reasonCode {actual_reason!r} != 期望 {expected.reason_code!r}"
                )
        if expected.response_status is not None:
            actual_status = str(terminal.get("responseStatus") or "")
            if actual_status != expected.response_status:
                failures.append(
                    f"responseStatus {actual_status!r} != 期望 {expected.response_status!r}"
                )
        if expected.verification_passed is not None:
            actual_passed = bool(terminal.get("verificationPassed"))
            if actual_passed != expected.verification_passed:
                failures.append(
                    f"verificationPassed {actual_passed} != 期望 {expected.verification_passed}"
                )

    return ScoreResult(
        name="terminal_uniqueness",
        passed=not failures,
        detail="终态唯一且与期望一致" if not failures else "；".join(failures),
        failures=failures,
    )


def score_evidence_lifecycle(run: CaseRun) -> ScoreResult:
    """证据状态迁移必须合法：起点为 read，且不得回退或跨越。"""
    failures: list[str] = []
    latest: dict[str, str] = {}
    for event in run.events:
        if str(event.get("type")) != "evidence.updated":
            continue
        evidence_id = str(event.get("evidenceId") or "")
        status = str(event.get("status") or "")
        if not evidence_id or not status:
            failures.append(f"证据事件缺少 evidenceId 或 status：{evidence_id!r}")
            continue
        if status not in _LEGAL_EVIDENCE_TRANSITIONS:
            failures.append(f"{evidence_id} 出现未知状态 {status!r}")
            continue
        previous = latest.get(evidence_id)
        if previous is None:
            if status != "read":
                failures.append(f"{evidence_id} 首个状态为 {status!r}，应为 read")
        elif status not in _LEGAL_EVIDENCE_TRANSITIONS[previous]:
            failures.append(f"{evidence_id} 非法迁移 {previous} → {status}")
        latest[evidence_id] = status

    cited = sum(1 for status in latest.values() if status == "cited")
    minimum = run.case.expect.min_evidence_cited
    if minimum is not None and cited < minimum:
        failures.append(f"最终 cited 证据 {cited} 条，少于期望 {minimum} 条")

    return ScoreResult(
        name="evidence_lifecycle",
        passed=not failures,
        detail=(
            f"{len(latest)} 条证据状态迁移合法，其中 cited {cited} 条"
            if not failures
            else "；".join(failures)
        ),
        failures=failures,
    )


def score_citation_traceability(run: CaseRun) -> ScoreResult:
    """终态引用必须可回溯到本轮 cited 证据的 URL。"""
    failures: list[str] = []
    terminals = _terminal_events(run)
    terminal = terminals[-1] if terminals else {}
    citations = terminal.get("citations") or []

    cited_urls = {
        str(event.get("url") or "")
        for event in run.events
        if str(event.get("type")) == "evidence.updated"
        and str(event.get("status")) == "cited"
    }
    for index, citation in enumerate(citations):
        url = str((citation or {}).get("url") or "")
        label = str((citation or {}).get("label") or "")
        if not url or not label:
            failures.append(f"引用[{index}] 缺少 label 或 url")
            continue
        if url not in cited_urls:
            failures.append(f"引用[{index}] {url} 无法回溯到 cited 证据")

    minimum = run.case.expect.min_citations
    if minimum is not None and len(citations) < minimum:
        failures.append(f"引用 {len(citations)} 条，少于期望 {minimum} 条")

    return ScoreResult(
        name="citation_traceability",
        passed=not failures,
        detail=(
            f"{len(citations)} 条引用全部可回溯"
            if not failures
            else "；".join(failures)
        ),
        failures=failures,
    )


def score_tool_ledger_completeness(run: CaseRun) -> ScoreResult:
    """每个 tool.started 必须有唯一终态，且 unknown 必须给出后续动作。"""
    failures: list[str] = []
    started: dict[str, dict[str, Any]] = {}
    terminated: dict[str, str] = {}

    for event in run.events:
        event_type = str(event.get("type") or "")
        tool_call_id = str(event.get("toolCallId") or "")
        if event_type == "tool.started":
            if tool_call_id in started:
                failures.append(f"{tool_call_id} 重复 tool.started")
            started[tool_call_id] = event
        elif event_type in {"tool.completed", "tool.failed", "tool.unknown"}:
            if tool_call_id in terminated:
                failures.append(
                    f"{tool_call_id} 出现多个终态：{terminated[tool_call_id]} 与 {event_type}"
                )
            terminated[tool_call_id] = event_type
            if tool_call_id not in started:
                failures.append(f"{tool_call_id} 有终态但无 tool.started")
            if event_type == "tool.unknown":
                if str(event.get("nextAction") or "") != "check_operation":
                    failures.append(f"{tool_call_id} unknown 终态缺少 check_operation")
                if not str(event.get("reasonCode") or ""):
                    failures.append(f"{tool_call_id} unknown 终态缺少 reasonCode")
            if not str(event.get("operationRef") or ""):
                failures.append(f"{tool_call_id} 终态缺少 operationRef")

    for tool_call_id in started:
        if tool_call_id not in terminated:
            failures.append(f"{tool_call_id} 没有终态事件")

    return ScoreResult(
        name="tool_ledger_completeness",
        passed=not failures,
        detail=(
            f"{len(started)} 次工具调用账本完整"
            if not failures
            else "；".join(failures)
        ),
        failures=failures,
    )


def score_route_and_channel(run: CaseRun) -> ScoreResult:
    """回答来源与实际使用的工具渠道必须与 Gold 期望一致。"""
    failures: list[str] = []
    expected = run.case.expect
    terminals = _terminal_events(run)
    terminal = terminals[-1] if terminals else {}

    if expected.answer_source is not None:
        actual_source = str(terminal.get("answerSource") or "none")
        if actual_source != expected.answer_source:
            failures.append(
                f"answerSource {actual_source!r} != 期望 {expected.answer_source!r}"
            )

    if expected.channels is not None:
        actual_channels = sorted({
            str(event.get("channel"))
            for event in run.events
            if str(event.get("type")) == "tool.started" and event.get("channel")
        })
        if actual_channels != sorted(expected.channels):
            failures.append(
                f"实际渠道 {actual_channels} != 期望 {sorted(expected.channels)}"
            )

    return ScoreResult(
        name="route_and_channel",
        passed=not failures,
        detail="路由与渠道符合期望" if not failures else "；".join(failures),
        failures=failures,
    )


def score_node_pairing(run: CaseRun) -> ScoreResult:
    """每个 node.started 必须有唯一终态（completed 或 failed），且无孤立终态。"""
    failures: list[str] = []
    started: set[str] = set()
    terminated: dict[str, str] = {}

    for event in run.events:
        event_type = str(event.get("type") or "")
        node_run_id = str(event.get("nodeRunId") or "")
        if event_type not in {"node.started", "node.completed", "node.failed"}:
            continue
        if not node_run_id:
            failures.append(f"{event_type} 缺少 nodeRunId")
            continue
        if event_type == "node.started":
            if node_run_id in started:
                failures.append(f"{node_run_id} 重复 node.started")
            started.add(node_run_id)
            continue
        if node_run_id in terminated:
            failures.append(
                f"{node_run_id} 出现多个终态：{terminated[node_run_id]} 与 {event_type}"
            )
        terminated[node_run_id] = event_type
        if node_run_id not in started:
            failures.append(f"{node_run_id} 有终态但无 node.started")

    for node_run_id in sorted(started - set(terminated)):
        failures.append(f"{node_run_id} 没有终态事件")

    return ScoreResult(
        name="node_pairing",
        passed=not failures,
        detail=(
            f"{len(started)} 个节点 started/终态配对完整"
            if not failures
            else "；".join(failures)
        ),
        failures=failures,
    )


def score_plan_legality(run: CaseRun) -> ScoreResult:
    """计划 revision 单调递增、步骤字段齐备，且依赖既已知又无环。"""
    failures: list[str] = []
    revisions: list[int] = []
    for event in run.events:
        if str(event.get("type")) != "plan.updated":
            continue
        revision = int(event.get("revision") or 0)
        if revisions and revision <= revisions[-1]:
            failures.append(f"plan revision 非单调：{revisions[-1]} → {revision}")
        revisions.append(revision)
        steps = list(event.get("steps") or [])
        step_ids = {str((step or {}).get("stepId") or "") for step in steps}
        step_ids.discard("")
        for index, step in enumerate(steps):
            step_id = str((step or {}).get("stepId") or "")
            if not step_id:
                failures.append(f"revision {revision} 的步骤[{index}] 缺少 stepId")
            if not str((step or {}).get("status") or ""):
                failures.append(f"revision {revision} 的步骤[{index}] 缺少 status")
            for dependency in (step or {}).get("dependsOn") or []:
                if str(dependency) not in step_ids:
                    failures.append(
                        f"revision {revision} 的 {step_id or index} 依赖未知步骤 {dependency}"
                    )
        failures.extend(
            f"revision {revision} 的依赖存在环：{cycle}"
            for cycle in _dependency_cycles(steps)
        )

    return ScoreResult(
        name="plan_legality",
        passed=not failures,
        detail=(
            f"{len(revisions)} 次计划更新合法" if not failures else "；".join(failures)
        ),
        failures=failures,
    )


def _dependency_cycles(steps: list[Any]) -> list[str]:
    """返回依赖图中的环；仅统计已知步骤之间的边。"""
    graph: dict[str, list[str]] = {}
    for step in steps:
        step_id = str((step or {}).get("stepId") or "")
        if step_id:
            graph[step_id] = [str(item) for item in (step or {}).get("dependsOn") or []]

    cycles: list[str] = []
    # 0=未访问 1=在当前递归栈 2=已完成
    state: dict[str, int] = {}

    def visit(node: str, path: list[str]) -> None:
        state[node] = 1
        for dependency in graph.get(node, []):
            if dependency not in graph:
                continue
            if state.get(dependency, 0) == 1:
                start = path.index(dependency)
                cycles.append(" → ".join([*path[start:], dependency]))
            elif state.get(dependency, 0) == 0:
                visit(dependency, [*path, dependency])
        state[node] = 2

    for node in graph:
        if state.get(node, 0) == 0:
            visit(node, [node])
    return cycles


def score_forbidden_field_scan(run: CaseRun) -> ScoreResult:
    """事件与 span 都不得出现禁止字段。"""
    failures: list[str] = []
    for index, event in enumerate(run.events):
        try:
            _assert_public(event, f"events[{index}]")
        except ValueError as exc:
            failures.append(str(exc))
    for index, span in enumerate(run.spans):
        try:
            _assert_public(span.attributes, f"spans[{index}].attributes")
            _assert_public(span.events, f"spans[{index}].events")
        except ValueError as exc:
            failures.append(str(exc))

    return ScoreResult(
        name="forbidden_field_scan",
        passed=not failures,
        detail=(
            f"{len(run.events)} 个事件与 {len(run.spans)} 个 span 均未出现"
            f"{len(_FORBIDDEN_KEYS)} 类禁止字段"
            if not failures
            else "；".join(failures)
        ),
        failures=failures,
    )


def score_latency_budget(run: CaseRun) -> ScoreResult:
    """节点与工具耗时之和不得超过用例声明的上限。"""
    failures: list[str] = []
    total_ms = 0
    for event in run.events:
        if str(event.get("type")) in {"node.completed", "tool.completed", "tool.unknown"}:
            total_ms += int(event.get("durationMs") or 0)

    budget = run.case.expect.max_duration_ms
    if budget is not None and total_ms > budget:
        failures.append(f"累计耗时 {total_ms}ms 超出预算 {budget}ms")

    return ScoreResult(
        name="latency_budget",
        passed=not failures,
        detail=(
            f"累计耗时 {total_ms}ms"
            + (f"，预算 {budget}ms" if budget is not None else "，未设预算")
            if not failures
            else "；".join(failures)
        ),
        failures=failures,
    )


ALL_SCORERS: tuple[Scorer, ...] = (
    score_terminal_uniqueness,
    score_route_and_channel,
    score_node_pairing,
    score_evidence_lifecycle,
    score_citation_traceability,
    score_tool_ledger_completeness,
    score_plan_legality,
    score_forbidden_field_scan,
    score_latency_budget,
)


def score_case(run: CaseRun, scorers: tuple[Scorer, ...] = ALL_SCORERS) -> list[ScoreResult]:
    """对一个用例运行全部 scorer，顺序稳定。"""
    return [scorer(run) for scorer in scorers]
