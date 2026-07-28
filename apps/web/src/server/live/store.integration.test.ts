import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { query } from "@/server/persistence/database";
import {
  createLiveProject,
  createLiveThread,
  deleteExpiredLiveThreads,
  finalizeLiveRun,
  prepareLiveRun,
  updateLiveThread,
  type PreparedRun
} from "./store";

const runLiveIntegration = process.env.WORKBENCH_LIVE_INTEGRATION === "1";
const visitors: string[] = [];

async function createVisitor() {
  const visitorId = randomUUID();
  const tokenHash = createHash("sha256").update(randomUUID(), "utf8").digest("hex");
  await query("INSERT INTO wb_visitors (id, token_hash) VALUES ($1, $2)", [visitorId, tokenHash]);
  visitors.push(visitorId);
  return visitorId;
}

async function prepare(visitorId: string, threadId: string, message: string, replaceMessageId?: string) {
  const prepared = await prepareLiveRun({
    visitorId,
    threadId,
    message,
    modelId: "deepseek-v4-flash",
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
  const events = await finalizeLiveRun(prepared.run, "completed", { finishReason: "stop" }, {
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
});
