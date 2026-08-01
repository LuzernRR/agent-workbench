"""生产 API 与离线评测共享的 Agent Harness 执行边界。"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Protocol

from langgraph.errors import GraphRecursionError

from app.api.schemas import SearchRunRequest
from app.config.agent import AgentConfig
from app.events.runtime import (
    EventClock,
    begin_event_scope,
    end_event_scope,
    runtime_event,
    utc_now,
)
from app.graph.context import RunContext
from app.graph.state import initial_state
from app.prompts.agents import PROMPT_VERSION
from app.run_control import RunRegistry, StopDecision

if TYPE_CHECKING:
    from app.memory.milvus_store import MilvusEvidenceStore
    from app.persistence.tool_ledger import LedgerDecision
    from app.tools.xiaohongshu_verification import XiaohongshuVerificationRegistry

type AgentEvent = dict[str, Any]
type DisconnectProbe = Callable[[], Awaitable[bool]]
type StreamIdFactory = Callable[[], str]
type TimeoutFactory = Callable[[float], AbstractAsyncContextManager[None]]


class HarnessGraph(Protocol):
    """Harness 依赖的最小 LangGraph 运行合同。"""

    def astream(self, *args: Any, **kwargs: Any) -> AsyncIterator[dict[str, Any]]: ...

    async def aget_state(self, config: dict[str, Any]) -> Any: ...


class HarnessLedger(Protocol):
    """Graph 工具调用与 Harness 结算共享的持久账本合同。"""

    async def begin(
        self,
        *,
        idempotency_key: str,
        run_id: str,
        tool_call_id: str,
        visitor_id: str,
        project_id: str | None,
        input_hash: str,
    ) -> LedgerDecision: ...

    async def complete(self, idempotency_key: str, result: dict[str, Any]) -> None: ...

    async def fail(
        self,
        idempotency_key: str,
        result: dict[str, Any],
        error_code: str,
    ) -> None: ...

    async def unknown(self, idempotency_key: str, error_code: str) -> None: ...

    async def unknown_for_run(self, run_id: str, error_code: str) -> None: ...


@dataclass(frozen=True)
class HarnessDependencies:
    """不会写入 checkpoint 的运行时依赖。"""

    config: AgentConfig
    graph: HarnessGraph
    ledger: HarnessLedger
    milvus: MilvusEvidenceStore | None
    run_registry: RunRegistry
    xiaohongshu_verifications: XiaohongshuVerificationRegistry | None = None


class ResumeScopeError(RuntimeError):
    """恢复请求与持久 checkpoint 的安全作用域不一致。"""


async def _never_disconnected() -> bool:
    return False


def _new_stream_id() -> str:
    return f"stream_{uuid.uuid4().hex}"


class HarnessRunner:
    """统一执行 run、resume、cancel、checkpoint、事件与唯一终态。"""

    def __init__(
        self,
        dependencies: HarnessDependencies,
        *,
        event_clock: EventClock = utc_now,
        stream_id_factory: StreamIdFactory = _new_stream_id,
        timeout_factory: TimeoutFactory = asyncio.timeout,
    ) -> None:
        self._dependencies = dependencies
        self._event_clock = event_clock
        self._stream_id_factory = stream_id_factory
        self._timeout_factory = timeout_factory

    @property
    def dependencies(self) -> HarnessDependencies:
        return self._dependencies

    async def stop(self, run_id: str) -> StopDecision:
        """停止活动 run，并把未结算工具结果标记为 unknown。"""
        decision = await self._dependencies.run_registry.stop(run_id)
        if decision.status in {"stopping", "already_stopped"}:
            await self._dependencies.ledger.unknown_for_run(
                run_id, "CANCELLED_OUTCOME_UNKNOWN"
            )
        return decision

    async def stream(
        self,
        payload: SearchRunRequest,
        *,
        is_disconnected: DisconnectProbe | None = None,
    ) -> AsyncIterator[AgentEvent]:
        """执行一次 run；HTTP 与离线调用必须共用此入口。"""
        previous = begin_event_scope(
            payload.run_id,
            stream_id=self._stream_id_factory(),
            clock=self._event_clock,
        )
        try:
            async for event in self._stream_scoped(
                payload,
                is_disconnected=is_disconnected or _never_disconnected,
            ):
                yield event
        finally:
            end_event_scope(previous)

    def _new_state(self, payload: SearchRunRequest) -> dict[str, Any]:
        config = self._dependencies.config
        return initial_state(
            payload.question,
            run_id=payload.run_id,
            tenant_id=payload.tenant_id,
            visitor_id=payload.visitor_id,
            project_id=payload.project_id,
            thread_id=payload.thread_id,
            model_id=payload.model_id,
            reasoning_effort=payload.reasoning_effort,
            conversation_context=payload.context_text(),
            depth=payload.depth,
            max_model_calls=config.graph.max_model_calls,
            max_rounds=config.graph.max_iterations,
            max_tool_calls=config.graph.max_tool_calls,
            max_run_seconds=config.graph.max_run_seconds,
            max_total_tokens=config.graph.max_total_tokens,
            max_cost_usd=config.graph.max_cost_usd,
            no_progress_limit=config.graph.no_progress_limit,
        )

    async def _resolve_graph_input(
        self,
        payload: SearchRunRequest,
        graph_config: dict[str, Any],
    ) -> dict[str, Any] | None:
        if not payload.resume:
            return self._new_state(payload)
        snapshot = await self._dependencies.graph.aget_state(graph_config)
        if not snapshot or not snapshot.values:
            return self._new_state(payload)
        values = snapshot.values
        expected = {
            "run_id": payload.run_id,
            "tenant_id": payload.tenant_id,
            "visitor_id": payload.visitor_id,
            "project_id": payload.project_id,
            "thread_id": payload.thread_id,
            "model_id": payload.model_id,
        }
        if any(values.get(key) != value for key, value in expected.items()):
            raise ResumeScopeError("checkpoint scope mismatch")
        return None

    async def _stream_scoped(
        self,
        payload: SearchRunRequest,
        *,
        is_disconnected: DisconnectProbe,
    ) -> AsyncIterator[AgentEvent]:
        dependencies = self._dependencies
        config = dependencies.config
        graph = dependencies.graph
        run_context = RunContext(
            config=config,
            ledger=dependencies.ledger,  # type: ignore[arg-type]
            milvus=dependencies.milvus,
            xiaohongshu_verifications=dependencies.xiaohongshu_verifications,
        )
        graph_config = {
            "configurable": {"thread_id": f"run:{payload.run_id}"},
            "recursion_limit": config.graph.recursion_limit,
        }
        task = asyncio.current_task()
        if task is None or not await dependencies.run_registry.register(payload.run_id, task):
            yield runtime_event(
                "run.failed",
                reasonCode="RUN_ALREADY_ACTIVE",
                message="相同运行 ID 已在执行",
            )
            return

        last_state: dict[str, Any] | None = None
        try:
            graph_input = await self._resolve_graph_input(payload, graph_config)
            timeout_context = self._timeout_factory(config.graph.max_run_seconds + 10)
            verification_waits: dict[str, tuple[float, float]] = {}
            async with timeout_context:
                async for part in graph.astream(
                    graph_input,
                    config=graph_config,
                    context=run_context,
                    stream_mode=["custom", "values"],
                    version="v2",
                ):
                    if await is_disconnected():
                        raise asyncio.CancelledError("CLIENT_DISCONNECTED")
                    if part["type"] == "custom":
                        event = part["data"]
                        event_type = event.get("type")
                        challenge_id = event.get("challengeId")
                        if (
                            event_type == "tool.verification.required"
                            and isinstance(challenge_id, str)
                            and challenge_id not in verification_waits
                        ):
                            extension = (
                                config.search.channels.xiaohongshu.verification_timeout_ms
                                / 1000
                                + 10
                            )
                            verification_waits[challenge_id] = (
                                asyncio.get_running_loop().time(),
                                extension,
                            )
                            self._shift_timeout(timeout_context, extension)
                        elif (
                            event_type == "tool.verification.resolved"
                            and isinstance(challenge_id, str)
                            and challenge_id in verification_waits
                        ):
                            waiting_at, extension = verification_waits.pop(challenge_id)
                            waited = max(
                                0.0,
                                asyncio.get_running_loop().time() - waiting_at,
                            )
                            self._shift_timeout(
                                timeout_context,
                                -max(0.0, extension - waited),
                            )
                        yield event
                    elif part["type"] == "values":
                        last_state = part["data"]
            if payload.resume and not last_state:
                terminal_snapshot = await graph.aget_state(graph_config)
                if terminal_snapshot and terminal_snapshot.values:
                    last_state = dict(terminal_snapshot.values)
        except TimeoutError:
            await dependencies.ledger.unknown_for_run(
                payload.run_id, "RUN_TIMEOUT_OUTCOME_UNKNOWN"
            )
            yield runtime_event(
                "run.failed",
                reasonCode="RUN_TIMEOUT",
                message="Agent 运行超时",
            )
            return
        except GraphRecursionError:
            yield runtime_event(
                "run.failed",
                reasonCode="RECURSION_LIMIT",
                message="Agent 循环达到上限",
            )
            return
        except ResumeScopeError:
            yield runtime_event(
                "run.failed",
                reasonCode="RESUME_SCOPE_MISMATCH",
                message="恢复请求与已有运行作用域不一致",
            )
            return
        except asyncio.CancelledError as exc:
            if task and hasattr(task, "uncancel"):
                task.uncancel()
            await asyncio.shield(dependencies.ledger.unknown_for_run(
                payload.run_id, "CANCELLED_OUTCOME_UNKNOWN"
            ))
            disconnected = bool(exc.args and exc.args[0] == "CLIENT_DISCONNECTED")
            yield runtime_event(
                "run.stopped",
                runId=payload.run_id,
                responseStatus="partial",
                reasonCode="CLIENT_DISCONNECTED" if disconnected else "USER_STOPPED",
            )
            return
        except Exception as exc:  # noqa: BLE001 - 只返回稳定错误，不泄露 Provider body
            yield runtime_event(
                "run.failed",
                reasonCode=type(exc).__name__.upper()[:80],
                message="Search Agent 运行失败",
            )
            return
        finally:
            await dependencies.run_registry.finish(payload.run_id, task)

        model_calls = int((last_state or {}).get("model_calls") or 0)
        answer_model_calls = int((last_state or {}).get("answer_model_calls") or 0)
        if (
            not last_state
            or not last_state.get("answer")
            or last_state.get("answer_source") != "model"
            or answer_model_calls <= 0
            or model_calls < answer_model_calls
        ):
            if last_state and last_state.get("answer"):
                reason_code = "NON_MODEL_OUTPUT"
            else:
                reason_code = str((last_state or {}).get("stop_reason") or "EMPTY_OUTPUT")
            if not reason_code.replace("_", "").isalnum() or not reason_code.isupper():
                reason_code = "EMPTY_OUTPUT"
            yield runtime_event(
                "run.failed",
                reasonCode=reason_code,
                message="Agent 没有生成可交付的模型回答",
            )
            return
        yield runtime_event(
            "run.completed",
            answerMarkdown=last_state["answer"],
            answerSource="model",
            answerModelCalls=answer_model_calls,
            promptVersion=last_state.get("prompt_version") or PROMPT_VERSION,
            responseStatus=last_state.get("response_status") or "partial",
            citations=last_state.get("citations") or [],
            verificationPassed=bool(last_state.get("verification_passed")),
            stopReason=last_state.get("stop_reason") or "UNKNOWN",
            usage=last_state.get("usage") or {},
            modelCalls=model_calls,
            toolCalls=int(last_state.get("tool_calls") or 0),
            evidenceCount=len(last_state.get("evidence") or []),
        )

    @staticmethod
    def _shift_timeout(timeout_context: Any, seconds: float) -> None:
        """仅在真实安全验证等待期间平移 asyncio 的硬截止时间。"""
        when = getattr(timeout_context, "when", None)
        reschedule = getattr(timeout_context, "reschedule", None)
        if not callable(when) or not callable(reschedule):
            return
        deadline = when()
        if deadline is not None:
            reschedule(deadline + seconds)
