## Search Agent 服务

Python/LangGraph 后端负责真实多 Agent 搜索链路和受控查询策略：

```text
Supervisor -> Planner -> Researcher(web_search -> observation)
           -> Reflector -> replan | Writer -> Verifier -> finalize
```

### 查询理解与迭代检索

Supervisor 将用户要求转换为私有、版本化的 `QueryBrief`：实体、`must`/`should`/`exclude`、绝对日期、地域、
语言、必需渠道、输出字段和证据分面。Planner 只提出查询；确定性门禁负责：

- 首轮最多两个不同证据分面，并以计划整体覆盖所有 `should`；
- web、X、xiaohongshu 的操作符和渠道边界；硬约束签名、排除语义和绝对日期保留；
- 稳定 `attemptId`、`gapId`、`parentAttemptId`、允许的改写策略和 near-duplicate/no-progress 熔断；
- 只有新候选、新正文或新硬约束覆盖才算进展，typed `EvidenceGap` 只在绑定尝试有进展后闭合。

普通补搜必须从同一 facet 的最新真实尝试继续。首次发现尚未搜索的 facet 时，gap 会标记
`origin=facet_discovery`，仅允许绑定全局最新真实尝试；旧 gap 没有该标记时仍严格拒绝跨 facet lineage。所有
查询分析字段只存在私有 State/checkpoint，不进入公开 AgentEvent、OTel span、日志或前端过程文本。

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
把容器内 8100 映射到宿主机 `http://127.0.0.1:8080/health`。非密钥配置位于
`config/search-agent.json`；DeepSeek 与 Tavily 等 Provider 密钥位于被忽略的
`config/*.local.json`，数据库及服务间 Token/租户断言密钥位于被忽略的
`config/*.local.env` 或生产密钥管理系统。

### 验证

```powershell
cd services/search-agent
.\.venv\Scripts\python.exe -m pytest -q
.\.venv\Scripts\python.exe -m ruff check .
.\.venv\Scripts\python.exe -m compileall -q app
```

Compose 运行态使用 `deploy/compose.yaml` 与 `config/deploy.local.env`。发布前还要执行 Web 全量门禁、镜像
构建、Compose 静态解析、依赖审计、Playwright 和 `git diff --check`。真实 smoke 优先通过 Web/Worker
发起，由服务端生成断言；若直接调用 `/v1/runs/stream`，请求必须同时携带 `X-Workbench-Token` 与
`X-Workbench-Tenant-Assertion`。后者使用独立 `WORKBENCH_TENANT_ASSERTION_SECRET` 对 UTF-8
长度前缀的 tenant/run/visitor 作用域签名，不能用内部 Token 代替，也不要把任何密钥粘贴到命令行或日志。
只有显式启用且两端均为 loopback 的不安全开发模式可以省略断言。结束后以最后一个
`checkpoint.committed` 的完整引用读取 PostgreSQL checkpoint，核对 `search_attempts`、
`evidence_gaps`、`evidence` 和终态；不要把公开事件中的摘要当作私有查询分析。

2026-08-07 发布前 Web Provider smoke `issue52accept_3d56d8258084` 验证了首轮 web 查询、两个带
`gapId`/`parentAttemptId` 的 `source_targeting` follow-up、Evidence 增益和缺口闭合；公开事件私有字段扫描为
空。Python 依赖审计可在不修改项目环境的情况下运行：

```powershell
uvx --from pip-audit pip-audit --path services/search-agent/.venv
```
