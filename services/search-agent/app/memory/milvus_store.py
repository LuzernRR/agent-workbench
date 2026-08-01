"""Milvus 证据索引。

Milvus 只用于相关性召回，绝不把向量相似度当作事实真实性。所有查询都带
tenant/visitor/project/memory_type/embedding_version 过滤。
"""

from __future__ import annotations

import asyncio
import hashlib
import math
import os
import re
import time
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any, TypedDict
from urllib.parse import urlsplit

from app.config.agent import MilvusConfig

_SCOPE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_SHA256 = re.compile(r"^[a-f0-9]{64}$")


class MemoryReference(TypedDict):
    memory_id: str
    evidence_id: str


class RecalledEvidenceMemory(TypedDict):
    memory_id: str
    evidence_id: str
    source_id: str
    content_hash: str
    source_run_id: str
    url: str
    title: str
    text: str
    captured_at: str
    score: float
    embedding_version: str


@dataclass(frozen=True)
class MilvusHealth:
    enabled: bool
    available: bool
    detail: str


def _scope(value: str, field: str) -> str:
    if not _SCOPE.fullmatch(value):
        raise ValueError(f"{field} 不是安全作用域 ID")
    return value


def _hash(value: str, field: str) -> str:
    if not _SHA256.fullmatch(value):
        raise ValueError(f"{field} 不是 SHA-256")
    return value


def _public_url(value: str) -> str:
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("source_url 不是安全 HTTP(S) URL")
    if parsed.username or parsed.password:
        raise ValueError("source_url 不得包含凭据")
    return value[:2048]


def memory_identity(
    tenant_id: str,
    visitor_id: str,
    project_id: str,
    evidence_id: str,
    content_hash: str,
    embedding_version: str,
) -> str:
    """依据完整作用域和 Evidence provenance 生成稳定 memoryRef。"""

    parts = (
        _scope(tenant_id, "tenant_id"),
        _scope(visitor_id, "visitor_id"),
        _scope(project_id, "project_id"),
        _scope(evidence_id, "evidence_id"),
        _hash(content_hash, "content_hash"),
        _scope(embedding_version, "embedding_version"),
    )
    digest = hashlib.sha256("\0".join(parts).encode("utf-8")).hexdigest()
    return f"memory_{digest[:40]}"


def hashing_embedding(text: str, dimension: int) -> list[float]:
    """确定性轻量 embedding；版本被显式写入每条记录。

    它只承担本地相关性预筛，不用于真实性判断。生产可在保持 collection
    版本过滤的前提下替换为 BGE-M3。
    """
    vector = [0.0] * dimension
    tokens = re.findall(r"[A-Za-z0-9_]+|[\u4e00-\u9fff]", text.lower())
    for token in tokens:
        digest = hashlib.blake2b(token.encode("utf-8"), digest_size=8).digest()
        index = int.from_bytes(digest[:4], "big") % dimension
        sign = 1.0 if digest[4] & 1 else -1.0
        vector[index] += sign
    norm = math.sqrt(sum(value * value for value in vector)) or 1.0
    return [value / norm for value in vector]


def milvus_client_kwargs(config: MilvusConfig) -> dict[str, Any]:
    """从环境注入 Milvus 鉴权/TLS；敏感值不进入 JSON、健康事件或 State。"""
    kwargs: dict[str, Any] = {"uri": config.uri}
    token = os.environ.get("SEARCH_AGENT_MILVUS_TOKEN", "").strip()
    if token:
        kwargs["token"] = token
    database = os.environ.get("SEARCH_AGENT_MILVUS_DATABASE", "").strip()
    if database:
        kwargs["db_name"] = database
    if os.environ.get("SEARCH_AGENT_MILVUS_TLS") == "1":
        kwargs["secure"] = True
        server_pem = os.environ.get("SEARCH_AGENT_MILVUS_SERVER_PEM", "").strip()
        server_name = os.environ.get("SEARCH_AGENT_MILVUS_SERVER_NAME", "").strip()
        if server_pem:
            kwargs["server_pem_path"] = server_pem
        if server_name:
            kwargs["server_name"] = server_name
    return kwargs


class MilvusEvidenceStore:
    def __init__(self, config: MilvusConfig) -> None:
        self.config = config
        self._client: Any | None = None
        self._health = MilvusHealth(config.enabled, False, "尚未初始化")

    @property
    def health(self) -> MilvusHealth:
        return self._health

    async def initialize(self) -> MilvusHealth:
        if not self.config.enabled:
            self._health = MilvusHealth(False, False, "配置已停用")
            return self._health
        try:
            await asyncio.to_thread(self._initialize_sync)
            self._health = MilvusHealth(True, True, "连接正常")
        except Exception as exc:  # noqa: BLE001 - 健康检查必须显式降级
            self._health = MilvusHealth(True, False, type(exc).__name__)
        return self._health

    def _initialize_sync(self) -> None:
        from pymilvus import MilvusClient

        self._client = MilvusClient(**milvus_client_kwargs(self.config))
        if not self._client.has_collection(self.config.collection):
            self._client.create_collection(
                collection_name=self.config.collection,
                dimension=self.config.embedding_dimension,
                metric_type="COSINE",
                consistency_level="Strong",
                auto_id=False,
                id_type="string",
                max_length=128,
                vector_field_name="vector",
                enable_dynamic_field=True,
            )

    async def remember(
        self,
        *,
        tenant_id: str,
        visitor_id: str,
        project_id: str,
        source_run_id: str,
        evidence: Iterable[dict[str, Any]],
    ) -> list[MemoryReference]:
        if not self._health.available or not self._client:
            return []
        tenant = _scope(tenant_id, "tenant_id")
        visitor = _scope(visitor_id, "visitor_id")
        project = _scope(project_id, "project_id")
        source_run = _scope(source_run_id, "source_run_id")
        records = []
        references: list[MemoryReference] = []
        for item in evidence:
            if item.get("status") != "cited":
                continue
            text = str(item.get("text") or "")[:8000]
            url = _public_url(str(item.get("url") or ""))
            if not text or not url:
                continue
            evidence_id = _scope(str(item.get("evidence_id") or ""), "evidence_id")
            source_id = _scope(str(item.get("source_id") or ""), "source_id")
            content_hash = _hash(
                str(item.get("content_hash") or ""), "content_hash"
            )
            captured_at = str(item.get("captured_at") or "")[:80]
            if not captured_at:
                raise ValueError("captured_at 不能为空")
            primary = memory_identity(
                tenant,
                visitor,
                project,
                evidence_id,
                content_hash,
                self.config.embedding_model_version,
            )
            records.append(
                {
                    "id": primary,
                    "memory_id": primary,
                    "vector": hashing_embedding(text, self.config.embedding_dimension),
                    "tenant_id": tenant,
                    "visitor_id": visitor,
                    "project_id": project,
                    "acl_scope": "visitor_project",
                    "memory_type": "verified_evidence",
                    "status": "active",
                    "embedding_version": self.config.embedding_model_version,
                    "created_at": int(time.time()),
                    "source_run_id": source_run,
                    "evidence_id": evidence_id,
                    "source_id": source_id,
                    "content_hash": content_hash,
                    "captured_at": captured_at,
                    "source_url": url,
                    "title": str(item.get("title") or url)[:500],
                    "text": text,
                }
            )
            references.append(
                MemoryReference(memory_id=primary, evidence_id=evidence_id)
            )
        if not records:
            return []
        await asyncio.to_thread(
            self._client.upsert, collection_name=self.config.collection, data=records
        )
        return references

    async def recall(
        self,
        *,
        tenant_id: str,
        visitor_id: str,
        project_id: str,
        query: str,
    ) -> list[RecalledEvidenceMemory]:
        if not self._health.available or not self._client:
            return []
        tenant = _scope(tenant_id, "tenant_id")
        visitor = _scope(visitor_id, "visitor_id")
        project = _scope(project_id, "project_id")
        expression = (
            f'tenant_id == "{tenant}" and visitor_id == "{visitor}" '
            f'and project_id == "{project}" and acl_scope == "visitor_project" '
            f'and memory_type == "verified_evidence" '
            f'and status == "active" '
            f'and embedding_version == "{self.config.embedding_model_version}"'
        )
        rows = await asyncio.to_thread(
            self._client.search,
            collection_name=self.config.collection,
            data=[hashing_embedding(query, self.config.embedding_dimension)],
            filter=expression,
            limit=self.config.recall_limit,
            output_fields=[
                "memory_id",
                "evidence_id",
                "source_id",
                "content_hash",
                "source_run_id",
                "source_url",
                "title",
                "text",
                "captured_at",
                "embedding_version",
            ],
        )
        output: list[RecalledEvidenceMemory] = []
        for hit in rows[0] if rows else []:
            entity = hit.get("entity") or {}
            try:
                memory_id = _scope(str(entity.get("memory_id") or ""), "memory_id")
                evidence_id = _scope(
                    str(entity.get("evidence_id") or ""), "evidence_id"
                )
                source_id = _scope(str(entity.get("source_id") or ""), "source_id")
                content_hash = _hash(
                    str(entity.get("content_hash") or ""), "content_hash"
                )
                source_run_id = _scope(
                    str(entity.get("source_run_id") or ""), "source_run_id"
                )
                url = _public_url(str(entity.get("source_url") or ""))
                captured_at = str(entity.get("captured_at") or "")[:80]
                title = str(entity.get("title") or url)[:500]
                text = str(entity.get("text") or "")[:1600]
                embedding_version = _scope(
                    str(entity.get("embedding_version") or ""),
                    "embedding_version",
                )
                if not captured_at or not text:
                    continue
            except ValueError:
                # 升级前或损坏的记录没有完整 provenance，不能作为记忆线索。
                continue
            output.append(RecalledEvidenceMemory(
                memory_id=memory_id,
                evidence_id=evidence_id,
                source_id=source_id,
                content_hash=content_hash,
                source_run_id=source_run_id,
                url=url,
                title=title,
                text=text,
                captured_at=captured_at,
                score=float(hit.get("distance") or 0),
                embedding_version=embedding_version,
            ))
        return output
