"""运行取消与幂等停止控制。

注册表只保存当前进程内的 asyncio Task，不进入 LangGraph checkpoint。
停止请求同时取消正在等待 Provider 的任务；调用方负责把未结算工具账本
标为 ``unknown``，恢复时便不会盲目重放可能已经产生费用的外部请求。
"""

from __future__ import annotations

import asyncio
from collections import deque
from dataclasses import dataclass
from typing import Any, Literal

StopStatus = Literal["stopping", "already_stopped", "not_running"]


@dataclass(frozen=True)
class StopDecision:
    status: StopStatus
    task_cancelled: bool


class RunRegistry:
    """进程内活动运行注册表；所有操作在事件循环锁内完成。"""

    def __init__(self, *, stopped_history_limit: int = 1024) -> None:
        self._active: dict[str, asyncio.Task[Any]] = {}
        self._stopped: set[str] = set()
        self._stopped_order: deque[str] = deque()
        self._stopped_history_limit = max(16, stopped_history_limit)
        self._lock = asyncio.Lock()

    async def register(self, run_id: str, task: asyncio.Task[Any]) -> bool:
        """注册一次运行；同一 run_id 已在执行时返回 False。"""
        async with self._lock:
            existing = self._active.get(run_id)
            if existing is not None and not existing.done():
                return False
            if run_id in self._stopped:
                self._stopped.discard(run_id)
                self._stopped_order = deque(
                    item for item in self._stopped_order if item != run_id
                )
            self._active[run_id] = task
            return True

    async def finish(self, run_id: str, task: asyncio.Task[Any]) -> None:
        """仅移除仍由当前 task 持有的注册，避免旧请求删除新恢复任务。"""
        async with self._lock:
            if self._active.get(run_id) is task:
                self._active.pop(run_id, None)

    async def stop(self, run_id: str) -> StopDecision:
        """请求停止；重复调用对已经停止的 run_id 返回稳定结果。"""
        task: asyncio.Task[Any] | None
        async with self._lock:
            if run_id in self._stopped:
                return StopDecision("already_stopped", False)
            task = self._active.get(run_id)
            if task is None or task.done():
                return StopDecision("not_running", False)
            self._remember_stopped(run_id)

        # 在锁外取消，避免任务 finally 回调等待同一把锁。
        cancelled = task.cancel("USER_STOP_REQUESTED")
        return StopDecision("stopping", cancelled)

    def _remember_stopped(self, run_id: str) -> None:
        if run_id in self._stopped:
            return
        self._stopped.add(run_id)
        self._stopped_order.append(run_id)
        while len(self._stopped_order) > self._stopped_history_limit:
            expired = self._stopped_order.popleft()
            self._stopped.discard(expired)
