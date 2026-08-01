from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from app.config.agent import MilvusConfig, agent_config
from app.graph import nodes
from app.graph.context import RunContext
from app.graph.evidence import normalize_evidence, transition_evidence
from app.graph.state import initial_state
from app.memory.milvus_store import (
    MilvusEvidenceStore,
    MilvusHealth,
    memory_identity,
    milvus_client_kwargs,
)

EVIDENCE_ID = "evidence_0123456789abcdef0123456789abcdef01234567"
SOURCE_ID = "source_0123456789abcdef0123456789abcdef01234567"
CONTENT_HASH = "a" * 64
MEMORY_ID = "memory_0123456789abcdef0123456789abcdef01234567"


def cited_evidence() -> dict[str, Any]:
    item = normalize_evidence({
        "tool_call_id": "call_one",
        "channel": "web",
        "url": "https://example.com/source",
        "title": "Source",
        "text": "verified text",
        "captured_at": "2026-08-01T00:00:00Z",
    })
    item, _ = transition_evidence(item, "accepted", "SOURCE_PRESENTED")
    item, _ = transition_evidence(item, "cited", "ANSWER_CITED")
    return item


class FakeMilvusClient:
    def __init__(self) -> None:
        self.search_kwargs: dict[str, Any] | None = None
        self.upsert_kwargs: dict[str, Any] | None = None

    def search(self, **kwargs: Any) -> list[list[dict[str, Any]]]:
        self.search_kwargs = kwargs
        return [[{
            "distance": 0.8,
            "entity": {
                "memory_id": MEMORY_ID,
                "evidence_id": EVIDENCE_ID,
                "source_id": SOURCE_ID,
                "content_hash": CONTENT_HASH,
                "source_run_id": "run_source",
                "source_url": "https://example.com/source",
                "title": "Source",
                "text": "verified text",
                "captured_at": "2026-08-01T00:00:00Z",
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
    assert 'status == "active"' in expression
    assert 'embedding_version == "hashing-test-v1"' in expression
    assert rows[0]["memory_id"] == MEMORY_ID
    assert rows[0]["evidence_id"] == EVIDENCE_ID
    assert rows[0]["source_run_id"] == "run_source"


@pytest.mark.asyncio
async def test_remember_persists_all_scope_discriminators() -> None:
    store = MilvusEvidenceStore(config())
    client = FakeMilvusClient()
    store._client = client
    store._health = MilvusHealth(True, True, "ok")

    references = await store.remember(
        tenant_id="tenant_a",
        visitor_id="visitor_a",
        project_id="project_a",
        source_run_id="run_source",
        evidence=[cited_evidence()],
    )

    assert len(references) == 1
    record = client.upsert_kwargs["data"][0]
    assert record["tenant_id"] == "tenant_a"
    assert record["visitor_id"] == "visitor_a"
    assert record["project_id"] == "project_a"
    assert record["memory_type"] == "verified_evidence"
    assert record["status"] == "active"
    assert record["embedding_version"] == "hashing-test-v1"
    assert record["source_run_id"] == "run_source"
    assert record["evidence_id"] == cited_evidence()["evidence_id"]
    assert record["source_id"] == cited_evidence()["source_id"]
    assert record["content_hash"] == cited_evidence()["content_hash"]
    assert references == [{
        "memory_id": record["memory_id"],
        "evidence_id": record["evidence_id"],
    }]


def test_memory_identity_is_stable_and_scope_separated() -> None:
    item = cited_evidence()
    args = (
        "tenant_a",
        "visitor_a",
        "project_a",
        item["evidence_id"],
        item["content_hash"],
        "hashing-test-v1",
    )
    assert memory_identity(*args) == memory_identity(*args)
    assert memory_identity(*args) != memory_identity(
        "tenant_a",
        "visitor_b",
        "project_a",
        item["evidence_id"],
        item["content_hash"],
        "hashing-test-v1",
    )


@pytest.mark.asyncio
async def test_remember_ignores_non_cited_evidence() -> None:
    store = MilvusEvidenceStore(config())
    client = FakeMilvusClient()
    store._client = client
    store._health = MilvusHealth(True, True, "ok")
    accepted, _ = transition_evidence(
        normalize_evidence({
            **cited_evidence(),
            "status": "read",
            "status_reason_code": "BODY_READ",
        }),
        "accepted",
        "SOURCE_PRESENTED",
    )

    references = await store.remember(
        tenant_id="tenant_a",
        visitor_id="visitor_a",
        project_id="project_a",
        source_run_id="run_source",
        evidence=[accepted],
    )

    assert references == []
    assert client.upsert_kwargs is None


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
    candidates, status = await nodes._recall_memory_candidates(
        initial_state("q", project_id="project_1", visitor_id="visitor_1"),
        runtime,
    )
    assert candidates == []
    assert status == "degraded"
    assert events[0]["type"] == "memory.updated"
    assert events[0]["operation"] == "recall"
    assert events[0]["status"] == "degraded"
    assert events[0]["count"] == 0
    assert events[0]["reasonCode"] == "MEMORY_UNAVAILABLE"


@pytest.mark.asyncio
async def test_load_context_never_recalls_or_injects_evidence_memory() -> None:
    class Store:
        async def recall(self, **kwargs: Any) -> list[dict[str, Any]]:
            raise AssertionError("load_context must not recall evidence memory")

    runtime = SimpleNamespace(context=RunContext(agent_config(), SimpleNamespace(), Store()))
    state = initial_state(
        "你是谁",
        conversation_context="此前讨论过奖学金",
        project_id="project_1",
        visitor_id="visitor_1",
    )

    output = await nodes.load_context(state, runtime)

    assert output["question"] == "你是谁"
    assert output["conversation_context"] == "此前讨论过奖学金"
    assert "memory_candidates" not in output


@pytest.mark.asyncio
async def test_recalled_evidence_stays_in_separate_candidates(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Store:
        health = MilvusHealth(True, True, "ok")

        async def recall(self, **kwargs: Any) -> list[dict[str, Any]]:
            return [{
                "memory_id": MEMORY_ID,
                "evidence_id": EVIDENCE_ID,
                "source_id": SOURCE_ID,
                "content_hash": CONTENT_HASH,
                "source_run_id": "run_source",
                "url": "https://example.com/source",
                "title": "Source",
                "text": "verified text",
                "captured_at": "2026-08-01T00:00:00Z",
                "score": 0.8,
                "embedding_version": "hashing-test-v1",
            }]

    events: list[dict[str, Any]] = []
    monkeypatch.setattr(nodes, "get_stream_writer", lambda: events.append)
    runtime = SimpleNamespace(context=RunContext(agent_config(), SimpleNamespace(), Store()))
    state = initial_state(
        "LangGraph 有什么更新",
        conversation_context="只保留原始会话上下文",
        project_id="project_1",
        visitor_id="visitor_1",
    )

    candidates, status = await nodes._recall_memory_candidates(state, runtime)

    assert status == "completed"
    assert candidates[0]["memory_id"] == MEMORY_ID
    assert state["conversation_context"] == "只保留原始会话上下文"
    assert state["evidence"] == []
    assert len(events) == 1
    assert events[0]["type"] == "memory.updated"
    assert events[0]["operation"] == "recall"
    assert events[0]["status"] == "completed"
    assert events[0]["count"] == 1
    assert events[0]["memoryRefs"] == [MEMORY_ID]
    assert events[0]["evidenceIds"] == [EVIDENCE_ID]
    assert events[0]["embeddingVersion"] == agent_config().milvus.embedding_model_version


@pytest.mark.asyncio
async def test_successful_memory_event_omits_nullable_reason_code(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Store:
        health = MilvusHealth(True, True, "ok")
        remember_kwargs: dict[str, Any] | None = None

        async def remember(self, **kwargs: Any) -> list[dict[str, str]]:
            self.remember_kwargs = kwargs
            evidence_id = kwargs["evidence"][0]["evidence_id"]
            return [{"memory_id": "memory_stored", "evidence_id": evidence_id}]

    events: list[dict[str, Any]] = []
    monkeypatch.setattr(nodes, "get_stream_writer", lambda: events.append)
    store = Store()
    runtime = SimpleNamespace(context=RunContext(agent_config(), SimpleNamespace(), store))
    state = initial_state("q", project_id="project_1", visitor_id="visitor_1")
    state.update({
        "verification_passed": True,
        "stop_reason": "VERIFIED",
        "answer": "已核验回答[来源1]",
        "answer_source": "model",
        "answer_model_calls": 1,
        "evidence": [transition_evidence(cited_evidence(), "cited", "ANSWER_CITED")[0]],
    })

    await nodes.finalize(state, runtime)

    memory_event = next(event for event in events if event["type"] == "memory.updated")
    assert memory_event["operation"] == "store"
    assert memory_event["status"] == "completed"
    assert memory_event["count"] == 1
    assert memory_event["memoryRefs"] == ["memory_stored"]
    assert "reasonCode" not in memory_event
    assert store.remember_kwargs is not None
    assert store.remember_kwargs["source_run_id"] == state["run_id"]
    assert store.remember_kwargs["evidence"][0]["status"] == "cited"


@pytest.mark.asyncio
async def test_partial_run_never_persists_memory_after_a_prior_verification_pass(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Store:
        health = MilvusHealth(True, True, "ok")

        async def remember(self, **kwargs: Any) -> list[dict[str, str]]:
            raise AssertionError("partial run must not persist evidence memory")

    events: list[dict[str, Any]] = []
    monkeypatch.setattr(nodes, "get_stream_writer", lambda: events.append)
    runtime = SimpleNamespace(context=RunContext(agent_config(), SimpleNamespace(), Store()))
    state = initial_state("q", project_id="project_1", visitor_id="visitor_1")
    state.update({
        "verification_passed": True,
        "stop_reason": "TOOL_CALL_LIMIT",
        "answer": "部分回答",
        "evidence": [{
            "url": "https://example.com/source",
            "title": "Source",
            "text": "verified text",
        }],
    })

    output = await nodes.finalize(state, runtime)

    assert output["response_status"] == "partial"
    assert output["verification_passed"] is False
    assert events == []
