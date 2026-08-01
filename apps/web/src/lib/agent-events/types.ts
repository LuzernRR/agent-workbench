export const AGENT_EVENT_TYPES = [
  "run.created",
  "run.started",
  "run.status",
  "thinking.started",
  "thinking.paragraph",
  "thinking.delta",
  "thinking.completed",
  "message.started",
  "message.reset",
  "message.delta",
  "text.delta",
  "message.completed",
  "tool.started",
  "tool.updated",
  "tool.progress",
  "tool.source.delta",
  "tool.completed",
  "tool.failed",
  "tool.unknown",
  "approval.required",
  "approval.resolved",
  "plan.updated",
  "artifact.created",
  "artifact.updated",
  "citation.created",
  "memory.updated",
  "file.changed",
  "log.appended",
  "run.completed",
  "run.cancelled",
  "run.failed"
] as const;

export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

export type AgentEvent = {
  id: string;
  seq: number;
  projectId: string | null;
  threadId: string;
  runId: string;
  createdAt: string;
  type: AgentEventType;
  payload: Record<string, unknown>;
};

export type RunStatus = "idle" | "queued" | "running" | "waiting" | "completed" | "failed" | "stopped" | "reconnecting";
export type ToolStatus = "preparing" | "running" | "waiting" | "completed" | "failed" | "stopped" | "unknown";
export type ToolVerificationStatus = "pending" | "succeeded" | "expired" | "account_mismatch" | "failed" | "cancelled";

export type ToolUsage = {
  toolId: string;
  toolVersion: string;
  provider: string;
  pricingVersion: string;
  currency: "USD";
  calls: number;
  attempts: number;
  units: number;
  bytes: number;
  resultCount: number;
  searchQueries: number;
  pageReads: number;
  estimatedCostUsd: string;
  actualCostUsd: string | null;
  possibleDuplicateCostUsd: string;
};

export type ToolSource = {
  title: string;
  url: string;
  verified: boolean;
  channel?: "web" | "x" | "xiaohongshu";
  author?: string;
  publishedAt?: string;
  limitation?: string;
  displayText?: string;
};

export type MessageAttachment = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  kind: "image" | "document";
  url: string;
};

export type MessageItem = {
  kind: "message";
  id: string;
  runId: string;
  role: "user" | "assistant" | "system";
  text: string;
  status: "streaming" | "completed" | "error";
  createdAt: string;
  agentId?: string;
  agentName?: string;
  citations?: Array<{ label: string; url: string }>;
  attachments?: MessageAttachment[];
};

export type ThinkingParagraph = {
  id: string;
  text: string;
  agent?: string;
  node?: string;
  iteration?: number;
};

export type ThinkingItem = {
  kind: "thinking";
  id: string;
  runId: string;
  /** Public activity class. Missing means legacy thinking data. */
  activityKind?: "thinking" | "verification";
  paragraphs: ThinkingParagraph[];
  status: "streaming" | "completed" | "stopped" | "error";
  createdAt: string;
};

export type ToolItem = {
  kind: "tool";
  id: string;
  runId: string;
  toolCallId: string;
  planStepId?: string;
  researchBatchId?: string;
  researchResultId?: string;
  operationRef?: string;
  resultRef?: string;
  attempt?: number;
  inputHash?: string;
  outputHash?: string;
  usage?: ToolUsage;
  name: string;
  summary: string;
  settlementSummary?: string;
  status: ToolStatus;
  outcomeStatus?: "success" | "degraded" | "failed";
  channel?: "web" | "x" | "xiaohongshu";
  query?: string;
  provider?: string;
  primaryProvider?: string;
  effectiveProvider?: string;
  reasonCode?: string;
  resolutionMessage?: string;
  nextAction?: "none" | "use_fallback" | "use_alternative_channel" | "reconnect_account" | "retry_later" | "check_operation" | "stop";
  resultCount?: number;
  evidenceCount?: number;
  sources?: ToolSource[];
  sourcePresentationActive?: boolean;
  cached?: boolean;
  retryable?: boolean;
  verificationStatus?: ToolVerificationStatus;
  verificationHref?: string;
  verificationExpiresAt?: string;
  verificationMessage?: string;
  input?: unknown;
  progress?: { current: number; total: number };
  output?: string;
  rawResult?: unknown;
  durationMs?: number;
  error?: string;
  createdAt: string;
};

export type ApprovalItem = {
  kind: "approval";
  id: string;
  runId: string;
  approvalId: string;
  toolCallId?: string;
  title: string;
  description: string;
  status: "pending" | "approved" | "denied";
  createdAt: string;
};

export type StatusItem = {
  kind: "status";
  id: string;
  runId: string;
  label: string;
  tone: "neutral" | "warning" | "danger";
  createdAt: string;
};

export type TimelineItem = MessageItem | ThinkingItem | ToolItem | ApprovalItem | StatusItem;

export type Artifact = {
  id: string;
  name: string;
  kind: "report" | "table" | "download";
  mimeType: string;
  content: string;
  version: number;
  createdAt: string;
  downloadUrl?: string;
};

export type WorkbenchFile = {
  id: string;
  path: string;
  name: string;
  status: "created" | "modified" | "unchanged";
  language?: string;
  content?: string;
  version: number;
  downloadUrl?: string;
};

export type LogEntry = {
  id: string;
  createdAt: string;
  actor: string;
  level: "debug" | "info" | "warn" | "error";
  content: string;
};

export type PlanStep = {
  id: string;
  planId?: string;
  revision?: number;
  title: string;
  facet?: string;
  objective?: string;
  query?: string;
  channel?: "web" | "x" | "xiaohongshu";
  dependsOn?: string[];
  priority?: number;
  evidenceNeeded?: number;
  canParallelize?: boolean;
  reasonCode?: string;
  status: "todo" | "in_progress" | "done" | "blocked" | "skipped";
  notes?: string;
};

export type RunTiming = {
  startedAt: string;
  completedAt?: string;
};

export type AgentThreadState = {
  projectId: string | null;
  threadId: string;
  activeRunId: string | null;
  runStatus: RunStatus;
  runStartedAt: string | null;
  items: Record<string, TimelineItem>;
  itemOrder: string[];
  artifacts: Artifact[];
  files: WorkbenchFile[];
  logs: LogEntry[];
  plan: PlanStep[];
  planId: string | null;
  planRevision: number;
  planUpdatedAt: string | null;
  runTimings: Record<string, RunTiming>;
  runStatuses: Record<string, RunStatus>;
  lastSeq: number;
};

export type ProjectSummary = {
  id: string;
  name: string;
  path: string;
  status: "idle" | "running" | "waiting" | "failed";
  context?: ProjectContext;
};

export type ProjectContext = {
  shortTermVersion?: string;
  longTermMemoryVersion?: string;
  checkpointId?: string;
};

export type ThreadSummary = {
  id: string;
  projectId: string | null;
  title: string;
  updatedAt: string;
  lastUserMessageAt?: string;
  status: "idle" | "running" | "waiting" | "failed";
};

export type ThreadSnapshot = {
  project: ProjectSummary | null;
  thread: ThreadSummary;
  state: AgentThreadState;
  context?: ProjectContext;
};

export type AgentDefinition = { id: string; name: string; description: string; toolIds: string[] };
export type ReasoningEffort = "medium" | "high" | "xhigh" | "max";
export type ModelDefinition = {
  id: string;
  name: string;
  description: string;
  reasoningEfforts: ReasoningEffort[];
  defaultReasoningEffort: ReasoningEffort;
};
export type ToolDefinition = { id: string; name: string; description: string; group: string; requiresApproval: boolean };
