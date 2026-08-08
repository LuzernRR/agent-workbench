import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { query, transaction } from "@/server/persistence/database";

/**
 * Thrown by admission when a dimension is over its limit. The handler maps it
 * to a stable 429; the audit row was already committed by the check.
 */
export class QuotaExceededError extends Error {
  readonly reasonCode: QuotaReasonCode;
  readonly limit: number;
  readonly observed: number;

  constructor(reasonCode: QuotaReasonCode, limit: number, observed: number) {
    super(`租户配额已超限：${reasonCode}`);
    this.name = "QuotaExceededError";
    this.reasonCode = reasonCode;
    this.limit = limit;
    this.observed = observed;
  }
}

/**
 * Per-tenant admission control.
 *
 * Every dimension is evaluated against PostgreSQL rather than process memory,
 * so a horizontally scaled Web tier shares one budget instead of one budget
 * per replica. The check and its audit row commit in the same transaction: a
 * denial that is not recorded, or a record without the corresponding decision,
 * would make the trail useless for reconciliation.
 *
 * This admits approximately, not exactly. The decision commits before the run
 * insert (see `prepareLiveRun`), which keeps a denial durable when that insert
 * later fails, but leaves a window: N simultaneous enqueues can each observe
 * `concurrent_runs = limit - 1` and all be admitted, so the ceiling can be
 * exceeded by up to the number of racing requests. That is acceptable for a
 * budget guard and is NOT acceptable for a security boundary — tenant
 * separation is enforced by the `visitor_id`/`tenant_id` predicates on every
 * statement, never by these counts. Making the ceiling exact would require
 * locking the tenant's quota row for the whole run transaction, serializing
 * enqueues per tenant and losing the durable-denial property above.
 */

export type QuotaDimension =
  | "requests_per_minute"
  | "concurrent_runs"
  | "tokens_per_day"
  | "cost_usd_per_day";

export type QuotaLimits = {
  maxRequestsPerMinute: number;
  maxConcurrentRuns: number;
  maxTokensPerDay: number;
  maxCostUsdPerDay: number;
};

export type QuotaReasonCode =
  | "QUOTA_REQUESTS_PER_MINUTE_EXCEEDED"
  | "QUOTA_CONCURRENT_RUNS_EXCEEDED"
  | "QUOTA_TOKENS_PER_DAY_EXCEEDED"
  | "QUOTA_COST_PER_DAY_EXCEEDED";

export type QuotaDecision =
  | { allowed: true }
  | { allowed: false; dimension: QuotaDimension; reasonCode: QuotaReasonCode; limit: number; observed: number };

const REASON_BY_DIMENSION: Record<QuotaDimension, QuotaReasonCode> = {
  requests_per_minute: "QUOTA_REQUESTS_PER_MINUTE_EXCEEDED",
  concurrent_runs: "QUOTA_CONCURRENT_RUNS_EXCEEDED",
  tokens_per_day: "QUOTA_TOKENS_PER_DAY_EXCEEDED",
  cost_usd_per_day: "QUOTA_COST_PER_DAY_EXCEEDED"
};

/**
 * Defaults are deliberately generous. This slice makes the limits observable
 * and enforceable; tuning them for a real tenant mix belongs to P0-08, which
 * adds shedding and breakers on top of these counters.
 */
export const DEFAULT_QUOTA_LIMITS: QuotaLimits = {
  maxRequestsPerMinute: 60,
  maxConcurrentRuns: 5,
  maxTokensPerDay: 5_000_000,
  maxCostUsdPerDay: 50
};

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function positiveNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

type QuotaRow = {
  max_requests_per_minute: number | string;
  max_concurrent_runs: number | string;
  max_tokens_per_day: number | string;
  max_cost_usd_per_day: number | string;
};

async function tenantLimits(client: PoolClient, tenantId: string): Promise<QuotaLimits> {
  const result = await client.query<QuotaRow>(`
    SELECT max_requests_per_minute, max_concurrent_runs, max_tokens_per_day, max_cost_usd_per_day
    FROM wb_tenant_quotas WHERE tenant_id = $1
  `, [tenantId]);
  const row = result.rows[0];
  // An absent row means "unconfigured", which must fall back to the defaults
  // rather than deny: adding this table cannot retroactively lock out a tenant
  // that was working before the migration ran.
  if (!row) return DEFAULT_QUOTA_LIMITS;
  return {
    maxRequestsPerMinute: positiveInteger(row.max_requests_per_minute, DEFAULT_QUOTA_LIMITS.maxRequestsPerMinute),
    maxConcurrentRuns: positiveInteger(row.max_concurrent_runs, DEFAULT_QUOTA_LIMITS.maxConcurrentRuns),
    maxTokensPerDay: positiveInteger(row.max_tokens_per_day, DEFAULT_QUOTA_LIMITS.maxTokensPerDay),
    maxCostUsdPerDay: positiveNumber(row.max_cost_usd_per_day, DEFAULT_QUOTA_LIMITS.maxCostUsdPerDay)
  };
}

export type AuditInput = {
  tenantId: string;
  visitorId: string | null;
  action: string;
  outcome: "allowed" | "denied" | "queued" | "completed" | "failed" | "stopped";
  reasonCode: string;
  resourceKind?: string | null;
  resourceId?: string | null;
};

export async function recordAuditEventWithClient(client: PoolClient, input: AuditInput): Promise<void> {
  await client.query(`
    INSERT INTO wb_audit_events (tenant_id, visitor_id, action, outcome, reason_code, resource_kind, resource_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, [
    input.tenantId,
    input.visitorId,
    input.action,
    input.outcome,
    input.reasonCode,
    input.resourceKind ?? null,
    input.resourceId ?? null
  ]);
}

export async function recordAuditEvent(input: AuditInput): Promise<void> {
  await query(`
    INSERT INTO wb_audit_events (tenant_id, visitor_id, action, outcome, reason_code, resource_kind, resource_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, [
    input.tenantId,
    input.visitorId,
    input.action,
    input.outcome,
    input.reasonCode,
    input.resourceKind ?? null,
    input.resourceId ?? null
  ]);
}

export type AuthorizationAuditAction =
  | "project.read"
  | "project.update"
  | "project.delete"
  | "project.reorder"
  | "thread.create"
  | "thread.read"
  | "thread.update"
  | "thread.delete"
  | "run.start"
  | "run.read"
  | "run.stop"
  | "run.verification.read"
  | "run.verification.cancel"
  | "attachment.upload"
  | "attachment.use"
  | "attachment.read"
  | "memory.read"
  | "memory.write"
  | "memory.delete";

export type AuthorizationResourceKind = "project" | "thread" | "run" | "attachment" | "memory";

export type AuthorizationDeniedInput = {
  tenantId: string;
  visitorId: string;
  action: AuthorizationAuditAction;
  resourceKind: AuthorizationResourceKind;
  resourceId?: string | null;
};

export function memoryAuthorizationScope(
  parentKind: Extract<AuthorizationResourceKind, "project" | "thread">,
  parentId: string
) {
  return `${parentKind}:${parentId}`;
}

function safeAuditResourceId(value: string | null | undefined): string | null {
  if (!value) return null;
  if (/^[A-Za-z0-9_.:-]{1,128}$/u.test(value)) return value;
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export async function recordAuthorizationDenialsWithClient(
  client: PoolClient,
  inputs: AuthorizationDeniedInput[]
): Promise<void> {
  for (const input of inputs) {
    await recordAuditEventWithClient(client, {
      ...input,
      outcome: "denied",
      reasonCode: "RESOURCE_NOT_OWNED_OR_MISSING",
      resourceId: safeAuditResourceId(input.resourceId)
    });
  }
}

export async function recordAuthorizationDeniedWithClient(
  client: PoolClient,
  input: AuthorizationDeniedInput
): Promise<void> {
  await recordAuthorizationDenialsWithClient(client, [input]);
}

export async function recordAuthorizationDenials(inputs: AuthorizationDeniedInput[]): Promise<void> {
  await transaction((client) => recordAuthorizationDenialsWithClient(client, inputs));
}

export async function recordAuthorizationDenied(input: AuthorizationDeniedInput): Promise<void> {
  await recordAuthorizationDenials([input]);
}

/**
 * Evaluate all four dimensions for one run admission and persist the decision.
 * Dimensions are checked cheapest-first and the first breach wins, so a denied
 * caller learns exactly which budget it hit instead of a generic rejection.
 */
export async function checkRunAdmission(input: {
  tenantId: string;
  visitorId: string;
  resourceId?: string | null;
}): Promise<QuotaDecision> {
  return transaction((client) => checkRunAdmissionWithClient(client, input));
}

/**
 * Transaction-scoped admission check. `prepareLiveRun` uses this overload so
 * the allowed decision, durable Run insert, and queued lifecycle audit either
 * commit together or all roll back. A denied decision is returned rather than
 * thrown so its audit row can commit before the caller maps it to HTTP 429.
 */
export async function checkRunAdmissionWithClient(client: PoolClient, input: {
  tenantId: string;
  visitorId: string;
  resourceId?: string | null;
}): Promise<QuotaDecision> {
    const limits = await tenantLimits(client, input.tenantId);

    const recent = await client.query<{ count: string }>(`
      SELECT count(*) AS count
      FROM wb_audit_events
      WHERE tenant_id = $1
        AND action = 'run.start'
        AND outcome = 'allowed'
        AND created_at > now() - interval '1 minute'
    `, [input.tenantId]);
    const requestsLastMinute = Number(recent.rows[0]?.count ?? 0);
    if (requestsLastMinute >= limits.maxRequestsPerMinute) {
      return deny(client, input, "requests_per_minute", limits.maxRequestsPerMinute, requestsLastMinute);
    }

    const active = await client.query<{ count: string }>(`
      SELECT count(*) AS count
      FROM wb_runs run
      JOIN wb_visitors visitor ON visitor.id = run.visitor_id
      WHERE visitor.tenant_id = $1
        AND run.archived_at IS NULL
        AND run.status IN ('queued', 'running', 'waiting')
    `, [input.tenantId]);
    const activeRuns = Number(active.rows[0]?.count ?? 0);
    if (activeRuns >= limits.maxConcurrentRuns) {
      return deny(client, input, "concurrent_runs", limits.maxConcurrentRuns, activeRuns);
    }

    const usage = await client.query<{ tokens: string | null; cost: string | null }>(`
      SELECT COALESCE(sum(total_tokens), 0) AS tokens, COALESCE(sum(cost_usd), 0) AS cost
      FROM wb_tenant_usage
      WHERE tenant_id = $1 AND recorded_at > now() - interval '1 day'
    `, [input.tenantId]);
    const tokens = Number(usage.rows[0]?.tokens ?? 0);
    if (tokens >= limits.maxTokensPerDay) {
      return deny(client, input, "tokens_per_day", limits.maxTokensPerDay, tokens);
    }
    const cost = Number(usage.rows[0]?.cost ?? 0);
    if (cost >= limits.maxCostUsdPerDay) {
      return deny(client, input, "cost_usd_per_day", limits.maxCostUsdPerDay, cost);
    }

    await recordAuditEventWithClient(client, {
      tenantId: input.tenantId,
      visitorId: input.visitorId,
      action: "run.start",
      outcome: "allowed",
      reasonCode: "QUOTA_WITHIN_LIMITS",
      resourceKind: "run",
      resourceId: input.resourceId ?? null
    });
    return { allowed: true };
}

async function deny(
  client: PoolClient,
  input: { tenantId: string; visitorId: string },
  dimension: QuotaDimension,
  limit: number,
  observed: number
): Promise<QuotaDecision> {
  const reasonCode = REASON_BY_DIMENSION[dimension];
  await recordAuditEventWithClient(client, {
    tenantId: input.tenantId,
    visitorId: input.visitorId,
    action: "run.start",
    outcome: "denied",
    reasonCode,
    resourceKind: "run"
  });
  return { allowed: false, dimension, reasonCode, limit, observed };
}

/**
 * Persist the usage a finished run actually consumed. Keyed by run so a
 * redelivered terminal event cannot double-count against the daily budget.
 */
export async function recordRunUsage(input: {
  runId: string;
  tenantId: string;
  visitorId: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}, client?: PoolClient): Promise<void> {
  const run = client ? client.query.bind(client) : query;
  await run(`
    INSERT INTO wb_tenant_usage (run_id, tenant_id, visitor_id, input_tokens, output_tokens, total_tokens, cost_usd)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (run_id) DO NOTHING
  `, [
    input.runId,
    input.tenantId,
    input.visitorId,
    Math.max(0, Math.floor(input.inputTokens)),
    Math.max(0, Math.floor(input.outputTokens)),
    Math.max(0, Math.floor(input.totalTokens)),
    Math.max(0, input.costUsd)
  ]);
}

const usageNumber = (source: Record<string, unknown>, key: string) => {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
};

/**
 * Persist one durable Run lifecycle state. Terminal usage and audit share the
 * caller's transaction with the Run status and public terminal AgentEvent.
 */
export async function recordRunLifecycleWithClient(client: PoolClient, input: {
  runId: string;
  tenantId: string;
  visitorId: string;
  status: "queued" | "completed" | "failed" | "stopped";
  payload: Record<string, unknown>;
}): Promise<void> {
  if (input.status !== "queued") {
    const raw = input.payload.usage;
    const usage = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    await recordRunUsage({
      runId: input.runId,
      tenantId: input.tenantId,
      visitorId: input.visitorId,
      inputTokens: usageNumber(usage, "input_tokens"),
      outputTokens: usageNumber(usage, "output_tokens"),
      totalTokens: usageNumber(usage, "total_tokens"),
      costUsd: typeof usage.cost_usd === "number" && Number.isFinite(usage.cost_usd) && usage.cost_usd >= 0
        ? usage.cost_usd
        : 0
    }, client);
  }
  await recordAuditEventWithClient(client, {
    tenantId: input.tenantId,
    visitorId: input.visitorId,
    action: "run.lifecycle",
    outcome: input.status,
    reasonCode: `RUN_${input.status.toUpperCase()}`,
    resourceKind: "run",
    resourceId: input.runId
  });
}
