"""可观测性 span 模型；所有 attributes 必须通过隐私门控。"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

SpanKind = Literal["run", "node", "tool", "model"]
SpanStatus = Literal["ok", "error", "unknown"]


@dataclass
class Span:
    """最小 span 单元；attributes 已通过 _assert_public 验证。"""

    span_id: str
    parent_span_id: str | None
    trace_id: str
    kind: SpanKind
    name: str
    started_at: str
    ended_at: str | None
    status: SpanStatus
    attributes: dict[str, Any] = field(default_factory=dict)
    events: list[dict[str, Any]] = field(default_factory=list)
