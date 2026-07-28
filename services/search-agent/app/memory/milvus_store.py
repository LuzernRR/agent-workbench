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
from typing import Any

from app.config.agent import MilvusConfig

_SCOPE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


@dataclass(frozen=True)
class MilvusHealth:
    enabled: bool
    available: bool
    detail: str


def _scope(value: str, field: str) -> str:
    if not _SCOPE.fullmatch(value):
        raise ValueError(f"{field} 不是安全作用域 ID")
    return value


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
        evidence: Iterable[dict[str, Any]],
    ) -> int:
        if not self._health.available or not self._client:
            return 0
        tenant = _scope(tenant_id, "tenant_id")
        visitor = _scope(visitor_id, "visitor_id")
        project = _scope(project_id, "project_id")
        records = []
        for item in evidence:
            text = str(item.get("text") or "")[:8000]
            url = str(item.get("url") or "")[:2048]
            if not text or not url:
                continue
            primary = hashlib.sha256(
                f"{tenant}|{visitor}|{project}|{url}|{self.config.embedding_model_version}".encode()
            ).hexdigest()[:64]
            records.append(
                {
                    "id": primary,
                    "vector": hashing_embedding(text, self.config.embedding_dimension),
                    "tenant_id": tenant,
                    "visitor_id": visitor,
                    "project_id": project,
                    "acl_scope": "visitor_project",
                    "memory_type": "verified_evidence",
                    "embedding_version": self.config.embedding_model_version,
                    "created_at": int(time.time()),
                    "source_url": url,
                    "title": str(item.get("title") or url)[:500],
                    "text": text,
                }
            )
        if not records:
            return 0
        await asyncio.to_thread(
            self._client.upsert, collection_name=self.config.collection, data=records
        )
        return len(records)

    async def recall(
        self,
        *,
        tenant_id: str,
        visitor_id: str,
        project_id: str,
        query: str,
    ) -> list[dict[str, Any]]:
        if not self._health.available or not self._client:
            return []
        tenant = _scope(tenant_id, "tenant_id")
        visitor = _scope(visitor_id, "visitor_id")
        project = _scope(project_id, "project_id")
        expression = (
            f'tenant_id == "{tenant}" and visitor_id == "{visitor}" '
            f'and project_id == "{project}" and acl_scope == "visitor_project" '
            f'and memory_type == "verified_evidence" '
            f'and embedding_version == "{self.config.embedding_model_version}"'
        )
        rows = await asyncio.to_thread(
            self._client.search,
            collection_name=self.config.collection,
            data=[hashing_embedding(query, self.config.embedding_dimension)],
            filter=expression,
            limit=self.config.recall_limit,
            output_fields=["source_url", "title", "text", "created_at", "embedding_version"],
        )
        output: list[dict[str, Any]] = []
        for hit in rows[0] if rows else []:
            entity = hit.get("entity") or {}
            output.append(
                {
                    "url": entity.get("source_url"),
                    "title": entity.get("title"),
                    "text": str(entity.get("text") or "")[:1600],
                    "score": float(hit.get("distance") or 0),
                    "created_at": entity.get("created_at"),
                    "embedding_version": entity.get("embedding_version"),
                }
            )
        return output
