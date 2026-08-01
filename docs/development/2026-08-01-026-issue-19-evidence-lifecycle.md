# Issue #19：Evidence 生命周期与可审计状态

## 范围与门禁

本 Issue 只实现生产 Search Agent 的 Evidence 生命周期，不实现 Claim 图、LangSmith 或新评测
框架。GitHub Issue #19 已标记 `Status: ready` 与 `Execution Gate: allowed`。

目标是把“工具读到了正文”与“模型采用了正文”“答案实际引用了正文”分开记录，并确保这些状态
可以随 LangGraph checkpoint、BFF 持久事件和前端 replay 一致恢复。公开过程仍只展示安全摘要和
结构化状态，不请求、保存或展示模型私有思维链。

## 服务端身份与状态机

新增 `app/graph/evidence.py`，由服务端生成：

- `sourceId`：对去除首尾空白后的正文 URL 做 SHA-256，再取 40 位稳定摘要；
- `contentHash`：对实际已读正文做完整 SHA-256；
- `evidenceId`：对 `sourceId + contentHash` 再做 SHA-256，正文变化会生成新 Evidence 身份；
- `status/statusReasonCode/statusUpdatedAt`：随 Evidence 一起进入 SearchState checkpoint。

合法迁移只有：

```text
read -> accepted -> cited
  └──> rejected
```

同一状态的重复事件不更新时间且不重复计数。`accepted -> rejected`、`cited -> accepted`、
`rejected -> accepted`、同 URL 返回不同正文身份或 checkpoint 中携带伪造 ID 都抛出
`EVIDENCE_STATE_CONFLICT`，由图节点按稳定 reasonCode fail-closed。

## 图节点消费边界

- `merge_research`：只把工具真实 `result.evidence` 转为 read；候选标题与 snippet 不创建
  Evidence；重放相同正文不重复加入。
- `reflect`：Reflector/Source Curator 的 `include_in_details` 只能引用本轮真实已读 URL。真实展示
  进入 accepted，明确排除进入 rejected，模型未决条目保持 read。
- `compose` 与 `verify`：只接收 accepted/cited Evidence，read/rejected 正文不进入 Writer 或
  Verifier 输入。
- `finalize`：解析 Writer 实际输出的 `[来源N]`，只有可解析且对应 accepted/cited Evidence 的
  条目进入 cited；未引用 accepted 不伪标 cited。Citation 也只发布这些实际引用。
- 长期记忆：仅在 `VERIFIED` 终态保存 cited Evidence；partial、read、accepted 未引用和 rejected
  均不写入长期证据记忆。
- 直接问题：保持 0 Evidence、0 evidence.updated。

## 公开事件、持久化与 UI

Search Agent 新增 `evidence.updated`，严格白名单只有：

```text
evidenceId, sourceId, contentHash, toolCallId, url, title,
channel, status, reasonCode, updatedAt
```

事件不含正文、query、Provider、author、metrics、Prompt、Provider body、Cookie、token、私有
CoT 或 `reasoning_content`。BFF Zod 严格校验 ID、64 位小写 SHA-256、HTTP(S) URL、时间与状态，
然后将状态投影到真实 `toolCallId` 的来源并写入 `wb_agent_events`。

Workbench Reducer 按规范 URL 归并来源，只有身份完全一致且迁移合法时才更新状态；重复 replay
幂等，倒退或身份漂移保留旧的可信状态。工具详情和聚合搜索记录显示“已读取 / 已采用 / 已排除 /
已引用”。这些是结构化状态标签，不是模型过程文案。

## 测试

新增或强化的覆盖包括：

1. 稳定身份、正文变化、合法迁移、幂等重放、终态冲突与伪造 ID；
2. 公开事件字段白名单，不允许正文或内部字段；
3. merge 的 read、Reflector 的 accepted/rejected、finalize 的实际 cited；
4. read/rejected 不进入 Writer，未引用 accepted 不进入 Citation/记忆；
5. BFF Zod、mapper、持久 AgentEvent、Reducer 状态单调归并与身份冲突；
6. Workbench 四种状态的公开中文标签；
7. “你是谁”即使带有旧检索历史也保持 0 plan、0 tool、0 Evidence，由 Writer 模型真实回答。

完整门禁：

- Search Agent：258 passed；Ruff、compileall 通过；
- Python 合同：6 passed；
- Web：385 passed、1 skipped；typecheck、lint、production build 通过；
- Playwright：16 passed、3 个 live gate skipped；
- `git diff --check` 通过。

## 真实生产验收

小红书首页案例运行 `run_32747c65d748476d99e723007adf8a14`：

- 总耗时 31.493 秒；
- 两个真实 `toolCallId`，分别 7.650 秒和 6.524 秒，均为 success；
- 每次 5 个候选、3 条已读正文，共 6 个稳定 Evidence；
- 6 个均为 read -> accepted，答案实际使用的 3 个继续进入 cited；
- 最终可见状态为 3 accepted、3 cited；
- 助手消息保存 3 个 Citation，与 3 个 cited Evidence 数量一致；
- `verificationPassed=true`、`VERIFIED / completed`；
- `wb_agent_events` 对 reasoning_content、Provider body、Prompt、Cookie、authorization 与 API key
  的扫描计数为 0。

同一线程先发送英国奖学金主题，再以显式 UTF-8 发送“你是谁”的运行
`run_f1b18b5a46184e3c92251fac67cce5a5`：

- 2.945 秒；
- `answerSource=model`、`answerModelCalls=1`；
- 0 plan、0 tool、0 Evidence；
- 唯一 `run.completed`，没有把旧主题带入回答。

早先一次 PowerShell 探针没有显式以 UTF-8 编码请求体；复核 `wb_agent_events` 后确认服务端实际
收到的是 `??? LangGraph ...`，而不是原中文“请搜索”请求，因此该运行不作为路由缺陷或验收
证据。改用 `application/json; charset=utf-8` 和 UTF-8 bytes 后，小红书请求正常产生结构化计划、
两次真实工具调用和 Evidence 生命周期；身份问题正常走 direct。此处没有为探针编码错误创建
产品 Issue，也没有增加关键词固定路由。

## 部署与回滚

- 回滚镜像：
  `agent-workbench/search-agent:pre-issue-19-244a553` 与
  `agent-workbench/web:pre-issue-19-244a553`；
- 滚动替换 Search Agent 与 Web，PostgreSQL、Milvus、小红书工具会话及数据卷未删除；
- Compose 七服务 healthy；3000、8080 与
  [https://luzern.cc.cd/workbench](https://luzern.cc.cd/workbench) 均返回 200；
- 回滚只需切换两个应用镜像，不删除 checkpoint、工具账本、Evidence、事件或用户会话。
