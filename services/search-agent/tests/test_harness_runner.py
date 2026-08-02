from __future__ import annotations

import asyncio
from contextlib import AbstractAsyncContextManager
from types import SimpleNamespace
from typing import Any

import pytest
from langgraph.errors import GraphRecursionError

from app.api.schemas import SearchRunRequest
from app.config.agent import agent_config
from app.events.runtime import runtime_event
from app.harness.runner import HarnessDependencies, HarnessRunner
from app.observability.trace import TracerFactory, record_model_call, tracing_enabled
from app.run_control import RunRegistry

FIXED_TIME = "2026-08-01T00:00:00Z"


def payload(*, run_id: str = "run_1", resume: bool = False) -> SearchRunRequest:
    return SearchRunRequest.model_validate({
        "version": 1,
        "runId": run_id,
        "tenantId": "tenant_1",
        "visitorId": "visitor_1",
        "projectId": "project_1",
        "threadId": "thread_1",
        "question": "测试问题",
        "modelId": "deepseek-v4-flash",
        "reasoningEffort": "high",
        "resume": resume,
    })


def completed_state(answer: str = "完成") -> dict[str, Any]:
    return {
        "run_id": "run_1",
        "tenant_id": "tenant_1",
        "visitor_id": "visitor_1",
        "project_id": "project_1",
        "thread_id": "thread_1",
        "model_id": "deepseek-v4-flash",
        "answer": answer,
        "answer_source": "model",
        "answer_model_calls": 1,
        "response_status": "completed",
        "citations": [],
        "verification_passed": True,
        "stop_reason": "VERIFIED",
        "usage": {
            "input_tokens": 1,
            "output_tokens": 1,
            "total_tokens": 2,
            "cost_usd": 0.0,
        },
        "model_calls": 1,
        "tool_calls": 1,
        "evidence": [],
    }


class RecordingLedger:
    def __init__(self) -> None:
        self.unknown_runs: list[tuple[str, str]] = []

    async def unknown_for_run(self, run_id: str, error_code: str) -> None:
        self.unknown_runs.append((run_id, error_code))


class FakeGraph:
    def __init__(
        self,
        *,
        state: dict[str, Any] | None = None,
        snapshot: dict[str, Any] | None = None,
        error: BaseException | None = None,
        entered: asyncio.Event | None = None,
        blocker: asyncio.Event | None = None,
        emit_public_event: bool = False,
    ) -> None:
        self.state = state
        self.snapshot = snapshot
        self.error = error
        self.entered = entered
        self.blocker = blocker
        self.emit_public_event = emit_public_event
        self.inputs: list[Any] = []
        self.configs: list[dict[str, Any]] = []
        self.contexts: list[Any] = []
        self.get_state_calls = 0

    async def aget_state(self, config: dict[str, Any]) -> Any:
        self.get_state_calls += 1
        return SimpleNamespace(values=self.snapshot or {})

    async def astream(self, graph_input: Any, **kwargs: Any):
        self.inputs.append(graph_input)
        self.configs.append(kwargs["config"])
        self.contexts.append(kwargs["context"])
        if self.entered is not None:
            self.entered.set()
        if self.blocker is not None:
            await self.blocker.wait()
        if self.error is not None:
            raise self.error
        if self.emit_public_event:
            yield {
                "type": "custom",
                "data": runtime_event(
                    "node.started",
                    node="plan_research",
                    nodeRunId="node_fixed",
                    agent="planner",
                    iteration=0,
                ),
            }
        if self.state is not None:
            yield {"type": "values", "data": self.state}


class ImmediateTimeout(AbstractAsyncContextManager[None]):
    async def __aenter__(self) -> None:
        raise TimeoutError

    async def __aexit__(self, *args: object) -> bool:
        return False


def runner(
    graph: FakeGraph,
    *,
    ledger: RecordingLedger | None = None,
    registry: RunRegistry | None = None,
    timeout_factory: Any | None = None,
    tracer_factory: Any | None = None,
) -> HarnessRunner:
    options: dict[str, Any] = {
        "event_clock": lambda: FIXED_TIME,
        "stream_id_factory": lambda: "stream_fixed",
    }
    if timeout_factory is not None:
        options["timeout_factory"] = timeout_factory
    if tracer_factory is not None:
        options["tracer_factory"] = tracer_factory
    return HarnessRunner(
        HarnessDependencies(
            config=agent_config(),
            graph=graph,
            ledger=ledger or RecordingLedger(),
            milvus=None,
            run_registry=registry or RunRegistry(),
        ),
        **options,
    )


async def collect(
    harness: HarnessRunner,
    request: SearchRunRequest | None = None,
    **kwargs: Any,
) -> list[dict[str, Any]]:
    return [
        event
        async for event in harness.stream(request or payload(), **kwargs)
    ]


@pytest.mark.asyncio
async def test_no_http_runner_is_deterministic_and_injects_runtime_dependencies() -> None:
    first_graph = FakeGraph(state=completed_state(), emit_public_event=True)
    second_graph = FakeGraph(state=completed_state(), emit_public_event=True)
    first_ledger = RecordingLedger()

    first = await collect(runner(first_graph, ledger=first_ledger))
    second = await collect(runner(second_graph))

    assert first == second
    assert [event["type"] for event in first] == ["node.started", "run.completed"]
    assert [event["streamSeq"] for event in first] == [1, 2]
    assert {event["createdAt"] for event in first} == {FIXED_TIME}
    assert first[-1]["answerMarkdown"] == "完成"
    assert first[-1]["answerSource"] == "model"
    assert first[-1]["answerModelCalls"] == 1
    assert first_graph.inputs[0]["run_id"] == "run_1"
    assert first_graph.configs[0]["configurable"]["thread_id"] == "run:run_1"
    assert first_graph.contexts[0].tool_gateway.ledger is first_ledger
    assert first_graph.contexts[0].config is agent_config()


@pytest.mark.asyncio
async def test_tracing_does_not_change_the_public_event_stream() -> None:
    class RecordingSink:
        def __init__(self) -> None:
            self.spans: list[Any] = []

        def emit(self, span: Any) -> None:
            self.spans.append(span)

        def flush(self) -> None:
            pass

    untraced = await collect(runner(FakeGraph(state=completed_state(), emit_public_event=True)))

    sink = RecordingSink()
    traced = await collect(
        runner(
            FakeGraph(state=completed_state(), emit_public_event=True),
            tracer_factory=TracerFactory(sink),
        )
    )

    # 开启 tracing 后事件流必须逐字节一致。
    assert traced == untraced
    # 且确实派生出了 span：1 个 node span + 1 个 run root span。
    assert [span.kind for span in sink.spans] == ["node", "run"]
    assert sink.spans[-1].attributes["stopReason"] == "VERIFIED"


@pytest.mark.asyncio
async def test_tracer_failure_never_breaks_the_run() -> None:
    class ExplodingTracerSink:
        def emit(self, span: Any) -> None:
            raise RuntimeError("sink unavailable")

        def flush(self) -> None:
            raise RuntimeError("flush unavailable")

    events = await collect(
        runner(
            FakeGraph(state=completed_state(), emit_public_event=True),
            tracer_factory=TracerFactory(ExplodingTracerSink()),
        )
    )

    assert [event["type"] for event in events] == ["node.started", "run.completed"]
    assert events[-1]["answerMarkdown"] == "完成"


@pytest.mark.asyncio
async def test_runner_binds_the_tracer_for_the_model_layer_and_unbinds_after() -> None:
    """节点内的模型层必须能经 contextvar 找到 tracer，run 结束后必须解绑。"""
    class ModelCallingGraph(FakeGraph):
        def __init__(self) -> None:
            super().__init__(state=completed_state(), emit_public_event=True)
            self.tracing_seen: bool | None = None

        async def astream(self, graph_input: Any, **kwargs: Any):
            self.tracing_seen = tracing_enabled()
            record_model_call(
                role="planner",
                model_id="deepseek-v4-flash",
                started_at=FIXED_TIME,
                ended_at=FIXED_TIME,
                status="ok",
                attributes={"inputTokens": 7, "attempts": 1},
            )
            async for chunk in super().astream(graph_input, **kwargs):
                yield chunk

    class RecordingSink:
        def __init__(self) -> None:
            self.spans: list[Any] = []

        def emit(self, span: Any) -> None:
            self.spans.append(span)

        def flush(self) -> None:
            pass

    assert tracing_enabled() is False
    graph = ModelCallingGraph()
    sink = RecordingSink()
    events = await collect(runner(graph, tracer_factory=TracerFactory(sink)))

    assert graph.tracing_seen is True
    model_spans = [span for span in sink.spans if span.kind == "model"]
    assert len(model_spans) == 1
    assert model_spans[0].name == "model:planner"
    assert model_spans[0].attributes["inputTokens"] == 7
    # model span 挂在 run root 之下，与 node/tool span 同源。
    assert model_spans[0].trace_id == "run_1"
    # 事件流不因 model span 增加任何事件。
    assert [event["type"] for event in events] == ["node.started", "run.completed"]
    # run 结束后 contextvar 必须复位，避免泄漏到下一个 run。
    assert tracing_enabled() is False


@pytest.mark.asyncio
async def test_model_layer_records_nothing_when_tracing_is_off() -> None:
    class ModelCallingGraph(FakeGraph):
        def __init__(self) -> None:
            super().__init__(state=completed_state(), emit_public_event=True)
            self.tracing_seen: bool | None = None

        async def astream(self, graph_input: Any, **kwargs: Any):
            self.tracing_seen = tracing_enabled()
            async for chunk in super().astream(graph_input, **kwargs):
                yield chunk

    graph = ModelCallingGraph()
    events = await collect(runner(graph))

    assert graph.tracing_seen is False
    assert [event["type"] for event in events] == ["node.started", "run.completed"]


@pytest.mark.asyncio
async def test_resume_uses_checkpoint_without_new_graph_input_and_replays_terminal() -> None:
    graph = FakeGraph(snapshot=completed_state("checkpoint answer"))
    events = await collect(runner(graph), payload(resume=True))

    assert graph.inputs == [None]
    assert graph.get_state_calls == 2
    assert [event["type"] for event in events] == ["run.completed"]
    assert events[0]["answerMarkdown"] == "checkpoint answer"


@pytest.mark.asyncio
async def test_resume_scope_mismatch_returns_stable_failure_without_running_graph() -> None:
    snapshot = completed_state()
    snapshot["tenant_id"] = "other_tenant"
    graph = FakeGraph(snapshot=snapshot)

    events = await collect(runner(graph), payload(resume=True))

    assert graph.inputs == []
    assert events[0]["type"] == "run.failed"
    assert events[0]["reasonCode"] == "RESUME_SCOPE_MISMATCH"


@pytest.mark.asyncio
async def test_non_model_answer_is_rejected_as_structured_failure() -> None:
    state = completed_state("本地固定回答")
    state["answer_source"] = "none"

    events = await collect(runner(FakeGraph(state=state)))

    assert [event["type"] for event in events] == ["run.failed"]
    assert events[0]["reasonCode"] == "NON_MODEL_OUTPUT"
    assert "answerMarkdown" not in events[0]


@pytest.mark.asyncio
async def test_answer_without_writer_call_receipt_is_rejected() -> None:
    state = completed_state("伪装成模型的本地回答")
    state["answer_model_calls"] = 0

    events = await collect(runner(FakeGraph(state=state)))

    assert [event["type"] for event in events] == ["run.failed"]
    assert events[0]["reasonCode"] == "NON_MODEL_OUTPUT"
    assert "answerMarkdown" not in events[0]


@pytest.mark.asyncio
async def test_duplicate_run_returns_stable_failure() -> None:
    registry = RunRegistry()
    blocker = asyncio.Event()
    active = asyncio.create_task(blocker.wait())
    await registry.register("run_1", active)
    try:
        events = await collect(runner(FakeGraph(), registry=registry))
        assert events[0]["type"] == "run.failed"
        assert events[0]["reasonCode"] == "RUN_ALREADY_ACTIVE"
    finally:
        active.cancel()
        with pytest.raises(asyncio.CancelledError):
            await active
        await registry.finish("run_1", active)


@pytest.mark.asyncio
async def test_timeout_marks_started_tools_unknown_and_returns_stable_failure() -> None:
    ledger = RecordingLedger()
    events = await collect(runner(
        FakeGraph(),
        ledger=ledger,
        timeout_factory=lambda _: ImmediateTimeout(),
    ))

    assert events[0]["reasonCode"] == "RUN_TIMEOUT"
    assert ledger.unknown_runs == [("run_1", "RUN_TIMEOUT_OUTCOME_UNKNOWN")]


@pytest.mark.asyncio
async def test_recursion_empty_output_and_unexpected_error_are_stable() -> None:
    class StableGraphError(RuntimeError):
        code = "RESEARCH_RESULT_CONFLICT"

    recursion = await collect(runner(FakeGraph(error=GraphRecursionError("limit"))))
    empty = await collect(runner(FakeGraph(state={"answer": ""})))
    unexpected = await collect(runner(FakeGraph(error=ValueError("private body"))))
    structured = await collect(runner(FakeGraph(error=StableGraphError("private body"))))

    assert recursion[0]["reasonCode"] == "RECURSION_LIMIT"
    assert empty[0]["reasonCode"] == "EMPTY_OUTPUT"
    assert unexpected[0]["reasonCode"] == "VALUEERROR"
    assert unexpected[0]["message"] == "Search Agent 运行失败"
    assert "private body" not in str(unexpected)
    assert structured[0]["reasonCode"] == "RESEARCH_RESULT_CONFLICT"
    assert "private body" not in str(structured)


@pytest.mark.asyncio
async def test_user_stop_cancels_runner_and_marks_tool_outcome_unknown() -> None:
    entered = asyncio.Event()
    ledger = RecordingLedger()
    harness = runner(
        FakeGraph(entered=entered, blocker=asyncio.Event()),
        ledger=ledger,
    )
    stream = harness.stream(payload())
    next_event = asyncio.create_task(anext(stream))
    await entered.wait()

    decision = await harness.stop("run_1")
    event = await next_event

    assert decision.status == "stopping"
    assert event["type"] == "run.stopped"
    assert event["reasonCode"] == "USER_STOPPED"
    assert ledger.unknown_runs == [
        ("run_1", "CANCELLED_OUTCOME_UNKNOWN"),
        ("run_1", "CANCELLED_OUTCOME_UNKNOWN"),
    ]
    await stream.aclose()


@pytest.mark.asyncio
async def test_client_disconnect_has_safe_terminal_and_unknown_tool_outcome() -> None:
    ledger = RecordingLedger()
    graph = FakeGraph(state=completed_state(), emit_public_event=True)

    async def disconnected() -> bool:
        return True

    events = await collect(
        runner(graph, ledger=ledger),
        is_disconnected=disconnected,
    )

    assert [event["type"] for event in events] == ["run.stopped"]
    assert events[0]["reasonCode"] == "CLIENT_DISCONNECTED"
    assert ledger.unknown_runs == [("run_1", "CANCELLED_OUTCOME_UNKNOWN")]
