import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn()
}));

vi.mock("@/server/persistence/database", () => database);

import { deleteExpiredLiveThreads, finalizeLiveRun, rememberProjectExchange } from "./store";

describe("live 数据保留与项目记忆", () => {
  beforeEach(() => {
    database.query.mockReset();
    database.transaction.mockReset();
  });

  it("只清理超过 3 天且不在运行或等待中的会话", async () => {
    database.query.mockResolvedValue({ rowCount: 2, rows: [{ id: "one" }, { id: "two" }] });
    await expect(deleteExpiredLiveThreads(3)).resolves.toBe(2);
    const [sql, values] = database.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("updated_at < now() - ($1::int * interval '1 day')");
    expect(sql).toContain("status NOT IN ('running', 'waiting')");
    expect(values).toEqual([3]);
  });

  it("按访客、项目、来源会话与运行保存有界共享记忆", async () => {
    const clientQuery = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    database.transaction.mockImplementation((operation: (client: { query: typeof clientQuery }) => Promise<unknown>) => operation({ query: clientQuery }));
    const count = await rememberProjectExchange({
      id: "run-one",
      visitorId: "visitor-one",
      threadId: "thread-one",
      projectId: "project-one",
      modelId: "deepseek-v4-flash"
    }, {
      userMessage: "项目代号是北辰",
      assistantMessage: "已记录项目代号北辰",
      maxItems: 120,
      maxChars: 16_000
    });

    expect(count).toBe(2);
    const inserts = clientQuery.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO wb_project_memories"));
    expect(inserts).toHaveLength(2);
    expect(inserts[0][1]).toEqual(expect.arrayContaining(["visitor-one", "project-one", "thread-one", "run-one", "user", "项目代号是北辰"]));
    const cleanup = clientQuery.mock.calls.find(([sql]) => String(sql).includes("DELETE FROM wb_project_memories"));
    expect(cleanup?.[1]).toEqual(["visitor-one", "project-one", 120]);
  });

  it("无项目会话不写入项目记忆", async () => {
    await expect(rememberProjectExchange({
      id: "run-one",
      visitorId: "visitor-one",
      threadId: "thread-one",
      projectId: null,
      modelId: "deepseek-v4-flash"
    }, { userMessage: "内容", assistantMessage: "回复", maxItems: 120, maxChars: 16_000 })).resolves.toBe(0);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it("以条件更新原子抢占终态并在同一事务写入完成消息、记忆和终态事件", async () => {
    let sequence = 0;
    const clientQuery = vi.fn().mockImplementation((sql: string, values?: unknown[]) => {
      if (sql.includes("UPDATE wb_runs")) return Promise.resolve({ rowCount: 1, rows: [{ id: "run-one" }] });
      if (sql.includes("INSERT INTO wb_agent_events")) {
        sequence += 1;
        return Promise.resolve({
          rowCount: 1,
          rows: [{
            id: `event-${sequence}`,
            seq: sequence,
            project_id: "project-one",
            thread_id: "thread-one",
            run_id: "run-one",
            created_at: new Date("2026-07-26T00:00:00.000Z"),
            event_type: values?.[5],
            payload: JSON.parse(String(values?.[6]))
          }]
        });
      }
      return Promise.resolve({ rowCount: 1, rows: [] });
    });
    database.transaction.mockImplementation((operation: (client: { query: typeof clientQuery }) => Promise<unknown>) => operation({ query: clientQuery }));

    const result = await finalizeLiveRun({
      id: "run-one",
      visitorId: "visitor-one",
      threadId: "thread-one",
      projectId: "project-one",
      modelId: "deepseek-v4-flash"
    }, "completed", { finishReason: "stop" }, {
      events: [{ type: "message.completed", payload: { messageId: "message-one", text: "完成内容" } }],
      memory: { userMessage: "用户内容", assistantMessage: "完成内容", maxItems: 120, maxChars: 16_000 }
    });

    expect(result?.map((event) => event.type)).toEqual(["message.completed", "run.completed"]);
    const transition = clientQuery.mock.calls.find(([sql]) => String(sql).includes("UPDATE wb_runs"));
    expect(String(transition?.[0])).toContain("status IN ('queued', 'running', 'waiting')");
    expect(clientQuery.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO wb_project_memories"))).toHaveLength(2);
  });

  it("终态已经被其他请求抢占时不重复写终态事件", async () => {
    const clientQuery = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    database.transaction.mockImplementation((operation: (client: { query: typeof clientQuery }) => Promise<unknown>) => operation({ query: clientQuery }));

    await expect(finalizeLiveRun({
      id: "run-one",
      visitorId: "visitor-one",
      threadId: "thread-one",
      projectId: null,
      modelId: "deepseek-v4-flash"
    }, "stopped", {})).resolves.toBeNull();
    expect(clientQuery).toHaveBeenCalledTimes(1);
    expect(String(clientQuery.mock.calls[0][0])).toContain("status IN ('queued', 'running', 'waiting')");
  });
});
