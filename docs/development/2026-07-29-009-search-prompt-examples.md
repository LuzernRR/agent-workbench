# 平台万能搜案例卡与真实渠道验收

## Issue 与边界

- Issue：[ #9 Agent 公开过程流式展示、有效来源增量与生产域名切换 ](https://github.com/LuzernRR/agent-workbench/issues/9)
- Status：`ready`
- Execution Gate：`allowed`
- Git 边界：本记录对应的改动继续等待用户显式验收；不 stage、commit、push 或关闭 Issue。

本次只扩展现有搜索交互：更新品牌、提供真实的空会话案例入口，并用真实 Web、
小红书、X 请求复核渠道选择、来源与响应时间。不展示私有 CoT，不改变 Cookie、
API Key、MCP、Milvus、端口或公网暴露边界。

## 实现

- 左栏与浏览器元数据统一为“平台万能搜”。
- 空会话的“今天想做什么？”下增加三张卡：网页官方更新、小红书实战笔记、X
  近期动态。卡片只显示简短标题；详细、可直接执行的提示词在点击后精确写入输入框。
- `Conversation` 为每次点击生成唯一 `prefillRequest`；`AgentComposer` 通过
  `aui.composer().setText()` 写入并聚焦原生输入框。它不会模拟发送、修改 URL 或
  使用 DOM 查询、超时器来填值，所以不会造成闪屏或意外启动 run。
- Planner Prompt 升级到
  `2026-07-29.v14-relative-date-x-routing`。相对日期必须以调用时输入的当前日期
  换算；`plan_research` 也将 UTC 当前日期明确传给结构化 Planner。
- X 适配器修复 `from:@handle` 的解析。该形式是 Planner 生成平台查询时的常见
  语法，现可正确识别为账号时间线而非普通站内搜索。

## 真实渠道结果与安全结论

| 案例 | 实测结果 | 结论 |
| --- | --- | --- |
| 网页 | 113.7 秒；4 次完成的 Web 工具调用；11 个去重有效来源 | 路由、来源投影和最终回答正常。 |
| 小红书 | 89.3 秒；登录态 MCP 先遇到 `CAPTCHA_REQUIRED`，随后切至 Web；5 个有效来源 | 没有绕过验证码，也没有展示不可读正文的占位信息。 |
| X | 34.3 秒；路由为 X；公开索引找到候选但没有已读来源 | `@LangChainAI` 在 FxEmbed 返回 404，改为实际存在的 `@LangChain`。FxEmbed 的 robots 明确禁止 API 爬取，因此适配器按 fail-closed 策略不读取 API；未读候选不进入来源详情或回答事实。 |

另以 FxEmbed 公开文档、其 GitHub 仓库与 API 响应交叉核验：`/2/profile/{handle}/statuses`
端点存在，`@LangChain` 可返回时间线，而 `@LangChainAI` 返回 404。即使端点可响应，
其 robots 规则为 `Disallow: /`，所以产品不绕过该限制。

## 验收

- Search Agent：`141 passed`；Ruff、compileall 通过。
- Web：`344 passed, 1 skipped`；typecheck、ESLint、production build 通过。
- 3110 deterministic Playwright：`16 passed, 2 skipped`。
- 浏览器直接验证：桌面和 `390×844` 移动端的案例卡都可填充并聚焦输入框，未发起
  run、未跳转，且 `scrollWidth <= innerWidth`、无页面错误。
- 视觉证据：
  - `docs/development/evidence/2026-07-29-example-cards-desktop.png`
  - `docs/development/evidence/2026-07-29-example-cards-mobile.png`

## 回滚

删除案例卡相关组件并恢复原品牌即可回退 UI；不会影响持久数据或工具账本。X 的
robots 约束属于安全策略，不应通过关闭安全检查来“回滚”。
