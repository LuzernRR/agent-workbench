import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closeDatabase, query } from "@/server/persistence/database";
import { commitClaimedCheckpointBatch, type ClaimedCheckpointBatch } from "./checkpoint-batches";
import {
  claimNextLiveRun,
  createUserStoppedPayload,
  createLiveProject,
  createLiveThread,
  deleteExpiredLiveThreads,
  deleteLiveThread,
  finalizeClaimedLiveRun,
  finalizeLiveRun,
  getLiveSnapshot,
  persistClaimedLiveEvent,
  prepareLiveRun,
  requestLiveRunStop,
  releaseLiveRunLease,
  renewLiveRunLease,
  settleClaimedTerminalSettlement,
  stageClaimedTerminalSettlement,
  updateLiveThread,
  type PreparedRun
} from "./store";
import { mapSearchAgentEvent } from "@/server/search-agent/mapper";
import type { SearchAgentEvent } from "@/server/search-agent/events";
import type { DirectTerminalSettlement } from "./terminal-settlements";

const runLiveIntegration = process.env.WORKBENCH_LIVE_INTEGRATION === "1";
const visitors: string[] = [];

function identifier(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

async function createVisitor(tenantId = "tenant-integration") {
  const visitorId = randomUUID();
  const tokenHash = createHash("sha256").update(randomUUID(), "utf8").digest("hex");
  await query("INSERT INTO wb_visitors (id, token_hash, tenant_id) VALUES ($1, $2, $3)", [visitorId, tokenHash, tenantId]);
  visitors.push(visitorId);
  return visitorId;
}

async function prepare(visitorId: string, threadId: string, message: string, replaceMessageId?: string) {
  const principal = await query<{ tenant_id: string }>("SELECT tenant_id FROM wb_visitors WHERE id = $1", [visitorId]);
  const prepared = await prepareLiveRun({
    visitorId,
    tenantId: principal.rows[0].tenant_id,
    threadId,
    message,
    modelId: "deepseek-v4-flash",
    agentId: "search-agent",
    attachmentIds: [],
    replaceMessageId,
    memoryRecallItems: 24,
    memoryMaxChars: 16_000
  });
  expect(prepared).not.toBeNull();
  return prepared as PreparedRun;
}

async function complete(prepared: PreparedRun, userMessage: string, assistantMessage: string) {
  const assistantMessageId = `msg_${randomUUID().replaceAll("-", "")}`;
  const events = await finalizeLiveRun(prepared.run, "completed", {
    finishReason: "stop",
    usage: { input_tokens: 13, output_tokens: 8, total_tokens: 21, cost_usd: 0.031 }
  }, {
    events: [
      { type: "message.started", payload: { messageId: assistantMessageId, role: "assistant", text: "" } },
      { type: "message.completed", payload: { messageId: assistantMessageId, text: assistantMessage, citations: [] } }
    ],
    memory: { userMessage, assistantMessage }
  });
  expect(events?.at(-1)?.type).toBe("run.completed");
}

async function stop(prepared: PreparedRun) {
  const events = await finalizeLiveRun(prepared.run, "stopped", {});
  expect(events?.at(-1)?.type).toBe("run.cancelled");
}

function directStoppedSettlement(input: {
  runId: string;
  streamId: string;
  toolCallId: string;
  usage: { input_tokens: number; output_tokens: number; total_tokens: number; cost_usd: number };
}): DirectTerminalSettlement {
  const sourceEvents: SearchAgentEvent[] = [
    {
      version: 1,
      eventId: `${input.streamId}_000001`,
      streamId: input.streamId,
      streamSeq: 1,
      seq: 1,
      createdAt: "2026-08-08T00:00:00Z",
      type: "tool.started",
      toolCallId: input.toolCallId,
      toolName: "web_search",
      query: "durable terminal settlement",
      channel: "web",
      cached: false
    },
    {
      version: 1,
      eventId: `${input.streamId}_000002`,
      streamId: input.streamId,
      streamSeq: 2,
      seq: 2,
      createdAt: "2026-08-08T00:00:01Z",
      type: "run.stopped",
      runId: input.runId,
      responseStatus: "partial",
      reasonCode: "USER_STOPPED",
      usage: input.usage
    }
  ];
  const events = sourceEvents.slice(0, -1).flatMap((event) => mapSearchAgentEvent(event, input.runId).events);
  const terminal = mapSearchAgentEvent(sourceEvents.at(-1)!, input.runId).terminal;
  if (terminal?.kind !== "stopped") throw new Error("测试 settlement 缺少 stopped 投影");
  return { terminalStatus: "stopped", sourceEvents, events, terminalPayload: terminal.payload };
}

function directFailedSettlement(input: {
  runId: string;
  streamId: string;
  toolCallId: string;
  usage: { input_tokens: number; output_tokens: number; total_tokens: number; cost_usd: number };
}): DirectTerminalSettlement {
  const stopped = directStoppedSettlement(input);
  const stoppedTerminal = stopped.sourceEvents.at(-1);
  if (!stoppedTerminal || stoppedTerminal.type !== "run.stopped") throw new Error("测试 settlement 缺少 stopped source");
  const failed: SearchAgentEvent = {
    version: stoppedTerminal.version,
    eventId: stoppedTerminal.eventId,
    streamId: stoppedTerminal.streamId,
    streamSeq: stoppedTerminal.streamSeq,
    seq: stoppedTerminal.seq,
    createdAt: stoppedTerminal.createdAt,
    type: "run.failed" as const,
    reasonCode: "SEARCH_UNAVAILABLE",
    message: "搜索服务不可用",
    usage: stoppedTerminal.usage
  };
  const sourceEvents = [...stopped.sourceEvents.slice(0, -1), failed];
  const terminal = mapSearchAgentEvent(sourceEvents.at(-1)!, input.runId).terminal;
  if (terminal?.kind !== "failed") throw new Error("测试 settlement 缺少 failed 投影");
  return {
    terminalStatus: "failed",
    sourceEvents,
    events: stopped.events,
    terminalPayload: terminal.payload
  };
}

afterAll(async () => {
  for (const visitorId of visitors) {
    await query("DELETE FROM wb_visitors WHERE id = $1", [visitorId]);
  }
});

describe.skipIf(!runLiveIntegration)("真实 PostgreSQL 分层记忆契约", () => {
  it("验证会话、项目、访客、编辑、移动、停止与 TTL 的完整边界", async () => {
    const visitorOne = await createVisitor();
    const visitorTwo = await createVisitor();
    const projectOne = await createLiveProject(visitorOne, "记忆项目甲");
    const projectTwo = await createLiveProject(visitorOne, "记忆项目乙");
    const visitorTwoProject = await createLiveProject(visitorTwo, "访客乙项目");
    const source = await createLiveThread(visitorOne, projectOne.id, "来源会话");
    const sameProject = await createLiveThread(visitorOne, projectOne.id, "同项目会话");
    const otherProject = await createLiveThread(visitorOne, projectTwo.id, "其他项目会话");
    const otherVisitor = await createLiveThread(visitorTwo, visitorTwoProject.id, "其他访客会话");
    const standalone = await createLiveThread(visitorOne, null, "无项目会话");
    expect(source && sameProject && otherProject && otherVisitor && standalone).toBeTruthy();

    const first = await prepare(visitorOne, source!.id, "旧项目事实是霜塔");
    await complete(first, "旧项目事实是霜塔", "已记录旧项目事实霜塔");

    const sameSession = await prepare(visitorOne, source!.id, "回忆上一轮");
    expect(sameSession.history).toEqual([
      { role: "user", content: "旧项目事实是霜塔" },
      { role: "assistant", content: "已记录旧项目事实霜塔" }
    ]);
    await stop(sameSession);

    const recalled = await prepare(visitorOne, sameProject!.id, "项目事实是什么？");
    expect(recalled.projectMemoryContext).toContain("旧项目事实是霜塔");
    await stop(recalled);

    const isolatedProject = await prepare(visitorOne, otherProject!.id, "项目事实是什么？");
    expect(isolatedProject.projectMemoryContext).toBe("");
    await stop(isolatedProject);

    const isolatedVisitor = await prepare(visitorTwo, otherVisitor!.id, "项目事实是什么？");
    expect(isolatedVisitor.projectMemoryContext).toBe("");
    await stop(isolatedVisitor);

    const isolatedStandalone = await prepare(visitorOne, standalone!.id, "项目事实是什么？");
    expect(isolatedStandalone.projectMemoryContext).toBe("");
    await stop(isolatedStandalone);

    const edited = await prepare(visitorOne, source!.id, "新项目事实是星港", first.userMessageId);
    expect(edited.history).toEqual([]);
    await complete(edited, "新项目事实是星港", "已记录新项目事实星港");
    const afterEdit = await prepare(visitorOne, sameProject!.id, "编辑后的事实是什么？");
    expect(afterEdit.projectMemoryContext).toContain("新项目事实是星港");
    expect(afterEdit.projectMemoryContext).not.toContain("旧项目事实是霜塔");
    await stop(afterEdit);

    await updateLiveThread(visitorOne, source!.id, { projectId: projectTwo.id });
    const oldProjectAfterMove = await prepare(visitorOne, sameProject!.id, "移动后的事实在哪里？");
    expect(oldProjectAfterMove.projectMemoryContext).toBe("");
    await stop(oldProjectAfterMove);
    const newProjectAfterMove = await prepare(visitorOne, otherProject!.id, "移动后的事实在哪里？");
    expect(newProjectAfterMove.projectMemoryContext).toContain("新项目事实是星港");
    await stop(newProjectAfterMove);

    await updateLiveThread(visitorOne, source!.id, { projectId: null });
    const afterExit = await prepare(visitorOne, otherProject!.id, "移出后的事实在哪里？");
    expect(afterExit.projectMemoryContext).toBe("");
    await stop(afterExit);

    const stopped = await prepare(visitorOne, otherProject!.id, "这条运行必须停止");
    await stop(stopped);
    const stoppedMemory = await query<{ count: string }>("SELECT count(*)::text AS count FROM wb_project_memories WHERE source_run_id = $1", [stopped.run.id]);
    expect(stoppedMemory.rows[0].count).toBe("0");

    const ttlProject = await createLiveProject(visitorOne, "TTL 项目");
    const ttlThread = await createLiveThread(visitorOne, ttlProject.id, "TTL 会话");
    const ttlRun = await prepare(visitorOne, ttlThread!.id, "保留的项目事实是远帆");
    await complete(ttlRun, "保留的项目事实是远帆", "已记录保留事实远帆");
    await query("UPDATE wb_threads SET updated_at = now() - interval '4 days' WHERE id = $1 AND visitor_id = $2", [ttlThread!.id, visitorOne]);
    await deleteExpiredLiveThreads(3);
    const ttlCounts = await query<{ threads: string; runs: string; events: string; memories: string }>(`
      SELECT
        (SELECT count(*) FROM wb_threads WHERE id = $1)::text AS threads,
        (SELECT count(*) FROM wb_runs WHERE thread_id = $1)::text AS runs,
        (SELECT count(*) FROM wb_agent_events WHERE thread_id = $1)::text AS events,
        (SELECT count(*) FROM wb_project_memories WHERE source_thread_id = $1)::text AS memories
    `, [ttlThread!.id]);
    expect(ttlCounts.rows[0]).toEqual({ threads: "0", runs: "0", events: "0", memories: "2" });
  });

  it("验证 FIFO、并发 claim、租约过期接管和完整 fencing", async () => {
    const visitorId = await createVisitor();
    const project = await createLiveProject(visitorId, "Worker 队列项目");
    const firstThread = await createLiveThread(visitorId, project.id, "先入队");
    const secondThread = await createLiveThread(visitorId, project.id, "后入队");
    const first = await prepare(visitorId, firstThread!.id, "第一个持久任务");
    const second = await prepare(visitorId, secondThread!.id, "第二个持久任务");

    const firstClaim = await claimNextLiveRun("worker-fifo-a", 30_000);
    const secondClaim = await claimNextLiveRun("worker-fifo-b", 30_000);
    expect(firstClaim?.run.id).toBe(first.run.id);
    expect(secondClaim?.run.id).toBe(second.run.id);
    await finalizeClaimedLiveRun(firstClaim!, "stopped", {});
    await finalizeClaimedLiveRun(secondClaim!, "stopped", {});

    const takeoverThread = await createLiveThread(visitorId, project.id, "故障接管");
    const takeoverRun = await prepare(visitorId, takeoverThread!.id, "模拟 Worker kill");
    const concurrent = await Promise.all([
      claimNextLiveRun("worker-race-a", 30_000),
      claimNextLiveRun("worker-race-b", 30_000)
    ]);
    const original = concurrent.find((claim) => claim?.run.id === takeoverRun.run.id);
    expect(concurrent.filter(Boolean)).toHaveLength(1);
    expect(original).toBeTruthy();

    await query("UPDATE wb_runs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [takeoverRun.run.id]);
    const replacement = await claimNextLiveRun("worker-replacement", 30_000);
    expect(replacement).toMatchObject({
      run: { id: takeoverRun.run.id },
      lease: { epoch: original!.lease.epoch + 1 },
      resume: false,
      checkpoint: null,
      attempt: original!.attempt + 1
    });

    const checkpointId = identifier("checkpoint");
    const checkpointSessionId = identifier("session");
    const checkpointBatch = {
      sourceEvents: [],
      boundary: {
        version: 1,
        eventId: identifier("checkpoint_event"),
        streamId: identifier("stream"),
        streamSeq: 1,
        seq: 1,
        createdAt: "2026-08-06T00:00:00Z",
        type: "checkpoint.committed",
        checkpointId,
        parentCheckpointId: null,
        checkpointNs: "",
        checkpointSessionId,
        step: -1
      },
      events: [{ type: "run.status", payload: { status: "running", recovered: true } }]
    } satisfies ClaimedCheckpointBatch;
    await expect(commitClaimedCheckpointBatch(replacement!, checkpointBatch)).resolves.toMatchObject({
      status: "committed",
      revision: 1
    });
    await query("UPDATE wb_runs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [takeoverRun.run.id]);
    const resumed = await claimNextLiveRun("worker-checkpoint-resume", 30_000);
    expect(resumed).toMatchObject({
      run: { id: takeoverRun.run.id },
      lease: { epoch: replacement!.lease.epoch + 1 },
      resume: true,
      checkpoint: {
        id: checkpointId,
        sessionId: checkpointSessionId,
        namespace: "",
        step: -1
      },
      attempt: replacement!.attempt + 1
    });

    await expect(renewLiveRunLease(original!, 30_000)).resolves.toEqual({ renewed: false, stopRequested: false });
    await expect(releaseLiveRunLease(original!)).resolves.toBe(false);
    await expect(persistClaimedLiveEvent(original!, "run.status", { status: "late" })).resolves.toBeNull();
    await expect(finalizeClaimedLiveRun(original!, "completed", {})).resolves.toBeNull();
    await expect(renewLiveRunLease(replacement!, 30_000)).resolves.toEqual({ renewed: false, stopRequested: false });
    await expect(releaseLiveRunLease(replacement!)).resolves.toBe(false);

    await expect(persistClaimedLiveEvent(resumed!, "run.status", { status: "running", recovered: true })).resolves.toMatchObject({
      runId: takeoverRun.run.id,
      type: "run.status"
    });
    await expect(finalizeClaimedLiveRun(resumed!, "completed", { finishReason: "stop" })).resolves.toEqual([
      expect.objectContaining({ type: "run.completed" })
    ]);
    await expect(finalizeLiveRun(takeoverRun.run, "stopped", {})).resolves.toBeNull();

    const terminalEvents = await query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM wb_agent_events
      WHERE run_id = $1 AND event_type IN ('run.completed', 'run.failed', 'run.cancelled')
    `, [takeoverRun.run.id]);
    expect(terminalEvents.rows[0].count).toBe("1");
  });

  it("持有租约的 Worker 心跳读取持久停止意图但继续续租", async () => {
    const visitorId = await createVisitor();
    const project = await createLiveProject(visitorId, "停止心跳项目");
    const thread = await createLiveThread(visitorId, project.id, "停止心跳会话");
    const prepared = await prepare(visitorId, thread!.id, "等待 Worker 收口");
    const claimed = await claimNextLiveRun("worker-stop-heartbeat", 30_000);
    expect(claimed?.run.id).toBe(prepared.run.id);

    await expect(requestLiveRunStop(visitorId, prepared.run.id)).resolves.toMatchObject({
      status: "running",
      hasActiveLease: true
    });
    await expect(renewLiveRunLease(claimed!, 30_000)).resolves.toEqual({
      renewed: true,
      stopRequested: true
    });

    await expect(finalizeClaimedLiveRun(claimed!, "stopped", {
      reasonCode: "USER_STOPPED",
      partial: true,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, cost_usd: 0 }
    })).resolves.toEqual([expect.objectContaining({ type: "run.cancelled" })]);
  });

  it("首个 checkpoint 前的 failed settlement 原子写入真实 usage、审计与 outbox", async () => {
    const visitorId = await createVisitor(identifier("tenant").slice(0, 60));
    const project = await createLiveProject(visitorId, "Direct failed 项目");
    const thread = await createLiveThread(visitorId, project.id, "Direct failed 会话");
    const prepared = await prepare(visitorId, thread!.id, "恢复一个不存在的 checkpoint");
    const claimed = await claimNextLiveRun("worker-direct-failed", 30_000);
    const usage = { input_tokens: 5, output_tokens: 2, total_tokens: 7, cost_usd: 0.012 };
    const settlement = directFailedSettlement({
      runId: prepared.run.id,
      streamId: identifier("direct_failed"),
      toolCallId: identifier("tool_failed"),
      usage
    });

    await expect(stageClaimedTerminalSettlement(claimed!, settlement)).resolves.toMatchObject({
      status: "staged",
      settled: false
    });
    await expect(settleClaimedTerminalSettlement(claimed!)).resolves.toMatchObject({
      kind: "settled",
      terminalStatus: "failed",
      events: [
        expect.objectContaining({ type: "tool.started" }),
        expect.objectContaining({ type: "run.failed", payload: expect.objectContaining({ usage }) })
      ]
    });

    const facts = await query<{
      run_status: string;
      thread_status: string;
      usage_rows: number;
      total_tokens: number;
      failed_audits: number;
      terminal_events: number;
      terminal_outbox: number;
      pending_settlements: number;
    }>(`
      SELECT run.status AS run_status, thread.status AS thread_status,
        (SELECT count(*)::int FROM wb_tenant_usage usage WHERE usage.run_id = run.id) AS usage_rows,
        (SELECT COALESCE(max(usage.total_tokens), 0)::int FROM wb_tenant_usage usage WHERE usage.run_id = run.id) AS total_tokens,
        (SELECT count(*)::int FROM wb_audit_events audit
          WHERE audit.resource_id = run.id AND audit.action = 'run.lifecycle' AND audit.outcome = 'failed') AS failed_audits,
        (SELECT count(*)::int FROM wb_agent_events event
          WHERE event.run_id = run.id AND event.event_type IN ('run.completed', 'run.failed', 'run.cancelled')) AS terminal_events,
        (SELECT count(*)::int FROM wb_agent_events event
          JOIN wb_agent_event_outbox outbox ON outbox.event_id = event.id
          WHERE event.run_id = run.id AND event.event_type = 'run.failed') AS terminal_outbox,
        (SELECT count(*)::int FROM wb_run_terminal_settlements settlement
          WHERE settlement.run_id = run.id AND settlement.settled_at IS NULL) AS pending_settlements
      FROM wb_runs run
      JOIN wb_threads thread ON thread.id = run.thread_id AND thread.visitor_id = run.visitor_id
      WHERE run.id = $1
    `, [prepared.run.id]);
    expect(facts.rows[0]).toEqual({
      run_status: "failed",
      thread_status: "failed",
      usage_rows: 1,
      total_tokens: usage.total_tokens,
      failed_audits: 1,
      terminal_events: 1,
      terminal_outbox: 1,
      pending_settlements: 0
    });
  });

  it("direct failed 与 stop intent 竞态时以 stopped 收口但保留真实 usage、source 与 toolCallId", async () => {
    const visitorId = await createVisitor(identifier("tenant").slice(0, 60));
    const project = await createLiveProject(visitorId, "Direct failed stop race");
    const thread = await createLiveThread(visitorId, project.id, "Direct failed stop race thread");
    const prepared = await prepare(visitorId, thread!.id, "停止竞态仍需保留真实失败 usage");
    const claimed = await claimNextLiveRun("worker-direct-failed-stop", 30_000);
    const usage = { input_tokens: 14, output_tokens: 4, total_tokens: 18, cost_usd: 0.052 };
    const toolCallId = identifier("tool_failed_stop");
    const settlement = directFailedSettlement({
      runId: prepared.run.id,
      streamId: identifier("direct_failed_stop"),
      toolCallId,
      usage
    });

    await expect(requestLiveRunStop(visitorId, prepared.run.id)).resolves.toMatchObject({
      status: "running",
      hasActiveLease: true
    });
    await expect(stageClaimedTerminalSettlement(claimed!, settlement)).resolves.toMatchObject({ status: "staged" });
    await expect(settleClaimedTerminalSettlement(claimed!)).resolves.toMatchObject({
      kind: "settled",
      terminalStatus: "stopped",
      events: [
        expect.objectContaining({ type: "tool.started", payload: expect.objectContaining({ toolCallId }) }),
        expect.objectContaining({
          type: "run.cancelled",
          payload: expect.objectContaining({ reasonCode: "USER_STOPPED", usage })
        })
      ]
    });

    const facts = await query<{
      run_status: string;
      usage_tokens: string;
      lifecycle_outcome: string;
      source_terminal_status: string;
      settled_status: string;
      terminal_event_type: string;
      tool_call_id: string;
    }>(`
      SELECT run.status AS run_status, usage.total_tokens::text AS usage_tokens,
        audit.outcome AS lifecycle_outcome,
        settlement.terminal_status AS source_terminal_status,
        settlement.settled_status,
        terminal.event_type AS terminal_event_type,
        tool.payload->>'toolCallId' AS tool_call_id
      FROM wb_runs run
      JOIN wb_tenant_usage usage ON usage.run_id = run.id
      JOIN wb_audit_events audit ON audit.resource_id = run.id
        AND audit.action = 'run.lifecycle' AND audit.outcome IN ('failed', 'stopped')
      JOIN wb_run_terminal_settlements settlement ON settlement.run_id = run.id
      JOIN wb_agent_events terminal ON terminal.run_id = run.id
        AND terminal.event_type IN ('run.failed', 'run.cancelled')
      JOIN wb_agent_events tool ON tool.run_id = run.id AND tool.event_type = 'tool.started'
      WHERE run.id = $1
    `, [prepared.run.id]);
    expect(facts.rows).toEqual([{
      run_status: "stopped",
      usage_tokens: String(usage.total_tokens),
      lifecycle_outcome: "stopped",
      source_terminal_status: "failed",
      settled_status: "stopped",
      terminal_event_type: "run.cancelled",
      tool_call_id: toolCallId
    }]);
  });

  it("failed stage 落库后才收到 stop intent 仍以 stopped 消费并保留 stage 权威内容", async () => {
    const visitorId = await createVisitor(identifier("tenant").slice(0, 60));
    const project = await createLiveProject(visitorId, "Failed stage then stop");
    const thread = await createLiveThread(visitorId, project.id, "Failed stage then stop thread");
    const prepared = await prepare(visitorId, thread!.id, "stage 后停止");
    const claimed = await claimNextLiveRun("worker-stage-before-stop", 30_000);
    const usage = { input_tokens: 16, output_tokens: 6, total_tokens: 22, cost_usd: 0.064 };
    const toolCallId = identifier("tool_stage_before_stop");
    const settlement = directFailedSettlement({
      runId: prepared.run.id,
      streamId: identifier("failed_stage_before_stop"),
      toolCallId,
      usage
    });

    await expect(stageClaimedTerminalSettlement(claimed!, settlement)).resolves.toMatchObject({ status: "staged" });
    await expect(requestLiveRunStop(visitorId, prepared.run.id)).resolves.toMatchObject({
      status: "running",
      hasActiveLease: true
    });
    await expect(settleClaimedTerminalSettlement(claimed!)).resolves.toMatchObject({
      kind: "settled",
      terminalStatus: "stopped",
      events: [
        expect.objectContaining({ type: "tool.started", payload: expect.objectContaining({ toolCallId }) }),
        expect.objectContaining({ type: "run.cancelled", payload: expect.objectContaining({ usage }) })
      ]
    });

    const facts = await query<{ status: string; total_tokens: string; terminal_status: string; settled_status: string }>(`
      SELECT run.status, usage.total_tokens::text, settlement.terminal_status, settlement.settled_status
      FROM wb_runs run
      JOIN wb_tenant_usage usage ON usage.run_id = run.id
      JOIN wb_run_terminal_settlements settlement ON settlement.run_id = run.id
      WHERE run.id = $1
    `, [prepared.run.id]);
    expect(facts.rows).toEqual([{
      status: "stopped",
      total_tokens: String(usage.total_tokens),
      terminal_status: "failed",
      settled_status: "stopped"
    }]);
  });

  it.each(["usage", "audit"] as const)("direct failed 的 %s 写入失败时 stage 保持 pending，epoch+1 claim 原样恢复 failed usage 与 toolCallId", async (failurePoint) => {
    const visitorId = await createVisitor(identifier("tenant").slice(0, 60));
    const project = await createLiveProject(visitorId, `Settlement ${failurePoint}`);
    const thread = await createLiveThread(visitorId, project.id, `Settlement ${failurePoint} thread`);
    const prepared = await prepare(visitorId, thread!.id, `settlement ${failurePoint}`);
    const claimed = await claimNextLiveRun(`worker-stage-${failurePoint}`, 30_000);
    expect(claimed?.run.id).toBe(prepared.run.id);

    const checkpointId = identifier("checkpoint");
    const checkpointSessionId = identifier("session");
    await expect(commitClaimedCheckpointBatch(claimed!, {
      sourceEvents: [],
      boundary: {
        version: 1,
        eventId: identifier("checkpoint_event"),
        streamId: identifier("checkpoint_stream"),
        streamSeq: 1,
        seq: 1,
        createdAt: "2026-08-08T00:00:00Z",
        type: "checkpoint.committed",
        checkpointId,
        parentCheckpointId: null,
        checkpointNs: "",
        checkpointSessionId,
        step: -1
      },
      events: [{ type: "run.status", payload: { status: "running", checkpointed: true } }]
    })).resolves.toMatchObject({ status: "committed", revision: 1 });

    const usage = failurePoint === "usage"
      ? { input_tokens: 31, output_tokens: 11, total_tokens: 42, cost_usd: 0.123 }
      : { input_tokens: 23, output_tokens: 9, total_tokens: 32, cost_usd: 0.087 };
    const toolCallId = identifier(`tool_${failurePoint}`);
    const settlement = directFailedSettlement({
      runId: prepared.run.id,
      streamId: identifier(`direct_${failurePoint}`),
      toolCallId,
      usage
    });
    const staged = await stageClaimedTerminalSettlement(claimed!, settlement);
    expect(staged).toMatchObject({ status: "staged", settled: false });

    const triggerName = identifier(`fail_${failurePoint}`);
    const functionName = identifier(`raise_${failurePoint}`);
    const tableName = failurePoint === "usage" ? "wb_tenant_usage" : "wb_audit_events";
    const predicate = failurePoint === "usage"
      ? `NEW.run_id = '${prepared.run.id}'`
      : `NEW.action = 'run.lifecycle' AND NEW.resource_id = '${prepared.run.id}' AND NEW.outcome = 'failed'`;
    let triggerInstalled = false;
    try {
      await query(`
        CREATE OR REPLACE FUNCTION ${functionName}()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          IF ${predicate} THEN
            RAISE EXCEPTION 'injected ${failurePoint} settlement failure';
          END IF;
          RETURN NEW;
        END;
        $$;
      `);
      await query(`
        CREATE TRIGGER ${triggerName}
        BEFORE INSERT ON ${tableName}
        FOR EACH ROW
        EXECUTE FUNCTION ${functionName}()
      `);
      triggerInstalled = true;

      await expect(settleClaimedTerminalSettlement(claimed!)).rejects.toThrow(`injected ${failurePoint} settlement failure`);
      const rolledBack = await query<{
        status: string;
        settled_at: string | null;
        usage_count: string;
        terminal_audit_count: string;
        projected_count: string;
        terminal_event_count: string;
      }>(`
        SELECT run.status,
          settlement.settled_at::text,
          (SELECT count(*) FROM wb_tenant_usage WHERE run_id = run.id)::text AS usage_count,
          (SELECT count(*) FROM wb_audit_events WHERE resource_id = run.id AND action = 'run.lifecycle' AND outcome IN ('completed', 'failed', 'stopped'))::text AS terminal_audit_count,
          (SELECT count(*) FROM wb_agent_events WHERE run_id = run.id AND event_type = 'tool.started')::text AS projected_count,
          (SELECT count(*) FROM wb_agent_events WHERE run_id = run.id AND event_type IN ('run.completed', 'run.failed', 'run.cancelled'))::text AS terminal_event_count
        FROM wb_runs run
        JOIN wb_run_terminal_settlements settlement ON settlement.run_id = run.id
        WHERE run.id = $1
      `, [prepared.run.id]);
      expect(rolledBack.rows[0]).toEqual({
        status: "running",
        settled_at: null,
        usage_count: "0",
        terminal_audit_count: "0",
        projected_count: "0",
        terminal_event_count: "0"
      });

      const exactReplay = await stageClaimedTerminalSettlement(claimed!, settlement);
      expect(exactReplay).toMatchObject({ status: "duplicate", hash: staged!.hash, settled: false });
      const changed = directFailedSettlement({
        runId: prepared.run.id,
        streamId: settlement.sourceEvents[0].streamId,
        toolCallId,
        usage: { ...usage, total_tokens: usage.total_tokens + 1 }
      });
      await expect(stageClaimedTerminalSettlement(claimed!, changed)).rejects.toMatchObject({
        code: "TERMINAL_SETTLEMENT_CONFLICT"
      });

      const beforeLateCheckpoint = await query<{ revision: string; commits: string; inbox: string }>(`
        SELECT revision::text,
          (SELECT count(*) FROM wb_checkpoint_commits WHERE run_id = wb_runs.id)::text AS commits,
          (SELECT count(*) FROM wb_source_event_inbox WHERE run_id = wb_runs.id)::text AS inbox
        FROM wb_runs WHERE id = $1
      `, [prepared.run.id]);
      await expect(commitClaimedCheckpointBatch(claimed!, {
        sourceEvents: [],
        boundary: {
          version: 1,
          eventId: identifier("late_checkpoint_event"),
          streamId: identifier("late_checkpoint_stream"),
          streamSeq: 1,
          seq: 1,
          createdAt: "2026-08-08T00:00:02Z",
          type: "checkpoint.committed",
          checkpointId: identifier("late_checkpoint"),
          parentCheckpointId: checkpointId,
          checkpointNs: "",
          checkpointSessionId,
          step: 0
        },
        events: [{ type: "run.status", payload: { status: "running", late: true } }]
      })).resolves.toBeNull();
      const afterLateCheckpoint = await query<{ revision: string; commits: string; inbox: string }>(`
        SELECT revision::text,
          (SELECT count(*) FROM wb_checkpoint_commits WHERE run_id = wb_runs.id)::text AS commits,
          (SELECT count(*) FROM wb_source_event_inbox WHERE run_id = wb_runs.id)::text AS inbox
        FROM wb_runs WHERE id = $1
      `, [prepared.run.id]);
      expect(afterLateCheckpoint.rows[0]).toEqual(beforeLateCheckpoint.rows[0]);

      await expect(releaseLiveRunLease(claimed!)).resolves.toBe(true);
      await query("UPDATE wb_runs SET execution_input = '{}'::jsonb WHERE id = $1", [prepared.run.id]);
    } finally {
      if (triggerInstalled) await query(`DROP TRIGGER IF EXISTS ${triggerName} ON ${tableName}`);
      await query(`DROP FUNCTION IF EXISTS ${functionName}()`);
    }

    await expect(claimNextLiveRun(`worker-takeover-${failurePoint}`, 30_000)).resolves.toBeNull();
    const recovered = await query<{
      status: string;
      worker_attempt: number;
      settled_lease_owner: string;
      settled_lease_epoch: string;
      staged_lease_epoch: string;
      input_tokens: string;
      output_tokens: string;
      total_tokens: string;
      cost_usd: string;
      revision: string;
      commits: string;
      inbox: string;
    }>(`
      SELECT run.status, run.worker_attempt,
        settlement.settled_lease_owner, settlement.settled_lease_epoch::text,
        settlement.staged_lease_epoch::text,
        usage.input_tokens::text, usage.output_tokens::text,
        usage.total_tokens::text, usage.cost_usd::text,
        run.revision::text,
        (SELECT count(*) FROM wb_checkpoint_commits WHERE run_id = run.id)::text AS commits,
        (SELECT count(*) FROM wb_source_event_inbox WHERE run_id = run.id)::text AS inbox
      FROM wb_runs run
      JOIN wb_run_terminal_settlements settlement ON settlement.run_id = run.id
      JOIN wb_tenant_usage usage ON usage.run_id = run.id
      WHERE run.id = $1
    `, [prepared.run.id]);
    expect(recovered.rows[0]).toMatchObject({
      status: "failed",
      worker_attempt: 2,
      settled_lease_owner: `worker-takeover-${failurePoint}`,
      staged_lease_epoch: "1",
      settled_lease_epoch: "2",
      input_tokens: String(usage.input_tokens),
      output_tokens: String(usage.output_tokens),
      total_tokens: String(usage.total_tokens),
      cost_usd: usage.cost_usd.toFixed(6),
      revision: "1",
      commits: "1",
      inbox: "1"
    });

    const publicEvents = await query<{ event_type: string; payload: Record<string, unknown>; outbox: boolean }>(`
      SELECT event.event_type, event.payload, outbox.event_id IS NOT NULL AS outbox
      FROM wb_agent_events event
      LEFT JOIN wb_agent_event_outbox outbox ON outbox.event_id = event.id
      WHERE event.run_id = $1 AND event.event_type IN ('tool.started', 'run.failed')
      ORDER BY event.seq
    `, [prepared.run.id]);
    expect(publicEvents.rows).toEqual([
      expect.objectContaining({
        event_type: "tool.started",
        outbox: true,
        payload: expect.objectContaining({ toolCallId, sourceEventId: settlement.sourceEvents[0].eventId })
      }),
      expect.objectContaining({
        event_type: "run.failed",
        outbox: true,
        payload: expect.objectContaining({ usage })
      })
    ]);
    const lifecycle = await query<{ outcome: string }>(`
      SELECT outcome FROM wb_audit_events
      WHERE resource_id = $1 AND action = 'run.lifecycle'
      ORDER BY id
    `, [prepared.run.id]);
    expect(lifecycle.rows).toEqual([{ outcome: "queued" }, { outcome: "failed" }]);

    await expect(stageClaimedTerminalSettlement(claimed!, settlement)).resolves.toMatchObject({
      status: "duplicate",
      settled: true,
      hash: staged!.hash
    });
    await expect(settleClaimedTerminalSettlement(claimed!)).resolves.toMatchObject({ kind: "duplicate" });
  });

  it("stale epoch 不能消费或改写 pending，新 epoch 可原子收口", async () => {
    const visitorId = await createVisitor();
    const project = await createLiveProject(visitorId, "Settlement fencing");
    const thread = await createLiveThread(visitorId, project.id, "Settlement fencing thread");
    const prepared = await prepare(visitorId, thread!.id, "settlement fencing");
    const original = await claimNextLiveRun("worker-settlement-old", 30_000);
    expect(original?.run.id).toBe(prepared.run.id);
    const usage = { input_tokens: 19, output_tokens: 7, total_tokens: 26, cost_usd: 0.061 };
    const settlement = directStoppedSettlement({
      runId: prepared.run.id,
      streamId: identifier("fenced_stream"),
      toolCallId: identifier("fenced_tool"),
      usage
    });
    const concurrentStages = await Promise.all([
      stageClaimedTerminalSettlement(original!, settlement),
      stageClaimedTerminalSettlement(original!, settlement)
    ]);
    expect(concurrentStages.map((result) => result?.status).sort()).toEqual(["duplicate", "staged"]);
    expect(new Set(concurrentStages.map((result) => result?.hash))).toEqual(new Set([concurrentStages[0]!.hash]));
    const canonicalHash = concurrentStages[0]!.hash;
    await releaseLiveRunLease(original!);
    const takeoverResult = await query<{ lease_epoch: string | number; lease_expires_at: Date | string }>(`
      UPDATE wb_runs
      SET status = 'running', lease_owner = 'worker-settlement-new',
        lease_epoch = lease_epoch + 1,
        lease_expires_at = now() + interval '30 seconds', heartbeat_at = now(),
        worker_attempt = worker_attempt + 1
      WHERE id = $1
      RETURNING lease_epoch, lease_expires_at
    `, [prepared.run.id]);
    const replacement = {
      ...original!,
      lease: { owner: "worker-settlement-new", epoch: Number(takeoverResult.rows[0].lease_epoch) },
      attempt: original!.attempt + 1,
      leaseExpiresAt: new Date(takeoverResult.rows[0].lease_expires_at).toISOString()
    };

    await expect(releaseLiveRunLease(original!)).resolves.toBe(false);
    await expect(settleClaimedTerminalSettlement(original!)).resolves.toBeNull();
    const changed = directStoppedSettlement({
      runId: prepared.run.id,
      streamId: settlement.sourceEvents[0].streamId,
      toolCallId: identifier("forged_tool"),
      usage
    });
    await expect(stageClaimedTerminalSettlement(original!, changed)).rejects.toMatchObject({
      code: "TERMINAL_SETTLEMENT_CONFLICT"
    });
    const stillPending = await query<{ settled_at: string | null; staged_lease_owner: string; staged_lease_epoch: string; canonical_hash: string }>(`
      SELECT settled_at::text, staged_lease_owner, staged_lease_epoch::text, canonical_hash
      FROM wb_run_terminal_settlements WHERE run_id = $1
    `, [prepared.run.id]);
    expect(stillPending.rows[0]).toEqual({
      settled_at: null,
      staged_lease_owner: "worker-settlement-old",
      staged_lease_epoch: "1",
      canonical_hash: canonicalHash
    });

    await expect(settleClaimedTerminalSettlement(replacement)).resolves.toMatchObject({ kind: "settled" });
    const final = await query<{ status: string; settled_lease_owner: string; settled_lease_epoch: string; total_tokens: string }>(`
      SELECT run.status, settlement.settled_lease_owner,
        settlement.settled_lease_epoch::text, usage.total_tokens::text
      FROM wb_runs run
      JOIN wb_run_terminal_settlements settlement ON settlement.run_id = run.id
      JOIN wb_tenant_usage usage ON usage.run_id = run.id
      WHERE run.id = $1
    `, [prepared.run.id]);
    expect(final.rows[0]).toEqual({
      status: "stopped",
      settled_lease_owner: "worker-settlement-new",
      settled_lease_epoch: "2",
      total_tokens: String(usage.total_tokens)
    });
  });

  it("HTTP 无有效 lease 的零 usage fallback 必须先消费 pending 的真实 usage", async () => {
    const visitorId = await createVisitor();
    const project = await createLiveProject(visitorId, "Settlement HTTP fallback");
    const thread = await createLiveThread(visitorId, project.id, "Settlement HTTP thread");
    const prepared = await prepare(visitorId, thread!.id, "settlement http fallback");
    const claimed = await claimNextLiveRun("worker-settlement-http", 30_000);
    expect(claimed?.run.id).toBe(prepared.run.id);
    const usage = { input_tokens: 27, output_tokens: 12, total_tokens: 39, cost_usd: 0.099 };
    const settlement = directStoppedSettlement({
      runId: prepared.run.id,
      streamId: identifier("http_stream"),
      toolCallId: identifier("http_tool"),
      usage
    });
    await stageClaimedTerminalSettlement(claimed!, settlement);
    await query("UPDATE wb_runs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [prepared.run.id]);
    await expect(requestLiveRunStop(visitorId, prepared.run.id)).resolves.toMatchObject({ hasActiveLease: false });

    const events = await finalizeLiveRun(prepared.run, "stopped", createUserStoppedPayload());
    expect(events?.map((event) => event.type)).toEqual(["tool.started", "run.cancelled"]);
    const persisted = await query<{ status: string; total_tokens: string; cost_usd: string; settled_lease_owner: string }>(`
      SELECT run.status, usage.total_tokens::text, usage.cost_usd::text,
        settlement.settled_lease_owner
      FROM wb_runs run
      JOIN wb_tenant_usage usage ON usage.run_id = run.id
      JOIN wb_run_terminal_settlements settlement ON settlement.run_id = run.id
      WHERE run.id = $1
    `, [prepared.run.id]);
    expect(persisted.rows[0]).toEqual({
      status: "stopped",
      total_tokens: String(usage.total_tokens),
      cost_usd: usage.cost_usd.toFixed(6),
      settled_lease_owner: "system:terminal-fallback"
    });
  });

  it("HTTP stop 读到无 lease 后若新 Worker 已领取，迟到 fallback 不得抢占有效 lease", async () => {
    const visitorId = await createVisitor();
    const project = await createLiveProject(visitorId, "Settlement HTTP lease race");
    const thread = await createLiveThread(visitorId, project.id, "Settlement HTTP lease race thread");
    const prepared = await prepare(visitorId, thread!.id, "settlement http lease race");
    await expect(requestLiveRunStop(visitorId, prepared.run.id)).resolves.toMatchObject({
      status: "queued",
      hasActiveLease: false
    });
    const claimed = await query<{ lease_epoch: string | number; lease_expires_at: Date | string }>(`
      UPDATE wb_runs
      SET status = 'running', lease_owner = 'worker-http-race',
        lease_epoch = lease_epoch + 1,
        lease_expires_at = now() + interval '30 seconds', heartbeat_at = now(),
        worker_attempt = worker_attempt + 1
      WHERE id = $1
      RETURNING lease_epoch, lease_expires_at
    `, [prepared.run.id]);

    await expect(finalizeLiveRun(prepared.run, "stopped", createUserStoppedPayload())).resolves.toBeNull();
    const untouched = await query<{ status: string; usage_count: string; terminal_count: string }>(`
      SELECT status,
        (SELECT count(*) FROM wb_tenant_usage WHERE run_id = wb_runs.id)::text AS usage_count,
        (SELECT count(*) FROM wb_agent_events WHERE run_id = wb_runs.id AND event_type IN ('run.completed', 'run.failed', 'run.cancelled'))::text AS terminal_count
      FROM wb_runs WHERE id = $1
    `, [prepared.run.id]);
    expect(untouched.rows[0]).toEqual({ status: "running", usage_count: "0", terminal_count: "0" });

    await expect(finalizeClaimedLiveRun({
      run: prepared.run,
      lease: { owner: "worker-http-race", epoch: Number(claimed.rows[0].lease_epoch) }
    }, "stopped", createUserStoppedPayload())).resolves.toEqual([
      expect.objectContaining({ type: "run.cancelled" })
    ]);
  });

  it("跨租户读写删一律 fail-closed，配额超限拒绝入队并留下审计", async () => {
    const tenantA = identifier("tenant").slice(0, 60);
    const tenantB = identifier("tenant").slice(0, 60);
    const visitorA = await createVisitor(tenantA);
    const visitorB = await createVisitor(tenantB);
    const projectA = await createLiveProject(visitorA, "租户甲项目");
    const threadA = await createLiveThread(visitorA, projectA.id, "租户甲会话");
    const run = await prepare(visitorA, threadA!.id, "租户甲事实是青川");
    await complete(run, "租户甲事实是青川", "已记录租户甲事实青川");

    const before = await query<{ title: string }>("SELECT title FROM wb_threads WHERE id = $1", [threadA!.id]);
    // Read: another tenant's visitor cannot see the thread or its snapshot.
    await expect(getLiveSnapshot(visitorB, threadA!.id)).resolves.toBeNull();
    // Write: an update scoped to the other tenant's visitor must not apply.
    await expect(updateLiveThread(visitorB, threadA!.id, { title: "越权改名" })).resolves.toEqual({
      kind: "thread_denied",
      resourceId: threadA!.id
    });
    // Delete: the same for removal.
    await expect(deleteLiveThread(visitorB, threadA!.id)).resolves.toBe(false);
    const intact = await query<{ title: string }>("SELECT title FROM wb_threads WHERE id = $1", [threadA!.id]);
    expect(intact.rows[0].title).toBe(before.rows[0].title);
    // Cross-tenant run start against another tenant's thread must fail closed.
    await expect(prepareLiveRun({
      visitorId: visitorB,
      tenantId: tenantB,
      threadId: threadA!.id,
      message: "越权运行",
      modelId: "deepseek-v4-flash",
      attachmentIds: [],
      memoryRecallItems: 24,
      memoryMaxChars: 16_000
    })).resolves.toBeNull();

    // Quota: a tenant pinned to a single concurrent run rejects the second.
    await query(`
      INSERT INTO wb_tenant_quotas (tenant_id, max_requests_per_minute, max_concurrent_runs, max_tokens_per_day, max_cost_usd_per_day)
      VALUES ($1, 1000, 1, 1000000, 100)
      ON CONFLICT (tenant_id) DO UPDATE SET max_concurrent_runs = 1
    `, [tenantA]);
    const secondThread = await createLiveThread(visitorA, projectA.id, "并发第二会话");
    const holding = await prepare(visitorA, threadA!.id, "占用并发额度");
    await expect(prepareLiveRun({
      visitorId: visitorA,
      tenantId: tenantA,
      threadId: secondThread!.id,
      message: "超出并发额度",
      modelId: "deepseek-v4-flash",
      attachmentIds: [],
      memoryRecallItems: 24,
      memoryMaxChars: 16_000
    })).rejects.toMatchObject({ reasonCode: "QUOTA_CONCURRENT_RUNS_EXCEEDED" });
    const audit = await query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM wb_audit_events
      WHERE tenant_id = $1 AND outcome = 'denied' AND reason_code = 'QUOTA_CONCURRENT_RUNS_EXCEEDED'
    `, [tenantA]);
    expect(audit.rows[0].count).toBe("1");
    await stop(holding);

    // Usage recorded on completion is attributed to the owning tenant only.
    const usage = await query<{ tenant_id: string; visitor_id: string; input_tokens: string; output_tokens: string; total_tokens: string; cost_usd: string }>(`
      SELECT tenant_id, visitor_id::text, input_tokens::text, output_tokens::text, total_tokens::text, cost_usd::text
      FROM wb_tenant_usage WHERE run_id = $1
    `, [run.run.id]);
    expect(usage.rows).toEqual([{
      tenant_id: tenantA,
      visitor_id: visitorA,
      input_tokens: "13",
      output_tokens: "8",
      total_tokens: "21",
      cost_usd: "0.031000"
    }]);
    const lifecycle = await query<{ outcome: string }>(`
      SELECT outcome FROM wb_audit_events
      WHERE tenant_id = $1 AND resource_id = $2 AND action = 'run.lifecycle'
      ORDER BY id
    `, [tenantA, run.run.id]);
    expect(lifecycle.rows).toEqual([{ outcome: "queued" }, { outcome: "completed" }]);
    const leaked = await query<{ count: string }>("SELECT count(*)::text AS count FROM wb_tenant_usage WHERE tenant_id = $1", [tenantB]);
    expect(leaked.rows[0].count).toBe("0");
  });

  it("已有运行表会幂等补齐 epoch 与 attempt 的非负约束", async () => {
    await query(`
      ALTER TABLE wb_runs
        DROP CONSTRAINT IF EXISTS wb_runs_lease_epoch_nonnegative,
        DROP CONSTRAINT IF EXISTS wb_runs_worker_attempt_nonnegative
    `);
    await closeDatabase();

    const constraints = await query<{ conname: string }>(`
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = 'wb_runs'::regclass
        AND conname IN ('wb_runs_lease_epoch_nonnegative', 'wb_runs_worker_attempt_nonnegative')
      ORDER BY conname
    `);
    expect(constraints.rows.map((row) => row.conname)).toEqual([
      "wb_runs_lease_epoch_nonnegative",
      "wb_runs_worker_attempt_nonnegative"
    ]);
  });
});
