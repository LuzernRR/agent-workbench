from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from app.config.agent import MilvusConfig, agent_config
from app.graph import nodes
from app.graph.context import RunContext
from app.graph.state import initial_state
from app.memory.milvus_store import (
    MilvusEvidenceStore,
    MilvusHealth,
    milvus_client_kwargs,
)


class FakeMilvusClient:
    def __init__(self) -> None:
        self.search_kwargs: dict[str, Any] | None = None
        self.upsert_kwargs: dict[str, Any] | None = None

    def search(self, **kwargs: Any) -> list[list[dict[str, Any]]]:
        self.search_kwargs = kwargs
        return [[{
            "distance": 0.8,
            "entity": {
                "source_url": "https://example.com/source",
                "title": "Source",
                "text": "verified text",
                "created_at": 1,
                "embedding_version": "hashing-test-v1",
            },
        }]]

    def upsert(self, **kwargs: Any) -> None:
        self.upsert_kwargs = kwargs


def config() -> MilvusConfig:
    return MilvusConfig.model_validate({
        "enabled": True,
        "uri": "http://127.0.0.1:19530",
        "collection": "agent_evidence_test",
        "dataDirectory": "D:\\milvus",
        "embeddingModelVersion": "hashing-test-v1",
        "embeddingDimension": 64,
        "recallLimit": 4,
    })


@pytest.mark.asyncio
async def test_recall_always_filters_visitor_project_type_and_embedding() -> None:
    store = MilvusEvidenceStore(config())
    client = FakeMilvusClient()
    store._client = client
    store._health = MilvusHealth(True, True, "ok")

    rows = await store.recall(
        tenant_id="tenant_a",
        visitor_id="visitor_a",
        project_id="project_a",
        query="LangGraph",
    )

    assert rows[0]["url"] == "https://example.com/source"
    expression = str(client.search_kwargs["filter"])
    assert 'tenant_id == "tenant_a"' in expression
    assert 'visitor_id == "visitor_a"' in expression
    assert 'project_id == "project_a"' in expression
    assert 'acl_scope == "visitor_project"' in expression
    assert 'memory_type == "verified_evidence"' in expression
    assert 'embedding_version == "hashing-test-v1"' in expression


@pytest.mark.asyncio
async def test_remember_persists_all_scope_discriminators() -> None:
    store = MilvusEvidenceStore(config())
    client = FakeMilvusClient()
    store._client = client
    store._health = MilvusHealth(True, True, "ok")

    count = await store.remember(
        tenant_id="tenant_a",
        visitor_id="visitor_a",
        project_id="project_a",
        evidence=[{
            "url": "https://example.com/source",
            "title": "Source",
            "text": "verified text",
        }],
    )

    assert count == 1
    record = client.upsert_kwargs["data"][0]
    assert record["tenant_id"] == "tenant_a"
    assert record["visitor_id"] == "visitor_a"
    assert record["project_id"] == "project_a"
    assert record["memory_type"] == "verified_evidence"
    assert record["embedding_version"] == "hashing-test-v1"


@pytest.mark.asyncio
async def test_scope_filter_rejects_expression_injection() -> None:
    store = MilvusEvidenceStore(config())
    store._client = FakeMilvusClient()
    store._health = MilvusHealth(True, True, "ok")

    with pytest.raises(ValueError, match="安全作用域"):
        await store.recall(
            tenant_id='tenant" or true',
            visitor_id="visitor_a",
            project_id="project_a",
            query="x",
        )


def test_milvus_auth_and_tls_are_injected_only_from_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SEARCH_AGENT_MILVUS_TOKEN", "secret-token")
    monkeypatch.setenv("SEARCH_AGENT_MILVUS_DATABASE", "agent_db")
    monkeypatch.setenv("SEARCH_AGENT_MILVUS_TLS", "1")
    monkeypatch.setenv("SEARCH_AGENT_MILVUS_SERVER_PEM", "D:\\certs\\ca.pem")
    monkeypatch.setenv("SEARCH_AGENT_MILVUS_SERVER_NAME", "milvus.internal")

    kwargs = milvus_client_kwargs(config())
    assert kwargs == {
        "uri": "http://127.0.0.1:19530",
        "token": "secret-token",
        "db_name": "agent_db",
        "secure": True,
        "server_pem_path": "D:\\certs\\ca.pem",
        "server_name": "milvus.internal",
    }


@pytest.mark.asyncio
async def test_unavailable_memory_is_reported_degraded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Store:
        health = MilvusHealth(True, False, "down")

        async def recall(self, **kwargs: Any) -> list[dict[str, Any]]:
            raise AssertionError("unavailable store must not be queried")

    events: list[dict[str, Any]] = []
    monkeypatch.setattr(nodes, "get_stream_writer", lambda: events.append)
    runtime = SimpleNamespace(context=RunContext(agent_config(), SimpleNamespace(), Store()))
    await nodes.load_context(
        initial_state("q", project_id="project_1", visitor_id="visitor_1"), runtime
    )
    assert events[0]["status"] == "degraded"
    assert events[0]["reasonCode"] == "MEMORY_UNAVAILABLE"


@pytest.mark.asyncio
async def test_successful_memory_event_omits_nullable_reason_code(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Store:
        health = MilvusHealth(True, True, "ok")

        async def remember(self, **kwargs: Any) -> int:
            return 1

    events: list[dict[str, Any]] = []
    monkeypatch.setattr(nodes, "get_stream_writer", lambda: events.append)
    runtime = SimpleNamespace(context=RunContext(agent_config(), SimpleNamespace(), Store()))
    state = initial_state("q", project_id="project_1", visitor_id="visitor_1")
    state.update({
        "verification_passed": True,
        "stop_reason": "VERIFIED",
        "answer": "已核验回答",
        "evidence": [{
            "url": "https://example.com/source",
            "title": "Source",
            "text": "verified text",
        }],
    })

    await nodes.finalize(state, runtime)

    assert events[0]["type"] == "memory.status"
    assert events[0]["status"] == "stored"
    assert events[0]["storedCount"] == 1
    assert "reasonCode" not in events[0]
