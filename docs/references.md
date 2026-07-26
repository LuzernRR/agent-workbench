# 资料来源

以下资料于 2026-07-26 核对。实现前应再次确认版本说明和迁移指南。

## DeepSeek

- [Create Chat Completion](https://api-docs.deepseek.com/api/create-chat-completion)：模型请求、流式输出、结束原因与用量。
- [Models and Pricing](https://api-docs.deepseek.com/quick_start/pricing)：正式模型标识和上下文能力；代理 Provider 的模型注册仍以本地统一配置为准。

## OpenAI

- [Function calling](https://developers.openai.com/api/docs/guides/function-calling)：工具定义、调用请求和工具结果循环。
- [Structured model outputs](https://developers.openai.com/api/docs/guides/structured-outputs)：JSON Schema 约束和结构化输出。
- [Conversation state](https://developers.openai.com/api/docs/guides/conversation-state)：对话状态与响应延续。
- [Streaming API responses](https://developers.openai.com/api/docs/guides/streaming-responses)：流式响应事件。
- [Retrieval](https://developers.openai.com/api/docs/guides/retrieval)：检索与向量存储概念。
- [Using tools](https://developers.openai.com/api/docs/guides/tools)：工具能力和使用方式。

## LangGraph 与 LangChain

- [LangGraph overview](https://docs.langchain.com/oss/python/langgraph/overview)：状态图运行时概览。
- [Thinking in LangGraph](https://docs.langchain.com/oss/python/langgraph/thinking-in-langgraph)：节点、状态和流程拆分。
- [Persistence](https://docs.langchain.com/oss/python/langgraph/persistence)：Checkpointer 与 Store 的职责。
- [Memory](https://docs.langchain.com/oss/python/concepts/memory)：短期与长期记忆概念。
- [Add and manage memory](https://docs.langchain.com/oss/python/langgraph/add-memory)：线程短期状态、Store 长期记忆和生产 checkpointer。
- [Streaming](https://docs.langchain.com/oss/python/langgraph/streaming)：消息、更新和自定义流。
- [Interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)：人工审批、暂停与恢复。
- [LangChain agents](https://docs.langchain.com/oss/python/langchain/agents)：Agent 循环与中间件。
- [LangChain tools](https://docs.langchain.com/oss/python/langchain/tools)：工具模式与运行上下文。
- [LangChain retrieval](https://docs.langchain.com/oss/python/langchain/retrieval)：两阶段 RAG 与 Agentic RAG。
- [LangGraph PostgreSQL checkpointer](https://github.com/langchain-ai/langgraph/tree/main/libs/checkpoint-postgres)：PostgreSQL 检查点实现。

## PostgreSQL 与 pgvector

- [pgvector](https://github.com/pgvector/pgvector)：距离操作符、精确检索、HNSW、IVFFlat、过滤与迭代扫描。
- [PostgreSQL Full Text Search](https://www.postgresql.org/docs/current/textsearch.html)：全文检索、`tsvector` 和查询函数。
- [PostgreSQL Row Security Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)：行级安全和租户隔离。
- [Psycopg connection pools](https://www.psycopg.org/psycopg3/docs/advanced/pool.html)：异步连接池。
- [Alembic](https://alembic.sqlalchemy.org/en/latest/)：数据库迁移。

## Python 服务端

- [FastAPI](https://fastapi.tiangolo.com/)：异步 API、依赖与流式响应。
- [Pydantic](https://docs.pydantic.dev/latest/)：配置、请求和结构校验。
- [HTTPX](https://www.python-httpx.org/)：异步 HTTP、超时和连接池。
- [OpenTelemetry Python](https://opentelemetry.io/docs/languages/python/)：追踪、指标和上下文传播。

## 前端与测试

- [assistant-ui](https://www.assistant-ui.com/docs)：对话运行时与界面原语。
- [Next.js App Router](https://nextjs.org/docs/app)：当前前端框架。
- [TanStack Query](https://tanstack.com/query/latest/docs/framework/react/overview)：服务端状态缓存和请求生命周期。
- [Radix UI](https://www.radix-ui.com/primitives/docs/overview/introduction)：无障碍交互原语。
- [Playwright assertions](https://playwright.dev/docs/test-assertions)：真实浏览器自动化断言。
- [Testing Library](https://testing-library.com/docs/react-testing-library/intro/)：面向用户行为的组件测试。

## 安全与评测

- [OWASP Top 10 for LLM Applications](https://owasp.org/www-project-top-10-for-large-language-model-applications/)：提示注入、敏感信息、过度代理等风险。
- [OpenAI evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices)：评测集和迭代方法。
- [OpenAI graders](https://developers.openai.com/api/docs/guides/graders)：模型与代码评分器。
- [LangSmith evaluation](https://docs.langchain.com/langsmith/evaluation)：数据集、实验与轨迹评测。
- [Ragas metrics](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/)：RAG 上下文与答案指标。

## 使用原则

- 官方文档优先于博客和二手教程。
- 框架示例只说明当前 API，正式项目必须锁定版本并运行回归。
- 模型名称、能力、价格和参数可能变化，应由部署配置和模型注册表管理。
- 文档中的初始阈值用于建立基线，不能替代真实数据评测。
