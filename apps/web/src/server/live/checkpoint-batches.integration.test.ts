import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closeDatabase, query } from "@/server/persistence/database";
import {
  canonicalCheckpointBatchHash,
  CheckpointBatchConflictError,
  CheckpointParentConflictError,
  commitClaimedCheckpointBatch,
  type ClaimedCheckpointBatch
} from "./checkpoint-batches";

const runLiveIntegration = process.env.WORKBENCH_LIVE_INTEGRATION === "1";
const visitors = new Set<string>();
const databaseObjects = new Set<{ trigger: string; functionName: string; table: string }>();

function identifier(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

async function createClaim() {
  const visitorId = randomUUID();
  const threadId = identifier("thread");
  const runId = identifier("run");
  const owner = identifier("worker");
  visitors.add(visitorId);
  await query("INSERT INTO wb_visitors (id, token_hash) VALUES ($1, $2)", [
    visitorId,
    randomUUID().replaceAll("-", "").repeat(2)
  ]);
  await query(`
    INSERT INTO wb_threads (id, visitor_id, title, status)
    VALUES ($1, $2, 'Issue 50 integration', 'running')
  `, [threadId, visitorId]);
  await query(`
    INSERT INTO wb_runs (
      id, visitor_id, thread_id, agent_id, model_id, status, execution_input,
      lease_owner, lease_epoch, lease_expires_at, worker_attempt
    ) VALUES ($1, $2, $3, 'search-agent', 'deepseek-v4-flash', 'running', '{}'::jsonb,
      $4, 1, now() + interval '5 minutes', 1)
  `, [runId, visitorId, threadId, owner]);
  return {
    run: {
      id: runId,
      visitorId,
      threadId,
      projectId: null,
      modelId: "deepseek-v4-flash",
      agentId: "search-agent"
    },
    lease: { owner, epoch: 1 }
  };
}

function checkpointBatch(suffix: string, input: {
  checkpointId?: string;
  parentCheckpointId?: string | null;
  step?: number;
  streamSeq?: number;
} = {}): ClaimedCheckpointBatch {
  const streamId = `stream_${suffix}`;
  const streamSeq = input.streamSeq ?? 1;
  return {
    sourceEvents: [{
      version: 1,
      eventId: `${streamId}_${streamSeq}`,
      streamId,
      streamSeq,
      seq: streamSeq,
      createdAt: "2026-08-06T00:00:01Z",
      type: "node.started",
      node: "plan_research",
      nodeRunId: `node_${suffix}`,
      agent: "planner",
      iteration: 0
    }],
    boundary: {
      version: 1,
      eventId: `${streamId}_${streamSeq + 1}`,
      streamId,
      streamSeq: streamSeq + 1,
      seq: streamSeq + 1,
      createdAt: "2026-08-06T00:00:02Z",
      type: "checkpoint.committed",
      checkpointId: input.checkpointId ?? `checkpoint_${suffix}`,
      parentCheckpointId: input.parentCheckpointId ?? null,
      checkpointNs: "",
      checkpointSessionId: `session_${suffix}`,
      step: input.step ?? -1
    },
    events: [{ type: "run.status", payload: { status: "running", suffix } }]
  };
}

async function projectionCounts(runId: string) {
  const result = await query<{
    revision: string;
    commits: string;
    inbox: string;
    events: string;
    outbox: string;
  }>(`
    SELECT run.revision::text AS revision,
      (SELECT count(*) FROM wb_checkpoint_commits WHERE run_id = run.id)::text AS commits,
      (SELECT count(*) FROM wb_source_event_inbox WHERE run_id = run.id)::text AS inbox,
      (SELECT count(*) FROM wb_agent_events WHERE run_id = run.id)::text AS events,
      (SELECT count(*) FROM wb_agent_event_outbox WHERE run_id = run.id)::text AS outbox
    FROM wb_runs run WHERE run.id = $1
  `, [runId]);
  return result.rows[0];
}

async function installFailureTrigger(
  stage: string,
  table: "wb_runs" | "wb_source_event_inbox" | "wb_agent_events" | "wb_agent_event_outbox",
  runId: string
) {
  const token = randomUUID().replaceAll("-", "");
  const functionName = `wb_issue50_fail_${stage}_${token}`;
  const trigger = `wb_issue50_trigger_${stage}_${token}`;
  const operation = table === "wb_runs" ? "UPDATE OF revision" : "INSERT";
  const runColumn = table === "wb_runs" ? "NEW.id" : "NEW.run_id";
  await query(`
    CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $function$
    BEGIN
      IF ${runColumn} = '${runId}' THEN
        RAISE EXCEPTION 'issue50 injected ${stage} failure';
      END IF;
      RETURN NEW;
    END;
    $function$;
    CREATE TRIGGER ${trigger}
    AFTER ${operation} ON ${table}
    FOR EACH ROW EXECUTE FUNCTION ${functionName}();
  `);
  const object = { trigger, functionName, table };
  databaseObjects.add(object);
  return object;
}

async function removeFailureTrigger(object: { trigger: string; functionName: string; table: string }) {
  await query(`
    DROP TRIGGER IF EXISTS ${object.trigger} ON ${object.table};
    DROP FUNCTION IF EXISTS ${object.functionName}();
  `);
  databaseObjects.delete(object);
}

afterAll(async () => {
  for (const object of databaseObjects) await removeFailureTrigger(object);
  for (const visitorId of visitors) {
    await query("DELETE FROM wb_visitors WHERE id = $1", [visitorId]);
  }
  await closeDatabase();
});

describe.skipIf(!runLiveIntegration)("Issue 50 checkpoint batch 真实 PostgreSQL 契约", () => {
  it("重复提交幂等，冲突内容、断裂 parent 与旧 lease 均 fail closed", async () => {
    const claim = await createClaim();
    const batch = checkpointBatch("idempotent");

    await expect(commitClaimedCheckpointBatch(claim, batch)).resolves.toMatchObject({
      status: "committed",
      revision: 1
    });
    const committedCounts = await projectionCounts(claim.run.id);
    expect(committedCounts).toEqual({ revision: "1", commits: "1", inbox: "2", events: "1", outbox: "1" });

    await expect(commitClaimedCheckpointBatch(claim, batch)).resolves.toMatchObject({
      status: "duplicate",
      revision: 1
    });
    expect(await projectionCounts(claim.run.id)).toEqual(committedCounts);

    expect(canonicalCheckpointBatchHash({
      ...batch,
      events: [{ type: "run.status", payload: { status: "waiting" } }]
    })).not.toBe(canonicalCheckpointBatchHash(batch));
    await expect(commitClaimedCheckpointBatch(claim, {
      ...batch,
      events: [{ type: "run.status", payload: { status: "waiting" } }]
    })).rejects.toBeInstanceOf(CheckpointBatchConflictError);
    expect(await projectionCounts(claim.run.id)).toEqual(committedCounts);

    const brokenParent = checkpointBatch("broken_parent", {
      checkpointId: "checkpoint_broken_parent",
      parentCheckpointId: "checkpoint_missing",
      step: 0
    });
    brokenParent.boundary.checkpointSessionId = batch.boundary.checkpointSessionId;
    await expect(commitClaimedCheckpointBatch(claim, brokenParent)).rejects.toBeInstanceOf(CheckpointParentConflictError);
    expect(await projectionCounts(claim.run.id)).toEqual(committedCounts);

    await query(`
      UPDATE wb_runs
      SET lease_owner = 'replacement', lease_epoch = lease_epoch + 1,
          lease_expires_at = now() + interval '5 minutes'
      WHERE id = $1
    `, [claim.run.id]);
    const next = checkpointBatch("old_lease", {
      checkpointId: "checkpoint_after_takeover",
      parentCheckpointId: batch.boundary.checkpointId,
      step: 0
    });
    next.boundary.checkpointSessionId = batch.boundary.checkpointSessionId;
    await expect(commitClaimedCheckpointBatch(claim, next)).resolves.toBeNull();
    expect(await projectionCounts(claim.run.id)).toEqual(committedCounts);
  });

  it("终态提交清除 lease 后，相同 batch 重投仍是只读幂等成功", async () => {
    const claim = await createClaim();
    const batch = checkpointBatch("terminal_duplicate");
    batch.sourceEvents = [{
      version: 1,
      eventId: `${batch.boundary.streamId}_1`,
      streamId: batch.boundary.streamId,
      streamSeq: 1,
      seq: 1,
      createdAt: "2026-08-06T00:00:01Z",
      type: "run.failed",
      reasonCode: "TEST_FAILURE",
      message: "测试失败"
    }];
    batch.events = [{
      type: "run.failed",
      payload: { reasonCode: "TEST_FAILURE", message: "测试失败" }
    }];
    batch.terminal = { status: "failed" };

    await expect(commitClaimedCheckpointBatch(claim, batch)).resolves.toMatchObject({
      status: "committed",
      revision: 1
    });
    const committedCounts = await projectionCounts(claim.run.id);
    await expect(commitClaimedCheckpointBatch(claim, batch)).resolves.toMatchObject({
      status: "duplicate",
      revision: 1
    });
    expect(await projectionCounts(claim.run.id)).toEqual(committedCounts);
  });

  it("Run、Inbox、AgentEvent 与 Outbox 任一阶段失败都会完整回滚且可重试", async () => {
    const stages = [
      { name: "run", table: "wb_runs" as const },
      { name: "inbox", table: "wb_source_event_inbox" as const },
      { name: "event", table: "wb_agent_events" as const },
      { name: "outbox", table: "wb_agent_event_outbox" as const }
    ];

    for (const stage of stages) {
      const claim = await createClaim();
      const batch = checkpointBatch(`fault_${stage.name}`);
      const trigger = await installFailureTrigger(stage.name, stage.table, claim.run.id);
      await expect(commitClaimedCheckpointBatch(claim, batch)).rejects.toThrow(`issue50 injected ${stage.name} failure`);
      expect(await projectionCounts(claim.run.id)).toEqual({
        revision: "0",
        commits: "0",
        inbox: "0",
        events: "0",
        outbox: "0"
      });

      await removeFailureTrigger(trigger);
      await expect(commitClaimedCheckpointBatch(claim, batch)).resolves.toMatchObject({
        status: "committed",
        revision: 1
      });
      expect(await projectionCounts(claim.run.id)).toEqual({
        revision: "1",
        commits: "1",
        inbox: "2",
        events: "1",
        outbox: "1"
      });
    }
  });

  it("schema 可重复执行并由目录约束与 revision trigger 强制不变量", async () => {
    await closeDatabase();
    await query("SELECT 1");
    await closeDatabase();
    await query("SELECT 1");

    const tables = await query<{ table_name: string | null }>(`
      SELECT unnest(ARRAY[
        to_regclass('wb_checkpoint_commits')::text,
        to_regclass('wb_source_event_inbox')::text,
        to_regclass('wb_agent_event_outbox')::text
      ]) AS table_name
    `);
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "wb_checkpoint_commits",
      "wb_source_event_inbox",
      "wb_agent_event_outbox"
    ]);

    const constraints = await query<{ table_name: string; constraint_name: string; definition: string }>(`
      SELECT conrelid::regclass::text AS table_name, conname AS constraint_name,
        pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid IN (
        'wb_runs'::regclass,
        'wb_checkpoint_commits'::regclass,
        'wb_source_event_inbox'::regclass,
        'wb_agent_event_outbox'::regclass
      )
    `);
    const definitions = constraints.rows.map((row) => `${row.table_name}: ${row.definition}`).join("\n");
    const constraintNames = constraints.rows.map((row) => row.constraint_name);
    expect(definitions).toContain("CHECK ((revision >= 0))");
    expect(definitions).toContain("UNIQUE (run_id, revision)");
    expect(definitions).toContain("UNIQUE (run_id, source_stream_id, source_stream_seq)");
    expect(definitions).toContain("CHECK ((attempts >= 0))");
    expect(constraintNames).toContain("wb_checkpoint_commits_checkpoint_session_id_valid");
    expect(constraintNames).toContain("wb_checkpoint_commits_checkpoint_ns_valid");

    const trigger = await query<{ enabled: string }>(`
      SELECT tgenabled AS enabled
      FROM pg_trigger
      WHERE tgrelid = 'wb_runs'::regclass
        AND tgname = 'wb_runs_revision_monotonic'
        AND NOT tgisinternal
    `);
    expect(trigger.rows).toEqual([{ enabled: "O" }]);

    const claim = await createClaim();
    await expect(query(`
      UPDATE wb_runs
      SET revision = 1,
          checkpoint_id = 'checkpoint_without_commit',
          checkpoint_session_id = 'session_without_commit',
          checkpoint_ns = '',
          checkpoint_step = -1
      WHERE id = $1
    `, [claim.run.id])).rejects.toThrow(/wb_runs_checkpoint_authority|foreign key/u);
    expect((await projectionCounts(claim.run.id)).revision).toBe("0");

    await expect(query(`
      UPDATE wb_runs
      SET revision = 2,
          checkpoint_id = 'checkpoint_skip',
          checkpoint_session_id = 'session_skip',
          checkpoint_ns = '',
          checkpoint_step = 0
      WHERE id = $1
    `, [claim.run.id])).rejects.toThrow("revision must remain stable or advance by one");
    expect((await projectionCounts(claim.run.id)).revision).toBe("0");
  });
});
