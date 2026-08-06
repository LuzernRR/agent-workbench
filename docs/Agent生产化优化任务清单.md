# Agent 生产化优化任务清单

本文是后续模型的唯一生产化优化队列。它把两份外部手册的技术选型与当前仓库逐项对齐，避免后续工作只做
局部性能微调，却遗漏身份、持久化、恢复、评测和运维等生产边界。

## 使用规则

1. 严格按 P0 → P1 → P2 和同级编号执行；同一时间只允许一个 GitHub Issue / 一个功能处于开发状态。
2. 默认必须获得用户明确验收；若用户明确授权 Codex 依据 DoD 自主验收并连续推进，必须在开发记录中保存
   该授权与逐项证据，未满足任一 DoD 时仍不得开启下一项。当前持续优化目标已于 2026-08-05 获得该授权。
3. 每项开始前都要重新核对仓库现状和手册原文，把目标切成可独立验证、可回滚的最小 Issue。
4. 技术栈是默认决策，不是无条件堆组件：初期优先模块化单体 + 独立 Worker；Temporal、Kafka、Kubernetes
   和专用向量库只有在长事务、吞吐、隔离或团队运维能力有证据支持时才引入。
5. 每项完成后更新本清单状态、`HANDOFF.md` 和一份 `docs/development/` 中文开发记录。

状态取值：`awaiting-acceptance`、`blocked`、`ready`、`in-progress`、`accepted`。

## 文档依据

- 《商用 Agent 开发全流程手册》：第 8-9 页推荐起步栈和 Runtime 选型；第 11-13 页 Model Gateway、
  Context 与 Runtime；第 15 页工具错误和 MCP 安全；第 17-19 页 RAG、数据、重试、Outbox/Inbox、
  OIDC/RBAC/ABAC；第 22 页评测与 OpenTelemetry；第 25 页 CI/CD、Secret、容量与发布。
- 《生产级 Agent 底层技术架构与工程实战》：第 6 页控制面/数据面/执行面；第 8-13 页仓库分层、统一
  错误、Schema 版本、SSE、幂等和事务边界；第 18 页 Model Gateway；第 22 页记忆治理；第 25-27 页
  Embedding、pgvector、Hybrid/RRF/Rerank；第 34-41 页 Worker、Checkpoint、观测、容量、故障注入和
  实施顺序；第 45-47 页 lease/fencing 与核心数据表。
- 仓库内的 `docs/万能搜索Agent开发指南.md` 和 `docs/万能搜索Agent端到端开发流程.md`：进一步明确
  中文检索采用 BGE-M3、PostgreSQL FTS + pgvector、RRF 与 `bge-reranker-v2-m3` 的实现方向。

## 当前匹配度

| 领域 | 手册目标 | 当前实现 | 判断 |
|---|---|---|---|
| Web/BFF | Next.js + React + TypeScript，SSE 事件流 | 已使用 Next.js 16、React 19、TypeScript，BFF 对 AgentEvent 做 Zod 校验 | 基础匹配 |
| Agent Runtime | Python 3.12 + FastAPI + Pydantic 2 + LangGraph | 已落地显式图、预算、事件、PostgreSQL Checkpoint；恢复只从 Run 账本完整权威引用精确 fork | 主栈匹配，#50 等待验收 |
| 数据 | PostgreSQL 为权威状态；Redis 只做缓存/锁/限流；对象存储保存产物 | PostgreSQL 已保存运行账本、Checkpoint、lease/fencing 持久队列、source Inbox 与 transactional Outbox；尚无备份恢复门禁 | 主路径匹配，灾备待补 |
| 模型层 | 统一 Model Gateway 负责路由、配额、重试、降级、成本和版本 | 生产 Search Agent 已统一走 Model Gateway；旧 mock/预览客户端仍独立，持久租户配额与健康熔断未完成 | 主路径匹配，治理待补 |
| 工具层 | Tool Registry/Gateway 负责 Schema、鉴权、幂等、审批和审计 | 已有 Tool Ledger、稳定事件和部分安全门禁，但缺统一策略执行面 | 部分匹配 |
| RAG | PostgreSQL FTS + pgvector 起步，Hybrid + RRF + Rerank，ACL 先过滤 | Compose 有 pgvector，但实际证据记忆走 Milvus + hashing embedding，尚无完整企业知识摄取和混合检索 | 技术路线未收敛 |
| 身份与租户 | OIDC/SSO；RBAC + ABAC；每次工具/数据访问服务端复核 | 主要是内部静态 token、环境 tenant 和数据字段过滤，没有真实用户身份与策略引擎 | P0 缺口 |
| 可观测性 | OTel SDK/Collector + Metric/Trace/Log，Prometheus/Grafana；可选 Langfuse | 已有隐私门控 span、OTel GenAI 属性和可选 LangSmith sink，未接 Collector、指标面板和 SLO 告警 | 部分匹配 |
| 评测 | 30-100 条初始 Golden Cases，轨迹/恢复/安全/成本发布门禁 | 已有 replay/scorer 和大量确定性测试，但未形成足量 Golden Cases 与 CI 质量阈值 | 部分匹配 |
| 代码架构 | domain/application/ports/adapters；模块化单体 + 独立 Worker | Node Run Worker 已与无状态 API 分离；`graph/nodes.py` 仍约 3014 行，编排、业务规则和适配逻辑集中 | 部分匹配，维护性风险 |

## P0：生产正确性与恢复

### P0-00 Web Search RetryPolicy

- 状态：`accepted`，Issue [#39](https://github.com/LuzernRR/agent-workbench/issues/39)，PR
  [#40](https://github.com/LuzernRR/agent-workbench/pull/40) 已合并（`74bc141`）。
- 已实现：错误分类、`Retry-After`、full jitter、attempt/elapsed 双上限；只迁移 Web Search。
- 验收：用户 2026-08-04 回复“验收通过，继续”。

### P0-01 Web Search 绝对 Deadline Propagation

- 状态：`accepted`，Issue [#41](https://github.com/LuzernRR/agent-workbench/issues/41)，PR
  [#42](https://github.com/LuzernRR/agent-workbench/pull/42) 已合并（`7b68016`）。
- 验收：用户 2026-08-04 验收通过。
- 诊断修正：Run 已有 `maxRunSeconds`、最终写作预留和工具外层硬 timeout；缺口是 Web 内部各层重置相对
  timeout，而不是缺少 Run 终止机制。
- 已实现：进程内单调时钟 `DeadlineBudget` 从工具入口贯穿 WebChannel、Tavily Key 池、Provider retry、
  DuckDuckGo fallback 与 fetch；任何子层只能收紧 deadline，不能延长。公共 State/Event 协议不变。
- 未迁移：DeepSeek/Model Gateway 进入 P0-02；X/小红书仍保留现有渠道 timeout 与工具外层硬边界，迁移
  时必须单独处理小红书人工验证的暂停计时。

### P0-02 统一 Model Gateway 与分层重试

- 状态：`accepted`，Issue [#43](https://github.com/LuzernRR/agent-workbench/issues/43)。
- 验收：用户 2026-08-04 回复“通过，继续”。
- 目标技术：内部 `ModelRequest/ModelResult` Pydantic 契约 + Provider adapters；Gateway 统一模型路由、
  租户配额、成本预算、Prompt/模型版本、timeout、fallback、健康度和 OTel 属性。
- 已实现：`app/llm/{contracts,ports,gateway,factory}.py`；`nodes.py` 只经 `RunContext.model_gateway`
  调模型，AST 静态测试守住这条边界；DeepSeek 收进 `DeepSeekProviderAdapter` 且 SDK `max_retries=0`；
  Gateway 复用 #39 `RetryPolicy` 与 #41 `DeadlineBudget`；`attempts`/`network_retries`/`format_repairs`/
  `fallbacks` 四项分开记账，格式修复全程上限 1；备用模型只认显式配置且能力不得降低，未配置即 fail
  closed；Writer 首段正文之后不再重试或切模型；model span 用 `gen_ai.request.model` 与
  `gen_ai.response.model` 区分 primary/effective。
- 未做（本项范围外）：租户持久配额与 Provider 健康度存储留在 P0-05/P0-08；未迁移 mock/旧预览
  TypeScript DeepSeek 客户端。
- 遗留已清理：`app/llm/deepseek.py` 的 `invoke_structured`、`stream_writer_answer`、
  `invoke_researcher_turn`、`_record_model_span` 已由 Issue
  [#46](https://github.com/LuzernRR/agent-workbench/issues/46) 全部删除（PR
  [#47](https://github.com/LuzernRR/agent-workbench/pull/47) 已合并 `028c9c7`），模块只剩
  `DeepSeekProviderAdapter`，并由 AST 静态测试守住「网络调用只能出现在 adapter 类体内」。
  复核中确认 `invoke_researcher_turn` 无任何调用点，无需先扩展 `ModelResult` 即可删除。

### P0-03 独立 Worker、持久任务队列与租约

- 状态：`accepted`，Issue [#48](https://github.com/LuzernRR/agent-workbench/issues/48)，PR
  [#49](https://github.com/LuzernRR/agent-workbench/pull/49) 已 squash 合入 main（`1f16041`）。
- 目标技术：先用 PostgreSQL `FOR UPDATE SKIP LOCKED` 或 Redis + Dramatiq/Celery 承载短/中任务；
  API 与 Worker 进程分离；Run 表使用 `lease_owner/lease_epoch/lease_expires_at`、heartbeat 和 fencing token。
  只有跨小时/天、外部事件等待和复杂补偿达到实际需求时，才引入 Temporal 外层工作流。
- 已实现：API 只持久化 `queued` Run 与用户事件；独立 Node Worker 从 PostgreSQL FIFO 队列领取；每次
  claim 单调递增 epoch，heartbeat、事件、release 和 finalize 都校验 owner + epoch + 未过期租约；SSE
  只轮询持久事件。Compose 使用同一 Web 镜像启动可横向扩展且不开放端口的 Worker 服务。
- 验收：隔离 PostgreSQL 故障注入证明并发 claim 唯一、过期后接管 `resume=true`、旧 Worker 的四类迟到
  操作全部拒绝且终态唯一；容器实测 SIGTERM 停止领取、关闭连接并可重新启动。用户 2026-08-05 明确
  授权 Codex 自主判定验收并自动继续；本项按完整 DoD 证据验收。
- 未做：Checkpoint、AgentEvent 与 Outbox 的同事务原子边界明确留给 P0-04。

### P0-04 Checkpoint、AgentEvent 与 Outbox 原子边界

- 状态：`awaiting-acceptance`。Issue
  [#50](https://github.com/LuzernRR/agent-workbench/issues/50) 已技术完成，等待用户显式验收。
- 已实现：Python 以 `durability="sync"` 提交 LangGraph Checkpoint；Node 仅从 `wb_runs` 的
  `checkpointSessionId + checkpointNs + checkpointId` 权威引用恢复，并在另一个 PostgreSQL 事务内同时
  确认 Run revision、checkpoint commit、source Inbox、连续 AgentEvent 和 transactional Outbox。该协议
  明确是两个本地事务，不宣称 XA 或跨服务原子性。
- 已验证：真实 PostgreSQL 微图证明较新孤儿 checkpoint 不会越过旧权威引用；lease/parent/revision、重复
  批次、冲突 Inbox、各写入阶段回滚、Worker kill、稳定 Tool Ledger 重放、`SKIP LOCKED` Outbox 与无
  listener 的 SSE cursor 补发均有直接测试。完整证据见
  [开发记录 043](development/2026-08-06-043-issue-50-checkpoint-outbox.md)。
- 发布约束：Search Agent 固定 `LANGGRAPH_STRICT_MSGPACK=true`；Outbox `NOTIFY` 只负责唤醒，持久事件表
  始终是可靠来源。验收前不得关闭 #50、合并 PR 或启动 P0-05。

### P0-05 OIDC、多租户授权、配额与审计

- 状态：`blocked`。
- 目标技术：Web 接入企业 OIDC/OAuth2，BFF 使用服务身份调用 Agent；RBAC 管角色，ABAC 按 tenant、
  resource、classification、environment 和时间做服务端授权；PostgreSQL 可结合 RLS 作为纵深防御。
- 当前问题：内部 token 和 `WORKBENCH_TENANT` 不能代表真实用户身份，调用方可传 tenant 字段不等于授权。
- 最小验收：跨租户、越权资源、伪造 tenant、过期 token 全部 fail closed；模型不能成为授权主体；工具、
  RAG、记忆和下载每次重新校验；租户 QPS/并发 Run/Token/费用均有限额并写审计。

### P0-06 完整 Tool Gateway 与副作用语义

- 状态：`blocked`。
- 目标技术：版本化 Tool Registry + Tool Gateway，登记输入/输出 Schema、权限、成本、超时、副作用、
  幂等和审批策略；写工具以原子业务工具或 Saga/补偿暴露，不向模型开放任意 SQL/Shell/HTTP。
- 当前问题：Tool Ledger 已覆盖调用事实，但统一授权、审批绑定 revision、`outcome_unknown` 对账和补偿失败
  人工处理仍不完整。
- 最小验收：副作用工具响应丢失后先查 operation 状态，禁止盲重试；同幂等键并发只产生一个业务效果；
  approval 绑定参数 hash + state revision；补偿达到上限进入 dead-letter/人工处理。

### P0-07 Schema 版本与独立 Migration Job

- 状态：`blocked`。
- 目标技术：数据库 schema、`state_schema_version`、`event_version`、graph/prompt/tool/release 版本独立管理；
  部署前由一次性 migration job 执行，应用副本无 DDL 权限。
- 最小验收：历史 Checkpoint fixtures 可在新版本加载或显式拒绝；支持 expand/migrate/contract；回滚不会
  读取不兼容状态；每次发布能从 Run/Trace 还原完整版本组合。

### P0-08 Admission、Bulkhead、限流与熔断

- 状态：`blocked`。
- 目标技术：边缘限流 + Redis 租户令牌桶/滑窗 + 服务 semaphore/队列深度 + 每 Provider 独立连接池；
  Circuit Breaker 半开探测，Load Shedding 优先拒绝低优先级大任务。
- 最小验收：慢搜索不会耗尽模型或数据库并发池；超过队列等待预算快速返回稳定错误；Redis 不作为权威
  Run 状态；面板可观察 inflight、queue oldest age、429、breaker state 和拒绝原因。

## P1：知识、质量与运营

### P1-01 RAG 技术路线收敛

- 状态：`blocked`。
- 默认技术选型：PostgreSQL FTS + pgvector（HNSW 起步）双路召回，RRF 融合，BGE-M3 embedding，
  `bge-reranker-v2-m3` 精排；所有索引记录 model/version/dimension/normalization。
- 当前问题：项目同时存在 pgvector 基础设施与 Milvus + hashing embedding 实现，尚无 ADR 说明何者是权威
  检索层，也没有 Hybrid/RRF/Rerank 完整链路。
- 最小验收：先用领域 Golden Set 比较 Recall@K/MRR/nDCG、P95 和成本，再由 ADR 决定保留 pgvector 或
  Milvus；不得长期双写两套无一致性方案；模型升级走新索引、回填、评测、别名切换。

### P1-02 企业知识摄取与删除传播

- 状态：`blocked`。
- 目标技术：版本化 source/document/chunk 表 + 对象存储原文；结构化 Chunk 保留章节、页码、坐标和父子
  关系；ACL/tenant/project/classification 在召回前过滤。
- 最小验收：支持增量更新、重试、死信、数据质量告警和删除传播；旧版本 chunk/embedding 不再被召回；
  引用能回到确切文档版本与 locator；间接 Prompt Injection 样本被隔离。

### P1-03 Token 级 Context Builder

- 状态：`blocked`。
- 目标技术：独立 `context.py` 按系统策略、当前状态、授权事实、RAG 证据、会话摘要和输出 Schema 分配
  Token；每段带 source、observed_at、permission、purpose 和预算。
- 最小验收：超预算时按确定性优先级裁剪/摘要，关键策略和最新工具事实不丢；记录 token_by_source、
  trimmed、summary_version；历史摘要可重新生成和版本化。

### P1-04 长期记忆治理

- 状态：`blocked`。
- 目标技术：结构化 MemoryRecord + 可选向量索引；保存来源、置信度、敏感度、同意依据、TTL、访问次数、
  `superseded_by`；模型只提候选，确定性门禁决定写入。
- 最小验收：一次性值和高敏数据默认不写；冲突不静默覆盖；支持用户删除、租户删除传播、过期和审计；
  记忆召回同时满足 ACL、新鲜度、可信度与 Token 预算。

### P1-05 OTel Collector、指标、SLO 与告警

- 状态：`blocked`。
- 目标技术：现有 span 接 OTel SDK/Collector；Prometheus/Grafana 承载 RED/USE 与业务指标；可选
  Langfuse 承载 Agent Trace/Eval，但不得替代业务 Run Store。
- 最小验收：Trace=Run，span 覆盖 context/model/retrieval/rerank/tool/checkpoint；失败/高风险/回退尾采样；
  Secret/PII 在 export 前脱敏；定义 TTFT、P95/P99、成功率、恢复率、重复副作用率和单成功任务成本告警。

### P1-06 Golden Cases 与 CI 发布门禁

- 状态：`blocked`。
- 目标：从 30-50 条起步，逐步到 100 条；覆盖正常、边界、空结果、权限、Prompt Injection、429、超时、
  SSE 断线、Worker kill、DB failover 和副作用响应丢失。
- 最小验收：同时评分答案、证据、节点轨迹、工具参数、安全、恢复、延迟和成本；模型/Prompt/工具/RAG
  变更自动跑回归；越权和重复高风险副作用必须为 0，失败样本经审核回流。

### P1-07 搜索与抓取关键路径性能

- 状态：`blocked`。
- 建议顺序：`asyncio.as_completed` 先到先用 → 单页分层 timeout → DuckDuckGo 与主 Provider 有界竞速 →
  租户/权限/版本安全的短期缓存。
- 前置限制：`gzip` 曾触发解码故障，必须先复现并写 ADR；`fetch_page` 新建 client 与 SSRF 的已校验 IP/SNI
  绑定有关，keep-alive/HTTP2 不能绕过 DNS 重绑定防护。
- 最小验收：用固定候选和延迟注入证明 TTFT/P95 改善；慢页取消不吞结果；缓存不跨租户/权限；无新增
  SSRF、robots 或来源真实性回归。

### P1-08 PITR、备份恢复演练与 Runbook

- 状态：`blocked`。
- 目标技术：PostgreSQL WAL/PITR + 定期 restore test；对象存储版本/生命周期；若保留 Milvus，使用同版本
  逻辑备份并与 etcd/MinIO 一致恢复；明确 RPO/RTO。
- 最小验收：在隔离环境恢复到指定时间点并跑一致性哨兵；Run/Checkpoint/Event/Tool Ledger 引用完整；
  密钥轮换、Provider 故障、数据库故障、队列积压和回滚均有可执行 Runbook。

## P2：可维护性与规模化

### P2-01 拆分 LangGraph 巨型节点模块

- 状态：`blocked`。
- 当前问题：`services/search-agent/app/graph/nodes.py` 已约 3122 行。
- 目标：按 supervisor/planning/research/reflection/writer/verifier/finalize 拆分；共享状态转换放纯函数；节点
  只做编排，不直接承担 Provider、持久化和协议投影。
- 最小验收：图节点名、事件顺序、Checkpoint 兼容和全量 Golden Cases 不变；单模块职责和依赖方向可审计。

### P2-02 Domain / Application / Ports / Adapters 分层

- 状态：`blocked`。
- 目标：domain 保存业务状态与不变量，application 保存用例/工作流，ports 定义 Model/Search/Tool/Store，
  adapters 承接 DeepSeek、Tavily、PostgreSQL、Milvus/MCP；FastAPI 和 LangGraph 都是外层适配器。
- 最小验收：核心策略测试不启动网络/数据库；替换 Provider 不改业务节点；跨层 import 由静态规则阻止。

### P2-03 ADR 补全与技术债决策

- 状态：`blocked`。
- 至少补：Runtime（LangGraph/Temporal 边界）、Checkpoint 原子性、Model Gateway、Tool Gateway、RAG
  存储（pgvector/Milvus）、身份授权、隐私与观测、HTTP client/SSRF、Redis/Kafka/Kubernetes 引入条件。
- 每份 ADR 必须记录上下文、候选、决策、后果、撤销条件和验证证据，不能只写最终技术名。

### P2-04 文档状态漂移与发布治理

- 状态：`blocked`。
- 当前问题：README、HANDOFF、路线图和真实部署能力会随逐 Issue 开发发生状态漂移。
- 当前依赖基线：2026-08-05 `npm audit --omit=dev` 报告 Next.js 内嵌 `postcss <= 8.5.22` 的 2 个
  moderate 告警；自动修复要求越过当前版本范围升级 Next 16.3.0，须在独立依赖升级 Issue 中验证，禁止
  在无关功能使用 `audit fix --force`。
- 目标：从代码/配置生成可验证的能力清单和版本矩阵；CI 检查失效链接、过期状态、Schema/Prompt/Graph
  版本与迁移记录；发布生成 SBOM、镜像签名、变更清单和回滚说明。

## 后续模型接手步骤

1. 先读 `AGENTS.md`、`HANDOFF.md`、本清单顶部和最后一个 `docs/development/` 记录。
2. 核对上一 Issue 是否已明确验收，或是否存在用户授予的自主验收授权；同时核对 PR 是否合并、Issue 是否
   关闭。没有验收/授权或缺少 DoD 证据时只做收口，不开下一项。
3. 从本清单取第一个非 `accepted` 且前置已满足的条目，先建立带 Problem/Goal/Scope/Non-Goals/DoD 的
   GitHub Issue；只有 `Status: ready` 且 `Execution Gate: allowed` 才能改功能代码。
4. 用真实代码和故障注入验证，不因手册列出某组件就直接引入；任何偏离默认技术栈都写 ADR。
5. 默认验证后标为 `awaiting-acceptance` 并停下；仅在已有明确自主验收授权且全部 DoD 有直接证据时，才可
   标为 `accepted`、完成提交/PR/Issue 闭环并继续下一项。
