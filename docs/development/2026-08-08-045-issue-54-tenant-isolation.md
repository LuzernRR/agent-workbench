# 045 · Issue #54 租户隔离与配额门禁

- 日期：2026-08-08
- Issue：#54（已验收并关闭；开发时 `Status: ready`、`Execution Gate: allowed`）
- 分支：`codex/issue-54-authz-quota-audit`
- 合并：PR #55，`main@314e28da32c37ad97596090240e8c09375e77fec`（短 SHA `314e28d`）
- 目标：把 tenant 从「调用方自述字段」改为「服务端派生 + 签名断言」，并按租户强制配额、跨租户 fail-closed、审计留痕。

## 1. 问题

改动前 tenant 有两条不可信路径：

1. BFF 侧接受请求携带的 tenant（头/cookie 都可伪造）。
2. Search Agent 完全信任请求体里的 `tenantId`，只校验共享 `X-Workbench-Token`。持有该 token 的调用方可把任意 run 绑到任意租户。

第 2 条是本次范围内最实质的漏洞：共享 token 只证明「来自内部」，不证明「属于该租户」。

## 2. 方案

### 2.1 服务端派生 tenant

`apps/web/src/server/session/visitor.ts`：`resolveVisitor` 只从访客令牌哈希查库，tenant 由 `wb_visitors` 行回读。请求里的 `x-tenant-id`、`tenant_id` cookie 一律忽略。

关键取舍：tenant 仅在会话行首次创建时用 `configuredDefaultTenant()` 播种；`ON CONFLICT` 分支只更新 `last_seen_at`，不写 `SET tenant_id`。这样改 `WORKBENCH_TENANT` 重新部署不会把存量会话静默迁移到别的租户。非法配置值回落到 `local` 而不是写入违反 CHECK 的值。

### 2.2 签名租户断言

本记录必须保留 #54 的真实历史：合并版本新增
`apps/web/src/server/search-agent/tenant-assertion.ts`，BFF 用
`WORKBENCH_INTERNAL_TOKEN` 对 tenant、run、visitor 三段做 HMAC-SHA256，每段以
UTF-8 字节长度前缀拼接（`8:tenant_1` 形式），断言体只有 `v1:<mac>`，不回显任何
标识；经 `X-Workbench-Tenant-Assertion` 下发；`services/search-agent/app/main.py`
按同一格式重建载荷并用 `hmac.compare_digest` 校验。

长度前缀是纵深防御：`app/api/schemas.py:95` 的作用域 ID 校验已把冒号与非 ASCII 挡在 API 边界之外，因此边界移位在公开接口上不可达（`test_scope_ids_cannot_carry_the_payload_separator` 锁定该门）。前缀保证即使某段将来放宽字符集，`("a","b:c","d")` 与 `("a","b","c:d")` 也不会共享 MAC。两端各钉同一个已知答案向量（`v1:246dd156…2abd0`），单侧修改格式会同时打断两个测试套件。

三元组绑定是刻意的：只签 tenant 会让一个合法断言可重放到同租户的任意 run 上，绑定
run 与 visitor 后，断言不能换到另一作用域。未配置 transport token 时，显式 loopback
开发路径仍可运行。

但 post-merge 安全审查确认：#54 原威胁模型中的攻击者正是「持有
`WORKBENCH_INTERNAL_TOKEN` 的内部调用方」。既然断言 HMAC 复用了同一 token，持有者就能为
任意 tenant/run/visitor 自行计算合法断言，因此 #54 的 MAC 只增加了作用域绑定，没有建立独立
授权边界。该缺口以及旧固定向量均由后续 Issue #56 明确接管；不能把 #56 的独立密钥方案倒写成
#54 当时已经交付的事实。

### 2.3 配额与审计

真实表名为 `wb_tenant_quotas`、`wb_tenant_usage` 与 `wb_audit_events`，幂等建表见
`schema.ts`；配额检查位于 `quota.ts`，覆盖 QPS、并发 Run、Token 与费用四维。#54 合并时
审计主要记录 Run admission 的 allowed/denied；资源授权拒绝和 queued/completed/failed/stopped
完整生命周期账本尚未覆盖，现由 Issue #56 补齐。审计表 `tenant_id` 为 `NOT NULL`，因此 tenant
无法可信解析时不能编造一个 tenant 写审计，只能让孤儿 Run 以稳定终态 reason code fail-closed。

## 3. #54 历史验证

| 门禁 | 结果 |
|---|---|
| Search Agent pytest | 631 passed, 1 skipped |
| ruff / compileall | clean |
| Web vitest | 471 passed, 11 skipped |
| typecheck / lint | clean |
| Next production build | exit 0 |
| Playwright | 17 passed, 3 live-only skipped |

跨租户隔离的真实证据来自 `store.integration.test.ts`，在真实 PostgreSQL（临时库，`finally` 中 drop）上 4 passed：跨租户读、写、删除全部 fail-closed，配额拒绝生效且审计行存在。默认 `vitest run` 会跳过该文件（需 `WORKBENCH_LIVE_INTEGRATION=1`），所以只看默认套件的 11 skipped 会误判这条证据缺失。

以上数字是 PR #55 合并时的历史证据，不代表 Issue #56 当前工作树的最终门禁；#56 的最终数字只能在
交付树冻结后写入记录 046。

## 4. 遗留与 post-merge 勘误

- 断言只覆盖 `/v1/runs/stream`。`requestSearchAgentStop` 与小红书验证端点仍只有共享 token；它们不携带 tenant 语义，但若将来按租户鉴权需要同样处理。
- `pip-audit` 未装进服务 venv（该 venv 也没有 `pip`），文档写法不可复现；可用的调用是 `uvx --python 3.12 pip-audit`，已在记录 044 说明。
- 配额是近似上限，不是精确串行上限。并发请求仍可能在 admission 窗口内超放；它只是预算护栏，
  不是租户隔离安全边界。若要精确限额，需锁住租户配额行并接受同租户入队串行化。
- post-merge 审查还发现 #54 的审计只覆盖 admission，没有完整记录资源授权拒绝和 Run 生命周期；
  这不是对历史记录的文字修饰，而是 Issue #56 的实际修复范围。
- HMAC 采用确定性固定作用域，没有 nonce 或过期时间；同一 tenant/run/visitor 的断言允许用于恢复。
  该语义在 #56 保留，并通过独立密钥、Run 唯一性、active-run 门与密钥轮换限制风险。

## 5. 验收、合并与回滚

- 用户验收后，PR #55 已合入 `main@314e28d`，Issue #54 已关闭。
- 若只回滚 #54，先暂停入口并排空/停止 Worker，再 `git revert 314e28d`，统一重建相关服务。
  若 #56 已合并，必须先回滚 #56，否则新旧断言协议会形成混合版本。
- `wb_visitors.tenant_id`、`wb_tenant_quotas`、`wb_tenant_usage`、`wb_audit_events` 及其索引可按
  expand-only 暂留；不要在代码回滚中直接 DROP。破坏性 contract 必须另立 migration，在完成备份并确认
  没有活动 Run 后执行。
- 回退到纯 #54 版本会重新引入「持有 transport token 即可伪造租户断言」的已知风险，只能作为应急
  降级，不能作为安全等价回滚。
