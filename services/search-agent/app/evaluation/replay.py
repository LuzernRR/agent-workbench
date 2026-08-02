"""回放图：把 Gold transcript 变成满足 HarnessGraph 合同的确定性图。

不发起任何 Provider / 网络调用；只把记录的事件与终态交回 HarnessRunner，
使离线评测与生产共用同一条执行边界与同一套终态校验。
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from types import SimpleNamespace
from typing import Any

from app.evaluation.dataset import GoldCase
from app.events.runtime import runtime_event


class ReplayGraph:
    """按 Gold 用例回放公开事件与最终状态。"""

    def __init__(self, case: GoldCase) -> None:
        self._case = case

    async def aget_state(self, config: dict[str, Any]) -> Any:
        # 离线评测不从 checkpoint 恢复。
        return SimpleNamespace(values={})

    async def astream(
        self,
        graph_input: Any,
        **kwargs: Any,
    ) -> AsyncIterator[dict[str, Any]]:
        for event in self._case.transcript:
            # 重新生成 envelope，使序号确定并再次通过隐私门控。
            yield {
                "type": "custom",
                "data": runtime_event(event.type, **event.payload),
            }
        if self._case.final_state is not None:
            yield {"type": "values", "data": dict(self._case.final_state)}
