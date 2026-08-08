# 047 · Issue #58 搜索计划错误修复与确定性 fallback

## 状态

- Issue：[#58](https://github.com/LuzernRR/agent-workbench/issues/58)
- 分支：`codex/issue-58-query-plan-fallback`
- 门禁：`Status: ready`、`Execution Gate: allowed`
- 当前：`accepted`
- 用户授权：已确认实现方案，并授权 Codex 在最终测试后自主验收；该授权不替代 A1-A8 证据。
- 本地验收：A1-A8 的代码、测试、运行态与安全证据已通过。
- GitHub 闭环：PR #59 已 squash 合并，Issue #58 已关闭，本地 main 已同步。

## 问题与真实证据

#56 运行态验收暴露两个通用 Agent-framework 搜索 Run：

- `run_278120d58722490b883333c9b5f8ce0d`
- `run_d0d13d42b61e4c35824ae51689a697da`

它们都在 Provider 调用前先触发 `PLAN_INITIAL_FACET_DUPLICATE`，随后在没有任何真实
`SearchAttempt` 的状态下把 gap 当作 follow-up，再触发 `QUERY_FOLLOW_UP_LINEAGE_REQUIRED`。最终
`toolCalls=0`、partial。根因是“模型计划不合法后的恢复链”缺失，不是 Tavily 或其他搜索 Provider 不可用。

## 实现

### 一次私有错误感知修复

`plan_validation_feedback()` 把稳定错误映射为受限的私有反馈：

- `errorCode`
- `fieldPath`
- 最多 240 字的校验消息
- 结构化 `rejectedPlan`

Planner 只允许再生成一次，且仍收到当前 QueryBrief、hardConstraintIds、真实 SearchAttempt、open
EvidenceGap、预算和当前用户消息。反馈不进入 AgentEvent、公开过程文本或普通日志。

### 确定性最小 fallback

第二份模型计划仍非法时，运行时生成最小步骤，再交回现有 `build_plan_snapshot()` 与
`validate_query_proposal()`：

- initial：最多两个不同 facet；按 QueryBrief required channel 与 Supervisor 授权渠道稳定排序；
- follow-up：只处理 open gap，必须绑定真实同 facet parent attempt；`facet_discovery` 仅保留既有窄例外；
- 约束：must、exclude、绝对日期、地域、required channel 和 constraint signature 不得丢失；should 只能用
  `broaden_should` 明确放宽；
- 查询：加入证据类型、请求字段和语言线索；Web/X/小红书分别通过渠道语法门；
- X：双语要求按 attempt 分配单个 `lang:`，避免 `lang:zh lang:en` 的不可能交集；
- 小红书：保持 80 字以内自然关键词，不注入 Web/X operator 或布尔排除；
- follow-up：按 no-results、不可读正文、缺声明、缺约束、缺渠道、冲突、缺字段选择枚举策略；
- 去重：既有 exact/near-duplicate、attempt identity、预算和 no-progress 门继续生效。

Planner 生成了新字符串不等于搜索有进展，因此 `plan_research` 不再清零 `no_progress_count`。只有
SearchAttempt 带来新候选、新 Evidence 或新约束覆盖才会重置。旧 checkpoint 若只有 gap 而没有真实
SearchAttempt，则按 initial 恢复，不伪造 parent lineage。

### 已批准计划的执行编译边界

重建后的首个 Run `run_5617c38ab51e48fa944e97e6c639a5c7` 进一步暴露：Planner 已生成两个合法、
不同 facet 的首轮步骤并进入 running，但 `_normalized_search_request()` 在 fan-out 前把计划整体分摊的
`should` 约束错误地按每个单请求重新要求完整覆盖，结果两个请求都返回无效，`merge_research` 显示
`branches=0 executed_searches=0`。

修复后，只有同时满足以下条件的请求才能沿用首轮计划的整体 should accounting：

- 与当前或历史 iteration=1 PlanStep 的 query/channel/attempt/facet/lineage/constraint 字段逐项相等；
- 当前执行请求绑定 running step 与 `pending_plan_step_ids`；
- 该计划所有步骤的 retained should 并集完整覆盖 QueryBrief.should。

缺 plan 绑定、字段漂移、重复身份、渠道越权或伪造 checkpoint 仍回到单请求完整复核并 fail closed。新增 TDD
用例先稳定复现 `2 selected / 0 branches`，修复后编译为两个独立 research branch。

### 可观察性

私有 state 新增：

- `plan_source: model | runtime`
- `plan_repair_count`
- `plan_fallback_count`

公开 `plan.updated` 只投影 `planSource` 与已允许的 public plan fields；`rejectedPlan`、fieldPath、QueryBrief、
constraint signature、gap 描述等保持私有。预算不足时保留稳定 `MODEL_CALL_LIMIT`，不会为了满足“至少一次
工具调用”透支最终化预算。

## 离线矩阵与当前证据

新增/更新的测试覆盖：

1. 同一 QueryBrief 的 deterministic output 稳定，首轮 facet/query 不重复；
2. Agent framework 的官方文档与 primary/academic 两类来源提示；
3. X 近 90 天 `since:`/`until:` 与单一语言 operator；
4. 小红书自然关键词、长度与 operator/exclude 边界；
5. no-results + should → `broaden_should`；
6. conflicting sources → `conflict_resolution`；
7. 真实 parent/gap/signature 与新 attempt/query；
8. 双重非法 Planner → runtime fallback → 真实 `tool.started`；
9. 最终化模型预算不足 → `MODEL_CALL_LIMIT` 且不执行工具；
10. 奖学金的日期、地域、申请资格和截止字段；
11. 排除词按词边界匹配，不因内部子串误删 source-tier cue；
12. 无 entities/must 时仍保留 objective topic cue，小红书使用中文来源层级；
13. Planner 越权 Web 时只在 Supervisor 授权的小红书渠道 fallback；
14. no-progress 不被计划改写清零；
15. 旧 checkpoint 无 SearchAttempt 时不伪造 follow-up lineage；
16. 首轮两个互补 PlanStep 分摊 should 时均可编译执行，伪造/未绑定请求仍拒绝。

当前实现树已经取得：

- Search Agent 聚焦：`200 passed`
- Search Agent 全量：`665 passed / 1 skipped`
- Ruff：通过
- compileall：通过
- `git diff --check`：通过

Web 与发布门禁：

- Vitest：`573 passed / 31 skipped`
- 专用 loopback PostgreSQL integration：`31 passed`
- TypeScript、ESLint、Next/Worker build：通过
- Playwright：最终完整复跑 `17 passed / 3 live-only skipped`；首轮滚动时序用例失败一次，随后聚焦 `1 passed`
  且完整套件全绿，没有隐去中间失败
- npm audit：`0 vulnerabilities`；pip-audit：`No known vulnerabilities found`
- Compose config：通过；本地 secret/ACL 脚本 8 项全 true
- Web/Search Agent health：`ok`；`git diff --check`：通过

### 真实 `forceSearch=false` 验收

最终运行 `run_f1b24daa53f34ba2af4a7fe2752fa6d4` 使用 Issue A6 的通用 Agent-framework 请求：

- 唯一终态 `run.completed`，公开事件 127 条，敏感字段扫描 0；
- 4 个 `tool.started`/4 个非空 toolCallId，全部有 `tool.completed` 和工具结果账本；
- 首轮 2 个不同 facet，后续 2 个 `source_targeting` attempt 均绑定各自真实 parentAttemptId/open gap；
- 4 条 SearchAttempt 全部 `progress=true`，20 results、10 次正文读取、9 条 Evidence、5 条 Citation；
- usage 48,749 tokens；127 条 outbox 全发布；pending settlement=0；lease owner/expiry 清空；
- 因 `TOOL_CALL_LIMIT` 以有来源的 partial 收口，符合 A6 允许的 completed/partial，不再出现 planner 拒绝后的
  `toolCalls=0` partial。

## 已批准的后续：搜索经验方案 A

用户已批准方案 A，但单 Issue 门禁要求 #58 合并关闭后才创建下一 Issue、修改经验功能代码。

### 研究依据

- [Microsoft Search Task Trails](https://www.microsoft.com/en-us/research/publication/evaluating-the-effectiveness-of-search-task-trails/)
  支持以完整任务轨迹而非孤立 query 学习后续路径。
- [MemSearcher](https://aclanthology.org/2026.findings-acl.736/) 与
  [MapAgent](https://arxiv.org/abs/2507.21953) 支持检索紧凑、相关的搜索记忆/轨迹，而不是重放全部历史。
- [HotNets 2024 cache freshness](https://conferences.sigcomm.org/hotnets/2024/papers/hotnets24-21.pdf)
  支持为复用项保存 provenance、observed time 与明确失效规则。
- [LangGraph persistence reference](https://reference.langchain.com/python/langgraph/overview) 给出 checkpoint/store
  集成能力，但 SearchExperience 的领域合同、ACL、版本与生命周期仍由本项目定义。
- [Similar search sessions](https://ojs.aaai.org/index.php/AAAI/article/view/25607) 支持先按任务/会话相似性粗召回，
  再做细粒度排序。

### 下一 Issue 计划

1. 只从 verify-passed 的终态写 `SearchExperience`；failed/stopped/unverified 不写。
2. 记录 QueryBrief/constraint fingerprint、facet/channel/strategy、query fingerprint、SearchAttempt 客观增益、
   EvidenceGap 闭合、source provenance/hash/capturedAt、freshness、版本、成本和延迟；不存 Provider body。
3. tenant/project/ACL 隔离召回：硬签名 → facet/channel/source tier → semantic similarity → freshness/provenance →
   verified reward。
4. 只把压缩策略/关键词提示送给 Planner；所有历史来源必须重新搜索、重新读正文、重新变成本轮 Evidence。
5. 先做 deterministic ranking 与 offline replay；记录 contextual-bandit features/reward，但第一阶段不做在线探索。
6. Golden replay 比较硬约束保持、duplicate rate、time-to-first-Evidence、gap closure、引用支持、工具数、成本与
   延迟；cold/no-match/stale-only 必须等价于 #58 baseline。

## 回滚

#58 合并后回滚时先停止 Worker 领取，再 revert 实际 merge commit，并协调重建 Search Agent、Worker、Web。
新增 state 字段有稳定默认值，可兼容旧 checkpoint。确定性 fallback 不改数据库 schema；若关闭功能，应恢复到
“模型计划 + fail-closed”路径，同时保留原 QueryBrief/SearchAttempt/EvidenceGap 数据。

## 最终回填占位

- 最终 Search Agent：聚焦 `200`、全量 `665/1`、Ruff/compileall/diff 通过
- Web/Playwright/审计/Compose/health：通过，数字见上文
- 真实 `forceSearch=false` Run：`run_f1b24daa53f34ba2af4a7fe2752fa6d4`，4 个 toolCallId/attempt，唯一 completed
- commit：待执行
- PR：[#59](https://github.com/LuzernRR/agent-workbench/pull/59)，已合并
- merge SHA：`6b7c83cef7439744deac677decf6aca7fc60e474`
- Issue #58 close/main sync：完成
