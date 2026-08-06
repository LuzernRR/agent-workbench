import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  transaction: vi.fn()
}));
const store = vi.hoisted(() => ({
  insertEventWithClient: vi.fn(),
  rememberProjectExchangeWithClient: vi.fn()
}));

vi.mock("@/server/persistence/database", () => database);
vi.mock("./store", () => store);

import {
  canonicalCheckpointBatchHash,
  CheckpointBatchConflictError,
  CheckpointParentConflictError,
  commitClaimedCheckpointBatch,
  type ClaimedCheckpointBatch
} from "./checkpoint-batches";

const claim = {
  run: {
    id: "run_one",
    visitorId: "11111111-1111-1111-1111-111111111111",
    threadId: "thread_one",
    projectId: "project_one",
    modelId: "deepseek-v4-flash",
    agentId: "search-agent"
  },
  lease: { owner: "worker_one", epoch: 1 }
};

const boundary = {
  version: 1 as const,
  eventId: "stream_one_000002",
  streamId: "stream_one",
  streamSeq: 2,
  seq: 2,
  createdAt: "2026-08-06T00:00:02Z",
  type: "checkpoint.committed" as const,
  checkpointId: "checkpoint_one",
  parentCheckpointId: null,
  checkpointNs: "",
  checkpointSessionId: "checkpoint_session_one",
  step: -1
};

const sourceEvent = {
  version: 1 as const,
  eventId: "stream_one_000001",
  streamId: "stream_one",
  streamSeq: 1,
  seq: 1,
  createdAt: "2026-08-06T00:00:01Z",
  type: "node.started" as const,
  node: "plan_research" as const,
  nodeRunId: "node_one",
  agent: "planner" as const,
  iteration: 0
};

const batch: ClaimedCheckpointBatch = {
  boundary,
  sourceEvents: [sourceEvent],
  events: [{ type: "run.status", payload: { status: "running" } }]
};

function clientFor(input: {
  run?: Record<string, unknown> | null;
  existing?: Record<string, unknown> | null;
  inbox?: Record<string, unknown>[];
} = {}) {
  const query = vi.fn(async (sqlInput: unknown, _params?: readonly unknown[]) => {
    const sql = String(sqlInput);
    if (sql.includes("FROM wb_runs") && sql.includes("FOR UPDATE")) {
      return {
        rowCount: input.run === null ? 0 : 1,
        rows: input.run === null ? [] : [{
          revision: "0",
          checkpoint_id: null,
          checkpoint_session_id: null,
          checkpoint_ns: null,
          checkpoint_step: null,
          status: "running",
          lease_owner: "worker_one",
          lease_epoch: "1",
          lease_valid: true,
          archived_at: null,
          ...input.run
        }]
      };
    }
    if (sql.includes("FROM wb_checkpoint_commits")) {
      return { rowCount: input.existing ? 1 : 0, rows: input.existing ? [input.existing] : [] };
    }
    if (sql.includes("FROM wb_source_event_inbox")) {
      return { rowCount: input.inbox?.length ?? 0, rows: input.inbox ?? [] };
    }
    return { rowCount: 1, rows: [] };
  });
  return { query };
}

describe("checkpoint batch 原子确认", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.insertEventWithClient.mockResolvedValue({ id: "event_one" });
    store.rememberProjectExchangeWithClient.mockResolvedValue(0);
  });

  it("canonical hash 不受对象 key 顺序影响，但覆盖 source 内容", () => {
    const reordered = {
      ...batch,
      sourceEvents: [{
        ...sourceEvent,
        iteration: 0,
        agent: "planner" as const,
        nodeRunId: "node_one",
        node: "plan_research" as const
      }]
    };
    expect(canonicalCheckpointBatchHash(batch)).toBe(canonicalCheckpointBatchHash(reordered));
    expect(canonicalCheckpointBatchHash({
      ...batch,
      sourceEvents: [{ ...sourceEvent, iteration: 1 }]
    })).not.toBe(canonicalCheckpointBatchHash(batch));
  });

  it("canonical hash 不依赖运行环境 locale 排序", () => {
    const localeCompare = vi.spyOn(String.prototype, "localeCompare")
      .mockImplementation(() => { throw new Error("locale compare must not be used"); });
    try {
      expect(() => canonicalCheckpointBatchHash({
        ...batch,
        events: [{ type: "run.status", payload: { "\u00e4": 1, z: 2 } }]
      })).not.toThrow();
      expect(localeCompare).not.toHaveBeenCalled();
    } finally {
      localeCompare.mockRestore();
    }
  });

  it("同一事务推进 revision、写 commit/inbox 与投影事件", async () => {
    const client = clientFor();
    database.transaction.mockImplementation(async (operation) => operation(client));

    await expect(commitClaimedCheckpointBatch(claim, batch)).resolves.toEqual({
      status: "committed",
      revision: 1,
      checkpoint: {
        id: "checkpoint_one",
        parentId: null,
        namespace: "",
        sessionId: "checkpoint_session_one",
        step: -1
      }
    });

    const sql = client.query.mock.calls.map(([statement]) => String(statement)).join("\n");
    expect(sql).toContain("UPDATE wb_runs");
    expect(sql).toContain("INSERT INTO wb_checkpoint_commits");
    expect(sql).toContain("INSERT INTO wb_source_event_inbox");
    expect(store.insertEventWithClient).toHaveBeenCalledWith(
      client,
      claim.run,
      "run.status",
      { status: "running" }
    );
    const inboxInsert = client.query.mock.calls.find(([statement]) =>
      String(statement).includes("INSERT INTO wb_source_event_inbox")
    );
    const inboxRows = JSON.parse(String(inboxInsert?.[1]?.[3]));
    expect(inboxRows.map((row: { sourceEventId: string }) => row.sourceEventId)).toEqual([
      sourceEvent.eventId,
      boundary.eventId
    ]);
  });

  it("相同 checkpoint batch 重投为幂等成功且不产生写入", async () => {
    const hash = canonicalCheckpointBatchHash(batch);
    const client = clientFor({
      run: {
        revision: "1",
        checkpoint_id: "checkpoint_one",
        checkpoint_session_id: "checkpoint_session_one",
        checkpoint_ns: "",
        checkpoint_step: "-1"
      },
      existing: {
        revision: "1",
        parent_checkpoint_id: null,
        checkpoint_session_id: "checkpoint_session_one",
        checkpoint_ns: "",
        step: "-1",
        source_count: 2,
        event_count: 1,
        batch_hash: hash
      }
    });
    database.transaction.mockImplementation(async (operation) => operation(client));

    await expect(commitClaimedCheckpointBatch(claim, batch)).resolves.toMatchObject({
      status: "duplicate",
      revision: 1
    });
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("UPDATE wb_runs"))).toBe(false);
    expect(store.insertEventWithClient).not.toHaveBeenCalled();
  });

  it("boundary 自身参与 Inbox 业务键碰撞检查", async () => {
    const client = clientFor({ inbox: [{ source_event_id: boundary.eventId }] });
    database.transaction.mockImplementation(async (operation) => operation(client));

    await expect(commitClaimedCheckpointBatch(claim, batch))
      .rejects.toBeInstanceOf(CheckpointBatchConflictError);
    const collision = client.query.mock.calls.find(([statement]) =>
      String(statement).includes("FROM wb_source_event_inbox")
    );
    expect(collision?.[1]?.[1]).toEqual([sourceEvent.eventId, boundary.eventId]);
    expect(collision?.[1]?.[2]).toEqual([sourceEvent.streamId, boundary.streamId]);
    expect(collision?.[1]?.[3]).toEqual([sourceEvent.streamSeq, boundary.streamSeq]);
  });

  it("一个 batch 出现多个 source 终态时 fail closed", async () => {
    const firstTerminal = {
      version: 1 as const,
      eventId: "stream_one_000001",
      streamId: "stream_one",
      streamSeq: 1,
      seq: 1,
      createdAt: "2026-08-06T00:00:01Z",
      type: "run.failed" as const,
      reasonCode: "TEST_FAILURE",
      message: "failure"
    };
    const secondTerminal = {
      ...firstTerminal,
      eventId: "stream_one_000002",
      streamSeq: 2,
      seq: 2,
      createdAt: "2026-08-06T00:00:02Z"
    };

    await expect(commitClaimedCheckpointBatch(claim, {
      boundary: {
        ...boundary,
        eventId: "stream_one_000003",
        streamSeq: 3,
        seq: 3,
        createdAt: "2026-08-06T00:00:03Z"
      },
      sourceEvents: [firstTerminal, secondTerminal],
      events: [],
      terminal: { status: "failed" }
    })).rejects.toThrow("终态必须唯一");
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it("Run 终态必须匹配唯一且位于末尾的公开投影", async () => {
    const terminalSource = {
      version: 1 as const,
      eventId: "stream_one_000001",
      streamId: "stream_one",
      streamSeq: 1,
      seq: 1,
      createdAt: "2026-08-06T00:00:01Z",
      type: "run.failed" as const,
      reasonCode: "TEST_FAILURE",
      message: "failure"
    };
    const invalidEvents: ClaimedCheckpointBatch["events"][] = [
      [],
      [{ type: "run.completed", payload: {} }],
      [
        { type: "run.failed", payload: {} },
        { type: "run.status", payload: { status: "failed" } }
      ],
      [
        { type: "run.failed", payload: {} },
        { type: "run.failed", payload: {} }
      ]
    ];

    for (const events of invalidEvents) {
      await expect(commitClaimedCheckpointBatch(claim, {
        boundary,
        sourceEvents: [terminalSource],
        events,
        terminal: { status: "failed" }
      })).rejects.toThrow("公开终态必须唯一");
    }
    await expect(commitClaimedCheckpointBatch(claim, {
      boundary,
      sourceEvents: [terminalSource],
      events: [{ type: "run.failed", payload: {} }],
      terminal: {
        status: "failed",
        memory: { userMessage: "question", assistantMessage: "failed answer" }
      }
    })).rejects.toThrow("只有完成终态");
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it("同一 checkpoint 的冲突内容与断裂 parent 均 fail closed", async () => {
    const conflicting = clientFor({
      existing: {
        revision: "1",
        parent_checkpoint_id: null,
        checkpoint_session_id: "checkpoint_session_one",
        checkpoint_ns: "",
        step: "-1",
        source_count: 2,
        event_count: 1,
        batch_hash: "f".repeat(64)
      }
    });
    database.transaction.mockImplementationOnce(async (operation) => operation(conflicting));
    await expect(commitClaimedCheckpointBatch(claim, batch)).rejects.toBeInstanceOf(CheckpointBatchConflictError);

    const brokenParent = clientFor({
      run: {
        revision: "1",
        checkpoint_id: "checkpoint_parent",
        checkpoint_session_id: "checkpoint_session_one",
        checkpoint_ns: "",
        checkpoint_step: "0"
      }
    });
    database.transaction.mockImplementationOnce(async (operation) => operation(brokenParent));
    await expect(commitClaimedCheckpointBatch(claim, {
      ...batch,
      boundary: { ...boundary, checkpointId: "checkpoint_two", step: 1 }
    })).rejects.toBeInstanceOf(CheckpointParentConflictError);
  });

  it("旧 lease 在任何 batch 写入前被 fencing", async () => {
    const client = clientFor({ run: null });
    database.transaction.mockImplementation(async (operation) => operation(client));

    await expect(commitClaimedCheckpointBatch(claim, batch)).resolves.toBeNull();
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(store.insertEventWithClient).not.toHaveBeenCalled();
  });
});
