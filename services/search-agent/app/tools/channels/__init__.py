"""经注册、只读且可审计的搜索渠道。"""

from app.tools.channels.base import ChannelName
from app.tools.channels.registry import ChannelRegistry

__all__ = ["ChannelName", "ChannelRegistry"]
