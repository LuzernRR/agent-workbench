"""多渠道只读搜索的统一结果与证据协议。

协议吸收了 Luz Crawl 的 production crawler contract：发现候选与已读证据
严格分离，并为每个字段保存渠道、Provider、观测时间和限制。登录会话若由
受控渠道使用，也必须停留在隔离 Provider 内，不能进入本协议、事件或模型。
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

ChannelName = Literal["web", "x", "xiaohongshu"]
OutcomeStatus = Literal["success", "degraded", "failed"]
NextAction = Literal[
    "none",
    "use_fallback",
    "use_alternative_channel",
    "reconnect_account",
    "retry_later",
    "stop",
]


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


class ChannelResolution(StrictChannelModel):
    """渠道的稳定结算语义；不含 Provider 原始异常或认证材料。"""

    status: OutcomeStatus
    primary_provider: str
    effective_provider: str
    reason_code: str | None = None
    message: str | None = None
    retryable: bool = False
    next_action: NextAction = "none"


def next_action_for_reason(reason_code: str | None) -> NextAction:
    code = (reason_code or "").upper()
    if code == "AUTH_REQUIRED":
        return "reconnect_account"
    if code in {"CAPTCHA_REQUIRED", "MCP_OUTPUT_INVALID", "ROBOTS_DENIED"}:
        return "use_alternative_channel"
    if code in {
        "MCP_TIMEOUT",
        "MCP_NETWORK_ERROR",
        "MCP_RATE_LIMITED",
        "MCP_UNAVAILABLE",
        "PROVIDER_UNAVAILABLE",
        "TIMEOUT",
        "RATE_LIMITED",
    }:
        return "retry_later"
    if code in {
        "TOOL_CALL_LIMIT",
        "MODEL_CALL_LIMIT",
        "RUN_TIME_RESERVE",
        "RUN_TIMEOUT",
        "LEDGER_UNAVAILABLE",
        "LEDGER_SETTLEMENT_UNKNOWN",
        "OUTCOME_UNKNOWN",
    }:
        return "stop"
    return "use_alternative_channel" if code else "none"


def channel_resolution(
    *,
    status: OutcomeStatus,
    primary_provider: str,
    effective_provider: str | None = None,
    reason_code: str | None = None,
    message: str | None = None,
    retryable: bool | None = None,
    next_action: NextAction | None = None,
) -> ChannelResolution:
    inferred_action = next_action_for_reason(reason_code)
    inferred_retryable = inferred_action == "retry_later"
    return ChannelResolution(
        status=status,
        primary_provider=primary_provider,
        effective_provider=effective_provider or primary_provider,
        reason_code=reason_code,
        message=message,
        retryable=inferred_retryable if retryable is None else retryable,
        next_action=(
            "use_fallback"
            if status == "degraded" and next_action is None
            else next_action or inferred_action
        ),
    )


class ChannelOutcome(StrictChannelModel):
    ok: bool
    channel: ChannelName
    provider: str
    query: str
    results: list[ChannelResult] = Field(default_factory=list)
    evidence: list[ChannelEvidence] = Field(default_factory=list)
    error_code: str | None = None
    error_message: str | None = None
    resolution: ChannelResolution | None = None

    @model_validator(mode="after")
    def populate_resolution(self) -> ChannelOutcome:
        if self.resolution is None:
            self.resolution = channel_resolution(
                status="success" if self.ok else "failed",
                primary_provider=self.provider,
                reason_code=self.error_code,
                message=self.error_message,
            )
        return self

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
