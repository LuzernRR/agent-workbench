"""渠道 URL 规范化与去重键。"""

from __future__ import annotations

import re
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

_TRACKING_KEYS = {
    "ref", "ref_src", "s", "t", "utm_campaign", "utm_content", "utm_medium",
    "utm_source", "utm_term", "xhsshare", "share_from_user_hidden", "shareRedId",
    "share_channel", "apptime", "app_version", "app_platform", "appuid",
}


def normalize_public_url(url: str, *, preserve_xhs_token: bool = True) -> str:
    parts = urlsplit(url.strip())
    host = (parts.hostname or "").lower()
    if host == "twitter.com" or host == "www.twitter.com":
        host = "x.com"
    elif host.startswith("www."):
        host = host[4:]
    port = parts.port
    authority = host if port is None else f"{host}:{port}"
    path = re.sub(r"/{2,}", "/", parts.path or "/")
    if path != "/":
        path = path.rstrip("/")
    query: list[tuple[str, str]] = []
    for key, value in parse_qsl(parts.query, keep_blank_values=False):
        if key in _TRACKING_KEYS:
            continue
        if (
            host == "xiaohongshu.com"
            and key in {"xsec_token", "xsec_source"}
            and preserve_xhs_token
        ):
            query.append((key, value))
    return urlunsplit((parts.scheme.lower(), authority, path, urlencode(query), ""))


def source_dedup_key(url: str) -> str:
    return normalize_public_url(url, preserve_xhs_token=False).casefold()
