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
- [x] Add idempotent `wb_quotas` and `wb_audit_events` tables
- [x] Derive tenant server-side from the visitor token, ignore request-supplied tenant
- [x] Per-tenant quotas across QPS, concurrent runs, tokens, and cost
- [x] Signed tenant assertion so Search Agent verifies instead of trusting `tenantId`
- [x] Cross-tenant fail-closed and audit coverage, proven on real PostgreSQL
- [x] Full gates: Python 631/1, vitest 471/11, typecheck, lint, build, Playwright 17/3
- [x] HANDOFF, P0-05 roadmap status, and Chinese development record 045
- [ ] User acceptance, then PR, merge, Issue close, main sync
