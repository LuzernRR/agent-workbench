# Supervisor 增加 evidence_depth 分层，单事实问题走 1 次搜索快路径

## 元数据

| 字段 | 内容 |
|---|---|
| 日期 | 2026-08-03 |
| Issue | https://github.com/LuzernRR/agent-workbench/issues/28 |
| 状态 | awaiting-acceptance |
| 目标环境 | local |

## 问题与目标

### 问题

「今天是几号？」这类单事实问题走完整搜索链路：Supervisor → Planner → Reflector →（可能再补搜）→
Writer → Verifier。实测一次简单问题要 4+ 次模型调用、47 秒，其中大部分时间花在规划、反思与可能的
多轮补搜上。用户明确要求：**「今天是几号」应该联网搜索，这是正确行为**，但链路成本应与问题复杂度
匹配——答案必须来自真实搜索结果并带来源引用，绝不凭模型记忆回答，也不写死关键词表。

### 目标

由 Supervisor 在意图识别时**语义判定**取证深度 `evidence_depth`：

- `single_fact`：一次检索读到权威正文即可确定答案（单一日期、数值、状态、定义）。必须恰好一个渠道，
  且必须给出 `fast_search`（唯一一次检索的 query 与 channel）。
- `multi_source`：需要多来源交叉、比较、汇总、推荐或存在争议。`fast_search` 必须为 null。

`single_fact` 走快路径：`plan_fast_search`（确定性，不调模型）直接以 Supervisor 给出的 query/channel
建 1 步计划 → 1 次真实搜索 → `accept_fast_evidence`（确定性，把读到正文的 Evidence 迁移到
`accepted`）→ compose → verify → finalize。

### 非目标

- **不减少搜索**：single_fact 仍然真实联网检索、仍然读正文、仍然过 Verifier 硬门禁。快路径不能跳过
  Verifier 的「missingChannels 非空必须 research_more」。
- **不用关键词表判断复杂度**：分层信号必须由模型语义判定，服务端不写关键词正则。
- **不把模型调用减到 2 次**：目标从「2 次模型调用」下调为 **3 次**（intent + compose + verify）。
  原因：两个硬门禁（`nodes.py:2530` 与 `nodes.py:2585` 的 missingChannels 检查）都位于模型节点
  `verify` 内部，用户明令不得绕过。省下来的成本是 Planner + Reflector（+ Source Curator）最多 2 次
  模型调用与最多 2 轮补搜——这才是延迟的主体。

### 验收条件

见 Issue #28 的 A1–A12。

## 根因

链路长度不是「写死了多次核验循环」，而是完整链路的四个模型节点（Planner、Reflector、Writer、
Verifier）与可能的再规划对简单问题没有任何减支路径。旧 Supervisor 只返回 `need_search/channels`，
没有取证深度维度，图无法知道「这一问一次搜索就够」。

## 方案与取舍

### 1. Schema 先行：`IntentResult` 增加两个必填字段

```python
evidence_depth: Literal["single_fact", "multi_source"]
fast_search: PlannedSearch | None
```

`model_validator` 锁死组合语义：

- 不搜索 ⇒ `evidence_depth == "multi_source"` 且 `fast_search is None`（不存在取证深度，取中性值）。
- `single_fact` ⇒ 必须给 `fast_search`、必须恰好一个渠道、`fast_search.channel ∈ channels`。
- 非 `single_fact` ⇒ `fast_search` 必须为 null。

这保证了「快路径的 query 来自 Supervisor 语义判定」，服务端从不代猜查询。两个字段都是必填（无默认值），
strict schema 兼容（`X | None` 是 required nullable，通过 preflight）。

### 2. 确定性 `plan_fast_search` 节点

不调用模型。从 `intent.fast_search` 取 query/channel，做预算裁剪（`remaining_tool_calls > 0`）与
`build_plan_snapshot` 校验后建 1 步计划（`evidence_needed = min(2, max_pages_per_call)`）。快路径
不可用或校验失败时**不自行降级搜索**，返回 `plan_ready=False / fast_path=False / replan_required=True`，
由 `route_after_fast_plan` 交回 `plan_research` 走完整链路。

### 3. 显式 `fast_path` 状态位

快路径可用的判定散落在多个节点里，若每处都重新读 `intent`，一旦降级到 `plan_research` 后
`route_after_research` 会再次命中 single_fact 条件、永远回不了完整链路。因此：

- `plan_fast_search` 置 `fast_path=True`。
- `plan_research` 的**每个**返回路径都带头清除 `fast_path=False`（到达 Planner 即不再走快路径）。

### 4. 确定性 `accept_fast_evidence` 节点（本轮的 key 发现）

完整链路的 `read → accepted` Evidence 迁移由 Reflector / Source Curator 完成（`nodes.py:2471`）。
快路径跳过了 Reflector，而 `answerable_evidence()` 只接受 `accepted/cited`——若不加这个节点，快路径
的 Evidence 将永远处于 `read`、永远不可作答，compose 拿不到任何可引用来源。

`accept_fast_evidence` 是确定性节点，不调模型：把本轮状态机中 `read` 的 Evidence 全部以
`FAST_PATH_BODY_READ` 迁移到 `accepted`（合法迁移，见 `_ALLOWED_TRANSITIONS["read"]`）。判据是客观的
「正文已成功读取」，不是模型意见，所以可以放在确定性节点里。随后 `route_after_research` 在
`fast_path=True` 且存在已读正文 Evidence 时路由到这里；证据不足/渠道缺口仍由 `verify` 的既有硬门禁
拦截并退回补搜。

### 5. Router 改动

- `route_after_intent`：`need_search=False` 或预算不足 → compose；`_fast_search_request(state)` 可用 →
  `plan_fast_search`；否则 `plan_research`。
- `route_after_fast_plan`：`plan_ready` → `mark_plan_running`，否则 → `plan_research`（降级）。
- `route_after_research`：计划未完成 → 继续 `mark_plan_running`；`fast_path=True` 且存在
  read/accepted/cited Evidence → `accept_fast_evidence`；否则 `reflect`。
- `build.py`：conditional-edge 目标 map 必须显式加入新分支目标（`plan_fast_search` /
  `accept_fast_evidence`）。

### 6. Prompt

`PROMPT_VERSION = "2026-08-03.v41-supervisor-evidence-depth"`。Supervisor 提示词追加五行，明确
`evidence_depth` 的语义判据（只依据问题语义，不依据关键词或模板；不确定选 multi_source）、
single_fact 的约束（一个渠道 + fast_search，query 要保留专有名词/地域/绝对日期、相对时间按输入中的
当前日期换算），以及明示「选择 single_fact 不会跳过搜索与核验，没读到正文会退回完整链路」。

## 完整执行链路

快路径：`load_context → classify_intent → plan_fast_search → mark_plan_running → Send(research) →
merge_research → accept_fast_evidence → compose → verify → finalize`。3 次模型调用（supervisor、writer、
verifier）、1 次工具调用。verify 判 `research_more` 时回到 `plan_research`，`fast_path` 已清除，
完整链路自然接管。

## 异常、取消与恢复

- 快路径不可用（intent 缺 fast_search / 渠道非法 / 预算为 0 / 计划校验失败）→ `plan_fast_search`
  返回不可用标记，路由降级到 `plan_research`，不自行编造查询。
- 没读到正文 → `route_after_research` 不进 `accept_fast_evidence`，回到 `reflect` 走完整链路。
- 后续 verify 判证据不足 → `research_more` → `plan_research`（清 fast_path）→ 完整链路补搜。
- `accept_fast_evidence` 只迁移 `read`，已 `rejected`/终态条目不受影响，迁移幂等。

## 数据与安全

两个新节点都是确定性节点，不调模型、不产生模型调用计数、不发公开模型摘要（`_PUBLIC_SUMMARY_NODES`
不含它们）。query/channel 完全来自 Supervisor 结构化输出，服务端只做预算裁剪与稳定 ID 分配，不在
服务端拼接或改写查询文本。未触碰密钥、Cookie、Prompt 版本外的任何安全边界；SSRF / robots 门禁不变。

## 验证证据

| 验收项 | 证据 | 结果 |
|---|---|---|
| A1/A2/A3/A4 schema 组合校验 | `test_single_fact_requires_fast_search_and_single_channel` / `test_single_fact_valid_combination_is_accepted` / `test_every_production_structured_schema_is_provider_strict` | 通过 |
| A5 快路径 1 次工具 + 3 次模型 | `test_single_fact_fast_path_uses_one_tool_and_three_model_calls`：`tool_calls == 1`、`{'supervisor':1,'writer':1,'verifier':1}`、节点序列 `load_context, classify_intent, plan_fast_search, mark_plan_running, merge_research, accept_fast_evidence, compose, verify, finalize`、`fast_path is True`、citations 全部指向 Evidence | 通过 |
| A6 计划与证据原样交给前端 | `test_single_fact_fast_path_preserves_plan_and_evidence_for_frontend`：1 步计划、Evidence 迁移到 `accepted`、引用非空 | 通过 |
| A7 零证据退回完整链路 | `test_single_fact_fast_path_with_zero_evidence_falls_back_to_full_plan`：reflect 与 planner 重新介入，`fast_path is False` | 通过 |
| A9 后续 research_more 降级 | `test_single_fact_fast_path_downgrades_to_full_plan_on_research_more`：`plan_research` 被访问、`reflect` 返回、`fast_path is False` | 通过 |
| A12 门禁 | `pytest -q` = `390 passed`；`ruff check .` = All checks passed；`compileall` = 0；`git diff --check` = 0；7 个改动文件 UTF-8 + LF + 无 BOM | 通过 |

前端安全性由既有测试锁定：`reducer.ts` 的 `sourcePresentations.size &&` 守卫保证跳过 reflect（无
`source_presentations`）时保留既有 `displayText`，不清空 UI、不逼前端自造过程文案（`AGENTS.md:50`）。

## 回滚

改动集中在 4 个生产文件（schemas / state / nodes / build / prompts）与 2 个测试文件。回滚即还原
diff：`IntentResult` 退回两字段旧版，`route_after_intent` 不再有 `plan_fast_search` 分支，
`fast_path` 状态位与新节点随图装配移除，行为回到「一切需要搜索的问题都走完整链路」。

## 未解决问题

- **`nodes.py:394` `_freshness_required()` 关键词正则**仍会覆盖 Supervisor 的 `evidence_depth` 语义
  （`prompts/agents.py:23` 与之相悖）。按用户要求，待本分层上线并验证稳定后单独开 Issue 移除，
  不与性能改造混在一起。
- 后续阶段（2–5）按序排队：Writer 流式、researcher 降 effort、`asyncio.as_completed` 先到先用、
  prompt-caching 等，一 Issue 一 feature。
- `.baseline/` 与 `scripts/latency_baseline.py` 为延迟基线探针（脚本目标端口 8100 已失效，需指向容器
  的 `127.0.0.1:8080`），不属本 Issue 交付物，未跟踪。

## 用户验收

- 状态：等待验收
- 验收反馈：待填写
- 下一功能执行门：阻塞
