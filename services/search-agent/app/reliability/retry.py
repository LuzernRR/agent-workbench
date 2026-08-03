"""有界重试策略。

本模块只负责判断「是否还能重试」和「下一次等待多久」，不耦合具体
Provider。调用方负责执行请求、记录稳定错误分类，并注入时钟、随机源和
sleeper，以便生产环境使用真实时间、测试环境保持确定性且不真实等待。
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from enum import StrEnum


class ErrorKind(StrEnum):
    """决定重试行为的内部错误分类。"""

    RATE_LIMIT = "rate_limit"
    TIMEOUT = "timeout"
    TRANSIENT = "transient"
    PERMANENT = "permanent"


_RETRYABLE_ERROR_KINDS = frozenset(
    {ErrorKind.RATE_LIMIT, ErrorKind.TIMEOUT, ErrorKind.TRANSIENT}
)


@dataclass(frozen=True)
class RetryPolicy:
    """重试次数、累计耗时和指数退避的统一上限。"""

    max_attempts: int = 3
    max_elapsed_seconds: float = 30.0
    initial_delay_seconds: float = 0.5
    max_delay_seconds: float = 8.0
    multiplier: float = 2.0

    def __post_init__(self) -> None:
        if self.max_attempts < 1:
            raise ValueError("max_attempts 必须至少为 1")
        if not math.isfinite(self.max_elapsed_seconds) or self.max_elapsed_seconds <= 0:
            raise ValueError("max_elapsed_seconds 必须是正有限数")
        if not math.isfinite(self.initial_delay_seconds) or self.initial_delay_seconds < 0:
            raise ValueError("initial_delay_seconds 必须是非负有限数")
        if not math.isfinite(self.max_delay_seconds) or self.max_delay_seconds < 0:
            raise ValueError("max_delay_seconds 必须是非负有限数")
        if not math.isfinite(self.multiplier) or self.multiplier < 1:
            raise ValueError("multiplier 必须是大于等于 1 的有限数")


def parse_retry_after(value: str | None, *, now: datetime | None = None) -> float | None:
    """解析 ``Retry-After`` 的秒数或 HTTP-date 形式。

    过去的日期和负秒数被归一为 0；非法值返回 ``None``，由调用方回退到
    full jitter 指数退避。
    """
    if value is None:
        return None
    candidate = value.strip()
    if not candidate:
        return None

    try:
        seconds = float(candidate)
    except ValueError:
        seconds = None
    if seconds is not None:
        if not math.isfinite(seconds):
            return None
        return max(0.0, seconds)

    try:
        retry_at = parsedate_to_datetime(candidate)
    except (TypeError, ValueError, OverflowError):
        return None
    if retry_at is None:
        return None
    if retry_at.tzinfo is None:
        retry_at = retry_at.replace(tzinfo=UTC)

    current = now or datetime.now(UTC)
    if current.tzinfo is None:
        current = current.replace(tzinfo=UTC)
    return max(0.0, (retry_at - current).total_seconds())


def next_delay(
    policy: RetryPolicy,
    *,
    error_kind: ErrorKind,
    attempt: int,
    elapsed_seconds: float,
    random_value: float,
    retry_after_seconds: float | None = None,
) -> float | None:
    """返回下一次尝试前的等待秒数，不能继续时返回 ``None``。

    ``attempt`` 是刚结束的 1-based 尝试序号。普通瞬时错误使用 full
    jitter；服务端给出的 ``Retry-After`` 优先，但仍受单次等待和累计耗时
    上限约束。若等待会耗尽剩余预算，直接停止，避免发起一个没有时间预算
    的新请求。
    """
    if attempt < 1:
        raise ValueError("attempt 必须从 1 开始")
    if not 0.0 <= random_value <= 1.0:
        raise ValueError("random_value 必须位于 [0, 1]")
    if error_kind not in _RETRYABLE_ERROR_KINDS:
        return None
    if attempt >= policy.max_attempts:
        return None

    remaining = policy.max_elapsed_seconds - max(0.0, elapsed_seconds)
    if remaining <= 0:
        return None

    if retry_after_seconds is not None and math.isfinite(retry_after_seconds):
        delay = min(max(0.0, retry_after_seconds), policy.max_delay_seconds)
    else:
        try:
            exponential_delay = policy.initial_delay_seconds * (
                policy.multiplier ** (attempt - 1)
            )
        except OverflowError:
            exponential_delay = policy.max_delay_seconds
        capped_delay = min(exponential_delay, policy.max_delay_seconds)
        delay = random_value * capped_delay

    if delay >= remaining:
        return None
    return delay
