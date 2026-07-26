import { z } from "zod";
import { AGENT_EVENT_TYPES, type AgentEvent } from "./types";

export const agentEventSchema = z.object({
  id: z.string().min(1),
  seq: z.number().int().nonnegative(),
  projectId: z.string().min(1).nullable().optional(),
  threadId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  createdAt: z.string().min(1).optional(),
  type: z.enum(AGENT_EVENT_TYPES),
  payload: z.record(z.string(), z.unknown())
});

export function parseAgentEvent(input: unknown, context: { projectId: string | null; threadId: string; runId: string }): AgentEvent {
  const parsed = agentEventSchema.parse(input);
  return {
    ...parsed,
    projectId: parsed.projectId === undefined ? context.projectId : parsed.projectId,
    threadId: parsed.threadId || context.threadId,
    runId: parsed.runId || context.runId,
    createdAt: parsed.createdAt || new Date().toISOString()
  };
}
