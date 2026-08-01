"""LangGraph 运行时依赖；不写入 checkpoint。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from app.config.agent import AgentConfig

if TYPE_CHECKING:
    from app.memory.milvus_store import MilvusEvidenceStore
    from app.tools.gateway import ToolGateway
    from app.tools.xiaohongshu_verification import XiaohongshuVerificationRegistry


@dataclass(frozen=True)
class RunContext:
    config: AgentConfig
    tool_gateway: ToolGateway
    milvus: MilvusEvidenceStore | None = None
    xiaohongshu_verifications: XiaohongshuVerificationRegistry | None = None
