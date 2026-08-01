from __future__ import annotations

from typing import Any

import pytest

from app.config.agent import agent_config
from app.tools.channels import xiaohongshu_public as module
from app.tools.channels.xiaohongshu_public import (
    XiaohongshuPublicChannel,
    _allowed_xhs_url,
    _hit_matches_query,
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
        ("https://www.xiaohongshu.com/user/profile/abc123", False),
        ("https://www.xiaohongshu.com/goods-detail/abc123", False),
        ("http://www.xiaohongshu.com/explore/abc123", False),
        ("https://evil.example/explore/abc123", False),
        ("https://www.xiaohongshu.com/search_result?keyword=test", False),
    ],
)
def test_xhs_url_allowlist(url: str, allowed: bool) -> None:
    assert _allowed_xhs_url(url) is allowed


def test_public_index_relevance_rejects_real_unrelated_fallback_hits() -> None:
    unrelated = SearchHit(
        "https://www.xiaohongshu.com/explore/tablet123?xsec_token=signed",
        "满级大屏，这平板电脑将生产力拉满",
        "家里、通勤路上和咖啡馆都能随身使用，真实感受很好。",
        1,
    )
    relevant = SearchHit(
        "https://www.xiaohongshu.com/explore/sunscreen123?xsec_token=signed",
        "油敏皮防晒决赛圈",
        "夏季通勤实测，记录清爽度、成膜和泛油情况。",
        2,
    )

    query = "油敏皮 夏季通勤 防晒 使用感受"
    assert _hit_matches_query(query, unrelated) is False
    assert _hit_matches_query(query, relevant) is True


@pytest.mark.asyncio
async def test_discovery_drops_unrelated_hits_before_public_reader(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    channel = XiaohongshuPublicChannel(agent_config())
    read_urls: list[str] = []

    async def search(*args: Any, **kwargs: Any) -> SearchOutcome:
        assert kwargs["max_results"] == 15
        return SearchOutcome(
            ok=True,
            query="油敏皮 夏季通勤 防晒 使用感受 site:xiaohongshu.com/explore",
            provider="test-index",
            hits=[
                SearchHit(
                    "https://www.xiaohongshu.com/explore/tablet123?xsec_token=signed",
                    "满级大屏，这平板电脑将生产力拉满",
                    "家里、通勤路上和咖啡馆都能随身使用。",
                    1,
                ),
                SearchHit(
                    "https://www.xiaohongshu.com/explore/sunscreen123?xsec_token=signed",
                    "油敏皮防晒决赛圈",
                    "夏季通勤实测，清爽不拔干。",
                    2,
                ),
            ],
        )

    async def read(url: str) -> tuple[str, str | None]:
        read_urls.append(url)
        return "油敏皮防晒决赛圈：夏季通勤清爽度与成膜记录。", None

    monkeypatch.setattr(module, "web_search", search)
    monkeypatch.setattr(channel, "_read_public", read)
    outcome = await channel.search("油敏皮 夏季通勤 防晒 使用感受", 5)

    assert [item.title for item in outcome.results] == ["油敏皮防晒决赛圈"]
    assert len(outcome.evidence) == 1
    assert read_urls == [
        "https://xiaohongshu.com/explore/sunscreen123?xsec_token=signed"
    ]


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
