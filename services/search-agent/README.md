## Search Agent 服务

Python/LangGraph 后端负责真实多 Agent 搜索链路：

```text
Supervisor -> Planner -> Researcher(web_search -> observation)
           -> Reflector -> replan | Writer -> Verifier -> finalize
```

Researcher 在单个 LangGraph 节点内部完成 DeepSeek thinking tool-call 子回合。
`reasoning_content` 只在该节点局部内存中回传给 Provider，绝不进入 State、
checkpoint、公开事件或 Milvus。工具调用使用 PostgreSQL 幂等账本，崩溃后
结果未知时不会盲重放。

本地运行：

```powershell
cd services/search-agent
uv sync --group dev
uv run python -m app.run
```

直接用 `app.run` 启动时健康检查为 `http://127.0.0.1:8100/health`；正式 Compose
把容器内 8100 映射到宿主机 `http://127.0.0.1:18100/health`。非密钥配置位于
`config/search-agent.json`；DeepSeek 与 Tavily 密钥只位于被忽略的
`config/*.local.json`。
