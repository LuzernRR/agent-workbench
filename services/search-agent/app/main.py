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
from fastapi.responses import Response, StreamingResponse
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

from app.api.schemas import SearchRunRequest, validate_run_id
from app.config.agent import agent_config
from app.config.runtime import runtime_config
from app.graph.build import build_graph
from app.harness.runner import HarnessDependencies, HarnessRunner
from app.memory.milvus_store import MilvusEvidenceStore
from app.observability.sink import sink_from_env
from app.observability.trace import TracerFactory
from app.persistence.tool_ledger import ToolOperationLedger
from app.prompts.agents import PROMPT_VERSION
from app.run_control import RunRegistry
from app.tools.channels.xiaohongshu_mcp import (
    XiaohongshuLoginVerification,
    XiaohongshuMcpClient,
    XiaohongshuMcpError,
)
from app.tools.xiaohongshu_verification import XiaohongshuVerificationRegistry


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
    xiaohongshu_verifications = XiaohongshuVerificationRegistry()
    xiaohongshu_origin = os.environ.get("XIAOHONGSHU_MCP_ORIGIN", "").strip()
    xiaohongshu_settings = config.search.channels.xiaohongshu
    xiaohongshu_client = (
        XiaohongshuMcpClient(
            xiaohongshu_origin,
            timeout_ms=xiaohongshu_settings.request_timeout_ms,
            detail_timeout_ms=xiaohongshu_settings.detail_timeout_ms,
            max_attempts=1,
        )
        if xiaohongshu_origin
        else None
    )
    runner = HarnessRunner(
        HarnessDependencies(
            config=config,
            graph=graph,
            ledger=ledger,
            milvus=milvus,
            run_registry=RunRegistry(),
            xiaohongshu_verifications=xiaohongshu_verifications,
        ),
        tracer_factory=TracerFactory(sink_from_env()),
    )

    app.state.agent_config = config
    app.state.runtime_config = runtime
    app.state.milvus = milvus
    app.state.runner = runner
    app.state.checkpoint_mode = checkpoint_mode
    app.state.xiaohongshu_verifications = xiaohongshu_verifications
    app.state.xiaohongshu_client = xiaohongshu_client
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
            "mark_plan_running",
            "research",
            "merge_research",
            "reflect",
            "compose",
            "verify",
            "finalize",
        ],
        "flow": "classify -> plan -> mark_running -> Send(research fan-out) -> merge_research fan-in -> reflect -> replan|compose -> verify -> research_more|rewrite|finalize",
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


def _verification_client(
    request: Request,
    run_id: str,
    challenge_id: str,
) -> XiaohongshuMcpClient:
    try:
        validated_run_id = validate_run_id(run_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="验证会话不存在") from exc
    registry: XiaohongshuVerificationRegistry = (
        request.app.state.xiaohongshu_verifications
    )
    if not registry.owns(
        run_id=validated_run_id,
        challenge_id=challenge_id,
    ):
        raise HTTPException(status_code=404, detail="验证会话不存在")
    client: XiaohongshuMcpClient | None = request.app.state.xiaohongshu_client
    if client is None:
        raise HTTPException(status_code=503, detail="小红书工具账号验证服务未配置")
    return client


def _raise_verification_http_error(exc: XiaohongshuMcpError) -> None:
    status = {
        "VERIFICATION_NOT_FOUND": 404,
        "VERIFICATION_QRCODE_GONE": 410,
        "VERIFICATION_SESSION_UNAVAILABLE": 409,
        "AUTH_REQUIRED": 409,
        "ACCOUNT_ID_UNAVAILABLE": 409,
        "ACCOUNT_MISMATCH": 409,
        "VERIFICATION_TIMEOUT": 408,
        "VERIFICATION_UNAVAILABLE": 503,
        "MCP_TIMEOUT": 504,
        "MCP_UNAVAILABLE": 503,
    }.get(exc.code, 502)
    raise HTTPException(
        status_code=status,
        detail={"reasonCode": exc.code, "message": str(exc)},
    ) from exc


def _verification_payload(
    run_id: str,
    value: XiaohongshuLoginVerification,
) -> dict[str, Any]:
    return {
        "version": 1,
        "runId": run_id,
        "challengeId": value.challenge_id,
        "status": value.status,
        "expiresAt": value.expires_at,
        "retryAfterMs": value.retry_after_ms,
        "reasonCode": value.reason_code,
        "message": value.message,
    }


@app.get("/v1/runs/{run_id}/xiaohongshu-verifications/{challenge_id}")
async def xiaohongshu_verification_status(
    run_id: str,
    challenge_id: str,
    request: Request,
    x_workbench_token: str | None = Header(default=None),
) -> dict[str, Any]:
    _authorize(x_workbench_token)
    client = _verification_client(request, run_id, challenge_id)
    try:
        status = await client.login_verification_status(challenge_id)
    except XiaohongshuMcpError as exc:
        _raise_verification_http_error(exc)
    return _verification_payload(run_id, status)


@app.get("/v1/runs/{run_id}/xiaohongshu-verifications/{challenge_id}/qrcode")
async def xiaohongshu_verification_qrcode(
    run_id: str,
    challenge_id: str,
    request: Request,
    x_workbench_token: str | None = Header(default=None),
) -> Response:
    _authorize(x_workbench_token)
    client = _verification_client(request, run_id, challenge_id)
    try:
        image = await client.login_verification_qrcode(challenge_id)
    except XiaohongshuMcpError as exc:
        _raise_verification_http_error(exc)
    return Response(
        content=image,
        media_type="image/png",
        headers={
            "Cache-Control": "no-store",
            "Content-Disposition": "inline",
            "X-Content-Type-Options": "nosniff",
        },
    )


@app.delete("/v1/runs/{run_id}/xiaohongshu-verifications/{challenge_id}")
async def cancel_xiaohongshu_verification(
    run_id: str,
    challenge_id: str,
    request: Request,
    x_workbench_token: str | None = Header(default=None),
) -> dict[str, Any]:
    _authorize(x_workbench_token)
    client = _verification_client(request, run_id, challenge_id)
    try:
        await client.cancel_login_verification(challenge_id)
    except XiaohongshuMcpError as exc:
        _raise_verification_http_error(exc)
    return {
        "version": 1,
        "runId": run_id,
        "challengeId": challenge_id,
        "status": "cancelled",
    }
