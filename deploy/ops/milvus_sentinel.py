"""在既有 Evidence collection 中写入并核验隔离的运维哨兵。

哨兵使用 ``memory_type=ops_sentinel``，不会被 Search Agent 的
``verified_evidence`` 召回过滤命中。脚本不会创建或删除 collection；cleanup
只删除当前 tag 对应的一条记录。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
from typing import Any

from pymilvus import MilvusClient

_SAFE_TAG = re.compile(r"^[A-Za-z0-9._-]{3,80}$")


def _sentinel_id(tag: str) -> str:
    return hashlib.sha256(f"agent-workbench-milvus-sentinel|{tag}".encode()).hexdigest()


def _client(uri: str) -> MilvusClient:
    return MilvusClient(uri=uri)


def _assert_collection(client: MilvusClient, collection: str) -> None:
    if not client.has_collection(collection):
        raise RuntimeError(f"collection 不存在：{collection}")


def _write(client: MilvusClient, collection: str, tag: str, dimension: int) -> dict[str, Any]:
    vector = [0.0] * dimension
    vector[0] = 1.0
    record_id = _sentinel_id(tag)
    now = int(time.time())
    client.upsert(
        collection_name=collection,
        data=[
            {
                "id": record_id,
                "vector": vector,
                "tenant_id": "ops",
                "visitor_id": "ops",
                "project_id": "ops",
                "acl_scope": "ops_only",
                "memory_type": "ops_sentinel",
                "embedding_version": "ops-sentinel-v1",
                "created_at": now,
                "source_url": f"https://ops.invalid/milvus-sentinel/{tag}",
                "title": "Milvus persistence sentinel",
                "text": "Operational persistence sentinel; never use as evidence.",
                "sentinel_tag": tag,
            }
        ],
    )
    return {"action": "write", "id": record_id, "tag": tag, "createdAt": now}


def _verify(client: MilvusClient, collection: str, tag: str) -> dict[str, Any]:
    record_id = _sentinel_id(tag)
    deadline = time.monotonic() + 15
    rows: list[dict[str, Any]] = []
    while time.monotonic() < deadline:
        rows = client.get(
            collection_name=collection,
            ids=[record_id],
            output_fields=["sentinel_tag", "memory_type", "created_at"],
        )
        if rows:
            break
        time.sleep(0.5)
    if not rows or rows[0].get("sentinel_tag") != tag:
        raise RuntimeError("哨兵不存在或 tag 不匹配")
    if rows[0].get("memory_type") != "ops_sentinel":
        raise RuntimeError("哨兵隔离字段不正确")
    return {"action": "verify", "id": record_id, "tag": tag, "status": "ok"}


def _cleanup(client: MilvusClient, collection: str, tag: str) -> dict[str, Any]:
    record_id = _sentinel_id(tag)
    client.delete(collection_name=collection, ids=[record_id])
    return {"action": "cleanup", "id": record_id, "tag": tag, "status": "requested"}


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Milvus 持久化哨兵写入/核验工具")
    parser.add_argument("action", choices=("write", "verify", "cleanup"))
    parser.add_argument("--tag", required=True, help="3-80 位维护批次标识")
    parser.add_argument(
        "--uri",
        default=os.environ.get("SEARCH_AGENT_MILVUS_URI", "http://127.0.0.1:19530"),
    )
    parser.add_argument("--collection", default="agent_evidence_v1")
    parser.add_argument("--dimension", type=int, default=384)
    return parser


def main() -> int:
    args = _parser().parse_args()
    if not _SAFE_TAG.fullmatch(args.tag):
        raise SystemExit("tag 只能包含字母、数字、点、下划线和连字符")
    if not 64 <= args.dimension <= 4096:
        raise SystemExit("dimension 必须位于 64-4096")

    client = _client(args.uri)
    _assert_collection(client, args.collection)
    actions = {
        "write": lambda: _write(client, args.collection, args.tag, args.dimension),
        "verify": lambda: _verify(client, args.collection, args.tag),
        "cleanup": lambda: _cleanup(client, args.collection, args.tag),
    }
    try:
        result = actions[args.action]()
    except Exception as exc:  # noqa: BLE001 - CLI 只输出稳定类型，不输出连接串
        print(json.dumps({"status": "failed", "error": type(exc).__name__}, ensure_ascii=False))
        return 1
    print(json.dumps({"status": "ok", **result}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
