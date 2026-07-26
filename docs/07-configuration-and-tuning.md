# 配置与调优手册

## 1. 配置优先级

从低到高：

1. 代码内安全默认值。
2. 版本化配置文件。
3. 部署环境变量。
4. 租户策略。
5. 项目策略。
6. 单次运行参数。

高优先级只能在平台允许范围内收窄或选择，不能绕过全局安全上限。

## 2. 环境变量基线

```dotenv
APP_ENV=development
APP_LOG_LEVEL=INFO
APP_PUBLIC_ORIGIN=http://localhost:3100

DATABASE_URL=postgresql://workbench:local-password@localhost:5432/workbench
DATABASE_POOL_MIN_SIZE=2
DATABASE_POOL_MAX_SIZE=20
DATABASE_STATEMENT_TIMEOUT_MS=30000

MODEL_API_KEY=由本地安全环境或密钥系统注入
MODEL_BASE_URL=https://api.openai.com/v1
MODEL_FLAGSHIP_ID=部署选择的旗舰模型
MODEL_BALANCED_ID=部署选择的均衡模型
MODEL_FAST_ID=部署选择的快速模型
MODEL_EMBEDDING_ID=部署选择的嵌入模型
MODEL_REQUEST_TIMEOUT_SECONDS=60
MODEL_MAX_RETRIES=2
MODEL_MAX_PARALLEL_REQUESTS=16

AGENT_MAX_ACTION_ROUNDS=8
AGENT_MAX_TOOL_CALLS=12
AGENT_MAX_PARALLEL_TOOLS=3
AGENT_SOFT_DEADLINE_SECONDS=120
AGENT_HARD_DEADLINE_SECONDS=180

RAG_VECTOR_DIMENSION=1536
RAG_VECTOR_CANDIDATES=60
RAG_KEYWORD_CANDIDATES=60
RAG_RERANK_CANDIDATES=20
RAG_FINAL_CHUNKS=8

MEMORY_MAX_RETRIEVED=6
MEMORY_WRITE_MIN_CONFIDENCE=0.8
MEMORY_DEFAULT_TTL_DAYS=365

SSE_HEARTBEAT_SECONDS=15
SSE_RECONNECT_WINDOW_SECONDS=300
```

生产环境不能使用仓库内 `.env` 保存密钥。示例密码只允许本地一次性数据库。

## 3. 模型注册表

```yaml
models:
  flagship:
    id_from_env: MODEL_FLAGSHIP_ID
    supports_tools: true
    supports_structured_output: true
    supports_vision: true
    max_output_tokens: 12000
    timeout_seconds: 90
  balanced:
    id_from_env: MODEL_BALANCED_ID
    supports_tools: true
    supports_structured_output: true
    supports_vision: true
    max_output_tokens: 6000
    timeout_seconds: 60
  fast:
    id_from_env: MODEL_FAST_ID
    supports_tools: true
    supports_structured_output: true
    supports_vision: false
    max_output_tokens: 3000
    timeout_seconds: 30
```

运行只选择角色。网关记录角色与实际模型，避免提示词和图节点绑定供应商标识。

## 4. 任务预算

| 任务类型 | 动作轮数 | 工具调用 | 软时限 | 最大输出 | 推荐模型 |
| --- | ---: | ---: | ---: | ---: | --- |
| 普通问答 | 2 | 1 | 30 秒 | 2000 令牌 | 均衡 |
| 文档问答 | 4 | 4 | 60 秒 | 3000 令牌 | 均衡 |
| 研究任务 | 8 | 12 | 120 秒 | 6000 令牌 | 均衡加旗舰审核 |
| 代码任务 | 8 | 10 | 180 秒 | 8000 令牌 | 旗舰 |
| 文件成果 | 8 | 12 | 180 秒 | 10000 令牌 | 旗舰 |

预算是总上限，不是目标消耗。简单任务应提前结束。

## 5. 工具策略配置

```yaml
tools:
  context_read:
    permission: read
    approval: never
    timeout_seconds: 10
    retries: 1
    max_result_bytes: 65536
  calculator:
    permission: read
    approval: never
    timeout_seconds: 3
    retries: 0
    max_result_bytes: 8192
  code_runner:
    permission: risky
    approval: every_time
    timeout_seconds: 30
    retries: 0
    sandbox:
      network: false
      memory_mb: 512
      cpu_seconds: 20
      output_bytes: 1048576
```

工具配置变更进入版本控制和评测流程。审批策略不能由提示词覆盖。

## 6. 重试配置

推荐退避：

```text
delay = min(max_delay, base_delay × 2^attempt) + random_jitter
```

初始值：

| 调用 | 基础延迟 | 最大延迟 | 次数 |
| --- | ---: | ---: | ---: |
| 模型临时错误 | 0.5 秒 | 4 秒 | 2 |
| 只读 HTTP 工具 | 0.25 秒 | 2 秒 | 2 |
| 数据库连接获取 | 0.1 秒 | 1 秒 | 2 |
| 嵌入批次 | 1 秒 | 8 秒 | 3 |
| 高风险写入 | 不自动重试 | 不适用 | 0 |

供应商返回明确等待时间时，在总时限内优先遵循。相同参数业务无结果不属于临时错误。

## 7. 超时配置

分层设置：

- 连接超时：建立连接的最大时间。
- 首字节超时：流式请求首次响应的最大时间。
- 空闲超时：流中两个事件之间的最大等待。
- 总请求超时：一次模型或工具调用的总时间。
- 运行软时限：允许生成降级结果。
- 运行硬时限：强制取消。

下层超时必须小于上层时限，给清理、事件提交和降级留出时间。

## 8. PostgreSQL 配置

### 连接池

- 每个服务实例从 2 到 20 个连接开始压测。
- 总连接数小于数据库上限，并为迁移、运维和后台任务保留空间。
- 流式 SSE 连接不能长期占用数据库事务。
- 工具调用和检索使用短事务。
- 连接获取超时与 SQL 语句超时分别设置。

### 表和索引

- 高频查询索引必须包含租户边界。
- 事件表按运行和序号唯一。
- 消息、工具和成果按运行索引。
- 文档片段同时有结构化过滤索引、全文 GIN 和向量索引。
- 定期分析查询计划、表膨胀和索引命中。

### 向量索引基线

从精确检索建立质量基线。数据规模和延迟需要近似索引时：

```sql
CREATE INDEX CONCURRENTLY document_chunks_embedding_hnsw
ON document_chunks
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);
```

查询会话可调搜索宽度：

```sql
BEGIN;
SET LOCAL hnsw.ef_search = 80;
SELECT id
FROM document_chunks
WHERE tenant_id = $1
ORDER BY embedding <=> $2::vector
LIMIT 60;
COMMIT;
```

`m`、`ef_construction` 和 `ef_search` 需要按内存、构建时间、延迟和 Recall@k 联合评测。过滤条件很强时，测试迭代扫描、分区或部分索引。

## 9. 切片配置

```yaml
chunking:
  default:
    target_tokens: 520
    max_tokens: 760
    overlap_tokens: 70
    respect_headings: true
    attach_heading_path: true
  code:
    strategy: symbols
    max_tokens: 900
  tables:
    strategy: header_plus_row_groups
    max_rows: 40
  faq:
    strategy: question_answer_pair
```

调优时记录切片器版本。新版本先写新文档版本并离线比较，再切换生效索引。

## 10. 检索配置

```yaml
retrieval:
  keyword_candidates: 60
  vector_candidates: 60
  rrf_k: 60
  rerank_candidates: 20
  final_chunks: 8
  max_chunks_per_document: 3
  min_vector_similarity: 0.35
  expand_parent: true
  expand_neighbors: 1
  max_context_tokens: 9000
```

相似度阈值不能跨嵌入模型照搬。模型升级后重新统计相关与无关样本分布。

## 11. RAG 调优矩阵

| 现象 | 优先检查 | 调整方向 |
| --- | --- | --- |
| 标准片段完全未召回 | 解析、权限、切片、查询实体 | 修复摄取或查询，不先换回答模型 |
| 召回很多相似重复片段 | 重叠、去重、单文档占比 | 降低重叠，按哈希去重 |
| 编号和错误码找不到 | 关键词分词与精确字段 | 增强全文和精确匹配 |
| 语义问题找不到 | 嵌入、查询改写、候选数 | 调整向量召回和改写 |
| 目标片段在候选后部 | 重排器和特征 | 增加重排，保留标题与实体 |
| 有证据仍答错 | 上下文打包与生成提示词 | 去冲突、提高引用约束 |
| 无答案时仍编造 | 无答案样本和阈值 | 加入拒答路径和校验 |
| 过滤后返回不足 | 近似索引扫描宽度 | 提高搜索宽度或使用分区 |

## 12. 记忆配置

```yaml
memory:
  extraction_model_role: fast
  min_write_confidence: 0.80
  max_retrieved: 6
  default_ttl_days: 365
  allow_automatic_sensitive_memory: false
  require_source_reference: true
  dedup_similarity: 0.92
  conflict_strategy: supersede_with_history
```

对稳定偏好和事实使用不同有效期。长期目标可以更长，临时项目偏好应绑定项目或较短有效期。

## 13. 上下文压缩配置

触发条件不能只看消息数，应看令牌预算：

```yaml
context:
  reserve_output_tokens: 4000
  summarize_when_input_ratio: 0.72
  retain_recent_turns: 8
  summary_model_role: fast
  max_summary_tokens: 1800
  preserve_tool_pairs: true
  preserve_active_plan: true
```

摘要质量用事实保留、约束保留和待办保留评测。摘要失败时保留原始历史并选择更保守裁剪。

## 14. SSE 配置

- 心跳 15 秒。
- 事件标识使用单调序号。
- 客户端携带最后事件标识重连。
- 服务端保留足够事件恢复窗口。
- 文本增量按 20 到 50 毫秒或合理字符数合并，避免高频渲染。
- 事件写入与发布解耦，慢客户端不能阻塞图执行。
- 最终消息事件包含完整正文。

## 15. 缓存

可缓存：

- 模型目录和工具目录。
- 相同文件哈希的解析和嵌入。
- 公开且稳定查询的只读工具结果。
- 同一文档版本和查询的检索候选。

谨慎缓存：

- 带用户权限的检索，键必须包含租户、主体和权限版本。
- 用户记忆读取，记忆更新后立即失效。
- 模型回答，只有确定性低风险场景才考虑。

不能缓存高风险写入结果并把缓存视为实际执行。

## 16. 功能开关

至少提供：

- 真实模型调用。
- 长期记忆读取。
- 长期记忆写入。
- RAG 查询改写。
- 重排器。
- 代码运行工具。
- 高风险写入工具。
- 自动打开工作区。
- 新模型或新提示词版本。

开关按环境、租户和流量比例控制，安全开关可以全局立即关闭。

## 17. 性能测试场景

### 前端

- 200 条消息与长 Markdown。
- 高频流式增量和工具进度。
- 连续快速切换十个会话。
- 大项目与会话列表。
- 多个长文件名和代码文件。
- 390px 移动端工作区抽屉。

### 服务端

- 并发创建运行。
- 长连接 SSE 与断线恢复。
- 模型限流和慢工具。
- 10 万、100 万和更大规模片段检索。
- 强租户过滤下的向量召回。
- 文档批量摄取和在线查询竞争资源。
- 服务实例在审批等待期间重启。

报告平均值、第 50、第 95、第 99 百分位、错误率和资源用量。

## 18. 调优实验记录

每次实验记录：

```text
实验标识
日期与负责人
代码和配置版本
假设
单一变更项
评测集版本
质量、延迟、成本和安全结果
统计置信度或样本规模
是否发布
回滚条件
```

一次实验不要同时改模型、提示词、切片和重排，否则无法归因。

## 19. 故障定位顺序

### 回答质量差

1. 用户目标是否被正确结构化。
2. 当前上下文是否包含必要约束。
3. 正确工具是否暴露且说明清楚。
4. 工具参数和结果是否正确。
5. RAG 目标片段是否召回。
6. 校验节点是否发现问题。
7. 最后检查模型和提示词。

### 延迟高

1. 排队和连接池等待。
2. 首次模型响应。
3. 串行且可并行的只读工具。
4. 重复检索、嵌入或重排。
5. 过长上下文。
6. 事件和前端渲染频率。
7. 数据库查询计划和向量搜索参数。

### 成本高

1. 无关历史和重复工具结果。
2. 不必要的旗舰模型调用。
3. 过多动作轮次和修复轮次。
4. 未缓存的稳定解析和嵌入。
5. 候选和重排规模过大。
6. 失败请求的无差别重试。

### 循环不结束

1. 完成条件是否可判定。
2. 工具空结果是否被分类。
3. 相同调用是否检测重复。
4. 计划步骤状态是否推进。
5. 路由是否读取旧状态。
6. 轮数、工具数和硬时限是否生效。

## 20. 配置变更发布

1. 在离线回归集中比较基线。
2. 检查安全硬门槛。
3. 记录配置版本和变更说明。
4. 小流量发布。
5. 观察质量、延迟、成本和错误。
6. 达标后逐步扩大。
7. 指标恶化时切回上一版本。

配置与提示词和代码一样需要评审、测试和回滚。

