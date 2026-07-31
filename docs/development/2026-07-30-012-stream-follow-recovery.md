# 流式过程的回到底部持续跟随

## Issue 与边界

- Issue：[ #9 Agent 公开过程流式展示、有效来源增量与生产域名切换 ](https://github.com/LuzernRR/agent-workbench/issues/9)
- Status：`ready`
- Execution Gate：`allowed`
- Git 边界：本记录对应改动仍未 stage、commit、push 或关闭 Issue。

本次只修正真实过程流式展示中的阅读位置：用户主动向上滚动时页面不得抢回到底部；
用户点击“滚动到底部”后，后续逐字输出、思考段落和来源链接增长必须继续贴住底部。
不改变 LangGraph 的公开文本、事件账本、工具聚合或来源内容，也不新开端口。

## 修复

`ThreadPrimitive.ScrollToBottom` 以前没有指定滚动行为。组件库会把未定义的行为视为
一次性滚动，不能保留“继续跟随”的意图：点击瞬间能到达底部，随后流式 DOM 增长又会
留在旧位置。现在明确传入 `behavior="instant"`，使用户的点击成为持续跟随意图；库的
原有滚动监听仍会在用户再次向上滚动时取消该意图。

这是一项显示层修复：所有思考、搜索、核验、有效来源与最终回答仍来自持久 AgentEvent，
前端没有新增或改写任何过程文案。

## 验证

- 定向 Playwright：`流式输出尊重用户向上滚动并由用户决定恢复跟随` 通过。覆盖上滚后
  不跟随、点击后立即到底部、剩余流式输出期间持续到底部三个阶段。
- Web：`npm test` 为 `351 passed, 1 skipped`；typecheck、全量 ESLint、生产 build
  全部通过；3110 deterministic Playwright 为 `16 passed, 3 skipped`。
- Search Agent：`149 passed`，Ruff 与 `compileall` 通过。本次修复没有改动图、工具或
  配置，但完整门禁同时确认了真实来源与终态语义没有回归。
- 已使用 `deploy/compose.yaml` 重建 `web`（同时按依赖重建 Search Agent 与小红书
  MCP）。所有容器 healthy；`127.0.0.1:3000/health`、`127.0.0.1:8080/health`、
  `https://luzern.cc.cd/workbench` 均为 200，公网页面标题为“平台万能搜”。Milvus
  仍为 enabled/available，数据目录为 `D:/001-agent/milvus`，端口只绑定 loopback；
  最近 100 行 Web/Search Agent 日志没有错误、trace 或敏感标记。

## 回滚

恢复 `Conversation.tsx` 中底部按钮的默认行为即可回退本项，不涉及数据库、Milvus、
运行事件、Cookie、模型密钥或公网暴露面。
