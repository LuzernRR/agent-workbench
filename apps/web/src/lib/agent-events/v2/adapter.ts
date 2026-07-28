import Ajv2020, { type AnySchema, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { z } from "zod";
import agentEventJson from "@contracts/v2/schemas/agent-event.schema.json";
import commonJson from "@contracts/v2/schemas/common.schema.json";
import runQueueEntryJson from "@contracts/v2/schemas/run-queue-entry.schema.json";
import steeringCommandJson from "@contracts/v2/schemas/steering-command.schema.json";
import threadQueueEventJson from "@contracts/v2/schemas/thread-queue-event.schema.json";
import {
  V2_AGENT_EVENT_TYPES,
  type V2AgentEvent,
  type V2AgentEventType,
  type V2EventKindByType,
  type V2EventStatusByType,
  type V2ParseResult,
  type V2SteeringCommand,
  type V2ThreadQueueEvent
} from "./types";

const privateReasoningKeys = new Set(["reasoning_content", "chainOfThought", "rawReasoning", "rawCoT"]);

function containsPrivateReasoning(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsPrivateReasoning);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => privateReasoningKeys.has(key) || containsPrivateReasoning(child));
}

const ajv = new Ajv2020({
  allErrors: false,
  strict: true,
  validateFormats: true
});
addFormats(ajv);
[commonJson, runQueueEntryJson, agentEventJson, threadQueueEventJson, steeringCommandJson].forEach((schema) => {
  ajv.addSchema(schema as AnySchema);
});

const agentEventValidator = ajv.getSchema(agentEventJson.$id) as ValidateFunction;
const threadQueueEventValidator = ajv.getSchema(threadQueueEventJson.$id) as ValidateFunction;
const steeringCommandValidator = ajv.getSchema(steeringCommandJson.$id) as ValidateFunction;

const scopeSchema = z.object({
  tenantId: z.string(),
  actorId: z.string(),
  visitorId: z.string(),
  projectId: z.string().nullable(),
  threadId: z.string()
}).strict();
const refsSchema = z.object({
  planRef: z.string().optional(),
  toolCallId: z.string().optional(),
  artifactId: z.string().optional(),
  citationId: z.string().optional(),
  messageId: z.string().optional(),
  commandId: z.string().optional(),
  responseId: z.string().optional(),
  checkpointRef: z.string().optional()
}).strict();
const timestampSchema = z.iso.datetime({ offset: true });

type EventDefinitions = {
  readonly [T in V2AgentEventType]: {
    readonly kind: V2EventKindByType[T];
    readonly statuses: readonly V2EventStatusByType[T][];
    readonly payload: keyof typeof agentEventJson.$defs;
  };
};

const eventDefinitions: EventDefinitions = {
  "run.created": { kind: "run", statuses: ["pending"], payload: "RunCreatedPayload" },
  "run.status": { kind: "run", statuses: ["running", "waiting", "waiting_approval", "waiting_clarification"], payload: "RunStatusPayload" },
  "node.started": { kind: "node", statuses: ["running"], payload: "NodeStartedPayload" },
  "node.completed": { kind: "node", statuses: ["completed"], payload: "NodeCompletedPayload" },
  "node.failed": { kind: "node", statuses: ["failed"], payload: "NodeFailedPayload" },
  "plan.updated": { kind: "plan", statuses: ["completed"], payload: "PlanUpdatedPayload" },
  "tool.started": { kind: "tool", statuses: ["running"], payload: "ToolStartedPayload" },
  "tool.updated": { kind: "tool", statuses: ["running", "waiting_approval"], payload: "ToolUpdatedPayload" },
  "tool.completed": { kind: "tool", statuses: ["completed"], payload: "ToolCompletedPayload" },
  "tool.failed": { kind: "tool", statuses: ["failed"], payload: "ToolFailedPayload" },
  "tool.unknown": { kind: "tool", statuses: ["unknown"], payload: "ToolUnknownPayload" },
  "approval.required": { kind: "approval", statuses: ["waiting_approval"], payload: "ApprovalRequiredPayload" },
  "approval.decided": { kind: "approval", statuses: ["completed"], payload: "ApprovalDecidedPayload" },
  "clarification.required": { kind: "clarification", statuses: ["waiting_clarification"], payload: "ClarificationRequiredPayload" },
  "clarification.resumed": { kind: "clarification", statuses: ["completed"], payload: "ClarificationResumedPayload" },
  "context.usage.updated": { kind: "context", statuses: ["completed"], payload: "ContextUsageUpdatedPayload" },
  "budget.updated": { kind: "budget", statuses: ["completed"], payload: "BudgetUpdatedPayload" },
  "artifact.created": { kind: "artifact", statuses: ["completed"], payload: "ArtifactCreatedPayload" },
  "citation.created": { kind: "citation", statuses: ["completed"], payload: "CitationCreatedPayload" },
  "verification.completed": { kind: "verification", statuses: ["completed"], payload: "VerificationCompletedPayload" },
  "memory.updated": { kind: "memory", statuses: ["completed"], payload: "MemoryUpdatedPayload" },
  "message.started": { kind: "message", statuses: ["running"], payload: "MessageStartedPayload" },
  "message.completed": { kind: "message", statuses: ["completed"], payload: "MessageCompletedPayload" },
  "guidance.accepted": { kind: "guidance", statuses: ["pending"], payload: "GuidanceAcceptedPayload" },
  "guidance.applied": { kind: "guidance", statuses: ["completed"], payload: "GuidanceAppliedPayload" },
  "guidance.superseded": { kind: "guidance", statuses: ["superseded"], payload: "GuidanceSupersededPayload" },
  "guidance.rejected": { kind: "guidance", statuses: ["rejected"], payload: "GuidanceRejectedPayload" },
  "guidance.failed": { kind: "guidance", statuses: ["failed"], payload: "GuidanceFailedPayload" },
  "run.completed": { kind: "run", statuses: ["completed"], payload: "RunCompletedPayload" },
  "run.cancelled": { kind: "run", statuses: ["cancelled"], payload: "RunCancelledPayload" },
  "run.failed": { kind: "run", statuses: ["failed"], payload: "RunFailedPayload" }
};

const eventBranches = V2_AGENT_EVENT_TYPES.map((type) => {
  const definition = eventDefinitions[type];
  return z.object({
    schemaVersion: z.literal("2.0"),
    eventId: z.string(),
    runId: z.string(),
    scope: scopeSchema,
    seq: z.number().int().min(1),
    occurredAt: timestampSchema,
    type: z.literal(type),
    kind: z.literal(definition.kind),
    status: z.string().refine(
      (status) => (definition.statuses as readonly string[]).includes(status)
    ),
    startedAt: z.union([timestampSchema, z.null()]),
    completedAt: z.union([timestampSchema, z.null()]),
    inputRevision: z.number().int().min(0),
    refs: refsSchema,
    source: z.enum(["live", "fixture"]),
    payload: z.unknown()
  }).strict();
});

export const v2AgentEventSchema = z.discriminatedUnion(
  "type",
  eventBranches as [typeof eventBranches[number], ...typeof eventBranches[number][]]
);

export function parseV2AgentEvent(input: unknown): V2ParseResult<V2AgentEvent> {
  if (containsPrivateReasoning(input)) return { ok: false, errorCode: "PRIVATE_REASONING_FORBIDDEN" };
  if (!agentEventValidator(input)) return { ok: false, errorCode: "SCHEMA_INVALID" };
  const result = v2AgentEventSchema.safeParse(input);
  return result.success
    ? { ok: true, value: result.data as V2AgentEvent }
    : { ok: false, errorCode: "SCHEMA_INVALID" };
}

export function parseV2ThreadQueueEvent(input: unknown): V2ParseResult<V2ThreadQueueEvent> {
  if (containsPrivateReasoning(input)) return { ok: false, errorCode: "PRIVATE_REASONING_FORBIDDEN" };
  return threadQueueEventValidator(input)
    ? { ok: true, value: input as V2ThreadQueueEvent }
    : { ok: false, errorCode: "SCHEMA_INVALID" };
}

export function parseV2SteeringCommand(input: unknown): V2ParseResult<V2SteeringCommand> {
  if (containsPrivateReasoning(input)) return { ok: false, errorCode: "PRIVATE_REASONING_FORBIDDEN" };
  return steeringCommandValidator(input)
    ? { ok: true, value: input as V2SteeringCommand }
    : { ok: false, errorCode: "SCHEMA_INVALID" };
}
