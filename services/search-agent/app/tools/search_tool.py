"""面向 Researcher 的严格网页搜索工具。"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.config.agent import AgentConfig
from app.tools.channels.base import ChannelName, SourceProvenance
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
    arguments: SearchToolInput, config: AgentConfig
) -> SearchExecutionResult:
    outcome = await ChannelRegistry(config).execute(
        arguments.channel,
        arguments.query,
        min(arguments.max_results, config.graph.max_results_per_call),
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
        )

    return SearchExecutionResult(
        ok=True,
        channel=arguments.channel,
        query=arguments.query,
        provider=outcome.provider,
        results=[PublicSearchResult.model_validate(item.model_dump()) for item in outcome.results],
        evidence=[SearchEvidence.model_validate(item.model_dump()) for item in outcome.evidence],
    )
