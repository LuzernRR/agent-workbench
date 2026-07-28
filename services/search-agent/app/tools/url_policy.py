"""URL 安全策略：抓取之前的强制校验。

项目文档 10.2 节要求「URL 安全在抓取之前」。这里实现最小但真实的
SSRF 防护：只允许 http/https，解析 DNS 后拒绝内网与云 metadata 地址。

重定向必须逐跳重新校验，因此 `assert_fetchable` 会被抓取器在每一跳调用，
而不是只在入口调用一次。
"""

from __future__ import annotations

import ipaddress
import socket
from dataclasses import dataclass
from urllib.parse import urlsplit

# 只允许这两种 scheme。file/ftp/data/javascript 一律拒绝。
_ALLOWED_SCHEMES = frozenset({"http", "https"})

# 云厂商 metadata 服务地址。命中即拒绝，防止凭据泄漏。
_METADATA_HOSTS = frozenset({"169.254.169.254", "metadata.google.internal", "100.100.100.200"})

# 允许的端口。其余端口(如数据库、Redis)一律拒绝。
_ALLOWED_PORTS = frozenset({80, 443, 8080, 8443})

_MAX_URL_LENGTH = 2048


class UrlPolicyError(ValueError):
    """URL 未通过安全策略。消息可安全展示给用户。"""

    def __init__(self, reason: str, url: str) -> None:
        super().__init__(reason)
        self.reason = reason
        self.url = url


@dataclass(frozen=True)
class ResolvedTarget:
    """一次安全 DNS 解析结果；抓取器必须连接这里固定的地址。"""

    url: str
    hostname: str
    port: int
    addresses: tuple[str, ...]


def _is_blocked_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """判断 IP 是否属于必须拒绝的范围。

    覆盖 loopback、私有网段、link-local、保留地址与组播。
    """
    # 抓取只允许互联网可路由地址；这同时覆盖 CGNAT、文档网段、benchmark、
    # loopback、私网、link-local、保留与组播地址。
    return not ip.is_global


def resolve_fetchable(url: str) -> ResolvedTarget:
    """校验 URL 并返回已固定的公网地址，避免校验后再次 DNS 解析。

    校验不通过时抛出 `UrlPolicyError`。调用方应把它转换为
    `ACCESS_DENIED` 类工具错误，而不是当成网络故障重试。
    """
    if len(url) > _MAX_URL_LENGTH:
        raise UrlPolicyError("URL 超长", url)

    parts = urlsplit(url)

    if parts.scheme.lower() not in _ALLOWED_SCHEMES:
        raise UrlPolicyError(f"不允许的协议：{parts.scheme or '空'}", url)

    # 带用户名密码的 URL 常用于绕过校验，直接拒绝。
    if parts.username or parts.password:
        raise UrlPolicyError("URL 不允许携带凭据", url)

    hostname = parts.hostname
    if not hostname:
        raise UrlPolicyError("URL 缺少主机名", url)

    host_lower = hostname.lower()
    if host_lower in _METADATA_HOSTS:
        raise UrlPolicyError("拒绝访问云 metadata 地址", url)

    try:
        port = parts.port
    except ValueError as exc:
        raise UrlPolicyError("URL 端口格式无效", url) from exc
    if port is not None and port not in _ALLOWED_PORTS:
        raise UrlPolicyError(f"不允许的端口：{port}", url)
    resolved_port = port or (443 if parts.scheme.lower() == "https" else 80)

    # 解析 DNS 后逐个校验真实 IP，防止域名指向内网。
    try:
        resolved = socket.getaddrinfo(hostname, resolved_port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise UrlPolicyError("域名解析失败", url) from exc

    addresses: list[str] = []
    for family, _type, _proto, _canon, sockaddr in resolved:
        raw_ip = sockaddr[0]
        try:
            ip = ipaddress.ip_address(raw_ip)
        except ValueError:
            continue
        if str(ip) in _METADATA_HOSTS or _is_blocked_ip(ip):
            raise UrlPolicyError("拒绝访问内网或保留地址", url)
        normalized = str(ip)
        if normalized not in addresses:
            addresses.append(normalized)

    if not addresses:
        raise UrlPolicyError("域名未解析到可用公网地址", url)

    return ResolvedTarget(
        url=url,
        hostname=hostname,
        port=resolved_port,
        addresses=tuple(addresses),
    )


def assert_fetchable(url: str) -> str:
    """校验 URL 可安全抓取，返回原 URL。"""
    return resolve_fetchable(url).url


def is_fetchable(url: str) -> bool:
    """`assert_fetchable` 的布尔版本，用于过滤候选列表。"""
    try:
        assert_fetchable(url)
    except UrlPolicyError:
        return False
    return True
