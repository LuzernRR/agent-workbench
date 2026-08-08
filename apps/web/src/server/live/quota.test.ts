import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn()
}));

vi.mock("@/server/persistence/database", () => database);

import {
  checkRunAdmission,
  checkRunAdmissionWithClient,
  memoryAuthorizationScope,
  QuotaExceededError,
  recordAuthorizationDenied,
  recordAuthorizationDenials,
  recordRunLifecycleWithClient,
  recordRunUsage
} from "./quota";

type Reply = { rowCount: number; rows: Record<string, unknown>[] };

const limitsRow = (overrides: Record<string, unknown> = {}) => ({
  max_requests_per_minute: 60,
  max_concurrent_runs: 3,
  max_tokens_per_day: 100000,
  max_cost_usd_per_day: 10,
  ...overrides
});

/**
 * Routes each statement the admission path issues to a canned reply so a test
 * only has to state the dimension it is exercising.
 */
function admissionClient(state: {
  limits?: Record<string, unknown>;
  requests?: number;
  concurrent?: number;
  tokens?: number;
  cost?: number;
}) {
  return vi.fn(async (sql: string, _values?: unknown[]): Promise<Reply> => {
    if (sql.includes("FROM wb_tenant_quotas")) {
      return { rowCount: 1, rows: [state.limits ?? limitsRow()] };
    }
    if (sql.includes("FROM wb_audit_events")) {
      return { rowCount: 1, rows: [{ count: state.requests ?? 0 }] };
    }
    if (sql.includes("FROM wb_runs")) {
      return { rowCount: 1, rows: [{ count: state.concurrent ?? 0 }] };
    }
    if (sql.includes("FROM wb_tenant_usage")) {
      return { rowCount: 1, rows: [{ tokens: state.tokens ?? 0, cost: state.cost ?? 0 }] };
    }
    return { rowCount: 1, rows: [] };
  });
}

function runAdmission(client: ReturnType<typeof admissionClient>) {
  database.transaction.mockImplementation(
    (operation: (c: { query: typeof client }) => Promise<unknown>) => operation({ query: client })
  );
  return checkRunAdmission({ tenantId: "tenant-one", visitorId: "visitor-one" });
}

const auditCalls = (client: ReturnType<typeof admissionClient>) =>
  client.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO wb_audit_events"));

describe("每租户配额准入", () => {
  beforeEach(() => {
    database.query.mockReset();
    database.transaction.mockReset();
  });

  it("四个维度都在限额内时放行且记录 allowed 审计", async () => {
    const client = admissionClient({ requests: 10, concurrent: 1, tokens: 500, cost: 1 });
    await expect(runAdmission(client)).resolves.toMatchObject({ allowed: true });
    const audit = auditCalls(client);
    expect(audit).toHaveLength(1);
    expect(String(audit[0]?.[1])).toContain("allowed");
  });

  it("准入检查在单个事务内完成，避免检查与写入之间产生竞态", async () => {
    const client = admissionClient({});
    await runAdmission(client);
    expect(database.transaction).toHaveBeenCalledTimes(1);
    expect(database.query).not.toHaveBeenCalled();
  });

  it("按租户而非访客统计限额", async () => {
    const client = admissionClient({});
    await runAdmission(client);
    const scoped = client.mock.calls.filter(([, values]) =>
      Array.isArray(values) && values.includes("tenant-one")
    );
    expect(scoped.length).toBeGreaterThan(0);
    expect(client.mock.calls.every(([sql]) =>
      !String(sql).includes("FROM wb_runs") || String(sql).includes("tenant_id")
    )).toBe(true);
  });

  it("超过每分钟请求数时拒绝并写入 denied 审计", async () => {
    const client = admissionClient({ requests: 60 });
    await expect(runAdmission(client)).resolves.toMatchObject({
      allowed: false,
      dimension: "requests_per_minute",
      reasonCode: "QUOTA_REQUESTS_PER_MINUTE_EXCEEDED",
      limit: 60,
      observed: 60
    });
    const audit = auditCalls(client);
    expect(audit).toHaveLength(1);
    expect(String(audit[0]?.[1])).toContain("QUOTA_REQUESTS_PER_MINUTE_EXCEEDED");
    expect(String(audit[0]?.[1])).toContain("denied");
  });

  it("达到并发上限时拒绝", async () => {
    const client = admissionClient({ concurrent: 3 });
    await expect(runAdmission(client)).resolves.toMatchObject({
      allowed: false,
      dimension: "concurrent_runs",
      reasonCode: "QUOTA_CONCURRENT_RUNS_EXCEEDED"
    });
  });

  it("超过每日 Token 预算时拒绝", async () => {
    const client = admissionClient({ tokens: 100000 });
    await expect(runAdmission(client)).resolves.toMatchObject({
      allowed: false,
      dimension: "tokens_per_day",
      reasonCode: "QUOTA_TOKENS_PER_DAY_EXCEEDED"
    });
  });

  it("超过每日费用预算时拒绝", async () => {
    const client = admissionClient({ cost: 10 });
    await expect(runAdmission(client)).resolves.toMatchObject({
      allowed: false,
      dimension: "cost_usd_per_day",
      reasonCode: "QUOTA_COST_PER_DAY_EXCEEDED"
    });
  });

  it("先命中的维度决定原因码，不被后续维度覆盖", async () => {
    const client = admissionClient({ requests: 60, concurrent: 99, tokens: 999999, cost: 99 });
    await expect(runAdmission(client)).resolves.toMatchObject({
      reasonCode: "QUOTA_REQUESTS_PER_MINUTE_EXCEEDED"
    });
    expect(auditCalls(client)).toHaveLength(1);
  });

  it("未配置租户配额时回落到默认限额而不是无限放行", async () => {
    const client = vi.fn(async (sql: string): Promise<Reply> => {
      if (sql.includes("FROM wb_tenant_quotas")) return { rowCount: 0, rows: [] };
      if (sql.includes("FROM wb_audit_events") && sql.includes("count(*)")) {
        return { rowCount: 1, rows: [{ count: 100000 }] };
      }
      return { rowCount: 1, rows: [{ count: 0, tokens: 0, cost: 0 }] };
    });
    await expect(runAdmission(client)).resolves.toMatchObject({
      allowed: false,
      limit: 60
    });
  });

  it("未配置租户在限额内时正常放行，新增表不会锁死既有租户", async () => {
    const client = vi.fn(async (sql: string): Promise<Reply> => {
      if (sql.includes("FROM wb_tenant_quotas")) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [{ count: 0, tokens: 0, cost: 0 }] };
    });
    await expect(runAdmission(client)).resolves.toMatchObject({ allowed: true });
  });

  it("配额行为非法值时回落到默认限额", async () => {
    const client = admissionClient({
      limits: limitsRow({ max_requests_per_minute: 0, max_concurrent_runs: -1 }),
      requests: 59
    });
    await expect(runAdmission(client)).resolves.toMatchObject({ allowed: true });
  });

  it("数值以字符串返回时仍能正确比较", async () => {
    const client = admissionClient({ limits: limitsRow({ max_requests_per_minute: "60" }), requests: "60" as never });
    await expect(runAdmission(client)).resolves.toMatchObject({ allowed: false });
  });

  it("拒绝决定与审计在同一事务内提交，避免出现无记录的拒绝", async () => {
    const client = admissionClient({ requests: 60 });
    await runAdmission(client);
    expect(database.transaction).toHaveBeenCalledTimes(1);
    expect(database.query).not.toHaveBeenCalled();
  });

  it.each([
    ["requests_per_minute", { requests: 60 }, "QUOTA_REQUESTS_PER_MINUTE_EXCEEDED"],
    ["concurrent_runs", { concurrent: 3 }, "QUOTA_CONCURRENT_RUNS_EXCEEDED"],
    ["tokens_per_day", { tokens: 100000 }, "QUOTA_TOKENS_PER_DAY_EXCEEDED"],
    ["cost_usd_per_day", { cost: 10 }, "QUOTA_COST_PER_DAY_EXCEEDED"]
  ] as const)("%s 超限都在调用方事务内写对应 denied 审计", async (_dimension, state, reasonCode) => {
    const query = admissionClient(state);
    await expect(checkRunAdmissionWithClient({ query } as never, {
      tenantId: "tenant-one",
      visitorId: "visitor-one"
    })).resolves.toMatchObject({ allowed: false, reasonCode });
    expect(auditCalls(query)).toHaveLength(1);
    expect(auditCalls(query)[0]?.[1]).toEqual(expect.arrayContaining(["denied", reasonCode]));
  });

  it("QuotaExceededError 携带原因码供上层映射为 429", () => {
    const error = new QuotaExceededError("QUOTA_CONCURRENT_RUNS_EXCEEDED", 5, 5);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("QuotaExceededError");
    expect(error.reasonCode).toBe("QUOTA_CONCURRENT_RUNS_EXCEEDED");
  });
});

describe("授权拒绝批量审计", () => {
  beforeEach(() => {
    database.query.mockReset();
    database.transaction.mockReset();
  });

  it("在一个事务中按顺序写入父命令与被阻断的 memory 能力", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [] }) };
    database.transaction.mockImplementation(
      (operation: (c: typeof client) => Promise<unknown>) => operation(client)
    );

    await recordAuthorizationDenials([
      {
        tenantId: "tenant-one",
        visitorId: "visitor-one",
        action: "thread.delete",
        resourceKind: "thread",
        resourceId: "thread-one"
      },
      {
        tenantId: "tenant-one",
        visitorId: "visitor-one",
        action: "memory.delete",
        resourceKind: "memory",
        resourceId: memoryAuthorizationScope("thread", "thread-one")
      }
    ]);

    expect(database.transaction).toHaveBeenCalledTimes(1);
    expect(database.query).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.query.mock.calls[0]?.[1]).toEqual([
      "tenant-one",
      "visitor-one",
      "thread.delete",
      "denied",
      "RESOURCE_NOT_OWNED_OR_MISSING",
      "thread",
      "thread-one"
    ]);
    expect(client.query.mock.calls[1]?.[1]).toEqual([
      "tenant-one",
      "visitor-one",
      "memory.delete",
      "denied",
      "RESOURCE_NOT_OWNED_OR_MISSING",
      "memory",
      "thread:thread-one"
    ]);
  });

  it("单条 helper 也通过同一批量事务路径写入", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [] }) };
    database.transaction.mockImplementation(
      (operation: (c: typeof client) => Promise<unknown>) => operation(client)
    );

    await recordAuthorizationDenied({
      tenantId: "tenant-one",
      visitorId: "visitor-one",
      action: "thread.read",
      resourceKind: "thread",
      resourceId: "thread-one"
    });

    expect(database.transaction).toHaveBeenCalledTimes(1);
    expect(database.query).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it("不把超长或含控制字符的资源 ID 原文写入审计", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [] }) };
    database.transaction.mockImplementation(
      (operation: (c: typeof client) => Promise<unknown>) => operation(client)
    );
    const unsafeResourceId = `thread\n${"private".repeat(32)}`;

    await recordAuthorizationDenied({
      tenantId: "tenant-one",
      visitorId: "visitor-one",
      action: "thread.read",
      resourceKind: "thread",
      resourceId: unsafeResourceId
    });

    const storedResourceId = client.query.mock.calls[0]?.[1]?.[6];
    expect(storedResourceId).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(storedResourceId).not.toContain("private");
    expect(storedResourceId).not.toContain("\n");
  });
});

describe("运行用量记账", () => {
  beforeEach(() => {
    database.query.mockReset();
    database.transaction.mockReset();
  });

  it("以 run 为幂等键写入用量，重复终态不重复计费", async () => {
    database.query.mockResolvedValue({ rowCount: 1, rows: [] });
    await recordRunUsage({
      runId: "run-one",
      tenantId: "tenant-one",
      visitorId: "visitor-one",
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      costUsd: 0.5
    });
    const [sql, values] = database.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("ON CONFLICT (run_id) DO NOTHING");
    expect(values).toEqual(["run-one", "tenant-one", "visitor-one", 10, 20, 30, 0.5]);
  });

  it("传入事务客户端时随终态事务一起提交", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [] }) };
    await recordRunUsage({
      runId: "run-one",
      tenantId: "tenant-one",
      visitorId: "visitor-one",
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      costUsd: 0
    }, client as never);
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(database.query).not.toHaveBeenCalled();
  });

  it("queued 生命周期只写带真实 runId 的审计", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [] }) };
    await recordRunLifecycleWithClient(client as never, {
      runId: "run-one",
      tenantId: "tenant-one",
      visitorId: "visitor-one",
      status: "queued",
      payload: {}
    });
    expect(client.query).toHaveBeenCalledTimes(1);
    const [sql, values] = client.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("INSERT INTO wb_audit_events");
    expect(values).toEqual(expect.arrayContaining(["run.lifecycle", "queued", "RUN_QUEUED", "run", "run-one"]));
  });

  it.each(["completed", "failed", "stopped"] as const)("%s 终态在同一客户端写 usage 与生命周期审计", async (status) => {
    const client = { query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [] }) };
    await recordRunLifecycleWithClient(client as never, {
      runId: "run-one",
      tenantId: "tenant-one",
      visitorId: "visitor-one",
      status,
      payload: {
        usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18, cost_usd: 0.125 }
      }
    });
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(String(client.query.mock.calls[0]?.[0])).toContain("INSERT INTO wb_tenant_usage");
    expect(client.query.mock.calls[0]?.[1]).toEqual([
      "run-one", "tenant-one", "visitor-one", 11, 7, 18, 0.125
    ]);
    expect(String(client.query.mock.calls[1]?.[0])).toContain("INSERT INTO wb_audit_events");
    expect(client.query.mock.calls[1]?.[1]).toEqual(expect.arrayContaining([
      "run.lifecycle", status, `RUN_${status.toUpperCase()}`, "run", "run-one"
    ]));
  });
});
