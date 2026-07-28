export type WorkbenchSelection = {
  projectId: string | null | undefined;
  threadId: string | null;
};

export function workbenchSelectionPath(projectId: string | null | undefined, threadId: string | null) {
  if (threadId) return `/workbench/t/${encodeURIComponent(threadId)}`;
  if (projectId) return `/workbench/p/${encodeURIComponent(projectId)}`;
  return "/workbench";
}
