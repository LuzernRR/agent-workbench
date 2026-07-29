from __future__ import annotations

from typing import Any

import pytest

from app.config.agent import agent_config
from app.tools.channels import xiaohongshu_public as module
from app.tools.channels.xiaohongshu_public import (
    XiaohongshuPublicChannel,
    _allowed_xhs_url,
)
from app.tools.robots_policy import RobotsDecision
from app.tools.web_search import SearchHit, SearchOutcome


def hit(title: str = "LangGraph 入门") -> SearchHit:
    return SearchHit(
        "https://www.xiaohongshu.com/explore/abc123?xsec_token=signed",
        title,
        "公开索引摘要",
        1,
    )


@pytest.mark.parametrize(
    "url,allowed",
    [
        ("https://www.xiaohongshu.com/explore/abc123?xsec_token=signed", True),
        ("https://www.xiaohongshu.com/user/profile/abc123", True),
        ("https://www.xiaohongshu.com/goods-detail/abc123", True),
        ("http://www.xiaohongshu.com/explore/abc123", False),
        ("https://evil.example/explore/abc123", False),
        ("https://www.xiaohongshu.com/search_result?keyword=test", False),
    ],
)
def test_xhs_url_allowlist(url: str, allowed: bool) -> None:
    assert _allowed_xhs_url(url) is allowed


@pytest.mark.asyncio
async def test_target_robots_denial_prevents_reader_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    channel = XiaohongshuPublicChannel(agent_config())

    async def denied(url: str, **kwargs: Any) -> RobotsDecision:
        return RobotsDecision(False, "ROBOTS_DENIED", "https://www.xiaohongshu.com/robots.txt", 200)

    monkeypatch.setattr(module, "check_robots", denied)
    body, limitation = await channel._read_public(hit().url)
    assert body == ""
    assert "robots.txt" in (limitation or "")


@pytest.mark.asyncio
async def test_blocked_or_mismatched_reader_body_is_not_evidence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    channel = XiaohongshuPublicChannel(agent_config())

    async def discover(query: str, max_results: int):
        return "test-index", [hit()]

    async def mismatch(url: str) -> tuple[str, str | None]:
        return "完全无关的正文", None

    monkeypatch.setattr(channel, "_discover", discover)
    monkeypatch.setattr(channel, "_read_public", mismatch)
    outcome = await channel.search("LangGraph", 5)

    assert outcome.ok is True
    assert outcome.results[0].verified is False
    assert outcome.evidence == []
    assert "不匹配" in (outcome.results[0].limitation or "")


@pytest.mark.asyncio
async def test_matching_reader_body_becomes_verified_evidence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    channel = XiaohongshuPublicChannel(agent_config())
    reader_targets: list[str] = []

    async def search(*args: Any, **kwargs: Any) -> SearchOutcome:
        return SearchOutcome(
            ok=True,
            query="LangGraph",
            provider="test-index",
            hits=[hit()],
        )

    async def read(url: str) -> tuple[str, str | None]:
        reader_targets.append(url)
        return "LangGraph 入门：状态图与工具调用的实践记录。", None

    monkeypatch.setattr(module, "web_search", search)
    monkeypatch.setattr(channel, "_read_public", read)
    outcome = await channel.search("LangGraph", 5)

    assert outcome.ok is True
    assert outcome.results[0].verified is True
    assert len(outcome.evidence) == 1
    assert outcome.evidence[0].channel == "xiaohongshu"
    assert "xsec_token=signed" in reader_targets[0]
    assert "xsec_token" not in outcome.model_dump_json()
