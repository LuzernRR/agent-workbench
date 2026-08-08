# Implementation Plan: Issue #52 Query Strategy Protocol

## Overview

Issue [#52](https://github.com/LuzernRR/agent-workbench/issues/52) adds a bounded,
recoverable query-strategy protocol to the existing Supervisor -> Planner ->
Researcher -> Reflector -> Verifier graph. The protocol turns the current user
request into a strict private `QueryBrief`, validates channel-specific search
queries, records each real `SearchAttempt`, and drives later searches from typed
`EvidenceGap` feedback. It does not add another graph loop, search provider,
reranker, broker, or public reasoning surface.

This section is the historical plan for #52, which has already been accepted and
merged. The current active feature is Issue #58 in the later plan section; do not
use this historical gate to infer current execution state.

## Architecture Decisions

- Keep one LangGraph loop. Extend the existing structured outputs and private
  state instead of adding a query-expansion agent or an independent pipeline.
- Treat `QueryBrief` as the normalized truth for must/should/exclude, absolute
  time range, location, language, required channel, requested fields, and
  evidence facets. Only `should` constraints can be explicitly relaxed.
- Let the model propose terms and queries; let deterministic code enforce
  schema, channel syntax, hard-constraint retention, lineage, near-duplicate,
  budget, and no-progress rules.
- Give every accepted plan step and tool execution a stable `attemptId`.
  Recovery reuses the same ID and Tool Ledger call; merge is idempotent and
  rejects conflicting replay.
- Reconcile typed `EvidenceGap` records after each real tool result. A follow-up
  must name an open gap, its parent attempt, and an allowed rewrite strategy.
- Measure progress from new candidate URLs, new Evidence, or newly covered hard
  constraints, never from query string variation alone.
- Keep `QueryBrief`, query terms, constraint signatures, gap detail, and attempt
  analysis private. Existing public plan/tool events remain the only boundary
  and continue through the runtime privacy validator.

## Source-Driven Design

- ReAct, Self-Ask, and IRCoT support decomposing multi-step questions and
  interleaving retrieval with observed results.
- CRAG supports a retrieval-quality evaluator that selects corrective actions;
  this maps to typed `EvidenceGap` rather than a second model loop.
- Adaptive-RAG supports the existing no-search/single-search/iterative routing.
- FLARE contributes only the evidence-deficit trigger; token-level confidence
  retrieval is out of scope.
- Query2doc, unrestricted RAG-Fusion, and Search-R1 training are not adopted:
  they add hallucinated pseudo-documents, unbounded query cost, reranking, or RL
  infrastructure outside this issue.
- Platform behavior follows official Tavily Search, X query construction,
  Azure agentic retrieval, Google Search grounding, and LangGraph workflow docs.

## Task List

### Phase 1: Strict Query Contract

- [x] Task 1: Add strict `QueryBrief`, constraint, time-range, facet, gap, and
  rewrite-strategy Pydantic contracts with hostile-output validation and safe
  legacy checkpoint normalization.
- [x] Task 2: Add deterministic channel adapters and query gates for web, X,
  and Xiaohongshu, including hard-constraint signatures and near-duplicate
  detection.

### Checkpoint: Query Contract

- [x] New schema and query-strategy tests pass before graph integration.
- [x] At least 12 deterministic Chinese/English/date/location/platform/version/
  exclusion/field/channel cases prove exact retention and fail-closed behavior.

### Phase 2: Recoverable Search Loop

- [x] Task 3: Extend Planner/runtime requests with stable facet, terms,
  strategy, gap/parent lineage, constraint signature, and `attemptId`.
- [x] Task 4: Record idempotent `SearchAttempt` outcomes at merge, including
  unique domains, new candidate/Evidence/constraint counts, and objective
  progress.
- [x] Task 5: Reconcile typed `EvidenceGap` state from Reflector/Verifier and
  admit only gap-bound, strategy-compatible follow-ups.
- [x] Task 6: Update versioned prompts and routing so first-round plans contain
  one or two complementary facets and later plans use real attempt feedback.

### Checkpoint: Graph Closure

- [x] Focused graph tests prove a second-round query names the first-round gap
  and parent attempt, preserves every hard constraint, and gains Evidence.
- [x] Zero results, unreadable body, conflict, missing channel, and missing field
  produce distinct gap kinds and rewrite strategies.
- [x] Exact replay neither re-executes a confirmed attempt nor duplicates state.

### Phase 3: Evaluation And Privacy

- [x] Task 7: Add deterministic offline metrics for constraint retention,
  facet coverage, duplicate-query rate, gap closure, and Evidence gain, with
  regression thresholds and a fixed query-quality fixture.
- [x] Task 8: Prove private query analysis never enters public AgentEvent,
  logs, OTel spans, error messages, or frontend-invented process text.

### Checkpoint: Quality Gate

- [x] Fixed fixtures achieve 100% hard-constraint retention, 0% duplicate
  execution, full expected gap closure, and positive Evidence gain.
- [x] Existing evaluation, event validation, Tool Ledger, and checkpoint tests
  remain green.

### Phase 4: Verification And Handoff

- [x] Task 9: Run focused tests, full Search Agent/Web gates, dependency audit,
  Compose parsing, health checks, Playwright, and `git diff --check`.
- [x] Task 10: Run a controlled live web smoke that shows an actual first query,
  result-driven rewrite, and final citable Evidence without exposing secrets.
- [x] Task 11: Update `HANDOFF.md`, production checklist, Search Agent README,
  and Chinese development record 044 with sources, evidence, rollback, and
  explicit non-goals.
- [x] Task 12: Review all A1-A12 evidence, re-run every repository gate on the
  delivered tree, create the PR, and record findings. Merging, closing Issue #52,
  and synchronizing `main` remain blocked on explicit user confirmation in the
  active session, because those actions are irreversible and outward-facing.

### Checkpoint: Complete

- [x] Every A1-A12 criterion has direct test, runtime, or document evidence.
- [x] Code review covers correctness, readability, architecture, security,
  performance, dependency discipline, and rollback.
- [x] Branch committed and pushed, PR opened, working tree clean.
- [x] PR merged, Issue #52 closed, and `main` synchronized. Accepted by the user
  on 2026-08-07; PR #53 squashed into `main` as `0ce59e6`, Issue #52 closed as
  completed, and the feature branch deleted.

## Task Details

### Task 1: QueryBrief And Gap Contracts

**Acceptance criteria:** All fields are explicit provider-strict properties;
unknown fields, controls, prompt-like directives, invalid IDs/dates, excessive
text, and list overflow fail closed. Direct answers use `query_brief=null`.
Legacy state normalizes to a bounded safe brief without inventing constraints.

**Verification:** `pytest -q tests/test_query_strategy.py tests/test_strict_schema_compatibility.py`.

**Dependencies:** None.

**Files likely touched:** `app/graph/query_strategy.py`, `app/graph/schemas.py`,
`app/graph/state.py`, and focused tests.

### Task 2: Channel And Constraint Gate

**Acceptance criteria:** web accepts supported authority/phrase/time syntax; X
accepts supported account/topic/since/until syntax and rejects web-only
operators; Xiaohongshu accepts compact natural keywords and rejects operator
leakage. Must, time, location, required channel, and exclude semantics cannot be
silently removed; only declared should IDs may be relaxed.

**Verification:** focused parametrized unit tests covering all three channels,
constraint loss, valid complementarity, and near duplicates.

**Dependencies:** Task 1.

### Task 3: Stable Planned Attempts

**Acceptance criteria:** Planner output explicitly names `facetId`, `queryTerms`,
`strategy`, `gapId`, `parentAttemptId`, retained/relaxed constraints, and query.
Service-generated `attemptId` is stable for identical input and survives state
recovery. First round admits no more than two distinct facets.

**Verification:** structured-plan and state/recovery tests.

**Dependencies:** Tasks 1-2.

### Task 4: Attempt Outcomes

**Acceptance criteria:** Every confirmed tool call has one private attempt
outcome with actual result/Evidence counts, unique domains, delta counts, and a
progress flag. Duplicate merge is idempotent; conflicting same-ID input fails.

**Verification:** fan-out, Tool Ledger, merge, and checkpoint tests.

**Dependencies:** Task 3.

### Task 5: EvidenceGap Feedback

**Acceptance criteria:** Reflector and Verifier emit typed gaps; service assigns
stable IDs and closes them only after linked progress. Follow-ups referencing an
unknown/closed gap, unknown parent, incompatible strategy, or lost constraint
are rejected before external execution.

**Verification:** unit tests plus graph-level two-round scenario.

**Dependencies:** Tasks 3-4.

### Task 6: Prompt And Routing Integration

**Acceptance criteria:** Supervisor preserves named entities, versions, dates,
regions, channels, fields, and exclusions in the private brief. Planner receives
compressed real feedback and open gaps. Public summaries still come only from
versioned model outputs and never reveal the private analysis.

**Verification:** prompt contract tests and deterministic fake-model graph tests.

**Dependencies:** Tasks 1-5.

### Task 7: Offline Quality Metrics

**Acceptance criteria:** Evaluation reports five deterministic query dimensions.
Metrics inspect private final-state fixtures, make no model/network calls, and
have positive and negative tests. Existing cases without query data remain
backward compatible.

**Verification:** `pytest -q tests/test_evaluation_scorers.py tests/test_evaluation_runner.py`.

**Dependencies:** Tasks 3-5.

### Task 8: Privacy Boundary

**Acceptance criteria:** No public event/span/error contains `queryBrief`, query
terms, constraint signatures, gap descriptions, provider body, Prompt, Cookie,
or Key. Existing allowed tool query fields remain validated public inputs.

**Verification:** event/observability tests and serialized stream scan.

**Dependencies:** Tasks 3-7.

### Tasks 9-12: Release Closure

**Acceptance criteria:** All repository gates pass on the final tree; controlled
live evidence is recorded; documentation explains adopted/rejected approaches,
rollback and limits; PR/Issue/main status are consistent and the user-authorized
acceptance is recorded only from fresh evidence.

**Dependencies:** Tasks 1-8.

## Risks And Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Lexical retention rejects legitimate semantic rewrites | High | Model supplies explicit terms/aliases; gate checks stable IDs plus terms and allows only documented strategy changes. |
| Extra state inflates checkpoints | Medium | Store bounded summaries, IDs, counts, and domains only; never Provider bodies or full pages. |
| Query analysis leaks through existing events/spans | High | Do not add private fields to event contracts; scan full events/spans deterministically. |
| Follow-up IDs drift after resume | High | Hash canonical run/round/facet/gap/parent/query material and reject conflicting replay. |
| Xiaohongshu cannot express Boolean exclusion | Medium | Preserve exclusion in private constraint metadata and evidence filtering; reject web/X operators rather than pretending they work. |
| Broad query expansion burns tool budget | High | First round 1-2 facets, follow-ups only for open gaps, existing max rounds/tool calls, near-duplicate and no-progress stops. |
| Prompt schema breaks provider strict mode | High | Keep every structured field required and run provider schema preflight tests before graph work. |

## Open Questions

- None. Issue #52 defines the scope, non-goals, architecture, acceptance criteria,
  and execution gate; the user explicitly authorized autonomous fresh acceptance.

---

# Implementation Plan: Issue #54 Tenant Isolation, Quotas, And Audit

## Overview

Issue [#54](https://github.com/LuzernRR/agent-workbench/issues/54) is the minimal
rollbackable slice of P0-05. It moves tenant from a caller-asserted field to a
server-derived, signed identity, adds per-tenant quotas, and records authorization
outcomes. Real OIDC/RBAC/RLS stay out of scope and remain blocked.

## Architecture Decisions

- Tenant is read back from the `wb_visitors` row, never from a request header or
  cookie. It is seeded only when the session row is first created, so changing
  `WORKBENCH_TENANT` cannot migrate existing sessions into another tenant.
- The Search Agent previously trusted the request-body `tenantId` behind a shared
  token. Issue #54 added a UTF-8 length-prefixed HMAC over tenant, run, and visitor,
  but the merged implementation used the transport token itself as the HMAC key.
  That binding prevented cross-run replay for callers without the token, but it did
  not establish an authorization boundary against the threat actor defined by the
  Issue. Issue #56 is the explicit post-merge correction.
- Quotas and the audit ledger live in PostgreSQL. No Redis: the authoritative run
  state is already there, and a second store would create a split source of truth.
- The audit table requires a non-null tenant, so paths where tenant cannot be
  resolved deliberately record the run's terminal `reasonCode` instead.

## Status

Accepted and merged. PR
[#55](https://github.com/LuzernRR/agent-workbench/pull/55) merged into `main` as
`314e28da32c37ad97596090240e8c09375e77fec`; Issue #54 is closed. The historical
verification numbers remain in development record 045. Post-merge findings are
tracked only in Issue #56 rather than rewriting #54 as if it had shipped the
independent secret and complete lifecycle audit.

## Open Questions

- None blocking. OIDC provider choice is deferred to the follow-up P0-05 Issue and
  requires user input (issuer, client credentials, callback domain).

---

# Implementation Plan: Issue #56 Tenant Assertion And Audit Follow-up

## Overview

Issue [#56](https://github.com/LuzernRR/agent-workbench/issues/56) repaired the
post-merge gaps in #54 without expanding into
OIDC, RBAC, ABAC, RLS, exact serialized quotas, or a new public memory API.
The GitHub gate remains `Status: ready` and `Execution Gate: allowed`. The user
pre-authorized Codex to accept after fresh verification. The final tree has now
passed the local acceptance gates and rebuilt-image runtime smokes, so local status
is `accepted`; PR #57 was squash-merged as `f46a04c`, Issue #56 is closed, and
local `main` is synchronized with `origin/main`.

## Acceptance Slices

- A1-A3: use an independent `WORKBENCH_TENANT_ASSERTION_SECRET`, fail closed on
  missing/weak/reused configuration, preserve the cross-language UTF-8
  length-prefixed payload, fixed vector, constant-time comparison, and exact-scope
  recovery replay behavior.
- A4: map cross-subject missing/not-owned project, thread, run, attachment, and
  parent-scoped memory operations to non-enumerating responses and durable denied
  audit rows with `RESOURCE_NOT_OWNED_OR_MISSING`.
- A5: commit allowed admission, Run insertion, queued lifecycle, terminal status,
  terminal usage, public terminal event, and one terminal lifecycle audit in their
  corresponding PostgreSQL transactions; rollback must not leave phantom usage or
  lifecycle rows.
- A6: enforce visitor/tenant and run/visitor ownership with composite foreign keys
  on `wb_tenant_usage` and `wb_audit_events`, plus unique queued/terminal lifecycle
  indexes keyed by tenant and Run.
- A7: use deterministic Node/Python tests and real PostgreSQL integration tests,
  then run the applicable full Web/Search Agent, type, lint, build, Playwright,
  Compose, dependency, and diff gates. Final evidence is Web `573 passed / 31
  skipped`, critical focused `89 passed`, dedicated PostgreSQL integration `31
  passed`, Search Agent `647 passed / 1 skipped`, and Playwright `17 passed / 3
  live-only skipped`; all build/lint/type/Compose/audit/diff gates passed.
- A8: update HANDOFF, tasks, record 045, the production checklist, deployment
  handoff, and a new Chinese record 046. PR and merge data remain explicit
  placeholders until those actions really occur.

## Architecture And Operational Decisions

- The transport token and tenant assertion secret are separate trust material.
  The assertion is deterministic and bound to the exact tenant/run/visitor tuple;
  no nonce or expiry is added because same-scope replay is required for checkpoint
  recovery. Run identity, active-run rejection, checkpoint authority, and secret
  rotation limit the replay surface.
- The authoritative tables are `wb_tenant_quotas`, `wb_tenant_usage`, and
  `wb_audit_events`. Authorization denial and Run lifecycle use stable action,
  outcome, reason code, resource kind, and resource ID fields; no prompt, question,
  cookie, token, or provider body is stored.
- Existing environments upgrade through `deploy/new-local-env.ps1
  -UpgradeTenantAssertionSecret`. Rotation has no dual-key window, so Web, Worker,
  and Search Agent are recreated as one release unit.
- Direct `run.failed` and `run.stopped` events without a checkpoint boundary use a
  two-phase `stage -> transactional consume` protocol backed by the
  immutable `wb_run_terminal_settlements` table. Pending settlement is authoritative
  before ordinary input parsing, upstream reconnect, checkpoint terminal, HTTP stop
  fallback, or generic zero-usage fallback. Same-hash stage is idempotent,
  different-hash stage conflicts, and owner/epoch fencing protects takeover. A
  direct `run.completed` without a checkpoint boundary is rejected; completed
  projection must use the checkpoint transaction. Database checks additionally
  require pending rows to have `settled_status IS NULL`, stopped source to settle
  only as stopped, and failed source to settle as failed or as stopped when a real
  stop intent won the race.
- PostgreSQL integration verification requires an explicit
  `WORKBENCH_INTEGRATION_DATABASE_URL`; the runner accepts only loopback PostgreSQL
  databases whose names end in `_test` or `_integration` and never falls back to
  the business database.
- Python tests lock `NodeName`, `_AGENT_BY_NODE`, and the actual LangGraph node set;
  Web validates all current 12 node-agent pairs and rejects a mismatched role. The
  cross-language list is still manually mirrored and remains a documented future
  contract-generation opportunity.
- Rollback is expand-only at the database boundary. Revert #56 before #54, stop
  intake and drain/stop Worker first, and never roll back only Search Agent. The
  #54 merge commit is `314e28d`; the #56 merge commit is `f46a04c`.

## Known Residual Boundaries

- Compose pins Search Agent with `container_name`, while cancellation uses an
  in-memory `RunRegistry`; the current deployment is intentionally single-replica
  for cancellation routing. Horizontal scale needs an external cancel registry or
  deterministic replica routing and removal of fixed container names.
- There is no independent public memory CRUD API. Memory isolation is proved
  through the owning visitor/thread/project/run predicates and direct database
  constraints; a future memory endpoint must add its own authorization and audit.
- `WORKBENCH_API_ORIGIN` bypasses the local `handleLive` authorization/audit path.
  Any external backend enabled through that seam must implement an equivalent
  non-enumerating authorization and lifecycle ledger before production use.
- The explicit insecure loopback exception is development-only. Stop and
  Xiaohongshu verification endpoints still carry transport authentication rather
  than tenant semantics. Quotas remain approximate admission controls, not the
  tenant-isolation security boundary.
- GitHub Issue #27 remains open. Its elapsed-time behavior must be reconciled and
  closed separately; this security follow-up must not claim that governance step.
- Final runtime probing also exposed a separate query-planning robustness defect:
  a generic Agent-framework research request can be rejected by
  `PLAN_INITIAL_FACET_DUPLICATE` and then `QUERY_FOLLOW_UP_LINEAGE_REQUIRED`, ending
  partial with zero tool calls. This belongs in a new post-#56 search Issue and is
  not silently folded into the tenant-assertion change.

## Status

Status is `accepted`, merged, and closed. Final rebuilt-image evidence:
completed `run_4d4a46dfd9034199838cb80807e67868`, direct failed
`run_3342b99584ef4dbb97bcda830751ff0e`, and active stop
`run_60623f90c32e4012aef9bd71ce1ae726`; each has one public terminal, consistent
usage/audit/outbox, cleared lease, no pending settlement, and stable SSE replay.
PR #57 had no configured check runs, review requests, or comments and was
`MERGEABLE/CLEAN`; it was squash-merged as `f46a04c`, Issue #56 was closed, and
`main` was synchronized. A next feature may start only through a new ready Issue.

---

# Implementation Plan: Issue #58 Query-plan Repair And Deterministic Fallback

## Overview

Issue [#58](https://github.com/LuzernRR/agent-workbench/issues/58) repairs the
post-#52 path where an explicit research request could be rejected twice by the
semantic plan gate and end partial with zero tool calls. The branch is
`codex/issue-58-query-plan-fallback`; GitHub has `Status: ready` and
`Execution Gate: allowed`. The user authorized implementation and Codex-owned
acceptance after fresh verification. Status remains `executing` until every
runtime/release gate, PR, merge, Issue close, and main synchronization step is real.

## Architecture Decisions

- Keep the model as the first query planner. On a stable `PLAN_*`/`QUERY_*`
  rejection, send one bounded private repair request containing `errorCode`,
  `fieldPath`, a bounded rejected plan, the current QueryBrief and hard IDs.
- If the repaired plan is still invalid, build a deterministic minimum plan from
  the same private QueryBrief. It still passes the existing plan and query gates;
  fallback is not an alternate trust boundary.
- Initial fallback chooses at most two distinct facets and authorized channels.
  Follow-up fallback requires an open EvidenceGap and a real same-facet parent
  SearchAttempt, except the existing narrow `facet_discovery` rule.
- Preserve must/exclude/date/location/channel signatures deterministically;
  account for should constraints through retain/relax metadata; add evidence type,
  requested field and language cues without generating channel-invalid syntax.
- X bilingual requirements distribute one `lang:` value per attempt. Xiaohongshu
  remains a bounded natural-language query. Planner activity never resets the
  objective no-progress counter because a new query string is not evidence gain.
- Treat the accepted plan as the authorization boundary for distributed initial
  `should` constraints. A pending request may use aggregate accounting only when
  it exactly matches a current/historical initial PlanStep and the complete plan
  accounts for every `should`; unbound checkpoint requests still fail closed.
- Keep repair details and QueryBrief-derived fields private. Public `plan.updated`
  may state only `planSource=runtime`; it never includes rejected plan data.

## Delivery Checklist

- [x] Reproduce the two zero-tool failures and prove that Provider availability
  was not the cause.
- [x] Add structured private validation feedback and at most one semantic repair.
- [x] Add stable initial/follow-up deterministic fallback with strict constraint,
  channel, budget, lineage and near-duplicate validation.
- [x] Preserve no-progress semantics and legacy zero-attempt checkpoint recovery.
- [x] Add offline coverage for Web official/primary sources, X 90-day windows,
  Xiaohongshu natural queries, no-result relaxation, source conflicts, double
  invalid planner output, finalization reserve and resumed legacy state.
- [x] Freeze documentation and run final Search Agent gates: focused `200 passed`,
  full `665 passed / 1 skipped`, Ruff, compileall and diff check passed.
- [x] Run Web unit/integration/type/lint/build/Playwright, dependency, Compose,
  health and diff gates on the final tree.
- [x] Rebuild Search Agent and prove `forceSearch=false` real Provider execution
  for the exact generic Agent-framework prompt, with a non-empty toolCallId,
  SearchAttempt, safe terminal and no planner-rejection zero-tool partial.
- [x] Complete record 047 with local test and Run evidence.
- [x] Commit/push and create PR #59.
- [ ] Complete PR #59 review/checks, squash merge, close #58,
  synchronize main, and replace placeholders with real IDs/SHAs.

## Acceptance And Rollback

- Acceptance is determined only from Issue #58 A1-A8 and fresh frozen-tree
  evidence. The user has pre-authorized Codex to make that determination after
  verification; it is not a waiver of any gate.
- Zero tool calls are valid only for stable budget/config/provider/user-stop
  reasons. A planner schema/semantic failure with available channel and budget
  must either execute the validated model plan or the deterministic fallback.
- Rollback stops Worker intake first, reverts the eventual #58 merge commit, and
  rebuilds Search Agent/Worker/Web as one release. The added state counters have
  stable defaults and may remain in old checkpoints.

---

# Approved Successor Plan: Search Experience Scheme A

## Gate And Scope

The user approved Scheme A on 2026-08-08. It is deliberately a successor to
#58, not part of #58: the repository permits one active feature at a time. After
#58 is merged and closed, create one new Issue with ready/allowed labels and the
DoD below before editing experience-memory code.

## Source-driven Design

- Microsoft Search Task Trails motivates learning from the sequence of queries
  and clicks/results belonging to one task rather than isolated query strings:
  https://www.microsoft.com/en-us/research/publication/evaluating-the-effectiveness-of-search-task-trails/
- MemSearcher and MapAgent support compact task-relevant memory and reusable
  search trajectories instead of replaying complete conversation history:
  https://aclanthology.org/2026.findings-acl.736/ and
  https://arxiv.org/abs/2507.21953
- Cache-freshness research requires explicit provenance, observation time and
  invalidation rather than assuming a past result is still true:
  https://conferences.sigcomm.org/hotnets/2024/papers/hotnets24-21.pdf
- LangGraph persistence provides a checkpoint/store integration point, but the
  domain contract remains project-owned and versioned:
  https://reference.langchain.com/python/langgraph/overview
- Similar-session recommendation supports coarse retrieval by task/session
  resemblance before fine-grained ranking:
  https://ojs.aaai.org/index.php/AAAI/article/view/25607

## Proposed Architecture

1. Persist a private, tenant/project-scoped `SearchExperience` only from a
   verified terminal task. Record QueryBrief/constraint fingerprints, facets,
   channels, rewrite sequence, SearchAttempt gains, EvidenceGap closure, source
   provenance/hash/capturedAt, freshness class, cost/latency and graph/prompt/tool
   versions. Do not store raw Provider bodies or public reasoning.
2. Recall in coarse-to-fine order: exact hard-constraint signature; compatible
   facet/channel/source tier; semantic task similarity; ACL/provenance/freshness;
   historical verified reward. A stale or version-incompatible item is excluded
   or down-ranked with a stable reason.
3. Inject only compact strategy/query cues into Planner. Historical Evidence is
   never current Evidence: every recalled path must execute a fresh search and
   pass the existing QueryBrief, lineage, Evidence and citation gates.
4. Add offline replay first. Compare baseline versus experience-assisted paths on
   tool calls, time-to-first-Evidence, constraint retention, duplicate rate, gap
   closure, answer support, cost and latency.
5. Log contextual-bandit features and observed rewards, but do not make online
   exploration decisions in phase one. Enable adaptive selection only after a
   sufficiently large, bias-audited label set and an independent Issue/ADR.

## Successor DoD

- Exact tenant/project/ACL isolation; failed, stopped, unverified or sensitive
  runs cannot enter the experience store.
- Idempotent write/replay, bounded retention, provenance/hash/version/freshness
  invalidation and user/tenant deletion propagation are tested.
- Retrieval ranking is deterministic for equal inputs and exposes private stable
  selection/rejection reason codes without leaking experience data publicly.
- An offline golden set proves no regression in hard constraints or citations and
  a measurable gain in at least two of: fewer duplicate calls, faster first
  Evidence, higher gap closure, lower cost, or higher verified task success.
- Cold start, no-match and stale-only states behave exactly like the #58 baseline;
  disabling the feature is a one-flag rollback with no data loss or split truth.
