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

from app.api.schemas import SearchRunRequest, validate_run_id
from app.config.agent import agent_config
from app.config.runtime import runtime_config
from app.graph.build import build_graph
from app.harness.runner import HarnessDependencies, HarnessRunner
from app.memory.milvus_store import MilvusEvidenceStore
from app.persistence.tool_ledger import ToolOperationLedger
from app.prompts.agents import PROMPT_VERSION
from app.run_control import RunRegistry


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
    runner = HarnessRunner(HarnessDependencies(
        config=config,
        graph=graph,
        ledger=ledger,
        milvus=milvus,
        run_registry=RunRegistry(),
    ))

    app.state.agent_config = config
    app.state.runtime_config = runtime
    app.state.milvus = milvus
    app.state.runner = runner
    app.state.checkpoint_mode = checkpoint_mode
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


async def _run_stream(request: Request, payload: SearchRunRequest) -> AsyncIterator[bytes]:
    async for event in request.app.state.runner.stream(
        payload,
        is_disconnected=request.is_disconnected,
    ):
        yield _line(event)


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
    decision = await request.app.state.runner.stop(validated)
    return {
        "version": 1,
        "runId": validated,
        "status": decision.status,
        "taskCancelled": decision.task_cancelled,
    }
