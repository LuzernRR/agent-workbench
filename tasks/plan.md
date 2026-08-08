# Implementation Plan: Issue #52 Query Strategy Protocol

## Overview

Issue [#52](https://github.com/LuzernRR/agent-workbench/issues/52) adds a bounded,
recoverable query-strategy protocol to the existing Supervisor -> Planner ->
Researcher -> Reflector -> Verifier graph. The protocol turns the current user
request into a strict private `QueryBrief`, validates channel-specific search
queries, records each real `SearchAttempt`, and drives later searches from typed
`EvidenceGap` feedback. It does not add another graph loop, search provider,
reranker, broker, or public reasoning surface.

Issue #52 is the only active feature. It has `Status: ready` and
`Execution Gate: allowed`. The user authorized Codex to run fresh verification
and pass the current acceptance when all criteria are proved.

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
  token. It now verifies an HMAC assertion over `tenant:run:visitor`. Binding all
  three prevents replaying a valid assertion onto another run of the same tenant.
- Quotas and the audit ledger live in PostgreSQL. No Redis: the authoritative run
  state is already there, and a second store would create a split source of truth.
- The audit table requires a non-null tenant, so paths where tenant cannot be
  resolved deliberately record the run's terminal `reasonCode` instead.

## Status

All implementation and verification tasks are complete; see `tasks/todo.md`.
Remaining: user acceptance, then PR, merge, Issue close, and main sync.

## Open Questions

- None blocking. OIDC provider choice is deferred to the follow-up P0-05 Issue and
  requires user input (issuer, client credentials, callback domain).
