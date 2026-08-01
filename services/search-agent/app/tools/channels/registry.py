"""确定性的只读搜索渠道注册表。"""

from __future__ import annotations

from app.config.agent import AgentConfig
from app.tools.channels.base import (
    ChannelName,
    ChannelOutcome,
    ChannelProgressReporter,
    ChannelVerificationReporter,
)
from app.tools.channels.web import WebChannel
from app.tools.channels.x_public import XPublicChannel
from app.tools.channels.xiaohongshu_mcp import XiaohongshuMcpChannel
from app.tools.luz_crawl.channel_preflight import public_channel_plan


class ChannelRegistry:
    """模型只能选择这里注册且启用的渠道，不能传入 Provider 或任意 URL。"""

    def __init__(self, config: AgentConfig) -> None:
        self.config = config
        self._channels = {
            "web": WebChannel(config),
            "x": XPublicChannel(config),
            "xiaohongshu": XiaohongshuMcpChannel(config),
        }
        settings = config.search.channels
        self._enabled: dict[ChannelName, bool] = {
            "web": settings.web.enabled,
            "x": settings.x.enabled,
            "xiaohongshu": settings.xiaohongshu.enabled,
        }

    def available(self) -> list[ChannelName]:
        requested: list[ChannelName] = ["web", "x", "xiaohongshu"]
        planned = public_channel_plan(requested, self._enabled)
        return [channel for channel in requested if any(item["channel"] == channel for item in planned)]

    async def execute(
        self,
        channel: ChannelName,
        query: str,
        max_results: int,
        progress: ChannelProgressReporter | None = None,
        *,
        xiaohongshu_public_only: bool = False,
        verification_request_key: str | None = None,
        verification: ChannelVerificationReporter | None = None,
    ) -> ChannelOutcome:
        if not self._enabled.get(channel, False):
            return ChannelOutcome(
                ok=False,
                channel=channel,
                provider="none",
                query=query,
                error_code="CHANNEL_DISABLED",
                error_message=f"渠道 {channel} 未启用",
            )
        adapter = self._channels[channel]
        if channel == "xiaohongshu" and xiaohongshu_public_only:
            return await adapter.search_public_after_mcp_failure(
                query,
                max_results,
                progress=progress,
            )
        if channel == "xiaohongshu":
            return await adapter.search(
                query,
                max_results,
                progress=progress,
                verification_request_key=verification_request_key,
                verification=verification,
            )
        return await adapter.search(query, max_results, progress=progress)
