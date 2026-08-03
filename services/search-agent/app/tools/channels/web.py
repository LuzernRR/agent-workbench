"""通用 Web 渠道。"""

from __future__ import annotations

from datetime import UTC, datetime

from app.config.agent import AgentConfig
from app.reliability.deadline import DeadlineBudget
from app.tools.channels.base import (
    ChannelEvidence,
    ChannelOutcome,
    ChannelProgressReporter,
    ChannelResult,
    SourceProvenance,
    report_progress,
)
from app.tools.fetch_page import FetchResult, fetch_pages
from app.tools.web_search import web_search


class WebChannel:
    name = "web"

    def __init__(self, config: AgentConfig) -> None:
        self.config = config

    async def search(
        self,
        query: str,
        max_results: int,
        progress: ChannelProgressReporter | None = None,
        *,
        deadline: DeadlineBudget | None = None,
    ) -> ChannelOutcome:
        outcome = await web_search(
            query,
            max_results=max_results,
            default_provider=self.config.search.default_provider,
            allow_duckduckgo_fallback=self.config.search.allow_duckduckgo_fallback,
            deadline=deadline,
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

        hits = outcome.hits[:max_results]
        for result_count in range(1, len(hits) + 1):
            report_progress(
                progress,
                provider=outcome.provider,
                result_count=result_count,
                evidence_count=0,
            )

        selected = hits[: self.config.graph.max_pages_per_call]
        if selected and (deadline is None or not deadline.expired):
            fetch_timeout = min(
                20.0,
                deadline.remaining_seconds() if deadline is not None else 20.0,
            )
            pages = await fetch_pages(
                [hit.url for hit in selected],
                concurrency=min(3, len(selected)),
                timeout=fetch_timeout,
            )
        elif selected:
            pages = [
                FetchResult(
                    url=hit.url,
                    ok=False,
                    error="搜索调用预算已耗尽",
                    error_category="timeout",
                )
                for hit in selected
            ]
        else:
            pages = []
        observed_at = datetime.now(UTC).isoformat().replace("+00:00", "Z")
        evidence: list[ChannelEvidence] = []
        verified: set[str] = set()
        resolved_urls: dict[str, str] = {}
        for hit, page in zip(selected, pages, strict=True):
            if not page.ok or not page.text:
                continue
            verified.add(hit.url)
            resolved_urls[hit.url] = page.url
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
                # A verified result must expose the exact page whose body was
                # read. Redirects and canonical trailing slashes otherwise
                # split one source into two identities downstream, preventing
                # the Agent's source presentation from attaching to the row.
                url=resolved_urls.get(hit.url, hit.url),
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
            for hit in hits
        ]
        result_by_url = {result.url: result for result in results if result.verified}
        for evidence_count, item in enumerate(evidence, start=1):
            report_progress(
                progress,
                provider=outcome.provider,
                result_count=len(results),
                evidence_count=evidence_count,
                source=result_by_url.get(item.url),
            )
        return ChannelOutcome(
            ok=True,
            channel="web",
            provider=outcome.provider,
            query=query,
            results=results,
            evidence=evidence,
        )
