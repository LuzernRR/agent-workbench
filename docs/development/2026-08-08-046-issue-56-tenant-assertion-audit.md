# 046 · Issue #56 独立租户断言与授权/生命周期审计补强

- 日期：2026-08-08
- Issue：[GitHub #56](https://github.com/LuzernRR/agent-workbench/issues/56)
- 状态：本地 `accepted`、GitHub 交付中；用户已预授权 Codex 在全部新鲜门禁通过后自行验收。旧阶段快照
  已由 17:04 后最终树门禁、最终镜像重建和三类真实 Run 证据替换
- 分支：`codex/issue-56-tenant-assertion-audit`
- 父项：Issue #54 已关闭，PR #55 已合入 `main@314e28da32c37ad97596090240e8c09375e77fec`
- 提交 / PR：`32fdbda` / [GitHub PR #57](https://github.com/LuzernRR/agent-workbench/pull/57)
- merge SHA：**待真实合并后最终回填；不得预填**
- 最终本地证据：Web `573 passed / 31 skipped`；关键聚焦 `89 passed`；专用 PostgreSQL integration
  `31 passed`；Search Agent `647 passed / 1 skipped`；Playwright `17 passed / 3 live-only skipped`；
  全部构建、静态检查、依赖审计、Compose、ACL、health、HTTP 握手与 runtime smoke 通过

## 1. Post-merge 问题

Issue #54 把 tenant 从请求自述字段改为 `wb_visitors` 中的服务端归属，建立每租户配额和第一版
审计表，并让 Search Agent 校验绑定 tenant/run/visitor 的 HMAC。PR #55 合并后复核发现三项必须
单独修正的问题：

1. #54 使用 `WORKBENCH_INTERNAL_TOKEN` 本身作为断言 HMAC key。原威胁模型中的攻击者正是持有
   该 transport token 的内部调用方，因此仍能为任意 tenant/run/visitor 自行签发合法断言。
2. `wb_audit_events` 主要记录 Run admission；资源授权拒绝和 queued/completed/failed/stopped
   生命周期没有形成完整、事务一致、可去重的账本。
3. `HANDOFF.md`、tasks、记录 045 和生产化清单仍把 #54 写成待验收，且曾使用错误的旧表名，
   与 PR #55、Issue #54 和 `main@314e28d` 的权威状态不一致。

本 Issue 是 #54 的 post-merge 修复，不接入企业身份系统，也不把所有未来资源 API 一次性扩入范围。

## 2. Scope 与 Non-Goals

### 2.1 Scope

- Web/Worker 与 Search Agent 使用独立 `WORKBENCH_TENANT_ASSERTION_SECRET`。
- 缺失、过弱或复用 transport token 的密钥在执行前 fail-closed；仅显式 loopback 开发模式豁免。
- 两端继续共享 UTF-8 字节长度前缀的 tenant/run/visitor 载荷、固定向量和常量时间比较。
- 跨主体 project/thread/run/attachment 以及父资源约束下的 memory 操作返回不泄漏存在性的响应，
  并写 denied 审计。
- Run admission、queued lifecycle、completed/failed/stopped terminal、终态 usage 和公开终态事件在
  对应 PostgreSQL 事务中一致提交；回滚不留下伪 usage 或伪生命周期。
- 用复合外键和唯一索引锁定 tenant/visitor/run 归属和每 Run 唯一 lifecycle。
- 补齐已有环境升级、密钥轮换、三服务协调重建、回滚和交接文档。

### 2.2 Non-Goals

- 不接入 OIDC/OAuth2、RBAC、ABAC 或 PostgreSQL RLS。
- 不把近似配额改成精确串行限额。
- 不新增独立公开 memory CRUD API。
- 不改变 stop 和小红书验证端点当前只携带 transport 认证、不携带 tenant 语义的协议。
- 不修改搜索策略、模型提示、前端计时器或 Issue #27 的 GitHub 状态。

## 3. 实现事实

### 3.1 A1-A3：独立租户断言

- `apps/web/src/server/search-agent/tenant-assertion.ts` 从
  `WORKBENCH_TENANT_ASSERTION_SECRET` 读取签名密钥，按 UTF-8 计算至少 32 字节，并拒绝与
  `WORKBENCH_INTERNAL_TOKEN` 相同的配置。
- `services/search-agent/app/main.py` 在 lifespan 启动和请求授权两处执行同一配置门；生产配置缺失时
  服务不能带病执行。
- 载荷不是简单冒号拼接，而是按 tenant、run、visitor 顺序拼成
  `UTF8字节长度:原值`，避免字段边界移位；断言只含 `v1:<sha256-mac>`，不回显作用域。
- Node 使用 `timingSafeEqual`，Python 使用 `hmac.compare_digest`。两端固定同一个 known-answer
  vector，并分别锁定 tenant/run/visitor 篡改和 checkpoint recovery 的同作用域复用。
- 只知道 transport token 的调用方无法计算独立断言；只知道某一合法断言也不能把它换到其他 tenant、
  run 或 visitor。

### 3.2 A4：不枚举资源的授权拒绝审计

- 本地 live handler 对 project、thread、run、attachment 等资源统一使用
  `RESOURCE_NOT_OWNED_OR_MISSING`，外部响应不区分「不存在」与「属于其他主体」。
- 审计行写入 `wb_audit_events`，包含 tenant、visitor、action、`denied` outcome、reason code、
  resource kind/id 与数据库时间；不保存问题、Prompt、Cookie、Token 或 Provider body。
- 不安全或超长的 resource ID 先变为稳定 SHA-256 引用，避免把任意用户内容带入审计字段。
- 当前没有独立公开 memory API。memory 读写删的隔离证据来自拥有它的 visitor/thread/project/run
  谓词和数据库外键；未来若增加 memory endpoint，必须在 endpoint 层重新执行授权和审计，不能仅引用
  本轮父资源测试。
- 若 denied 审计自身不可写，本地 handler 选择 fail-closed 的 503，而不是返回一个没有审计证据的
  假成功拒绝；这是安全优先于可用性的明确取舍。

### 3.3 A5-A6：生命周期、usage 与数据库归属

权威对象和真实名称如下：

| 对象 | 用途 |
|---|---|
| `wb_tenant_quotas` | 每租户 requests/minute、并发 Run、tokens/day、cost/day 上限 |
| `wb_tenant_usage` | 每 Run 唯一的 input/output/total tokens 与 cost 账本 |
| `wb_audit_events` | admission、授权拒绝和 Run lifecycle 审计 |
| `wb_run_terminal_settlements` | Worker 先持久化、后原子消费的不可变终态结算信封 |
| `wb_runs.stop_requested_at` | 持久停止意图，供 Worker、接管和终态竞争读取 |

- allowed admission、Run 插入和 `run.lifecycle/queued` 在同一事务提交；quota denied 没有 Run，
  但其 denied 审计必须成功提交后才映射为 HTTP 429。
- terminal Run 状态、`wb_tenant_usage`、`run.lifecycle` terminal 审计、公开 terminal AgentEvent 和
  可选成功记忆共享终态事务；事务任一步失败则全部不可见。
- Search Agent 没有 checkpoint boundary 的 direct `run.failed` / `run.stopped` 先经过严格流序、唯一终态、
  usage、`runId`、`toolCallId` 与投影校验，再以 canonical hash 写入 `wb_run_terminal_settlements`。stage 成功不等于
  业务已结算；Worker 随后在 PostgreSQL 事务中 consume settlement，原子提交 Run、事件、outbox、usage、
  lifecycle audit 与可选记忆。
- 没有 checkpoint boundary 的 direct `run.completed` 明确 fail-closed；completed 只能由 checkpoint batch
  事务提交，不能借 settlement 绕过 checkpoint authority。
- settlement 行由 trigger 保护为 immutable。相同 canonical hash 的重复 stage 幂等；不同 hash 明确冲突；
  owner + epoch fencing 阻止旧 Worker 释放、消费或覆盖新接管者的结算。usage/audit 故障会回滚所有业务投影，
  但保留 pending stage，供下一 epoch 接管重试。
- settlement Schema 强制 pending 行的 `settled_status IS NULL`；source 为 stopped 时只能结算 stopped，
  source 为 failed 时允许 failed，或在真实 stop intent 赢得竞态时结算 stopped。迁移会移除旧约束、修复
  legacy 状态并幂等重建这些组合约束。
- `claimNextLiveRun` 在解析普通输入、连接上游、HTTP stop fallback 或 checkpoint terminal 之前优先消费 pending
  settlement。只要合法 direct terminal 已 stage，就不能再被 generic failed 或零 usage stop fallback 覆盖。
- `wb_audit_events_run_queued_once_idx` 与 `wb_audit_events_run_terminal_once_idx` 分别保证同一
  tenant/run 只有一个 queued 和一个 terminal lifecycle。
- `wb_tenant_usage_visitor_tenant_fk`、`wb_tenant_usage_run_visitor_fk` 与
  `wb_audit_events_visitor_tenant_fk` 阻止把 usage 或审计行绑定到错误 tenant/visitor/run。
- tenant 无法可信解析的孤儿 Run 以 `RUN_TENANT_UNRESOLVED` fail-closed；系统不得为了补审计而编造
  tenant。除此之外，缺少可信 tenant 的 terminal 会被拒绝，避免静默产生未计费完成。

### 3.4 配置升级与轮换

- `config/deploy.env.example` 和 Compose 的 Web、Worker、Search Agent 三端显式要求独立断言密钥。
- 新环境由 `deploy/new-local-env.ps1` 分别生成 transport token 与 assertion secret。
- 旧环境使用：

  ```powershell
  .\deploy\new-local-env.ps1 -UpgradeTenantAssertionSecret
  ```

  合规值保持不变；缺失、过弱或复用 token 时生成新的独立值。脚本不输出任何密钥。
- 文件创建、升级和轮换关闭 ACL 继承，只允许当前 Windows 用户、Administrators 与 SYSTEM；同目录
  临时文件先收紧 ACL，再写密钥。更新使用同卷原子替换，代码包含替换后安全检查失败时的原文件恢复与
  hash/ACL 再验证；本轮自动化直接覆盖成功路径、ACL、临时文件清理和“输出不包含真实 secret”，没有故意
  注入 replace 后 ACL 失败。
- 轮换没有双密钥兼容窗口。`docker compose restart` 不重新读取 env，必须排空/停止 Worker，协调
  `--force-recreate` Search Agent、Web、Worker，并完成真实 Web→Worker→Search Agent smoke 后再恢复入口。

## 4. A1-A8 证据矩阵

| 条件 | 当前直接证据 | 最终状态 |
|---|---|---|
| A1 独立密钥 | Node/Python 仅 transport token 伪造断言的拒绝测试；三端运行时密钥独立且同指纹 | 通过 |
| A2 配置 fail-closed | Web fetch 前拒绝；Search Agent lifespan/request 拒绝；正向 200、缺断言 401 | 通过 |
| A3 协议与恢复 | 两端固定向量、长度前缀、常量时间；tenant/run/visitor 篡改均 403；resume 同作用域可用 | 通过 |
| A4 授权拒绝审计 | handler 单测与真实 PostgreSQL project/thread/run/attachment/父资源 memory 矩阵 | 通过 |
| A5 lifecycle 原子性 | failed/stopped stage→consume、completed checkpoint-only、pending-first、故障回滚、epoch fencing；最终 completed/direct-failed/active-stop smoke 均通过 | 通过 |
| A6 归属约束 | schema 单测、真实 PostgreSQL 错配 usage/audit 拒绝 | 通过 |
| A7 全门禁 | Web 573/31、聚焦 89、integration 31、Search Agent 647/1、Playwright 17/3；构建/审计/Compose/health/diff 全通过 | 通过 |
| A8 文档交接 | HANDOFF、tasks、045 勘误、生产清单、部署文档与本记录已同步本地验收；commit 32fdbda、PR #57 已回填，仅 merge SHA/close/main 待办 | 本地通过 |

## 5. 回滚

### 5.1 合并前

当前 #56 的提交为 `32fdbda`，PR 为 #57，尚无真实 merge SHA。合并前回滚仅丢弃本功能分支的改动，
不修改 `main@314e28d`。

### 5.2 #56 合并后

1. 暂停公网入口，等待 queued/running Run 排空；随后停止 Worker 领取。
2. `git revert <实际 #56 merge SHA>`；占位符只能在真实 merge 后替换。
3. Web、Worker、Search Agent 作为一个单元重建。不得只回滚 Search Agent，否则断言密钥或协议混合会
   fail-closed，并可能把已领取 Run 推入失败/接管路径。
4. 保留 `WORKBENCH_TENANT_ASSERTION_SECRET` 和数据库 expand-only 对象；旧版本忽略额外 env 比删除
   密钥更安全。

回退到 #54 会重新引入「持 transport token 可计算租户断言」的已知安全缺陷，只能作为紧急降级。

### 5.3 继续回滚 #54

先确保 #56 已回退，再执行 `git revert 314e28d`。`wb_visitors.tenant_id`、
`wb_tenant_quotas`、`wb_tenant_usage`、`wb_audit_events`、复合外键和唯一索引默认保留；它们对旧代码
属于可兼容的 expand。任何 DROP/contract 必须另立 migration，先备份并确认没有活动 Run、pending
checkpoint/outbox 或审计保留要求。

### 5.4 撤销一次密钥轮换

不要把旧 secret 粘回 shell 或日志。再次生成一个新的共同 secret，并按维护顺序协调重建三端。因为没有
双密钥窗口，任何新旧组合都应 fail-closed。

## 6. 残余风险与明确边界

1. **取消控制仍是单副本边界**：Compose 为 Search Agent 固定 `container_name`，服务内部
   `RunRegistry` 只知道本进程任务。当前单副本可保证 stop 命中；若取消固定容器名并横向扩容，stop 可能
   落到非拥有副本。扩容前必须引入共享取消注册表、确定性路由或同等机制。
2. **无独立 memory API**：memory 隔离来自父 thread/project/run 和数据库谓词，不代表未来 memory
   endpoint 自动安全。新 API 必须独立审查 action、resource kind、non-enumerating response 和审计事务。
3. **HMAC 无 nonce/expiry**：断言是确定性的，同一 tenant/run/visitor 可永久重放，目的是支持恢复；
   它不能阻止同作用域重放，只能阻止换作用域。泄露后的撤销手段是终结 Run 或协调轮换 secret。
4. **外部后端接缝**：设置 `WORKBENCH_API_ORIGIN` 后，Next proxy 会跳过本地 `handleLive` 授权和
   `wb_audit_events` 写入，只转发服务端派生的 tenant/user header。外部后端必须实现等价授权、配额、
   non-enumerating 错误和 lifecycle audit；在完成契约测试前不能把本轮 A4/A5 结论外推到该模式。
5. **配额是近似护栏**：并发 admission 窗口仍可能超放；租户隔离依赖服务端主体和数据库谓词，不依赖
   计数精确性。
6. **开发豁免**：`SEARCH_AGENT_ALLOW_INSECURE_LOOPBACK=1` 仅限 Web 目标与 Search Agent bind host
   都为 loopback；生产或容器网络不得开启。
7. **未覆盖 tenant 语义的端点**：stop 与小红书验证端点目前只校验 transport token，因为请求不携 tenant；
   若未来增加 tenant-scoped 状态，必须补断言与资源审计。
8. **Windows 运维脚本**：本地 env 帮助脚本依赖 Windows ACL-capable volume；并发变化检测属于
   尽力而为，不是跨进程严格 CAS。生产密钥仍应优先由密钥管理系统分发。
9. **GitHub 治理残余**：[Issue #27](https://github.com/LuzernRR/agent-workbench/issues/27) 当前仍为
   open。仓库已有即时耗时相关实现或历史验收描述不等于 Issue 已闭环，必须单独核对并关闭。
10. **企业身份仍缺失**：匿名 visitor 不能代表企业用户，尚无 OIDC/OAuth2、RBAC/ABAC、RLS、过期用户
    token 和逐工具策略执行面。
11. **非法 direct terminal 的极端退化**：合法且已 stage 的 terminal 绝不会被零 usage fallback 覆盖；但若
    上游返回结构非法、无法 stage 的 direct terminal，Worker 会隔离并等待 lease/接管。若其后只收到 stop 且
    没有任何可验证 usage，仍可能走零 usage stop fallback。应为 `SEARCH_AGENT_INVALID_EVENT` 和长期 pending
    lease 建立告警，不能把非法信封当成成功结算。
12. **集成测试必须使用专用数据库**：`npm run test:integration` 要求显式
    `WORKBENCH_INTEGRATION_DATABASE_URL`；runner 仅接受 loopback PostgreSQL，且数据库名必须以 `_test` 或
    `_integration` 结尾。禁止回退 `WORKBENCH_DATABASE_URL` 或共享业务库；畸形 URL 的错误不得回显密码。
13. **跨语言节点表仍非单源**：Python 已用测试锁定 `NodeName`、`_AGENT_BY_NODE` 与实际 LangGraph 节点集合，
    Web 也锁定当前 12 个 node-agent 配对；但 Web 列表仍手工镜像 Python。未来新增第 13 个节点时必须同步
    BFF 合同，后续可独立评估生成式共享合同，避免再次出现 `SEARCH_AGENT_INVALID_EVENT`。
14. **env 原子回滚缺少故障注入**：`new-local-env.ps1` 的 replace 后失败恢复分支会校验原文件 hash 与 ACL，
    但当前测试没有主动制造该 Windows 文件系统失败；自动化已证明成功替换、幂等升级、轮换、ACL、无 secret
    输出和临时文件清理。若该脚本成为生产密钥主路径，应在独立运维测试中加入可控故障注入。
15. **搜索规划另有稳健性缺口**：最终 stop 验收前，通用 Agent 框架检索请求曾连续触发
    `PLAN_INITIAL_FACET_DUPLICATE` 和 `QUERY_FOLLOW_UP_LINEAGE_REQUIRED`，最终 `toolCalls=0`、partial
    收口。更明确的单主题检索可正常产生真实工具调用并完成本 Issue 的 stop 验收，但通用请求失败必须在
    #56 关闭后另立搜索 Issue 修复，不能把它伪装成本安全 Issue 已解决的内容。

## 7. 最终验证证据与待 GitHub 回填

旧的 Web 552/27、569/30、聚焦 71、integration 27/30 及旧 Run 均不再作为最终证据。最终冻结树结果：

- Web：`573 passed / 31 skipped`；关键 terminal/store/executor/schema/runner 聚焦 `89 passed`；
  TypeScript、ESLint、Next/Worker build 全部 exit 0。
- PostgreSQL integration：显式 loopback 专用 `agent_workbench_integration`，`31 passed`；runner 拒绝缺失
  专用变量、远程主机、非 `_test`/`_integration` 数据库以及 query/fragment 目标覆盖。
- Search Agent：`647 passed / 1 skipped`；Ruff、compileall 通过。公开 `/v1/graph` 与实际 12 节点一致，
  包含 `plan_fast_search`、`accept_fast_evidence`。
- Playwright：`17 passed / 3 live-only skipped`；“已处理 0 秒”即时首帧位于助手回答左上角，文本与来源按
  可见逐字流式增长。npm audit 为 0 vulnerabilities，pip-audit 无已知漏洞；Compose config、
  `new-local-env` 8 项、Web/Search Agent health、`git diff --check` 均通过。
- 租户断言 HTTP：正确独立断言 200；缺断言 401；错误断言 403；使用 transport token 伪造 HMAC 403；
  tenant/run/visitor 分别篡改均 403；缺 transport token 401。
- completed：`run_4d4a46dfd9034199838cb80807e67868`，`completed/idle`、checkpoint revision 7、
  usage 1 行/3401 tokens、queued/completed audit 各 1、唯一 `run.completed`、终态 outbox 1、pending 0。
- direct failed：`run_3342b99584ef4dbb97bcda830751ff0e`，唯一 source/public terminal 为
  `run.failed` / `CHECKPOINT_NOT_FOUND`，settlement `failed→failed` 已消费，usage/audit/outbox 各 1、
  lease 清除、pending 0。
- active stop：`run_60623f90c32e4012aef9bd71ce1ae726`，真实
  `tool.started(call_search_c23a9ecb057f4ded61e09f1f)` 后 stop 返回 `stopping`；source terminal
  `run.stopped`，公开唯一 `run.cancelled`，settlement `stopped→stopped` 已消费，usage 1 行/2855 tokens、
  queued/stopped audit 各 1、终态 outbox 1、lease/pending 均清零。三类 Run 的两次 SSE 全量重放序号一致。

依据用户此前两次明确要求「验收通过，测试后你自己通过当前验收」，Codex 已将 #56 本地状态设为
`accepted`。

提交 `32fdbda` 与 PR #57 已真实回填。仍只能在真实发生后回填：实际 merge SHA、Issue close、功能分支
处理与本地 `main` 同步结果。若 GitHub/CI 暴露新阻断，必须修复并重新执行受影响门禁。
