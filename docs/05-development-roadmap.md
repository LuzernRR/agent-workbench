# Agent 平台开发路线

## 1. 总路线

按可验证能力递增，不从复杂自治开始：

```mermaid
flowchart LR
  A["模型 API"] --> B["单轮对话"]
  B --> C["流式会话"]
  C --> D["一个只读工具"]
  D --> E["受限工具循环"]
  E --> F["LangGraph 状态图"]
  F --> G["检查点与恢复"]
  G --> H["长期记忆"]
  H --> I["RAG"]
  I --> J["审批与成果"]
  J --> K["评测与生产加固"]
```

每一阶段都必须能独立演示、测试和回滚。

## 2. 推荐目录

未来服务端建议建立独立目录，不把 Python 放进当前前端源码：

```text
backend/
├─ pyproject.toml
├─ alembic.ini
├─ migrations/
├─ src/workbench/
│  ├─ main.py
│  ├─ config.py
│  ├─ api/
│  │  ├─ dependencies.py
│  │  ├─ projects.py
│  │  ├─ threads.py
│  │  ├─ runs.py
│  │  ├─ approvals.py
│  │  └─ files.py
│  ├─ agent/
│  │  ├─ state.py
│  │  ├─ graph.py
│  │  ├─ nodes.py
│  │  ├─ routes.py
│  │  ├─ prompts.py
│  │  ├─ model_gateway.py
│  │  └─ event_mapper.py
│  ├─ tools/
│  │  ├─ registry.py
│  │  ├─ policy.py
│  │  ├─ executor.py
│  │  └─ builtins/
│  ├─ memory/
│  │  ├─ short_term.py
│  │  ├─ long_term.py
│  │  └─ extractor.py
│  ├─ rag/
│  │  ├─ ingestion.py
│  │  ├─ parsers.py
│  │  ├─ chunking.py
│  │  ├─ embeddings.py
│  │  ├─ retrieval.py
│  │  └─ reranking.py
│  ├─ persistence/
│  │  ├─ database.py
│  │  ├─ models.py
│  │  ├─ repositories.py
│  │  └─ event_store.py
│  ├─ security/
│  │  ├─ authorization.py
│  │  ├─ redaction.py
│  │  └─ url_policy.py
│  └─ observability/
│     ├─ tracing.py
│     └─ metrics.py
└─ tests/
   ├─ unit/
   ├─ integration/
   ├─ graph/
   ├─ security/
   └─ evals/
```

按领域拆包，不建立庞大的 `utils.py`。提示词、工具模式、数据库模型和公开 API 类型分别管理。

## 3. Python 基线

推荐：

```toml
[project]
requires-python = ">=3.12,<3.13"
dependencies = [
  "fastapi",
  "uvicorn[standard]",
  "pydantic",
  "pydantic-settings",
  "openai",
  "langgraph",
  "langgraph-checkpoint-postgres",
  "psycopg[binary,pool]",
  "sqlalchemy[asyncio]",
  "alembic",
  "pgvector",
  "httpx",
  "structlog",
  "opentelemetry-api",
  "opentelemetry-sdk"
]

[project.optional-dependencies]
test = [
  "pytest",
  "pytest-asyncio",
  "pytest-cov",
  "testcontainers[postgres]",
  "respx",
  "hypothesis"
]
```

版本由锁文件固定。解析 Office、PDF、网页或图像时，再按真实需求增加小范围依赖。

## 4. 阶段 0：定义产品契约

### 工作

- 明确单助手边界、目标用户和五到十个核心任务。
- 为每个任务定义输入、交付物、完成条件、风险和预算。
- 建立首批离线评测集。
- 固定公开事件协议和错误模型。
- 明确数据分类、租户隔离和删除要求。

### 交付

- 产品任务矩阵。
- 事件 JSON Schema。
- 错误码表。
- 评测集最小版本。
- 安全威胁模型。

### 验收

产品、前端、服务端和测试人员对同一状态与完成条件有一致理解。

## 5. 阶段 1：模型 API 通路

### 工作

1. 实现配置加载和密钥注入。
2. 实现 `ModelGateway`，先支持文本非流式调用。
3. 记录请求标识、模型、延迟、用量和错误。
4. 增加超时、有限重试和并发限制。
5. 用 Pydantic 验证一个结构化任务理解输出。

### 测试

- 配置缺失时启动失败且信息清晰。
- 模型成功、超时、限流、拒绝和格式错误。
- 日志不包含密钥和完整敏感输入。
- 相同固定输入在伪模型下结果确定。

### 验收

命令行或测试接口可以发送中文问题，得到文本和结构化输出，并有完整追踪。

## 6. 阶段 2：无工具单轮与多轮对话

### 工作

- 创建项目、会话、运行和消息表。
- 建立创建会话、读取快照、发送消息的 API。
- 实现系统提示词模板和版本。
- 保存用户消息和最终助手消息。
- 增加会话标题生成，但允许用户重命名。

### 验收

- 刷新页面后消息不丢失。
- 会话切换不显示上一会话的内容。
- 重复提交幂等键不会创建两个运行。
- 错误以稳定错误码和中文信息返回。

## 7. 阶段 3：流式输出与停止

### API

```text
POST /api/v1/threads/{thread_id}/runs
GET  /api/v1/runs/{run_id}/events
POST /api/v1/runs/{run_id}/stop
GET  /api/v1/threads/{thread_id}
```

### 工作

- 模型增量转换为稳定 Agent 事件。
- 事件写入事件表并通过 SSE 发布。
- 客户端使用最后 `seq` 断线续传。
- 完成事件包含完整文本，修复增量丢失。
- 停止信号贯穿 API、图任务和模型调用。

### 验收

- 首个可见事件和首段文本达到目标。
- 手动断开网络后能续传，消息不重复。
- 点击停止后不再继续产生正文。
- 页面刷新后能恢复活动运行或显示正确终态。

## 8. 阶段 4：一个只读工具

先实现无副作用工具，例如计算器或受控上下文读取。

### 工作

- 工具输入输出使用 Pydantic。
- 工具注册表包含说明、权限、超时和重试。
- 建立参数校验、执行、结果校验和审计管线。
- 发布工具开始、完成、失败事件。
- 前端运行过程可折叠展示。

### 验收

- 模型能在需要时调用工具，不需要时直接回答。
- 非法参数不会进入处理器。
- 工具超时不会卡住整个运行。
- 结果和错误不泄露内部实现。

## 9. 阶段 5：受限工具循环

### 工作

- 实现模型动作、工具执行、观察和终止循环。
- 设置动作轮数、工具次数、并发、时间和费用预算。
- 对重复无效调用和相同错误提前终止。
- 增加工具结果压缩和结果引用。
- 建立任务完成校验。

### 验收

- 三类多步任务在预算内完成。
- 达到上限时清晰结束，不无限循环。
- 工具调用失败后按错误类别恢复或终止。
- 每次工具调用有唯一标识和完整审计。

## 10. 阶段 6：LangGraph 显式编排

### 工作

- 将上下文、理解、计划、动作、工具、校验和结束拆为节点。
- 状态使用 TypedDict 或 Pydantic 明确定义。
- 路由函数纯函数化并写单元测试。
- 节点发出计划、工具和成果事件。
- 伪模型与伪工具完成图级确定性测试。

### 验收

- 能从任意节点追踪运行轨迹。
- 节点可以独立重试和测试。
- 图的循环和终止条件可由代码审查确认。
- 当前前端无需理解 LangGraph 内部事件。

## 11. 阶段 7：PostgreSQL 检查点与恢复

### 迁移顺序

1. 安装 pgvector 扩展。
2. 创建租户、用户、项目、会话、运行和消息表。
3. 创建事件、工具调用、审批、成果和文件表。
4. 执行 LangGraph Checkpointer 与 Store 初始化迁移。
5. 创建约束、索引和行级权限策略。
6. 用测试容器验证空库升级和旧版本升级。

### 工作

- LangGraph 使用 PostgreSQL Checkpointer。
- `thread_id` 与会话一对一映射。
- 事件发布遵循先持久化后发布。
- 服务进程重启后可恢复运行。
- 工具和外部写入使用幂等表。

### 验收

- 在每个节点后模拟崩溃并恢复。
- 审批等待跨服务重启仍有效。
- 重放不会重复产生副作用。
- 恢复后事件序号连续。

## 12. 阶段 8：用户长期记忆

### 工作

- 建立语义、情景和程序记忆模式。
- 快速模型抽取候选记忆。
- 敏感、稳定性、冲突和重复过滤。
- 读取时按用户、类型、有效期和相关性检索。
- 提供用户查看、修改、停用和删除接口。

### 验收

- 新会话能正确使用明确偏好。
- 临时信息和第三方敏感信息不会自动写入。
- 冲突记忆有替代关系。
- 删除后检索、缓存和向量不再返回该记忆。

## 13. 阶段 9：RAG 最小闭环

### 工作

1. 只支持一种高价值文件类型。
2. 解析并保留标题和页码。
3. 结构感知切片和元数据。
4. 生成嵌入并写 pgvector。
5. 先做精确向量检索建立基线。
6. 加入关键词检索和倒数排名融合。
7. 返回带片段标识的引用。
8. 建立至少五十条真实检索评测样本。

### 验收

- 目标片段 Recall@k 达到基线目标。
- 权限过滤无泄露。
- 无证据问题能够拒绝猜测。
- 引用能打开正确文档版本和位置。

## 14. 阶段 10：RAG 扩展与调优

### 工作

- 增加 PDF、Office、网页和代码解析器。
- 按内容类型配置切片器。
- 加入查询改写、父子片段和重排。
- 评估 HNSW 与精确检索的质量和延迟。
- 建立增量更新、版本切换和删除流程。
- 解析失败进入隔离队列和人工修复入口。

### 验收

- 每种文件类型有解析与引用回归集。
- 更新文档后只有生效版本参与检索。
- 重排提升质量且成本与延迟在预算内。
- 大规模数据下第 95 百分位延迟达标。

## 15. 阶段 11：审批、成果和文件

### 工作

- 使用 LangGraph 中断实现审批等待和恢复。
- 工具策略分读取、受限读取、可逆写入和高风险写入。
- 成果有草稿、审核、可下载状态和版本。
- 文件生成、预览和下载使用受控对象存储。
- 生成代码在隔离环境验证语法、测试和安全规则。

### 验收

- 高风险动作没有审批漏检。
- 拒绝后图选择安全替代或结束。
- 审批恢复不重放已有副作用。
- 成果在审核通过前不能下载为正式版本。
- 文件名、类型、大小和路径攻击测试通过。

## 16. 阶段 12：生产加固

### 工作

- 完整离线回归和攻击集。
- OpenTelemetry 追踪、指标、告警和仪表盘。
- 限流、预算、熔断、隔舱和功能开关。
- 数据备份、恢复、保留和删除演练。
- 小流量、分阶段发布和快速回滚。
- 运行手册和事故响应流程。

### 验收

- 所有安全硬门槛通过。
- 服务重启、数据库故障、模型限流和工具不可用演练通过。
- 发布版本可追溯到配置、提示词、工具和索引版本。
- 一键关闭高风险工具和记忆写入。

## 17. API 契约建议

### 项目与会话

```text
GET    /api/v1/projects
POST   /api/v1/projects
PATCH  /api/v1/projects/{project_id}
DELETE /api/v1/projects/{project_id}
GET    /api/v1/threads
POST   /api/v1/threads
GET    /api/v1/threads/{thread_id}
PATCH  /api/v1/threads/{thread_id}
DELETE /api/v1/threads/{thread_id}
```

### 运行与审批

```text
POST /api/v1/threads/{thread_id}/runs
GET  /api/v1/runs/{run_id}/events
POST /api/v1/runs/{run_id}/stop
POST /api/v1/approvals/{approval_id}
```

### 附件、成果和文件

```text
POST /api/v1/threads/{thread_id}/attachments
GET  /api/v1/attachments/{attachment_id}
GET  /api/v1/artifacts/{artifact_id}
GET  /api/v1/files/{file_id}
```

### 配置目录

```text
GET /api/v1/models
GET /api/v1/tools
```

模型和工具目录只返回用户可用配置，不返回密钥、内部端点和不可授权工具。

## 18. 数据库迁移纪律

- 所有模式变更使用 Alembic，禁止生产手工改表。
- 先扩展、后迁移数据、再切换读取、最后删除旧列。
- 大表索引评估并发创建和锁影响。
- 向量模型或维度变化创建新版本列或表并双写回填。
- 每个迁移有前向测试、回滚策略和数据校验查询。
- LangGraph 自带表的迁移与业务迁移分开记录。

## 19. CI 流水线

每个合并请求：

1. 格式化、静态类型和安全扫描。
2. 单元与属性测试。
3. PostgreSQL 与 pgvector 集成测试。
4. 图轨迹测试和固定伪模型测试。
5. 小型真实模型评测或受控夜间评测。
6. 前端类型、单元、构建和 Playwright。
7. 依赖和容器漏洞扫描。
8. 生成评测与性能差异报告。

主分支定时运行完整回归、RAG 检索集、攻击集和恢复演练。

## 20. 开发环境

本地环境至少包含：

- 前端开发服务器 `3100`。
- Python API 开发服务器，端口由环境配置。
- PostgreSQL 与 pgvector。
- 模拟模型和工具，用于稳定自动化测试。
- 可选的真实模型配置，只在显式集成测试中使用。
- 本地追踪查看器或受控追踪项目。

默认测试不能依赖真实模型、公共互联网和个人凭据。

## 21. 估算与优先级

先实现垂直闭环，再拓展功能面。优先级顺序：

1. 状态正确和不会泄露数据。
2. 停止、重试、恢复和幂等。
3. 核心任务质量和工具准确率。
4. 检索和引用质量。
5. 延迟与成本。
6. 更多工具、文件类型和自动化能力。

成熟 Agent 平台的标志不是工具数量，而是任务能稳定完成、过程可解释、失败可恢复、权限可证明。

