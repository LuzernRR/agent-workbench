"""跨调用层传播的单调时钟 deadline。"""

from __future__ import annotations

import math
import time
from collections.abc import Callable
from dataclasses import dataclass, field

type MonotonicClock = Callable[[], float]


@dataclass(frozen=True)
class DeadlineBudget:
    """进程内绝对 deadline；只传运行时依赖，不进入持久状态或事件。"""

    expires_at: float
    clock: MonotonicClock = field(default=time.monotonic, repr=False, compare=False)

    def __post_init__(self) -> None:
        if not math.isfinite(self.expires_at):
            raise ValueError("expires_at 必须是有限单调时钟值")

    @classmethod
    def after(
        cls,
        timeout_seconds: float,
        *,
        clock: MonotonicClock = time.monotonic,
    ) -> DeadlineBudget:
        if not math.isfinite(timeout_seconds) or timeout_seconds <= 0:
            raise ValueError("timeout_seconds 必须是正有限数")
        return cls(expires_at=clock() + timeout_seconds, clock=clock)

    def bounded(self, timeout_seconds: float) -> DeadlineBudget:
        """派生不晚于当前 deadline 的子预算。"""
        if not math.isfinite(timeout_seconds) or timeout_seconds <= 0:
            raise ValueError("timeout_seconds 必须是正有限数")
        return DeadlineBudget(
            expires_at=min(self.expires_at, self.clock() + timeout_seconds),
            clock=self.clock,
        )

    def remaining_seconds(self) -> float:
        return max(0.0, self.expires_at - self.clock())

    @property
    def expired(self) -> bool:
        return self.remaining_seconds() <= 0
