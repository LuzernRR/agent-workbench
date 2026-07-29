"""X/Twitter 公开、免登录渠道。

精确帖子和账号时间线使用 FxEmbed 的公开 API；通用查询若为空，则通过
现有网页搜索 Provider 发现 x.com URL，再逐条读取公开状态。第三方服务
不可用时返回 typed degraded/empty，绝不回退到 Cookie 或浏览器登录态。
"""

from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Any, Literal
from urllib.parse import urlsplit

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
from app.tools.web_search import SearchHit, SearchOutcome, web_search

_STATUS_RE = re.compile(
    r"https?://(?:www\.)?(?:x\.com|twitter\.com)/([A-Za-z0-9_]{1,15})/status/(\d{1,24})",
    re.IGNORECASE,
)
_PROFILE_RE = re.compile(
    r"https?://(?:www\.)?(?:x\.com|twitter\.com)/([A-Za-z0-9_]{1,15})(?:[/?#]|$)",
    re.IGNORECASE,
)
_HANDLE_RE = re.compile(r"(?:^|\s)(?:from:|@)([A-Za-z0-9_]{1,15})(?:\s|$)", re.IGNORECASE)
_MAX_BODY_BYTES = 1_048_576
_RESERVED_HANDLES = {
    "about", "compose", "explore", "home", "i", "intent", "login", "messages",
    "notifications", "privacy", "search", "settings", "share", "signup", "tos",
}

XCandidateKind = Literal["profile", "status"]


def _canonical_x_candidate(raw_url: str) -> tuple[str, XCandidateKind, str, str | None] | None:
    """只接受公开账号主页或单条帖子，拒绝 X 的任意内部路径。"""
    try:
        parts = urlsplit(raw_url.strip())
    except ValueError:
        return None
    host = (parts.hostname or "").casefold()
    if parts.scheme.casefold() not in {"http", "https"} or host not in {
        "x.com", "www.x.com", "twitter.com", "www.twitter.com",
    }:
        return None
    segments = [segment for segment in parts.path.split("/") if segment]
    if not segments or not re.fullmatch(r"[A-Za-z0-9_]{1,15}", segments[0]):
        return None
    handle = segments[0]
    if handle.casefold() in _RESERVED_HANDLES:
        return None
    if len(segments) == 1:
        return f"https://x.com/{handle}", "profile", handle, None
    if (
        len(segments) == 3
        and segments[1].casefold() == "status"
        and re.fullmatch(r"\d{1,24}", segments[2])
    ):
        return f"https://x.com/{handle}/status/{segments[2]}", "status", handle, segments[2]
    return None


def _query_handle(query: str) -> str | None:
    status_match = _STATUS_RE.search(query)
    if status_match and status_match.group(1).casefold() not in _RESERVED_HANDLES:
        return status_match.group(1)
    profile_match = _PROFILE_RE.search(query)
    if profile_match:
        candidate = _canonical_x_candidate(profile_match.group(0))
        if candidate:
            return candidate[2]
    handle_match = _HANDLE_RE.search(query)
    if handle_match and handle_match.group(1).casefold() not in _RESERVED_HANDLES:
        return handle_match.group(1)
    return None


class XProviderError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class XPublicChannel:
    name = "x"

    def __init__(self, config: AgentConfig) -> None:
        self.config = config
        self.settings = config.search.channels.x
        self.origin = str(self.settings.origin).rstrip("/")

    async def _get_json(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        endpoint = f"{self.origin}{path}"
        robots = await check_robots(endpoint)
        if not robots.allowed:
            raise XProviderError(
                "ROBOTS_DENIED",
                "X 第三方公共 API 的 robots.txt 不允许当前服务读取",
            )
        headers = {
            "User-Agent": "agent-workbench-search/0.2 (+https://github.com/LuzernRR/agent-workbench)",
            "Accept": "application/json",
        }
        try:
            async with httpx.AsyncClient(
                base_url=self.origin,
                timeout=httpx.Timeout(self.settings.request_timeout_ms / 1000, connect=5.0),
                follow_redirects=False,
                trust_env=False,
                headers=headers,
            ) as client:
                response = await client.get(path, params=params)
        except httpx.TimeoutException as exc:
            raise XProviderError("TIMEOUT", "X 公开读取超时") from exc
        except httpx.HTTPError as exc:
            raise XProviderError("PROVIDER_UNAVAILABLE", "X 公开读取服务不可用") from exc
        if len(response.content) > _MAX_BODY_BYTES:
            raise XProviderError("OUTPUT_INVALID", "X 公开响应超过大小上限")
        if response.status_code == 429:
            raise XProviderError("RATE_LIMITED", "X 公开读取服务限流")
        if response.status_code == 404:
            try:
                return response.json()
            except ValueError:
                return {"code": 404, "results": []}
        if response.status_code >= 500:
            raise XProviderError("PROVIDER_UNAVAILABLE", "X 公开读取服务异常")
        if response.status_code >= 400:
            raise XProviderError("OUTPUT_INVALID", f"X 公开读取返回 HTTP {response.status_code}")
        try:
            payload = response.json()
        except ValueError as exc:
            raise XProviderError("OUTPUT_INVALID", "X 公开响应不是有效 JSON") from exc
        if not isinstance(payload, dict):
            raise XProviderError("OUTPUT_INVALID", "X 公开响应结构无效")
        return payload

    @staticmethod
    def _status_items(payload: dict[str, Any]) -> list[dict[str, Any]]:
        status = payload.get("status")
        if isinstance(status, dict):
            return [status]
        results = payload.get("results")
        return [item for item in results if isinstance(item, dict)] if isinstance(results, list) else []

    def _normalize_status(
        self, status: dict[str, Any], query: str, observed_at: str
    ) -> tuple[ChannelResult, ChannelEvidence | None] | None:
        raw_url = str(status.get("url") or "")
        match = _STATUS_RE.search(raw_url)
        if not match:
            return None
        url = normalize_public_url(match.group(0))
        text = re.sub(r"\s+", " ", str(status.get("text") or "")).strip()
        author_data = status.get("author") if isinstance(status.get("author"), dict) else {}
        handle = str(author_data.get("screen_name") or match.group(1))
        author = str(author_data.get("name") or handle).strip()[:160] or None
        title = f"@{handle}：{text[:220]}" if text else f"@{handle} 的公开帖子"
        metrics: dict[str, int | float | str] = {}
        for source, target in (
            ("likes", "likes"), ("reposts", "reposts"), ("replies", "replies"),
            ("quotes", "quotes"), ("bookmarks", "bookmarks"), ("views", "views"),
        ):
            value = status.get(source)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                metrics[target] = value
        published_at = str(status.get("created_at") or "").strip() or None
        provenance = SourceProvenance(
            discovery_provider="fxembed",
            detail_provider="fxembed",
            source_kind="public_api",
            observed_at=observed_at,
            confidence="high" if text else "medium",
        )
        result = ChannelResult(
            channel="x",
            provider="fxembed",
            query=query,
            url=url,
            title=title[:300],
            snippet=text[:500],
            verified=bool(text),
            author=author,
            published_at=published_at,
            metrics=metrics,
            limitation=(
                "正文来自第三方公共 API，未直接抓取 x.com 页面"
                if text
                else "公开 API 未返回帖子正文"
            ),
            provenance=provenance,
        )
        evidence = None
        if text:
            evidence = ChannelEvidence(
                channel="x",
                provider="fxembed",
                query=query,
                url=url,
                title=title[:300],
                text=text[:2400],
                extractor="fxembed-public-api",
                captured_at=observed_at,
                author=author,
                published_at=published_at,
                metrics=metrics,
                limitation="正文来自第三方公共 API，未直接抓取 x.com 页面",
                provenance=provenance,
            )
        return result, evidence

    async def _discover_index(self, query: str, max_results: int) -> SearchOutcome:
        """通过公开索引发现 X URL，状态页优先，账号主页只作候选兜底。"""
        handle = _query_handle(query)
        variants = []
        if handle:
            subject = re.sub(
                rf"(?:from:|@){re.escape(handle)}\b",
                handle,
                query,
                flags=re.IGNORECASE,
            )
            variants.append(f"{subject} site:x.com/{handle}/status")
        variants.extend((f"{query} site:x.com status", f"{query} site:x.com"))

        hits: list[SearchHit] = []
        seen: set[str] = set()
        providers: list[str] = []
        last_error: SearchOutcome | None = None
        for variant in dict.fromkeys(variants):
            outcome = await web_search(
                variant,
                max_results=max_results,
                default_provider=self.config.search.default_provider,
                allow_duckduckgo_fallback=self.config.search.allow_duckduckgo_fallback,
            )
            providers.append(outcome.provider)
            if not outcome.ok:
                last_error = outcome
                continue
            for hit in outcome.hits:
                candidate = _canonical_x_candidate(hit.url)
                if not candidate:
                    continue
                canonical = candidate[0]
                key = source_dedup_key(canonical)
                if key in seen:
                    continue
                seen.add(key)
                hits.append(SearchHit(canonical, hit.title, hit.snippet, len(hits) + 1))
                if len(hits) >= max_results:
                    break
            if len(hits) >= max_results:
                break

        provider = "+".join(dict.fromkeys(providers)) or "public_index"
        if hits:
            return SearchOutcome(ok=True, query=query, provider=provider, hits=hits)
        if last_error:
            return SearchOutcome(
                ok=False,
                query=query,
                provider=provider,
                error=last_error.error,
                error_category=last_error.error_category,
            )
        return SearchOutcome(ok=True, query=query, provider=provider, hits=[])

    async def search(
        self,
        query: str,
        max_results: int,
        progress: ChannelProgressReporter | None = None,
    ) -> ChannelOutcome:
        observed_at = datetime.now(UTC).isoformat().replace("+00:00", "Z")
        status_match = _STATUS_RE.search(query)
        profile_match = _PROFILE_RE.search(query)
        direct_candidate = (
            _canonical_x_candidate(status_match.group(0))
            if status_match
            else _canonical_x_candidate(profile_match.group(0)) if profile_match else None
        )
        api_error: XProviderError | None = None
        payload: dict[str, Any] = {}
        try:
            if direct_candidate and direct_candidate[1] == "status":
                assert direct_candidate[3] is not None
                payload = await self._get_json(f"/2/status/{direct_candidate[3]}")
            elif _query_handle(query):
                handle = _query_handle(query)
                assert handle is not None
                payload = await self._get_json(
                    f"/2/profile/{handle}/statuses",
                    {"count": min(max_results, self.settings.max_profile_posts)},
                )
            else:
                payload = await self._get_json(
                    "/2/search", {"q": query, "feed": "latest", "count": max_results}
                )
        except XProviderError as exc:
            api_error = exc

        results: list[ChannelResult] = []
        evidence: list[ChannelEvidence] = []
        seen: set[str] = set()

        def append_result(
            result: ChannelResult,
            item_evidence: ChannelEvidence | None = None,
        ) -> None:
            results.append(result)
            report_progress(
                progress,
                provider=result.provider,
                result_count=len(results),
                evidence_count=len(evidence),
            )
            if item_evidence:
                evidence.append(item_evidence)
                report_progress(
                    progress,
                    provider=result.provider,
                    result_count=len(results),
                    evidence_count=len(evidence),
                    source=result,
                )

        for status in self._status_items(payload)[:max_results]:
            normalized = self._normalize_status(status, query, observed_at)
            if not normalized:
                continue
            result, item_evidence = normalized
            key = source_dedup_key(result.url)
            if key in seen:
                continue
            seen.add(key)
            append_result(result, item_evidence)

        if direct_candidate and direct_candidate[1] == "status" and not results:
            canonical, _, handle, _ = direct_candidate
            seen.add(source_dedup_key(canonical))
            append_result(ChannelResult(
                channel="x",
                provider="direct+fxembed",
                query=query,
                url=canonical,
                title=f"@{handle} 的 X 帖子",
                snippet="",
                verified=False,
                limitation=(
                    str(api_error)
                    if api_error
                    else "已识别帖子 URL，但详情未成功读取"
                ),
                provenance=SourceProvenance(
                    discovery_provider="direct",
                    detail_provider="fxembed",
                    source_kind="public_index",
                    observed_at=observed_at,
                    confidence="low",
                ),
            ))

        if direct_candidate and direct_candidate[1] == "profile" and not results:
            canonical, _, handle, _ = direct_candidate
            seen.add(source_dedup_key(canonical))
            append_result(ChannelResult(
                channel="x",
                provider="direct+fxembed",
                query=query,
                url=canonical,
                title=f"@{handle} 的 X 公开主页",
                snippet="",
                verified=False,
                limitation=(str(api_error) if api_error else "已识别账号主页，但未读取帖子正文"),
                provenance=SourceProvenance(
                    discovery_provider="direct",
                    detail_provider="fxembed",
                    source_kind="public_index",
                    observed_at=observed_at,
                    confidence="low",
                ),
            ))

        # 通用 search 当前可能返回空列表；通过公开搜索索引发现真实 x.com
        # 状态 URL，再用公开 API 逐条读取，避免把索引 snippet 当证据。
        if not status_match and len(results) < max_results:
            discovery = await self._discover_index(query, max_results)
            if discovery.ok:
                for hit in discovery.hits:
                    candidate = _canonical_x_candidate(hit.url)
                    if not candidate:
                        continue
                    canonical, kind, handle, status_id = candidate
                    key = source_dedup_key(canonical)
                    if key in seen:
                        continue
                    seen.add(key)
                    normalized = None
                    if kind == "status" and status_id:
                        try:
                            detail = await self._get_json(f"/2/status/{status_id}")
                        except XProviderError:
                            detail = {}
                        normalized_items = self._status_items(detail)
                        normalized = self._normalize_status(
                            normalized_items[0], query, observed_at
                        ) if normalized_items else None
                    if normalized:
                        result, item_evidence = normalized
                    else:
                        result = ChannelResult(
                            channel="x",
                            provider=f"{discovery.provider}+fxembed",
                            query=query,
                            url=canonical,
                            title=(hit.title or f"@{handle} 的 X 公开主页")[:300],
                            snippet=hit.snippet[:500],
                            verified=False,
                            limitation=(
                                "公开索引已发现，但帖子详情未成功读取"
                                if kind == "status"
                                else "公开索引已发现账号主页，未读取帖子正文"
                            ),
                            provenance=SourceProvenance(
                                discovery_provider=discovery.provider,
                                detail_provider="fxembed",
                                source_kind="public_index",
                                observed_at=observed_at,
                                confidence="low",
                            ),
                        )
                        item_evidence = None
                    append_result(result, item_evidence)
                    if len(results) >= max_results:
                        break

        if api_error and not results:
            return ChannelOutcome(
                ok=False,
                channel="x",
                provider="fxembed",
                query=query,
                error_code=api_error.code,
                error_message=str(api_error),
            )
        return ChannelOutcome(
            ok=True,
            channel="x",
            provider="fxembed",
            query=query,
            results=results[:max_results],
            evidence=evidence[:max_results],
        )
