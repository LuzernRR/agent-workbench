# 清理 deepseek.py 未受 Gateway 治理的第二模型路径

## 元数据

| 字段 | 内容 |
|---|---|
| 日期 | 2026-08-04 |
| Issue | https://github.com/LuzernRR/agent-workbench/issues/46 |
| 状态 | accepted |
| 目标环境 | local |

## 手册依据

两份手册对 Model Gateway 的要求不是「存在一个 Gateway」，而是「模型调用**有且只有**这一条路径」。
统一路由、配额、重试、降级、成本与版本治理，只有在没有旁路时才成立。#43 建成了 Gateway，本轮负责
把旁路关掉。

## 问题与诊断

#43 把生产调用点全部迁到 `DefaultModelGateway` 后，`app/llm/deepseek.py` 的旧入口没有删除，构成第二条
绕过全部治理的模型路径：

| 遗留入口 | 绕过了什么 |
|---|---|
| `invoke_structured` | 自带 `max_attempts = 2 if allow_repair else 1` 修复循环，不经 `RetryPolicy`、不受 `DeadlineBudget` 约束、不产生 `network_retries`/`fallbacks` 记账，自行调用 `_record_model_span` |
| `stream_writer_answer` | 自带 `produced` 判定与 span 上报，与 Gateway 的 `_stream_text` 完全重复 |
| `invoke_researcher_turn` + `ResearcherTurn` + `ResearchToolCall` + `_reasoning_effort` | 已完全没有调用点 |
| `_record_model_span` | 只被上述函数调用，与 Gateway 的 `_record_span` 重复 |

风险不是「有死代码」，而是**后续任何改动重新调用这些函数都不会有测试报警**，却会静默绕过 deadline、
预算与分层记账。

关于 `invoke_researcher_turn` 的一处诊断修正：#43 的记录称它「被 `scripts/intent_probe.py` 引用」。
复核代码后确认并非如此——被探针引用的是 `invoke_structured`，`invoke_researcher_turn` 没有任何调用点，
`tests/test_graph_runtime.py` 里的 `Scenario.researcher` 测试替身也从未被接线（三处
`assert scenario.researcher_messages == []` 恒真）。因此本轮可以直接删除，无需先扩展 `ModelResult`。

## 目标、范围与非目标

目标：`app/llm/deepseek.py` 只保留 `DeepSeekProviderAdapter` 及其辅助函数作为唯一 Provider 入口，
并由静态测试守住这条边界。

范围：删除上述七个符号与随之孤立的 import；把调用被删函数的测试迁到 adapter + Gateway 组合；清理
`Scenario` 的 researcher 脚手架；新增 AST 静态测试。

非目标：不改 Gateway/`RetryPolicy`/`DeadlineBudget` 行为；不改 Prompt、LangGraph 拓扑、Checkpoint
Schema、公开 AgentEvent；不迁移 TypeScript 侧 mock/预览客户端；不为 researcher 工具子回合重建 Gateway
契约。

## 架构决策

### 用静态测试代替约定

「不要再调用这些函数」是约定，删除函数才是约束。但删除只解决当下，挡不住后续把网络调用重新写进
模块。因此新增 AST 测试 `test_provider_network_calls_only_exist_inside_the_adapter`：解析
`deepseek.py`，收集 `DeepSeekProviderAdapter` 类体内的全部节点，再扫描模块内所有 `.ainvoke(` 与
`.create(` 调用，任何一个落在类体外就失败。这条测试对「把网络调用搬到类外」这一改动会红，而不是靠
review 发现。

配套的 `test_module_exposes_no_legacy_model_entry_points` 用 `hasattr` 断言七个符号确实不存在——它守的
是「删掉了」，AST 测试守的是「没有重新长出来」。

### 私有推理断言迁到真正剥离它的那一层

`test_private_reasoning_never_crosses_state_checkpoint_or_public_events` 原先靠
`Scenario.researcher` 在 `assistant_message` 里塞
`reasoning_content: "PRIVATE_CHAIN_OF_THOUGHT_SENTINEL"` 来注入。但该替身从未被接线，这个注入实际上
从未发生过——**该用例在改前就已是空转**。

删除脚手架后不能假装等价，因此把断言搬到真正发生剥离的位置：新增
`test_stream_never_forwards_reasoning_content_to_the_gateway`，构造一条同时含 `reasoning_content` 与
`content` 增量的假流，断言 adapter 只转发 `delta.content`，sentinel 不出现在任何 delta、也不出现在
终局 `ModelResult` 的序列化里，同时 usage 如实回传。这是对**真实代码**的行为断言，强于原先的空转。

图层用例保留为结构回归守卫，并在 docstring 里写明它现在守什么：Gateway 契约只承载
`(parsed, ModelUsage)` 与纯文本增量，本身没有承载 `reasoning_content` 的通道，图层已无处注入。
断言收敛为 `reasoning_content` 与 `chain_of_thought` 两个键——不能写成 `"reasoning" not in serialized`，
因为 State 合法携带请求侧配置 `reasoning_effort`（这一条是实测发现：先写宽了，测试直接红）。

### `StructuredOutputError` / `WriterStreamError` 改从 contracts 导入

这两个异常本就定义在 `app/llm/contracts.py`，此前经 `deepseek.py` 转出口。删除孤立 import 后转出口消失，
`tests/test_graph_runtime.py` 随之改为从正源导入。这不是重构偏好，而是删除动作的直接后果。

## 逐文件修改

| 文件 | 修改 |
|---|---|
| `app/llm/deepseek.py` | 575 → 276 行；删除 7 个遗留符号与 7 个孤立 import；模块 docstring 写明单一路径不变式 |
| `tests/test_deepseek_model_adapter.py` | 迁入 400 归一用例；新增 adapter 单次尝试、无自有 span、reasoning 剥离、AST 守卫、遗留符号缺席共 6 个用例 |
| `tests/test_model_gateway.py` | 迁入 tracing 关闭无 span、`allow_repair=False` 一次失败共 2 个用例 |
| `tests/test_strict_schema_compatibility.py` | 移除已迁走的 400 用例与其 4 个孤立 import；schema 严格性用例全部保留 |
| `tests/test_structured_output_repair.py` | 整文件删除（5 个用例已全部有等价覆盖） |
| `tests/test_graph_runtime.py` | 删除 `Scenario.researcher` 及 `researcher_mode`/`include_reasoning`/`researcher_messages` 字段与三处恒真断言 |
| `scripts/intent_probe.py` | 改经 `model_gateway()` 调用，与生产同一条路径（该脚本已在 `.gitignore` 中，不入库） |

## 测试总数变化（DoD 第 5 项）

484 → **486**，净 +2。逐项拆分：

| 变化 | 数量 | 说明 |
|---|---|---|
| 删除 `tests/test_structured_output_repair.py` | −5 | 修复计数、无预算不重试 → Gateway；三个 span 用例 → Gateway/adapter |
| 删除 `test_strict_schema_compatibility` 中的 400 用例 | −1 | 迁到 adapter，断言原样保留 |
| 新增 adapter 用例 | +6 | 400 归一、单次尝试、无自有 span、reasoning 剥离、AST 守卫、遗留符号缺席 |
| 新增 Gateway 用例 | +2 | tracing 关闭无 span、`allow_repair=False` 一次失败 |

删掉的 6 个全部有等价或更强的替代；新增的 6 个里有 3 个（AST 守卫、遗留符号缺席、reasoning 剥离）
是改前不存在的新保护。

## 兼容性、安全和异常

- 生产行为零变化：被删函数在 #43 之后已无生产调用点，删除不影响任何运行路径。
- Prompt 常量、LangGraph 拓扑、Checkpoint Schema、公开 AgentEvent 均未改。
- 结构化调用的 `thinking` 保持 disabled；流式侧 adapter 只读 `delta.content`，`reasoning_content`
  在 Provider 边界即被丢弃，现已有直接测试证明。
- 未新增任何 Provider 正文或凭据进入异常文本、日志或 span 的路径；400 归一仍只暴露稳定错误码
  `MODEL_STRUCTURED_REQUEST_INVALID`。

## 验证证据

| 验收项 | 测试证据 |
|---|---|
| DoD 1 无残留引用 | `git grep` 在 `app/`、`scripts/` 下无命中；`tests/` 下仅剩守卫测试内的字符串字面量（本意如此） |
| DoD 2 AST 守卫 | `test_provider_network_calls_only_exist_inside_the_adapter`：类体外的 `.ainvoke(`/`.create(` 列表必须为空 |
| DoD 2 删除守卫 | `test_module_exposes_no_legacy_model_entry_points`：7 个符号 `hasattr` 全为假 |
| DoD 3 400 归一 | `test_provider_bad_request_becomes_stable_safe_error`：`MODEL_STRUCTURED_REQUEST_INVALID`，且 `PRIVATE_PROVIDER_BODY_SENTINEL` 不在异常文本中 |
| DoD 4 tracing 关闭 | `test_no_span_is_recorded_when_tracing_is_off`：`record_model_call` 零调用，usage 仍正常 |
| 补充 adapter 语义 | `test_adapter_reports_schema_violation_as_empty_output_without_retrying`：只发一次请求，`output=None`，usage 如实回传 |
| 补充预算语义 | `test_schema_violation_without_repair_budget_fails_on_first_attempt`：1 次调用、`format_repairs=0`、`network_retries=0` |
| 补充隐私语义 | `test_stream_never_forwards_reasoning_content_to_the_gateway`：只转发 `content`，sentinel 不入 delta 与 `ModelResult` |
| DoD 5 全量门禁 | `pytest -q` → **486 passed in 7.77s**；`ruff check .`、`compileall -q app`、`git diff --check` 全部通过 |

全部测试使用假 Provider 与假流，不访问真实网络。Python 门禁使用仓库内
`services/search-agent/.venv/Scripts/python.exe`。本轮未触碰 Web 侧代码，未跑前端门禁。

## 遗留与下一项

- researcher 工具调用子回合（thinking + tool_calls）在本轮被确认为**无调用点的历史遗留**，已随代码
  删除。若将来确实需要该能力，须先扩展 `ModelResult` 表达 `tool_calls`，作为独立 Issue 处理，不得
  绕开 Gateway 重建。
- `scripts/intent_probe.py`、`scripts/latency_baseline.py` 等一次性探针已在 `.gitignore` 中，本轮虽
  修复了 intent_probe 的导入，但该修复不入库；下次使用者需自行确认脚本与当前契约一致。
- P0-02 清单中的「遗留」条目本轮标记为已清理。
- 下一项按清单顺序为 P0-03 独立 Worker、持久任务队列与租约。

## 回滚

`git revert <merge-sha>`。纯删除与测试迁移，无数据迁移、无配置变更、无 Schema 变化。回滚会把第二条
未受治理的模型路径恢复回来，但不影响任何已持久化 Run。

## 用户验收

- 状态：验收通过
- 验收反馈：用户 2026-08-04 回复“确认”。PR
  [#47](https://github.com/LuzernRR/agent-workbench/pull/47) 已 squash 合入 main（`028c9c7`），
  #46 以 completed 关闭。
- 下一功能执行门：放行（#46 已验收合并；下一项按清单顺序为 P0-03 独立 Worker、持久任务队列与租约，
  须先建带 Problem/Goal/Scope/Non-Goals/DoD 的 Issue 并置 `Execution Gate: allowed` 才能改代码）
