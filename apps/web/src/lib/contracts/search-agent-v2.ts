import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import Ajv2020, { type AnySchema, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export const CONTRACT_SCHEMA_BASE = "https://schemas.agent-workbench.invalid/contracts/v2/schemas/";

export const contractErrorCodes = [
  "SCHEMA_INVALID",
  "PRIVATE_REASONING_FORBIDDEN",
  "PUBLIC_TEXT_INVALID",
  "SCOPE_MISMATCH",
  "PLAN_STEP_DUPLICATE",
  "PLAN_DEPENDENCY_MISSING",
  "PLAN_CYCLE",
  "TOOL_CALL_DUPLICATE",
  "TOOL_CALL_DANGLING",
  "TOOL_SCHEMA_INVALID",
  "TOOL_POLICY_INVALID",
  "TOOL_ERROR_INVALID",
  "TOOL_ARGUMENTS_INVALID",
  "TOOL_UNKNOWN_RETRY_FORBIDDEN",
  "EVIDENCE_REFERENCE_INVALID",
  "CITATION_UNVERIFIED",
  "CITATION_PROJECTION_MISMATCH",
  "LOCATOR_INVALID",
  "UNSUPPORTED_CLAIM",
  "USAGE_INVALID",
  "BUDGET_INVALID",
  "BUDGET_STOP_MISMATCH",
  "CONTEXT_USAGE_INVALID",
  "EVENT_SEQ_INVALID",
  "EVENT_STATE_INVALID",
  "DUPLICATE_TERMINAL",
  "EVENT_AFTER_TERMINAL",
  "MEMORY_WRITE_INVALID",
  "COMMAND_REVISION_CONFLICT",
  "COMMAND_AFTER_TERMINAL",
  "COMMAND_SCOPE_MISMATCH",
  "QUEUE_REVISION_CONFLICT",
  "QUEUE_ORDER_INVALID",
  "QUEUE_ACTIVE_RUN_CONFLICT",
  "QUEUE_PAUSE_INVALID",
  "STATE_TRANSITION_INVALID",
  "STATE_FENCE_INVALID"
] as const;

export type ContractErrorCode = (typeof contractErrorCodes)[number];

export type ContractManifestEntry = {
  id: string;
  schemaId: string;
  path: string;
  expectedValid: boolean;
  expectedErrorCode: ContractErrorCode | null;
  coveredInvariant: string;
};

export type ContractManifest = {
  schemaVersion: "2.0";
  errorCodes: ContractErrorCode[];
  entries: ContractManifestEntry[];
};

export type ContractValidationResult =
  | { valid: true; errorCode: null }
  | { valid: false; errorCode: ContractErrorCode };

type JsonObject = Record<string, unknown>;

const forbiddenPrivateKeys = new Set(["reasoningcontent", "chainofthought", "rawreasoning", "rawcot"]);
const terminalEventTypes = new Set(["run.completed", "run.cancelled", "run.failed"]);
const publicTextEventTypes = new Set([
  "run.status",
  "node.started",
  "node.completed",
  "node.failed",
  "plan.updated",
  "tool.started",
  "tool.updated",
  "tool.completed",
  "tool.failed",
  "tool.unknown",
  "approval.required",
  "approval.decided",
  "clarification.required",
  "clarification.resumed",
  "context.usage.updated",
  "budget.updated",
  "verification.completed"
]);
const nullPublicTextEventTypes = new Set([
  "node.started",
  "tool.started",
  "tool.updated",
  "tool.completed",
  "tool.failed",
  "tool.unknown",
  "approval.required",
  "approval.decided",
  "clarification.required",
  "clarification.resumed",
  "context.usage.updated",
  "budget.updated"
]);

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objects(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((entry, index) => sameJson(entry, right[index]));
  }
  if (!isObject(left) || !isObject(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return sameJson(leftKeys, rightKeys) && leftKeys.every((key) => sameJson(left[key], right[key]));
}

function normalizedPrivateKey(key: string) {
  return key.replaceAll("_", "").replaceAll("-", "").toLowerCase();
}

export function containsPrivateReasoning(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsPrivateReasoning);
  if (!isObject(value)) return false;
  return Object.entries(value).some(([key, nested]) => forbiddenPrivateKeys.has(normalizedPrivateKey(key)) || containsPrivateReasoning(nested));
}

function isPublicParagraph(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 500
    && !/[\r\n]/u.test(value)
    && !value.includes("```")
    && !/^\s*(?:#{1,6}\s|[-*+]\s|[0-9]+[.)]\s)/u.test(value);
}

function validateEventPublicText(event: unknown): ContractErrorCode | null {
  if (!isObject(event) || !publicTextEventTypes.has(text(event.type) ?? "") || !isObject(event.payload)) return null;
  const type = text(event.type) ?? "";
  const payload = event.payload;
  const publicText = payload.publicText;
  if (nullPublicTextEventTypes.has(type)) return publicText === null ? null : "PUBLIC_TEXT_INVALID";
  if (type === "node.completed") {
    return payload.executionKind === "model"
      ? (isPublicParagraph(publicText) ? null : "PUBLIC_TEXT_INVALID")
      : (publicText === null ? null : "PUBLIC_TEXT_INVALID");
  }
  return publicText === null || isPublicParagraph(publicText) ? null : "PUBLIC_TEXT_INVALID";
}

function validatePublicText(document: unknown): ContractErrorCode | null {
  if (isObject(document) && Array.isArray(document.events)) {
    for (const event of document.events) {
      const error = validateEventPublicText(event);
      if (error) return error;
    }
    return null;
  }
  return validateEventPublicText(document);
}

function validateAgentStateSemantics(document: unknown): ContractErrorCode | null {
  const states = isObject(document) && Array.isArray(document.agentStates)
    ? objects(document.agentStates)
    : isObject(document) && isObject(document.agentState)
      ? [document.agentState]
      : isObject(document) && typeof document.stateId === "string"
        ? [document]
        : [];
  for (const state of states) {
    const currentNode = text(state.currentNode);
    const clarificationRef = text(state.pendingClarificationRef);
    const approvalRef = text(state.pendingApprovalRef);
    if (clarificationRef && approvalRef) return "STATE_TRANSITION_INVALID";
    if (currentNode === "interrupt_for_clarification") {
      if (!clarificationRef || state.pendingApprovalRef !== null) return "STATE_TRANSITION_INVALID";
    } else if (currentNode === "interrupt_for_approval") {
      if (!approvalRef || state.pendingClarificationRef !== null) return "STATE_TRANSITION_INVALID";
    } else if (state.pendingClarificationRef !== null || state.pendingApprovalRef !== null) {
      return "STATE_TRANSITION_INVALID";
    }
    if (currentNode === "terminal") {
      if (
        state.nextNode !== null
        || state.pendingClarificationRef !== null
        || state.pendingApprovalRef !== null
        || !["completed", "cancelled", "failed"].includes(text(state.terminalStatus) ?? "")
        || !text(state.stopReason)
      ) return "STATE_TRANSITION_INVALID";
      if (state.terminalStatus === "completed" && state.cancelRequested !== false) return "STATE_TRANSITION_INVALID";
      if (state.terminalStatus === "cancelled" && state.cancelRequested !== true) return "STATE_TRANSITION_INVALID";
    } else if (state.terminalStatus !== null || state.stopReason !== null) {
      return "STATE_TRANSITION_INVALID";
    }
  }
  return null;
}

function sameScope(left: unknown, right: unknown) {
  if (!isObject(left) || !isObject(right)) return false;
  return ["tenantId", "actorId", "visitorId", "projectId", "threadId"].every((key) => left[key] === right[key]);
}

function nestedScopes(value: unknown, found: unknown[] = []): unknown[] {
  if (Array.isArray(value)) {
    value.forEach((entry) => nestedScopes(entry, found));
    return found;
  }
  if (!isObject(value)) return found;
  for (const [key, nested] of Object.entries(value)) {
    if (key === "scope") found.push(nested);
    else nestedScopes(nested, found);
  }
  return found;
}

function validatePlan(bundle: JsonObject): ContractErrorCode | null {
  const plan = isObject(bundle.plan) ? bundle.plan : null;
  if (!plan) return null;
  const steps = objects(plan.steps);
  const ids = steps.map((step) => text(step.id)).filter((id): id is string => Boolean(id));
  if (new Set(ids).size !== ids.length) return "PLAN_STEP_DUPLICATE";
  const known = new Set(ids);
  const dependencies = new Map<string, string[]>();
  for (const step of steps) {
    const id = text(step.id);
    if (!id) continue;
    const dependsOn = Array.isArray(step.dependsOn) ? step.dependsOn.filter((item): item is string => typeof item === "string") : [];
    if (dependsOn.some((dependency) => !known.has(dependency))) return "PLAN_DEPENDENCY_MISSING";
    dependencies.set(id, dependsOn);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const hasCycle = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    if ((dependencies.get(id) ?? []).some(hasCycle)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return ids.some(hasCycle) ? "PLAN_CYCLE" : null;
}

function isStrictObjectSchema(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(isStrictObjectSchema);
  if (!isObject(value)) return true;
  if (value.type === "object" && value.additionalProperties !== false) return false;
  return Object.values(value).every(isStrictObjectSchema);
}

function validateToolErrors(value: unknown): ContractErrorCode | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const error = validateToolErrors(item);
      if (error) return error;
    }
    return null;
  }
  if (!isObject(value)) return null;
  if (["category", "retryable", "nextAction", "fieldPath", "expected", "retryAfterMs"].every((key) => key in value)) {
    const fieldPath = text(value.fieldPath);
    const expected = text(value.expected);
    const retryAfterMs = integer(value.retryAfterMs);
    if (value.category === "invalid_arguments" && (!fieldPath || !expected || value.retryable !== false || value.nextAction !== "repair_arguments")) return "TOOL_ERROR_INVALID";
    if (value.category === "rate_limited" && (retryAfterMs === null || value.retryable !== true || value.nextAction !== "retry_wait")) return "TOOL_ERROR_INVALID";
    if (value.category === "outcome_unknown" && (value.retryable !== false || value.nextAction !== "check_operation")) return "TOOL_ERROR_INVALID";
    if (value.category === "permission_denied" && (value.retryable !== false || !["request_approval", "stop"].includes(text(value.nextAction) ?? ""))) return "TOOL_ERROR_INVALID";
    if (value.category === "auth_required" && (value.retryable !== false || value.nextAction !== "connect_account")) return "TOOL_ERROR_INVALID";
  }
  for (const nested of Object.values(value)) {
    const error = validateToolErrors(nested);
    if (error) return error;
  }
  return null;
}

function validateTools(bundle: JsonObject, ajv: Ajv2020): ContractErrorCode | null {
  const specs = objects(bundle.toolSpecs);
  const calls = objects(bundle.toolCalls);
  const results = objects(bundle.toolResults);
  const callIds = calls.map((call) => text(call.toolCallId)).filter((id): id is string => Boolean(id));
  if (new Set(callIds).size !== callIds.length) return "TOOL_CALL_DUPLICATE";
  const resultIds = results.map((result) => text(result.toolCallId)).filter((id): id is string => Boolean(id));
  if (new Set(resultIds).size !== resultIds.length) return "TOOL_CALL_DUPLICATE";
  if (callIds.length !== resultIds.length || callIds.some((id) => !resultIds.includes(id))) return "TOOL_CALL_DANGLING";

  const specsById = new Map(specs.map((spec) => [text(spec.toolId), spec]));
  const resultsByCall = new Map(results.map((result) => [text(result.toolCallId), result]));
  const toolError = validateToolErrors(results);
  if (toolError) return toolError;
  for (const spec of specs) {
    if (!isObject(spec.parametersSchema) || !isObject(spec.resultSchema)) return "TOOL_SCHEMA_INVALID";
    if (!isStrictObjectSchema(spec.parametersSchema) || !isStrictObjectSchema(spec.resultSchema)) return "TOOL_SCHEMA_INVALID";
    if (spec.effect === "read" ? spec.reversibility !== "read_only" : spec.reversibility === "read_only") return "TOOL_POLICY_INVALID";
    if (spec.reversibility === "irreversible" && spec.approval === "never") return "TOOL_POLICY_INVALID";
    try {
      ajv.compile(spec.parametersSchema as AnySchema);
      ajv.compile(spec.resultSchema as AnySchema);
    } catch {
      return "TOOL_SCHEMA_INVALID";
    }
  }

  const callsByOperation = new Map<string, JsonObject[]>();
  for (const call of calls) {
    const operationRef = text(call.operationRef);
    if (!operationRef) return "TOOL_CALL_DANGLING";
    callsByOperation.set(operationRef, [...(callsByOperation.get(operationRef) ?? []), call]);
  }
  for (const operationCalls of callsByOperation.values()) {
    if (operationCalls.length < 2) continue;
    const hasUnknown = operationCalls.some((call) => resultsByCall.get(text(call.toolCallId))?.status === "unknown");
    const spec = specsById.get(text(operationCalls[0].toolId));
    if (hasUnknown && spec?.effect !== "read" && spec?.idempotency === "none") return "TOOL_UNKNOWN_RETRY_FORBIDDEN";
    return "TOOL_CALL_DUPLICATE";
  }

  for (const call of calls) {
    const toolId = text(call.toolId);
    const callId = text(call.toolCallId);
    const spec = specsById.get(toolId);
    const result = resultsByCall.get(callId);
    if (!spec || !result || result.toolId !== toolId || result.operationRef !== call.operationRef) return "TOOL_CALL_DANGLING";
    try {
      const validateArguments = ajv.compile(spec.parametersSchema as AnySchema);
      if (!validateArguments(call.arguments)) return "TOOL_ARGUMENTS_INVALID";
    } catch {
      return "TOOL_ARGUMENTS_INVALID";
    }
    const usage = isObject(result.usage) ? result.usage : null;
    if (!usage || usage.toolId !== toolId) return "USAGE_INVALID";
    if (result.status === "unknown") {
      const error = isObject(result.error) ? result.error : null;
      if (
        !error
        || error.category !== "outcome_unknown"
        || error.retryable !== false
        || error.nextAction !== "check_operation"
        || result.outputRef !== null
        || usage.actualCostUsd !== null
        || (usdMicros(usage.possibleDuplicateCostUsd) ?? 0n) <= 0n
      ) return "USAGE_INVALID";
    }
  }
  return null;
}

function validateEvidence(bundle: JsonObject): ContractErrorCode | null {
  const sources = objects(bundle.sources);
  const snapshots = objects(bundle.snapshots);
  const evidence = objects(bundle.evidence);
  const response = isObject(bundle.response) ? bundle.response : null;
  const claims = response ? objects(response.claims) : objects(bundle.claims);
  const citations = response ? objects(response.citations) : objects(bundle.citations);
  const sourceIds = sources.map((item) => text(item.sourceId));
  const snapshotIds = snapshots.map((item) => text(item.snapshotId));
  const evidenceIds = evidence.map((item) => text(item.evidenceId));
  const claimIds = claims.map((item) => text(item.id));
  const citationIds = citations.map((item) => text(item.citationId));
  if (
    new Set(sourceIds).size !== sourceIds.length
    || new Set(snapshotIds).size !== snapshotIds.length
    || new Set(evidenceIds).size !== evidenceIds.length
    || new Set(claimIds).size !== claimIds.length
    || new Set(citationIds).size !== citationIds.length
  ) return "EVIDENCE_REFERENCE_INVALID";
  const sourceById = new Map(sources.map((item) => [text(item.sourceId), item]));
  const snapshotById = new Map(snapshots.map((item) => [text(item.snapshotId), item]));
  const evidenceById = new Map(evidence.map((item) => [text(item.evidenceId), item]));
  const claimById = new Map(claims.map((item) => [text(item.id), item]));
  const citationById = new Map(citations.map((item) => [text(item.citationId), item]));

  for (const snapshot of snapshots) {
    if (!sourceById.has(text(snapshot.sourceId))) return "EVIDENCE_REFERENCE_INVALID";
  }
  for (const passage of evidence) {
    const snapshot = snapshotById.get(text(passage.snapshotId));
    if (!sourceById.has(text(passage.sourceId)) || !snapshot || snapshot.sourceId !== passage.sourceId) return "EVIDENCE_REFERENCE_INVALID";
    const locator = isObject(passage.locator) ? passage.locator : null;
    if (locator?.kind === "code_line" && (integer(locator.startLine) ?? 0) > (integer(locator.endLine) ?? 0)) return "LOCATOR_INVALID";
    if (locator?.kind === "media_timecode" && locator.endMs !== null && (integer(locator.startMs) ?? 0) > (integer(locator.endMs) ?? 0)) return "LOCATOR_INVALID";
    if (locator?.kind === "text_quote" && locator.exactQuote !== passage.quote) return "LOCATOR_INVALID";
  }
  for (const claim of claims) {
    const ids = Array.isArray(claim.evidenceIds) ? claim.evidenceIds : [];
    if (ids.some((id) => !evidenceById.has(text(id)))) return "EVIDENCE_REFERENCE_INVALID";
  }
  for (const citation of citations) {
    const passage = evidenceById.get(text(citation.evidenceId));
    const claim = claimById.get(text(citation.claimId));
    if (!passage || !claim) return "EVIDENCE_REFERENCE_INVALID";
    if (citation.locatorVerified !== true || passage.verified !== true) return "CITATION_UNVERIFIED";
    const source = sourceById.get(text(passage.sourceId));
    if (!source) return "EVIDENCE_REFERENCE_INVALID";
    if (
      citation.title !== source.title
      || citation.canonicalUrl !== source.canonicalUrl
      || !sameJson(citation.artifactRef, source.artifactRef)
      || citation.publishedAt !== source.publishedAt
      || citation.retrievedAt !== source.retrievedAt
      || citation.sourceType !== source.sourceType
      || !sameJson(citation.locator, passage.locator)
    ) return "CITATION_PROJECTION_MISMATCH";
    if ((source.sourceType === "private" || source.sourceType === "user_attachment") && citation.canonicalUrl !== null) {
      return "CITATION_PROJECTION_MISMATCH";
    }
  }
  for (const claim of claims) {
    const claimEvidence = Array.isArray(claim.evidenceIds) ? claim.evidenceIds : [];
    const claimCitations = Array.isArray(claim.citationIds) ? claim.citationIds : [];
    if (claimCitations.some((id) => !citationById.has(text(id)))) return "EVIDENCE_REFERENCE_INVALID";
    if (claimCitations.some((id) => !claimEvidence.includes(citationById.get(text(id))?.evidenceId))) return "EVIDENCE_REFERENCE_INVALID";
    if (claimCitations.some((id) => citationById.get(text(id))?.claimId !== claim.id)) return "EVIDENCE_REFERENCE_INVALID";
  }
  if (!response) return null;
  if (
    response.status === "completed"
    && claims.some((claim) => claim.status !== "supported" || (claim.importance !== "context" && (!Array.isArray(claim.citationIds) || claim.citationIds.length === 0)))
  ) return "UNSUPPORTED_CLAIM";
  return null;
}

function usdMicros(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

function validateUsage(value: unknown): ContractErrorCode | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const result = validateUsage(entry);
      if (result) return result;
    }
    return null;
  }
  if (!isObject(value)) return null;
  if (["model", "inputTokens", "outputTokens", "totalTokens", "reasoningTokens", "cacheHitInputTokens", "cacheMissInputTokens"].every((key) => key in value)) {
    const number = (key: string) => integer(value[key]) ?? -1;
    if (number("totalTokens") !== number("inputTokens") + number("outputTokens")) return "USAGE_INVALID";
    if (number("reasoningTokens") > number("outputTokens")) return "USAGE_INVALID";
    if (number("cacheHitInputTokens") + number("cacheMissInputTokens") > number("inputTokens")) return "USAGE_INVALID";
  }
  if (["toolId", "calls", "attempts", "units", "bytes", "resultCount"].every((key) => key in value)) {
    if ((integer(value.attempts) ?? -1) < (integer(value.calls) ?? -1)) return "USAGE_INVALID";
  }
  if (["attemptId", "status", "possibleDuplicateCostUsd"].every((key) => key in value)) {
    const duplicateCost = usdMicros(value.possibleDuplicateCostUsd);
    if (value.status === "unknown" && (duplicateCost === null || duplicateCost <= 0n)) return "USAGE_INVALID";
  }
  if (Array.isArray(value.modelBreakdown) && Array.isArray(value.toolBreakdown) && isObject(value.totals)) {
    const models = objects(value.modelBreakdown);
    const tools = objects(value.toolBreakdown);
    const totals = value.totals;
    const sumNumber = (items: JsonObject[], key: string) => items.reduce((sum, item) => sum + (integer(item[key]) ?? 0), 0);
    if (integer(totals.modelCalls) !== sumNumber(models, "calls")) return "USAGE_INVALID";
    if (integer(totals.toolCalls) !== sumNumber(tools, "calls")) return "USAGE_INVALID";
    if (integer(totals.searchQueries) !== sumNumber(tools, "searchQueries")) return "USAGE_INVALID";
    if (integer(totals.pageReads) !== sumNumber(tools, "pageReads")) return "USAGE_INVALID";
    for (const key of ["inputTokens", "outputTokens", "totalTokens", "reasoningTokens"]) {
      if (integer(totals[key]) !== sumNumber(models, key)) return "USAGE_INVALID";
    }
    const estimated = [...models, ...tools].reduce((sum, item) => sum + (usdMicros(item.estimatedCostUsd) ?? 0n), 0n);
    if (usdMicros(totals.estimatedCostUsd) !== estimated) return "USAGE_INVALID";
    const actualValues = [...models, ...tools].map((item) => item.actualCostUsd);
    if (actualValues.some((item) => item === null)) {
      if (totals.actualCostUsd !== null) return "USAGE_INVALID";
    } else {
      const actual = actualValues.reduce<bigint>((sum, item) => sum + (usdMicros(item) ?? 0n), 0n);
      if (usdMicros(totals.actualCostUsd) !== actual) return "USAGE_INVALID";
    }
    const duplicate = [...models, ...tools].reduce((sum, item) => sum + (usdMicros(item.possibleDuplicateCostUsd) ?? 0n), 0n);
    if (usdMicros(totals.possibleDuplicateCostUsd) !== duplicate) return "USAGE_INVALID";
    const modelKeys = models.map((item) => `${text(item.provider)}:${text(item.model)}:${text(item.pricingVersion)}`);
    const toolKeys = tools.map((item) => `${text(item.toolId)}:${text(item.toolVersion)}:${text(item.provider)}:${text(item.pricingVersion)}`);
    if (new Set(modelKeys).size !== modelKeys.length || new Set(toolKeys).size !== toolKeys.length) return "USAGE_INVALID";
  }
  for (const nested of Object.values(value)) {
    const result = validateUsage(nested);
    if (result) return result;
  }
  return null;
}

function validateBudgets(value: unknown): ContractErrorCode | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const result = validateBudgets(entry);
      if (result) return result;
    }
    return null;
  }
  if (!isObject(value)) return null;
  if (["max", "used", "reserved", "remaining"].every((key) => key in value)) {
    if (typeof value.max === "string") {
      const maximum = usdMicros(value.max);
      const used = usdMicros(value.used);
      const reserved = usdMicros(value.reserved);
      const remaining = usdMicros(value.remaining);
      if (maximum === null || used === null || reserved === null || remaining === null || used + reserved + remaining !== maximum) return "BUDGET_INVALID";
    } else {
      const maximum = integer(value.max);
      const used = integer(value.used);
      const reserved = integer(value.reserved);
      const remaining = integer(value.remaining);
      if (maximum === null || used === null || reserved === null || remaining === null || used + reserved + remaining !== maximum) return "BUDGET_INVALID";
    }
  }
  if (isObject(value.usage) && isObject(value.budget) && isObject(value.usage.totals)) {
    const totals = value.usage.totals;
    const budget = value.budget;
    const numericMappings: Array<[string, string]> = [
      ["modelCalls", "modelCalls"],
      ["inputTokens", "inputTokens"],
      ["outputTokens", "outputTokens"],
      ["toolCalls", "toolCalls"],
      ["searchQueries", "searchQueries"],
      ["pageReads", "pageReads"],
      ["peakParallelTools", "parallelTools"],
      ["elapsedMs", "wallTimeMs"]
    ];
    for (const [usageKey, budgetKey] of numericMappings) {
      const counter = isObject(budget[budgetKey]) ? budget[budgetKey] : null;
      if (!counter || integer(counter.used) !== integer(totals[usageKey])) return "BUDGET_INVALID";
    }
    const cost = isObject(budget.costUsd) ? budget.costUsd : null;
    const usedCost = totals.actualCostUsd ?? totals.estimatedCostUsd;
    if (!cost || usdMicros(cost.used) !== usdMicros(usedCost)) return "BUDGET_INVALID";
  }
  for (const nested of Object.values(value)) {
    const result = validateBudgets(nested);
    if (result) return result;
  }
  return null;
}

function hasExhaustedBudget(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasExhaustedBudget);
  if (!isObject(value)) return false;
  if (value.exhausted === true && "modelCalls" in value && "costUsd" in value) return true;
  return Object.values(value).some(hasExhaustedBudget);
}

function validateBudgetStop(bundle: JsonObject): ContractErrorCode | null {
  if (!hasExhaustedBudget(bundle)) return null;
  const response = isObject(bundle.response) ? bundle.response : null;
  const terminalBudgetEvent = objects(bundle.events).some((event) => {
    if (!terminalEventTypes.has(text(event.type) ?? "") || !isObject(event.payload)) return false;
    return event.payload.stopReason === "budget_exhausted";
  });
  return response?.stopReason === "budget_exhausted" || terminalBudgetEvent ? null : "BUDGET_STOP_MISMATCH";
}

function validateEvents(bundle: JsonObject): ContractErrorCode | null {
  const events = objects(bundle.events);
  const eventKinds: Record<string, string> = {
    "run.created": "run", "run.status": "run", "run.completed": "run", "run.cancelled": "run", "run.failed": "run",
    "node.started": "node", "node.completed": "node", "node.failed": "node", "plan.updated": "plan",
    "tool.started": "tool", "tool.updated": "tool", "tool.completed": "tool", "tool.failed": "tool", "tool.unknown": "tool",
    "approval.required": "approval", "approval.decided": "approval",
    "clarification.required": "clarification", "clarification.resumed": "clarification", "artifact.created": "artifact",
    "context.usage.updated": "context", "budget.updated": "budget",
    "citation.created": "citation", "verification.completed": "verification", "memory.updated": "memory",
    "message.started": "message", "message.completed": "message", "guidance.accepted": "guidance",
    "guidance.applied": "guidance", "guidance.superseded": "guidance", "guidance.rejected": "guidance",
    "guidance.failed": "guidance"
  };
  let previousSeq = 0;
  let terminalSeen = false;
  let previousContextRevision = -1;
  let previousContextWasEstimate: boolean | null = null;
  let previousBudgetRevision = -1;
  let exhaustedBudgetSeq: number | null = null;
  for (const event of events) {
    const seq = integer(event.seq) ?? -1;
    if (seq <= previousSeq) return "EVENT_SEQ_INVALID";
    previousSeq = seq;
    const type = text(event.type);
    if (!type || eventKinds[type] !== event.kind) return "EVENT_STATE_INVALID";
    if (terminalSeen) return terminalEventTypes.has(type ?? "") ? "DUPLICATE_TERMINAL" : "EVENT_AFTER_TERMINAL";
    if (type && terminalEventTypes.has(type)) terminalSeen = true;

    const payload = isObject(event.payload) ? event.payload : {};
    if (exhaustedBudgetSeq !== null && seq > exhaustedBudgetSeq && !terminalEventTypes.has(type ?? "")) return "BUDGET_STOP_MISMATCH";
    if (type === "context.usage.updated") {
      const sections = isObject(payload.sections) ? payload.sections : null;
      const names = ["system", "history", "projectMemory", "retrieval", "toolResults", "attachments", "userInput"];
      const values = sections ? names.map((name) => isObject(sections[name]) ? sections[name] as JsonObject : null) : [];
      if (!sections || values.some((value) => value === null)) return "CONTEXT_USAGE_INVALID";
      let retainedTotal = 0;
      for (const section of values as JsonObject[]) {
        const original = integer(section.originalTokens) ?? -1;
        const retained = integer(section.retainedTokens) ?? -1;
        if (
          retained > original
          || (section.status === "retained" && retained !== original)
          || (section.status === "truncated" && retained >= original)
          || (section.status === "omitted" && retained !== 0)
        ) return "CONTEXT_USAGE_INVALID";
        retainedTotal += retained;
      }
      const estimated = integer(payload.estimatedInputTokens) ?? -1;
      const actual = payload.actualInputTokens === null ? null : integer(payload.actualInputTokens);
      const limit = integer(payload.modelLimitTokens) ?? -1;
      const reserved = integer(payload.reservedOutputTokens) ?? -1;
      const margin = integer(payload.safetyMarginTokens) ?? -1;
      const used = actual ?? estimated;
      const occupied = used + reserved + margin;
      const revision = integer(payload.contextRevision) ?? -1;
      if (
        retainedTotal !== estimated
        || (payload.isEstimate === true) !== (actual === null)
        || occupied > limit
        || integer(payload.remainingTokens) !== limit - occupied
        || integer(payload.utilizationBasisPoints) !== Math.floor((occupied * 10000) / limit)
        || revision < previousContextRevision
        || (revision === previousContextRevision && previousContextWasEstimate !== true)
        || (revision === previousContextRevision && payload.isEstimate !== false)
      ) return "CONTEXT_USAGE_INVALID";
      previousContextRevision = revision;
      previousContextWasEstimate = payload.isEstimate === true;
    }
    if (type === "budget.updated") {
      const budgetRevision = integer(payload.budgetRevision) ?? -1;
      const usage = isObject(payload.usage) ? payload.usage : null;
      const totals = usage && isObject(usage.totals) ? usage.totals : null;
      const budget = isObject(payload.budget) ? payload.budget : null;
      if (
        budgetRevision <= previousBudgetRevision
        || !totals
        || !budget
        || payload.possibleDuplicateCostUsd !== totals.possibleDuplicateCostUsd
        || payload.exhausted !== budget.exhausted
      ) return "BUDGET_INVALID";
      previousBudgetRevision = budgetRevision;
      if (payload.exhausted === true) exhaustedBudgetSeq = seq;
    }
    const display = isObject(payload.display) ? payload.display : null;
    if (display && type === "tool.started") {
      if (
        display.resultSummary !== null
        || display.errorMessage !== null
        || display.resultCount !== null
        || display.resultType !== null
        || display.durationMs !== null
        || display.costUsd !== null
        || display.errorCode !== null
      ) return "EVENT_STATE_INVALID";
    }
    if (display && type === "tool.completed") {
      const usage = isObject(payload.usage) ? payload.usage : null;
      const expectedCost = usage?.actualCostUsd ?? usage?.estimatedCostUsd;
      if (
        display.resultCount !== payload.resultCount
        || display.durationMs !== payload.durationMs
        || display.costUsd !== expectedCost
        || display.errorCode !== null
        || display.errorMessage !== null
      ) return "EVENT_STATE_INVALID";
    }
    if (display && type === "tool.failed") {
      const usage = isObject(payload.usage) ? payload.usage : null;
      const expectedCost = usage?.actualCostUsd ?? usage?.estimatedCostUsd;
      if (
        display.errorCode !== payload.errorCode
        || display.resultSummary !== null
        || display.durationMs !== payload.durationMs
        || display.costUsd !== expectedCost
      ) return "EVENT_STATE_INVALID";
    }
    if (display && type === "tool.unknown") {
      const usage = isObject(payload.usage) ? payload.usage : null;
      if (
        !usage
        || display.attemptStatus !== "unknown"
        || display.errorCode !== payload.errorCode
        || display.resultSummary !== null
        || display.durationMs !== payload.durationMs
        || display.costUsd !== usage.estimatedCostUsd
        || usage.actualCostUsd !== null
        || (usdMicros(usage.possibleDuplicateCostUsd) ?? 0n) <= 0n
        || payload.nextAction !== "check_operation"
      ) return "EVENT_STATE_INVALID";
    }

    const expectedStatus: Partial<Record<string, string>> = {
      "run.completed": "completed",
      "run.cancelled": "cancelled",
      "run.failed": "failed",
      "node.completed": "completed",
      "node.failed": "failed",
      "node.started": "running",
      "tool.completed": "completed",
      "tool.failed": "failed",
      "tool.unknown": "unknown",
      "guidance.accepted": "pending",
      "guidance.applied": "completed",
      "guidance.superseded": "superseded",
      "guidance.rejected": "rejected",
      "guidance.failed": "failed",
      "clarification.required": "waiting_clarification",
      "clarification.resumed": "completed"
    };
    if (type && expectedStatus[type] && event.status !== expectedStatus[type]) return "EVENT_STATE_INVALID";
    if (type && terminalEventTypes.has(type) && isObject(payload.budget)) {
      for (const counter of Object.values(payload.budget)) {
        if (isObject(counter) && "reserved" in counter && counter.reserved !== 0 && counter.reserved !== "0") return "BUDGET_INVALID";
      }
    }
  }

  const toolStarts = events.filter((event) => event.type === "tool.started").map((event) => text(isObject(event.payload) ? event.payload.toolCallId : null));
  const toolEnds = events.filter((event) => event.type === "tool.completed" || event.type === "tool.failed" || event.type === "tool.unknown").map((event) => text(isObject(event.payload) ? event.payload.toolCallId : null));
  if (new Set(toolStarts).size !== toolStarts.length || new Set(toolEnds).size !== toolEnds.length) return "TOOL_CALL_DUPLICATE";
  if (toolStarts.length !== toolEnds.length || toolStarts.some((id) => !toolEnds.includes(id))) return "TOOL_CALL_DANGLING";
  const nodeStarts = events.filter((event) => event.type === "node.started" && isObject(event.payload));
  const nodeEnds = events.filter((event) => (event.type === "node.completed" || event.type === "node.failed") && isObject(event.payload));
  const startedNodeIds = nodeStarts.map((event) => text((event.payload as JsonObject).nodeExecutionId));
  const endedNodeIds = nodeEnds.map((event) => text((event.payload as JsonObject).nodeExecutionId));
  if (new Set(startedNodeIds).size !== startedNodeIds.length || new Set(endedNodeIds).size !== endedNodeIds.length) return "EVENT_STATE_INVALID";
  for (const ended of nodeEnds) {
    const payload = ended.payload as JsonObject;
    const executionId = text(payload.nodeExecutionId);
    const started = nodeStarts.find((event) => isObject(event.payload) && event.payload.nodeExecutionId === executionId);
    const startedPayload = started && isObject(started.payload) ? started.payload : null;
    if (
      !started
      || (integer(started.seq) ?? -1) >= (integer(ended.seq) ?? -1)
      || !startedPayload
      || started.runId !== ended.runId
      || started.inputRevision !== ended.inputRevision
      || ["node", "executionKind", "ordinal", "attemptNumber"].some((key) => startedPayload[key] !== payload[key])
    ) return "EVENT_STATE_INVALID";
  }
  const clarificationRequired = events
    .filter((event) => event.type === "clarification.required" && isObject(event.payload))
    .map((event) => text((event.payload as JsonObject).clarificationId));
  const clarificationResumed = events
    .filter((event) => event.type === "clarification.resumed" && isObject(event.payload))
    .map((event) => text((event.payload as JsonObject).clarificationId));
  if (
    new Set(clarificationRequired).size !== clarificationRequired.length
    || new Set(clarificationResumed).size !== clarificationResumed.length
    || clarificationResumed.some((id) => !clarificationRequired.includes(id))
  ) return "EVENT_STATE_INVALID";

  const messageStarts = events.filter((event) => event.type === "message.started" && isObject(event.payload));
  const messageCompletes = events.filter((event) => event.type === "message.completed" && isObject(event.payload));
  const startedMessageIds = messageStarts.map((event) => text((event.payload as JsonObject).messageId));
  const completedMessageIds = messageCompletes.map((event) => text((event.payload as JsonObject).messageId));
  if (new Set(startedMessageIds).size !== startedMessageIds.length || new Set(completedMessageIds).size !== completedMessageIds.length) return "EVENT_STATE_INVALID";
  for (const completed of messageCompletes) {
    const payload = completed.payload as JsonObject;
    const messageId = text(payload.messageId);
    const started = messageStarts.find((event) => isObject(event.payload) && event.payload.messageId === messageId);
    if (
      !started
      || (integer(started.seq) ?? -1) >= (integer(completed.seq) ?? -1)
      || !isObject(started.payload)
      || started.payload.role !== payload.role
      || started.inputRevision !== completed.inputRevision
      || !isObject(completed.refs)
      || completed.refs.messageId !== messageId
      || (payload.role === "assistant" && completed.refs.responseId !== payload.responseId)
    ) return "EVENT_STATE_INVALID";
  }

  const response = isObject(bundle.response) ? bundle.response : null;
  const terminalEvent = events.find((event) => terminalEventTypes.has(text(event.type) ?? ""));
  if (terminalEvent && startedNodeIds.some((id) => !endedNodeIds.includes(id))) return "EVENT_STATE_INVALID";
  if (terminalEvent && isObject(terminalEvent.payload) && terminalEvent.type === "run.completed") {
    const terminalRevision = integer(terminalEvent.inputRevision) ?? -1;
    const verifications = events.filter((event) => event.type === "verification.completed" && event.inputRevision === terminalRevision && isObject(event.payload));
    const verification = verifications.at(-1);
    const assistantMessage = [...messageCompletes].reverse().find((event) => event.inputRevision === terminalRevision && isObject(event.payload) && event.payload.role === "assistant");
    if (
      !response
      || !verification
      || !assistantMessage
      || (integer(verification.seq) ?? -1) >= (integer(assistantMessage.seq) ?? -1)
      || (integer(assistantMessage.seq) ?? -1) >= (integer(terminalEvent.seq) ?? -1)
      || terminalEvent.payload.responseId !== response.responseId
      || terminalEvent.payload.responseStatus !== response.status
      || terminalEvent.payload.stopReason !== response.stopReason
      || !sameJson(terminalEvent.payload.usage, response.usage)
      || !isObject(assistantMessage.payload)
      || assistantMessage.payload.responseId !== response.responseId
      || assistantMessage.payload.verified !== true
      || !isObject(assistantMessage.refs)
      || assistantMessage.refs.responseId !== response.responseId
      || (response.status === "completed" && (!isObject(verification.payload) || verification.payload.passed !== true))
    ) return "EVENT_STATE_INVALID";
  }
  const memoryEvents = events.filter((event) => event.type === "memory.updated" && isObject(event.payload));
  if (memoryEvents.length > 0) {
    if (!terminalEvent || terminalEvent.type !== "run.completed" || !response) return "MEMORY_WRITE_INVALID";
    const terminalRevision = integer(terminalEvent.inputRevision) ?? -1;
    const verification = [...events].reverse().find((event) => event.type === "verification.completed" && event.inputRevision === terminalRevision && isObject(event.payload) && event.payload.passed === true);
    const assistantMessage = [...messageCompletes].reverse().find((event) => event.inputRevision === terminalRevision && isObject(event.payload) && event.payload.role === "assistant" && event.payload.responseId === response.responseId);
    if (!verification || !assistantMessage) return "MEMORY_WRITE_INVALID";
    for (const memoryEvent of memoryEvents) {
      const payload = memoryEvent.payload as JsonObject;
      if (
        payload.sourceResponseId !== response.responseId
        || (integer(memoryEvent.seq) ?? -1) <= (integer(assistantMessage.seq) ?? -1)
        || (integer(memoryEvent.seq) ?? -1) >= (integer(terminalEvent.seq) ?? -1)
        || memoryEvent.inputRevision !== terminalRevision
      ) return "MEMORY_WRITE_INVALID";
    }
  }
  return null;
}

function validateCommands(bundle: JsonObject): ContractErrorCode | null {
  const scope = bundle.scope;
  const commands = objects(bundle.steeringCommands);
  if (commands.some((command) => !sameScope(scope, command.scope))) return "COMMAND_SCOPE_MISMATCH";
  const state = isObject(bundle.agentState) ? bundle.agentState : null;
  const events = objects(bundle.events);
  const terminalEvent = events.find((event) => terminalEventTypes.has(text(event.type) ?? ""));
  const terminalAt = text(terminalEvent?.occurredAt) ?? (state?.terminalStatus ? text(state.updatedAt) : null);
  if (terminalAt && commands.some((command) => Date.parse(text(command.createdAt) ?? "") > Date.parse(terminalAt))) return "COMMAND_AFTER_TERMINAL";

  const byCommandId = new Map<string, JsonObject>();
  const byIdempotency = new Map<string, JsonObject>();
  for (const command of commands) {
    const commandId = text(command.commandId);
    const key = text(command.idempotencyKey);
    if (!commandId || !key) return "COMMAND_REVISION_CONFLICT";
    const previousCommand = byCommandId.get(commandId);
    if (previousCommand && (previousCommand.idempotencyKey !== key || previousCommand.contentHash !== command.contentHash)) {
      return "COMMAND_REVISION_CONFLICT";
    }
    const previous = byIdempotency.get(key);
    if (previous && (previous.commandId !== command.commandId || previous.contentHash !== command.contentHash)) return "COMMAND_REVISION_CONFLICT";
    byCommandId.set(commandId, command);
    byIdempotency.set(key, command);
  }

  let observedRevision: number | null = null;
  let latestAppliedInputRevision = -1;
  let lastDecisionCommandSeq = 0;
  const acceptedCommandIds = new Set<string>();
  let activeBatch: { id: string; previous: number; next: number; inputRevision: number; appliedCount: number } | null = null;
  const closeBatch = () => {
    if (!activeBatch || activeBatch.appliedCount < 1) return false;
    observedRevision = activeBatch.next;
    latestAppliedInputRevision = activeBatch.inputRevision;
    activeBatch = null;
    return true;
  };

  for (const event of events) {
    const payload = isObject(event.payload) ? event.payload : {};
    const type = text(event.type);
    const isBatchDecision = type === "guidance.applied" || type === "guidance.superseded";
    if (!isBatchDecision && activeBatch && !closeBatch()) return "COMMAND_REVISION_CONFLICT";

    if (type === "guidance.accepted") {
      const commandId = text(payload.commandId);
      const command = byCommandId.get(commandId ?? "");
      const expected = integer(payload.expectedSteeringRevision);
      const current = integer(payload.currentSteeringRevision);
      if (
        !commandId
        || !command
        || acceptedCommandIds.has(commandId)
        || expected !== integer(command.expectedSteeringRevision)
        || current !== expected
        || payload.idempotencyKey !== command.idempotencyKey
      ) return "COMMAND_REVISION_CONFLICT";
      if (observedRevision === null) observedRevision = current;
      if (current !== observedRevision) return "COMMAND_REVISION_CONFLICT";
      acceptedCommandIds.add(commandId);
    }

    if (isBatchDecision) {
      const batchId = text(payload.batchId);
      const commandId = text(payload.commandId);
      const commandSeq = integer(payload.commandSeq) ?? -1;
      const previous = integer(payload.previousSteeringRevision) ?? -1;
      const next = integer(payload.newSteeringRevision) ?? -1;
      const inputRevision = integer(event.inputRevision) ?? -1;
      if (!batchId || !commandId || !acceptedCommandIds.has(commandId) || commandSeq <= lastDecisionCommandSeq || next !== previous + 1) {
        return "COMMAND_REVISION_CONFLICT";
      }
      if (!activeBatch) {
        if (observedRevision === null) observedRevision = previous;
        if (observedRevision !== previous) return "COMMAND_REVISION_CONFLICT";
        activeBatch = { id: batchId, previous, next, inputRevision, appliedCount: 0 };
      } else if (
        activeBatch.id !== batchId
        || activeBatch.previous !== previous
        || activeBatch.next !== next
        || activeBatch.inputRevision !== inputRevision
      ) return "COMMAND_REVISION_CONFLICT";
      if (type === "guidance.applied") activeBatch.appliedCount += 1;
      lastDecisionCommandSeq = commandSeq;
    }

    if (type === "guidance.rejected" && payload.code === "COMMAND_REVISION_CONFLICT") {
      const command = byCommandId.get(text(payload.commandId) ?? "");
      if (!command || integer(command.expectedSteeringRevision) === integer(payload.actualSteeringRevision)) return "COMMAND_REVISION_CONFLICT";
    }

    if (
      latestAppliedInputRevision >= 0
      && ["node.completed", "verification.completed", "message.completed", "run.completed"].includes(type ?? "")
      && (integer(event.inputRevision) ?? -1) < latestAppliedInputRevision
    ) return "COMMAND_REVISION_CONFLICT";
  }
  if (activeBatch && !closeBatch()) return "COMMAND_REVISION_CONFLICT";
  if (state && observedRevision !== null && integer(state.steeringRevision) !== observedRevision) return "COMMAND_REVISION_CONFLICT";
  return null;
}

function validateQueue(bundle: JsonObject): ContractErrorCode | null {
  const queueEvents = objects(bundle.queueEvents);
  const latestQueuePayload = isObject(queueEvents.at(-1)?.payload) ? queueEvents.at(-1)?.payload as JsonObject : null;
  const explicitEntries = objects(bundle.queueEntries);
  const entries = explicitEntries.length > 0 ? explicitEntries : objects(latestQueuePayload?.entries);

  const validateSnapshot = (snapshotEntries: JsonObject[], payload: JsonObject | null, revision: number | null): ContractErrorCode | null => {
    if (revision !== null && snapshotEntries.some((entry) => integer(entry.queueRevision) !== revision)) return "QUEUE_REVISION_CONFLICT";
    const activeEntries = snapshotEntries.filter((entry) => entry.status === "starting" || entry.status === "running");
    if (activeEntries.length > 1) return "QUEUE_ACTIVE_RUN_CONFLICT";
    if (payload) {
      const activeRunIds = Array.isArray(payload.activeRunIds) ? payload.activeRunIds.map(text).filter((id): id is string => Boolean(id)).sort() : [];
      const entryRunIds = activeEntries.map((entry) => text(entry.runId)).filter((id): id is string => Boolean(id)).sort();
      if (!sameJson(activeRunIds, entryRunIds)) return "QUEUE_ACTIVE_RUN_CONFLICT";
    }
    const queued = snapshotEntries.filter((entry) => entry.status === "queued").sort((a, b) => (integer(a.position) ?? 0) - (integer(b.position) ?? 0));
    if (queued.some((entry, index) => integer(entry.position) !== index)) return "QUEUE_ORDER_INVALID";
    for (let index = 1; index < queued.length; index += 1) {
      if (Date.parse(text(queued[index - 1].createdAt) ?? "") > Date.parse(text(queued[index].createdAt) ?? "")) return "QUEUE_ORDER_INVALID";
    }
    return null;
  };

  let previousRevision = -1;
  let previousCursor = 0;
  for (const event of queueEvents) {
    const payload = isObject(event.payload) ? event.payload : {};
    if (event.threadId !== (isObject(event.scope) ? event.scope.threadId : null)) return "SCOPE_MISMATCH";
    const revision = integer(event.queueRevision) ?? -1;
    const cursor = integer(event.queueCursor) ?? -1;
    const expectedPrevious = integer(payload.expectedPreviousRevision) ?? -1;
    if (revision <= previousRevision || cursor <= previousCursor) return "QUEUE_REVISION_CONFLICT";
    if (expectedPrevious !== (previousRevision >= 0 ? previousRevision : revision - 1)) return "QUEUE_REVISION_CONFLICT";
    previousRevision = revision;
    previousCursor = cursor;
    const snapshotError = validateSnapshot(objects(payload.entries), payload, revision);
    if (snapshotError) return snapshotError;
  }
  const snapshotRevision = previousRevision >= 0 ? previousRevision : (integer(entries[0]?.queueRevision) ?? null);
  const entryError = validateSnapshot(entries, latestQueuePayload, snapshotRevision);
  if (entryError) return entryError;

  const terminalEvent = [...objects(bundle.events)].reverse().find((event) => terminalEventTypes.has(text(event.type) ?? ""));
  const terminalType = terminalEvent?.type;
  if (queueEvents.length > 0 && terminalType === "run.cancelled" && (latestQueuePayload?.paused !== true || latestQueuePayload.pauseReason !== "stopped")) return "QUEUE_PAUSE_INVALID";
  if (queueEvents.length > 0 && terminalType === "run.failed" && (latestQueuePayload?.paused !== true || latestQueuePayload.pauseReason !== "failed")) return "QUEUE_PAUSE_INVALID";
  if (queueEvents.length > 0 && terminalEvent && Date.parse(text(queueEvents.at(-1)?.occurredAt) ?? "") < Date.parse(text(terminalEvent.occurredAt) ?? "")) {
    return "QUEUE_REVISION_CONFLICT";
  }
  const autoStart = latestQueuePayload?.autoStartNext === true;
  const activeEntries = entries.filter((entry) => entry.status === "starting" || entry.status === "running");
  if (terminalType === "run.completed" && autoStart && entries.some((entry) => entry.status === "queued") && activeEntries.length === 0) return "QUEUE_ORDER_INVALID";
  const trigger = latestQueuePayload && isObject(latestQueuePayload.trigger) ? latestQueuePayload.trigger : null;
  if (trigger?.terminalStatus === "cancelled" && (latestQueuePayload?.paused !== true || latestQueuePayload.pauseReason !== "stopped")) return "QUEUE_PAUSE_INVALID";
  if (trigger?.terminalStatus === "failed" && (latestQueuePayload?.paused !== true || latestQueuePayload.pauseReason !== "failed")) return "QUEUE_PAUSE_INVALID";
  if (trigger?.terminalStatus === "completed" && autoStart && entries.some((entry) => entry.status === "queued") && activeEntries.length === 0) return "QUEUE_ORDER_INVALID";
  return null;
}

function validateStates(bundle: JsonObject): ContractErrorCode | null {
  const history = objects(bundle.agentStates);
  const latest = isObject(bundle.agentState) ? bundle.agentState : null;
  const states = history.length > 0 ? history : (latest ? [latest] : []);
  if (history.length > 0 && latest && !sameJson(history.at(-1), latest)) return "STATE_TRANSITION_INVALID";
  for (let index = 1; index < states.length; index += 1) {
    const previous = states[index - 1];
    const current = states[index];
    if (
      previous.stateId !== current.stateId
      || previous.runId !== current.runId
      || !sameScope(previous.scope, current.scope)
      || (integer(current.stateRevision) ?? -1) <= (integer(previous.stateRevision) ?? -1)
      || (integer(current.checkpointRevision) ?? -1) <= (integer(previous.checkpointRevision) ?? -1)
      || (previous.cancelRequested === true && current.cancelRequested !== true)
    ) return "STATE_TRANSITION_INVALID";
    if ((integer(current.fencingToken) ?? -1) < (integer(previous.fencingToken) ?? -1)) return "STATE_FENCE_INVALID";
  }
  return null;
}

function validateBundle(bundle: JsonObject, ajv: Ajv2020): ContractErrorCode | null {
  const commandScope = validateCommands(bundle);
  if (commandScope === "COMMAND_SCOPE_MISMATCH") return commandScope;
  const scope = bundle.scope;
  if (nestedScopes(bundle).some((candidate) => !sameScope(scope, candidate))) return "SCOPE_MISMATCH";
  return validateStates(bundle)
    ?? validatePlan(bundle)
    ?? validateTools(bundle, ajv)
    ?? validateEvidence(bundle)
    ?? validateUsage(bundle)
    ?? validateBudgets(bundle)
    ?? validateBudgetStop(bundle)
    ?? validateEvents(bundle)
    ?? commandScope
    ?? validateQueue(bundle);
}

export function defaultContractsRoot() {
  return path.resolve(process.cwd(), "..", "..", "packages", "contracts", "v2");
}

export function loadContractManifest(contractsRoot = defaultContractsRoot()): ContractManifest {
  return JSON.parse(readFileSync(path.join(contractsRoot, "fixtures", "manifest.json"), "utf8")) as ContractManifest;
}

export function loadFixture(entry: ContractManifestEntry, contractsRoot = defaultContractsRoot()): unknown {
  return JSON.parse(readFileSync(path.join(contractsRoot, "fixtures", entry.path), "utf8")) as unknown;
}

export class SearchAgentV2ContractValidator {
  private readonly ajv: Ajv2020;
  private readonly validators = new Map<string, ValidateFunction>();

  constructor(readonly contractsRoot = defaultContractsRoot()) {
    this.ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: true });
    addFormats(this.ajv, { mode: "full" });
    const schemaDirectory = path.join(contractsRoot, "schemas");
    for (const filename of readdirSync(schemaDirectory).filter((name) => name.endsWith(".schema.json")).sort()) {
      const schema = JSON.parse(readFileSync(path.join(schemaDirectory, filename), "utf8")) as AnySchema;
      this.ajv.addSchema(schema);
    }
  }

  validate(schemaId: string, document: unknown): ContractValidationResult {
    if (containsPrivateReasoning(document)) return { valid: false, errorCode: "PRIVATE_REASONING_FORBIDDEN" };
    if (validatePublicText(document)) return { valid: false, errorCode: "PUBLIC_TEXT_INVALID" };
    const stateError = validateAgentStateSemantics(document);
    if (stateError) return { valid: false, errorCode: stateError };
    let validator = this.validators.get(schemaId);
    if (!validator) {
      validator = this.ajv.getSchema(schemaId);
      if (!validator) return { valid: false, errorCode: "SCHEMA_INVALID" };
      this.validators.set(schemaId, validator);
    }
    if (!validator(document)) return { valid: false, errorCode: "SCHEMA_INVALID" };
    if (schemaId === `${CONTRACT_SCHEMA_BASE}contract-bundle.schema.json` && isObject(document)) {
      const errorCode = validateBundle(document, this.ajv);
      if (errorCode) return { valid: false, errorCode };
    }
    if (schemaId.startsWith(`${CONTRACT_SCHEMA_BASE}common.schema.json#/$defs/`)) {
      const errorCode = schemaId.endsWith("Budget") ? validateBudgets(document) : validateUsage(document);
      if (errorCode) return { valid: false, errorCode };
    }
    if (schemaId.startsWith(`${CONTRACT_SCHEMA_BASE}tool.schema.json`)) {
      const errorCode = validateToolErrors(document);
      if (errorCode) return { valid: false, errorCode };
    }
    return { valid: true, errorCode: null };
  }

  validateFixture(entry: ContractManifestEntry): ContractValidationResult {
    return this.validate(entry.schemaId, loadFixture(entry, this.contractsRoot));
  }
}
