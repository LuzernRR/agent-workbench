# 真实来源相关性与小红书延迟收口

## Issue 与边界

- Issue：[ #9 Agent 公开过程流式展示、有效来源增量与生产域名切换 ](https://github.com/LuzernRR/agent-workbench/issues/9)
- Status：`ready`
- Execution Gate：`allowed`
- Git 边界：本记录对应改动仍未 stage、commit、push 或关闭 Issue。

本次在既有“平台万能搜”链路内，针对真实用户案例复核来源详情的相关性、partial
终态语义和小红书登录态超时。没有暴露 Cookie、二维码、`xsec_token`、私有 CoT
或任何新公网端口。

## 修复

### 只展示直接相关的来源详情

- `SourcePresentation` 与 `Source Curator` 新增内部结构字段
  `include_in_details`。Reflector/Curator 必须由 LangGraph Agent 依据当前问题和
  用户筛选条件决定是否展示；不相关、不适用、已过期或仅作排除依据的已读来源保持
  在内部证据账本，但不会产生 `tool.source.delta`。
- 不存在前端兜底或固定来源文案。`include_in_details=true` 时必须有真实正文支撑的
  有效文字；为 `false` 时公开说明必须为空。连续搜索行仍按所有真实完成工具事件
  累计“找到 N 条结果，读取 M 个来源”，详情只会是这些已读来源的安全、相关子集。
- `finalize` 只在终态原因为 `VERIFIED` 时保留 `verification_passed=true` 和写入
  Milvus。工具、模型或时间预算在核验后耗尽的 partial 运行不再误报“已核验”，也不
  会把不完整答案写进项目记忆。

### 小红书受控快速降级

- 配置新增 `search.channels.xiaohongshu.detailTimeoutMs`，生产值为 18 秒；
  登录态检查、站内搜索与公开 Reader 仍使用原有独立超时策略。
- MCP 笔记详情调用使用独立短超时。首条详情出现 `MCP_TIMEOUT`、验证码、网络或
  服务不可用等可回退错误时，立即进入公开只读 fallback，不再串行等待其余两条详情。
- fallback 继续遵守 robots、SSRF、无写操作和有效正文门禁；没有正文时不生成来源
  详情，也不会把候选或标题写进答案事实。

## 真实验收

| 场景 | 运行 | 结果 |
| --- | --- | --- |
| 小红书 LangGraph（生产过程回归） | `run_234a0a31b4c54fb7b6a2502de5ca2689` | 103.0 秒，MCP 首选后转 Web，3 条相关有效来源，`VERIFIED`。 |
| 学生·英国硕士奖学金 | `run_f04aa5fbd8a444e88f53b9b5440c541b` | 130.4 秒，6 次真实 Web 调用、12 条已读来源，因工具上限 partial；`verificationPassed=false`，未进入记忆。 |
| 女性通勤·油敏皮夏季防晒（修复前） | `run_d447dde5c56642438cfa3a712aa3a97a` | 173.6 秒；登录态详情连续超时，只有 1 次小红书工具调用且无正文。 |
| 女性通勤·油敏皮夏季防晒（修复后） | `run_7a84913794f84a809a3838070ecedb7b` | 115.2 秒；2 次小红书 MCP→公开 fallback、4 次 Web 补搜，6 条已读来源但均不满足“小红书真实笔记”条件，故详情为 0、partial 且不虚构证据。 |
| 求职学生·AI 产品岗位动态 | `run_3d116fd9328d430a9ceeef43107b03e0` | 104.3 秒；首选 X 后按图补 Web，8 条已读来源、5 条相关详情，因覆盖不足 partial。 |

浏览器真实回归覆盖三张案例卡的填充、首选渠道、`thinking/tool/message` 流事件及
partial 不得带 `verificationPassed=true`。该回归默认执行三场景，也可用
`LIVE_PROMPT_EXAMPLE=xiaohongshu` 单独复测受限渠道。

## 门禁与部署

- Search Agent 全量：`149 passed`，Ruff 与 `compileall` 通过。
- Web 全量：`351 passed, 1 skipped`，typecheck、全量 ESLint、production build 通过；
  3110 deterministic Playwright 为 `16 passed, 3 skipped`。需要显式启用真实 Provider
  环境的三场景 live E2E 已另行通过，因默认 mock 门禁不携带生产凭据而保持跳过。
- `docker compose --env-file ../config/deploy.local.env -f compose.yaml up -d --build search-agent`
  已重建 `search-agent` 与其内部 `xiaohongshu-mcp` 依赖；Search Agent 健康检查为
  healthy，并在容器内确认 `detailTimeoutMs=18000`。
- 后续的流式阅读位置修复见
  `docs/development/2026-07-30-012-stream-follow-recovery.md`；它不改变本记录的
  搜索、来源或终态结论。

## 回滚

回退 `search-agent` 镜像与 `config/search-agent.json` 即恢复先前详情等待策略；不涉及
数据库迁移、Milvus collection 变更、会话 volume 删除或公网端口调整。
