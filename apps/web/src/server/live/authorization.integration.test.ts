import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { VISITOR_COOKIE } from "@/lib/visitor-session";
import { closeDatabase, query } from "@/server/persistence/database";
import { handleLive } from "./handler";
import {
  createLiveProject,
  createLiveThread,
  prepareLiveRun,
  rememberProjectExchange
} from "./store";

const runLiveIntegration = process.env.WORKBENCH_LIVE_INTEGRATION === "1";
const visitorIds = new Set<string>();
const tenantIds = new Set<string>();
const databaseObjects = new Set<{ trigger: string; functionName: string }>();

type PrincipalFixture = { id: string; tenantId: string; token: string };

function identifier(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

async function createPrincipal(tenantId: string): Promise<PrincipalFixture> {
  const id = randomUUID();
  const token = `wbv_${randomBytes(32).toString("base64url")}`;
  const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");
  await query("INSERT INTO wb_visitors (id, token_hash, tenant_id) VALUES ($1, $2, $3)", [id, tokenHash, tenantId]);
  visitorIds.add(id);
  tenantIds.add(tenantId);
  return { id, tenantId, token };
}

function liveRequest(
  principal: PrincipalFixture,
  path: string,
  init: RequestInit = {}
) {
  const headers = new Headers(init.headers);
  headers.set("cookie", `${VISITOR_COOKIE}=${principal.token}`);
  if (init.body && typeof init.body === "string") headers.set("content-type", "application/json");
  return handleLive(new Request(`http://localhost${path}`, { ...init, headers }), path);
}

afterAll(async () => {
  for (const object of databaseObjects) {
    await query(`DROP TRIGGER IF EXISTS ${object.trigger} ON wb_audit_events; DROP FUNCTION IF EXISTS ${object.functionName}();`);
  }
  for (const visitorId of visitorIds) await query("DELETE FROM wb_visitors WHERE id = $1", [visitorId]);
  for (const tenantId of tenantIds) {
    await query("DELETE FROM wb_audit_events WHERE tenant_id = $1", [tenantId]);
    await query("DELETE FROM wb_tenant_quotas WHERE tenant_id = $1", [tenantId]);
  }
  await closeDatabase();
});

describe.skipIf(!runLiveIntegration)("Issue 56 真实 PostgreSQL 授权拒绝矩阵", () => {
  it("跨 tenant 与同 tenant 不同 visitor 均不泄漏资源，拒绝可审计且无半写", async () => {
    const tenantA = identifier("tenant_a").slice(0, 60);
    const tenantB = identifier("tenant_b").slice(0, 60);
    const owner = await createPrincipal(tenantA);
    const sameTenantOtherVisitor = await createPrincipal(tenantA);
    const attacker = await createPrincipal(tenantB);

    const projectA = await createLiveProject(owner.id, "甲项目");
    const threadA = await createLiveThread(owner.id, projectA.id, "甲会话");
    expect(threadA).not.toBeNull();
    const prepared = await prepareLiveRun({
      visitorId: owner.id,
      tenantId: owner.tenantId,
      threadId: threadA!.id,
      message: "甲租户事实",
      modelId: "deepseek-v4-flash",
      agentId: "search-agent",
      attachmentIds: [],
      memoryRecallItems: 24,
      memoryMaxChars: 16_000
    });
    expect(prepared).not.toBeNull();
    await expect(rememberProjectExchange(prepared!.run, {
      userMessage: "甲租户事实",
      assistantMessage: "已记录甲租户事实"
    })).resolves.toBe(2);
    const memory = await query<{ id: string; content: string }>(`
      SELECT id, content FROM wb_project_memories
      WHERE visitor_id = $1 AND source_run_id = $2 AND role = 'assistant'
    `, [owner.id, prepared!.run.id]);
    expect(memory.rows).toHaveLength(1);

    const attachmentId = identifier("att");
    await query(`
      INSERT INTO wb_attachments (id, visitor_id, thread_id, name, mime_type, size_bytes, kind, bytes)
      VALUES ($1, $2, $3, 'secret.txt', 'text/plain', 6, 'document', $4)
    `, [attachmentId, owner.id, threadA!.id, Buffer.from("secret")]);

    const foreignProject = await liveRequest(attacker, `/api/v1/projects/${projectA.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "越权改名" })
    });
    const missingProjectId = identifier("project_missing");
    const missingProject = await liveRequest(attacker, `/api/v1/projects/${missingProjectId}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "不存在项目" })
    });
    expect(foreignProject.status).toBe(404);
    expect(missingProject.status).toBe(404);
    expect(await foreignProject.json()).toEqual(await missingProject.json());

    expect((await liveRequest(attacker, `/api/v1/projects/${projectA.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await liveRequest(attacker, `/api/v1/projects/${projectA.id}/threads`)).status).toBe(404);
    expect((await liveRequest(attacker, `/api/v1/projects/${projectA.id}/threads`, {
      method: "POST",
      body: JSON.stringify({ title: "越权会话" })
    })).status).toBe(404);

    const foreignThread = await liveRequest(attacker, `/api/v1/threads/${threadA!.id}`);
    const sameTenantForeignThread = await liveRequest(sameTenantOtherVisitor, `/api/v1/threads/${threadA!.id}`);
    expect(foreignThread.status).toBe(404);
    expect(sameTenantForeignThread.status).toBe(404);
    expect(await foreignThread.json()).toEqual(await sameTenantForeignThread.json());
    expect((await liveRequest(attacker, `/api/v1/threads/${threadA!.id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "越权会话改名" })
    })).status).toBe(404);
    expect((await liveRequest(attacker, `/api/v1/threads/${threadA!.id}`, { method: "DELETE" })).status).toBe(404);

    expect((await liveRequest(attacker, `/api/v1/runs/${prepared!.run.id}/events`)).status).toBe(404);
    expect((await liveRequest(attacker, `/api/v1/runs/${prepared!.run.id}/stop`, { method: "POST" })).status).toBe(404);
    expect((await liveRequest(attacker, `/api/v1/attachments/${attachmentId}`)).status).toBe(404);

    await expect(prepareLiveRun({
      visitorId: attacker.id,
      tenantId: attacker.tenantId,
      threadId: threadA!.id,
      message: "越权启动",
      modelId: "deepseek-v4-flash",
      attachmentIds: [],
      memoryRecallItems: 24,
      memoryMaxChars: 16_000
    })).resolves.toBeNull();

    const projectB = await createLiveProject(attacker.id, "乙项目");
    const threadB = await createLiveThread(attacker.id, projectB.id, "乙会话");
    await expect(prepareLiveRun({
      visitorId: attacker.id,
      tenantId: attacker.tenantId,
      threadId: threadB!.id,
      message: "使用外来附件",
      modelId: "deepseek-v4-flash",
      attachmentIds: [attachmentId],
      memoryRecallItems: 24,
      memoryMaxChars: 16_000
    })).resolves.toBeNull();

    await expect(rememberProjectExchange({
      ...prepared!.run,
      visitorId: attacker.id,
      tenantId: attacker.tenantId
    }, {
      userMessage: "伪造写入",
      assistantMessage: "不应覆盖"
    })).resolves.toBe(0);

    const memoryRead = await query("SELECT 1 FROM wb_project_memories WHERE id = $1 AND visitor_id = $2", [memory.rows[0].id, attacker.id]);
    const memoryUpdate = await query("UPDATE wb_project_memories SET content = '越权覆盖' WHERE id = $1 AND visitor_id = $2", [memory.rows[0].id, attacker.id]);
    const memoryDelete = await query("DELETE FROM wb_project_memories WHERE id = $1 AND visitor_id = $2", [memory.rows[0].id, attacker.id]);
    expect(memoryRead.rowCount).toBe(0);
    expect(memoryUpdate.rowCount).toBe(0);
    expect(memoryDelete.rowCount).toBe(0);

    const projectState = await query<{ name: string }>("SELECT name FROM wb_projects WHERE id = $1", [projectA.id]);
    const threadState = await query<{ title: string }>("SELECT title FROM wb_threads WHERE id = $1", [threadA!.id]);
    const runState = await query<{ status: string }>("SELECT status FROM wb_runs WHERE id = $1", [prepared!.run.id]);
    const attachmentState = await query<{ count: string }>("SELECT count(*)::text AS count FROM wb_attachments WHERE id = $1", [attachmentId]);
    const memoryState = await query<{ content: string }>("SELECT content FROM wb_project_memories WHERE id = $1", [memory.rows[0].id]);
    const attackerRuns = await query<{ count: string }>("SELECT count(*)::text AS count FROM wb_runs WHERE visitor_id = $1", [attacker.id]);
    expect(projectState.rows).toEqual([{ name: "甲项目" }]);
    expect(threadState.rows).toEqual([{ title: "甲租户事实" }]);
    expect(runState.rows).toEqual([{ status: "queued" }]);
    expect(attachmentState.rows).toEqual([{ count: "1" }]);
    expect(memoryState.rows).toEqual([{ content: "已记录甲租户事实" }]);
    expect(attackerRuns.rows).toEqual([{ count: "0" }]);

    const denied = await query<{
      action: string;
      outcome: string;
      reason_code: string;
      resource_kind: string;
      resource_id: string | null;
    }>(`
      SELECT action, outcome, reason_code, resource_kind, resource_id
      FROM wb_audit_events
      WHERE visitor_id = $1 AND outcome = 'denied'
      ORDER BY id
    `, [attacker.id]);
    expect(denied.rows.every((row) => row.reason_code === "RESOURCE_NOT_OWNED_OR_MISSING")).toBe(true);
    expect(denied.rows.map((row) => `${row.action}:${row.resource_kind}`)).toEqual(expect.arrayContaining([
      "project.update:project",
      "project.delete:project",
      "project.read:project",
      "thread.create:project",
      "thread.read:thread",
      "thread.update:thread",
      "thread.delete:thread",
      "run.read:run",
      "run.stop:run",
      "run.start:thread",
      "attachment.read:attachment",
      "attachment.use:attachment",
      "memory.read:memory",
      "memory.delete:memory",
      "memory.write:memory"
    ]));
    const implicitMemoryDenials = denied.rows
      .filter((row) => row.action === "memory.read" || row.action === "memory.delete")
      .map((row) => ({ action: row.action, resourceId: row.resource_id }));
    expect(implicitMemoryDenials).toHaveLength(3);
    expect(implicitMemoryDenials).toEqual(expect.arrayContaining([
      { action: "memory.delete", resourceId: `project:${projectA.id}` },
      { action: "memory.delete", resourceId: `thread:${threadA!.id}` },
      { action: "memory.read", resourceId: `thread:${threadA!.id}` }
    ]));
    expect(denied.rows.every((row) => row.outcome === "denied")).toBe(true);

    const sameTenantAudit = await query<{ action: string; reason_code: string }>(`
      SELECT action, reason_code FROM wb_audit_events WHERE visitor_id = $1
    `, [sameTenantOtherVisitor.id]);
    expect(sameTenantAudit.rows).toEqual([{
      action: "thread.read",
      reason_code: "RESOURCE_NOT_OWNED_OR_MISSING"
    }]);
  });

  it("会话移动和项目排序保留相同外部响应，并审计准确的拒绝资源", async () => {
    const owner = await createPrincipal(identifier("tenant_move_owner").slice(0, 60));
    const attacker = await createPrincipal(identifier("tenant_move_attacker").slice(0, 60));
    const ownerProject = await createLiveProject(owner.id, "移动源项目");
    const ownerThread = await createLiveThread(owner.id, ownerProject.id, "移动源会话");
    const attackerProject = await createLiveProject(attacker.id, "外来目标项目");

    const foreignTarget = await liveRequest(owner, `/api/v1/threads/${ownerThread!.id}`, {
      method: "PATCH",
      body: JSON.stringify({ projectId: attackerProject.id })
    });
    const missingProjectId = identifier("project_missing");
    const missingTarget = await liveRequest(owner, `/api/v1/threads/${ownerThread!.id}`, {
      method: "PATCH",
      body: JSON.stringify({ projectId: missingProjectId })
    });
    expect(foreignTarget.status).toBe(404);
    expect(missingTarget.status).toBe(404);
    expect(await foreignTarget.json()).toEqual(await missingTarget.json());

    const invalidOrder = await liveRequest(attacker, "/api/v1/projects/reorder", {
      method: "PATCH",
      body: JSON.stringify({ projectIds: [attackerProject.id, attackerProject.id] })
    });
    expect(invalidOrder.status).toBe(400);
    const foreignOrder = await liveRequest(attacker, "/api/v1/projects/reorder", {
      method: "PATCH",
      body: JSON.stringify({ projectIds: [ownerProject.id] })
    });
    expect(foreignOrder.status).toBe(400);
    expect(await foreignOrder.json()).toEqual(await invalidOrder.json());

    const ownerAudit = await query<{ action: string; resource_kind: string; resource_id: string }>(`
      SELECT action, resource_kind, resource_id
      FROM wb_audit_events
      WHERE visitor_id = $1 AND outcome = 'denied'
      ORDER BY id
    `, [owner.id]);
    expect(ownerAudit.rows).toEqual([
      { action: "thread.update", resource_kind: "project", resource_id: attackerProject.id },
      { action: "thread.update", resource_kind: "project", resource_id: missingProjectId }
    ]);

    const attackerAudit = await query<{ action: string; resource_kind: string; resource_id: string }>(`
      SELECT action, resource_kind, resource_id
      FROM wb_audit_events
      WHERE visitor_id = $1 AND outcome = 'denied'
      ORDER BY id
    `, [attacker.id]);
    expect(attackerAudit.rows).toEqual([{
      action: "project.reorder",
      resource_kind: "project",
      resource_id: ownerProject.id
    }]);
    const unchanged = await query<{ project_id: string | null }>("SELECT project_id FROM wb_threads WHERE id = $1 AND visitor_id = $2", [ownerThread!.id, owner.id]);
    expect(unchanged.rows).toEqual([{ project_id: ownerProject.id }]);
  });

  it("批量 memory.delete 审计失败会回滚 thread.delete 父审计且不删除保留记忆", async () => {
    const principal = await createPrincipal(identifier("tenant_stale_delete").slice(0, 60));
    const project = await createLiveProject(principal.id, "保留记忆项目");
    const thread = await createLiveThread(principal.id, project.id, "待 TTL 会话");
    const prepared = await prepareLiveRun({
      visitorId: principal.id,
      tenantId: principal.tenantId,
      threadId: thread!.id,
      message: "TTL 后仍需保留的事实",
      modelId: "deepseek-v4-flash",
      attachmentIds: [],
      memoryRecallItems: 24,
      memoryMaxChars: 16_000
    });
    expect(prepared).not.toBeNull();
    await expect(rememberProjectExchange(prepared!.run, {
      userMessage: "TTL 后仍需保留的事实",
      assistantMessage: "项目记忆必须继续存在"
    })).resolves.toBe(2);

    await query(`
      UPDATE wb_threads
      SET status = 'idle', updated_at = now() - interval '4 days'
      WHERE id = $1 AND visitor_id = $2
    `, [thread!.id, principal.id]);
    const ttlDelete = await query(`
      DELETE FROM wb_threads
      WHERE id = $1 AND visitor_id = $2
        AND updated_at < now() - interval '3 days'
        AND status NOT IN ('running', 'waiting')
    `, [thread!.id, principal.id]);
    expect(ttlDelete.rowCount).toBe(1);
    const retainedBefore = await query<{ count: string }>("SELECT count(*)::text AS count FROM wb_project_memories WHERE visitor_id = $1 AND source_thread_id = $2", [principal.id, thread!.id]);
    expect(retainedBefore.rows).toEqual([{ count: "2" }]);

    const token = randomUUID().replaceAll("-", "");
    const functionName = `wb_issue56_fail_thread_delete_audit_${token}`;
    const trigger = `wb_issue56_thread_delete_audit_trigger_${token}`;
    await query(`
      CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $function$
      BEGIN
        IF NEW.visitor_id = '${principal.id}'::uuid
          AND NEW.action = 'memory.delete'
          AND NEW.outcome = 'denied' THEN
          RAISE EXCEPTION 'issue56 injected memory delete audit failure';
        END IF;
        RETURN NEW;
      END;
      $function$;
      CREATE TRIGGER ${trigger}
      AFTER INSERT ON wb_audit_events
      FOR EACH ROW EXECUTE FUNCTION ${functionName}();
    `);
    const object = { trigger, functionName };
    databaseObjects.add(object);

    const failedAudit = await liveRequest(principal, `/api/v1/threads/${thread!.id}`, { method: "DELETE" });
    expect(failedAudit.status).toBe(503);
    const retainedAfterFailure = await query<{ count: string }>("SELECT count(*)::text AS count FROM wb_project_memories WHERE visitor_id = $1 AND source_thread_id = $2", [principal.id, thread!.id]);
    expect(retainedAfterFailure.rows).toEqual([{ count: "2" }]);
    const rolledBackAudit = await query<{ action: string }>(`
      SELECT action FROM wb_audit_events
      WHERE visitor_id = $1 AND outcome = 'denied'
    `, [principal.id]);
    expect(rolledBackAudit.rows).toEqual([]);

    await query(`DROP TRIGGER IF EXISTS ${trigger} ON wb_audit_events; DROP FUNCTION IF EXISTS ${functionName}();`);
    databaseObjects.delete(object);
    const denied = await liveRequest(principal, `/api/v1/threads/${thread!.id}`, { method: "DELETE" });
    expect(denied.status).toBe(404);
    const retainedAfterDenied = await query<{ count: string }>("SELECT count(*)::text AS count FROM wb_project_memories WHERE visitor_id = $1 AND source_thread_id = $2", [principal.id, thread!.id]);
    expect(retainedAfterDenied.rows).toEqual([{ count: "2" }]);
    const audit = await query<{ action: string; resource_kind: string; resource_id: string }>(`
      SELECT action, resource_kind, resource_id
      FROM wb_audit_events
      WHERE visitor_id = $1 AND outcome = 'denied'
      ORDER BY id
    `, [principal.id]);
    expect(audit.rows).toEqual([
      {
        action: "thread.delete",
        resource_kind: "thread",
        resource_id: thread!.id
      },
      {
        action: "memory.delete",
        resource_kind: "memory",
        resource_id: `thread:${thread!.id}`
      }
    ]);
  });

  it("memory.read denied 审计失败会回滚同事务的 run.start 父审计", async () => {
    const principal = await createPrincipal(identifier("tenant_memory_read_audit").slice(0, 60));
    const missingThreadId = identifier("thread_missing");
    const token = randomUUID().replaceAll("-", "");
    const functionName = `wb_issue56_fail_memory_read_audit_${token}`;
    const trigger = `wb_issue56_memory_read_audit_trigger_${token}`;
    await query(`
      CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $function$
      BEGIN
        IF NEW.visitor_id = '${principal.id}'::uuid
          AND NEW.action = 'memory.read'
          AND NEW.outcome = 'denied' THEN
          RAISE EXCEPTION 'issue56 injected memory read audit failure';
        END IF;
        RETURN NEW;
      END;
      $function$;
      CREATE TRIGGER ${trigger}
      AFTER INSERT ON wb_audit_events
      FOR EACH ROW EXECUTE FUNCTION ${functionName}();
    `);
    const object = { trigger, functionName };
    databaseObjects.add(object);

    await expect(prepareLiveRun({
      visitorId: principal.id,
      tenantId: principal.tenantId,
      threadId: missingThreadId,
      message: "拒绝读取外来记忆",
      modelId: "deepseek-v4-flash",
      attachmentIds: [],
      memoryRecallItems: 24,
      memoryMaxChars: 16_000
    })).rejects.toThrow("issue56 injected memory read audit failure");
    const rolledBack = await query<{ action: string }>(`
      SELECT action FROM wb_audit_events
      WHERE visitor_id = $1 AND outcome = 'denied'
    `, [principal.id]);
    expect(rolledBack.rows).toEqual([]);

    await query(`DROP TRIGGER IF EXISTS ${trigger} ON wb_audit_events; DROP FUNCTION IF EXISTS ${functionName}();`);
    databaseObjects.delete(object);
    await expect(prepareLiveRun({
      visitorId: principal.id,
      tenantId: principal.tenantId,
      threadId: missingThreadId,
      message: "拒绝读取外来记忆",
      modelId: "deepseek-v4-flash",
      attachmentIds: [],
      memoryRecallItems: 24,
      memoryMaxChars: 16_000
    })).resolves.toBeNull();
    const committed = await query<{ action: string; resource_kind: string; resource_id: string }>(`
      SELECT action, resource_kind, resource_id
      FROM wb_audit_events
      WHERE visitor_id = $1 AND outcome = 'denied'
      ORDER BY id
    `, [principal.id]);
    expect(committed.rows).toEqual([
      {
        action: "run.start",
        resource_kind: "thread",
        resource_id: missingThreadId
      },
      {
        action: "memory.read",
        resource_kind: "memory",
        resource_id: `thread:${missingThreadId}`
      }
    ]);
  });

  it("queued 生命周期审计失败会回滚 Run、初始事件、Thread 状态与 allowed 准入", async () => {
    const tenantId = identifier("tenant_queue").slice(0, 60);
    const principal = await createPrincipal(tenantId);
    const project = await createLiveProject(principal.id, "排队审计项目");
    const thread = await createLiveThread(principal.id, project.id, "排队审计会话");
    const token = randomUUID().replaceAll("-", "");
    const functionName = `wb_issue56_fail_queue_audit_${token}`;
    const trigger = `wb_issue56_queue_audit_trigger_${token}`;
    await query(`
      CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $function$
      BEGIN
        IF NEW.visitor_id = '${principal.id}'::uuid
          AND NEW.action = 'run.lifecycle'
          AND NEW.outcome = 'queued' THEN
          RAISE EXCEPTION 'issue56 injected queued audit failure';
        END IF;
        RETURN NEW;
      END;
      $function$;
      CREATE TRIGGER ${trigger}
      AFTER INSERT ON wb_audit_events
      FOR EACH ROW EXECUTE FUNCTION ${functionName}();
    `);
    const object = { trigger, functionName };
    databaseObjects.add(object);

    await expect(prepareLiveRun({
      visitorId: principal.id,
      tenantId: principal.tenantId,
      threadId: thread!.id,
      message: "审计失败不得留下半写",
      modelId: "deepseek-v4-flash",
      attachmentIds: [],
      memoryRecallItems: 24,
      memoryMaxChars: 16_000
    })).rejects.toThrow("issue56 injected queued audit failure");

    const rolledBack = await query<{ status: string; runs: string; events: string; allowed: string; queued: string }>(`
      SELECT thread.status,
        (SELECT count(*) FROM wb_runs WHERE visitor_id = $1 AND thread_id = thread.id)::text AS runs,
        (SELECT count(*) FROM wb_agent_events WHERE visitor_id = $1 AND thread_id = thread.id)::text AS events,
        (SELECT count(*) FROM wb_audit_events WHERE visitor_id = $1 AND action = 'run.start' AND outcome = 'allowed')::text AS allowed,
        (SELECT count(*) FROM wb_audit_events WHERE visitor_id = $1 AND action = 'run.lifecycle' AND outcome = 'queued')::text AS queued
      FROM wb_threads thread WHERE thread.id = $2 AND thread.visitor_id = $1
    `, [principal.id, thread!.id]);
    expect(rolledBack.rows).toEqual([{
      status: "idle",
      runs: "0",
      events: "0",
      allowed: "0",
      queued: "0"
    }]);

    await query(`DROP TRIGGER IF EXISTS ${trigger} ON wb_audit_events; DROP FUNCTION IF EXISTS ${functionName}();`);
    databaseObjects.delete(object);
    const retried = await prepareLiveRun({
      visitorId: principal.id,
      tenantId: principal.tenantId,
      threadId: thread!.id,
      message: "审计恢复后正常入队",
      modelId: "deepseek-v4-flash",
      attachmentIds: [],
      memoryRecallItems: 24,
      memoryMaxChars: 16_000
    });
    expect(retried).not.toBeNull();
    const committed = await query<{ allowed: string; queued: string }>(`
      SELECT
        (SELECT count(*) FROM wb_audit_events WHERE visitor_id = $1 AND action = 'run.start' AND outcome = 'allowed')::text AS allowed,
        (SELECT count(*) FROM wb_audit_events WHERE visitor_id = $1 AND action = 'run.lifecycle' AND outcome = 'queued')::text AS queued
    `, [principal.id]);
    expect(committed.rows).toEqual([{ allowed: "1", queued: "1" }]);
  });
});
