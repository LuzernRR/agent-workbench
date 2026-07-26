import type { AgentDefinition, MessageAttachment, ModelDefinition, ProjectSummary, ReasoningEffort, ThreadSnapshot, ThreadSummary, ToolDefinition } from "@/lib/agent-events/types";

const configuredBasePath = process.env.NEXT_PUBLIC_WORKBENCH_BASE_PATH || "";
const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || `${configuredBasePath}/api/v1` || "/api/v1";

class WorkbenchApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "WorkbenchApiError";
  }
}

/** Resolve API-owned resources returned by the backend into the mounted browser path. */
export function resolveWorkbenchResourceUrl(value: string | null | undefined) {
  if (!value) return value || "";
  if (!value.startsWith("/api/v1/")) return value;
  const prefix = configuredBasePath || (API_BASE_URL.endsWith("/api/v1") ? API_BASE_URL.slice(0, -7) : "");
  return `${prefix}${value}`;
}

/** Allow only browser-safe HTTP(S) links or same-origin absolute paths. */
export function safeWorkbenchHref(value: string | null | undefined) {
  const resolved = resolveWorkbenchResourceUrl(value).trim();
  if (!resolved) return "";
  if (resolved.startsWith("/") && !resolved.startsWith("//")) return resolved;
  try {
    const parsed = new URL(resolved);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : "";
  } catch {
    return "";
  }
}

export function safeLinkLabel(value: string | null | undefined, fallback: string) {
  const label = value?.trim() || "";
  if (!label || /^(?:https?:\/\/|www\.)/iu.test(label)) return fallback;
  return label;
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has("accept")) headers.set("accept", "application/json; charset=utf-8");
  if (!(init?.body instanceof FormData) && !headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers
  });
  const bytes = await response.arrayBuffer();
  let text = "";
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`响应不是有效的 UTF-8（${response.status}）`);
  }
  let decoded: T | { success: boolean; message?: string; data: T } | null = null;
  try {
    decoded = text ? JSON.parse(text) as T | { success: boolean; message?: string; data: T } : null;
  } catch {
    throw new Error(`响应内容无法解析（${response.status}）`);
  }
  if (!response.ok) {
    const body = decoded as { message?: string } | null;
    throw new WorkbenchApiError(body?.message || `请求失败（${response.status}）`, response.status);
  }
  const body = decoded as T | { success: boolean; message?: string; data: T };
  if (body && typeof body === "object" && "success" in body && "data" in body) {
    if (!body.success) throw new Error(body.message || "工作台请求失败");
    return body.data;
  }
  return body as T;
}

export function normalizeDisplayText(value: string | null | undefined, fallback: string) {
  const text = value?.trim() || "";
  if (!text || /^\?{2,}$/u.test(text) || /\?{3,}/u.test(text)) return fallback;
  if ([...text].every((character) => character.charCodeAt(0) <= 255) && /[ÃÂåäæçèé]/u.test(text)) {
    try {
      const recovered = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from([...text], (character) => character.charCodeAt(0)));
      if (recovered && !recovered.includes("�")) return recovered;
    } catch {
      // Keep the original text when it is not UTF-8 mojibake.
    }
  }
  return text;
}

export function normalizeProjectName(value: string | null | undefined) {
  return normalizeDisplayText(value, "未命名项目");
}

function normalizeThread(thread: ThreadSummary): ThreadSummary {
  return { ...thread, title: normalizeDisplayText(thread.title, "新对话") };
}

function normalizeSnapshot(snapshot: ThreadSnapshot): ThreadSnapshot {
  return {
    ...snapshot,
    project: snapshot.project ? { ...snapshot.project, name: normalizeProjectName(snapshot.project.name) } : null,
    thread: normalizeThread(snapshot.thread)
  };
}

async function allThreads(projectIds: string[]) {
  try {
    return (await apiFetch<ThreadSummary[]>("/threads")).map(normalizeThread);
  } catch (error) {
    // Transitional compatibility only: old deployments have project-scoped
    // reads. Standalone sessions are never fabricated by this fallback.
    if (!(error instanceof WorkbenchApiError) || ![404, 405].includes(error.status)) throw error;
    const groups = await Promise.all(projectIds.map((projectId) => apiFetch<ThreadSummary[]>(`/projects/${projectId}/threads`)));
    return groups.flat().map(normalizeThread).sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  }
}

export const workbenchApi = {
  projects: () => apiFetch<ProjectSummary[]>("/projects").then((projects) => projects.map((project) => ({ ...project, name: normalizeProjectName(project.name) }))),
  createProject: (body: { name: string; path?: string }) => apiFetch<ProjectSummary>("/projects", {
    method: "POST",
    body: JSON.stringify(body)
  }).then((project) => ({ ...project, name: normalizeProjectName(project.name) })),
  updateProject: (projectId: string, body: { name?: string; path?: string }) => apiFetch<ProjectSummary>(`/projects/${projectId}`, {
    method: "PATCH",
    body: JSON.stringify(body)
  }).then((project) => ({ ...project, name: normalizeProjectName(project.name) })),
  deleteProject: (projectId: string) => apiFetch<{ status: string }>(`/projects/${projectId}`, {
    method: "DELETE"
  }),
  threads: (projectId: string) => apiFetch<ThreadSummary[]>(`/projects/${projectId}/threads`).then((threads) => threads.map(normalizeThread)),
  allThreads,
  createThread: (projectId: string | null, title?: string) => apiFetch<ThreadSummary>(projectId ? `/projects/${projectId}/threads` : "/threads", {
    method: "POST",
    body: JSON.stringify(projectId ? { title } : { title, projectId: null })
  }).then(normalizeThread),
  moveThread: (threadId: string, projectId: string | null) => apiFetch<ThreadSummary>(`/threads/${threadId}`, {
    method: "PATCH",
    body: JSON.stringify({ projectId })
  }).then(normalizeThread),
  renameThread: (threadId: string, title: string) => apiFetch<ThreadSummary>(`/threads/${threadId}`, {
    method: "PATCH",
    body: JSON.stringify({ title })
  }).then((thread) => ({ ...thread, title: normalizeDisplayText(thread.title, "新对话") })),
  deleteThread: (threadId: string) => apiFetch<{ status: string }>(`/threads/${threadId}`, {
    method: "DELETE"
  }),
  thread: (threadId: string) => apiFetch<ThreadSnapshot>(`/threads/${threadId}`).then(normalizeSnapshot),
  agents: () => apiFetch<AgentDefinition[]>("/agents"),
  models: () => apiFetch<ModelDefinition[]>("/models"),
  tools: () => apiFetch<ToolDefinition[]>("/tools"),
  uploadAttachments: (threadId: string, files: File[]) => {
    const body = new FormData();
    files.forEach((file) => body.append("files", file));
    return apiFetch<MessageAttachment[]>(`/threads/${threadId}/attachments`, { method: "POST", body }).then((attachments) => attachments.map((attachment) => ({ ...attachment, url: resolveWorkbenchResourceUrl(attachment.url) })));
  },
  startRun: (threadId: string, body: { message: string; agentId: string; modelId: string; reasoningEffort: ReasoningEffort; toolIds: string[]; permissionMode: "ask" | "auto" | "read-only"; attachmentIds: string[]; replaceMessageId: string | null }) =>
    apiFetch<{ runId: string }>(`/threads/${threadId}/runs`, { method: "POST", body: JSON.stringify(body) }),
  stopRun: (runId: string) => apiFetch<{ status: string }>(`/runs/${runId}/stop`, { method: "POST", body: "{}" }),
  resolveApproval: (approvalId: string, decision: "allow_once" | "always_allow" | "deny") =>
    apiFetch<{ status: string }>(`/approvals/${approvalId}`, { method: "POST", body: JSON.stringify({ decision }) }),
  eventUrl: (runId: string, after = 0) => `${API_BASE_URL}/runs/${runId}/events?after=${after}`
};
