"""URL 安全策略单测。

这些是确定性测试，不依赖网络，用于固化 SSRF 防护行为。
"""

from __future__ import annotations

import pytest

from app.tools.url_policy import UrlPolicyError, assert_fetchable, is_fetchable

BLOCKED = [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "ftp://example.com/x",
    "http://127.0.0.1:8000/",
    "http://localhost/admin",
    "http://169.254.169.254/latest/meta-data/",
    "http://192.168.1.1/",
    "http://10.0.0.5/",
    "http://100.64.0.1/",
    "http://172.16.0.1/",
    "https://user:pw@example.com/",
    "http://example.com:22/",
    "http://[::1]/",
]

ALLOWED = [
    "https://www.iana.org/help/example-domains",
    "https://example.com/",
    "http://example.com/path?q=1",
]


@pytest.mark.parametrize("url", BLOCKED)
def test_blocked_urls_rejected(url: str) -> None:
    assert is_fetchable(url) is False
    with pytest.raises(UrlPolicyError):
        assert_fetchable(url)


@pytest.mark.parametrize("url", ALLOWED)
def test_allowed_urls_pass(url: str) -> None:
    assert is_fetchable(url) is True
    assert assert_fetchable(url) == url
