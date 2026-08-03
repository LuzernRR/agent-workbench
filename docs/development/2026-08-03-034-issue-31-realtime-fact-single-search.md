# 实时事实类问题走单次检索，不再退化为完整链路

## 元数据

| 字段 | 内容 |
|---|---|
| 日期 | 2026-08-03 |
| Issue | https://github.com/LuzernRR/agent-workbench/issues/31 |
| 状态 | awaiting-acceptance |
| 目标环境 | local |

## 问题与目标

### 问题

用户反馈（原话）：

> 这个思考搜索链路还是太长了，能不能不要这么啰嗦？……能否一次搜索，不满足要求再二次搜索，而不是一次
> 搜索已经符合，甚至不需要搜索的情况下，还要持续搜索？

以及对循环形状的补充要求（原话）：

> 这些简单的一次性搜索就有答案的问题不需要多次检索，不需要调用多次工具，每次都先调用一次，然后进行
> 核验，核验不通过再进行二次调用，最多三次，能理解吗？每次调用完可以先核验

实测「今天是几号」跑出 9 次模型调用、3 次工具调用、两轮 `plan_research → … → reflect`，`fastPath=False`，
其中一次运行以 `stopReason=MODEL_CALL_LIMIT`、`responseStatus=partial` 结束。#28 建好的单事实快路径
在真实链路上**从未命中过**。

### 目标

让真正的单事实问题由 Supervisor 自己判成 `single_fact`，走一次检索即收口；同时不误伤需要多来源的
问题，也不减少必要搜索。

### 范围

仅 `SUPERVISOR_PROMPT` 的判定口径 + 两条回归测试 + Prompt 版本号。

### 非目标

- **不加关键词表。** 分层仍由模型语义判定，服务端不写死规则、不代猜查询。
- **不减少必要搜索。**「今天是几号」仍然联网检索、仍然读正文、仍然带来源引用。
- **不改循环上限与图结构。** `max_rounds` 的硬顶与 `merge_research → reflect` 的每轮核验均已存在。
- 不动 Item I 的 `_freshness_required()` 正则本体（保留为兜底）。

## 根因

诊断脚本 `scripts/intent_probe.py` 直连 Supervisor（与 `classify_intent` 同一套 prompt 与入参）实测，
结论与原假设相反——**`evidence_depth` 的语义判定本身是准确的**：

| 问题 | 修复前 modelNeedSearch | evidence_depth | fastPath |
|---|---|---|---|
| 今天是几号 | **False** | multi_source | **False** |
| OpenAI 最新的模型是什么 | True | single_fact | True |
| LangGraph 最新版本号是多少 | True | single_fact | True |
| 你是谁 | False | multi_source | False（正确，不搜索） |
| 比较 LangGraph 和 LlamaIndex | True | multi_source | False（正确，需多来源） |

两个真正的单事实问题都判对了。只有「今天是几号」栽在一条**状态不一致**的路径上：

1. Supervisor prompt 注入 `当前日期：YYYY-MM-DD`（本是给 `fast_search.query` 做相对时间换算用的）。
   模型看到日期就在输入里，合理地判 `need_search=False`。
2. `need_search=False` 时 `IntentResult.validate_route()` 强制 `evidence_depth=multi_source`、
   `fast_search=None`、`channels=[]`（`schemas.py:84-90`）——这个约束本身是**正确**的。
3. `_freshness_required()` 的正则命中「今天」，把 `need_search` 翻成 True、`channels` 补成 `["web"]`，
   **但 `evidence_depth` 与 `fast_search` 仍停在第 2 步的值**（`nodes.py:1040-1045`）。
4. `_fast_search_request()` 因 `evidence_depth != "single_fact"` 返回 None → 落 `plan_research` 完整链路。

即：**正则覆盖能强制搜索，却无法凭空造出 `fast_search`**（服务端按约定不得代猜查询），
于是每一个由正则触发的搜索都必然退化为完整链路。这正是 Item I 所指的问题，但危害比原记录更具体。

## 方案与取舍

修复落在**让模型自己判对**，而不是在服务端加兜底猜测——后者会违反「不写死模板、不代猜查询」的约定，
而且对「最新 AI 新闻」这类真正需要多来源的问题，强行填 `single_fact` 是错的。

`SUPERVISOR_PROMPT` 增加一句判定口径：注入的当前日期只用于相对时间换算以撰写检索查询，
**它本身不是可直接作答的事实依据**；当用户所问的答案本身就是实时事实（当天日期、当前时间、当前价格、
当前版本、当前状态、当前排名），必须 `need_search=true` 并按单事实取证。

正则作为兜底保留。模型判对后覆盖分支不再进入（`overrideBroke=False`），它对这一类问题变成 no-op。

### 循环形状：已有结构满足要求，本轮未改

用户要求的「搜一次 → 核验 → 不通过再搜 → 最多三次」在图上已经成立，本轮无需改动：

- **每轮之后先核验**：`merge_research → reflect` 是每轮检索后的充分性判定（`build.py:249-257`）。
- **不通过才继续**：`reflect` 判不足才回 `plan_research`（`build.py:259-263`）；`verify` 判
  `research_more` 同样退回（`build.py:269-273`）。
- **最多三次**：`resolved_rounds = min(max_rounds or budget_rounds, 3)`（`state.py:388`）硬顶 3 轮，
  balanced 默认 2 轮。

## 配置

无新增配置项。`PROMPT_VERSION` 升至 `2026-08-03.v43-realtime-fact-single-search`。

## 逐文件修改

| 文件 | 修改 | 原因 |
|---|---|---|
| `app/prompts/agents.py` | `SUPERVISOR_PROMPT` 增加实时事实判定口径；升 `PROMPT_VERSION` | 让模型自己判出 single_fact |
| `tests/test_graph_runtime.py` | 新增 2 条回归测试 | 锁定快路径命中与覆盖逻辑边界 |
| `tests/test_prompts_and_events.py` | 新增 3 条 prompt 契约断言 | 防止口径被误删 |

## 完整执行链路

`classify_intent` 判 `single_fact` → `route_after_intent` 返回 `plan_fast_search` → 确定性建 1 步计划 →
`mark_plan_running` → `research`（1 次工具调用）→ `merge_research` → `accept_fast_evidence`
（`read → accepted` 迁移）→ `compose` → `verify` → `finalize`。共 10 个节点、1 次工具调用、3 次模型调用。

若这次检索没读到可用正文，`route_after_fast_plan` / `route_after_research` 自动退回完整链路；
`verify` 判 `research_more` 时 `fast_path` 清 False 并回 `plan_research`，由 `max_rounds` 收口。

## 异常、取消与恢复

本轮只改判定口径，未新增失败路径。模型仍可能判错分层——判成 `multi_source` 只是多搜一轮（退化为
修复前行为，不会出错）；判成 `single_fact` 但检索无正文时按既有路径退回完整链路。

## 数据与安全

- 未新增网络出口、未改渠道与 SSRF/robots 门禁，全部既有安全测试通过。
- 诊断脚本 `scripts/intent_probe.py` 从被忽略的本地配置读取密钥注入进程环境，不打印任何密钥内容；
  API Key 仍只在 `config/*.local.json`，未新增 `NEXT_PUBLIC_` 暴露。

## 验证证据

### 单元与静态门禁

| 门禁 | 结果 |
|---|---|
| `pytest -q` | 401 passed（较基线 +2 为本轮新增） |
| `ruff check .` | All checks passed |
| `npx tsc --noEmit` | 干净 |
| `npx vitest run` | 398 passed / 1 skipped |

### Supervisor 判定实测（`scripts/intent_probe.py --repeat 2`，各问题跑 2 次全部一致）

| 问题 | 修复前 | 修复后 |
|---|---|---|
| 今天是几号 | need_search=False / multi_source / **fastPath=False** | **need_search=True / single_fact / fastPath=True** |
| OpenAI 最新的模型是什么 | single_fact / fastPath=True | single_fact / fastPath=True（保持） |
| LangGraph 最新版本号是多少 | single_fact / fastPath=True | single_fact / fastPath=True（保持） |
| 你是谁 | 不搜索 | 不搜索（保持） |
| 比较 LangGraph 和 LlamaIndex | multi_source | multi_source（保持） |

修复后全部 `overrideBroke=False`，即正则覆盖分支不再进入。

### 真实链路实测（本地 8101，`promptVersion=2026-08-03.v43-realtime-fact-single-search`）

| 问题 | modelCalls | toolCalls | 节点数 | stopReason | 链路 |
|---|---|---|---|---|---|
| 今天是几号（修复前） | 9 | 3 | 16 | MODEL_CALL_LIMIT / VERIFIED | 两轮 `plan_research → … → reflect` |
| **今天是几号（修复后）** | **3** | **1** | **10** | **VERIFIED** | `plan_fast_search → … → accept_fast_evidence` |
| 你是谁 | 2 | 0 | 5 | DIRECT_COMPLETED | 不搜索（保持） |
| 比较 LangGraph 和 LlamaIndex | 8 | 4 | 17 | VERIFIED | 两轮，每轮后经 `reflect`（保持） |

修复后「今天是几号」答案带真实来源引用（`https://www.huangli.com/huangli/2026/08_03.html`），
`verificationPassed=true`，答案来自真实检索而非模型记忆。同时 `isPrefix=True`、
`streamedEqualsFinal=True`、字段白名单违规 0，#29 的流式不变量未被破坏。

## 回滚

`git revert` 本次提交即可。仅 prompt 文本与测试，无数据迁移、无契约变更；回滚后行为退回修复前
（多搜一轮，不会出错）。

## 未解决问题

- `_freshness_required()` 的正则仍作为兜底存在（Item I）。本轮证明了它的真实危害是「制造必然退化为
  完整链路的状态」；模型判对后它变为 no-op，但仍建议按约定单独开 Issue 评估移除。
- 单事实问题的 TTFT 仍有 17.3s（总 19.3s）落在 Writer 之前。相比修复前的 32.4s / 34.1s 已显著改善，
  但阶段 3–5 的性能改造（researcher 降 effort、`asyncio.as_completed` 先到先用、prompt-caching）仍待推进。
- `packages/contracts/python` 的 pytest 收集因缺 `jsonschema` 失败，先前既有，不在本轮范围。

## 用户验收

- 状态：等待验收
- 验收反馈：待填写
- 下一功能执行门：阻塞
