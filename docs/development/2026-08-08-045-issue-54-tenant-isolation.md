# 045 · Issue #54 租户隔离与配额门禁

- 日期：2026-08-08
- Issue：#54（Status: ready，Execution Gate: allowed）
- 分支：`codex/issue-54-authz-quota-audit`
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

新增 `apps/web/src/server/search-agent/tenant-assertion.ts`：BFF 用 `WORKBENCH_INTERNAL_TOKEN` 对 `tenant`、`run`、`visitor` 三段做 HMAC-SHA256，每段以 UTF-8 字节长度前缀拼接（`8:tenant_1` 形式），断言体只有 `v1:<mac>`，不回显任何标识；经 `X-Workbench-Tenant-Assertion` 下发；`services/search-agent/app/main.py` 的 `_authorize_tenant` 按同一格式重建载荷并用 `hmac.compare_digest` 常量时间校验。

长度前缀是纵深防御：`app/api/schemas.py:95` 的作用域 ID 校验已把冒号与非 ASCII 挡在 API 边界之外，因此边界移位在公开接口上不可达（`test_scope_ids_cannot_carry_the_payload_separator` 锁定该门）。前缀保证即使某段将来放宽字符集，`("a","b:c","d")` 与 `("a","b","c:d")` 也不会共享 MAC。两端各钉同一个已知答案向量（`v1:246dd156…2abd0`），单侧修改格式会同时打断两个测试套件。

三元组绑定是刻意的：只签 tenant 会让一个合法断言可重放到同租户的任意 run 上，绑定 run 与 visitor 后重放即失效。未配置密钥时 `_authorize_tenant` 直接返回，把判断交回既有的 loopback 开发路径，不新增一条绕过。

### 2.3 配额与审计

`wb_quotas`、`wb_audit_events` 幂等建表见 `schema.ts`；配额检查在 `quota.ts`，QPS/并发/Token/费用四维。审计表 `tenant_id` 为 `NOT NULL`，因此 tenant 未解析的路径写不出审计行——该场景以 run 的终态 `reasonCode` 为记录，这一点是设计选择而非遗漏。

## 3. 验证

| 门禁 | 结果 |
|---|---|
| Search Agent pytest | 631 passed, 1 skipped |
| ruff / compileall | clean |
| Web vitest | 471 passed, 11 skipped |
| typecheck / lint | clean |
| Next production build | exit 0 |
| Playwright | 17 passed, 3 live-only skipped |

跨租户隔离的真实证据来自 `store.integration.test.ts`，在真实 PostgreSQL（临时库，`finally` 中 drop）上 4 passed：跨租户读、写、删除全部 fail-closed，配额拒绝生效且审计行存在。默认 `vitest run` 会跳过该文件（需 `WORKBENCH_LIVE_INTEGRATION=1`），所以只看默认套件的 11 skipped 会误判这条证据缺失。

## 4. 遗留

- 断言只覆盖 `/v1/runs/stream`。`requestSearchAgentStop` 与小红书验证端点仍只有共享 token；它们不携带 tenant 语义，但若将来按租户鉴权需要同样处理。
- `pip-audit` 未装进服务 venv（该 venv 也没有 `pip`），文档写法不可复现；可用的调用是 `uvx --python 3.12 pip-audit`，已在记录 044 说明。
- 配额是近似上限，不是精确上限。准入判定先于 run 插入单独提交（`quota.ts:158` / `store.ts:591`），换来"拒绝一定留痕"，代价是并发窗口：N 个同时入队的请求可能都读到 `concurrent_runs = limit - 1` 而全部放行，超出量最多为并发请求数。作为预算护栏可接受；**它不是安全边界**——租户隔离由每条语句上的 `visitor_id`/`tenant_id` 谓词保证，不依赖这些计数。要做成精确上限，需在整个 run 事务期间锁住租户配额行，代价是同租户入队串行化并失去上述留痕性质。
- MAC 载荷改为长度前缀（`8:tenant_1`）。此前用 `:` 直接拼接三个字段，`("a","b:c","d")` 与 `("a","b","c:d")` 会产生同一个 MAC；虽然 `app/api/schemas.py:95` 已在 schema 层拒绝含冒号的 scope ID、经公开 API 不可达，但该安全性依赖三个其他文件的不变量。现两侧同时钉住同一组已知答案向量（`v1:246dd156…`），单侧改格式会同时打断两套测试。
