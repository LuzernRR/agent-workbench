"""通用 Web 渠道。"""

from __future__ import annotations

from datetime import UTC, datetime

from app.config.agent import AgentConfig
from app.tools.channels.base import (
    ChannelEvidence,
    ChannelOutcome,
    ChannelResult,
    SourceProvenance,
)
from app.tools.fetch_page import fetch_pages
from app.tools.web_search import web_search


class WebChannel:
    name = "web"

    def __init__(self, config: AgentConfig) -> None:
        self.config = config

    async def search(self, query: str, max_results: int) -> ChannelOutcome:
        outcome = await web_search(
            query,
            max_results=max_results,
            default_provider=self.config.search.default_provider,
            allow_duckduckgo_fallback=self.config.search.allow_duckduckgo_fallback,
        )
        if not outcome.ok:
            return ChannelOutcome(
                ok=False,
                channel="web",
                query=query,
                provider=outcome.provider,
                error_code=(outcome.error_category or "provider_unavailable").upper(),
                error_message=outcome.error or "网页搜索失败",
            )

        selected = outcome.hits[: self.config.graph.max_pages_per_call]
        pages = await fetch_pages(
            [hit.url for hit in selected], concurrency=min(3, len(selected))
        ) if selected else []
        observed_at = datetime.now(UTC).isoformat().replace("+00:00", "Z")
        evidence: list[ChannelEvidence] = []
        verified: set[str] = set()
        for hit, page in zip(selected, pages, strict=True):
            if not page.ok or not page.text:
                continue
            verified.add(hit.url)
            provenance = SourceProvenance(
                discovery_provider=outcome.provider,
                detail_provider=page.extractor,
                source_kind="public_page",
                observed_at=observed_at,
                confidence="high",
            )
            evidence.append(ChannelEvidence(
                channel="web",
                provider=outcome.provider,
                query=query,
                url=page.url,
                title=(page.title or hit.title or page.url)[:300],
                text=page.text[:2400],
                extractor=page.extractor,
                captured_at=observed_at,
                provenance=provenance,
            ))

        results = [
            ChannelResult(
                channel="web",
                provider=outcome.provider,
                query=query,
                url=hit.url,
                title=(hit.title or hit.url)[:300],
                snippet=hit.snippet[:500],
                verified=hit.url in verified,
                limitation=None if hit.url in verified else "仅发现候选，原文未成功读取",
                provenance=SourceProvenance(
                    discovery_provider=outcome.provider,
                    detail_provider="trafilatura" if hit.url in verified else None,
                    source_kind="public_page" if hit.url in verified else "public_index",
                    observed_at=observed_at,
                    confidence="high" if hit.url in verified else "low",
                ),
            )
            for hit in outcome.hits
        ]
        return ChannelOutcome(
            ok=True,
            channel="web",
            provider=outcome.provider,
            query=query,
            results=results,
            evidence=evidence,
        )
