import { describe, expect, it } from "vitest";
import { resolveDraftElapsedStartedAt } from "./WorkbenchShell";

describe("resolveDraftElapsedStartedAt", () => {
  const startedAt = "2026-08-07T01:02:03.000Z";

  it("keeps the draft anchor while the created thread is still hydrating", () => {
    expect(resolveDraftElapsedStartedAt({
      draftStartedAt: startedAt,
      draftHandoffThreadId: "thread-created",
      threadId: "thread-created",
      handoffHydrated: false
    })).toBe(startedAt);
  });

  it("drops the draft anchor after handoff hydration so later runs cannot reuse it", () => {
    expect(resolveDraftElapsedStartedAt({
      draftStartedAt: startedAt,
      draftHandoffThreadId: "thread-created",
      threadId: "thread-created",
      handoffHydrated: true
    })).toBeNull();
  });

  it("keeps the anchor only on the draft selection or its matching handoff", () => {
    expect(resolveDraftElapsedStartedAt({
      draftStartedAt: startedAt,
      draftHandoffThreadId: null,
      threadId: null,
      handoffHydrated: false
    })).toBe(startedAt);
    expect(resolveDraftElapsedStartedAt({
      draftStartedAt: startedAt,
      draftHandoffThreadId: "thread-created",
      threadId: "thread-other",
      handoffHydrated: false
    })).toBeNull();
  });
});
