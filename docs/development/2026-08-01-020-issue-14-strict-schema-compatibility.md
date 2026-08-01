# Issue #14：生产 strict 结构化 Schema 与 Planner 兼容

## 元数据

| 字段 | 内容 |
|---|---|
| 日期 | 2026-08-01 |
| Issue | [#14](https://github.com/LuzernRR/agent-workbench/issues/14) |
| 状态 | completed |
| Execution Gate | allowed |

## 修改前基线与根因

Issue #13 部署后的真实 Web+X smoke 在 `plan_research` 直接失败：

- `load_context`、`classify_intent` completed；
- `plan_research` 发布 `node.failed.reasonCode=invalid_request_error`；
- 0 次工具调用、0 个 Research 分支；
- Harness 以唯一 `run.failed / BADREQUESTERROR` 收口。

只读 JSON Schema 审计发现，DeepSeek strict function calling 要求每个 object property 都在
`required` 中。当前生产 Schema 有 6 个 optional property：

- `PlannedStep.depends_on`；
- `ReflectResult.missing/extra_searches/source_presentations`；
- `VerifyResult.issue/extra_searches`。

`IntentResult` 所有字段本来就是 required，因此 Supervisor 成功，Planner 成为第一个失败点。
在部署容器中使用字段、约束相同但所有 property 都 required 的临时 ProbePlan 实测成功：
1 step、1 attempt、698 tokens；探针没有输出模型正文、Prompt、Provider body 或任何凭据。

## 单一 Feature 与安全边界

本 Issue 只修复所有生产 strict structured-output Schema 的 Provider 兼容，并增加静态预检和
稳定请求错误码。不修改模型自然语言为硬编码模板，不修改 API/Tavily Key 或任何
`config/*.local.json`，不实现 ToolGateway、完整账本、Evidence 状态机、记忆、LangSmith 或
eval。

公开事件继续只允许模型生成的安全摘要、节点状态、工具、计划、证据和稳定 reason code；
Provider request body、异常正文、私有思维链、`reasoning_content`、Cookie、token 和密钥均不
进入 State、checkpoint、事件、日志或 UI。

## 实现

### 全字段显式必填

- `depends_on` 不再有 `default_factory`；无依赖时模型必须显式返回 `[]`。
- Reflector 必须显式返回 `missing/extra_searches/source_presentations`；语义为空时分别使用
  `""/[]/[]`。
- Verifier 必须显式返回 `issue/extra_searches`；通过或不需补搜时使用 `""/[]`。
- 缺少任一字段时 Pydantic 直接拒绝，不使用服务端默认值补写模型语义。

Prompt 版本升级为 `2026-08-01.v27-strict-required-fields`，Planner、Reflector、Verifier
明确要求即使为空也必须返回字段。这里约束的是结构完整性，不提供计划、反思、核验或回答的
固定自然语言内容。

### strict Schema preflight

`validate_strict_schema()` 在任何 Provider 调用前递归检查 Pydantic JSON Schema：

- 每个 `type=object` 必须 `additionalProperties=false`；
- `properties` 集合必须与 `required` 集合完全相等；
- `$defs` 中的嵌套对象同样检查；
- 失败抛出稳定 `STRICT_SCHEMA_INVALID`，且不会产生外部模型调用。

生产使用的 Intent、Plan、Reflect、Source Curator、Compose、Verify 六个 Schema 均纳入
静态回归。

### Provider 400 安全归一化

strict structured-output 请求若仍被 Provider 以 HTTP 400 拒绝，接入层转换为
`MODEL_STRUCTURED_REQUEST_INVALID`。异常只保留通用中文消息；Provider 原始 message/body
不会出现在节点或 Run 事件中。HarnessRunner 继续优先使用稳定异常 `code`。

## 测试证据

| 门禁 | 结果 |
|---|---|
| strict/repair/prompt 定向 | `34 passed` |
| graph/fan-out 定向 | `57 passed` |
| Search Agent 全量 | `225 passed` |
| Ruff / compileall | passed |
| 共享 Python 合同 | `6 passed` |
| Web 全量 | `379 passed, 1 skipped` |
| TypeScript / ESLint / production build | passed |
| Playwright deterministic | `16 passed, 3 skipped` |
| `git diff --check` | passed |

新增关键回归：

- 六个生产 Schema 递归满足 strict object 规则；
- optional property 测试 Schema 在 Provider 调用前以 `STRICT_SCHEMA_INVALID` 失败；
- Plan/Reflect/Verify 缺少显式空字段时 Pydantic validation error；
- 合法空字符串/空数组可通过；
- 模拟 Provider 私密 400 body 只得到 `MODEL_STRUCTURED_REQUEST_INVALID`，sentinel 不泄露；
- 既有 structured repair、完整图、fan-out/fan-in、partial、预算、stop/cancel、outcome
  unknown 和唯一 terminal 不回归。

## 真实生产验证

Search Agent 镜像已滚动部署，旧镜像保留为
`agent-workbench/search-agent:pre-issue-14-d387b66`。真实运行：

- Run：`run_issue14_1785574081801`；
- 问题明确要求 Web 与 X/Twitter 两个渠道分别执行独立查询；
- 耗时：100.596 秒；
- 节点：load/classify/plan/mark 各 1，`research` 2，`merge_research` 1，
  reflect/compose/verify/finalize 各 1；所有节点 started/completed 成对，0 node.failed；
- 工具：2 次，渠道顺序 `web, x`；
- 计划 revision：`1 → 2 → 3`；
- Evidence：3；
- 终态：唯一 `run.completed / partial`，`answerSource=model`，Writer 模型调用 receipt 为 1；
- 原始公开 NDJSON 敏感字段扫描：0。

这次验证证明真实 Provider 已越过 Planner，并实际进入 Issue #13 的两个 Send Research 分支和
单一 merge fan-in。`partial` 是证据/核验结果的诚实终态，不是 Schema 或图执行故障。

Compose 七服务保持 healthy；3000、8080 与
[https://luzern.cc.cd/workbench](https://luzern.cc.cd/workbench) 可用。

## 回滚

- 将 Search Agent 切换到 `agent-workbench/search-agent:pre-issue-14-d387b66` 可恢复旧 Schema。
- 本轮无数据库 migration、无 Web 镜像变更、无配置/密钥修改、无数据卷操作。

## 后续

生产结构化模型主链路已恢复。下一独立 Issue 可以继续通用 ToolGateway、完整工具调用账本与
Evidence 状态机；不得重新实现已有 HarnessRunner 或图级 fan-out/fan-in。
