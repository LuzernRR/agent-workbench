# Issue #15：生产级 ToolGateway 与完整工具调用账本

## 元数据

| 字段 | 内容 |
|---|---|
| 日期 | 2026-08-01 |
| Issue | [#15](https://github.com/LuzernRR/agent-workbench/issues/15) |
| 状态 | completed |
| Execution Gate | allowed |

## 单一 Feature 与基线

本 Issue 只实现显式可复用的 `ToolGateway` 和真实搜索工具调用账本，不实现 Evidence 状态机、
长期记忆、LangSmith 或新工具。

修改前，`_run_one_search` 同时负责 Provider 调用、幂等、结算、取消、事件和错误归一；
`search_agent_tool_operations` 只保存基础 input hash、状态和内联结果。生产事件没有贯通 v2
已冻结的 operation/result 引用、attempt、output hash 和 ToolUsage，缓存重放也无法证明每个
逻辑 `toolCallId` 对应的真实调用次数。

## 实现

### 显式 ToolGateway 边界

新增 `services/search-agent/app/tools/gateway.py`：

- `prepare()` 从 run、tool、toolCallId、attempt 和输入内容生成稳定 input SHA-256、幂等键与
  `operationRef`；输入正文只在当前进程内参与哈希，不写入账本。
- `invoke()` 统一执行 ledger begin、缓存恢复、真实 Provider operation、结算和 outcome unknown。
- 取消发生在 begin、Provider 或 settlement 时，Gateway 会先取得或形成真实终态，再向
  Harness 传播取消；外部调用发生后结算不明时禁止盲目重试。
- 同一逻辑调用重放复用原 resultRef 和 attempt；不同 toolCallId 即使参数相同也保持独立账本
  身份。进行中的并发重放返回 unknown，不产生第二次 Provider 调用。
- `RunContext` 只向图节点注入 `tool_gateway`；Harness 仍持有 ledger，用于 run stop/timeout 后
  按 runId 统一收口尚未结算的调用。

### PostgreSQL 账本与结果引用

新增幂等迁移 `database/migrations/003_tool_gateway_ledger.sql`：

- operation 行记录 tool/version、planStepId、research batch/result、attempt、Provider、
  input/output hash、resultRef、outcome/error、时间、duration、请求/结果/证据/page read/bytes、
  estimated/actual/possible duplicate cost。
- `search_agent_tool_results` 以 resultRef 保存可重放的安全结构化结果；operation 行不再内联
  JSON 结果。
- `(run_id, tool_call_id)` 保证逻辑调用唯一，result 表按 run/toolCallId/attempt 唯一；
  operationRef 另有唯一索引。
- 旧记录的 operationRef 和 startedAt 在 SQL 中回填；旧内联结果由 Python 启动迁移在同一事务
  中去除输入/私有字段、计算 SHA-256、写入引用表并清空旧 `result`。

生产升级前有 552 条 operation，其中 509 条含旧内联结果。新容器启动后：

- 旧内联 `result`：0；
- operationRef/startedAt 空值：0；
- 安全结果引用：509；
- query、Prompt、messages、reasoning_content、Provider body、Cookie、authorization、API key、
  token、toolArguments 等禁止键：0。

### 事件、BFF 与 Workbench

Search Agent 工具事件现在携带：

- started/progress/verification：operationRef、attempt、inputHash、research batch/result；
- completed/failed：再增加 outputHash、resultRef 和完整安全 ToolUsage；
- unknown：携带 operationRef、attempt、inputHash、duration、usage、稳定 error 与
  `check_operation`。

BFF Zod 白名单验证 hash、引用、attempt、usage 和 decimal USD；新增字段经 mapper 进入
`wb_agent_events`。v1 `AgentEventType` 增加真实 `tool.unknown`，reducer 按 toolCallId 原位更新，
保留 operation/result 引用和分支关联，不因重连或终态事件增加第二个工具行。

本轮未把 hash、引用或 usage 转换成模型自然语言，也未新增回答模板。工具标题、状态标签和
unknown 后续动作属于确定性 UI 元数据，不冒充模型输出。

## 安全边界

- `safe_result_payload()` 在任何结果落库前递归删除 query、Prompt、messages、reasoning、
  Provider body、raw request/response、Cookie、Authorization、API key、token、headers 和
  tool arguments。
- Python runtime event 与 TypeScript NDJSON parser 同时拒绝上述禁止字段。
- 可重放结果只包含通过 Pydantic 收口的公开候选、已读取 Evidence 与稳定 resolution；不保存
  Provider 原始 body。
- actualCostUsd 不可确认时显式为 `null`，不伪造真实费用；缓存事件保留原逻辑 operation usage，
  同时以 `cached=true` 表明本次没有新 Provider 调用。

## 测试证据

| 门禁 | 结果 |
|---|---|
| Gateway/幂等/取消/并发/隐私定向 | passed |
| graph/Harness/stop/timeout 定向 | `110 passed` |
| Search Agent 全量 | `231 passed` |
| Ruff / compileall | passed |
| 共享 Python 合同 | `6 passed` |
| Web 全量 | `381 passed, 1 skipped` |
| TypeScript / ESLint / production build | passed |
| Playwright deterministic | `16 passed, 3 skipped` |
| PostgreSQL migration 连续执行两次 | passed |
| `git diff --check` | passed |

关键回归覆盖：

- 同一 toolCallId 的缓存重放不重复调用 Provider，attempt 保持 1；
- 同一调用并发重放只有一个 Provider execution，另一路 outcome unknown；
- Provider failed、timeout、取消、ledger disabled、scope/cache invalid 与 settlement failure 都有
  started + 明确 terminal；
- research batch/result、planStepId、operationRef、hash、resultRef 和 usage 从图事件贯通到 BFF
  与 reducer；
- BFF 不持久化候选 snippet，新增账本字段中无禁止私密键；
- `tool.unknown` 是终态并只保留一个 Workbench 工具行。

## 真实生产验证

滚动部署 Web 与 Search Agent，旧镜像保留为：

- `agent-workbench/search-agent:pre-issue-15-5b925ff`；
- `agent-workbench/web:pre-issue-15-5b925ff`。

真实 Web smoke：

- Run：`run_issue15_1785578091405`；
- 96.5 秒，36 个公开事件；
- 10 node.started、10 node.completed、0 node.failed；
- 1 个真实 Research 分支和 1 次 Web Provider 调用；
- `toolCallId=call_search_acd88164e6df23f6a8d78e59`，attempt=1；
- 5 条候选、2 条已读取 Evidence，usage 为 1 search query、2 page reads、9500 bytes；
- input/output hash 均为 64 位，operationRef/resultRef 与 PostgreSQL 行一致；
- 唯一 `run.completed / completed / VERIFIED`；
- 公开 NDJSON 禁止字段计数：0；result payload 禁止字段计数：0。

部署后 Search Agent 与 Web 容器 healthy；`127.0.0.1:3000/health`、
`127.0.0.1:8080/health` 与
[https://luzern.cc.cd/workbench](https://luzern.cc.cd/workbench) 均返回 200。

## 回滚

- Web 或 Search Agent 可分别切换到对应 `pre-issue-15-5b925ff` 镜像。
- 数据库迁移为向前兼容的新增列/表；旧镜像仍只读取原有列，不依赖新结构。
- 回滚镜像不会删除已迁移的安全 resultRef 数据，也不得执行卷删除或 destructive schema rollback。

## 后续

下一项单 feature 应实现 Evidence 生命周期/状态机与声明级引用关联，复用本 Issue 的
toolCallId、resultRef、research result 和 usage；不得把 ToolGateway、HarnessRunner 或图级
fan-out/fan-in 重新实现一遍。
