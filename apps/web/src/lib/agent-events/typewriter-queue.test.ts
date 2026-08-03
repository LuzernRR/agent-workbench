import { describe, expect, it } from "vitest";
import { createRenderQueue } from "./typewriter-queue";
import type { AgentEvent } from "./types";

const base = { projectId: "project", threadId: "thread", runId: "run", createdAt: "2026-07-25T00:00:00.000Z" };
const event = (seq: number, type: AgentEvent["type"], payload: Record<string, unknown>): AgentEvent => ({
  ...base,
  id: `event-${seq}`,
  seq,
  type,
  payload
});

// A synchronous frame scheduler so tests can advance the queue deterministically
// instead of depending on requestAnimationFrame timing.
function manualFrames() {
  const pending: Array<() => void> = [];
  return {
    requestFrame: (callback: () => void) => {
      pending.push(callback);
      return pending.length;
    },
    cancelFrame: () => {
      pending.length = 0;
    },
    // Run queued frames until the queue stops scheduling more or we hit the cap.
    flush: (max = 10_000) => {
      let frames = 0;
      while (pending.length > 0 && frames < max) {
        const next = pending.shift()!;
        frames += 1;
        next();
      }
      return frames;
    }
  };
}

describe("createRenderQueue", () => {
  it("reveals a short delta one grapheme per frame for a typewriter feel", () => {
    const frames = manualFrames();
    const applied: string[] = [];
    const queue = createRenderQueue({
      apply: (e) => applied.push(String(e.payload.delta ?? "")),
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame
    });
    queue.enqueue(event(1, "text.delta", { messageId: "m1", delta: "你好" }));
    const drawn = frames.flush();
    // Two graphemes over two separate frames.
    expect(applied).toEqual(["你", "好"]);
    expect(drawn).toBeGreaterThanOrEqual(2);
  });

  it("streams a persisted Agent public-process delta before completing that activity", () => {
    const frames = manualFrames();
    const order: string[] = [];
    const queue = createRenderQueue({
      apply: (e) => order.push(e.type === "thinking.delta" ? String(e.payload.delta) : `[${e.type}]`),
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame
    });
    queue.enqueue(event(1, "thinking.started", { thinkingId: "thinking-one" }));
    queue.enqueue(event(2, "thinking.delta", { thinkingId: "thinking-one", paragraphId: "paragraph-one", delta: "核对来源" }));
    queue.enqueue(event(3, "thinking.completed", { thinkingId: "thinking-one" }));
    frames.flush();
    expect(order).toEqual(["[thinking.started]", "核", "对", "来", "源", "[thinking.completed]"]);
  });

  it("paints the last streamed grapheme before a following fold event", () => {
    const frames = manualFrames();
    const order: string[] = [];
    const queue = createRenderQueue({
      apply: (e) => order.push(e.type === "thinking.delta" ? String(e.payload.delta) : `[${e.type}]`),
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame
    });
    queue.enqueue(event(1, "thinking.delta", {
      thinkingId: "thinking-one",
      paragraphId: "paragraph-one",
      delta: "尾"
    }));
    queue.enqueue(event(2, "thinking.completed", { thinkingId: "thinking-one" }));

    frames.flush(1);
    expect(order).toEqual(["尾"]);
    frames.flush(1);
    expect(order).toEqual(["尾", "[thinking.completed]"]);
  });

  it("reveals source link text character by character before folding its search row", () => {
    const frames = manualFrames();
    const order: string[] = [];
    const queue = createRenderQueue({
      apply: (e) => order.push(e.type === "tool.source.delta" ? String(e.payload.delta) : `[${e.type}:${String(e.payload.sourcePresentationActive)}]`),
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame
    });
    queue.enqueue(event(1, "tool.updated", { toolCallId: "search-one", sourcePresentationActive: true }));
    queue.enqueue(event(2, "tool.source.delta", { toolCallId: "search-one", url: "https://example.com/source", delta: "有效来源" }));
    queue.enqueue(event(3, "tool.updated", { toolCallId: "search-one", sourcePresentationActive: false }));
    frames.flush();
    expect(order).toEqual([
      "[tool.updated:true]",
      "有",
      "效",
      "来",
      "源",
      "[tool.updated:false]"
    ]);
  });

  it("keeps combined emoji graphemes intact", () => {
    const frames = manualFrames();
    const applied: string[] = [];
    const queue = createRenderQueue({
      apply: (e) => applied.push(String(e.payload.delta ?? "")),
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame
    });
    // A multi-code-unit emoji must not be split across frames.
    queue.enqueue(event(1, "text.delta", { messageId: "m1", delta: "🚀火箭" }));
    frames.flush();
    expect(applied.join("")).toBe("🚀火箭");
    expect(applied[0]).toBe("🚀");
  });

  it.each(["text.delta", "thinking.delta", "tool.source.delta"] as const)(
    "streams each %s payload as one extended grapheme per frame",
    (type) => {
      const frames = manualFrames();
      const applied: string[] = [];
      const queue = createRenderQueue({
        apply: (e) => applied.push(String(e.payload.delta ?? "")),
        requestFrame: frames.requestFrame,
        cancelFrame: frames.cancelFrame
      });
      queue.enqueue(event(1, type, {
        messageId: "m1",
        thinkingId: "thinking-one",
        paragraphId: "paragraph-one",
        toolCallId: "search-one",
        url: "https://example.com/source",
        delta: "👨‍👩‍👧‍👦好"
      }));

      expect(frames.flush()).toBe(2);
      expect(applied).toEqual(["👨‍👩‍👧‍👦", "好"]);
    }
  );

  it("accelerates a large backlog but never exceeds the per-frame cap", () => {
    const frames = manualFrames();
    let count = 0;
    const queue = createRenderQueue({
      apply: () => {
        count += 1;
      },
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame
    });
    const big = "字".repeat(3000);
    queue.enqueue(event(1, "text.delta", { messageId: "m1", delta: big }));
    const drawn = frames.flush();
    expect(count).toBe(3000);
    // 积压 3000 字时每帧吐 24 个（上限），3000/24 ≈ 125 帧即可排空。
    expect(drawn).toBeLessThan(3000);
    expect(drawn).toBeGreaterThanOrEqual(Math.ceil(3000 / 24));
  });

  it("does not let a terminal event accelerate or overtake answer text", () => {
    const frames = manualFrames();
    let chars = 0;
    const queue = createRenderQueue({
      apply: (e) => {
        if (e.type === "text.delta") chars += 1;
      },
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame
    });
    queue.enqueue(event(1, "text.delta", { messageId: "m1", delta: "字".repeat(1000) }));
    queue.enqueue(event(2, "run.completed", {}));
    const drawn = frames.flush();
    expect(chars).toBe(1000);
    // run.completed 只在所有更早的字之后触发，且不增加逐字计数。
    expect(drawn).toBeGreaterThanOrEqual(Math.ceil(1000 / 24));
    expect(drawn).toBeLessThan(1001);
  });

  it("applies a queued terminal only after the preceding text has drained", () => {
    const frames = manualFrames();
    const order: string[] = [];
    const queue = createRenderQueue({
      apply: (e) => order.push(e.type === "text.delta" ? String(e.payload.delta) : e.type),
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame
    });
    queue.enqueue(event(1, "text.delta", { messageId: "m1", delta: "abcdef" }));
    queue.enqueue(event(2, "run.completed", {}));
    frames.flush();
    expect(order[order.length - 1]).toBe("run.completed");
    expect(order.slice(0, -1).join("")).toBe("abcdef");
  });

  it("keeps a completed answer visibly streaming when its terminal is already queued", () => {
    const frames = manualFrames();
    const snapshots: string[] = [];
    let visible = "";
    const queue = createRenderQueue({
      apply: (e) => {
        if (e.type === "message.delta") {
          visible += String(e.payload.delta);
          snapshots.push(visible);
        }
      },
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame
    });
    const answer = "最终回答需要逐步显示，不能在完成事件到达时整段跳出。".repeat(20);
    queue.enqueue(event(1, "message.delta", { messageId: "m1", delta: answer }));
    queue.enqueue(event(2, "message.completed", { messageId: "m1", text: answer }));
    queue.enqueue(event(3, "run.completed", {}));
    const drawn = frames.flush();

    expect(visible).toBe(answer);
    // 逐字 append 不变：每个可见快照仍只比上一个多一个 grapheme。
    expect(snapshots.length).toBe(Array.from(answer).length);
    // 提速后每帧最多 24 字，快照数 = 字数，因此帧数不会超过字数。
    expect(drawn).toBeLessThanOrEqual(snapshots.length);
  });

  it("preserves non-text ordering: tool events apply after earlier text drains", () => {
    const frames = manualFrames();
    const order: string[] = [];
    const queue = createRenderQueue({
      apply: (e) => order.push(e.type === "text.delta" ? String(e.payload.delta) : e.type),
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame
    });
    queue.enqueue(event(1, "text.delta", { messageId: "m1", delta: "abc" }));
    queue.enqueue(event(2, "tool.started", { toolCallId: "t1" }));
    queue.enqueue(event(3, "text.delta", { messageId: "m1", delta: "de" }));
    frames.flush();
    expect(order).toEqual(["a", "b", "c", "tool.started", "d", "e"]);
  });

  it("keeps the existing draft immutable when a legacy message.reset arrives", () => {
    const frames = manualFrames();
    const order: string[] = [];
    const queue = createRenderQueue({
      apply: (e) => order.push(e.type === "text.delta" ? String(e.payload.delta) : `[${e.type}]`),
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame
    });
    // The reset is ordered after the already-durable draft and cannot erase it.
    queue.enqueue(event(1, "tool.completed", { toolCallId: "t1" }));
    queue.enqueue(event(2, "text.delta", { messageId: "m1", delta: "废弃的草稿内容" }));
    queue.enqueue(event(3, "message.reset", { messageId: "m1", text: "" }));
    frames.flush();
    expect(order.filter((entry) => entry.length === 1).join("")).toBe("废弃的草稿内容");
    expect(order).toContain("[tool.completed]");
    expect(order).toContain("[message.reset]");
  });

  it("flush still applies one grapheme per reducer mutation", () => {
    const frames = manualFrames();
    const applied: AgentEvent[] = [];
    const queue = createRenderQueue({
      apply: (value) => applied.push(value),
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame
    });
    queue.enqueue(event(1, "text.delta", { messageId: "m1", delta: "后台继续生成" }));
    queue.enqueue(event(2, "run.completed", {}));

    queue.flush();

    expect(applied.map((value) => value.type)).toEqual([
      "text.delta", "text.delta", "text.delta", "text.delta", "text.delta", "text.delta", "run.completed"
    ]);
    expect(applied.slice(0, -1).map((value) => value.payload.delta).join("")).toBe("后台继续生成");
    expect(applied.slice(0, -1).every((value) => Array.from(String(value.payload.delta)).length === 1)).toBe(true);
    expect(frames.flush()).toBe(0);
  });

  it("normalizes a legacy whole thinking paragraph into append-only deltas", () => {
    const frames = manualFrames();
    const applied: AgentEvent[] = [];
    const queue = createRenderQueue({
      apply: (value) => applied.push(value),
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame
    });
    queue.enqueue(event(1, "thinking.paragraph", {
      thinkingId: "thinking-one",
      paragraphId: "paragraph-one",
      text: "新增证据"
    }));
    frames.flush();
    expect(applied.every((value) => value.type === "thinking.delta")).toBe(true);
    expect(applied.map((value) => value.payload.delta).join("")).toBe("新增证据");
  });

  it("stops applying events after dispose", () => {
    const frames = manualFrames();
    let count = 0;
    const queue = createRenderQueue({
      apply: () => {
        count += 1;
      },
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame
    });
    queue.enqueue(event(1, "text.delta", { messageId: "m1", delta: "abcdef" }));
    queue.dispose();
    frames.flush();
    expect(count).toBe(0);
  });
});
