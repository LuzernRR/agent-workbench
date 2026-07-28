"""面向 Researcher 的严格网页搜索工具。"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.config.agent import AgentConfig
from app.tools.fetch_page import fetch_pages
from app.tools.web_search import web_search


class SearchToolInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    query: str = Field(min_length=2, max_length=300)
    max_results: Literal[5]


class PublicSearchResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str
    url: str
    snippet: str
    verified: bool


class SearchEvidence(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str
    url: str
    text: str
    extractor: str
    query: str
    captured_at: str


class SearchExecutionResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ok: bool
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
            "Search the current public web and read the top source pages. Use for fresh facts, "
            "versions, prices, news, comparisons, citations, or explicit search requests. "
            "The result separates unverified candidates from fetched evidence."
        ),
        "strict": True,
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "A precise search query preserving entities, dates, versions, and locale.",
                },
                "max_results": {
                    "type": "integer",
                    "enum": [5],
                    "description": "Return up to five public search candidates.",
                },
            },
            "required": ["query", "max_results"],
            "additionalProperties": False,
        },
    },
}


async def execute_search_tool(
    arguments: SearchToolInput, config: AgentConfig
) -> SearchExecutionResult:
    outcome = await web_search(
        arguments.query,
        max_results=min(arguments.max_results, config.graph.max_results_per_call),
        default_provider=config.search.default_provider,
        allow_duckduckgo_fallback=config.search.allow_duckduckgo_fallback,
    )
    if not outcome.ok:
        return SearchExecutionResult(
            ok=False,
            query=arguments.query,
            provider=outcome.provider,
            results=[],
            evidence=[],
            error_code=(outcome.error_category or "provider_unavailable").upper(),
            error_message=outcome.error or "搜索失败",
        )

    targets = [hit.url for hit in outcome.hits[: config.graph.max_pages_per_call]]
    pages = await fetch_pages(targets, concurrency=min(3, len(targets))) if targets else []
    captured_at = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    evidence: list[SearchEvidence] = []
    verified_candidate_urls: set[str] = set()
    selected_hits = outcome.hits[: config.graph.max_pages_per_call]
    for hit, page in zip(selected_hits, pages, strict=True):
        if not page.ok or not page.text:
            continue
        verified_candidate_urls.add(hit.url)
        evidence.append(
            SearchEvidence(
                title=(page.title or page.url)[:300],
                url=page.url,
                text=page.text[:2400],
                extractor=page.extractor,
                query=arguments.query,
                captured_at=captured_at,
            )
        )

    results = [
        PublicSearchResult(
            title=(hit.title or hit.url)[:300],
            url=hit.url,
            snippet=hit.snippet[:500],
            verified=hit.url in verified_candidate_urls,
        )
        for hit in outcome.hits
    ]
    return SearchExecutionResult(
        ok=True,
        query=arguments.query,
        provider=outcome.provider,
        results=results,
        evidence=evidence,
    )
