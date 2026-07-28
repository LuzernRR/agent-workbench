import {
  createV2QueueState,
  mergeV2QueueInputs,
  type V2QueueState,
  type V2RejectedQueueInput
} from "./queue-reducer";
import {
  createV2RunState,
  mergeV2RunInputs,
  type V2RejectedRunInput,
  type V2RunState
} from "./run-reducer";
import type { V2Scope } from "./types";

export interface V2SnapshotInput {
  readonly runId: string;
  readonly threadId: string;
  readonly scope: V2Scope;
  readonly runEvents: readonly unknown[];
  readonly queueEvents: readonly unknown[];
}

export interface V2ProjectedSnapshot {
  readonly run: V2RunState;
  readonly queue: V2QueueState;
  readonly rejectedRunInputs: readonly V2RejectedRunInput[];
  readonly rejectedQueueInputs: readonly V2RejectedQueueInput[];
}

export function projectV2Snapshot(input: V2SnapshotInput): V2ProjectedSnapshot {
  const run = mergeV2RunInputs(createV2RunState(input.runId, input.scope), input.runEvents);
  const queue = mergeV2QueueInputs(createV2QueueState(input.threadId, input.scope), input.queueEvents);
  return {
    run: run.state,
    queue: queue.state,
    rejectedRunInputs: run.rejected,
    rejectedQueueInputs: queue.rejected
  };
}
