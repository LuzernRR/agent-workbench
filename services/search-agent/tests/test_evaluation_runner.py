"""离线评测 Runner 测试：复用生产边界、确定性、无网络调用。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from app.evaluation.dataset import (
    GoldCase,
    GoldDataset,
    GoldEvent,
    GoldExpectation,
    default_dataset_path,
    load_dataset,
)
from app.evaluation.replay import ReplayGraph
from app.evaluation.runner import build_eval_runner, run_case, run_dataset
from app.harness.runner import HarnessRunner


def minimal_case(case_id: str = "c1") -> GoldCase:
    return GoldCase.model_validate({
        "caseId": case_id,
        "question": "测试问题",
        "transcript": [
            {
                "type": "node.started",
                "payload": {
                    "node": "compose",
                    "nodeRunId": "n1",
                    "agent": "writer",
                    "iteration": 1,
                },
            },
            {
                "type": "node.completed",
                "payload": {
                    "node": "compose",
                    "nodeRunId": "n1",
                    "agent": "writer",
                    "iteration": 1,
                },
            },
        ],
        "finalState": {
            "run_id": f"eval_{case_id}",
            "tenant_id": "eval-tenant",
            "visitor_id": "eval-visitor",
            "project_id": "eval-project",
            "thread_id": f"eval-thread-{case_id}",
            "model_id": "deepseek-v4-flash",
            "answer": "## 结论\n\n答案。",
            "answer_source": "model",
            "answer_model_calls": 1,
            "response_status": "completed",
            "citations": [{"label": "来源", "url": "https://example.com/a"}],
            "verification_passed": True,
            "stop_reason": "VERIFIED",
            "usage": {
                "input_tokens": 10,
                "output_tokens": 5,
                "total_tokens": 15,
                "cost_usd": 0.0,
            },
            "model_calls": 2,
            "tool_calls": 0,
            "evidence": [],
        },
        "expect": {"terminalType": "run.completed"},
    })


async def test_eval_runner_reuses_the_production_harness_boundary() -> None:
    runner, _ = build_eval_runner(minimal_case())
    assert isinstance(runner, HarnessRunner)
    # 图输入必须是回放图，账本不接触真实 Postgres。
    assert isinstance(runner.dependencies.graph, ReplayGraph)
    assert runner.dependencies.milvus is None


def test_eval_runner_module_contains_no_second_run_loop() -> None:
    """静态断言：runner 只能经 HarnessRunner.stream 取事件，不得自建运行循环。"""
    import app.evaluation.runner as runner_module

    source = Path(runner_module.__file__).read_text(encoding="utf-8")
    assert "graph.astream" not in source
    assert "initial_state" not in source
    assert "stream_mode" not in source
    # 唯一的事件来源必须是生产边界。
    assert source.count("runner.stream(") == 1


async def test_eval_run_is_byte_for_byte_deterministic() -> None:
    first = await run_case(minimal_case())
    second = await run_case(minimal_case())

    assert first.events == second.events
    assert [event["type"] for event in first.events] == [
        "node.started",
        "node.completed",
        "run.completed",
    ]
    # 固定时钟与 streamId 使事件 envelope 完全可复现。
    assert {event["createdAt"] for event in first.events} == {"2026-01-01T00:00:00Z"}
    assert [event["streamSeq"] for event in first.events] == [1, 2, 3]
    assert first.events[0]["eventId"] == "eval_stream_c1_000001"


async def test_eval_run_derives_spans_without_touching_the_event_stream() -> None:
    with_spans = await run_case(minimal_case(), collect_spans=True)
    without_spans = await run_case(minimal_case(), collect_spans=False)

    assert with_spans.events == without_spans.events
    assert without_spans.spans == []
    assert [span.kind for span in with_spans.spans] == ["node", "run"]


async def test_eval_run_keeps_private_final_state_out_of_public_events() -> None:
    source = minimal_case()
    assert source.final_state is not None
    source.final_state["query_brief"] = {"private": "query analysis"}
    source.final_state["search_attempts"] = [{"attempt_id": "attempt_private"}]

    result = await run_case(source)

    assert result.final_state == source.final_state
    encoded_events = json.dumps(result.events, ensure_ascii=False)
    assert "query_brief" not in encoded_events
    assert "attempt_private" not in encoded_events


async def test_terminal_property_returns_the_last_run_event() -> None:
    result = await run_case(minimal_case())
    terminal = result.terminal
    assert terminal is not None
    assert terminal["type"] == "run.completed"
    assert terminal["answerSource"] == "model"


async def test_replay_graph_regenerates_envelopes_and_applies_privacy_gate() -> None:
    case = GoldCase.model_validate({
        "caseId": "leaky",
        "question": "q",
        "transcript": [
            {"type": "node.started", "payload": {"node": "compose", "prompt": "系统提示"}}
        ],
        "expect": {"terminalType": "run.failed"},
    })
    graph = ReplayGraph(case)

    with pytest.raises(ValueError, match="公开事件包含禁止字段"):
        async for _ in graph.astream(None):
            pass


async def test_replay_graph_never_resumes_from_checkpoint() -> None:
    graph = ReplayGraph(minimal_case())
    snapshot = await graph.aget_state({"configurable": {"thread_id": "run:x"}})
    assert snapshot.values == {}


async def test_replay_graph_without_final_state_yields_only_events() -> None:
    case = GoldCase.model_validate({
        "caseId": "no-state",
        "question": "q",
        "transcript": [
            {"type": "node.started", "payload": {"node": "compose", "nodeRunId": "n1"}}
        ],
        "expect": {"terminalType": "run.failed"},
    })
    parts = [part async for part in ReplayGraph(case).astream(None)]
    assert [part["type"] for part in parts] == ["custom"]


async def test_run_dataset_preserves_case_order() -> None:
    dataset = GoldDataset(
        version=1,
        name="ordered",
        cases=[minimal_case("a"), minimal_case("b"), minimal_case("c")],
    )
    results = await run_dataset(dataset)
    assert [result.case.case_id for result in results] == ["a", "b", "c"]


def test_load_dataset_rejects_duplicate_case_ids(tmp_path: Path) -> None:
    payload = {
        "version": 1,
        "name": "dupes",
        "cases": [
            json.loads(minimal_case("same").model_dump_json(by_alias=True)),
            json.loads(minimal_case("same").model_dump_json(by_alias=True)),
        ],
    }
    path = tmp_path / "dupes.json"
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    with pytest.raises(ValueError, match="重复 caseId"):
        load_dataset(path)


def test_load_dataset_rejects_unknown_fields(tmp_path: Path) -> None:
    path = tmp_path / "extra.json"
    path.write_text(
        json.dumps({"version": 1, "name": "x", "cases": [], "surprise": 1}),
        encoding="utf-8",
    )
    with pytest.raises(Exception, match="surprise"):
        load_dataset(path)


def test_default_dataset_path_honours_env_override(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("SEARCH_AGENT_EVAL_DATASET", raising=False)
    assert default_dataset_path().name == "search-agent.json"

    target = tmp_path / "custom.json"
    monkeypatch.setenv("SEARCH_AGENT_EVAL_DATASET", str(target))
    assert default_dataset_path() == target.resolve()


def test_shipped_gold_dataset_is_valid_and_covers_key_dimensions() -> None:
    dataset = load_dataset()

    assert dataset.version == 1
    assert len(dataset.cases) >= 6
    tags = {tag for case in dataset.cases for tag in case.tags}
    assert {"evidence-lifecycle", "tool-ledger", "terminal", "fail-closed"} <= tags
    terminals = {case.expect.terminal_type for case in dataset.cases}
    assert {"run.completed", "run.failed"} <= terminals


async def test_shipped_gold_dataset_runs_offline_without_providers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 任何真实 HTTP 出网都应让本测试失败。
    import httpx

    def forbid(*args: Any, **kwargs: Any) -> None:
        raise AssertionError("离线评测不得发起网络请求")

    monkeypatch.setattr(httpx.AsyncClient, "request", forbid, raising=False)
    monkeypatch.setattr(httpx.Client, "request", forbid, raising=False)

    results = await run_dataset(load_dataset())

    assert len(results) >= 6
    for result in results:
        terminal = result.terminal
        assert terminal is not None
        assert terminal["type"] == result.case.expect.terminal_type


def test_gold_event_and_expectation_reject_unknown_fields() -> None:
    with pytest.raises(Exception, match="surprise"):
        GoldEvent.model_validate({"type": "node.started", "surprise": 1})
    with pytest.raises(Exception, match="surprise"):
        GoldExpectation.model_validate({"terminalType": "run.completed", "surprise": 1})
