import { describe, expect, it } from "vitest";
import { createEmptyThreadState } from "@/lib/agent-events/reducer";
import { reconcileThreadSnapshot } from "./use-agent-thread";

function state(lastSeq: number) {
  return { ...createEmptyThreadState("project", "thread"), lastSeq };
}

describe("reconcileThreadSnapshot", () => {
  it("does not replace an append-only read model or advance its SSE cursor during an active run", () => {
    const current = {
      ...state(12),
      activeRunId: "run-live",
      runStatus: "running" as const,
      items: {
        answer: {
          kind: "message" as const,
          id: "answer",
          runId: "run-live",
          role: "assistant" as const,
          text: "已经逐字显示的前缀",
          status: "streaming" as const,
          createdAt: "2026-08-01T00:00:00.000Z"
        }
      },
      itemOrder: ["answer"]
    };
    const incoming = { ...state(20), items: {}, itemOrder: [] };

    const reconciled = reconcileThreadSnapshot(current, incoming, 12);

    expect(reconciled.state).toBe(current);
    expect(reconciled.lastSeq).toBe(12);
  });

  it("accepts a newer settled snapshot and advances the durable cursor", () => {
    const current = { ...state(12), runStatus: "completed" as const };
    const incoming = { ...state(20), runStatus: "completed" as const };

    expect(reconcileThreadSnapshot(current, incoming, 12)).toEqual({
      state: incoming,
      lastSeq: 20
    });
  });

  it("never lets an older snapshot rewind a settled read model", () => {
    const current = { ...state(20), runStatus: "completed" as const };
    const incoming = { ...state(12), runStatus: "completed" as const };

    expect(reconcileThreadSnapshot(current, incoming, 20)).toEqual({
      state: current,
      lastSeq: 20
    });
  });
});
