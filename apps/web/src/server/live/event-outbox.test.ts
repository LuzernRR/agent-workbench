import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  transaction: vi.fn()
}));

vi.mock("@/server/persistence/database", () => database);

import {
  AGENT_EVENT_NOTIFY_CHANNEL,
  dispatchAgentEventOutboxBatch,
  runAgentEventOutboxDispatcher
} from "./event-outbox";

type ClaimedRow = {
  event_id: string;
  event_seq: string;
};

function outboxClient(rows: ClaimedRow[], failPayload?: string) {
  const query = vi.fn(async (statement: unknown, values: unknown[] = []) => {
    const sql = String(statement);
    if (sql.includes("FROM wb_agent_event_outbox outbox")) {
      return { rowCount: rows.length, rows };
    }
    if (sql.includes("pg_notify") && values[0] === failPayload) {
      throw new Error("notify unavailable");
    }
    return { rowCount: 1, rows: [] };
  });
  return { query };
}

describe("AgentEvent transactional outbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("用有界 SKIP LOCKED 批次发布并在同一事务结算", async () => {
    const client = outboxClient([
      { event_id: "evt_one", event_seq: "41" },
      { event_id: "evt_two", event_seq: "42" }
    ]);
    database.transaction.mockImplementation(async (operation) => operation(client));

    await expect(dispatchAgentEventOutboxBatch(2)).resolves.toEqual({
      claimed: 2,
      published: 2,
      failed: 0
    });

    const statements = client.query.mock.calls.map(([statement]) => String(statement));
    const claimSql = statements.find((sql) => sql.includes("FROM wb_agent_event_outbox outbox"));
    expect(claimSql).toContain("LIMIT $1");
    expect(claimSql).toContain("FOR UPDATE OF outbox SKIP LOCKED");
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining(`pg_notify('${AGENT_EVENT_NOTIFY_CHANNEL}', $1)`),
      ["41"]
    );
    expect(statements.filter((sql) => sql.includes("published_at = now()"))).toHaveLength(2);
    expect(statements.every((sql) => !/\bDELETE\b/u.test(sql))).toBe(true);
  });

  it("发布失败会回滚该通知、记录尝试并保留消息供重试", async () => {
    const client = outboxClient([
      { event_id: "evt_failed", event_seq: "51" },
      { event_id: "evt_ok", event_seq: "52" }
    ], "51");
    database.transaction.mockImplementation(async (operation) => operation(client));

    await expect(dispatchAgentEventOutboxBatch(10)).resolves.toEqual({
      claimed: 2,
      published: 1,
      failed: 1
    });

    const statements = client.query.mock.calls.map(([statement]) => String(statement));
    expect(statements).toContain("ROLLBACK TO SAVEPOINT wb_agent_event_publish");
    expect(statements.some((sql) => sql.includes("last_error = $2") && sql.includes("published_at IS NULL"))).toBe(true);
    expect(statements.every((sql) => !/\bDELETE\b/u.test(sql))).toBe(true);
  });

  it("饱和批次立即续投，空批次等待且可随 worker 一起停止", async () => {
    const shutdown = new AbortController();
    const dispatch = vi.fn()
      .mockResolvedValueOnce({ claimed: 2, published: 1, failed: 1 })
      .mockResolvedValueOnce({ claimed: 0, published: 0, failed: 0 });
    const wait = vi.fn(async () => shutdown.abort());

    await runAgentEventOutboxDispatcher(
      { batchSize: 2, pollMs: 50 },
      shutdown.signal,
      vi.fn(),
      { dispatch, wait }
    );

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it("拒绝无界或非法批次", async () => {
    await expect(dispatchAgentEventOutboxBatch(0)).rejects.toThrow("batchSize");
    await expect(dispatchAgentEventOutboxBatch(501)).rejects.toThrow("batchSize");
    expect(database.transaction).not.toHaveBeenCalled();
  });
});
