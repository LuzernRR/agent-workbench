# Issue #52：查询理解与证据缺口驱动的迭代检索

日期：2026-08-07

状态：已验收合并。用户于 2026-08-07 明确回复「验收通过，合并并关闭 #52」，PR
[#53](https://github.com/LuzernRR/agent-workbench/pull/53) 已 squash 合入 `main`（`0ce59e6`），Issue #52 以
`completed` 关闭，功能分支已删除。回滚为 `git revert 0ce59e6`，执行前先停止 Worker 领取。

Issue：[搜索质量：查询理解、关键词拆解与证据缺口驱动的迭代检索](https://github.com/LuzernRR/agent-workbench/issues/52)

分支：`codex/issue-52-query-strategy`

执行门：`Execution Gate: allowed`

## 用户授权与目标

用户要求把自然语言搜索要求翻译成平台可执行关键词，持续根据真实结果迭代，使后续查询更精准；并在测试
通过后由 Codex 自主完成验收、交接、发布和 Issue 关闭。当前只推进 Issue #52，没有并行功能。

本项解决五个问题：查询要求没有结构化真值、Planner 缺少关键词/分面/谱系、补搜缺少 typed 缺口、近重复
查询浪费预算、以及离线质量没有查询维度指标。实现仍复用一条 Supervisor → Planner → Researcher →
Reflector → Writer → Verifier LangGraph，不新增 Provider 或第二套运行循环。

## 采用的查询策略

### 从用户要求到平台输入

```text
用户问题
  -> Supervisor: QueryBrief（实体、must/should/exclude、日期、地域、平台、字段）
  -> Planner: 1-2 个互补 facet 的 queryTerms + 渠道语法
  -> deterministic gate: 硬约束、预算、重复、谱系
  -> Researcher: 只执行已批准 query+channel
  -> Reflector/Verifier: result/evidence/来源域/限制 -> typed EvidenceGap
  -> Planner: gap-bound rewrite + parentAttemptId
  -> 新 Evidence/约束覆盖 -> gap closure 或 no-progress stop
```

`QueryBrief` 是私有规范化语义，不是用户文本复制品。`must`、绝对时间、地域、必需渠道和 `exclude` 永远
不能静默删除；只有显式记录的 `should` 可以由 `broaden_should` 放宽。查询词只从简报和模型提案产生，服务端
不靠固定领域词典猜测用户意图。

渠道规则分别执行：web 允许权威域、短语和 `after/before`；X 允许账号、话题及 `since/until` 等已登记
操作符；小红书保持紧凑自然关键词并拒绝布尔排除/跨渠道操作符。指定平台的 web fallback 必须保留
`site:x.com`、`site:xiaohongshu.com` 或明确平台标记，不能把补充网页冒充指定平台证据。

首轮最多两个不同分面，按计划整体覆盖全部 `should`，不要求每个 query 重复所有可选词。每个真实调用产生
一个稳定 `SearchAttempt`，记录 `attemptId`、`facetId`、`gapId`、`parentAttemptId`、策略、查询、渠道、
候选/正文/来源域计数、硬约束增益和 `progress`。只有新增候选、新正文或新硬约束覆盖算进展。

普通 follow-up 必须从同一 facet 的最新真实尝试继续。Reflector 首次发现尚未执行的分面时，服务端将 gap
标记为 `origin=facet_discovery`；仅在该 facet 没有任何历史尝试时允许绑定全局最新真实父尝试。旧 checkpoint
或无 origin 的 gap 仍拒绝 `QUERY_PARENT_ATTEMPT_FACET_MISMATCH`。这个例外让新分面有可审计的上下文，又不把
所有跨 facet 查询变成合法 lineage。

### 研究过的方案与决策

| 来源/方案 | 结论 | 取舍 |
|---|---|---|
| [ReAct](https://arxiv.org/abs/2210.03629)、[IRCoT](https://arxiv.org/abs/2212.10509) | 采用其“检索—观察—再检索”思路 | 由现有 LangGraph 节点承载，不新增自由循环 |
| [Self-Ask](https://arxiv.org/abs/2210.03350)、[Step-Back](https://arxiv.org/abs/2310.06117) | 采用问题分面和抽象证据方向 | 分面数量由首轮 2 步和工具预算硬限制 |
| [CRAG](https://arxiv.org/abs/2401.15884)、Adaptive-RAG | 采用证据质量评估与按需深度路由 | 用 typed EvidenceGap 和已有 Reflector/Verifier 实现 |
| [FLARE](https://arxiv.org/abs/2305.06983) | 只采用“证据不足时触发检索”的思想 | 不做 token 级置信度触发，避免不可审计成本 |
| [Query2doc](https://arxiv.org/abs/2303.07678) | 拒绝默认伪文档扩展 | 伪文档可能把模型臆测注入查询；查询词必须来自简报/反馈 |
| RAG-Fusion/RRF | 拒绝作为本 Issue 依赖 | 需要额外 reranker/融合预算；本项先证明查询增益 |
| Search-R1 | 拒绝训练型架构 | 需要 RL、检索环境和新发布链路，超出可回滚范围 |
| [Tavily Search API](https://docs.tavily.com/documentation/api-reference/search)、[X Search](https://developer.x.com/en/docs/x-api/posts/search/integrating)、[LangGraph persistence](https://langchain-ai.github.io/langgraph/concepts/persistence/) | 作为渠道语法、只读搜索和 checkpoint 依据 | 现有 Provider/Tool Ledger/Checkpoint 保持不变 |

## 实现清单

- `services/search-agent/app/graph/query_strategy.py`：严格 QueryBrief、约束签名、日期 schema、渠道门禁、
  near-duplicate、gap reconciliation、lineage repair。
- `services/search-agent/app/graph/schemas.py`、`state.py`、`plan.py`：结构化计划、SearchAttempt、
  EvidenceGap 和恢复字段。
- `services/search-agent/app/graph/nodes.py`：Planner/Reflector/Verifier 反馈压缩、幂等 merge、增益统计、
  fallback gap 和隐私边界。
- `services/search-agent/app/prompts/agents.py`：版本 `2026-08-07.v45-query-strategy-live`，明确
  首轮 should 整体覆盖、gap 策略、facet discovery 父规则和公开摘要限制。
- `services/search-agent/app/llm/deepseek.py`：`ProviderIsoDate` 将 Python `date` 在运行时保留为日期，
  对 Provider 暴露为严格 `YYYY-MM-DD` 字符串 pattern；同时拒绝 Provider 不支持的字符串 `format`。
- `services/search-agent/evaluation/` 与 `tests/fixtures/query-quality-matrix.json`：五维离线指标和 13 个
  固定行为场景。

### 真实故障与修复

首次 DeepSeek live 请求被 Provider 拒绝，错误为结构化请求 schema 不支持 `format: date`。根因是 Pydantic
默认把 `datetime.date` 输出为带 format 的 JSON Schema，而当前 Provider strict schema 只接受字符串 pattern。
修复为 `Annotated[date, WithJsonSchema({"type":"string","pattern":"^\\d{4}-\\d{2}-\\d{2}$"})]`，
并在 `validate_strict_schema` 拒绝其他未知 string format。随后真实请求成功调用 Tavily 并读到 Evidence。

另一个 live 问题是 Reflector 为未执行分面创建 gap，但 Planner 只会找同分面父尝试；新增受限
`facet_discovery` lineage 规则和无历史尝试时的 fail-closed guard，避免跨分面 mismatch 误放行或空历史崩溃。

## A1-A12 验收证据

| 标准 | 直接证据 |
|---|---|
| A1 | `test_query_strategy.py`、`test_strict_schema_compatibility.py`：严格字段、控制字符、内部指令、日期、旧状态归一和未知字段拒绝。 |
| A2 | QueryBrief/Planner 图测试覆盖中英文、版本、相对日期、地域、渠道、数量/字段和排除；`test_graph_runtime.py` 锁定 direct/single-fact 边界。 |
| A3 | `test_structured_plan.py`、图运行测试：步骤字段齐全、首轮最多 2 个不同 facet、整体 should 覆盖、预算门禁与稳定 attempt ID。 |
| A4 | `test_query_strategy.py` 与渠道测试：web/X/xiaohongshu 操作符边界、短自然词和平台 fallback。 |
| A5 | 硬约束、日期、地域、exclude、required channel、should relaxation 的确定性 gate；不合法模型计划拒绝或只做受控加法修复。 |
| A6 | `test_research_fanout.py`、`test_graph_runtime.py`、checkpoint/ledger 测试：真实 toolCallId、幂等 merge、候选/正文/域/增益、恢复不重放。 |
| A7 | typed `EvidenceGap` schema、策略矩阵和图级 zero-result/unreadable/conflict/missing-channel/missing-field 测试。 |
| A8 | near-duplicate、progress/no-progress 和 gap closure 测试；互补 facet 不因词面相似误拒。 |
| A9 | `test_prompts_and_events.py`、私有分析序列化扫描、OTel span 检查；公开事件不含 QueryBrief/gap/query terms/provider body。 |
| A10 | 固定矩阵 13 场景；`test_query_strategy.py` 59 tests，图运行覆盖第二轮 gap 绑定并获得新 Evidence。 |
| A11 | 固定 fixture 五维指标：hard retention 100%、facet coverage 100%、duplicate execution 0%、预期 gap closure 100%、Evidence gain 正值；评测相关 85 tests 通过。 |
| A12 | Search Agent 全量 625 passed / 1 skipped、Ruff、compileall；真实 Web Provider checkpoint smoke、健康检查和 Web 全量门禁；生产依赖 high/critical、Compose 与 diff check 通过。 |

## 真实运行态 smoke

镜像：`agent-workbench/search-agent:local`，端点 `http://127.0.0.1:8080/health` 返回 `status=ok`，
checkpoint=`postgres`、provider=`tavily`、Milvus 可用。

### Run 1：两分面反馈闭环

- Run ID：`live52_934ac47826494f45b155`
- 公开流：167 events、19 checkpoints、4 tool calls、11 Evidence；终态 `run.completed`，因模型预算为 partial。
- 首轮 facet：`official_changes`、`dev_community`；后续两个 gap 各绑定同 facet 父尝试。
- 每次 attempt 的新增 Evidence：2、4、3、2；两个 gap 均 `closed`，`resolved_by_attempt_id` 指向对应补搜。

### Run 2：四分面与 facet discovery

- Run ID：`live52d_c7846531325644929e1a`
- 公开流：149 events、17 checkpoints、4 tool calls、11 Evidence；终态因 `TOOL_CALL_LIMIT` 为 partial。
- 首轮只执行 `langgraph`、`autogen`；`crewai` 和 `openai_agents_sdk` gap 均为 `origin=facet_discovery`。
- `crewai` gap 绑定 `attempt_430b...`，新增 3 条 Evidence 后 closed；`openai_agents_sdk` gap 绑定
  `attempt_a344...`，新增 2 条 Evidence 后 closed。其余 open gaps 因硬预算保留 open，系统没有伪造充分结论。

两次运行均通过最后 `checkpoint.committed` 的完整引用读取同一 PostgreSQL 状态；公开事件只包含安全节点/工具
统计，私有 QueryBrief、完整查询词和 gap 描述只在 checkpoint 状态中可见。

### Run 3：发布前真实 Web Provider 回归（最新镜像）

- Run ID：`issue52accept_3d56d8258084`；耗时 68.917 秒；终态 `run.completed`，停止原因为硬迭代预算
  `MAX_ITERATIONS`，没有伪造“所有分面已充分覆盖”。
- 首轮实际执行 1 个 `web` 查询（`facet_langgraph`）；结果反馈后生成两个 `facet_discovery` 缺口，后续两次
  `source_targeting` 查询分别绑定真实 `parentAttemptId`，新增 Evidence 为 2 和 1，两个
  `missing_channel` gap 均闭合。共 3 个 tool call、9 次模型调用、5 条 Evidence、2 条最终 citation。
- 公开 NDJSON 共 110 个事件；扫描 `queryBrief`、`constraint_signature`、完整 QueryBrief、Provider body、
  `reasoning_content`、`authorization`、`apiKey` 和 Cookie 等私有字段，命中为空。私有 `search_attempts`、
  `evidence_gaps` 和增益只通过最后 PostgreSQL checkpoint 读取。
- 前端在生产 3000 端口的最早占位帧于请求返回前显示 `已处理 0 秒`；元素首子节点为
  `data-assistant-response-run-id`，不属于用户消息。桌面证据图：
  `docs/development/evidence/2026-08-07-issue-52-elapsed-live-pending-desktop.png`；回答流式状态的桌面与
  移动截图：`docs/development/evidence/2026-08-07-issue-52-elapsed-{desktop,mobile}.png`。

## 测试与发布门禁

已通过（发布前最终复跑，2026-08-07）：

```text
services/search-agent: 625 passed, 1 skipped
apps/web: 438 passed, 10 skipped; typecheck, lint, build
Playwright: 17 passed, 3 live-only skipped
production npm audit --omit=dev --audit-level=high: no high/critical（仅 2 个 moderate：next -> postcss）
Python pip-audit: No known vulnerabilities found
Ruff: All checks passed
compileall: passed
health: 127.0.0.1:3000 与 127.0.0.1:8080 均为 status=ok
Compose config --quiet: passed with config/deploy.local.env
git diff --check: clean
```

`pip-audit` 未安装在 `services/search-agent/.venv`（该 venv 也没有 `pip`），因此审计必须通过 uv 的
隔离工具环境执行，并显式指定 3.12 解释器；lock 中的 `numpy==2.5.1` 要求 Python >=3.12，缺省解释器会
以 `No matching distribution` 失败，那是环境问题而不是漏洞：

```powershell
uv export --no-dev --format requirements-txt -o <tmp>\sa-prod-reqs.txt
uvx --python 3.12 pip-audit -r <tmp>\sa-prod-reqs.txt
```

工作树为 CRLF 是 `core.autocrlf=true` 的既有本机状态，`.gitattributes` 的 `* text=auto eol=lf` 使入库
对象仍为 LF；已用 `git hash-object` 复核新增文件入库后 CR 计数为 0，与未改动的基线文件一致。

发布前复跑仓库规定的完整命令：

```powershell
cd apps/web
npm test
npm run typecheck
npm run lint
npm run build
npm run test:e2e
```

并执行 Web/Search Agent 依赖审计、Compose 静态解析、健康检查、`git diff --check`，确认生产依赖无 high/critical
漏洞和未跟踪生成物。开发依赖的新增 advisory 与 Next/PostCSS moderate 已登记到独立依赖治理项，不能在本
Issue 使用越界 `audit fix --force`。最终数字已在上文「发布前最终复跑」记录，并在合并前复核一致。

## 隐私、性能、回滚与非目标

- 私有字段只进入 LangGraph State/checkpoint；公开过程摘要仍由版本化 Agent 输出，前端不自行编造推理。
- **审计遗留（不阻塞本 Issue）**：`facet_discovery` 的父尝试选择规则目前写在三处——`nodes.py` 的 Planner
  提示候选、`query_strategy.complete_query_lineage` 的受控修复、`validate_query_proposal` 的强制判定。
  当前三处语义一致且有测试覆盖，但没有测试把它们锁在一起；若日后只改其中一处，Planner 可能收到一个
  会被 validator 拒绝的候选父尝试。建议后续单独开 Issue 抽出唯一判定函数，不在本轮扩大 diff。
- **隐私边界的强制方式**：`_FORBIDDEN_KEYS` 是键名denylist，并不包含 `queryBrief`/`constraint_signature`
  等本轮新增私有字段；这些字段之所以不外泄，是因为事件构造处从不写入它们，并由
  `test_private_query_strategy_stays_out_of_events_spans_and_logs` 对事件、span 和日志做序列化扫描锁定。
  该测试是回归防线，运行时校验器不会自动拦住未来新增的泄漏字段。
- 查询数量、步数、Evidence、gap 数、模型调用、工具调用和运行时间均有硬上限；无进展达到阈值即停止。
- 不新增 Provider、reranker、向量库、登录绕过、写平台动作、OIDC/RBAC、租户配额或手工关键词编辑 UI。
- 回滚先停止 Worker 领取，再 `git revert 0ce59e6`；数据库新增字段按兼容默认保留，必要时另立 migration。

## 交接与验收结论

实现代码、测试、评测 fixture、任务清单和本记录已同步，全量门禁在交付树上复跑通过。用户于 2026-08-07 明确
回复「验收通过，合并并关闭 #52」；PR #53 已 squash 合入 `main`（`0ce59e6`），Issue #52 以 `completed` 关闭，
`codex/issue-52-query-strategy` 已删除，本地 `main` 已同步。

单 Issue 门禁随之解锁。下一项功能必须先创建独立 Issue 并写明 Problem/Goal/Scope/Non-Goals/DoD，置
`Status: ready` 与 `Execution Gate: allowed` 后才能编辑功能代码。已登记的首选候选是收敛上文「审计遗留」中
`facet_discovery` 父尝试规则的三处实现。
