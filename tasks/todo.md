# Issue #52 Delivery Checklist

- [x] Task 1: strict QueryBrief, constraints, facets, time range, and EvidenceGap
- [x] Task 2: web/X/Xiaohongshu adapters, hard-constraint and near-duplicate gate
- [x] Checkpoint: 12+ deterministic query-quality cases RED then GREEN
- [x] Task 3: Planner terms/strategy/gap/parent fields and stable attempt IDs
- [x] Task 4: idempotent SearchAttempt result, source, coverage, and gain accounting
- [x] Task 5: typed gap reconciliation and gap-bound follow-up admission
- [x] Task 6: versioned Supervisor/Planner/Reflector/Verifier prompt integration
- [x] Checkpoint: graph-level second-round gap closure and recovery proof
- [x] Task 7: five deterministic offline query-quality metrics and thresholds
- [x] Task 8: AgentEvent/log/OTel/private-analysis boundary proof
- [x] Focused Search Agent tests, Ruff, and compileall
- [x] Full Search Agent and Web verification gates
- [x] High/critical dependency gate, Compose config, health, Playwright, diff check
- [x] Controlled live web smoke with real feedback rewrite and citable Evidence
- [x] HANDOFF, production checklist, README, and Chinese development record 044
- [x] A1-A12 evidence audit and code review
- [x] Final pre-release gate re-run on the delivered tree (tests, audits, health, diff check)
- [x] Commit and push the branch, open the PR
- [x] User confirmation in this session, then merge, Issue close, main sync
      (accepted 2026-08-07; PR #53 squashed into `main` as `0ce59e6`, Issue #52
      closed as completed, feature branch deleted)

## Issue #54 · 租户隔离、配额与审计（2026-08-08）

- [x] Audit the authorization boundary and design the minimal slice
- [x] Add idempotent `wb_tenant_quotas`, `wb_tenant_usage`, and `wb_audit_events` tables
- [x] Derive tenant server-side from the visitor token, ignore request-supplied tenant
- [x] Per-tenant quotas across QPS, concurrent runs, tokens, and cost
- [x] Signed tenant assertion so Search Agent verifies instead of trusting `tenantId`
      (historical #54 implementation reused the transport token; corrected by #56)
- [x] Cross-tenant fail-closed and audit coverage, proven on real PostgreSQL
- [x] Full gates: Python 631/1, vitest 471/11, typecheck, lint, build, Playwright 17/3
- [x] HANDOFF, P0-05 roadmap status, and Chinese development record 045
- [x] User acceptance, PR #55 merge, Issue close, and main sync
      (merged as `314e28da32c37ad97596090240e8c09375e77fec`; Issue #54 closed)

## Issue #56 · 独立租户断言与授权/生命周期审计补强（2026-08-08）

- [x] A1: separate `WORKBENCH_TENANT_ASSERTION_SECRET` from the transport token
- [x] A2: fail closed before execution for missing, weak, or reused assertion secrets;
      keep only the explicit two-sided loopback development exception
- [x] A3: pin the UTF-8 length-prefixed tuple, fixed vector, constant-time comparison,
      tenant/run/visitor tampering, and exact-scope recovery replay
- [x] A4: add non-enumerating denied audit for project/thread/run/attachment and
      parent-scoped memory boundaries with `RESOURCE_NOT_OWNED_OR_MISSING`
- [x] A5: make queued and terminal Run lifecycle audit/usage share the owning
      PostgreSQL transactions; keep stop intent and late terminal handling durable
- [x] A6: add visitor/tenant and run/visitor composite ownership constraints plus
      unique queued/terminal lifecycle indexes
- [x] Add safe existing-env upgrade, rotation, restricted ACL, atomic replacement,
      implemented rollback verification, secret-output scanning, and coordinated
      three-service deployment guidance; deliberate post-replace failure injection is documented residual work
- [x] A7: freeze the latest delivered tree and record final focused/full/integration/E2E,
      Compose, dependency, health, diff, assertion-handshake, and three runtime-smoke results
- [x] A8 local: update HANDOFF, plans, record 045, production checklist, deployment
      handoff, and Chinese development record 046 with final local acceptance evidence
- [x] Reconcile all delivery documents with failed/stopped settlement, completed
      checkpoint authority, settlement status constraints, and dedicated integration DB behavior
- [x] Replace stale 046 baselines with final frozen-tree evidence and the user's
      pre-authorized Codex acceptance; keep only real GitHub metadata pending
- [x] Commit `32fdbda`, push the feature branch, and open actual PR #57
- [x] Confirm no configured CI/review blockers, merge PR #57 as `f46a04c`, close
      Issue #56, sync `main`, and record the real merge SHA

## Issue #58 · 搜索计划错误修复与确定性 fallback（2026-08-08）

- [x] Reproduce `PLAN_INITIAL_FACET_DUPLICATE` →
      `QUERY_FOLLOW_UP_LINEAGE_REQUIRED` zero-tool failure from real Runs
- [x] Add one bounded, structured, private semantic repair with stable error code
      and field path
- [x] Add validated deterministic initial/follow-up fallback with constraint,
      channel, facet, lineage, budget and near-duplicate gates
- [x] Preserve objective no-progress counting and recover zero-attempt legacy
      checkpoints without fake parent lineage
- [x] Add Web official/primary, X 90-day, Xiaohongshu, no-result, conflict,
      double-invalid, budget and resume offline cases
- [x] Final Search Agent gate: focused `200 passed`, full `665 passed / 1 skipped`,
      Ruff, compileall and diff check passed
- [x] Record the user-approved Search Experience Scheme A as the gated successor;
      do not open or implement it before #58 closes
- [x] Run final Web full/integration/type/lint/build/Playwright, dependency,
      Compose, health and diff gates
- [x] Rebuild Search Agent and complete the `forceSearch=false` real Provider smoke
- [x] Finish Chinese record 047 with final Run/test evidence
- [ ] Commit and push, create PR, resolve checks/comments, squash merge, close #58,
      sync main, and record real PR/merge IDs
- [ ] Only after #58 closure: create the Scheme A ready/allowed Issue and continue
      its implementation under the one-active-Issue gate
