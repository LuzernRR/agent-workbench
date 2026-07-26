# 万能搜索 Agent v2 跨语言契约

## 目的与边界

本目录是 TypeScript 与 Python 共享的唯一业务合同。S00 只冻结 JSON Schema、跨对象语义、不变量、稳定错误码和测试样本，不接入现有 v1 生产路径，不实现 UI、API、数据库、模型调用、Prompt、工具执行、搜索、RAG、Memory v2、LangGraph 或跨进程恢复。

所有 Schema 使用 JSON Schema Draft 2020-12。canonical URI 前缀为：

```text
https://schemas.agent-workbench.invalid/contracts/v2/schemas/
```

`.invalid` 是保留的不可解析域名，用于稳定标识而非网络发布。TypeScript 与 Python 消费端必须预注册全部 Schema 并在离线条件下解析 `$ref`，禁止联网取回 Schema。对象 envelope 默认 `additionalProperties: false`；唯一动态对象是工具参数和结果，但它们仍须由对应 `ToolSpec.parametersSchema`、`ToolSpec.resultSchema` 二次校验，并递归拒绝私有思维链字段。

## 目录

| 文件 | 合同 |
|---|---|
| `schemas/common.schema.json` | 版本、ID、时间、scope、SourceType、金额、Usage、Budget、ModelAttempt 等共享定义 |
| `schemas/research-intent.schema.json` | ResearchIntent |
| `schemas/research-brief.schema.json` | ResearchBrief |
| `schemas/search-plan.schema.json` | SearchPlan 与 PlanStep DAG |
| `schemas/tool.schema.json` | ToolSpec、ToolCall、ToolResult、ToolError |
| `schemas/evidence.schema.json` | Source、Snapshot、Evidence、严格 Locator |
| `schemas/claim-citation.schema.json` | Claim 与可独立渲染的 Citation |
| `schemas/search-response.schema.json` | completed、partial、failed 的统一 SearchResponse |
| `schemas/steering-command.schema.json` | SteeringCommand |
| `schemas/run-queue-entry.schema.json` | RunQueueEntry 与 QueueSnapshot |
| `schemas/thread-queue-event.schema.json` | 独立于 run 的 ThreadQueueEvent |
| `schemas/agent-state.schema.json` | 未来 AgentState 的最小公共状态引用 |
| `schemas/agent-event.schema.json` | 严格、按 `type` 判别的 AgentEvent v2 |
| `schemas/contract-bundle.schema.json` | 跨对象、序列和引用验证使用的测试聚合对象 |
| `fixtures/manifest.json` | 双语言测试唯一入口 |

## 共享枚举与数据语义

### SourceType

`SourceType` 只在 `common.schema.json` 定义，其他 Schema 统一引用：

```text
web
official_docs
news
academic
code
dataset
private
user_attachment
social
```

平台差异由 `platforms` 表达，不再为 GitHub、RSS 等复制新的来源大类。

### 金额、Usage 与 Budget

- USD 金额统一使用非负 decimal string，禁止用 IEEE 754 浮点数比较预算。
- `ModelUsage` 只描述模型调用；`ToolUsage` 只描述工具调用；`RunUsage` 由 `modelBreakdown[]`、`toolBreakdown[]` 和可复算 totals 组成。
- `totalTokens = inputTokens + outputTokens`；`reasoningTokens` 是输出 Token 子集；`cacheHitInputTokens + cacheMissInputTokens <= inputTokens`，剩余部分允许 Provider 无法分类。
- `promptTokens`/`completionTokens` 不另建一套计数，合同以 `inputTokens`/`outputTokens` 为规范字段。
- `actualCostUsd` 未知时必须为 `null`，不能当作零；`possibleDuplicateCostUsd` 同时汇总模型和工具的未知 attempt。
- `RunUsage.totals` 必须逐项等于 breakdown 求和；`peakParallelTools` 是运行期间观察到的并行工具峰值。
- Budget 的整数与金额计数均满足 `remaining = max - used - reserved`。`parallelTools.used` 同样表示已观察峰值，而非当前并发数。
- 预算覆盖模型调用、输入/输出 Token、费用、计划修订、搜索查询、页面读取、工具调用、并行峰值与 wall time/deadline。硬预算耗尽后，同一 run 只允许直接写唯一 terminal，不得继续 node、message、memory、guidance、approval、clarification、context、budget 或普通状态事件。

### Provider 崩溃窗口

模型与工具 attempt 都允许 `unknown`。`unknown` 表示无法确认远端操作是否已完成或计费：

- `actualCostUsd` 必须为 `null`；
- `possibleDuplicateCostUsd` 必须大于零；
- 非幂等或有副作用工具不得盲目重复执行；
- 后续动作必须先检查 operation ledger 或重规划，不能把未知结果伪报成失败、成功或零成本。

## Tool 合同

`ToolSpec` 冻结 capability、permission、approval、cost、timeout、idempotency，并显式声明：

- `effect`：`read | write | external_side_effect`
- `reversibility`：`read_only | reversible | compensatable | irreversible`
- 严格的 `parametersSchema`
- 严格的 `resultSchema`

不可逆工具不能配置为永不审批。Tool Gateway 必须在调用前校验参数，在 Provider 返回后校验结果，再生成公开白名单投影；Provider strict Beta 不是服务端权限、策略或结果安全边界。

`ToolResult.status` 为 `succeeded | failed | cancelled | unknown`。完整 `ToolError` 只属于受 ACL 保护的 ToolResult/Operation Ledger；AgentEvent 仅公开 operationRef、稳定 errorCode、nextAction、ToolDisplay、Usage、耗时、attempt 和安全 reason codes。

ToolError `category`：

```text
invalid_arguments
permission_denied
auth_required
rate_limited
timeout
provider_unavailable
output_invalid
empty_result
not_found
conflict
cancelled
outcome_unknown
internal
```

ToolError `nextAction`：

```text
repair_arguments
request_approval
connect_account
retry_wait
retry_same
fallback_provider
replan
check_operation
stop
```

关键跨字段规则：

- `invalid_arguments`：`fieldPath`、`expected` 非空，`retryable=false`，`nextAction=repair_arguments`。
- `rate_limited`：`retryAfterMs` 非空，`retryable=true`，`nextAction=retry_wait`。
- `outcome_unknown`：`retryable=false`，`nextAction=check_operation`。
- `permission_denied`、`auth_required` 不得自动重试。

`ToolDisplay.parameterSummary`、`resultSummary`、`errorMessage` 都允许 `null`。它们必须由 Tool Gateway 从白名单字段确定性生成，不能为了满足 UI 而泄露敏感参数或编造说明。

## Evidence、Claim 与 Citation

- 跨边界对象只保存 Source/Snapshot/Passage/Artifact 引用、hash、有限 quote 和 locator；不得把网页全文、完整 Prompt、历史或项目记忆塞进 AgentState 或 AgentEvent。
- Locator 使用严格分支：`html_paragraph`、`text_quote`、`pdf_page`、`code_line`、`media_timecode`。
- Claim 只能引用已存在 Evidence；completed 响应不能包含 unsupported claim。
- Citation 内嵌 title、canonicalUrl/artifactRef、sourceType、publishedAt/retrievedAt、locator 和 `locatorVerified`，无需客户端再查询外部 Evidence 才能渲染或下载。
- completed 响应中的 Citation 必须已验证，且 URL、标题、时间和 locator 与已读 Source/Evidence 投影一致；私有来源的 canonicalUrl 必须为 `null`，只能公开受 ACL 控制的 artifactRef。

## 可见过程与 publicText

公开过程不是 `reasoning_content` 或私有 CoT。全目录递归阻断：

```text
reasoning_content
chainOfThought
rawReasoning
rawCoT
```

`publicText` 仅是同一次严格结构化节点结果的安全投影：

- `node.started.publicText` 必须为 `null`。
- `node.completed` 为 model 节点时必须是单个自然段，最长 500 字符，禁止换行、Markdown 标题、列表和代码围栏；deterministic 节点必须为 `null`。
- `node.failed.publicText` 可为 `null`；非空时仍遵守单段规则。
- tool、context、budget、approval、clarification 依赖各自结构化字段，`publicText` 必须为 `null`。
- plan/run status/verification 允许安全单段，但不能声称未发生的工具、搜索、核验或完成动作。

S00 只冻结形状；同次生成的支持关系和投影蕴含门由后续阶段实现。投影失败时必须隐藏文本，禁止本地 fallback 话术。

## AgentEvent 与运行闭环

AgentEvent envelope 固定 `schemaVersion/eventId/runId/scope/seq/occurredAt/type/kind/status/timestamps/inputRevision/refs/source/payload`。事件分支使用 `oneOf + const` 同时锁定 type、kind、status 和终态时间，不依赖非标准 discriminator。

### 节点

- `node.started` 与唯一 `node.completed | node.failed` 通过 `nodeExecutionId` 配对。
- `executionKind=model` 必须提供真实 ModelUsage/ModelAttempt；`executionKind=deterministic` 不得伪造零调用 Provider Usage。
- 同一生命周期的 run、inputRevision、node、ordinal、attemptNumber 必须一致；terminal 前不能遗留运行中节点。

### 工具

- `tool.started`、可选 `tool.updated/approval.*` 与唯一 `tool.completed | tool.failed | tool.unknown` 通过 `toolCallId` 严格配对。
- started 与 terminal 不是同一原子事务；每条事件都必须先独立持久化，再向 SSE 发布。
- 同一个 toolCallId 只能有一个终点；unknown 之后不得盲目重复非幂等副作用调用。

### 上下文与预算

- `context.usage.updated` 只公开 Token 数、revision、estimate/actual 状态和各区段 retained/truncated/omitted 计数，不携带正文。
- 同一 `contextRevision` 只能从 estimate 收敛到 actual，不能回退；重建上下文必须递增 revision。
- `remainingTokens` 和 `utilizationBasisPoints` 必须可复算。
- `budget.updated` 引用完整 Budget/RunUsage；耗尽后直接进入唯一 terminal。

### 答案、验证与记忆

- assistant message 必须 `message.started -> message.completed` 唯一配对，`message.completed.responseId` 绑定 SearchResponse。
- completed/partial terminal 前必须有最新 inputRevision 的 `verification.completed` 和已验证 assistant message；completed 必须 `passed=true`。
- `memory.updated` 若存在，只能发生在已验证 message/response 后、run terminal 前；cancelled/failed 分支不能写长期记忆。
- run terminal 是同一 run AgentEvent 流的最后事件；terminal 后禁止同一 run 继续发布业务 AgentEvent。
- ThreadQueueEvent 是独立线程级流，可在 run terminal 后合法更新出队、暂停或自动启动状态；它使用独立 queue cursor/revision，不受 run terminal 事件规则错误拦截。

## Steering、interrupt 与 FIFO

clarification/approval interrupt、活动 run steering 和普通新消息 FIFO 是三种不同输入。

- 客户端提交 `expectedSteeringRevision`；accepted 只表示命令已经持久化，记录 commandSeq/base revision，不增加 steeringRevision。
- 同一 base revision、同一安全点前的命令按 commandSeq 组成 batch；一次事务只把 steeringRevision 增加 1，并写 applied/superseded 与旧 artifact invalidation。
- cancel/权限收紧优先；非冲突字段合并；同一格式或范围字段后到者 supersede 先到者。
- batch commit 期间到达的新命令进入下一批；旧 steering revision 返回稳定冲突，不静默套用。
- revision 变化后，旧 draft、verify、finalize 必须作废或重新核验。
- Ctrl/Cmd+Enter 对应未来 steer，普通消息对应 enqueue；UI/API、IME/repeat/幂等保护属于后续 S01/S04，不在 S00 实现。

ThreadQueueEvent 没有 runId/run seq。每个线程最多一个 active run，普通消息 FIFO；`autoStartNext` 是可配置 boolean。completed 可按配置自动启动队首，stopped/failed 默认暂停。队列更新使用独立、单调 queueRevision；无 active run 时仍可入队、编辑、取消、暂停和恢复。

## AgentState 最小边界

AgentState 只冻结未来状态图所需的小型引用：

- `stateRevision`、`checkpointRevision`、整数 `fencingToken`
- `steeringRevision`、`lastAppliedCommandSeq`
- `currentNode`、`nextNode`
- `pendingClarificationRef`、`pendingApprovalRef`
- `cancelRequested`
- Artifact/Evidence/plan/message 等引用

等待 clarification/approval 时必须存在对应引用，离开等待后清空；两个 pending 引用不能同时非空。checkpoint 与 fencing token 单调，`cancelRequested` 不能从 true 回退 false，terminal 时 nextNode 和 pending 引用必须为 null。AgentState 不包含线程队列快照，也不保存大正文、完整历史或 CoT。

这些字段只冻结条件提交合同，不表示 S00 已实现 checkpoint、lease、fencing 数据库或重启续跑。

## 稳定错误码与优先级

稳定错误码集合的共享事实源是 `fixtures/manifest.json.errorCodes`。两个消费端必须导出同序列表并由测试逐项对账：

- TypeScript：`frontend/src/lib/contracts/search-agent-v2.ts` 的 `contractErrorCodes`
- Python：`frontend/contracts/python/search_agent_v2.py` 的 `CONTRACT_ERROR_CODES`

当前检查优先级如下。新增规则必须同时修改两端和共享 fixture，禁止依赖 Ajv/jsonschema 原始错误文本。

1. 全局私有推理字段：`PRIVATE_REASONING_FORBIDDEN`
2. publicText 投影形状：`PUBLIC_TEXT_INVALID`
3. 单个 AgentState 语义：`STATE_TRANSITION_INVALID`
4. JSON Schema、格式、未知字段和未知事件：`SCHEMA_INVALID`
5. bundle 的 command scope：`COMMAND_SCOPE_MISMATCH`
6. bundle 通用 scope：`SCOPE_MISMATCH`
7. AgentState 序列与 fence：`STATE_TRANSITION_INVALID`、`STATE_FENCE_INVALID`
8. 计划：`PLAN_STEP_DUPLICATE`、`PLAN_DEPENDENCY_MISSING`、`PLAN_CYCLE`
9. 工具：`TOOL_ERROR_INVALID`、`TOOL_POLICY_INVALID`、`TOOL_SCHEMA_INVALID`、`TOOL_CALL_DUPLICATE`、`TOOL_CALL_DANGLING`、`TOOL_ARGUMENTS_INVALID`、`TOOL_UNKNOWN_RETRY_FORBIDDEN`
10. Evidence/Citation/Locator/Claim：`EVIDENCE_REFERENCE_INVALID`、`CITATION_UNVERIFIED`、`CITATION_PROJECTION_MISMATCH`、`LOCATOR_INVALID`、`UNSUPPORTED_CLAIM`
11. Usage：`USAGE_INVALID`
12. Budget：`BUDGET_INVALID`、`BUDGET_STOP_MISMATCH`
13. AgentEvent：`CONTEXT_USAGE_INVALID`、`EVENT_SEQ_INVALID`、`EVENT_STATE_INVALID`、`DUPLICATE_TERMINAL`、`EVENT_AFTER_TERMINAL`、`MEMORY_WRITE_INVALID`
14. 延后处理的 steering revision/terminal：`COMMAND_REVISION_CONFLICT`、`COMMAND_AFTER_TERMINAL`
15. 独立队列：`QUEUE_REVISION_CONFLICT`、`QUEUE_ORDER_INVALID`、`QUEUE_ACTIVE_RUN_CONFLICT`、`QUEUE_PAUSE_INVALID`

完整 37 项错误码：

```text
SCHEMA_INVALID
PRIVATE_REASONING_FORBIDDEN
PUBLIC_TEXT_INVALID
SCOPE_MISMATCH
PLAN_STEP_DUPLICATE
PLAN_DEPENDENCY_MISSING
PLAN_CYCLE
TOOL_CALL_DUPLICATE
TOOL_CALL_DANGLING
TOOL_SCHEMA_INVALID
TOOL_POLICY_INVALID
TOOL_ERROR_INVALID
TOOL_ARGUMENTS_INVALID
TOOL_UNKNOWN_RETRY_FORBIDDEN
EVIDENCE_REFERENCE_INVALID
CITATION_UNVERIFIED
CITATION_PROJECTION_MISMATCH
LOCATOR_INVALID
UNSUPPORTED_CLAIM
USAGE_INVALID
BUDGET_INVALID
BUDGET_STOP_MISMATCH
CONTEXT_USAGE_INVALID
EVENT_SEQ_INVALID
EVENT_STATE_INVALID
DUPLICATE_TERMINAL
EVENT_AFTER_TERMINAL
MEMORY_WRITE_INVALID
COMMAND_REVISION_CONFLICT
COMMAND_AFTER_TERMINAL
COMMAND_SCOPE_MISMATCH
QUEUE_REVISION_CONFLICT
QUEUE_ORDER_INVALID
QUEUE_ACTIVE_RUN_CONFLICT
QUEUE_PAUSE_INVALID
STATE_TRANSITION_INVALID
STATE_FENCE_INVALID
```

## Fixtures 与测试

`fixtures/manifest.json` 是测试唯一入口。每项声明 `id`、`schemaId`、`path`、`expectedValid`、`expectedErrorCode` 和 `coveredInvariant`。当前冻结 107 项：30 项合法，77 项非法。测试同时检查 manifest 无重复 ID/路径、没有漏收 fixture、全部 `$ref` 离线解析、合法样本无私有推理字段，以及 TS/Python 对每项返回相同稳定错误码。

TypeScript：

```powershell
cd frontend
npx vitest run src/lib/contracts/search-agent-v2.contract.test.ts
npm run typecheck
```

Python：

```powershell
cd frontend/contracts/python
uv sync --locked
uv run pytest -q
```

S00 定向双语言测试与完整仓库门禁均已通过；这只表示合同实现具备验收证据，不代表用户已经验收或允许开始 S01。

## 官方依据

- [JSON Schema Draft 2020-12 Core](https://json-schema.org/draft/2020-12/json-schema-core)
- [JSON Schema Draft 2020-12 Validation](https://json-schema.org/draft/2020-12/json-schema-validation)
- [LangGraph Persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)
- [DeepSeek Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)
- [DeepSeek Tool Calls strict mode](https://api-docs.deepseek.com/guides/tool_calls/)

LangGraph 文档仅用于冻结未来 thread checkpointer 与跨线程 Store 的职责边界。DeepSeek Thinking Mode 的 `reasoning_content` 只允许在单次 Provider 适配器内部短暂使用；公开合同、日志、fixture、历史 Prompt 和项目记忆均不得保存。DeepSeek strict mode 仍处于 Beta，不能替代服务端二次 Schema 校验、ACL、审批、预算和操作账本。

## 兼容与回滚

v2 合同位于独立目录，生产代码没有导入。回滚只需撤销 `frontend/contracts/`、TypeScript 契约消费者测试和 Ajv 开发依赖，不涉及数据库、用户数据或 v1 运行行为。
