import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn()
}));

vi.mock("@/server/persistence/database", () => database);

import {
  buildProjectMemoryContext,
  claimNextLiveRun,
  deleteExpiredLiveThreads,
  finalizeClaimedLiveRun,
  finalizeLiveRun,
  getLiveSnapshot,
  persistClaimedLiveEvent,
  prepareLiveRun,
  releaseLiveRunLease,
  rememberProjectExchange,
  renewLiveRunLease,
  updateLiveThread
} from "./store";

const timestamp = new Date("2026-07-26T00:00:00.000Z");

function eventRow(input: {
  id: string;
  runId: string;
  type: string;
  payload: Record<string, unknown>;
}) {
  return {
    id: `event-${input.id}`,
    seq: Number(input.id),
    project_id: "project-one",
    thread_id: "thread-current",
    run_id: input.runId,
    created_at: timestamp,
    event_type: input.type,
    payload: input.payload
  };
}

function completedExchange(sequence: number, runId: string, userText: string, assistantText: string) {
  const userMessageId = `user-${sequence}`;
  const assistantMessageId = `assistant-${sequence}`;
  return [
    eventRow({ id: `${sequence}1`, runId, type: "message.started", payload: { messageId: userMessageId, role: "user", text: userText } }),
    eventRow({ id: `${sequence}2`, runId, type: "message.completed", payload: { messageId: userMessageId, text: userText } }),
    eventRow({ id: `${sequence}3`, runId, type: "message.started", payload: { messageId: assistantMessageId, role: "assistant", text: "" } }),
    eventRow({ id: `${sequence}4`, runId, type: "text.delta", payload: { messageId: assistantMessageId, delta: assistantText } }),
    eventRow({ id: `${sequence}5`, runId, type: "message.completed", payload: { messageId: assistantMessageId, text: assistantText } })
  ];
}

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

  it("Worker 尚未领取时快照仍保留 queued Run 的活动状态", async () => {
    database.query.mockImplementation((sql: string) => {
      if (sql.includes("FROM wb_threads WHERE")) {
        return Promise.resolve({
          rowCount: 1,
          rows: [{ id: "thread-one", project_id: null, title: "排队会话", status: "running", updated_at: timestamp, last_user_message_at: timestamp }]
        });
      }
      if (sql.includes("FROM wb_agent_events")) return Promise.resolve({ rowCount: 0, rows: [] });
      if (sql.includes("FROM wb_runs")) return Promise.resolve({ rowCount: 1, rows: [{ id: "run-queued", status: "queued" }] });
      return Promise.resolve({ rowCount: 0, rows: [] });
    });

    const snapshot = await getLiveSnapshot("visitor-one", "thread-one");

    expect(snapshot?.state.activeRunId).toBe("run-queued");
    expect(snapshot?.state.runStatus).toBe("queued");
    const activeSql = String(database.query.mock.calls.find(([sql]) => String(sql).includes("FROM wb_runs"))?.[0]);
    expect(activeSql).toContain("status IN ('queued', 'running', 'waiting')");
  });

  it("按访客、项目、来源会话与运行保存完整共享记忆", async () => {
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
      assistantMessage: "已记录项目代号北辰"
    });

    expect(count).toBe(2);
    const inserts = clientQuery.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO wb_project_memories"));
    expect(inserts).toHaveLength(2);
    expect(inserts[0][1]).toEqual(expect.arrayContaining(["visitor-one", "project-one", "thread-one", "run-one", "user", "项目代号是北辰"]));
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes("DELETE FROM wb_project_memories"))).toBe(false);
  });

  it("无项目会话不写入项目记忆", async () => {
    await expect(rememberProjectExchange({
      id: "run-one",
      visitorId: "visitor-one",
      threadId: "thread-one",
      projectId: null,
      modelId: "deepseek-v4-flash"
    }, { userMessage: "内容", assistantMessage: "回复" })).resolves.toBe(0);
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
      memory: { userMessage: "用户内容", assistantMessage: "完成内容" }
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

  it("以 FIFO 和 SKIP LOCKED 原子领取运行并递增 fencing epoch", async () => {
    const clientQuery = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [{
        id: "run-queue",
        visitor_id: "visitor-one",
        thread_id: "thread-one",
        project_id: "project-one",
        model_id: "deepseek-v4-flash",
        agent_id: "search-agent",
        execution_input: {
          version: 1,
          message: "排队问题",
          history: [],
          attachmentIds: [],
          projectMemoryContext: "",
          reasoningEffort: "high"
        },
        lease_epoch: "2",
        lease_expires_at: timestamp,
        worker_attempt: 2,
        checkpoint_id: null,
        checkpoint_session_id: null,
        checkpoint_ns: null,
        checkpoint_step: null
      }]
    });
    database.transaction.mockImplementation((operation: (client: { query: typeof clientQuery }) => Promise<unknown>) => operation({ query: clientQuery }));

    const claimed = await claimNextLiveRun("worker-two", 30_000);

    expect(claimed).toMatchObject({
      run: { id: "run-queue" },
      lease: { owner: "worker-two", epoch: 2 },
      attempt: 2,
      resume: false,
      checkpoint: null,
      input: { message: "排队问题", resume: false }
    });
    const [sql, values] = clientQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).toContain("ORDER BY available_at, created_at, id");
    expect(sql).toContain("lease_epoch = run.lease_epoch + 1");
    expect(sql).toContain("lease_expires_at IS NULL OR lease_expires_at <= now()");
    expect(values).toEqual(["worker-two", 30_000]);
  });

  it("heartbeat 与 release 都要求 owner、epoch 和未过期租约", async () => {
    database.query.mockResolvedValue({ rowCount: 1, rows: [] });
    const claimed = {
      run: { id: "run-one", visitorId: "visitor-one", threadId: "thread-one", projectId: null, modelId: "deepseek-v4-flash" },
      lease: { owner: "worker-one", epoch: 7 }
    };

    await expect(renewLiveRunLease(claimed, 30_000)).resolves.toBe(true);
    await expect(releaseLiveRunLease(claimed)).resolves.toBe(true);

    const renewSql = String(database.query.mock.calls[0][0]);
    const releaseSql = String(database.query.mock.calls[1][0]);
    expect(renewSql).toContain("lease_owner = $2 AND lease_epoch = $3");
    expect(renewSql).toContain("lease_expires_at > now()");
    expect(releaseSql).toContain("lease_owner = $2 AND lease_epoch = $3");
    expect(releaseSql).toContain("lease_expires_at > now()");
    expect(releaseSql).toContain("status = 'queued'");
  });

  it("迟到 Worker 无法写事件或抢占终态", async () => {
    const clientQuery = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    database.transaction.mockImplementation((operation: (client: { query: typeof clientQuery }) => Promise<unknown>) => operation({ query: clientQuery }));
    const claimed = {
      run: { id: "run-one", visitorId: "visitor-one", threadId: "thread-one", projectId: null, modelId: "deepseek-v4-flash" },
      lease: { owner: "worker-old", epoch: 3 }
    };

    await expect(persistClaimedLiveEvent(claimed, "run.status", { status: "running" })).resolves.toBeNull();
    await expect(finalizeClaimedLiveRun(claimed, "completed", {})).resolves.toBeNull();

    expect(String(clientQuery.mock.calls[0][0])).toContain("FOR UPDATE");
    expect(String(clientQuery.mock.calls[0][0])).toContain("lease_owner = $2 AND lease_epoch = $3");
    expect(String(clientQuery.mock.calls[1][0])).toContain("lease_owner = $2 AND lease_epoch = $3");
    expect(String(clientQuery.mock.calls[1][0])).toContain("lease_expires_at > now()");
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO wb_agent_events"))).toBe(false);
  });

  it("同会话只拼接活动分支上已完成的历史消息", async () => {
    let eventSequence = 100;
    const rows = [
      ...completedExchange(1, "run-history", "我叫林舟", "已记住你的名字"),
      eventRow({ id: "16", runId: "run-incomplete", type: "message.started", payload: { messageId: "unfinished", role: "assistant", text: "不应进入历史" } })
    ];
    const clientQuery = vi.fn().mockImplementation((sql: string, values?: unknown[]) => {
      if (sql.includes("FROM wb_threads") && sql.includes("FOR UPDATE")) {
        return Promise.resolve({ rowCount: 1, rows: [{ id: "thread-current", project_id: null, title: "测试", status: "idle", updated_at: timestamp, last_user_message_at: timestamp }] });
      }
      if (sql.includes("FROM wb_agent_events")) return Promise.resolve({ rowCount: rows.length, rows });
      if (sql.includes("INSERT INTO wb_agent_events")) {
        eventSequence += 1;
        return Promise.resolve({ rowCount: 1, rows: [{ id: `event-${eventSequence}`, seq: eventSequence, project_id: null, thread_id: "thread-current", run_id: "run-current", created_at: timestamp, event_type: values?.[5], payload: JSON.parse(String(values?.[6])) }] });
      }
      return Promise.resolve({ rowCount: 1, rows: [] });
    });
    database.transaction.mockImplementation((operation: (client: { query: typeof clientQuery }) => Promise<unknown>) => operation({ query: clientQuery }));

    const prepared = await prepareLiveRun({
      visitorId: "visitor-one",
      threadId: "thread-current",
      message: "我叫什么名字？",
      modelId: "deepseek-v4-flash",
      attachmentIds: [],
      memoryRecallItems: 24,
      memoryMaxChars: 16_000
    });

    expect(prepared?.history).toEqual([
      { role: "user", content: "我叫林舟" },
      { role: "assistant", content: "已记住你的名字" }
    ]);
    expect(prepared?.history.some((message) => message.content.includes("不应进入历史"))).toBe(false);
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes("FROM wb_project_memories"))).toBe(false);
  });

  it("同项目跨会话召回严格绑定访客、项目和来源会话", async () => {
    let eventSequence = 200;
    const clientQuery = vi.fn().mockImplementation((sql: string, values?: unknown[]) => {
      if (sql.includes("FROM wb_threads") && sql.includes("FOR UPDATE")) {
        return Promise.resolve({ rowCount: 1, rows: [{ id: "thread-current", project_id: "project-one", title: "测试", status: "idle", updated_at: timestamp, last_user_message_at: null }] });
      }
      if (sql.includes("FROM wb_agent_events")) return Promise.resolve({ rowCount: 0, rows: [] });
      if (sql.includes("SELECT id, source_thread_id") && sql.includes("FROM wb_project_memories")) {
        return Promise.resolve({ rowCount: 2, rows: [
          { id: "memory-assistant", source_thread_id: "thread-source", source_thread_title: "来源会话", source_run_id: "run-source", role: "assistant", content: "已记录代号北辰", created_at: timestamp },
          { id: "memory-user", source_thread_id: "thread-source", source_thread_title: "来源会话", source_run_id: "run-source", role: "user", content: "项目代号是北辰", created_at: timestamp }
        ] });
      }
      if (sql.includes("INSERT INTO wb_agent_events")) {
        eventSequence += 1;
        return Promise.resolve({ rowCount: 1, rows: [{ id: `event-${eventSequence}`, seq: eventSequence, project_id: "project-one", thread_id: "thread-current", run_id: "run-current", created_at: timestamp, event_type: values?.[5], payload: JSON.parse(String(values?.[6])) }] });
      }
      return Promise.resolve({ rowCount: 1, rows: [] });
    });
    database.transaction.mockImplementation((operation: (client: { query: typeof clientQuery }) => Promise<unknown>) => operation({ query: clientQuery }));

    const prepared = await prepareLiveRun({
      visitorId: "visitor-one",
      threadId: "thread-current",
      message: "项目代号是什么？",
      modelId: "deepseek-v4-flash",
      attachmentIds: [],
      memoryRecallItems: 24,
      memoryMaxChars: 16_000
    });

    expect(prepared?.projectMemoryContext).toContain("项目来源会话：\n- 来源会话");
    expect(prepared?.projectMemoryContext).toContain("用户：项目代号是北辰\n助手：已记录代号北辰");
    const recall = clientQuery.mock.calls.find(([sql]) => String(sql).includes("SELECT id, source_thread_id"));
    expect(String(recall?.[0])).toContain("visitor_id = $1 AND project_id = $2 AND archived_at IS NULL");
    expect(String(recall?.[0])).toContain("source_run_id = ANY($3::text[])");
    expect(recall?.[1]).toEqual(["visitor-one", "project-one", []]);
  });

  it("项目记忆上下文不会突破配置的字符预算", async () => {
    let eventSequence = 300;
    const clientQuery = vi.fn().mockImplementation((sql: string, values?: unknown[]) => {
      if (sql.includes("FROM wb_threads") && sql.includes("FOR UPDATE")) {
        return Promise.resolve({ rowCount: 1, rows: [{ id: "thread-current", project_id: "project-one", title: "测试", status: "idle", updated_at: timestamp, last_user_message_at: null }] });
      }
      if (sql.includes("FROM wb_agent_events")) return Promise.resolve({ rowCount: 0, rows: [] });
      if (sql.includes("SELECT id, source_thread_id") && sql.includes("FROM wb_project_memories")) {
        return Promise.resolve({ rowCount: 1, rows: [{ id: "memory-long", source_thread_id: "thread-source", source_thread_title: "来源会话", source_run_id: "run-source", role: "user", content: "北".repeat(200), created_at: timestamp }] });
      }
      if (sql.includes("INSERT INTO wb_agent_events")) {
        eventSequence += 1;
        return Promise.resolve({ rowCount: 1, rows: [{ id: `event-${eventSequence}`, seq: eventSequence, project_id: "project-one", thread_id: "thread-current", run_id: "run-current", created_at: timestamp, event_type: values?.[5], payload: JSON.parse(String(values?.[6])) }] });
      }
      return Promise.resolve({ rowCount: 1, rows: [] });
    });
    database.transaction.mockImplementation((operation: (client: { query: typeof clientQuery }) => Promise<unknown>) => operation({ query: clientQuery }));

    const prepared = await prepareLiveRun({
      visitorId: "visitor-one",
      threadId: "thread-current",
      message: "召回",
      modelId: "deepseek-v4-flash",
      attachmentIds: [],
      memoryRecallItems: 24,
      memoryMaxChars: 40
    });
    expect(prepared?.projectMemoryContext).toHaveLength(40);
    expect(prepared?.projectMemoryContext.startsWith("项目来源会话：")).toBe(true);
  });

  it("项目召回覆盖来源会话并让相关旧事实优先于无关近期内容", () => {
    const rows = [
      { id: "a-new-user", source_thread_id: "thread-a", source_thread_title: "需求讨论", source_run_id: "run-a-new", role: "user" as const, content: "最近讨论页面颜色", created_at: "2026-07-26T03:00:00.000Z" },
      { id: "a-new-assistant", source_thread_id: "thread-a", source_thread_title: "需求讨论", source_run_id: "run-a-new", role: "assistant" as const, content: "确定使用中性色", created_at: "2026-07-26T03:00:01.000Z" },
      { id: "b-new-user", source_thread_id: "thread-b", source_thread_title: "接口约定", source_run_id: "run-b-new", role: "user" as const, content: "接口返回 JSON", created_at: "2026-07-26T02:00:00.000Z" },
      { id: "b-new-assistant", source_thread_id: "thread-b", source_thread_title: "接口约定", source_run_id: "run-b-new", role: "assistant" as const, content: "已记录结构", created_at: "2026-07-26T02:00:01.000Z" },
      { id: "a-old-user", source_thread_id: "thread-a", source_thread_title: "需求讨论", source_run_id: "run-a-old", role: "user" as const, content: "项目密钥代号是霜塔", created_at: "2026-07-20T01:00:00.000Z" },
      { id: "a-old-assistant", source_thread_id: "thread-a", source_thread_title: "需求讨论", source_run_id: "run-a-old", role: "assistant" as const, content: "已记录霜塔", created_at: "2026-07-20T01:00:01.000Z" }
    ];

    const recalled = buildProjectMemoryContext(rows, "项目密钥代号是什么", 6, 4000);

    expect(recalled.context).toContain("- 需求讨论");
    expect(recalled.context).toContain("- 接口约定");
    expect(recalled.context).toContain("项目密钥代号是霜塔");
    expect(recalled.rowIds).toEqual(expect.arrayContaining(["a-new-user", "b-new-user", "a-old-user"]));
  });

  it("编辑旧消息会归档该运行及其下游事件、运行和项目记忆", async () => {
    let eventSequence = 400;
    const rows = [
      ...completedExchange(1, "run-old", "旧事实", "旧回复"),
      ...completedExchange(2, "run-later", "下游事实", "下游回复")
    ];
    const clientQuery = vi.fn().mockImplementation((sql: string, values?: unknown[]) => {
      if (sql.includes("FROM wb_threads") && sql.includes("FOR UPDATE")) {
        return Promise.resolve({ rowCount: 1, rows: [{ id: "thread-current", project_id: "project-one", title: "测试", status: "idle", updated_at: timestamp, last_user_message_at: timestamp }] });
      }
      if (sql.includes("FROM wb_agent_events")) return Promise.resolve({ rowCount: rows.length, rows });
      if (sql.includes("SELECT created_at FROM wb_runs")) return Promise.resolve({ rowCount: 1, rows: [{ created_at: timestamp }] });
      if (sql.includes("SELECT id, source_thread_id") && sql.includes("FROM wb_project_memories")) return Promise.resolve({ rowCount: 0, rows: [] });
      if (sql.includes("INSERT INTO wb_agent_events")) {
        eventSequence += 1;
        return Promise.resolve({ rowCount: 1, rows: [{ id: `event-${eventSequence}`, seq: eventSequence, project_id: "project-one", thread_id: "thread-current", run_id: "run-current", created_at: timestamp, event_type: values?.[5], payload: JSON.parse(String(values?.[6])) }] });
      }
      return Promise.resolve({ rowCount: 1, rows: [] });
    });
    database.transaction.mockImplementation((operation: (client: { query: typeof clientQuery }) => Promise<unknown>) => operation({ query: clientQuery }));

    const prepared = await prepareLiveRun({
      visitorId: "visitor-one",
      threadId: "thread-current",
      message: "新事实",
      modelId: "deepseek-v4-flash",
      attachmentIds: [],
      replaceMessageId: "user-1",
      memoryRecallItems: 24,
      memoryMaxChars: 16_000
    });

    expect(prepared?.history).toEqual([]);
    const archiveEvents = clientQuery.mock.calls.find(([sql]) => String(sql).includes("UPDATE wb_agent_events SET archived_at"));
    const archiveMemories = clientQuery.mock.calls.find(([sql]) => String(sql).includes("UPDATE wb_project_memories SET archived_at"));
    const archiveRuns = clientQuery.mock.calls.find(([sql]) => String(sql).includes("UPDATE wb_runs SET archived_at"));
    expect(String(archiveEvents?.[0])).toContain("created_at >= $3");
    expect(String(archiveMemories?.[0])).toContain("source_thread_id = $2");
    expect(String(archiveMemories?.[0])).toContain("created_at >= $3");
    expect(String(archiveRuns?.[0])).toContain("created_at >= $3");
    expect(archiveMemories?.[1]).toEqual(["visitor-one", "thread-current", timestamp]);
  });

  it("会话跨项目移动时迁移活动记忆，移出项目时归档活动记忆", async () => {
    const moveQuery = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes("SELECT 1 FROM wb_projects")) return Promise.resolve({ rowCount: 1, rows: [{}] });
      if (sql.includes("UPDATE wb_threads")) return Promise.resolve({ rowCount: 1, rows: [{ id: "thread-one", project_id: "project-two", title: "测试", status: "idle", updated_at: timestamp, last_user_message_at: timestamp }] });
      return Promise.resolve({ rowCount: 1, rows: [] });
    });
    database.transaction.mockImplementationOnce((operation: (client: { query: typeof moveQuery }) => Promise<unknown>) => operation({ query: moveQuery }));
    await updateLiveThread("visitor-one", "thread-one", { projectId: "project-two" });
    const migrate = moveQuery.mock.calls.find(([sql]) => String(sql).includes("UPDATE wb_project_memories SET project_id"));
    expect(migrate?.[1]).toEqual(["thread-one", "visitor-one", "project-two"]);
    expect(String(migrate?.[0])).toContain("archived_at IS NULL");

    const exitQuery = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes("UPDATE wb_threads")) return Promise.resolve({ rowCount: 1, rows: [{ id: "thread-one", project_id: null, title: "测试", status: "idle", updated_at: timestamp, last_user_message_at: timestamp }] });
      return Promise.resolve({ rowCount: 1, rows: [] });
    });
    database.transaction.mockImplementationOnce((operation: (client: { query: typeof exitQuery }) => Promise<unknown>) => operation({ query: exitQuery }));
    await updateLiveThread("visitor-one", "thread-one", { projectId: null });
    const archive = exitQuery.mock.calls.find(([sql]) => String(sql).includes("UPDATE wb_project_memories SET archived_at"));
    expect(archive?.[1]).toEqual(["thread-one", "visitor-one"]);
    expect(String(archive?.[0])).toContain("archived_at IS NULL");
  });

  it("停止运行不写项目记忆", async () => {
    let sequence = 500;
    const clientQuery = vi.fn().mockImplementation((sql: string, values?: unknown[]) => {
      if (sql.includes("UPDATE wb_runs")) return Promise.resolve({ rowCount: 1, rows: [{ id: "run-stop" }] });
      if (sql.includes("INSERT INTO wb_agent_events")) {
        sequence += 1;
        return Promise.resolve({ rowCount: 1, rows: [{ id: `event-${sequence}`, seq: sequence, project_id: "project-one", thread_id: "thread-one", run_id: "run-stop", created_at: timestamp, event_type: values?.[5], payload: JSON.parse(String(values?.[6])) }] });
      }
      return Promise.resolve({ rowCount: 1, rows: [] });
    });
    database.transaction.mockImplementation((operation: (client: { query: typeof clientQuery }) => Promise<unknown>) => operation({ query: clientQuery }));

    const events = await finalizeLiveRun({ id: "run-stop", visitorId: "visitor-one", threadId: "thread-one", projectId: "project-one", modelId: "deepseek-v4-flash" }, "stopped", {});
    expect(events?.map((event) => event.type)).toEqual(["run.cancelled"]);
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO wb_project_memories"))).toBe(false);
  });

});
