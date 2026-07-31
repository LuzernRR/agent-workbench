from __future__ import annotations

from typing import Any

import pytest

from app.config.agent import agent_config
from app.tools.channels import web as module
from app.tools.channels.web import WebChannel
from app.tools.fetch_page import FetchResult
from app.tools.web_search import SearchHit, SearchOutcome


@pytest.mark.asyncio
async def test_redirected_fetch_uses_the_exact_verified_source_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original = "https://example.com/old"
    final = "https://example.com/new"

    async def search(*args: Any, **kwargs: Any) -> SearchOutcome:
        return SearchOutcome(
            ok=True,
            query="query",
            provider="test",
            hits=[SearchHit(original, "Original", "candidate", 1)],
        )

    async def fetch(*args: Any, **kwargs: Any) -> list[FetchResult]:
        return [FetchResult(
            url=final,
            ok=True,
            status=200,
            title="Final",
            text="verified page text",
            extractor="test",
        )]

    monkeypatch.setattr(module, "web_search", search)
    monkeypatch.setattr(module, "fetch_pages", fetch)
    progress: list[Any] = []
    result = await WebChannel(agent_config()).search("query", 5, progress.append)

    assert result.results[0].url == final
    assert result.results[0].verified is True
    assert result.evidence[0].url == final
    assert progress[-1].source.url == final
