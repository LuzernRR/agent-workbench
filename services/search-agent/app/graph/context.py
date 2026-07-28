"""LangGraph 运行时依赖；不写入 checkpoint。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from app.config.agent import AgentConfig

if TYPE_CHECKING:
    from app.memory.milvus_store import MilvusEvidenceStore
    from app.persistence.tool_ledger import ToolOperationLedger


@dataclass(frozen=True)
class RunContext:
    config: AgentConfig
    ledger: ToolOperationLedger
    milvus: MilvusEvidenceStore | None = None
