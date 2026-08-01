"""面向 Researcher 的严格网页搜索工具。"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.config.agent import AgentConfig
from app.tools.channels.base import (
    ChannelName,
    ChannelProgressReporter,
    ChannelResolution,
    ChannelVerificationReporter,
    SourceProvenance,
    channel_resolution,
)
from app.tools.channels.registry import ChannelRegistry


class SearchToolInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    query: str = Field(min_length=2, max_length=300)
    channel: ChannelName
    max_results: Literal[5]


class PublicSearchResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    channel: ChannelName
    provider: str
    query: str
    title: str
    url: str
    snippet: str
    verified: bool
    author: str | None = None
    published_at: str | None = None
    metrics: dict[str, int | float | str] = Field(default_factory=dict)
    limitation: str | None = None
    provenance: SourceProvenance


class SearchEvidence(BaseModel):
    model_config = ConfigDict(extra="forbid")

    channel: ChannelName
    provider: str
    title: str
    url: str
    text: str
    extractor: str
    query: str
    captured_at: str
    author: str | None = None
    published_at: str | None = None
    metrics: dict[str, int | float | str] = Field(default_factory=dict)
    limitation: str | None = None
    provenance: SourceProvenance


class SearchExecutionResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ok: bool
    channel: ChannelName
    query: str
    provider: str
    results: list[PublicSearchResult]
    evidence: list[SearchEvidence]
    error_code: str | None = None
    error_message: str | None = None
    resolution: ChannelResolution | None = None
    interaction_wait_ms: int = Field(default=0, ge=0, le=600_000)

    @model_validator(mode="after")
    def populate_resolution(self) -> SearchExecutionResult:
        if self.resolution is None:
            self.resolution = channel_resolution(
                status="success" if self.ok else "failed",
                primary_provider=self.provider,
                reason_code=self.error_code,
                message=self.error_message,
            )
        return self

    def tool_message(self) -> str:
        # 传给模型的也是经过 schema 收口的结果，不含 Provider 原始 body。
        return self.model_dump_json(by_alias=True)

    def public_dict(self) -> dict[str, Any]:
        return self.model_dump(mode="json", by_alias=True)


SEARCH_TOOL_SPEC: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "web_search",
        "description": (
            "Search one approved channel and read the top available sources. Choose web, x, or "
            "xiaohongshu from the planner's exact channel decision. Xiaohongshu may use the "
            "user-authorized, read-only internal service; it cannot publish, comment, like, or "
            "favorite. The result separates candidates from verified evidence and reports "
            "authentication or access limits."
        ),
        "strict": True,
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "A precise search query preserving entities, dates, versions, and locale.",
                },
                "channel": {
                    "type": "string",
                    "enum": ["web", "x", "xiaohongshu"],
                    "description": "The exact approved channel selected by Planner for this query.",
                },
                "max_results": {
                    "type": "integer",
                    "enum": [5],
                    "description": "Return up to five public search candidates.",
                },
            },
            "required": ["query", "channel", "max_results"],
            "additionalProperties": False,
        },
    },
}


async def execute_search_tool(
    arguments: SearchToolInput,
    config: AgentConfig,
    progress: ChannelProgressReporter | None = None,
    *,
    xiaohongshu_public_only: bool = False,
    verification_request_key: str | None = None,
    verification: ChannelVerificationReporter | None = None,
) -> SearchExecutionResult:
    outcome = await ChannelRegistry(config).execute(
        arguments.channel,
        arguments.query,
        min(arguments.max_results, config.graph.max_results_per_call),
        progress=progress,
        xiaohongshu_public_only=xiaohongshu_public_only,
        verification_request_key=verification_request_key,
        verification=verification,
    )
    if not outcome.ok:
        return SearchExecutionResult(
            ok=False,
            channel=arguments.channel,
            query=arguments.query,
            provider=outcome.provider,
            results=[],
            evidence=[],
            error_code=outcome.error_code or "PROVIDER_UNAVAILABLE",
            error_message=outcome.error_message or "搜索失败",
            resolution=outcome.resolution,
            interaction_wait_ms=outcome.interaction_wait_ms,
        )

    return SearchExecutionResult(
        ok=True,
        channel=arguments.channel,
        query=arguments.query,
        provider=outcome.provider,
        results=[PublicSearchResult.model_validate(item.model_dump()) for item in outcome.results],
        evidence=[SearchEvidence.model_validate(item.model_dump()) for item in outcome.evidence],
        error_code=outcome.error_code,
        error_message=outcome.error_message,
        resolution=outcome.resolution,
        interaction_wait_ms=outcome.interaction_wait_ms,
    )
