# Implementation Plan: Issue #50 Checkpoint Atomic Confirmation

## Overview

Issue [#50](https://github.com/LuzernRR/agent-workbench/issues/50) establishes a recoverable two-transaction protocol between the Python LangGraph checkpoint transaction and the Node PostgreSQL projection transaction. The Node run ledger is the only authority for resume; source events stay buffered until a readable checkpoint boundary can atomically advance the run revision, checkpoint reference, inbox, projected AgentEvents, and transactional outbox.

Issue status is `ready` and `Execution Gate: allowed`. Implementation and technical
verification are complete. The user explicitly accepted the feature on 2026-08-06 and
authorized Codex to pass the current acceptance after fresh verification; delivery is
finishing the PR/Issue merge closure. This plan covers only Issue #50.

## Architecture Decisions

- Keep the Python checkpoint transaction and Node projection transaction explicit and separate. No XA or cross-service atomicity claim.
- Treat `(run_id, checkpoint_ns, checkpoint_id)` recorded on `wb_runs` as the only automatic resume authority. A newer unconfirmed LangGraph checkpoint is an orphan.
- Use a private `checkpoint.committed` source event as the batch delimiter. It contains identifiers and step metadata only, never checkpoint State values.
- Commit each source batch with lease fencing, parent continuity, revision increment, source inbox deduplication, AgentEvent projection, and outbox rows in one Node transaction.
- Keep PostgreSQL-backed SSE cursor polling authoritative. `NOTIFY` is only a low-latency wake-up and may be lost without losing events.
- Preserve stable tool call IDs and fail closed for unknown Tool Ledger outcomes during replay.

## Task List

### Phase 1: Contract And Checkpoint Boundary

- [x] Task 1: Add validated checkpoint resume fields to Python and Node request contracts.
- [x] Task 2: Emit readable LangGraph checkpoint boundaries with synchronous durability.

### Checkpoint: Python Boundary

- [x] Focused Python and Node contract tests pass.
- [x] A checkpoint boundary is emitted only after exact `aget_state` succeeds and exposes no State body.

### Phase 2: Durable Projection

- [x] Task 3: Add idempotent run revision, checkpoint commit, source inbox, and event outbox schema.
- [x] Task 4: Add the fenced, parent-contiguous, idempotent checkpoint batch transaction.
- [x] Task 5: Buffer source events in the Worker and resume only from the run ledger authority.
- [x] Task 6: Add the bounded `SKIP LOCKED` outbox dispatcher while retaining SSE polling fallback.

### Checkpoint: Transaction Protocol

- [x] Focused Web tests and isolated PostgreSQL integration tests pass.
- [x] Fault injection proves no partial run/inbox/event/outbox visibility.
- [x] Duplicate batches are idempotent and conflicting batches fail closed.

### Phase 3: Recovery Proof And Handoff

- [x] Task 7: Prove orphan-checkpoint recovery, stable Tool Ledger replay, Worker kill recovery, and SSE cursor replay.
- [x] Task 8: Update production queue, Chinese development record, HANDOFF, and verification evidence.

### Checkpoint: Complete

- [x] Issue #50 acceptance criteria A1-A11 have direct evidence.
- [x] Web and Search Agent full verification gates pass.
- [x] Runtime/Compose checks and `git diff --check` pass.
- [x] User acceptance recorded after fresh full verification; no next feature has started.

## Task Details

### Task 1: Validated Resume Contract

**Acceptance criteria:** Invalid identifiers, incomplete checkpoint references, and checkpoint IDs on non-resume requests fail closed. The Node client serializes an authoritative checkpoint reference without silently dropping it.

**Verification:** `pytest -q tests/test_harness_runner.py tests/test_run_control.py` and `npx vitest run src/server/search-agent/client.test.ts`.

**Dependencies:** None.

**Files likely touched:** `services/search-agent/app/api/schemas.py`, related Python tests, `apps/web/src/server/search-agent/client.ts`, and its test.

### Task 2: Synchronous Checkpoint Boundary

**Acceptance criteria:** Production Harness uses `durability="sync"` and checkpoint streaming; every private boundary is emitted after exact checkpoint read and contains only ID, parent ID, namespace, and step. Resume uses the explicit authoritative reference.

**Verification:** Focused Harness tests, including an ordering probe and orphan checkpoint case.

**Dependencies:** Task 1.

**Files likely touched:** `services/search-agent/app/harness/runner.py` and `services/search-agent/tests/test_harness_runner.py`.

### Task 3: Idempotent Database Schema

**Acceptance criteria:** Existing and fresh databases gain nonnegative run revision, authoritative checkpoint columns, unique checkpoint commit, source inbox business key/hash, and transactional outbox constraints. Re-running setup is safe.

**Verification:** Schema unit test plus isolated PostgreSQL setup-twice integration assertion.

**Dependencies:** Task 1.

**Files likely touched:** `apps/web/src/server/persistence/schema.ts` and its tests.

### Task 4: Fenced Batch Transaction

**Acceptance criteria:** One transaction checks the live lease and parent, advances revision exactly once, writes checkpoint commit/inbox/projected events/outbox, and rolls back every table on injected failure. Duplicate identical input succeeds without new rows; conflicts fail closed.

**Verification:** Focused store unit tests and isolated PostgreSQL failure-stage integration tests with direct counts.

**Dependencies:** Tasks 2 and 3.

**Files likely touched:** a focused checkpoint batch store module, its unit test, and integration test.

### Task 5: Worker Buffering And Authoritative Resume

**Acceptance criteria:** Search Agent business events are never persisted one by one. The Worker buffers through the checkpoint boundary, commits the batch, then continues. Every reconnect reads/sends the latest run-ledger checkpoint reference; no reference means no automatic orphan selection.

**Verification:** Worker tests for buffering, transaction failure, reconnect, terminal batch, and isolated newer orphan checkpoint.

**Dependencies:** Task 4.

**Files likely touched:** `apps/web/src/server/worker/executor.ts`, its tests, and the run claim/store boundary.

### Task 6: Transactional Outbox Dispatcher

**Acceptance criteria:** Dispatcher claims a bounded batch with `FOR UPDATE SKIP LOCKED`, emits `pg_notify`, and records attempts/published time without deleting rows. Failures remain retryable; SSE polling works without a listener.

**Verification:** Dispatcher unit/integration tests and existing SSE route tests.

**Dependencies:** Task 4.

**Files likely touched:** a focused outbox module, Worker lifecycle wiring, and tests.

### Task 7: Recovery And Replay Proof

**Acceptance criteria:** Failure cases A7 and Tool Ledger replay A8 have deterministic tests; event/order/count evidence proves no duplicate terminal event and Last-Event-ID replay completeness.

**Verification:** Isolated PostgreSQL integration suite plus focused Search Agent Tool Gateway/Ledger tests.

**Dependencies:** Tasks 5 and 6.

**Files likely touched:** existing integration and Tool Ledger test files; production code only if a proven gap exists.

### Task 8: Documentation And Full Gate

**Acceptance criteria:** `HANDOFF.md`, `docs/Agent生产化优化任务清单.md`, and one Chinese `docs/development/` record accurately describe the two local transactions, evidence, non-goals, rollback, and next blocked gate.

**Verification:** Repository full gates from `AGENTS.md`, Compose static parsing, runtime smoke where available, and `git diff --check`.

**Dependencies:** Tasks 1-7.

**Files likely touched:** the three required documentation artifacts.

## Risks And Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| LangGraph stream metadata differs from assumptions | High | Verify installed 1.2.9 source and official docs, then test the exact payload before implementation. |
| A terminal result occurs after the last checkpoint boundary | High | Keep terminal projection inside a checkpoint-confirmed batch and prove it with a real micrograph. |
| Batch hashes are nondeterministic | High | Canonicalize validated source JSON before hashing and cover key-order variation. |
| `NOTIFY` is mistaken for durable delivery | High | Keep event table + cursor polling authoritative and test with no listener. |
| Existing database constraints drift | Medium | Use idempotent setup and direct catalog assertions in an isolated PostgreSQL database. |
| Store module grows beyond a reviewable boundary | Medium | Put checkpoint batch and outbox behavior in focused persistence modules instead of extending unrelated live-store control flow. |

## Open Questions

- None. Issue #50 supplies the approved scope, non-goals, architecture decision, and execution gate.
