"""跨平台本地启动器。"""

from __future__ import annotations

import asyncio
import os
import sys

import uvicorn


def main() -> None:
    config = uvicorn.Config(
        "app.main:app",
        host=os.environ.get("SEARCH_AGENT_HOST", "127.0.0.1"),
        port=int(os.environ.get("SEARCH_AGENT_PORT", "8100")),
        loop="none",
        access_log=True,
    )
    server = uvicorn.Server(config)
    if sys.platform == "win32":
        # Uvicorn 在 Windows 默认显式选择 Proactor；psycopg async 不支持它。
        asyncio.run(server.serve(), loop_factory=asyncio.SelectorEventLoop)
    else:
        asyncio.run(server.serve())


if __name__ == "__main__":
    main()
