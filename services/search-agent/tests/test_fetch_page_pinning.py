from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any, Self

import httpx
import pytest

from app.tools import fetch_page as module
from app.tools.url_policy import ResolvedTarget


@pytest.mark.asyncio
async def test_static_fetch_connects_to_validated_ip_with_original_host_and_sni(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    def resolve(url: str) -> ResolvedTarget:
        return ResolvedTarget(
            url=url,
            hostname="example.com",
            port=443,
            addresses=("93.184.216.34",),
        )

    class Client:
        def __init__(self, **kwargs: Any) -> None:
            captured["client_kwargs"] = kwargs

        async def __aenter__(self) -> Self:
            return self

        async def __aexit__(self, *args: object) -> None:
            return None

        def build_request(self, method: str, url: httpx.URL, headers: dict[str, str]) -> httpx.Request:
            return httpx.Request(method, url, headers=headers)

        async def send(self, request: httpx.Request, *, stream: bool) -> httpx.Response:
            captured["request"] = request
            return httpx.Response(
                200,
                request=request,
                headers={"content-type": "text/html"},
                text="ok",
            )

    monkeypatch.setattr(module, "resolve_fetchable", resolve)
    monkeypatch.setattr(module.httpx, "AsyncClient", Client)
    _response, logical_url = await module._pinned_get("https://example.com/path", 5)

    request = captured["request"]
    assert str(request.url) == "https://93.184.216.34/path"
    assert request.headers["host"] == "example.com"
    assert request.headers["accept-encoding"] == "identity"
    assert request.extensions["sni_hostname"] == "example.com"
    assert captured["client_kwargs"]["trust_env"] is False
    assert logical_url == "https://example.com/path"


@pytest.mark.asyncio
async def test_dynamic_browser_path_fails_closed() -> None:
    result = await module._fetch_dynamic("https://example.com")
    assert result.ok is False
    assert result.error_category == "permission_denied"


@pytest.mark.asyncio
async def test_declared_oversized_response_is_rejected_before_buffering(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        module,
        "resolve_fetchable",
        lambda url: ResolvedTarget(url, "example.com", 443, ("93.184.216.34",)),
    )

    class Client:
        def __init__(self, **kwargs: Any) -> None:
            pass

        async def __aenter__(self) -> Self:
            return self

        async def __aexit__(self, *args: object) -> None:
            return None

        def build_request(self, method: str, url: httpx.URL, headers: dict[str, str]) -> httpx.Request:
            return httpx.Request(method, url, headers=headers)

        async def send(self, request: httpx.Request, *, stream: bool) -> httpx.Response:
            return httpx.Response(
                200,
                request=request,
                headers={
                    "content-type": "text/html",
                    "content-length": str(module.MAX_RESPONSE_BYTES + 1),
                },
            )

    monkeypatch.setattr(module.httpx, "AsyncClient", Client)
    with pytest.raises(module.ResponsePolicyError, match="超出上限"):
        await module._pinned_get("https://example.com/large", 5)


class _StreamedResponse:
    """最小响应替身：只暴露 `_read_allowed_body` 依赖的三个成员。

    `consumed` 记录真正被产出的分片，用来断言「不为判类型缓冲整页」。
    """

    def __init__(
        self,
        status_code: int,
        headers: dict[str, str],
        chunks: list[bytes],
    ) -> None:
        self.status_code = status_code
        self.headers = httpx.Headers(headers)
        self._chunks = chunks
        self.consumed: list[bytes] = []

    async def aiter_bytes(self) -> AsyncIterator[bytes]:
        for chunk in self._chunks:
            self.consumed.append(chunk)
            yield chunk


@pytest.mark.asyncio
async def test_comma_joined_content_type_takes_first_member() -> None:
    body = b"<html>ok</html>"
    response = _StreamedResponse(
        200, {"content-type": "text/html, text/html"}, [body]
    )
    assert await module._read_allowed_body(response) == body


@pytest.mark.asyncio
async def test_mislabeled_octet_stream_html_is_accepted_by_sniffing() -> None:
    body = b"<!DOCTYPE html><title>t</title>" + b"x" * 600
    response = _StreamedResponse(
        200, {"content-type": "application/octet-stream"}, [body]
    )
    assert await module._read_allowed_body(response) == body


@pytest.mark.asyncio
async def test_short_mislabeled_page_is_sniffed_at_stream_end() -> None:
    body = "<html>短页面</html>".encode()
    response = _StreamedResponse(
        200, {"content-type": "application/octet-stream"}, [body]
    )
    assert await module._read_allowed_body(response) == body


@pytest.mark.asyncio
async def test_non_html_mislabeled_body_is_rejected() -> None:
    body = b"PK\x03\x04not really a zip but binary"
    response = _StreamedResponse(
        200, {"content-type": "application/octet-stream"}, [body]
    )
    with pytest.raises(module.ResponsePolicyError, match="不支持的响应类型"):
        await module._read_allowed_body(response)


@pytest.mark.asyncio
async def test_never_sniff_types_are_rejected_without_reading_body() -> None:
    response = _StreamedResponse(
        200, {"content-type": "application/pdf"}, [b"%" + b"PDF"]
    )
    with pytest.raises(module.ResponsePolicyError, match="不支持的响应类型"):
        await module._read_allowed_body(response)
    assert response.consumed == []


@pytest.mark.asyncio
async def test_error_responses_are_not_type_gated() -> None:
    response = _StreamedResponse(
        404, {"content-type": "application/octet-stream"}, [b"not found"]
    )
    assert await module._read_allowed_body(response) == b"not found"
