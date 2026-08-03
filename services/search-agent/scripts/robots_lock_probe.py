"""阶段 4 取证脚本：测量 robots 门禁的全局锁是否串行化跨域抓取。

不发真实网络请求，用可控延迟替换 _load_policy，观察三个不同域名的
check_robots 是墙钟并行还是串行。不属于 feature 代码，不打印密钥。
"""

from __future__ import annotations

import asyncio
import sys
import time

from app.tools import robots_policy as module

FETCH_DELAY = 0.5
ORIGINS = [
    "https://a.example/page",
    "https://b.example/page",
    "https://c.example/page",
]


async def main() -> int:
    calls: list[str] = []

    async def slow_load(policy_url: str, timeout: float) -> module._CachedPolicy:
        calls.append(policy_url)
        await asyncio.sleep(FETCH_DELAY)
        return module._CachedPolicy(0, None, 404, missing=True)

    module.clear_robots_cache()
    module._load_policy = slow_load  # type: ignore[assignment]

    started = time.perf_counter()
    decisions = await asyncio.gather(*(module.check_robots(u) for u in ORIGINS))
    elapsed = time.perf_counter() - started

    print(f"域名数            = {len(ORIGINS)}")
    print(f"单域模拟抓取耗时  = {FETCH_DELAY:.2f}s")
    print(f"实际墙钟          = {elapsed:.2f}s")
    print(f"_load_policy 调用 = {len(calls)}")
    print(f"理论并行上限      = {FETCH_DELAY:.2f}s")
    print(f"理论串行下限      = {FETCH_DELAY * len(ORIGINS):.2f}s")
    verdict = "串行（全局锁生效）" if elapsed > FETCH_DELAY * 1.8 else "并行"
    print(f"结论              = {verdict}")
    print(f"决策全部允许      = {all(d.allowed for d in decisions)}")

    # 同域并发只应触发一次真实抓取（去重仍需保留）。
    module.clear_robots_cache()
    calls.clear()
    started = time.perf_counter()
    await asyncio.gather(*(module.check_robots("https://same.example/p") for _ in range(3)))
    same_elapsed = time.perf_counter() - started
    print(f"\n同域 3 并发：抓取次数 = {len(calls)}，墙钟 = {same_elapsed:.2f}s")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
