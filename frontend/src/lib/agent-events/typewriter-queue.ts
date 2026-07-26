import type { AgentEvent } from "./types";

// Adaptive typewriter queue for durable SSE deltas.
//
// A single persisted `text.delta` can carry anywhere from a few characters to
// a full paragraph. Rendering exactly one grapheme per animation frame keeps
// the growth smooth for short bursts but adds ~50s of tail latency to a
// multi-thousand character answer. Instead we drain an adaptive number of
// characters per frame: small backlogs stay one-at-a-time for a genuine
// typewriter feel, while large backlogs (or an already-arrived terminal event)
// accelerate so the visible tail latency stays bounded. We never fall back to
// publishing a whole delta in one jump.
//
// Non-text events (tools, plan, citations, terminal) apply strictly in durable
// order, only after any characters queued before them have drained. A
// `message.reset` (quality retry) discards the still-unrendered portion of the
// previous draft but preserves preceding control/tool events. Background tabs
// can explicitly flush pending deltas because browsers suspend animation frames
// when a document is hidden.

type QueueItem = { event: AgentEvent; characters: string[] | null; offset: number };

export type RenderQueueOptions = {
  apply: (event: AgentEvent) => void;
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (handle: number) => void;
  // Target number of frames to drain the current backlog over. Larger backlogs
  // therefore draw more characters per frame while staying visibly continuous.
  targetFrames?: number;
  // A tighter target once a terminal event is queued, so the run finishes
  // promptly instead of lingering behind a long draft.
  terminalFrames?: number;
  // Hard ceiling so a single frame never dumps a large block.
  maxCharsPerFrame?: number;
};

const TEXT_TYPES = new Set<AgentEvent["type"]>(["text.delta", "message.delta"]);
const TERMINAL_TYPES = new Set<AgentEvent["type"]>(["run.completed", "run.failed", "run.cancelled"]);

export function createRenderQueue(options: RenderQueueOptions) {
  const requestFrame = options.requestFrame ?? ((callback: () => void) => window.requestAnimationFrame(callback));
  const cancelFrame = options.cancelFrame ?? ((handle: number) => window.cancelAnimationFrame(handle));
  const targetFrames = Math.max(1, options.targetFrames ?? 45);
  const terminalFrames = Math.max(1, options.terminalFrames ?? 12);
  const maxCharsPerFrame = Math.max(1, options.maxCharsPerFrame ?? 120);

  const queue: QueueItem[] = [];
  let frame = 0;
  let disposed = false;

  const backlog = () => queue.reduce((sum, item) => sum + (item.characters ? item.characters.length - item.offset : 0), 0);
  const terminalQueued = () => queue.some((item) => TERMINAL_TYPES.has(item.event.type));

  const charsThisFrame = () => {
    const pending = backlog();
    if (pending === 0) return 0;
    const frames = terminalQueued() ? terminalFrames : targetFrames;
    return Math.max(1, Math.min(maxCharsPerFrame, Math.ceil(pending / frames)));
  };

  const drain = () => {
    frame = 0;
    if (disposed) return;
    let budget = charsThisFrame();
    while (queue.length > 0) {
      const current = queue[0];
      if (current.characters) {
        while (current.offset < current.characters.length && budget > 0) {
          const index = current.offset++;
          const total = current.characters.length;
          options.apply({
            ...current.event,
            // The reducer enforces monotonic durable sequence numbers. Use a
            // fractional display-only position inside this one persisted delta
            // so each grapheme renders exactly once and the next real event
            // still carries a larger integer sequence.
            seq: current.event.seq - 1 + (index + 1) / (total + 1),
            payload: { ...current.event.payload, delta: current.characters[index] }
          });
          budget -= 1;
        }
        if (current.offset < current.characters.length) {
          frame = requestFrame(drain);
          return;
        }
        queue.shift();
        continue;
      }
      queue.shift();
      options.apply(current.event);
    }
  };

  const schedule = () => {
    if (!disposed && !frame) frame = requestFrame(drain);
  };

  const enqueue = (event: AgentEvent) => {
    if (event.type === "message.reset") {
      // A quality retry invalidates any unrendered portion of the previous
      // draft. Drop only queued deltas, preserve preceding control/tool
      // events, then apply the reset in durable order.
      const retained = queue.filter((item) => !TEXT_TYPES.has(item.event.type));
      queue.splice(0, queue.length, ...retained, { event, characters: null, offset: 0 });
      schedule();
      return;
    }
    if (TEXT_TYPES.has(event.type)) {
      const characters = Array.from(String(event.payload.delta || ""));
      if (characters.length > 0) queue.push({ event, characters, offset: 0 });
    } else {
      queue.push({ event, characters: null, offset: 0 });
    }
    schedule();
  };

  const flush = () => {
    if (disposed) return;
    if (frame) cancelFrame(frame);
    frame = 0;
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (!current.characters) {
        options.apply(current.event);
        continue;
      }
      const delta = current.characters.slice(current.offset).join("");
      if (!delta) continue;
      options.apply({
        ...current.event,
        seq: current.event.seq,
        payload: { ...current.event.payload, delta }
      });
    }
  };

  const dispose = () => {
    disposed = true;
    if (frame) cancelFrame(frame);
    queue.length = 0;
  };

  return { enqueue, flush, dispose };
}
