import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn()
}));

vi.mock("@/server/persistence/database", () => database);

import {
  buildProjectMemoryContext,
  claimNextLiveRun,
  createUserStoppedPayload,
  deleteExpiredLiveThreads,
  deleteLiveThread,
  finalizeClaimedLiveRun,
  finalizeLiveRun,
  getLiveSnapshot,
  persistClaimedLiveEvent,
  prepareLiveRun,
  releaseLiveRunLease,
  requestLiveRunStop,
  rememberProjectExchange,
  reorderLiveProjects,
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

  it("拒绝删除不存在的会话时不会先删除保留的项目记忆", async () => {
    const clientQuery = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT 1 FROM wb_threads")) return { rowCount: 0, rows: [] };
      throw new Error(`拒绝路径不应继续执行：${sql}`);
    });
    database.transaction.mockImplementationOnce((operation: (client: { query: typeof clientQuery }) => Promise<unknown>) => operation({ query: clientQuery }));

    await expect(deleteLiveThread("visitor-one", "thread-stale")).resolves.toBe(false);
    expect(clientQuery).toHaveBeenCalledTimes(1);
    expect(String(clientQuery.mock.calls[0][0])).toContain("FOR UPDATE");
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes("DELETE FROM wb_project_memories"))).toBe(false);
  });

  it("只在 owned 会话锁定成功后于同一事务删除记忆和会话", async () => {
    const clientQuery = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT 1 FROM wb_threads")) return { rowCount: 1, rows: [{}] };
      if (sql.includes("DELETE FROM wb_project_memories")) return { rowCount: 2, rows: [] };
      if (sql.includes("DELETE FROM wb_threads")) return { rowCount: 1, rows: [] };
      return { rowCount: 0, rows: [] };
    });
    database.transaction.mockImplementationOnce((operation: (client: { query: typeof clientQuery }) => Promise<unknown>) => operation({ query: clientQuery }));

    await expect(deleteLiveThread("visitor-one", "thread-one")).resolves.toBe(true);
    expect(clientQuery.mock.calls.map(([sql]) => String(sql).trim().split(/\s+/u).slice(0, 3).join(" "))).toEqual([
      "SELECT 1 FROM",
      "DELETE FROM wb_project_memories",
      "DELETE FROM wb_threads"
    ]);
  });

  it("项目排序区分无效顺序与首个无权或不存在的项目", async () => {
    const execute = async (projectIds: string[]) => {
      const clientQuery = vi.fn(async (sql: string) => {
        if (sql.includes("SELECT id FROM wb_projects")) return { rowCount: 2, rows: [{ id: "project-one" }, { id: "project-two" }] };
        return { rowCount: 1, rows: [] };
      });
      database.transaction.mockImplementationOnce((operation: (client: { query: typeof clientQuery }) => Promise<unknown>) => operation({ query: clientQuery }));
      return { result: await reorderLiveProjects("visitor-one", projectIds), clientQuery };
    };

    const duplicate = await execute(["project-one", "project-one"]);
    expect(duplicate.result).toEqual({ kind: "invalid_order" });
    expect(duplicate.clientQuery.mock.calls.some(([sql]) => String(sql).includes("UPDATE wb_projects"))).toBe(false);

    const missingOwned = await execute(["project-one"]);
    expect(missingOwned.result).toEqual({ kind: "invalid_order" });

    const foreign = await execute(["project-one", "project-foreign"]);
    expect(foreign.result).toEqual({ kind: "not_owned_or_missing", resourceId: "project-foreign" });
    expect(foreign.clientQuery.mock.calls.some(([sql]) => String(sql).includes("UPDATE wb_projects"))).toBe(false);

    const reordered = await execute(["project-two", "project-one"]);
    expect(reordered.result).toEqual({ kind: "reordered" });
    expect(reordered.clientQuery.mock.calls.filter(([sql]) => String(sql).includes("UPDATE wb_projects"))).toHaveLength(2);
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
      tenantId: "tenant-one",
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
      tenantId: "tenant-one",
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
    expect(clientQuery.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO wb_tenant_usage"))).toHaveLength(1);
    expect(clientQuery.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO wb_audit_events"))).toHaveLength(1);
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
    expect(clientQuery).toHaveBeenCalledTimes(2);
    expect(String(clientQuery.mock.calls[0][0])).toContain("FOR UPDATE");
    expect(String(clientQuery.mock.calls[1][0])).toContain("status IN ('queued', 'running', 'waiting')");
    expect(String(clientQuery.mock.calls[1][0])).toContain("lease_expires_at <= now()");
  });

  it("无 pending 的本地终态兜底也不能抢占刚被 Worker 领取的有效租约", async () => {
    const clientQuery = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT status, archived_at")) {
        return {
          rowCount: 1,
          rows: [{
            status: "running",
            archived_at: null,
            lease_owner: "worker-new",
            lease_epoch: "4",
            lease_expires_at: new Date("2099-01-01T00:00:00Z"),
            lease_valid: true,
            stop_requested_at: new Date("2026-08-08T00:00:00Z")
          }]
        };
      }
      if (sql.includes("FROM wb_run_terminal_settlements")) return { rowCount: 0, rows: [] };
      return { rowCount: 0, rows: [] };
    });
    database.transaction.mockImplementation((operation: (client: { query: typeof clientQuery }) => Promise<unknown>) => operation({ query: clientQuery }));

    await expect(finalizeLiveRun({
      id: "run-race",
      visitorId: "visitor-one",
      tenantId: "tenant-one",
      threadId: "thread-one",
      projectId: null,
      modelId: "deepseek-v4-flash"
    }, "stopped", createUserStoppedPayload())).resolves.toBeNull();

    const transitionSql = String(clientQuery.mock.calls.find(([sql]) => String(sql).includes("UPDATE wb_runs"))?.[0]);
    expect(transitionSql).toContain("lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= now()");
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO wb_agent_events"))).toBe(false);
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
        checkpoint_step: null,
        tenant_id: "tenant-one"
      }]
    });
    database.transaction.mockImplementation((operation: (client: { query: typeof clientQuery }) => Promise<unknown>) => operation({ query: clientQuery }));

    const claimed = await claimNextLiveRun("worker-two", 30_000);

    expect(claimed).toMatchObject({
      run: { id: "run-queue", tenantId: "tenant-one" },
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
    expect(sql).toContain("SELECT tenant_id FROM wb_visitors WHERE id = run.visitor_id");
  });

  it("领取到缺失 tenant_id 的运行时 fail-closed，不返回无归属运行", async () => {
    const claimResult = {
      rowCount: 1,
      rows: [{
        id: "run-orphan",
        visitor_id: "visitor-orphan",
        thread_id: "thread-one",
        project_id: null,
        model_id: "deepseek-v4-flash",
        agent_id: "search-agent",
        execution_input: {
          version: 1,
          message: "无归属运行",
          history: [],
          attachmentIds: [],
          projectMemoryContext: "",
          reasoningEffort: "high"
        },
        lease_epoch: "1",
        lease_expires_at: timestamp,
        worker_attempt: 1,
        checkpoint_id: null,
        checkpoint_session_id: null,
        checkpoint_ns: null,
        checkpoint_step: null,
        tenant_id: null
      }]
    };
    const clientQuery = vi.fn().mockImplementation((sql: string, values?: unknown[]) => {
      if (String(sql).includes("INSERT INTO wb_agent_events")) {
        return Promise.resolve({
          rowCount: 1,
          rows: [{
            id: "event-orphan",
            seq: 1,
            project_id: null,
            thread_id: "thread-one",
            run_id: "run-orphan",
            created_at: timestamp,
            event_type: values?.[5],
            payload: JSON.parse(String(values?.[6]))
          }]
        });
      }
      return Promise.resolve(claimResult);
    });
    database.query.mockImplementation((sql: string) => Promise.resolve(
      String(sql).includes("INSERT INTO wb_agent_events")
        ? { rowCount: 1, rows: [{ id: "event-orphan", seq: 1, project_id: null, thread_id: "thread-one", run_id: "run-orphan", created_at: timestamp, event_type: "run.failed", payload: {} }] }
        : { rowCount: 1, rows: [] }
    ));
    database.transaction.mockImplementation((operation: (client: { query: typeof clientQuery }) => Promise<unknown>) => operation({ query: clientQuery }));

    await expect(claimNextLiveRun("worker-two", 30_000)).resolves.toBeNull();
    const finalized = clientQuery.mock.calls.map((call) => JSON.stringify(call[1] ?? "")).join("\n");
    expect(finalized).toContain("RUN_TENANT_UNRESOLVED");
  });

  it("heartbeat 与 release 都要求 owner、epoch 和未过期租约", async () => {
    database.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ stop_requested: true }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const claimed = {
      run: { id: "run-one", visitorId: "visitor-one", threadId: "thread-one", projectId: null, modelId: "deepseek-v4-flash" },
      lease: { owner: "worker-one", epoch: 7 }
    };

    await expect(renewLiveRunLease(claimed, 30_000)).resolves.toEqual({
      renewed: true,
      stopRequested: true
    });
    await expect(releaseLiveRunLease(claimed)).resolves.toBe(true);

    const renewSql = String(database.query.mock.calls[0][0]);
    const releaseSql = String(database.query.mock.calls[1][0]);
    expect(renewSql).toContain("lease_owner = $2 AND lease_epoch = $3");
    expect(renewSql).toContain("lease_expires_at > now()");
    expect(renewSql).toContain("RETURNING stop_requested_at IS NOT NULL AS stop_requested");
    expect(releaseSql).toContain("lease_owner = $2 AND lease_epoch = $3");
    expect(releaseSql).toContain("lease_expires_at > now()");
    expect(releaseSql).toContain("status = 'queued'");
  });

  it("停止请求先持久化且只把有效租约交给上游收口", async () => {
    const clientQuery = vi.fn()
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          id: "run-one",
          thread_id: "thread-one",
          project_id: "project-one",
          model_id: "deepseek-v4-flash",
          agent_id: "search-agent",
          status: "running",
          tenant_id: "tenant-one",
          lease_owner: "worker-one",
          lease_valid: true
        }]
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    database.transaction.mockImplementation((operation: (client: { query: typeof clientQuery }) => Promise<unknown>) => operation({ query: clientQuery }));

    await expect(requestLiveRunStop("visitor-one", "run-one")).resolves.toMatchObject({
      status: "running",
      hasActiveLease: true,
      run: { id: "run-one", tenantId: "tenant-one" }
    });

    expect(String(clientQuery.mock.calls[0][0])).toContain("FOR UPDATE OF run");
    expect(String(clientQuery.mock.calls[1][0])).toContain("stop_requested_at = COALESCE(stop_requested_at, now())");
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
    expect(String(clientQuery.mock.calls[1][0])).toContain("FOR UPDATE");
    expect(String(clientQuery.mock.calls[2][0])).toContain("lease_owner = $2 AND lease_epoch = $3");
    expect(String(clientQuery.mock.calls[2][0])).toContain("lease_expires_at > now()");
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
      tenantId: "tenant-one",
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
    expect(prepared?.run.tenantId).toBe("tenant-one");
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
      tenantId: "tenant-one",
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
      tenantId: "tenant-one",
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
      tenantId: "tenant-one",
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

  it("配额超限时 prepareLiveRun 抛出 QuotaExceededError 且不插入运行", async () => {
    const clientQuery = vi.fn(async (sql: string, _values?: unknown[]) => {
      if (sql.includes("FROM wb_threads") && sql.includes("FOR UPDATE")) {
        return { rowCount: 1, rows: [{ id: "thread-current", project_id: null, title: "测试", status: "idle", updated_at: timestamp, last_user_message_at: null }] };
      }
      if (sql.includes("FROM wb_agent_events")) return { rowCount: 0, rows: [] };
      if (sql.includes("FROM wb_tenant_quotas")) return { rowCount: 0, rows: [] };
      if (sql.includes("FROM wb_audit_events")) return { rowCount: 1, rows: [{ count: 9999 }] };
      return { rowCount: 1, rows: [] };
    });
    database.transaction.mockImplementation((operation: (client: { query: typeof clientQuery }) => Promise<unknown>) => operation({ query: clientQuery }));

    await expect(prepareLiveRun({
      visitorId: "visitor-one",
      tenantId: "tenant-one",
      threadId: "thread-current",
      message: "超限请求",
      modelId: "deepseek-v4-flash",
      attachmentIds: [],
      memoryRecallItems: 24,
      memoryMaxChars: 16_000
    })).rejects.toMatchObject({ name: "QuotaExceededError", reasonCode: "QUOTA_REQUESTS_PER_MINUTE_EXCEEDED" });
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO wb_runs"))).toBe(false);
    expect(clientQuery.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO wb_audit_events"))).toHaveLength(1);
  });

  it.each(["running", "waiting"] as const)("%s 会话不会被误记为 memory 授权拒绝", async (status) => {
    const clientQuery = vi.fn(async (sql: string) => {
      if (sql.includes("FROM wb_threads") && sql.includes("FOR UPDATE")) {
        return { rowCount: 1, rows: [{ id: "thread-current", project_id: null, title: "测试", status, updated_at: timestamp, last_user_message_at: null }] };
      }
      throw new Error(`忙碌会话不应继续执行：${sql}`);
    });
    database.transaction.mockImplementation((operation: (client: { query: typeof clientQuery }) => Promise<unknown>) => operation({ query: clientQuery }));

    await expect(prepareLiveRun({
      visitorId: "visitor-one",
      tenantId: "tenant-one",
      threadId: "thread-current",
      message: "重复运行",
      modelId: "deepseek-v4-flash",
      attachmentIds: [],
      memoryRecallItems: 24,
      memoryMaxChars: 16_000
    })).resolves.toBeNull();

    expect(clientQuery.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO wb_audit_events"))).toHaveLength(0);
  });

  it("无效 replaceMessageId 不会被误记为 memory 授权拒绝", async () => {
    const clientQuery = vi.fn(async (sql: string) => {
      if (sql.includes("FROM wb_threads") && sql.includes("FOR UPDATE")) {
        return { rowCount: 1, rows: [{ id: "thread-current", project_id: null, title: "测试", status: "idle", updated_at: timestamp, last_user_message_at: null }] };
      }
      if (sql.includes("FROM wb_agent_events")) return { rowCount: 0, rows: [] };
      throw new Error(`无效替换不应继续执行：${sql}`);
    });
    database.transaction.mockImplementation((operation: (client: { query: typeof clientQuery }) => Promise<unknown>) => operation({ query: clientQuery }));

    await expect(prepareLiveRun({
      visitorId: "visitor-one",
      tenantId: "tenant-one",
      threadId: "thread-current",
      message: "编辑不存在的消息",
      modelId: "deepseek-v4-flash",
      attachmentIds: [],
      replaceMessageId: "message-missing",
      memoryRecallItems: 24,
      memoryMaxChars: 16_000
    })).resolves.toBeNull();

    expect(clientQuery.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO wb_audit_events"))).toHaveLength(0);
  });

  it("越权或不存在的会话在配额检查前 fail-closed 并写 run.start 与 memory.read denied", async () => {
    const clientQuery = vi.fn(async (sql: string, _values?: unknown[]) => {
      if (sql.includes("FROM wb_threads") && sql.includes("FOR UPDATE")) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [] };
    });
    database.transaction.mockImplementation((operation: (client: { query: typeof clientQuery }) => Promise<unknown>) => operation({ query: clientQuery }));

    await expect(prepareLiveRun({
      visitorId: "visitor-one",
      tenantId: "tenant-one",
      threadId: "thread-foreign",
      message: "越权运行",
      modelId: "deepseek-v4-flash",
      attachmentIds: [],
      memoryRecallItems: 24,
      memoryMaxChars: 16_000
    })).resolves.toBeNull();

    const audits = clientQuery.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO wb_audit_events"));
    expect(audits).toHaveLength(2);
    expect(audits[0]?.[1]).toEqual([
      "tenant-one", "visitor-one", "run.start", "denied", "RESOURCE_NOT_OWNED_OR_MISSING", "thread", "thread-foreign"
    ]);
    expect(audits[1]?.[1]).toEqual([
      "tenant-one", "visitor-one", "memory.read", "denied", "RESOURCE_NOT_OWNED_OR_MISSING", "memory", "thread:thread-foreign"
    ]);
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes("FROM wb_tenant_quotas"))).toBe(false);
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO wb_runs"))).toBe(false);
  });

  it("外来附件不会被静默丢弃，且不产生 allowed 或 Run 半写", async () => {
    const clientQuery = vi.fn(async (sql: string, _values?: unknown[]) => {
      if (sql.includes("FROM wb_threads") && sql.includes("FOR UPDATE")) {
        return { rowCount: 1, rows: [{ id: "thread-current", project_id: null, title: "测试", status: "idle", updated_at: timestamp, last_user_message_at: null }] };
      }
      if (sql.includes("FROM wb_agent_events")) return { rowCount: 0, rows: [] };
      if (sql.includes("FROM wb_attachments")) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [] };
    });
    database.transaction.mockImplementation((operation: (client: { query: typeof clientQuery }) => Promise<unknown>) => operation({ query: clientQuery }));

    await expect(prepareLiveRun({
      visitorId: "visitor-one",
      tenantId: "tenant-one",
      threadId: "thread-current",
      message: "使用外来附件",
      modelId: "deepseek-v4-flash",
      attachmentIds: ["attachment-foreign"],
      memoryRecallItems: 24,
      memoryMaxChars: 16_000
    })).resolves.toBeNull();

    const audits = clientQuery.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO wb_audit_events"));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.[1]).toEqual(expect.arrayContaining([
      "attachment.use", "denied", "RESOURCE_NOT_OWNED_OR_MISSING", "attachment", "attachment-foreign"
    ]));
    expect(audits.some(([, values]) => Array.isArray(values) && values.includes("memory.read"))).toBe(false);
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes("QUOTA_WITHIN_LIMITS"))).toBe(false);
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO wb_runs"))).toBe(false);
  });

  it("会话跨项目移动时迁移活动记忆，移出项目时归档活动记忆", async () => {
    const moveQuery = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes("SELECT 1 FROM wb_threads")) return Promise.resolve({ rowCount: 1, rows: [{}] });
      if (sql.includes("SELECT 1 FROM wb_projects")) return Promise.resolve({ rowCount: 1, rows: [{}] });
      if (sql.includes("UPDATE wb_threads")) return Promise.resolve({ rowCount: 1, rows: [{ id: "thread-one", project_id: "project-two", title: "测试", status: "idle", updated_at: timestamp, last_user_message_at: timestamp }] });
      return Promise.resolve({ rowCount: 1, rows: [] });
    });
    database.transaction.mockImplementationOnce((operation: (client: { query: typeof moveQuery }) => Promise<unknown>) => operation({ query: moveQuery }));
    await expect(updateLiveThread("visitor-one", "thread-one", { projectId: "project-two" })).resolves.toMatchObject({ kind: "updated" });
    const migrate = moveQuery.mock.calls.find(([sql]) => String(sql).includes("UPDATE wb_project_memories SET project_id"));
    expect(migrate?.[1]).toEqual(["thread-one", "visitor-one", "project-two"]);
    expect(String(migrate?.[0])).toContain("archived_at IS NULL");

    const exitQuery = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes("SELECT 1 FROM wb_threads")) return Promise.resolve({ rowCount: 1, rows: [{}] });
      if (sql.includes("UPDATE wb_threads")) return Promise.resolve({ rowCount: 1, rows: [{ id: "thread-one", project_id: null, title: "测试", status: "idle", updated_at: timestamp, last_user_message_at: timestamp }] });
      return Promise.resolve({ rowCount: 1, rows: [] });
    });
    database.transaction.mockImplementationOnce((operation: (client: { query: typeof exitQuery }) => Promise<unknown>) => operation({ query: exitQuery }));
    await expect(updateLiveThread("visitor-one", "thread-one", { projectId: null })).resolves.toMatchObject({ kind: "updated" });
    const archive = exitQuery.mock.calls.find(([sql]) => String(sql).includes("UPDATE wb_project_memories SET archived_at"));
    expect(archive?.[1]).toEqual(["thread-one", "visitor-one"]);
    expect(String(archive?.[0])).toContain("archived_at IS NULL");
  });

  it("会话更新能区分 source thread 与 target project 的拒绝对象", async () => {
    const threadDeniedQuery = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT 1 FROM wb_threads")) return { rowCount: 0, rows: [] };
      throw new Error(`thread denied 后不应继续查询：${sql}`);
    });
    database.transaction.mockImplementationOnce((operation: (client: { query: typeof threadDeniedQuery }) => Promise<unknown>) => operation({ query: threadDeniedQuery }));
    await expect(updateLiveThread("visitor-one", "thread-foreign", { projectId: "project-one" })).resolves.toEqual({
      kind: "thread_denied",
      resourceId: "thread-foreign"
    });

    const projectDeniedQuery = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT 1 FROM wb_threads")) return { rowCount: 1, rows: [{}] };
      if (sql.includes("SELECT 1 FROM wb_projects")) return { rowCount: 0, rows: [] };
      throw new Error(`project denied 后不应继续更新：${sql}`);
    });
    database.transaction.mockImplementationOnce((operation: (client: { query: typeof projectDeniedQuery }) => Promise<unknown>) => operation({ query: projectDeniedQuery }));
    await expect(updateLiveThread("visitor-one", "thread-one", { projectId: "project-foreign" })).resolves.toEqual({
      kind: "target_project_denied",
      resourceId: "project-foreign"
    });
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

    const events = await finalizeLiveRun({ id: "run-stop", visitorId: "visitor-one", tenantId: "tenant-one", threadId: "thread-one", projectId: "project-one", modelId: "deepseek-v4-flash" }, "stopped", {});
    expect(events?.map((event) => event.type)).toEqual(["run.cancelled"]);
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO wb_project_memories"))).toBe(false);
    expect(clientQuery.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO wb_tenant_usage"))).toHaveLength(1);
    expect(clientQuery.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO wb_audit_events"))).toHaveLength(1);
  });

});
