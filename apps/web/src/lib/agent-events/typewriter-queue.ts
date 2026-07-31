import type { AgentEvent } from "./types";

// Durable SSE events may contain a full sentence, but visible public text must
// grow by exactly one Unicode grapheme and must never be rewritten. Control
// events keep durable order and wait behind all earlier graphemes.

type QueueItem = {
  event: AgentEvent;
  graphemes: string[] | null;
  offset: number;
  emittedType?: AgentEvent["type"];
};

export type RenderQueueOptions = {
  apply: (event: AgentEvent) => void;
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (handle: number) => void;
};

const DELTA_TYPES = new Set<AgentEvent["type"]>([
  "text.delta",
  "message.delta",
  "thinking.delta",
  "tool.source.delta"
]);

function graphemes(value: string) {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return [...segmenter.segment(value)].map((item) => item.segment);
  }
  return Array.from(value);
}

function streamItem(event: AgentEvent): QueueItem {
  if (DELTA_TYPES.has(event.type)) {
    return {
      event,
      graphemes: graphemes(String(event.payload.delta || "")),
      offset: 0
    };
  }
  // Legacy mock/snapshot events can still carry a whole public paragraph.
  // Normalize them to append-only deltas before they reach the reducer.
  if (event.type === "thinking.paragraph") {
    return {
      event,
      graphemes: graphemes(String(event.payload.text || "")),
      offset: 0,
      emittedType: "thinking.delta"
    };
  }
  return { event, graphemes: null, offset: 0 };
}

function graphemeEvent(item: QueueItem) {
  const index = item.offset++;
  const total = item.graphemes?.length || 1;
  return {
    ...item.event,
    type: item.emittedType || item.event.type,
    // Fractional positions are display-only. The following durable event still
    // has the next integer sequence, while every grapheme is accepted once.
    seq: item.event.seq - 1 + (index + 1) / (total + 1),
    payload: {
      ...item.event.payload,
      delta: item.graphemes?.[index] || ""
    }
  } satisfies AgentEvent;
}

export function createRenderQueue(options: RenderQueueOptions) {
  const requestFrame = options.requestFrame ?? ((callback: () => void) => window.requestAnimationFrame(callback));
  const cancelFrame = options.cancelFrame ?? ((handle: number) => window.cancelAnimationFrame(handle));
  const queue: QueueItem[] = [];
  let frame = 0;
  let disposed = false;

  const drain = () => {
    frame = 0;
    if (disposed) return;

    while (queue.length > 0) {
      const current = queue[0];
      if (!current.graphemes) {
        queue.shift();
        options.apply(current.event);
        continue;
      }
      if (current.offset >= current.graphemes.length) {
        queue.shift();
        continue;
      }
      options.apply(graphemeEvent(current));
      if (current.offset >= current.graphemes.length) queue.shift();
      // Always yield after one visible grapheme so React can paint it before
      // any later text or terminal event is applied.
      if (queue.length > 0 || (current.graphemes && current.offset < current.graphemes.length)) {
        frame = requestFrame(drain);
      }
      return;
    }
  };

  const schedule = () => {
    if (!disposed && !frame) frame = requestFrame(drain);
  };

  const enqueue = (event: AgentEvent) => {
    const item = streamItem(event);
    if (item.graphemes && item.graphemes.length === 0) return;
    queue.push(item);
    schedule();
  };

  // Kept for deterministic tests and controlled teardown. Even an explicit
  // flush applies one grapheme per reducer mutation; the UI never calls this
  // while hidden, so browsers cannot batch a whole paragraph into one paint.
  const flush = () => {
    if (disposed) return;
    if (frame) cancelFrame(frame);
    frame = 0;
    while (queue.length > 0) {
      const current = queue[0];
      if (!current.graphemes) {
        queue.shift();
        options.apply(current.event);
        continue;
      }
      while (current.offset < current.graphemes.length) {
        options.apply(graphemeEvent(current));
      }
      queue.shift();
    }
  };

  const dispose = () => {
    disposed = true;
    if (frame) cancelFrame(frame);
    queue.length = 0;
  };

  return { enqueue, flush, dispose };
}
