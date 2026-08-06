"""离线评测 Runner：复用生产 HarnessRunner 边界，不实现第二套运行循环。"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from app.api.schemas import SearchRunRequest
from app.config.agent import AgentConfig, agent_config
from app.evaluation.dataset import GoldCase, GoldDataset
from app.evaluation.replay import ReplayGraph
from app.harness.runner import HarnessDependencies, HarnessRunner
from app.observability.trace import TracerFactory
from app.run_control import RunRegistry

FIXED_EVAL_TIME = "2026-01-01T00:00:00Z"


class _EvalLedger:
    """离线账本：回放不产生真实工具调用，只记录 unknown 标记。"""

    def __init__(self) -> None:
        self.unknown_runs: list[tuple[str, str]] = []

    async def unknown_for_run(self, run_id: str, error_code: str) -> None:
        self.unknown_runs.append((run_id, error_code))


class _CollectingSink:
    def __init__(self) -> None:
        self.spans: list[Any] = []

    def emit(self, span: Any) -> None:
        self.spans.append(span)

    def flush(self) -> None:
        pass


@dataclass
class CaseRun:
    """一个用例的完整可判定观测结果。"""

    case: GoldCase
    events: list[dict[str, Any]]
    spans: list[Any] = field(default_factory=list)
    unknown_runs: list[tuple[str, str]] = field(default_factory=list)

    @property
    def terminal(self) -> dict[str, Any] | None:
        terminals = [
            event
            for event in self.events
            if str(event.get("type", "")).startswith("run.")
        ]
        return terminals[-1] if terminals else None


def _eval_request(case: GoldCase) -> SearchRunRequest:
    return SearchRunRequest.model_validate({
        "version": 1,
        "runId": f"eval_{case.case_id}",
        "tenantId": "eval-tenant",
        "visitorId": "eval-visitor",
        "projectId": "eval-project",
        "threadId": f"eval-thread-{case.case_id}",
        "question": case.question,
        "modelId": case.model_id,
        "reasoningEffort": case.reasoning_effort,
        "depth": case.depth,
        "resume": False,
        "checkpointSessionId": f"evaluation_{case.case_id}",
    })


def build_eval_runner(
    case: GoldCase,
    *,
    config: AgentConfig | None = None,
    sink: Any | None = None,
) -> tuple[HarnessRunner, _EvalLedger]:
    """为一个用例构造复用生产边界的 HarnessRunner。"""
    ledger = _EvalLedger()
    runner = HarnessRunner(
        HarnessDependencies(
            config=config or agent_config(),
            graph=ReplayGraph(case),
            ledger=ledger,  # type: ignore[arg-type]
            milvus=None,
            run_registry=RunRegistry(),
        ),
        # 固定时钟与 streamId，使离线评测结果可复现。
        event_clock=lambda: FIXED_EVAL_TIME,
        stream_id_factory=lambda: f"eval_stream_{case.case_id}",
        tracer_factory=TracerFactory(sink) if sink is not None else None,
    )
    return runner, ledger


async def run_case(
    case: GoldCase,
    *,
    config: AgentConfig | None = None,
    collect_spans: bool = True,
) -> CaseRun:
    """执行一个 Gold 用例；事件全部来自生产 HarnessRunner。"""
    sink = _CollectingSink() if collect_spans else None
    runner, ledger = build_eval_runner(case, config=config, sink=sink)
    events = [event async for event in runner.stream(_eval_request(case))]
    return CaseRun(
        case=case,
        events=events,
        spans=list(sink.spans) if sink is not None else [],
        unknown_runs=list(ledger.unknown_runs),
    )


async def run_dataset(
    dataset: GoldDataset,
    *,
    config: AgentConfig | None = None,
) -> list[CaseRun]:
    """按数据集顺序串行执行全部用例，保证结果稳定。"""
    return [await run_case(case, config=config) for case in dataset.cases]


__all__ = [
    "CaseRun",
    "build_eval_runner",
    "run_case",
    "run_dataset",
]
