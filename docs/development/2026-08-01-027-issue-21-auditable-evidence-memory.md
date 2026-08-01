# Issue #21：已核验证据长期记忆

## 范围与验收边界

本 Issue 只贯通生产 Search Agent 的已核验证据长期记忆：稳定 `memoryRef`、Evidence provenance、
visitor/project 隔离、独立召回候选、公开事件、BFF/replay 和 Workbench 状态。用户偏好、项目会话
全文管理、Claim 图、LangSmith 与评测继续作为后续独立 feature。

验收要求不是“Milvus 能写入”这一条，而是同时证明：

1. 只有 `VERIFIED` 且最终 `cited` 的 Evidence 可写；
2. 同项目后续搜索能召回稳定引用，但仍重新调用工具读取本轮证据；
3. 不同 visitor/project 召回为 0；
4. 记忆正文不进入公开事件、会话历史、本轮 Evidence/Citation、Writer 或 Verifier；
5. 记忆故障只产生结构化降级，不破坏主回答。

## 旧实现的问题

- Milvus 主键只基于 scope、URL 与 embedding 版本，缺少 `evidenceId/contentHash/sourceRunId` 等
  provenance，无法可靠关联 Evidence 生命周期，也无法区分同 URL 的正文变化。
- `load_context` 在意图识别前召回，并把标题、URL 和正文整体追加到 `conversation_context`。直接问
  “你是谁”一类问题也可能访问记忆，后续 Writer/Verifier 还能把历史正文误当当前事实。
- 旧 `memory.status` 只报告粗粒度可用、召回数或写入数，没有稳定 `memoryRef/evidenceId`；BFF 与
  Reducer 无法审计、幂等归并或证明刷新后的同一性。
- mock 运行器仍把 recalled/extracted 文本数组放进公开 `memory.updated`，与真实生产合同分叉。

## 实现

### 稳定身份与严格记录

`services/search-agent/app/memory/milvus_store.py` 新增服务端 `memory_identity()`：

```text
SHA-256(tenantId, visitorId, projectId, evidenceId, contentHash, embeddingVersion)
```

公开引用使用 `memory_<40 hex>`；重复写入使用同一主键 upsert。写入前必须满足：

- Evidence 状态为 `cited`；
- tenant/visitor/project、`evidenceId/sourceId/sourceRunId` 均符合安全 ID 约束；
- `contentHash` 是 64 位 SHA-256；
- URL 是不含凭据的 HTTP(S) 公网来源格式；
- `capturedAt` 与正文存在。

Milvus 记录包含严格 scope、`memory_type=verified_evidence`、`status=active`、embedding 版本与完整
Evidence provenance。召回使用 tenant、visitor、project、ACL、type、status、embeddingVersion 的
组合过滤；缺少 provenance 的升级前记录和损坏记录直接跳过。

### 独立召回候选

`SearchState` 新增 `memory_candidates` 与 `memory_recall_status`。`load_context` 只保留当前消息与原始
会话上下文，不访问 Milvus。只有 Supervisor 已决定 `need_search=true`、并且 Planner 仍有预算时，
`plan_research` 才调用 `_recall_memory_candidates()`。

Planner 最多收到四条带 `memoryRef/title/url/capturedAt/textCue` 的线索，并被明确约束：这些内容可能
过期，只能用于形成新的检索，不得作为本轮 Evidence、Citation 或最终事实。候选保存在独立
checkpoint 字段，不拼入 `conversation_context/evidence/citations`，Writer 与 Verifier 也没有该输入。

### 公开事件、回放与 UI

生产源事件统一为严格 `memory.updated`：

- `operation`: `recall | store`
- `status`: `completed | degraded`
- `count`
- `memoryRefs/evidenceIds`
- `embeddingVersion`
- 可选 `reasonCode`

事件数组最大 10 项，count 必须与去重后的两个引用数组同时一致；`degraded` 必须有 reasonCode，
`completed` 不允许 reasonCode。正文、模型输入和 Provider 数据不在合同中。

BFF 白名单投影为用户可见的简短状态，`wb_agent_events` 保存流身份和原始稳定引用。Reducer 使用
`memory:<runId>:<operation>` 唯一键归并 replay，相同事件不重复增加；已完成状态不会被后到的降级
事件倒退。Workbench 继续使用通用 StatusItem，只展示计数状态。mock 运行器也切换为同合同的
匿名稳定 ID，不再把模拟记忆正文放进公开事件。

## 自动化验证

- Search Agent：`262 passed`；Ruff、compileall 通过；
- Web：`387 passed, 1 skipped`；typecheck、lint、production build 通过；
- contracts：`6 passed`；
- Playwright：`16 passed, 3 skipped`；
- `git diff --check` 通过。

新增回归覆盖：

- scope/status/type/embedding 过滤与表达式注入 fail-closed；
- 稳定 identity、跨 visitor identity 分离与只写 cited；
- direct `load_context` 不召回、不修改会话历史；
- recalled candidate 与当前 Evidence 分离；
- VERIFIED store 的 `sourceRunId` 和 cited 输入；
- partial 不写长期记忆，Milvus 不可用产生受控降级；
- BFF 严格事件、公开投影、Reducer 幂等 replay 和 completed 不倒退。

## 生产验收

部署后使用同一访客的两个项目做真实小红书搜索：

1. 项目 A 首轮 `run_755ff83b07a44f7987eb79a6be62d64c`
   - 两个真实工具 started/completed；
   - `VERIFIED / completed`；
   - recall 0；
   - store 3，返回 3 个稳定 `memoryRef` 与 3 个 `evidenceId`。
2. 项目 A 第二轮 `run_3c531b601202468b94cdbe4048bd0fdf`
   - recall 3，引用与首轮 store 完全相同；
   - 之后仍有 4 个真实工具 started/completed，证明记忆没有替代本轮检索；
   - 工具预算最终 `TOOL_CALL_LIMIT / partial`，没有错误写入新记忆。
3. 项目 B 相近问题 `run_7060f03b133041a88449d86f75f6300f`
   - recall 0；
   - 仍有 2 个真实工具 started/completed；
   - 以 `MAX_ITERATIONS / partial` 诚实收口，没有跨项目泄露。

三轮持久 `memory.updated` 的 key 只有 count、operation/status、memory/evidence 引用、embedding 版本、
流元数据和公开 summary；`memoryRef` 在所有非 memory 事件中的出现数为 0。另一次 Web 探针
`run_f8c5ddc0f03b486bad0ed5a61869f4c1` 因一个正文工具失败并触发 `RUN_TIME_RESERVE / partial`，只
产生 recall 0，没有被误算为 store 成功。

## 部署与回滚

- 回滚镜像：
  `agent-workbench/search-agent:pre-issue-21-9ca2ee2` 与
  `agent-workbench/web:pre-issue-21-9ca2ee2`；
- 重建并滚动替换 Search Agent 与 Web，没有删除 PostgreSQL、Milvus、工具会话或数据卷；
- Compose 七服务 healthy；`127.0.0.1:3000`、`127.0.0.1:8080` 与
  [https://luzern.cc.cd/workbench](https://luzern.cc.cd/workbench) 均返回 200；
- 回滚只需恢复两个应用镜像，不删除 checkpoint、工具账本、Evidence、记忆或用户会话。
