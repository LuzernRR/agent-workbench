"""小红书公开索引与免登录详情读取渠道。"""

from __future__ import annotations

import re
from datetime import UTC, datetime
from urllib.parse import parse_qs, urlsplit

import httpx

from app.config.agent import AgentConfig
from app.tools.channels.base import (
    ChannelEvidence,
    ChannelOutcome,
    ChannelProgressReporter,
    ChannelResult,
    SourceProvenance,
    report_progress,
)
from app.tools.channels.normalization import normalize_public_url, source_dedup_key
from app.tools.robots_policy import check_robots
from app.tools.web_search import SearchHit, web_search

_URL_RE = re.compile(r"https?://(?:www\.)?xiaohongshu\.com/[^\s<>\]\)\"']+", re.IGNORECASE)
_ALLOWED_PATH = re.compile(
    r"^/explore/[A-Za-z0-9]+$"
)
_BLOCK_MARKERS = (
    "requiring CAPTCHA", "安全验证", "访问的页面不见了", "页面不见了", "我要申诉",
    "300012", "操作太快", "稍后再试", "广告屏蔽插件", "登录后查看",
)
_GENERIC_TITLES = {"小红书", "小红书 - 你的生活兴趣社区", "rednote", "found."}
_MAX_READER_BYTES = 1_048_576
_QUERY_NOISE = (
    "小红书", "近期", "最近", "最新", "使用笔记", "使用感受", "真实体验",
    "笔记", "正文", "证据", "来源链接", "来源", "链接", "搜索", "查找",
    "关于", "归纳", "总结", "测评", "推荐", "经验", "可访问", "只读取",
)
_ASCII_QUERY_TERM = re.compile(r"[a-z0-9][a-z0-9.+#_-]{2,}", re.IGNORECASE)
_CJK_QUERY_CHUNK = re.compile(r"[\u4e00-\u9fff]{2,}")


def _allowed_xhs_url(url: str) -> bool:
    try:
        parts = urlsplit(url)
    except ValueError:
        return False
    return (
        parts.scheme == "https"
        and (parts.hostname or "").lower() in {"xiaohongshu.com", "www.xiaohongshu.com"}
        and bool(_ALLOWED_PATH.fullmatch(parts.path.rstrip("/")))
        and not parts.username
        and not parts.password
    )


def _readable_detail_url(url: str) -> bool:
    parts = urlsplit(url)
    if parts.path.startswith("/explore/"):
        return bool(parse_qs(parts.query).get("xsec_token"))
    return True


def _expected_title(title: str) -> str:
    cleaned = re.sub(r"\s*-\s*小红书\s*$", "", title, flags=re.IGNORECASE).strip()
    return "" if cleaned.casefold() in {item.casefold() for item in _GENERIC_TITLES} else cleaned


def _content_matches(expected: str, content: str) -> bool:
    expected = _expected_title(expected)
    if not expected or expected.startswith(("http://", "https://")):
        return False
    compact_expected = re.sub(r"[^\w\u4e00-\u9fff]+", "", expected).casefold()
    compact_content = re.sub(r"[^\w\u4e00-\u9fff]+", "", content).casefold()
    if len(compact_expected) < 4:
        return compact_expected in compact_content
    probe = compact_expected[: min(12, len(compact_expected))]
    return probe in compact_content


def _query_relevance_terms(query: str) -> tuple[set[str], set[str]]:
    """提取保守的英文词和中文主题片段。

    公开搜索 Provider 对 ``site:xiaohongshu.com`` 查询偶尔返回完全无关的最新
    索引页。这里不把搜索摘要当证据，只用它做候选准入：英文主题需命中原词；
    中文长主题至少命中两个二字片段，避免仅因正文里出现一次“通勤”就入选。
    """

    cleaned = query.casefold()
    for noise in _QUERY_NOISE:
        cleaned = cleaned.replace(noise.casefold(), " ")
    ascii_terms = set(_ASCII_QUERY_TERM.findall(cleaned))
    cjk_terms: set[str] = set()
    for chunk in _CJK_QUERY_CHUNK.findall(cleaned):
        if len(chunk) <= 4:
            cjk_terms.add(chunk)
        cjk_terms.update(
            chunk[index:index + 2]
            for index in range(len(chunk) - 1)
        )
    return ascii_terms, cjk_terms


def _hit_matches_query(query: str, hit: SearchHit) -> bool:
    ascii_terms, cjk_terms = _query_relevance_terms(query)
    haystack = f"{hit.title}\n{hit.snippet}".casefold()
    if ascii_terms and not any(term in haystack for term in ascii_terms):
        return False
    if not cjk_terms:
        return bool(ascii_terms)
    matches = {term for term in cjk_terms if term in haystack}
    required = 1 if len(cjk_terms) == 1 else 2
    return len(matches) >= required


class XiaohongshuPublicChannel:
    name = "xiaohongshu"

    def __init__(self, config: AgentConfig) -> None:
        self.config = config
        self.settings = config.search.channels.xiaohongshu
        self.reader_origin = str(self.settings.reader_origin).rstrip("/")

    async def _read_public(self, url: str) -> tuple[str, str | None]:
        if not self.settings.read_public_details:
            return "", "公开详情读取已在配置中停用"
        if not _allowed_xhs_url(url):
            return "", "URL 未通过小红书 host/path 策略"
        if not _readable_detail_url(url):
            return "", "笔记 URL 缺少公开索引提供的 xsec_token"
        reader_url = f"{self.reader_origin}/{url}"
        target_robots = await check_robots(url)
        if not target_robots.allowed:
            return "", f"目标页面 robots.txt 不允许读取：{target_robots.reason}"
        reader_robots = await check_robots(reader_url, user_agent="ChatGPT-User")
        if not reader_robots.allowed:
            return "", f"公开 Reader 的 robots.txt 不允许读取：{reader_robots.reason}"
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(self.settings.request_timeout_ms / 1000, connect=5.0),
                follow_redirects=False,
                trust_env=False,
                headers={
                    "User-Agent": "ChatGPT-User",
                    "Accept": "text/plain,text/markdown;q=0.9",
                    "Accept-Encoding": "identity",
                },
            ) as client:
                response = await client.get(reader_url)
        except httpx.TimeoutException:
            return "", "公开 Reader 读取超时"
        except httpx.HTTPError:
            return "", "公开 Reader 当前不可用"
        if response.status_code == 429:
            return "", "公开 Reader 请求过于频繁"
        if response.status_code >= 400:
            return "", f"公开 Reader 返回 HTTP {response.status_code}"
        if len(response.content) > _MAX_READER_BYTES:
            return "", "公开 Reader 响应超过大小上限"
        text = response.text.strip()
        if any(marker.casefold() in text.casefold() for marker in _BLOCK_MARKERS):
            return "", "页面触发安全验证、登录提示或访问限制"
        marker = "Markdown Content:"
        if marker in text:
            text = text.split(marker, 1)[1].strip()
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text[:20_000], None

    async def _discover(self, query: str, max_results: int):
        exact = _URL_RE.search(query)
        if exact and _allowed_xhs_url(exact.group(0)):
            url = normalize_public_url(exact.group(0))
            return "direct", [SearchHit(url=url, title=url, snippet="", rank=1)]
        outcome = await web_search(
            f"{query} site:xiaohongshu.com/explore",
            max_results=min(max(max_results * 3, max_results), 15),
            default_provider=self.config.search.default_provider,
            allow_duckduckgo_fallback=self.config.search.allow_duckduckgo_fallback,
        )
        if not outcome.ok:
            return outcome, []
        return outcome.provider, [
            hit
            for hit in outcome.hits
            if _allowed_xhs_url(hit.url) and _hit_matches_query(query, hit)
        ][:max_results]

    async def search(
        self,
        query: str,
        max_results: int,
        progress: ChannelProgressReporter | None = None,
    ) -> ChannelOutcome:
        discovery, hits = await self._discover(query, max_results)
        if not isinstance(discovery, str):
            return ChannelOutcome(
                ok=False,
                channel="xiaohongshu",
                provider=discovery.provider,
                query=query,
                error_code=(discovery.error_category or "provider_unavailable").upper(),
                error_message=discovery.error or "小红书公开索引搜索失败",
            )
        observed_at = datetime.now(UTC).isoformat().replace("+00:00", "Z")
        results: list[ChannelResult] = []
        evidence: list[ChannelEvidence] = []
        seen: set[str] = set()
        for hit in hits[:max_results]:
            reader_target = normalize_public_url(hit.url)
            public_url = normalize_public_url(hit.url, preserve_xhs_token=False)
            key = source_dedup_key(reader_target)
            if key in seen:
                continue
            seen.add(key)
            body, limitation = await self._read_public(reader_target)
            matched = bool(body and _content_matches(hit.title, body))
            if body and not matched:
                limitation = "Reader 返回内容与索引标题不匹配，未计入已读来源"
            verified = bool(body and matched)
            title = (_expected_title(hit.title) or hit.title or public_url)[:300]
            provenance = SourceProvenance(
                discovery_provider=discovery,
                detail_provider="jina-public-reader" if body else None,
                source_kind="public_page" if verified else "public_index",
                observed_at=observed_at,
                confidence="medium" if verified else "low",
            )
            result = ChannelResult(
                channel="xiaohongshu",
                provider=f"{discovery}+jina" if verified else discovery,
                query=query,
                url=public_url,
                title=title,
                snippet=hit.snippet[:500],
                verified=verified,
                limitation=None if verified else limitation or "仅发现公开索引，详情未验证",
                provenance=provenance,
            )
            results.append(result)
            report_progress(
                progress,
                provider=result.provider,
                result_count=len(results),
                evidence_count=len(evidence),
            )
            if verified:
                evidence.append(ChannelEvidence(
                    channel="xiaohongshu",
                    provider=f"{discovery}+jina",
                    query=query,
                    url=public_url,
                    title=title,
                    text=body[:2400],
                    extractor="jina-public-reader",
                    captured_at=observed_at,
                    provenance=provenance,
                ))
                report_progress(
                    progress,
                    provider=result.provider,
                    result_count=len(results),
                    evidence_count=len(evidence),
                    source=result,
                )
        return ChannelOutcome(
            ok=True,
            channel="xiaohongshu",
            provider=discovery,
            query=query,
            results=results,
            evidence=evidence,
        )
