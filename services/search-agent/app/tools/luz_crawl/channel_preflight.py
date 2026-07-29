"""公开渠道预检。

Adapted from:
``C:/Users/12860/plugins/luz-crawl/skills/luz-crawl/scripts/tool_preflight.py``.

原脚本面向 Codex 本机命令发现；本版本只保留生产服务需要的确定性路由
计划，排除登录、Cookie、浏览器 Profile、设备认证和验证码处理。
"""

from __future__ import annotations

from app.tools.channels.base import ChannelName

_PURPOSES: dict[ChannelName, str] = {
    "web": "公开网页发现与原文读取",
    "x": "X 公开帖子、账号与讨论",
    "xiaohongshu": "小红书公开索引、笔记、商品与主页",
}


def public_channel_plan(
    requested: list[ChannelName], enabled: dict[ChannelName, bool]
) -> list[dict[str, str]]:
    """返回当前可执行渠道；未知或禁用渠道不会进入工具注册表。"""
    routes: list[dict[str, str]] = []
    for channel in requested:
        if not enabled.get(channel, False):
            continue
        routes.append({
            "channel": channel,
            "purpose": _PURPOSES[channel],
            "access": "public-no-login",
        })
    return routes
