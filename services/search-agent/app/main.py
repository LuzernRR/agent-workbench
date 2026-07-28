"""Search Agent FastAPI 入口。"""

from __future__ import annotations

import asyncio
import hmac
import ipaddress
import json
import os
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

if sys.platform == "win32":
    # psycopg async checkpointer 在 Windows 上要求 SelectorEventLoop。
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import StreamingResponse
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from langgraph.errors import GraphRecursionError

from app.api.schemas import SearchRunRequest, validate_run_id
from app.config.agent import agent_config
from app.config.runtime import runtime_config
from app.events.runtime import begin_event_scope, end_event_scope, runtime_event
from app.graph.build import build_graph
from app.graph.context import RunContext
from app.graph.state import initial_state
from app.memory.milvus_store import MilvusEvidenceStore
from app.persistence.tool_ledger import ToolOperationLedger
from app.prompts.agents import PROMPT_VERSION
from app.run_control import RunRegistry


class ResumeScopeError(RuntimeError):
    """恢复请求与持久 checkpoint 的安全作用域不一致。"""


@asynccontextmanager
async def lifespan(app: FastAPI):
    config = agent_config()
    runtime = runtime_config()
    if not _internal_auth_configured():
        raise RuntimeError(
            "Search Agent 必须配置 WORKBENCH_INTERNAL_TOKEN；仅显式本机开发模式可豁免"
        )
    if not runtime.database_url:
        raise RuntimeError("Search Agent live 模式必须配置 PostgreSQL 持久账本与 checkpoint")
    ledger = ToolOperationLedger(runtime.database_url)
    await ledger.setup()
    milvus = MilvusEvidenceStore(config.milvus)
    await milvus.initialize()

    saver_cm = AsyncPostgresSaver.from_conn_string(runtime.database_url)
    saver = await saver_cm.__aenter__()
    await saver.setup()
    graph = build_graph(saver)
    checkpoint_mode = "postgres"

    app.state.agent_config = config
    app.state.runtime_config = runtime
    app.state.ledger = ledger
    app.state.milvus = milvus
    app.state.graph = graph
    app.state.checkpoint_mode = checkpoint_mode
    app.state.run_registry = RunRegistry()
    try:
        yield
    finally:
        await saver_cm.__aexit__(None, None, None)


app = FastAPI(
    title="Agent Workbench Search Agent",
    version="0.2.0",
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)


def _insecure_loopback_allowed() -> bool:
    if os.environ.get("SEARCH_AGENT_ALLOW_INSECURE_LOOPBACK") != "1":
        return False
    host = os.environ.get("SEARCH_AGENT_HOST", "127.0.0.1")
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return host.lower() == "localhost"


def _internal_auth_configured() -> bool:
    return bool(os.environ.get("WORKBENCH_INTERNAL_TOKEN", "").strip()) or _insecure_loopback_allowed()


def _authorize(token: str | None) -> None:
    expected = os.environ.get("WORKBENCH_INTERNAL_TOKEN", "").strip()
    if not expected:
        if _insecure_loopback_allowed():
            return
        raise HTTPException(status_code=503, detail="内部服务认证未配置")
    if token is None or not hmac.compare_digest(token, expected):
        raise HTTPException(status_code=401, detail="内部服务认证失败")


@app.get("/health")
async def health(request: Request) -> dict[str, Any]:
    config = request.app.state.agent_config
    runtime = request.app.state.runtime_config
    milvus = request.app.state.milvus.health
    return {
        "status": "ok" if milvus.available or not milvus.enabled else "degraded",
        "service": "search-agent",
        "version": app.version,
        "checkpoint": request.app.state.checkpoint_mode,
        "providerConfigured": bool(runtime.api_key),
        "searchProvider": config.search.default_provider,
        "milvus": {
            "enabled": milvus.enabled,
            "available": milvus.available,
            "detail": milvus.detail,
            "collection": config.milvus.collection,
            "dataDirectory": config.milvus.data_directory,
            "embeddingVersion": config.milvus.embedding_model_version,
        },
    }


@app.get("/v1/graph")
async def graph_definition(
    request: Request,
    x_workbench_token: str | None = Header(default=None),
) -> dict[str, Any]:
    _authorize(x_workbench_token)
    return {
        "version": 1,
        "promptVersion": PROMPT_VERSION,
        "forceSearch": request.app.state.agent_config.search.force_search,
        "nodes": [
            "load_context",
            "classify_intent",
            "plan_research",
            "research",
            "reflect",
            "compose",
            "verify",
            "finalize",
        ],
        "flow": "classify -> plan -> researcher(search+observe) -> reflect -> replan|compose -> verify -> research_more|rewrite|finalize",
    }


def _line(event: dict[str, Any]) -> bytes:
    return (json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def _new_state(payload: SearchRunRequest, config: Any) -> dict[str, Any]:
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
    graph: Any,
    payload: SearchRunRequest,
    config: Any,
    graph_config: dict[str, Any],
) -> dict[str, Any] | None:
    if not payload.resume:
        return _new_state(payload, config)
    snapshot = await graph.aget_state(graph_config)
    if not snapshot or not snapshot.values:
        return _new_state(payload, config)
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


async def _run_stream(request: Request, payload: SearchRunRequest) -> AsyncIterator[bytes]:
    tokens = begin_event_scope(payload.run_id)
    try:
        async for line in _run_stream_scoped(request, payload):
            yield line
    finally:
        end_event_scope(tokens)


async def _run_stream_scoped(request: Request, payload: SearchRunRequest) -> AsyncIterator[bytes]:
    config = request.app.state.agent_config
    graph = request.app.state.graph
    run_context = RunContext(
        config=config,
        ledger=request.app.state.ledger,
        milvus=request.app.state.milvus,
    )
    graph_config = {
        "configurable": {"thread_id": f"run:{payload.run_id}"},
        "recursion_limit": config.graph.recursion_limit,
    }
    task = asyncio.current_task()
    if task is None or not await request.app.state.run_registry.register(payload.run_id, task):
        yield _line(runtime_event(
            "run.failed",
            reasonCode="RUN_ALREADY_ACTIVE",
            message="相同运行 ID 已在执行",
        ))
        return

    last_state: dict[str, Any] | None = None
    try:
        graph_input = await _resolve_graph_input(graph, payload, config, graph_config)
        async with asyncio.timeout(config.graph.max_run_seconds + 10):
            async for part in graph.astream(
                graph_input,
                config=graph_config,
                context=run_context,
                stream_mode=["custom", "values"],
                version="v2",
            ):
                if await request.is_disconnected():
                    raise asyncio.CancelledError("CLIENT_DISCONNECTED")
                if part["type"] == "custom":
                    yield _line(part["data"])
                elif part["type"] == "values":
                    last_state = part["data"]
        if payload.resume and not last_state:
            terminal_snapshot = await graph.aget_state(graph_config)
            if terminal_snapshot and terminal_snapshot.values:
                last_state = dict(terminal_snapshot.values)
    except TimeoutError:
        await request.app.state.ledger.unknown_for_run(
            payload.run_id, "RUN_TIMEOUT_OUTCOME_UNKNOWN"
        )
        yield _line(runtime_event("run.failed", reasonCode="RUN_TIMEOUT", message="Agent 运行超时"))
        return
    except GraphRecursionError:
        yield _line(runtime_event("run.failed", reasonCode="RECURSION_LIMIT", message="Agent 循环达到上限"))
        return
    except ResumeScopeError:
        yield _line(runtime_event(
            "run.failed",
            reasonCode="RESUME_SCOPE_MISMATCH",
            message="恢复请求与已有运行作用域不一致",
        ))
        return
    except asyncio.CancelledError as exc:
        # stop endpoint 会取消当前流任务，以便中断正在等待的 Provider 请求。
        # 取消是预期终态，必须结算为 unknown 而不是让 ASGI 打出未处理异常。
        if task and hasattr(task, "uncancel"):
            task.uncancel()
        await asyncio.shield(request.app.state.ledger.unknown_for_run(
            payload.run_id, "CANCELLED_OUTCOME_UNKNOWN"
        ))
        disconnected = bool(exc.args and exc.args[0] == "CLIENT_DISCONNECTED")
        if not disconnected:
            yield _line(runtime_event(
                "run.stopped",
                runId=payload.run_id,
                responseStatus="partial",
                reasonCode="USER_STOPPED",
            ))
        return
    except Exception as exc:  # noqa: BLE001 - 只返回稳定错误，不泄露 Provider body
        yield _line(runtime_event(
            "run.failed",
            reasonCode=type(exc).__name__.upper()[:80],
            message="Search Agent 运行失败",
        ))
        return
    finally:
        await request.app.state.run_registry.finish(payload.run_id, task)

    if not last_state or not last_state.get("answer"):
        yield _line(runtime_event("run.failed", reasonCode="EMPTY_OUTPUT", message="Agent 没有生成可交付结果"))
        return
    yield _line(runtime_event(
        "run.completed",
        answerMarkdown=last_state["answer"],
        promptVersion=last_state.get("prompt_version") or PROMPT_VERSION,
        responseStatus=last_state.get("response_status") or "partial",
        citations=last_state.get("citations") or [],
        verificationPassed=bool(last_state.get("verification_passed")),
        stopReason=last_state.get("stop_reason") or "UNKNOWN",
        usage=last_state.get("usage") or {},
        modelCalls=int(last_state.get("model_calls") or 0),
        toolCalls=int(last_state.get("tool_calls") or 0),
        evidenceCount=len(last_state.get("evidence") or []),
    ))


@app.post("/v1/runs/stream")
async def stream_run(
    request: Request,
    payload: SearchRunRequest,
    x_workbench_token: str | None = Header(default=None),
) -> StreamingResponse:
    _authorize(x_workbench_token)
    return StreamingResponse(
        _run_stream(request, payload),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )


@app.post("/v1/runs/{run_id}/stop")
async def stop_run(
    run_id: str,
    request: Request,
    x_workbench_token: str | None = Header(default=None),
) -> dict[str, Any]:
    _authorize(x_workbench_token)
    try:
        validated = validate_run_id(run_id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    decision = await request.app.state.run_registry.stop(validated)
    if decision.status in {"stopping", "already_stopped"}:
        await request.app.state.ledger.unknown_for_run(
            validated, "CANCELLED_OUTCOME_UNKNOWN"
        )
    return {
        "version": 1,
        "runId": validated,
        "status": decision.status,
        "taskCancelled": decision.task_cancelled,
    }
