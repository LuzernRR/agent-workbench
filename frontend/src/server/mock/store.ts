import type { AgentEvent, AgentEventType, MessageAttachment, ProjectSummary, ThreadSummary } from "@/lib/agent-events/types";
import type { MockAgentId } from "./catalog";

export type MockRun = {
  id: string;
  threadId: string;
  projectId: string | null;
  agent: MockAgentId;
  status: "queued" | "running" | "waiting" | "completed" | "failed" | "stopped";
  createdAt: string;
  events: AgentEvent[];
  subscribers: Set<(event: AgentEvent) => void>;
  cancelled: boolean;
  abortController: AbortController;
  pendingApprovals: Map<string, (decision: "allow_once" | "always_allow" | "deny") => void>;
};

export type MockThread = {
  id: string;
  projectId: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastUserMessageAt?: string;
  status: ThreadSummary["status"];
  runIds: string[];
  attachments: Map<string, MockAttachment>;
};

export type MockAttachment = MessageAttachment & { bytes: Uint8Array };

export type MockArtifactRecord = { id: string; threadId: string; name: string; mimeType: string; content: string };

type MockDatabase = {
  projects: Map<string, ProjectSummary & { createdAt: string }>;
  threads: Map<string, MockThread>;
  runs: Map<string, MockRun>;
  artifacts: Map<string, MockArtifactRecord>;
  seq: number;
};

// Next.js dev 模式会热重载模块，用 globalThis 兜住单例，避免会话在编辑代码后丢失。
const globalStore = globalThis as unknown as { __workbenchMockDb?: MockDatabase };

function seed(): MockDatabase {
  const now = Date.now();
  const iso = (offsetMs: number) => new Date(now - offsetMs).toISOString();
  const db: MockDatabase = {
    projects: new Map(),
    threads: new Map(),
    runs: new Map(),
    artifacts: new Map(),
    seq: 0
  };

  const projects: Array<[string, string, string]> = [
    ["proj-product", "产品规划", "workspace/product"],
    ["proj-learning", "学习与研究", "workspace/learning"]
  ];
  projects.forEach(([id, name, path], index) => {
    db.projects.set(id, { id, name, path, status: "idle", createdAt: iso((index + 3) * 86400000) });
  });

  const threads: Array<[string, string | null, string, number]> = [
    ["thread-week", null, "安排本周工作", 5 * 60000],
    ["thread-product", "proj-product", "整理工作台功能清单", 2 * 3600000],
    ["thread-learning", "proj-learning", "梳理工作台交互模式", 26 * 3600000]
  ];
  threads.forEach(([id, projectId, title, ageMs]) => {
    db.threads.set(id, {
      id,
      projectId,
      title,
      createdAt: iso(ageMs + 60000),
      updatedAt: iso(ageMs),
      lastUserMessageAt: iso(ageMs),
      status: "idle",
      runIds: [],
      attachments: new Map()
    });
  });

  return db;
}

export function db(): MockDatabase {
  if (!globalStore.__workbenchMockDb) globalStore.__workbenchMockDb = seed();
  return globalStore.__workbenchMockDb;
}

export function nextSeq() {
  const database = db();
  database.seq += 1;
  return database.seq;
}

export function newId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

/** 追加事件到运行日志，并推给所有在线订阅者。 */
export function emit(run: MockRun, type: AgentEventType, payload: Record<string, unknown>): AgentEvent {
  const event: AgentEvent = {
    id: newId("evt"),
    seq: nextSeq(),
    projectId: run.projectId,
    threadId: run.threadId,
    runId: run.id,
    createdAt: new Date().toISOString(),
    type,
    payload
  };
  run.events.push(event);
  for (const subscriber of run.subscribers) {
    try {
      subscriber(event);
    } catch {
      // 单个断开的订阅者不应影响运行本身。
    }
  }
  return event;
}

export function listThreads(): ThreadSummary[] {
  return [...db().threads.values()]
    .map((thread) => ({
      id: thread.id,
      projectId: thread.projectId,
      title: thread.title,
      updatedAt: thread.updatedAt,
      lastUserMessageAt: thread.lastUserMessageAt,
      status: thread.status
    }))
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

export function listProjects(): ProjectSummary[] {
  return [...db().projects.values()]
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
    .map(({ createdAt: _createdAt, ...project }) => ({
      ...project,
      status: [...db().threads.values()].some((thread) => thread.projectId === project.id && thread.status === "running") ? "running" : "idle",
      context: {
        shortTermVersion: "trim@6k+rolling-summary",
        longTermMemoryVersion: "pgvector:user_memories",
        checkpointId: `ckpt-${project.id}`
      }
    }));
}

export function touchThread(thread: MockThread, patch: Partial<MockThread> = {}) {
  Object.assign(thread, patch, { updatedAt: new Date().toISOString() });
}
