import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { closeDatabase, query, transaction } from "@/server/persistence/database";
import { dispatchAgentEventOutboxBatch } from "./event-outbox";
import { insertEventWithClient } from "./store";

const runLiveIntegration = process.env.WORKBENCH_LIVE_INTEGRATION === "1";
const visitors = new Set<string>();

function identifier(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

async function createRun() {
  const visitorId = randomUUID();
  const threadId = identifier("thread");
  const runId = identifier("run");
  visitors.add(visitorId);
  await query("INSERT INTO wb_visitors (id, token_hash) VALUES ($1, $2)", [
    visitorId,
    randomUUID().replaceAll("-", "").repeat(2)
  ]);
  await query(`
    INSERT INTO wb_threads (id, visitor_id, title, status)
    VALUES ($1, $2, 'Outbox integration', 'running')
  `, [threadId, visitorId]);
  await query(`
    INSERT INTO wb_runs (id, visitor_id, thread_id, agent_id, model_id, status)
    VALUES ($1, $2, $3, 'search-agent', 'deepseek-v4-flash', 'running')
  `, [runId, visitorId, threadId]);
  return {
    id: runId,
    visitorId,
    threadId,
    projectId: null,
    modelId: "deepseek-v4-flash",
    agentId: "search-agent"
  };
}

async function outboxRows(runId: string) {
  return (await query<{
    event_id: string;
    attempts: number;
    published: boolean;
    last_error: string | null;
  }>(`
    SELECT event_id, attempts, published_at IS NOT NULL AS published, last_error
    FROM wb_agent_event_outbox
    WHERE run_id = $1
    ORDER BY event_id
  `, [runId])).rows;
}

afterAll(async () => {
  for (const visitorId of visitors) {
    await query("DELETE FROM wb_visitors WHERE id = $1", [visitorId]);
  }
  await closeDatabase();
});

describe.skipIf(!runLiveIntegration)("AgentEvent outbox 真实 PostgreSQL 契约", () => {
  it("有界 dispatcher 会跳过其他事务锁定的行且不删除已发布消息", async () => {
    const run = await createRun();
    const events = await transaction(async (client) => [
      await insertEventWithClient(client, run, "run.status", { index: 1 }),
      await insertEventWithClient(client, run, "run.status", { index: 2 })
    ]);
    await query(`
      UPDATE wb_agent_event_outbox
      SET available_at = now() - interval '100 years'
      WHERE run_id = $1
    `, [run.id]);
    const orderedIds = events.map((event) => event.id).sort();

    const databaseUrl = process.env.WORKBENCH_DATABASE_URL;
    if (!databaseUrl) throw new Error("WORKBENCH_DATABASE_URL 是真实集成测试必需项");
    const locker = new Client({ connectionString: databaseUrl });
    await locker.connect();
    try {
      await locker.query("BEGIN");
      await locker.query("SELECT event_id FROM wb_agent_event_outbox WHERE event_id = $1 FOR UPDATE", [orderedIds[0]]);

      await expect(dispatchAgentEventOutboxBatch(1)).resolves.toEqual({
        claimed: 1,
        published: 1,
        failed: 0
      });
      expect(await outboxRows(run.id)).toEqual([
        { event_id: orderedIds[0], attempts: 0, published: false, last_error: null },
        { event_id: orderedIds[1], attempts: 1, published: true, last_error: null }
      ]);
    } finally {
      await locker.query("ROLLBACK");
      await locker.end();
    }

    await expect(dispatchAgentEventOutboxBatch(1)).resolves.toEqual({
      claimed: 1,
      published: 1,
      failed: 0
    });
    expect(await outboxRows(run.id)).toEqual([
      { event_id: orderedIds[0], attempts: 1, published: true, last_error: null },
      { event_id: orderedIds[1], attempts: 1, published: true, last_error: null }
    ]);
    expect(await query<{ count: string }>(`
      SELECT count(*)::text AS count FROM wb_agent_event_outbox WHERE run_id = $1
    `, [run.id])).toMatchObject({ rows: [{ count: "2" }] });
  });

  it("通知后的结算失败会取消该通知、保留消息并在下一次成功重试", async () => {
    const run = await createRun();
    const event = await transaction((client) => insertEventWithClient(client, run, "run.status", { retry: true }));
    await query(`
      UPDATE wb_agent_event_outbox
      SET available_at = now() - interval '100 years'
      WHERE event_id = $1
    `, [event.id]);
    const token = randomUUID().replaceAll("-", "");
    const functionName = `wb_issue50_outbox_fail_${token}`;
    const triggerName = `wb_issue50_outbox_trigger_${token}`;
    await query(`
      CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $function$
      BEGIN
        IF NEW.run_id = '${run.id}' AND NEW.published_at IS NOT NULL THEN
          RAISE EXCEPTION 'issue50 injected outbox settlement failure';
        END IF;
        RETURN NEW;
      END;
      $function$;
      CREATE TRIGGER ${triggerName}
      AFTER UPDATE OF published_at ON wb_agent_event_outbox
      FOR EACH ROW EXECUTE FUNCTION ${functionName}();
    `);

    try {
      await expect(dispatchAgentEventOutboxBatch(1)).resolves.toEqual({
        claimed: 1,
        published: 0,
        failed: 1
      });
      expect(await outboxRows(run.id)).toEqual([{
        event_id: event.id,
        attempts: 1,
        published: false,
        last_error: "issue50 injected outbox settlement failure"
      }]);
    } finally {
      await query(`
        DROP TRIGGER IF EXISTS ${triggerName} ON wb_agent_event_outbox;
        DROP FUNCTION IF EXISTS ${functionName}();
      `);
    }

    await query("UPDATE wb_agent_event_outbox SET available_at = now() WHERE event_id = $1", [event.id]);
    await expect(dispatchAgentEventOutboxBatch(1)).resolves.toEqual({
      claimed: 1,
      published: 1,
      failed: 0
    });
    expect(await outboxRows(run.id)).toEqual([{
      event_id: event.id,
      attempts: 2,
      published: true,
      last_error: null
    }]);
  });
});
