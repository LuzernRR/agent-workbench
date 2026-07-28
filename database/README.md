# 数据库模块

此目录保存跨应用共享的数据库迁移与运维说明。Web/BFF 的查询实现仍位于
`apps/web/src/server/persistence/`，Python Agent 的持久化适配器位于
`services/search-agent/app/persistence/`；两者都只能通过这里定义的稳定表
或各自框架管理的内部表访问 PostgreSQL。

- `migrations/002_search_agent_runtime.sql`：真实搜索工具幂等账本。
- LangGraph checkpoint 表由官方 `AsyncPostgresSaver.setup()` 幂等创建。
- Milvus collection 由 Python 服务启动时检查；Docker 数据实际挂载在
  `D:\milvus`，不进入 Git 工作树。
- PostgreSQL 使用命名卷 `001-agent_agent-workbench-postgres`；迁移目录会复制到
  Search Agent 镜像，容器启动时只执行幂等建表。
- 备份、隔离恢复演练、Milvus 三目录一致性边界和降级步骤统一见
  `deploy/README.md`。禁止用 `docker compose down -v` 清理生产数据。
