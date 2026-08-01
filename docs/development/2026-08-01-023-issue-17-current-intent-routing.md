# Issue #17：当前意图隔离与检索计划预算

## 范围

本 Issue 只修复当前用户意图被旧会话主题覆盖、无需检索的问题仍被强制搜索、计划证据目标与
工具/时间预算不一致，以及案例专属规则污染其他回答的问题。不实现 Evidence 状态机，不修改
Tavily Key、小红书会话、Web 抓取并发或 HarnessRunner。

## 真实复现与根因

截图对应运行 `run_c0e55bd0d19646f19bceacbe092eb30b` 的持久用户输入是“你是谁”。公开事件
和节点状态显示，首轮 Planner 却生成 British Council 与英国大学奖学金计划，之后又搜索
“你是谁 自我介绍”，Writer 最终自称 Writer Agent。

根因不是 run/thread 事件归属串线，而是四个边界共同失效：

1. `config/search-agent.json` 的 `forceSearch=true` 令分类节点跳过真实模型；
2. Supervisor Prompt 规定所有任务都必须搜索；
3. Planner 与 Direct Writer 总会收到完整历史，当前短问题无法隔离旧主题；
4. Writer/Verifier 通用 Prompt 内写入了防晒案例的字段与医疗免责声明规则，其他任务也可能
   误用。

原 Planner 还允许一次生成四个步骤和每步最多八条证据目标，既可能超过单次正文容量，也会在
150 秒运行预算后段创建必然因 `RUN_TIME_RESERVE` 失败的新计划。依赖步骤因上游无正文不可达时，
运行时会误报 `PLAN_NO_RUNNABLE_STEP`。

## 修改

### 当前意图成为唯一权威任务

- 关闭 `forceSearch`，每轮由真实 structured Supervisor 判断 `need_search` 与 `channels`；
- `IntentResult` 新增必填 `use_history`。只有当前消息存在必须依赖历史才能理解的明确指代时为
  true；独立消息为 false；
- Supervisor 输入把历史标为低优先级，并把当前消息放在最后明确标记为唯一权威任务；
- Direct Writer 在 `use_history=false` 时只收到当前问题，不再收到旧会话正文；
- 身份回答由 Writer 模型实时生成。代码没有“你是谁”的固定答案、关键词路由或前端模板。

### 可执行的计划预算与终止语义

- 每轮最多两个高区分度步骤，剩余工具调用留给真实 Evidence 缺口的下一轮；
- `build_plan_snapshot` 校验 `max_steps`、单步正文容量和总 Evidence 容量，稳定错误分别为
  `PLAN_TOOL_BUDGET_EXCEEDED`、`PLAN_EVIDENCE_TARGET_EXCEEDS_CALL_CAPACITY` 和
  `PLAN_EVIDENCE_BUDGET_EXCEEDED`；
- 首份模型计划仅在预算错误且剩余模型额度足够时允许一次真实 Planner 修复；被拒计划不产生
  `plan.updated`；
- 上游 blocked 会确定性传播为 `PLAN_DEPENDENCY_BLOCKED` 并进入 Reflector，不把没有剩余 todo
  的计划误判为图死锁；
- 工具成功且取得至少一条正文时，计划步骤为 done；正文数量低于目标属于 Evidence 覆盖问题，
  不再把真实成功工具调用标成计划错误。零正文且目标大于零时仍 fail-closed；
- 重规划需要额外保留 Planner 延迟与最终写作/核验窗口。剩余时间不足时停止扩展计划并基于已有
  Evidence 诚实 partial，不生成必然全部 blocked 的下一份计划。

### 领域中立输出契约

通用 Reflector、Writer 和 Verifier 不再包含任何防晒、肤质、不适人群、个人体验或医疗建议
案例文本。用户明确指定的条目范围、斜杠分隔字段、字段顺序、来源引用与领域安全边界由当前
问题确定性提取后交给模型；未提出的约束不会迁移到其他任务。地域、时间、资格、开放状态等硬
筛选条件必须由正文直接支持，不满足或无法确认的对象不得作为合格结果。

Prompt 版本升级为 `2026-08-01.v30-domain-neutral-contracts`。

## 测试

- Search Agent：242 passed；Ruff 与 compileall 通过；
- Python 合同：6 passed；
- Web：381 passed、1 skipped；typecheck、lint、production build 通过；
- Playwright：16 passed、3 个真实 live gate skipped；
- `git diff --check` 通过。

新增回归覆盖：

- 旧奖学金历史 + 当前“你是谁”产生 0 工具、0 计划并由模型直接回答；
- `use_history=true` 的真实指代问题仍能把历史交给 Writer；
- strict schema 的 direct/research 交叉字段有效；
- 计划步骤/证据预算超限和一次模型修复；
- blocked 依赖传播后进入 Reflector而非误报死锁；
- 成功取得部分正文的步骤为 done，零正文仍 blocked；
- 剩余 70 秒时保留收尾窗口，不启动必死的第二轮计划；
- 通用 Agent Prompt 不含小红书防晒案例专属规则。

## 生产回归

### 直接问题

`run_issue17_direct_v30_1785582433089` 使用真实 DeepSeek structured Supervisor 与 Writer，
并带有上一轮英国奖学金历史：

- 3.593 秒完成；
- `answerSource=model`，回答只说明当前产品 AI 助手身份；
- `DIRECT_COMPLETED`；
- 0 plan event、0 tool call、0 node.failed；
- 未提及奖学金或 Writer Agent；
- 公开 NDJSON 禁止字段扫描为 0。

### 首页奖学金案例

`run_issue17_scholarship_final2_1785582623189` 使用首页原始案例提示词：

- 103.334 秒，真实执行两个 Web 工具调用；
- 第一调用 75.055 秒成功、返回 5 个候选和 1 条正文 Evidence，对应计划步骤为 done；
- 第二调用在 84.501 秒触发 `RUN_TIME_RESERVE`，对应步骤 blocked；
- 最终为诚实 `partial`，没有把未完成核验伪报为 completed；
- 回答不含防晒、肤质、个人体验或医疗建议等跨领域文本；
- 0 node.failed，公开 NDJSON 禁止字段扫描为 0。

该结果证明当前意图修复没有关闭真实搜索，并精确暴露 Web 正文读取仍有 60–85 秒慢路径。该工具
性能问题将作为下一独立 Issue 优化，本 Issue 不通过增大超时或伪造完成状态掩盖。

## 部署与回滚

- 回滚镜像：`agent-workbench/search-agent:pre-issue-17-e9edb65`；
- 只滚动替换 Search Agent；PostgreSQL、Milvus、Web、小红书工具会话和用户数据未修改；
- Compose 七服务 healthy；3000、8080 和
  [https://luzern.cc.cd/workbench](https://luzern.cc.cd/workbench) 均返回 200；
- 回滚只切回上述 Search Agent 镜像，不删除 checkpoint、tool ledger、Evidence 或会话数据。
