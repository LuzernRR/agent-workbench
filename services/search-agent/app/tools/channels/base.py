"""多渠道只读搜索的统一结果与证据协议。

协议吸收了 Luz Crawl 的 production crawler contract：发现候选与已读证据
严格分离，并为每个字段保存渠道、Provider、观测时间和限制。登录会话若由
受控渠道使用，也必须停留在隔离 Provider 内，不能进入本协议、事件或模型。
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

ChannelName = Literal["web", "x", "xiaohongshu"]


class StrictChannelModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SourceProvenance(StrictChannelModel):
    discovery_provider: str
    detail_provider: str | None = None
    source_kind: Literal[
        "public_index",
        "public_api",
        "public_page",
        "authenticated_page",
    ]
    observed_at: str
    confidence: Literal["high", "medium", "low"]


class ChannelResult(StrictChannelModel):
    channel: ChannelName
    provider: str
    query: str
    url: str
    title: str
    snippet: str
    verified: bool
    author: str | None = None
    published_at: str | None = None
    metrics: dict[str, int | float | str] = Field(default_factory=dict)
    limitation: str | None = None
    provenance: SourceProvenance


class ChannelEvidence(StrictChannelModel):
    channel: ChannelName
    provider: str
    query: str
    url: str
    title: str
    text: str
    extractor: str
    captured_at: str
    author: str | None = None
    published_at: str | None = None
    metrics: dict[str, int | float | str] = Field(default_factory=dict)
    limitation: str | None = None
    provenance: SourceProvenance


class ChannelOutcome(StrictChannelModel):
    ok: bool
    channel: ChannelName
    provider: str
    query: str
    results: list[ChannelResult] = Field(default_factory=list)
    evidence: list[ChannelEvidence] = Field(default_factory=list)
    error_code: str | None = None
    error_message: str | None = None

    def public_payload(self) -> dict[str, Any]:
        return self.model_dump(mode="json")


class ChannelProgress(StrictChannelModel):
    """渠道在真实发现或正文读取完成时发出的单调进度。"""

    provider: str
    result_count: int = Field(ge=0, le=50)
    evidence_count: int = Field(ge=0, le=50)
    source: ChannelResult | None = None


ChannelProgressReporter = Callable[[ChannelProgress], None]


def report_progress(
    reporter: ChannelProgressReporter | None,
    *,
    provider: str,
    result_count: int,
    evidence_count: int,
    source: ChannelResult | None = None,
) -> None:
    if reporter is None:
        return
    reporter(ChannelProgress(
        provider=provider,
        result_count=result_count,
        evidence_count=evidence_count,
        source=source,
    ))
