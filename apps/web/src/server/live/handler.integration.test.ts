import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { closeDatabase, query, transaction } from "@/server/persistence/database";
import { dispatchAgentEventOutboxBatch } from "./event-outbox";
import { insertEventWithClient } from "./store";

const visitor = vi.hoisted(() => ({ id: "" }));

vi.mock("@/server/session/visitor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/session/visitor")>()),
  resolveVisitor: vi.fn(async () => ({ id: visitor.id }))
}));

import { handleLive } from "./handler";

const runLiveIntegration = process.env.WORKBENCH_LIVE_INTEGRATION === "1";
const visitors = new Set<string>();

function identifier(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

afterAll(async () => {
  for (const visitorId of visitors) {
    await query("DELETE FROM wb_visitors WHERE id = $1", [visitorId]);
  }
  await closeDatabase();
});

describe.skipIf(!runLiveIntegration)("SSE PostgreSQL cursor 真实恢复契约", () => {
  it("没有 NOTIFY listener 时仍按 Last-Event-ID 从持久事件表完整补发", async () => {
    const visitorId = randomUUID();
    const threadId = identifier("thread");
    const runId = identifier("run");
    visitors.add(visitorId);
    visitor.id = visitorId;
    await query("INSERT INTO wb_visitors (id, token_hash) VALUES ($1, $2)", [
      visitorId,
      randomUUID().replaceAll("-", "").repeat(2)
    ]);
    await query(`
      INSERT INTO wb_threads (id, visitor_id, title, status)
      VALUES ($1, $2, 'SSE cursor integration', 'idle')
    `, [threadId, visitorId]);
    await query(`
      INSERT INTO wb_runs (id, visitor_id, thread_id, agent_id, model_id, status, completed_at)
      VALUES ($1, $2, $3, 'search-agent', 'deepseek-v4-flash', 'completed', now())
    `, [runId, visitorId, threadId]);
    const run = {
      id: runId,
      visitorId,
      threadId,
      projectId: null,
      modelId: "deepseek-v4-flash",
      agentId: "search-agent"
    };
    const events = await transaction(async (client) => [
      await insertEventWithClient(client, run, "run.status", { status: "running" }),
      await insertEventWithClient(client, run, "message.started", { messageId: "msg_resume", role: "assistant", text: "" }),
      await insertEventWithClient(client, run, "run.completed", { finishReason: "stop" })
    ]);
    await query(`
      UPDATE wb_agent_event_outbox
      SET available_at = now() - interval '100 years'
      WHERE run_id = $1
    `, [runId]);

    await dispatchAgentEventOutboxBatch(500);
    const published = await query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM wb_agent_event_outbox
      WHERE run_id = $1 AND published_at IS NOT NULL
    `, [runId]);
    expect(published.rows[0].count).toBe("3");

    const path = `/api/v1/runs/${runId}/events`;
    const response = await handleLive(new Request(`http://localhost${path}`, {
      headers: { "Last-Event-ID": String(events[0].seq) }
    }), path);
    const body = await response.text();
    const replayedIds = [...body.matchAll(/^id: (\d+)$/gmu)].map((match) => Number(match[1]));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(replayedIds).toEqual([events[1].seq, events[2].seq]);
    expect(body).toContain(`\"id\":\"${events[1].id}\"`);
    expect(body).toContain(`\"id\":\"${events[2].id}\"`);
    expect(body).not.toContain(`\"id\":\"${events[0].id}\"`);
  });
});
