"""确定性 scorers 与报告测试：每个维度的正反例。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from app.evaluation.cli import main
from app.evaluation.dataset import GoldCase, load_dataset
from app.evaluation.report import build_report
from app.evaluation.runner import CaseRun, run_dataset
from app.evaluation.scorers import (
    ALL_SCORERS,
    score_case,
    score_citation_traceability,
    score_evidence_lifecycle,
    score_forbidden_field_scan,
    score_latency_budget,
    score_node_pairing,
    score_plan_legality,
    score_route_and_channel,
    score_terminal_uniqueness,
    score_tool_ledger_completeness,
)
from app.observability.span import Span


def case(**expect: Any) -> GoldCase:
    return GoldCase.model_validate({
        "caseId": "c1",
        "question": "q",
        "tags": ["t"],
        "expect": {"terminalType": "run.completed", **expect},
    })


def make_run(
    events: list[dict[str, Any]],
    *,
    spans: list[Span] | None = None,
    **expect: Any,
) -> CaseRun:
    return CaseRun(case=case(**expect), events=events, spans=spans or [])


def evidence(evidence_id: str, status: str, url: str = "https://a.com") -> dict[str, Any]:
    return {
        "type": "evidence.updated",
        "evidenceId": evidence_id,
        "status": status,
        "url": url,
    }


def terminal(**payload: Any) -> dict[str, Any]:
    return {"type": "run.completed", "citations": [], **payload}


# --- terminal_uniqueness ---


def test_terminal_uniqueness_accepts_single_trailing_terminal() -> None:
    run = make_run([{"type": "node.started"}, terminal(responseStatus="completed")])
    assert score_terminal_uniqueness(run).passed


def test_terminal_uniqueness_rejects_multiple_terminals() -> None:
    run = make_run([terminal(), terminal()])
    result = score_terminal_uniqueness(run)
    assert not result.passed
    assert "终态事件数量为 2" in result.detail


def test_terminal_uniqueness_rejects_terminal_not_at_end() -> None:
    run = make_run([terminal(), {"type": "node.completed"}])
    result = score_terminal_uniqueness(run)
    assert not result.passed
    assert "不是事件流的最后一条" in result.detail


def test_terminal_uniqueness_rejects_wrong_terminal_type() -> None:
    run = make_run([{"type": "run.failed", "reasonCode": "X"}])
    result = score_terminal_uniqueness(run)
    assert not result.passed
    assert "run.failed" in result.detail


def test_terminal_uniqueness_checks_reason_and_status_and_verification() -> None:
    run = make_run(
        [terminal(responseStatus="partial", verificationPassed=False, reasonCode="A")],
        reasonCode="B",
        responseStatus="completed",
        verificationPassed=True,
    )
    result = score_terminal_uniqueness(run)
    assert not result.passed
    assert len(result.failures) == 3


# --- evidence_lifecycle ---


def test_evidence_lifecycle_accepts_read_accepted_cited() -> None:
    run = make_run(
        [evidence("e1", "read"), evidence("e1", "accepted"), evidence("e1", "cited"), terminal()],
        minEvidenceCited=1,
    )
    assert score_evidence_lifecycle(run).passed


def test_evidence_lifecycle_accepts_read_then_rejected() -> None:
    run = make_run([evidence("e1", "read"), evidence("e1", "rejected"), terminal()])
    assert score_evidence_lifecycle(run).passed


def test_evidence_lifecycle_rejects_non_read_first_status() -> None:
    result = score_evidence_lifecycle(make_run([evidence("e1", "cited")]))
    assert not result.passed
    assert "首个状态为 'cited'" in result.detail


def test_evidence_lifecycle_rejects_illegal_transition() -> None:
    run = make_run([evidence("e1", "read"), evidence("e1", "cited")])
    result = score_evidence_lifecycle(run)
    assert not result.passed
    assert "非法迁移 read → cited" in result.detail


def test_evidence_lifecycle_rejects_transition_out_of_terminal_status() -> None:
    run = make_run([evidence("e1", "read"), evidence("e1", "rejected"), evidence("e1", "accepted")])
    result = score_evidence_lifecycle(run)
    assert not result.passed
    assert "rejected → accepted" in result.detail


def test_evidence_lifecycle_rejects_unknown_status_and_missing_id() -> None:
    run = make_run([evidence("e1", "maybe"), {"type": "evidence.updated", "status": "read"}])
    result = score_evidence_lifecycle(run)
    assert not result.passed
    assert len(result.failures) == 2


def test_evidence_lifecycle_enforces_min_cited() -> None:
    run = make_run([evidence("e1", "read"), evidence("e1", "accepted")], minEvidenceCited=1)
    result = score_evidence_lifecycle(run)
    assert not result.passed
    assert "少于期望 1 条" in result.detail


# --- citation_traceability ---


def test_citation_traceability_accepts_cited_backed_citations() -> None:
    run = make_run([
        evidence("e1", "read"),
        evidence("e1", "accepted"),
        evidence("e1", "cited", "https://a.com"),
        terminal(citations=[{"label": "来源", "url": "https://a.com"}]),
    ])
    assert score_citation_traceability(run).passed


def test_citation_traceability_rejects_untraceable_citation() -> None:
    run = make_run([terminal(citations=[{"label": "凭空", "url": "https://ghost.com"}])])
    result = score_citation_traceability(run)
    assert not result.passed
    assert "无法回溯到 cited 证据" in result.detail


def test_citation_traceability_rejects_incomplete_citation() -> None:
    run = make_run([terminal(citations=[{"label": "", "url": ""}])])
    result = score_citation_traceability(run)
    assert not result.passed
    assert "缺少 label 或 url" in result.detail


def test_citation_traceability_enforces_min_citations() -> None:
    result = score_citation_traceability(make_run([terminal()], minCitations=1))
    assert not result.passed
    assert "少于期望 1 条" in result.detail


# --- tool_ledger_completeness ---


def tool_event(event_type: str, call_id: str = "tc1", **payload: Any) -> dict[str, Any]:
    return {"type": event_type, "toolCallId": call_id, "operationRef": "op1", **payload}


def test_tool_ledger_accepts_paired_start_and_terminal() -> None:
    run = make_run([tool_event("tool.started"), tool_event("tool.completed"), terminal()])
    assert score_tool_ledger_completeness(run).passed


def test_tool_ledger_rejects_missing_terminal() -> None:
    result = score_tool_ledger_completeness(make_run([tool_event("tool.started")]))
    assert not result.passed
    assert "没有终态事件" in result.detail


def test_tool_ledger_rejects_terminal_without_start() -> None:
    result = score_tool_ledger_completeness(make_run([tool_event("tool.completed")]))
    assert not result.passed
    assert "有终态但无 tool.started" in result.detail


def test_tool_ledger_rejects_duplicate_start_and_double_terminal() -> None:
    run = make_run([
        tool_event("tool.started"),
        tool_event("tool.started"),
        tool_event("tool.completed"),
        tool_event("tool.failed"),
    ])
    result = score_tool_ledger_completeness(run)
    assert not result.passed
    assert any("重复 tool.started" in item for item in result.failures)
    assert any("多个终态" in item for item in result.failures)


def test_tool_ledger_requires_check_operation_on_unknown() -> None:
    run = make_run([
        tool_event("tool.started"),
        tool_event("tool.unknown", nextAction="continue", reasonCode="X"),
    ])
    result = score_tool_ledger_completeness(run)
    assert not result.passed
    assert "缺少 check_operation" in result.detail


def test_tool_ledger_accepts_wellformed_unknown() -> None:
    run = make_run([
        tool_event("tool.started"),
        tool_event("tool.unknown", nextAction="check_operation", reasonCode="TIMEOUT"),
    ])
    assert score_tool_ledger_completeness(run).passed


def test_tool_ledger_requires_operation_ref() -> None:
    run = make_run([
        {"type": "tool.started", "toolCallId": "tc1", "operationRef": "op1"},
        {"type": "tool.completed", "toolCallId": "tc1"},
    ])
    result = score_tool_ledger_completeness(run)
    assert not result.passed
    assert "缺少 operationRef" in result.detail


# --- plan_legality ---


def test_plan_legality_accepts_monotonic_revisions() -> None:
    run = make_run([
        {"type": "plan.updated", "revision": 1, "steps": [{"stepId": "s1", "status": "todo"}]},
        {"type": "plan.updated", "revision": 2, "steps": [{"stepId": "s1", "status": "done"}]},
    ])
    assert score_plan_legality(run).passed


def test_plan_legality_rejects_non_monotonic_revision() -> None:
    run = make_run([
        {"type": "plan.updated", "revision": 2, "steps": []},
        {"type": "plan.updated", "revision": 2, "steps": []},
    ])
    result = score_plan_legality(run)
    assert not result.passed
    assert "非单调" in result.detail


def test_plan_legality_rejects_steps_missing_fields() -> None:
    run = make_run([{"type": "plan.updated", "revision": 1, "steps": [{"facet": "x"}]}])
    result = score_plan_legality(run)
    assert not result.passed
    assert len(result.failures) == 2


def test_plan_legality_accepts_known_dependencies() -> None:
    run = make_run([
        {
            "type": "plan.updated",
            "revision": 1,
            "steps": [
                {"stepId": "s1", "status": "todo", "dependsOn": []},
                {"stepId": "s2", "status": "todo", "dependsOn": ["s1"]},
            ],
        }
    ])
    assert score_plan_legality(run).passed


def test_plan_legality_rejects_unknown_dependency() -> None:
    run = make_run([
        {
            "type": "plan.updated",
            "revision": 1,
            "steps": [{"stepId": "s1", "status": "todo", "dependsOn": ["ghost"]}],
        }
    ])
    result = score_plan_legality(run)
    assert not result.passed
    assert "依赖未知步骤 ghost" in result.detail


def test_plan_legality_rejects_dependency_cycle() -> None:
    run = make_run([
        {
            "type": "plan.updated",
            "revision": 1,
            "steps": [
                {"stepId": "s1", "status": "todo", "dependsOn": ["s2"]},
                {"stepId": "s2", "status": "todo", "dependsOn": ["s1"]},
            ],
        }
    ])
    result = score_plan_legality(run)
    assert not result.passed
    assert "依赖存在环" in result.detail


def test_plan_legality_rejects_self_dependency() -> None:
    run = make_run([
        {
            "type": "plan.updated",
            "revision": 1,
            "steps": [{"stepId": "s1", "status": "todo", "dependsOn": ["s1"]}],
        }
    ])
    result = score_plan_legality(run)
    assert not result.passed
    assert "依赖存在环" in result.detail


# --- node_pairing ---


def node_event(event_type: str, node_run_id: str = "n1") -> dict[str, Any]:
    return {"type": event_type, "nodeRunId": node_run_id}


def test_node_pairing_accepts_matched_started_and_completed() -> None:
    run = make_run([node_event("node.started"), node_event("node.completed"), terminal()])
    assert score_node_pairing(run).passed


def test_node_pairing_accepts_failed_as_terminal() -> None:
    run = make_run([node_event("node.started"), node_event("node.failed"), terminal()])
    assert score_node_pairing(run).passed


def test_node_pairing_rejects_unterminated_node() -> None:
    result = score_node_pairing(make_run([node_event("node.started")]))
    assert not result.passed
    assert "没有终态事件" in result.detail


def test_node_pairing_rejects_orphan_terminal() -> None:
    result = score_node_pairing(make_run([node_event("node.completed")]))
    assert not result.passed
    assert "有终态但无 node.started" in result.detail


def test_node_pairing_rejects_duplicate_start_and_double_terminal() -> None:
    run = make_run([
        node_event("node.started"),
        node_event("node.started"),
        node_event("node.completed"),
        node_event("node.failed"),
    ])
    result = score_node_pairing(run)
    assert not result.passed
    assert any("重复 node.started" in item for item in result.failures)
    assert any("多个终态" in item for item in result.failures)


def test_node_pairing_rejects_missing_node_run_id() -> None:
    result = score_node_pairing(make_run([{"type": "node.started"}]))
    assert not result.passed
    assert "缺少 nodeRunId" in result.detail


def test_node_pairing_scopes_pairing_per_node_run_id() -> None:
    run = make_run([
        node_event("node.started", "n1"),
        node_event("node.started", "n2"),
        node_event("node.completed", "n2"),
        node_event("node.completed", "n1"),
        terminal(),
    ])
    assert score_node_pairing(run).passed


# --- route_and_channel ---


def test_route_and_channel_accepts_matching_source_and_channels() -> None:
    run = make_run(
        [tool_event("tool.started", channel="web"), terminal(answerSource="model")],
        answerSource="model",
        channels=["web"],
    )
    assert score_route_and_channel(run).passed


def test_route_and_channel_rejects_wrong_answer_source() -> None:
    run = make_run([terminal(answerSource="model")], answerSource="none")
    result = score_route_and_channel(run)
    assert not result.passed
    assert "answerSource" in result.detail


def test_route_and_channel_treats_missing_source_as_none() -> None:
    run = make_run([{"type": "run.failed", "reasonCode": "X"}], answerSource="none")
    assert score_route_and_channel(run).passed


def test_route_and_channel_rejects_unexpected_channel() -> None:
    run = make_run(
        [tool_event("tool.started", channel="xiaohongshu"), terminal()],
        channels=["web"],
    )
    result = score_route_and_channel(run)
    assert not result.passed
    assert "xiaohongshu" in result.detail


def test_route_and_channel_requires_declared_channel_to_be_used() -> None:
    run = make_run([terminal()], channels=["web"])
    result = score_route_and_channel(run)
    assert not result.passed
    assert "!= 期望" in result.detail


def test_route_and_channel_skips_dimensions_left_unset() -> None:
    run = make_run([tool_event("tool.started", channel="web"), terminal()])
    assert score_route_and_channel(run).passed


# --- forbidden_field_scan ---


def test_forbidden_field_scan_passes_on_clean_events() -> None:
    assert score_forbidden_field_scan(make_run([terminal()])).passed


def test_forbidden_field_scan_catches_forbidden_event_field() -> None:
    run = make_run([{"type": "node.started", "prompt": "系统提示"}])
    result = score_forbidden_field_scan(run)
    assert not result.passed
    assert "prompt" in result.detail


def test_forbidden_field_scan_catches_forbidden_span_attribute() -> None:
    span = Span(
        span_id="s1",
        parent_span_id=None,
        trace_id="t1",
        kind="node",
        name="compose",
        started_at="2026-01-01T00:00:00Z",
        ended_at=None,
        status="ok",
        attributes={"apiKey": "sk-secret"},
    )
    result = score_forbidden_field_scan(make_run([terminal()], spans=[span]))
    assert not result.passed
    assert "apiKey" in result.detail


# --- latency_budget ---


def test_latency_budget_sums_node_and_tool_durations() -> None:
    run = make_run(
        [
            {"type": "node.completed", "durationMs": 300},
            {"type": "tool.completed", "durationMs": 700},
            terminal(),
        ],
        maxDurationMs=1000,
    )
    result = score_latency_budget(run)
    assert result.passed
    assert "1000ms" in result.detail


def test_latency_budget_rejects_over_budget() -> None:
    run = make_run([{"type": "node.completed", "durationMs": 1200}], maxDurationMs=1000)
    result = score_latency_budget(run)
    assert not result.passed
    assert "超出预算" in result.detail


def test_latency_budget_without_budget_always_passes() -> None:
    run = make_run([{"type": "node.completed", "durationMs": 99999}])
    result = score_latency_budget(run)
    assert result.passed
    assert "未设预算" in result.detail


# --- 聚合与报告 ---


def test_score_case_runs_every_dimension_in_stable_order() -> None:
    run = make_run([terminal()])
    assert [score.name for score in score_case(run)] == [scorer(run).name for scorer in ALL_SCORERS]
    assert len(ALL_SCORERS) == 9


async def test_report_aggregates_shipped_dataset_to_all_pass() -> None:
    dataset = load_dataset()
    report = build_report(dataset.name, await run_dataset(dataset))

    assert report.passed
    assert report.case_pass_rate == 1.0
    assert len(report.cases) == len(dataset.cases)
    assert report.failures() == []
    for bucket in report.dimension_summary().values():
        assert bucket["failed"] == 0


async def test_report_serialization_is_deterministic_and_machine_readable() -> None:
    dataset = load_dataset()
    first = build_report(dataset.name, await run_dataset(dataset)).to_json()
    second = build_report(dataset.name, await run_dataset(dataset)).to_json()

    assert first == second
    payload = json.loads(first)
    assert payload["version"] == 1
    assert payload["passed"] is True
    assert payload["caseCount"] == len(dataset.cases)
    assert set(payload["dimensions"]) == {
        "terminal_uniqueness",
        "route_and_channel",
        "node_pairing",
        "evidence_lifecycle",
        "citation_traceability",
        "tool_ledger_completeness",
        "plan_legality",
        "forbidden_field_scan",
        "latency_budget",
    }


def test_report_markdown_lists_failures_and_marks_verdict() -> None:
    failing = make_run([terminal(citations=[{"label": "凭空", "url": "https://ghost.com"}])])
    report = build_report("ds", [failing])

    markdown = report.to_markdown()
    assert not report.passed
    assert "存在失败" in markdown
    assert "## 失败明细" in markdown
    assert "citation_traceability" in markdown
    assert report.failures()


def test_report_handles_empty_dataset() -> None:
    report = build_report("empty", [])
    assert report.case_pass_rate == 0.0
    assert report.passed
    assert "用例数：0" in report.to_markdown()


def test_cli_returns_zero_on_pass_and_writes_json(tmp_path: Path) -> None:
    out = tmp_path / "nested" / "report.json"
    assert main(["--json-out", str(out)]) == 0
    payload = json.loads(out.read_text(encoding="utf-8"))
    assert payload["passed"] is True


def test_cli_returns_one_on_failure(tmp_path: Path) -> None:
    bad = {
        "version": 1,
        "name": "bad",
        "cases": [
            {
                "caseId": "x",
                "question": "q",
                "transcript": [
                    {
                        "type": "evidence.updated",
                        "payload": {"evidenceId": "e1", "status": "cited", "url": "https://a.com"},
                    }
                ],
                "finalState": {
                    "run_id": "eval_x",
                    "tenant_id": "eval-tenant",
                    "visitor_id": "eval-visitor",
                    "project_id": "eval-project",
                    "thread_id": "eval-thread-x",
                    "model_id": "m",
                    "answer": "a",
                    "answer_source": "model",
                    "answer_model_calls": 1,
                    "response_status": "completed",
                    "citations": [],
                    "verification_passed": True,
                    "stop_reason": "V",
                    "usage": {},
                    "model_calls": 1,
                    "tool_calls": 0,
                    "evidence": [],
                },
                "expect": {"terminalType": "run.completed"},
            }
        ],
    }
    path = tmp_path / "bad.json"
    path.write_text(json.dumps(bad, ensure_ascii=False), encoding="utf-8")

    assert main(["--dataset", str(path)]) == 1
