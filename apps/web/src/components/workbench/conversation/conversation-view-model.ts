import type { AgentThreadState, ThinkingItem, TimelineItem, ToolItem } from "@/lib/agent-events/types";

export function isSearchToolItem(item: ToolItem) {
  return /搜索|search/iu.test(item.name)
    || Boolean(item.query)
    || typeof item.resultCount === "number"
    || typeof item.evidenceCount === "number";
}

function thinkingActivityKind(item: ThinkingItem) {
  return item.activityKind || "thinking";
}

function mergedThinkingStatus(items: readonly ThinkingItem[]): ThinkingItem["status"] {
  if (items.some((item) => item.status === "streaming")) return "streaming";
  if (items.some((item) => item.status === "error")) return "error";
  if (items.some((item) => item.status === "stopped")) return "stopped";
  return "completed";
}

/**
 * Build a chronological public timeline with run-length grouping:
 * only adjacent activities of the same class are merged. Once another class
 * appears, a later thought/search/verification starts a new immutable row.
 * The underlying event ledger and toolCallId records remain untouched.
 */
export function selectConversationTimelineItems(state: AgentThreadState): TimelineItem[] {
  const visible: TimelineItem[] = [];

  for (const id of new Set(state.itemOrder)) {
    const item = state.items[id];
    if (!item) continue;

    const previous = visible.at(-1);
    if (
      item.kind === "thinking"
      && previous?.kind === "thinking"
      && previous.runId === item.runId
      && thinkingActivityKind(previous) === thinkingActivityKind(item)
    ) {
      const members = [previous, item];
      visible[visible.length - 1] = {
        ...previous,
        paragraphs: [...previous.paragraphs, ...item.paragraphs],
        status: mergedThinkingStatus(members)
      };
      continue;
    }

    if (item.kind === "tool" && isSearchToolItem(item)) {
      if (
        previous?.kind === "tool"
        && previous.runId === item.runId
        && isSearchToolItem(previous)
      ) continue;
    }
    visible.push(item);
  }

  return visible;
}

export function selectSearchSegmentTools(state: AgentThreadState, representativeId: string): ToolItem[] {
  const ordered = [...new Set(state.itemOrder)].map((id) => state.items[id]).filter(Boolean);
  const start = ordered.findIndex((item) => item.id === representativeId);
  if (start < 0) return [];
  const representative = ordered[start];
  if (representative.kind !== "tool" || !isSearchToolItem(representative)) return [];

  const segment: ToolItem[] = [];
  for (const item of ordered.slice(start)) {
    if (
      item.kind !== "tool"
      || item.runId !== representative.runId
      || !isSearchToolItem(item)
    ) break;
    segment.push(item);
  }
  return segment;
}
