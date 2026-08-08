import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closeDatabase, query, transaction } from "./database";
import { WORKBENCH_SCHEMA_SQL } from "./schema";

const runLiveIntegration = process.env.WORKBENCH_LIVE_INTEGRATION === "1";
const visitors = new Set<string>();
const auditResources = new Set<string>();

function identifier(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function tokenHash() {
  return createHash("sha256").update(randomUUID(), "utf8").digest("hex");
}

async function createFixture() {
  const tenantA = identifier("tenant_a").slice(0, 64);
  const tenantB = identifier("tenant_b").slice(0, 64);
  const visitorA = randomUUID();
  const visitorB = randomUUID();
  const threadId = identifier("thread");
  const runId = identifier("run");
  visitors.add(visitorA);
  visitors.add(visitorB);

  await query(`
    INSERT INTO wb_visitors (id, token_hash, tenant_id)
    VALUES ($1, $2, $3), ($4, $5, $6)
  `, [visitorA, tokenHash(), tenantA, visitorB, tokenHash(), tenantB]);
  await query(`
    INSERT INTO wb_threads (id, visitor_id, title, status)
    VALUES ($1, $2, 'Issue 56 schema integration', 'idle')
  `, [threadId, visitorA]);
  await query(`
    INSERT INTO wb_runs (id, visitor_id, thread_id, agent_id, model_id, status)
    VALUES ($1, $2, $3, 'search-agent', 'deepseek-v4-flash', 'queued')
  `, [runId, visitorA, threadId]);

  return { tenantA, tenantB, visitorA, visitorB, runId };
}

async function insertTerminalSettlement(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  terminalStatus: "failed" | "stopped"
) {
  const streamId = identifier(`stream_${terminalStatus}`);
  const sourceEventId = identifier(`source_${terminalStatus}`);
  await query("UPDATE wb_runs SET lease_epoch = 1 WHERE id = $1", [fixture.runId]);
  await query(`
    INSERT INTO wb_run_terminal_settlements (
      run_id, visitor_id, staged_lease_owner, staged_lease_epoch,
      source_stream_id, source_first_seq, source_last_seq, source_count,
      source_events, projected_count, projected_events, terminal_status, stopped_payload,
      usage, canonical_hash
    ) VALUES (
      $1, $2, 'worker-status', 1,
      $3, 1, 1, 1,
      $4::jsonb,
      0, '[]'::jsonb, $5,
      '{"reasonCode":"STATUS_TEST","usage":{}}'::jsonb,
      '{}'::jsonb, $6
    )
  `, [
    fixture.runId,
    fixture.visitorA,
    streamId,
    JSON.stringify([{ eventId: sourceEventId }]),
    terminalStatus,
    createHash("sha256").update(`${fixture.runId}:${terminalStatus}`, "utf8").digest("hex")
  ]);
}

function settleTerminal(runId: string, settledStatus: "failed" | "stopped") {
  return query(`
    UPDATE wb_run_terminal_settlements
    SET settled_lease_owner = 'worker-status', settled_lease_epoch = 1,
        settled_status = $2, settled_at = now()
    WHERE run_id = $1
  `, [runId, settledStatus]);
}

afterAll(async () => {
  for (const resourceId of auditResources) {
    await query("DELETE FROM wb_audit_events WHERE resource_id = $1", [resourceId]);
  }
  for (const visitorId of visitors) {
    await query("DELETE FROM wb_visitors WHERE id = $1", [visitorId]);
  }
  await closeDatabase();
});

describe.skipIf(!runLiveIntegration)("Issue 56 租户账本与审计 schema 契约", () => {
  it("迁移先按 Run 和 Visitor 权威关系校正可推导数据，并可重复执行", async () => {
    const fixture = await createFixture();
    const auditResource = identifier("migration_audit");
    auditResources.add(auditResource);

    await transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('agent-workbench-schema-v1'))");
      await client.query(`
        ALTER TABLE wb_tenant_usage
          DROP CONSTRAINT IF EXISTS wb_tenant_usage_visitor_tenant_fk,
          DROP CONSTRAINT IF EXISTS wb_tenant_usage_run_visitor_fk;
        ALTER TABLE wb_audit_events
          DROP CONSTRAINT IF EXISTS wb_audit_events_visitor_tenant_fk;
        ALTER TABLE wb_run_terminal_settlements
          DROP CONSTRAINT IF EXISTS wb_run_terminal_settlements_pending_status_null,
          DROP CONSTRAINT IF EXISTS wb_run_terminal_settlements_terminal_to_settled_status_valid,
          DROP CONSTRAINT IF EXISTS wb_run_terminal_settlements_status_transition_valid;
        ALTER TABLE wb_run_terminal_settlements
          ADD CONSTRAINT wb_run_terminal_settlements_status_transition_valid
          CHECK (settled_status IS NULL OR settled_status IN ('failed', 'stopped'));
      `);
      await client.query(`
        INSERT INTO wb_tenant_usage (run_id, tenant_id, visitor_id)
        VALUES ($1, $2, $3)
      `, [fixture.runId, fixture.tenantB, fixture.visitorB]);
      await client.query(`
        INSERT INTO wb_audit_events (
          tenant_id, visitor_id, action, outcome, reason_code, resource_kind, resource_id
        ) VALUES ($1, $2, 'thread.read', 'denied', 'RESOURCE_NOT_OWNED_OR_MISSING', 'thread', $3)
      `, [fixture.tenantB, fixture.visitorA, auditResource]);

      await client.query(WORKBENCH_SCHEMA_SQL);
      await client.query(WORKBENCH_SCHEMA_SQL);
    });

    const usage = await query<{ tenant_id: string; visitor_id: string }>(`
      SELECT tenant_id, visitor_id::text
      FROM wb_tenant_usage
      WHERE run_id = $1
    `, [fixture.runId]);
    expect(usage.rows).toEqual([{ tenant_id: fixture.tenantA, visitor_id: fixture.visitorA }]);

    const audit = await query<{ tenant_id: string; visitor_id: string }>(`
      SELECT tenant_id, visitor_id::text
      FROM wb_audit_events
      WHERE resource_id = $1
    `, [auditResource]);
    expect(audit.rows).toEqual([{ tenant_id: fixture.tenantA, visitor_id: fixture.visitorA }]);

    const constraints = await query<{ conname: string }>(`
      SELECT conname
      FROM pg_constraint
      WHERE conname IN (
        'wb_visitors_id_tenant_key',
        'wb_tenant_usage_visitor_tenant_fk',
        'wb_tenant_usage_run_visitor_fk',
        'wb_audit_events_visitor_tenant_fk',
        'wb_audit_events_outcome_valid',
        'wb_run_terminal_settlements_pending_status_null',
        'wb_run_terminal_settlements_terminal_to_settled_status_valid',
        'wb_run_terminal_settlements_status_transition_valid'
      )
      ORDER BY conname
    `);
    expect(constraints.rows.map((row) => row.conname)).toEqual([
      "wb_audit_events_outcome_valid",
      "wb_audit_events_visitor_tenant_fk",
      "wb_run_terminal_settlements_pending_status_null",
      "wb_run_terminal_settlements_terminal_to_settled_status_valid",
      "wb_tenant_usage_run_visitor_fk",
      "wb_tenant_usage_visitor_tenant_fk",
      "wb_visitors_id_tenant_key"
    ]);

    await query("DELETE FROM wb_tenant_usage WHERE run_id = $1", [fixture.runId]);
  });

  it("terminal settlement 只允许 pending、stopped→stopped 与 failed→failed|stopped", async () => {
    const stoppedFixture = await createFixture();
    await insertTerminalSettlement(stoppedFixture, "stopped");
    const pending = await query<{ settled_status: string | null }>(`
      SELECT settled_status
      FROM wb_run_terminal_settlements
      WHERE run_id = $1
    `, [stoppedFixture.runId]);
    expect(pending.rows).toEqual([{ settled_status: null }]);
    await expect(query(`
      UPDATE wb_run_terminal_settlements
      SET settled_status = 'stopped'
      WHERE run_id = $1
    `, [stoppedFixture.runId])).rejects.toThrow(
      /wb_run_terminal_settlements_pending_status_null/u
    );
    await expect(settleTerminal(stoppedFixture.runId, "failed")).rejects.toThrow(
      /wb_run_terminal_settlements_terminal_to_settled_status_valid/u
    );
    await expect(settleTerminal(stoppedFixture.runId, "stopped")).resolves.toMatchObject({ rowCount: 1 });

    const failedFixture = await createFixture();
    await insertTerminalSettlement(failedFixture, "failed");
    await expect(settleTerminal(failedFixture.runId, "failed")).resolves.toMatchObject({ rowCount: 1 });

    const failedStoppedFixture = await createFixture();
    await insertTerminalSettlement(failedStoppedFixture, "failed");
    await expect(settleTerminal(failedStoppedFixture.runId, "stopped")).resolves.toMatchObject({ rowCount: 1 });
  });

  it("数据库拒绝 tenant/visitor、run/visitor 错配并幂等约束 Run 生命周期", async () => {
    const fixture = await createFixture();
    const lifecycleResource = fixture.runId;
    auditResources.add(lifecycleResource);

    await expect(query(`
      INSERT INTO wb_tenant_usage (run_id, tenant_id, visitor_id)
      VALUES ($1, $2, $3)
    `, [fixture.runId, fixture.tenantB, fixture.visitorA])).rejects.toThrow(/wb_tenant_usage_visitor_tenant_fk|foreign key/u);

    await expect(query(`
      INSERT INTO wb_tenant_usage (run_id, tenant_id, visitor_id)
      VALUES ($1, $2, $3)
    `, [fixture.runId, fixture.tenantB, fixture.visitorB])).rejects.toThrow(/wb_tenant_usage_run_visitor_fk|foreign key/u);

    await expect(query(`
      INSERT INTO wb_audit_events (
        tenant_id, visitor_id, action, outcome, reason_code, resource_kind, resource_id
      ) VALUES ($1, $2, 'run.lifecycle', 'queued', 'RUN_QUEUED', 'run', $3)
    `, [fixture.tenantB, fixture.visitorA, lifecycleResource])).rejects.toThrow(/wb_audit_events_visitor_tenant_fk|foreign key/u);

    await expect(query(`
      INSERT INTO wb_tenant_usage (run_id, tenant_id, visitor_id)
      VALUES ($1, $2, $3)
    `, [fixture.runId, fixture.tenantA, fixture.visitorA])).resolves.toMatchObject({ rowCount: 1 });

    await expect(query(`
      INSERT INTO wb_audit_events (
        tenant_id, visitor_id, action, outcome, reason_code, resource_kind, resource_id
      ) VALUES ($1, $2, 'run.lifecycle', 'queued', 'RUN_QUEUED', 'run', $3)
    `, [fixture.tenantA, fixture.visitorA, lifecycleResource])).resolves.toMatchObject({ rowCount: 1 });
    await expect(query(`
      INSERT INTO wb_audit_events (
        tenant_id, visitor_id, action, outcome, reason_code, resource_kind, resource_id
      ) VALUES ($1, $2, 'run.lifecycle', 'queued', 'RUN_QUEUED', 'run', $3)
    `, [fixture.tenantA, fixture.visitorA, lifecycleResource])).rejects.toThrow(/wb_audit_events_run_queued_once_idx|duplicate key/u);

    await expect(query(`
      INSERT INTO wb_audit_events (
        tenant_id, visitor_id, action, outcome, reason_code, resource_kind, resource_id
      ) VALUES ($1, $2, 'run.lifecycle', 'completed', 'RUN_COMPLETED', 'run', $3)
    `, [fixture.tenantA, fixture.visitorA, lifecycleResource])).resolves.toMatchObject({ rowCount: 1 });
    await expect(query(`
      INSERT INTO wb_audit_events (
        tenant_id, visitor_id, action, outcome, reason_code, resource_kind, resource_id
      ) VALUES ($1, $2, 'run.lifecycle', 'failed', 'RUN_FAILED', 'run', $3)
    `, [fixture.tenantA, fixture.visitorA, lifecycleResource])).rejects.toThrow(/wb_audit_events_run_terminal_once_idx|duplicate key/u);

    const indexes = await query<{ indexname: string }>(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND indexname IN (
          'wb_audit_events_run_queued_once_idx',
          'wb_audit_events_run_terminal_once_idx'
        )
      ORDER BY indexname
    `);
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      "wb_audit_events_run_queued_once_idx",
      "wb_audit_events_run_terminal_once_idx"
    ]);
  });

  it("terminal settlement authority 不可变、只结算一次并随 Run 级联删除", async () => {
    const fixture = await createFixture();
    await query("UPDATE wb_runs SET lease_epoch = 1 WHERE id = $1", [fixture.runId]);
    await expect(query(`
      INSERT INTO wb_run_terminal_settlements (
        run_id, visitor_id, staged_lease_owner, staged_lease_epoch,
        source_stream_id, source_first_seq, source_last_seq, source_count,
        source_events, projected_count, projected_events, terminal_status, stopped_payload,
        usage, canonical_hash
      ) VALUES (
        $1, $2, 'worker-foreign', 1,
        'stream_foreign', 1, 1, 1,
        '[{"eventId":"source_foreign"}]'::jsonb,
        0, '[]'::jsonb, 'stopped', '{}'::jsonb, '{}'::jsonb, $3
      )
    `, [fixture.runId, fixture.visitorB, "b".repeat(64)])).rejects.toThrow(/wb_run_terminal_settlements_run_visitor_fk|foreign key/u);

    await query(`
      INSERT INTO wb_run_terminal_settlements (
        run_id, visitor_id, staged_lease_owner, staged_lease_epoch,
        source_stream_id, source_first_seq, source_last_seq, source_count,
        source_events, projected_count, projected_events, terminal_status, stopped_payload,
        usage, canonical_hash
      ) VALUES (
        $1, $2, 'worker-schema', 1,
        'stream_schema', 1, 1, 1,
        '[{"eventId":"source_schema"}]'::jsonb,
        0, '[]'::jsonb, 'stopped',
        '{"reasonCode":"USER_STOPPED","usage":{}}'::jsonb,
        '{}'::jsonb, $3
      )
    `, [fixture.runId, fixture.visitorA, "a".repeat(64)]);

    await expect(query(`
      UPDATE wb_run_terminal_settlements
      SET stopped_payload = '{"reasonCode":"FORGED","usage":{}}'::jsonb
      WHERE run_id = $1
    `, [fixture.runId])).rejects.toThrow(/terminal settlement authority is immutable/u);
    await expect(query(`
      UPDATE wb_run_terminal_settlements
      SET terminal_status = 'failed'
      WHERE run_id = $1
    `, [fixture.runId])).rejects.toThrow(/terminal settlement authority is immutable/u);
    await expect(query(`
      UPDATE wb_run_terminal_settlements
      SET staged_lease_owner = 'worker-forged', staged_lease_epoch = 2
      WHERE run_id = $1
    `, [fixture.runId])).rejects.toThrow(/terminal settlement authority is immutable/u);
    await expect(query(`
      UPDATE wb_run_terminal_settlements
      SET canonical_hash = $2
      WHERE run_id = $1
    `, [fixture.runId, "c".repeat(64)])).rejects.toThrow(/terminal settlement authority is immutable/u);
    await expect(query(`
      UPDATE wb_run_terminal_settlements
      SET settled_lease_owner = 'worker-schema'
      WHERE run_id = $1
    `, [fixture.runId])).rejects.toThrow(/wb_run_terminal_settlements_settled_complete|check constraint/u);
    await expect(query(`
      UPDATE wb_run_terminal_settlements
      SET settled_lease_owner = 'worker-schema', settled_lease_epoch = 0,
          settled_status = 'stopped', settled_at = now()
      WHERE run_id = $1
    `, [fixture.runId])).rejects.toThrow(/wb_run_terminal_settlements_settled_complete|check constraint/u);

    await expect(query(`
      UPDATE wb_run_terminal_settlements
      SET settled_lease_owner = 'worker-schema', settled_lease_epoch = 1,
          settled_status = 'stopped', settled_at = now()
      WHERE run_id = $1
    `, [fixture.runId])).resolves.toMatchObject({ rowCount: 1 });
    await expect(query(`
      UPDATE wb_run_terminal_settlements
      SET settled_lease_owner = 'worker-forged', settled_lease_epoch = 2,
          settled_status = 'failed', settled_at = now()
      WHERE run_id = $1
    `, [fixture.runId])).rejects.toThrow(/terminal settlement cannot be consumed twice/u);

    await transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('agent-workbench-schema-v1'))");
      await client.query(WORKBENCH_SCHEMA_SQL);
      await client.query(WORKBENCH_SCHEMA_SQL);
    });
    const trigger = await query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM pg_trigger
      WHERE tgrelid = 'wb_run_terminal_settlements'::regclass
        AND tgname = 'wb_run_terminal_settlements_immutable'
        AND NOT tgisinternal
    `);
    expect(trigger.rows[0].count).toBe("1");

    await query("DELETE FROM wb_visitors WHERE id = $1", [fixture.visitorA]);
    const remaining = await query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM wb_run_terminal_settlements WHERE run_id = $1
    `, [fixture.runId]);
    expect(remaining.rows[0].count).toBe("0");
  });
});
