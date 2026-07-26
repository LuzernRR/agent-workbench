# 阶段 2 进度

## 当前状态

`awaiting_acceptance`：功能、真实 DeepSeek/PostgreSQL、完整门禁和文档已经完成。提交推送后等待用户验收，验收前不得开始下一功能。

## 已完成

- [x] Issue #3 已建立可测试验收条件并标记 `Execution Gate: allowed`。
- [x] 本轮模型身份由服务端配置动态注入。
- [x] 身份问题返回 Provider、模型名称和模型 ID，普通问题不重复自报。
- [x] 项目记忆保持为低优先级、不可信事实背景。
- [x] 项目记忆上下文严格限制字符预算。
- [x] 17 项 Prompt/Store 定向单测通过。
- [x] 真实 PostgreSQL 全生命周期集成测试通过。
- [x] Flash 与 Pro 分别返回本轮真实 Provider、模型名称和模型 ID。
- [x] 真实同会话刷新、同项目召回和跨项目隔离通过。
- [x] 85 项 Vitest、类型检查、Lint、生产构建和 16 项 Playwright 通过。
- [x] 密钥、UTF-8/LF、禁用文案、可见省略号、文档链接和生产依赖扫描通过。

## 待完成

- [ ] 用户验收。

## 交付

- 功能提交：[`6b05a66`](https://github.com/LuzernRR/agent-workbench/commit/6b05a66)
- Issue 证据：[阶段 2 交付记录](https://github.com/LuzernRR/agent-workbench/issues/3#issuecomment-5082595426)

## 当前边界

- 未接入 Python、FastAPI、LangGraph 或 ReAct。
- 未生成 embedding，未启用 pgvector 相似度排序。
- 未实现用户长期记忆、事实冲突覆盖或记忆管理界面。
- 未实现 RAG 文档摄取、切片、重排和引用。
