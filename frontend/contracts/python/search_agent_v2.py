from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

CONTRACT_SCHEMA_BASE = "https://schemas.agent-workbench.invalid/contracts/v2/schemas/"
CONTRACT_ERROR_CODES = (
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
    "STATE_FENCE_INVALID",
)
FORBIDDEN_PRIVATE_KEYS = {"reasoningcontent", "chainofthought", "rawreasoning", "rawcot"}
TERMINAL_EVENT_TYPES = {"run.completed", "run.cancelled", "run.failed"}
USD_PATTERN = re.compile(r"^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$")
PUBLIC_TEXT_EVENT_TYPES = {
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
    "verification.completed",
}
NULL_PUBLIC_TEXT_EVENT_TYPES = {
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
    "budget.updated",
}


@dataclass(frozen=True)
class ValidationResult:
    valid: bool
    error_code: str | None


def contracts_root() -> Path:
    return Path(__file__).resolve().parents[1] / "v2"


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def normalize_private_key(key: str) -> str:
    return key.replace("_", "").replace("-", "").lower()


def contains_private_reasoning(value: Any) -> bool:
    if isinstance(value, list):
        return any(contains_private_reasoning(item) for item in value)
    if not isinstance(value, dict):
        return False
    return any(
        normalize_private_key(str(key)) in FORBIDDEN_PRIVATE_KEYS or contains_private_reasoning(nested)
        for key, nested in value.items()
    )


def is_public_paragraph(value: Any) -> bool:
    return (
        isinstance(value, str)
        and 1 <= len(value) <= 500
        and "\r" not in value
        and "\n" not in value
        and "```" not in value
        and re.match(r"^\s*(?:#{1,6}\s|[-*+]\s|[0-9]+[.)]\s)", value) is None
    )


def validate_event_public_text(event: Any) -> str | None:
    if not isinstance(event, dict) or event.get("type") not in PUBLIC_TEXT_EVENT_TYPES:
        return None
    payload = event.get("payload")
    if not isinstance(payload, dict):
        return None
    event_type = event.get("type")
    public_text = payload.get("publicText")
    if event_type in NULL_PUBLIC_TEXT_EVENT_TYPES:
        return None if public_text is None else "PUBLIC_TEXT_INVALID"
    if event_type == "node.completed":
        if payload.get("executionKind") == "model":
            return None if is_public_paragraph(public_text) else "PUBLIC_TEXT_INVALID"
        return None if public_text is None else "PUBLIC_TEXT_INVALID"
    return None if public_text is None or is_public_paragraph(public_text) else "PUBLIC_TEXT_INVALID"


def validate_public_text(document: Any) -> str | None:
    if isinstance(document, dict) and isinstance(document.get("events"), list):
        for event in document["events"]:
            if error := validate_event_public_text(event):
                return error
        return None
    return validate_event_public_text(document)


def validate_agent_state_semantics(document: Any) -> str | None:
    if isinstance(document, dict) and isinstance(document.get("agentStates"), list):
        states = [state for state in document["agentStates"] if isinstance(state, dict)]
    elif isinstance(document, dict) and isinstance(document.get("agentState"), dict):
        states = [document["agentState"]]
    elif isinstance(document, dict) and isinstance(document.get("stateId"), str):
        states = [document]
    else:
        states = []
    for state in states:
        current_node = state.get("currentNode")
        clarification_ref = state.get("pendingClarificationRef")
        approval_ref = state.get("pendingApprovalRef")
        if isinstance(clarification_ref, str) and isinstance(approval_ref, str):
            return "STATE_TRANSITION_INVALID"
        if current_node == "interrupt_for_clarification":
            if not isinstance(clarification_ref, str) or approval_ref is not None:
                return "STATE_TRANSITION_INVALID"
        elif current_node == "interrupt_for_approval":
            if not isinstance(approval_ref, str) or clarification_ref is not None:
                return "STATE_TRANSITION_INVALID"
        elif clarification_ref is not None or approval_ref is not None:
            return "STATE_TRANSITION_INVALID"
        if current_node == "terminal":
            if (
                state.get("nextNode") is not None
                or clarification_ref is not None
                or approval_ref is not None
                or state.get("terminalStatus") not in {"completed", "cancelled", "failed"}
                or not isinstance(state.get("stopReason"), str)
            ):
                return "STATE_TRANSITION_INVALID"
            if state.get("terminalStatus") == "completed" and state.get("cancelRequested") is not False:
                return "STATE_TRANSITION_INVALID"
            if state.get("terminalStatus") == "cancelled" and state.get("cancelRequested") is not True:
                return "STATE_TRANSITION_INVALID"
        elif state.get("terminalStatus") is not None or state.get("stopReason") is not None:
            return "STATE_TRANSITION_INVALID"
    return None


def same_scope(left: Any, right: Any) -> bool:
    if not isinstance(left, dict) or not isinstance(right, dict):
        return False
    return all(left.get(key) == right.get(key) for key in ("tenantId", "actorId", "visitorId", "projectId", "threadId"))


def same_json(left: Any, right: Any) -> bool:
    if type(left) is not type(right):
        return False
    if isinstance(left, list):
        return len(left) == len(right) and all(same_json(item, right[index]) for index, item in enumerate(left))
    if isinstance(left, dict):
        return set(left) == set(right) and all(same_json(left[key], right[key]) for key in left)
    return left == right


def nested_scopes(value: Any) -> list[Any]:
    found: list[Any] = []
    if isinstance(value, list):
        for item in value:
            found.extend(nested_scopes(item))
    elif isinstance(value, dict):
        for key, nested in value.items():
            if key == "scope":
                found.append(nested)
            else:
                found.extend(nested_scopes(nested))
    return found


def is_strict_object_schema(value: Any) -> bool:
    if isinstance(value, list):
        return all(is_strict_object_schema(item) for item in value)
    if not isinstance(value, dict):
        return True
    if value.get("type") == "object" and value.get("additionalProperties") is not False:
        return False
    return all(is_strict_object_schema(item) for item in value.values())


def validate_tool_errors(value: Any) -> str | None:
    if isinstance(value, list):
        for item in value:
            if error := validate_tool_errors(item):
                return error
        return None
    if not isinstance(value, dict):
        return None
    if {"category", "retryable", "nextAction", "fieldPath", "expected", "retryAfterMs"}.issubset(value):
        category = value.get("category")
        if category == "invalid_arguments" and (
            not isinstance(value.get("fieldPath"), str)
            or not isinstance(value.get("expected"), str)
            or value.get("retryable") is not False
            or value.get("nextAction") != "repair_arguments"
        ):
            return "TOOL_ERROR_INVALID"
        if category == "rate_limited" and (
            not isinstance(value.get("retryAfterMs"), int)
            or value.get("retryable") is not True
            or value.get("nextAction") != "retry_wait"
        ):
            return "TOOL_ERROR_INVALID"
        if category == "outcome_unknown" and (
            value.get("retryable") is not False or value.get("nextAction") != "check_operation"
        ):
            return "TOOL_ERROR_INVALID"
        if category == "permission_denied" and (
            value.get("retryable") is not False or value.get("nextAction") not in {"request_approval", "stop"}
        ):
            return "TOOL_ERROR_INVALID"
        if category == "auth_required" and (
            value.get("retryable") is not False or value.get("nextAction") != "connect_account"
        ):
            return "TOOL_ERROR_INVALID"
    for nested in value.values():
        if error := validate_tool_errors(nested):
            return error
    return None


class SearchAgentV2ContractValidator:
    def __init__(self, root: Path | None = None) -> None:
        self.root = root or contracts_root()
        schema_files = sorted((self.root / "schemas").glob("*.schema.json"))
        schemas = [load_json(path) for path in schema_files]
        self.schemas = {schema["$id"]: schema for schema in schemas}
        resources = [(schema_id, Resource.from_contents(schema)) for schema_id, schema in self.schemas.items()]
        self.registry = Registry().with_resources(resources)
        self.format_checker = FormatChecker()
        self.format_checker.checks("date-time")(self._is_rfc3339_datetime)
        self.format_checker.checks("date")(self._is_iso_date)

    @staticmethod
    def _is_rfc3339_datetime(value: Any) -> bool:
        if not isinstance(value, str):
            return True
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return False
        return parsed.tzinfo is not None

    @staticmethod
    def _is_iso_date(value: Any) -> bool:
        if not isinstance(value, str):
            return True
        try:
            return date.fromisoformat(value).isoformat() == value
        except ValueError:
            return False

    def validate(self, schema_id: str, document: Any) -> ValidationResult:
        if contains_private_reasoning(document):
            return ValidationResult(False, "PRIVATE_REASONING_FORBIDDEN")
        if validate_public_text(document):
            return ValidationResult(False, "PUBLIC_TEXT_INVALID")
        if state_error := validate_agent_state_semantics(document):
            return ValidationResult(False, state_error)
        base_schema_id = schema_id.split("#", 1)[0]
        schema = self.schemas.get(base_schema_id)
        if schema is None:
            return ValidationResult(False, "SCHEMA_INVALID")
        validation_schema = schema if schema_id == base_schema_id else {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$ref": schema_id,
        }
        validator = Draft202012Validator(validation_schema, registry=self.registry, format_checker=self.format_checker)
        if next(validator.iter_errors(document), None) is not None:
            return ValidationResult(False, "SCHEMA_INVALID")
        if schema_id == f"{CONTRACT_SCHEMA_BASE}contract-bundle.schema.json" and isinstance(document, dict):
            error = self._validate_bundle(document)
            if error:
                return ValidationResult(False, error)
        if schema_id.startswith(f"{CONTRACT_SCHEMA_BASE}common.schema.json#/$defs/"):
            error = self._validate_budgets(document) if schema_id.endswith("Budget") else self._validate_usage(document)
            if error:
                return ValidationResult(False, error)
        if schema_id.startswith(f"{CONTRACT_SCHEMA_BASE}tool.schema.json"):
            if error := validate_tool_errors(document):
                return ValidationResult(False, error)
        return ValidationResult(True, None)

    def validate_fixture(self, entry: dict[str, Any]) -> ValidationResult:
        document = load_json(self.root / "fixtures" / entry["path"])
        return self.validate(entry["schemaId"], document)

    def _validate_bundle(self, bundle: dict[str, Any]) -> str | None:
        command_error = self._validate_commands(bundle)
        if command_error == "COMMAND_SCOPE_MISMATCH":
            return command_error
        if any(not same_scope(bundle.get("scope"), candidate) for candidate in nested_scopes(bundle)):
            return "SCOPE_MISMATCH"
        return (
            self._validate_states(bundle)
            or self._validate_plan(bundle)
            or self._validate_tools(bundle)
            or self._validate_evidence(bundle)
            or self._validate_usage(bundle)
            or self._validate_budgets(bundle)
            or self._validate_budget_stop(bundle)
            or self._validate_events(bundle)
            or command_error
            or self._validate_queue(bundle)
        )

    @staticmethod
    def _validate_states(bundle: dict[str, Any]) -> str | None:
        history = [item for item in bundle.get("agentStates", []) if isinstance(item, dict)]
        latest = bundle.get("agentState") if isinstance(bundle.get("agentState"), dict) else None
        states = history if history else ([latest] if latest else [])
        if history and latest and not same_json(history[-1], latest):
            return "STATE_TRANSITION_INVALID"
        for previous, current in zip(states, states[1:]):
            if (
                previous.get("stateId") != current.get("stateId")
                or previous.get("runId") != current.get("runId")
                or not same_scope(previous.get("scope"), current.get("scope"))
                or current.get("stateRevision", -1) <= previous.get("stateRevision", -1)
                or current.get("checkpointRevision", -1) <= previous.get("checkpointRevision", -1)
                or (previous.get("cancelRequested") is True and current.get("cancelRequested") is not True)
            ):
                return "STATE_TRANSITION_INVALID"
            if current.get("fencingToken", -1) < previous.get("fencingToken", -1):
                return "STATE_FENCE_INVALID"
        return None

    @staticmethod
    def _validate_plan(bundle: dict[str, Any]) -> str | None:
        plan = bundle.get("plan")
        if not isinstance(plan, dict):
            return None
        steps = [step for step in plan.get("steps", []) if isinstance(step, dict)]
        ids = [step.get("id") for step in steps]
        if len(set(ids)) != len(ids):
            return "PLAN_STEP_DUPLICATE"
        known = set(ids)
        dependencies: dict[str, list[str]] = {}
        for step in steps:
            step_id = step.get("id")
            depends_on = step.get("dependsOn", [])
            if any(dependency not in known for dependency in depends_on):
                return "PLAN_DEPENDENCY_MISSING"
            dependencies[step_id] = depends_on
        visiting: set[str] = set()
        visited: set[str] = set()

        def has_cycle(step_id: str) -> bool:
            if step_id in visiting:
                return True
            if step_id in visited:
                return False
            visiting.add(step_id)
            if any(has_cycle(dependency) for dependency in dependencies.get(step_id, [])):
                return True
            visiting.remove(step_id)
            visited.add(step_id)
            return False

        return "PLAN_CYCLE" if any(has_cycle(step_id) for step_id in ids) else None

    def _validate_tools(self, bundle: dict[str, Any]) -> str | None:
        specs = [item for item in bundle.get("toolSpecs", []) if isinstance(item, dict)]
        calls = [item for item in bundle.get("toolCalls", []) if isinstance(item, dict)]
        results = [item for item in bundle.get("toolResults", []) if isinstance(item, dict)]
        call_ids = [item.get("toolCallId") for item in calls]
        result_ids = [item.get("toolCallId") for item in results]
        if len(set(call_ids)) != len(call_ids) or len(set(result_ids)) != len(result_ids):
            return "TOOL_CALL_DUPLICATE"
        if len(call_ids) != len(result_ids) or any(call_id not in result_ids for call_id in call_ids):
            return "TOOL_CALL_DANGLING"
        specs_by_id = {item.get("toolId"): item for item in specs}
        results_by_call = {item.get("toolCallId"): item for item in results}
        if error := validate_tool_errors(results):
            return error
        for spec in specs:
            parameters_schema = spec.get("parametersSchema")
            result_schema = spec.get("resultSchema")
            if not isinstance(parameters_schema, dict) or not isinstance(result_schema, dict):
                return "TOOL_SCHEMA_INVALID"
            if not is_strict_object_schema(parameters_schema) or not is_strict_object_schema(result_schema):
                return "TOOL_SCHEMA_INVALID"
            if (spec.get("effect") == "read") != (spec.get("reversibility") == "read_only"):
                return "TOOL_POLICY_INVALID"
            if spec.get("reversibility") == "irreversible" and spec.get("approval") == "never":
                return "TOOL_POLICY_INVALID"
            try:
                Draft202012Validator.check_schema(parameters_schema)
                Draft202012Validator.check_schema(result_schema)
            except Exception:
                return "TOOL_SCHEMA_INVALID"

        calls_by_operation: dict[str, list[dict[str, Any]]] = {}
        for call in calls:
            operation_ref = call.get("operationRef")
            if not isinstance(operation_ref, str):
                return "TOOL_CALL_DANGLING"
            calls_by_operation.setdefault(operation_ref, []).append(call)
        for operation_calls in calls_by_operation.values():
            if len(operation_calls) < 2:
                continue
            has_unknown = any(
                results_by_call.get(call.get("toolCallId"), {}).get("status") == "unknown"
                for call in operation_calls
            )
            spec = specs_by_id.get(operation_calls[0].get("toolId"))
            if has_unknown and spec and spec.get("effect") != "read" and spec.get("idempotency") == "none":
                return "TOOL_UNKNOWN_RETRY_FORBIDDEN"
            return "TOOL_CALL_DUPLICATE"

        for call in calls:
            spec = specs_by_id.get(call.get("toolId"))
            result = results_by_call.get(call.get("toolCallId"))
            if (
                spec is None
                or result is None
                or result.get("toolId") != call.get("toolId")
                or result.get("operationRef") != call.get("operationRef")
            ):
                return "TOOL_CALL_DANGLING"
            try:
                parameter_validator = Draft202012Validator(
                    spec["parametersSchema"], registry=self.registry, format_checker=self.format_checker
                )
                if next(parameter_validator.iter_errors(call.get("arguments")), None) is not None:
                    return "TOOL_ARGUMENTS_INVALID"
            except Exception:
                return "TOOL_ARGUMENTS_INVALID"
            usage = result.get("usage") if isinstance(result.get("usage"), dict) else None
            if usage is None or usage.get("toolId") != call.get("toolId"):
                return "USAGE_INVALID"
            if result.get("status") == "unknown":
                error = result.get("error") if isinstance(result.get("error"), dict) else None
                if (
                    error is None
                    or error.get("category") != "outcome_unknown"
                    or error.get("retryable") is not False
                    or error.get("nextAction") != "check_operation"
                    or result.get("outputRef") is not None
                    or usage.get("actualCostUsd") is not None
                    or (self._usd_micros(usage.get("possibleDuplicateCostUsd")) or 0) <= 0
                ):
                    return "USAGE_INVALID"
        return None

    @staticmethod
    def _validate_evidence(bundle: dict[str, Any]) -> str | None:
        sources = [item for item in bundle.get("sources", []) if isinstance(item, dict)]
        snapshots = [item for item in bundle.get("snapshots", []) if isinstance(item, dict)]
        evidence = [item for item in bundle.get("evidence", []) if isinstance(item, dict)]
        response = bundle.get("response") if isinstance(bundle.get("response"), dict) else None
        claims = [item for item in (response.get("claims", []) if response else bundle.get("claims", [])) if isinstance(item, dict)]
        citations = [item for item in (response.get("citations", []) if response else bundle.get("citations", [])) if isinstance(item, dict)]
        source_ids = [item.get("sourceId") for item in sources]
        snapshot_ids = [item.get("snapshotId") for item in snapshots]
        evidence_ids = [item.get("evidenceId") for item in evidence]
        claim_ids = [item.get("id") for item in claims]
        citation_ids = [item.get("citationId") for item in citations]
        if any(len(set(values)) != len(values) for values in (source_ids, snapshot_ids, evidence_ids, claim_ids, citation_ids)):
            return "EVIDENCE_REFERENCE_INVALID"
        sources_by_id = {item.get("sourceId"): item for item in sources}
        snapshots_by_id = {item.get("snapshotId"): item for item in snapshots}
        evidence_by_id = {item.get("evidenceId"): item for item in evidence}
        claims_by_id = {item.get("id"): item for item in claims}
        citations_by_id = {item.get("citationId"): item for item in citations}
        if any(snapshot.get("sourceId") not in sources_by_id for snapshot in snapshots):
            return "EVIDENCE_REFERENCE_INVALID"
        for passage in evidence:
            snapshot = snapshots_by_id.get(passage.get("snapshotId"))
            if passage.get("sourceId") not in sources_by_id or snapshot is None or snapshot.get("sourceId") != passage.get("sourceId"):
                return "EVIDENCE_REFERENCE_INVALID"
            locator = passage.get("locator") if isinstance(passage.get("locator"), dict) else None
            if locator and locator.get("kind") == "code_line" and locator.get("startLine", 0) > locator.get("endLine", 0):
                return "LOCATOR_INVALID"
            if locator and locator.get("kind") == "media_timecode" and locator.get("endMs") is not None and locator.get("startMs", 0) > locator.get("endMs", 0):
                return "LOCATOR_INVALID"
            if locator and locator.get("kind") == "text_quote" and locator.get("exactQuote") != passage.get("quote"):
                return "LOCATOR_INVALID"
        if any(any(evidence_id not in evidence_by_id for evidence_id in claim.get("evidenceIds", [])) for claim in claims):
            return "EVIDENCE_REFERENCE_INVALID"
        for citation in citations:
            passage = evidence_by_id.get(citation.get("evidenceId"))
            claim = claims_by_id.get(citation.get("claimId"))
            if passage is None or claim is None:
                return "EVIDENCE_REFERENCE_INVALID"
            if citation.get("locatorVerified") is not True or passage.get("verified") is not True:
                return "CITATION_UNVERIFIED"
            source = sources_by_id.get(passage.get("sourceId"))
            if source is None:
                return "EVIDENCE_REFERENCE_INVALID"
            if (
                citation.get("title") != source.get("title")
                or citation.get("canonicalUrl") != source.get("canonicalUrl")
                or not same_json(citation.get("artifactRef"), source.get("artifactRef"))
                or citation.get("publishedAt") != source.get("publishedAt")
                or citation.get("retrievedAt") != source.get("retrievedAt")
                or citation.get("sourceType") != source.get("sourceType")
                or not same_json(citation.get("locator"), passage.get("locator"))
            ):
                return "CITATION_PROJECTION_MISMATCH"
            if source.get("sourceType") in {"private", "user_attachment"} and citation.get("canonicalUrl") is not None:
                return "CITATION_PROJECTION_MISMATCH"
        for claim in claims:
            if any(citation_id not in citations_by_id for citation_id in claim.get("citationIds", [])):
                return "EVIDENCE_REFERENCE_INVALID"
            if any(
                citations_by_id[citation_id].get("evidenceId") not in claim.get("evidenceIds", [])
                for citation_id in claim.get("citationIds", [])
            ):
                return "EVIDENCE_REFERENCE_INVALID"
            if any(citations_by_id[citation_id].get("claimId") != claim.get("id") for citation_id in claim.get("citationIds", [])):
                return "EVIDENCE_REFERENCE_INVALID"
        if response is None:
            return None
        if response.get("status") == "completed" and any(
            claim.get("status") != "supported"
            or (claim.get("importance") != "context" and len(claim.get("citationIds", [])) == 0)
            for claim in claims
        ):
            return "UNSUPPORTED_CLAIM"
        return None

    @staticmethod
    def _usd_micros(value: Any) -> int | None:
        if not isinstance(value, str) or USD_PATTERN.fullmatch(value) is None:
            return None
        try:
            return int(Decimal(value) * 1_000_000)
        except (InvalidOperation, ValueError):
            return None

    def _validate_usage(self, value: Any) -> str | None:
        if isinstance(value, list):
            for item in value:
                if error := self._validate_usage(item):
                    return error
            return None
        if not isinstance(value, dict):
            return None
        token_keys = {"model", "inputTokens", "outputTokens", "totalTokens", "reasoningTokens", "cacheHitInputTokens", "cacheMissInputTokens"}
        if token_keys.issubset(value):
            if value["totalTokens"] != value["inputTokens"] + value["outputTokens"]:
                return "USAGE_INVALID"
            if value["reasoningTokens"] > value["outputTokens"]:
                return "USAGE_INVALID"
            if value["cacheHitInputTokens"] + value["cacheMissInputTokens"] > value["inputTokens"]:
                return "USAGE_INVALID"
        if {"toolId", "calls", "attempts", "units", "bytes", "resultCount"}.issubset(value):
            if value["attempts"] < value["calls"]:
                return "USAGE_INVALID"
        if {"attemptId", "status", "possibleDuplicateCostUsd"}.issubset(value):
            duplicate_cost = self._usd_micros(value.get("possibleDuplicateCostUsd"))
            if value.get("status") == "unknown" and (duplicate_cost is None or duplicate_cost <= 0):
                return "USAGE_INVALID"
        if isinstance(value.get("modelBreakdown"), list) and isinstance(value.get("toolBreakdown"), list) and isinstance(value.get("totals"), dict):
            models = [item for item in value["modelBreakdown"] if isinstance(item, dict)]
            tools = [item for item in value["toolBreakdown"] if isinstance(item, dict)]
            totals = value["totals"]
            if totals.get("modelCalls") != sum(item.get("calls", 0) for item in models):
                return "USAGE_INVALID"
            if totals.get("toolCalls") != sum(item.get("calls", 0) for item in tools):
                return "USAGE_INVALID"
            if totals.get("searchQueries") != sum(item.get("searchQueries", 0) for item in tools):
                return "USAGE_INVALID"
            if totals.get("pageReads") != sum(item.get("pageReads", 0) for item in tools):
                return "USAGE_INVALID"
            for key in ("inputTokens", "outputTokens", "totalTokens", "reasoningTokens"):
                if totals.get(key) != sum(item.get(key, 0) for item in models):
                    return "USAGE_INVALID"
            estimated = sum((self._usd_micros(item.get("estimatedCostUsd")) or 0) for item in [*models, *tools])
            if self._usd_micros(totals.get("estimatedCostUsd")) != estimated:
                return "USAGE_INVALID"
            actual_values = [item.get("actualCostUsd") for item in [*models, *tools]]
            if any(item is None for item in actual_values):
                if totals.get("actualCostUsd") is not None:
                    return "USAGE_INVALID"
            else:
                actual = sum((self._usd_micros(item) or 0) for item in actual_values)
                if self._usd_micros(totals.get("actualCostUsd")) != actual:
                    return "USAGE_INVALID"
            duplicate = sum((self._usd_micros(item.get("possibleDuplicateCostUsd")) or 0) for item in [*models, *tools])
            if self._usd_micros(totals.get("possibleDuplicateCostUsd")) != duplicate:
                return "USAGE_INVALID"
            model_keys = [(item.get("provider"), item.get("model"), item.get("pricingVersion")) for item in models]
            tool_keys = [(item.get("toolId"), item.get("toolVersion"), item.get("provider"), item.get("pricingVersion")) for item in tools]
            if len(set(model_keys)) != len(model_keys) or len(set(tool_keys)) != len(tool_keys):
                return "USAGE_INVALID"
        for nested in value.values():
            if error := self._validate_usage(nested):
                return error
        return None

    def _validate_budgets(self, value: Any) -> str | None:
        if isinstance(value, list):
            for item in value:
                if error := self._validate_budgets(item):
                    return error
            return None
        if not isinstance(value, dict):
            return None
        if all(key in value for key in ("max", "used", "reserved", "remaining")):
            if isinstance(value["max"], str):
                maximum = self._usd_micros(value.get("max"))
                used = self._usd_micros(value.get("used"))
                reserved = self._usd_micros(value.get("reserved"))
                remaining = self._usd_micros(value.get("remaining"))
            else:
                maximum = value.get("max")
                used = value.get("used")
                reserved = value.get("reserved")
                remaining = value.get("remaining")
            if None in (maximum, used, reserved, remaining) or used + reserved + remaining != maximum:
                return "BUDGET_INVALID"
        usage = value.get("usage") if isinstance(value.get("usage"), dict) else None
        budget = value.get("budget") if isinstance(value.get("budget"), dict) else None
        totals = usage.get("totals") if usage and isinstance(usage.get("totals"), dict) else None
        if budget is not None and totals is not None:
            numeric_mappings = (
                ("modelCalls", "modelCalls"),
                ("inputTokens", "inputTokens"),
                ("outputTokens", "outputTokens"),
                ("toolCalls", "toolCalls"),
                ("searchQueries", "searchQueries"),
                ("pageReads", "pageReads"),
                ("peakParallelTools", "parallelTools"),
                ("elapsedMs", "wallTimeMs"),
            )
            for usage_key, budget_key in numeric_mappings:
                counter = budget.get(budget_key)
                if not isinstance(counter, dict) or counter.get("used") != totals.get(usage_key):
                    return "BUDGET_INVALID"
            cost = budget.get("costUsd")
            used_cost = totals.get("actualCostUsd") if totals.get("actualCostUsd") is not None else totals.get("estimatedCostUsd")
            if not isinstance(cost, dict) or self._usd_micros(cost.get("used")) != self._usd_micros(used_cost):
                return "BUDGET_INVALID"
        for nested in value.values():
            if error := self._validate_budgets(nested):
                return error
        return None

    @staticmethod
    def _has_exhausted_budget(value: Any) -> bool:
        if isinstance(value, list):
            return any(SearchAgentV2ContractValidator._has_exhausted_budget(item) for item in value)
        if not isinstance(value, dict):
            return False
        if value.get("exhausted") is True and "modelCalls" in value and "costUsd" in value:
            return True
        return any(SearchAgentV2ContractValidator._has_exhausted_budget(item) for item in value.values())

    def _validate_budget_stop(self, bundle: dict[str, Any]) -> str | None:
        if not self._has_exhausted_budget(bundle):
            return None
        response = bundle.get("response") if isinstance(bundle.get("response"), dict) else None
        terminal_match = any(
            event.get("type") in TERMINAL_EVENT_TYPES
            and isinstance(event.get("payload"), dict)
            and event["payload"].get("stopReason") == "budget_exhausted"
            for event in bundle.get("events", [])
            if isinstance(event, dict)
        )
        return None if (response and response.get("stopReason") == "budget_exhausted") or terminal_match else "BUDGET_STOP_MISMATCH"

    @staticmethod
    def _validate_events(bundle: dict[str, Any]) -> str | None:
        events = [item for item in bundle.get("events", []) if isinstance(item, dict)]
        event_kinds = {
            "run.created": "run", "run.status": "run", "run.completed": "run", "run.cancelled": "run", "run.failed": "run",
            "node.started": "node", "node.completed": "node", "node.failed": "node", "plan.updated": "plan",
            "tool.started": "tool", "tool.updated": "tool", "tool.completed": "tool", "tool.failed": "tool",
            "tool.unknown": "tool",
            "approval.required": "approval", "approval.decided": "approval",
            "clarification.required": "clarification", "clarification.resumed": "clarification", "artifact.created": "artifact",
            "context.usage.updated": "context", "budget.updated": "budget",
            "citation.created": "citation", "verification.completed": "verification", "memory.updated": "memory",
            "message.started": "message", "message.completed": "message", "guidance.accepted": "guidance",
            "guidance.applied": "guidance", "guidance.superseded": "guidance", "guidance.rejected": "guidance",
            "guidance.failed": "guidance",
        }
        previous_seq = 0
        terminal_seen = False
        previous_context_revision = -1
        previous_context_was_estimate: bool | None = None
        previous_budget_revision = -1
        exhausted_budget_seq: int | None = None
        expected_status = {
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
            "clarification.resumed": "completed",
        }
        for event in events:
            seq = event.get("seq", -1)
            if seq <= previous_seq:
                return "EVENT_SEQ_INVALID"
            previous_seq = seq
            event_type = event.get("type")
            if event_kinds.get(event_type) != event.get("kind"):
                return "EVENT_STATE_INVALID"
            if terminal_seen:
                return "DUPLICATE_TERMINAL" if event_type in TERMINAL_EVENT_TYPES else "EVENT_AFTER_TERMINAL"
            if event_type in TERMINAL_EVENT_TYPES:
                terminal_seen = True
            payload = event.get("payload") if isinstance(event.get("payload"), dict) else None
            payload = payload or {}
            if exhausted_budget_seq is not None and seq > exhausted_budget_seq and event_type not in TERMINAL_EVENT_TYPES:
                return "BUDGET_STOP_MISMATCH"
            if event_type == "context.usage.updated":
                sections = payload.get("sections") if isinstance(payload.get("sections"), dict) else None
                names = ("system", "history", "projectMemory", "retrieval", "toolResults", "attachments", "userInput")
                values = [sections.get(name) if sections and isinstance(sections.get(name), dict) else None for name in names]
                if sections is None or any(value is None for value in values):
                    return "CONTEXT_USAGE_INVALID"
                retained_total = 0
                for section in values:
                    original = section.get("originalTokens", -1)
                    retained = section.get("retainedTokens", -1)
                    if (
                        retained > original
                        or (section.get("status") == "retained" and retained != original)
                        or (section.get("status") == "truncated" and retained >= original)
                        or (section.get("status") == "omitted" and retained != 0)
                    ):
                        return "CONTEXT_USAGE_INVALID"
                    retained_total += retained
                estimated = payload.get("estimatedInputTokens", -1)
                actual = payload.get("actualInputTokens")
                limit = payload.get("modelLimitTokens", -1)
                occupied = (actual if actual is not None else estimated) + payload.get("reservedOutputTokens", -1) + payload.get("safetyMarginTokens", -1)
                revision = payload.get("contextRevision", -1)
                if (
                    retained_total != estimated
                    or (payload.get("isEstimate") is True) != (actual is None)
                    or occupied > limit
                    or payload.get("remainingTokens") != limit - occupied
                    or payload.get("utilizationBasisPoints") != (occupied * 10000) // limit
                    or revision < previous_context_revision
                    or (revision == previous_context_revision and previous_context_was_estimate is not True)
                    or (revision == previous_context_revision and payload.get("isEstimate") is not False)
                ):
                    return "CONTEXT_USAGE_INVALID"
                previous_context_revision = revision
                previous_context_was_estimate = payload.get("isEstimate") is True
            if event_type == "budget.updated":
                budget_revision = payload.get("budgetRevision", -1)
                usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else None
                totals = usage.get("totals") if usage and isinstance(usage.get("totals"), dict) else None
                budget = payload.get("budget") if isinstance(payload.get("budget"), dict) else None
                if (
                    budget_revision <= previous_budget_revision
                    or totals is None
                    or budget is None
                    or payload.get("possibleDuplicateCostUsd") != totals.get("possibleDuplicateCostUsd")
                    or payload.get("exhausted") != budget.get("exhausted")
                ):
                    return "BUDGET_INVALID"
                previous_budget_revision = budget_revision
                if payload.get("exhausted") is True:
                    exhausted_budget_seq = seq
            display = payload.get("display") if payload and isinstance(payload.get("display"), dict) else None
            if display and event_type == "tool.started" and any(
                display.get(key) is not None
                for key in ("resultSummary", "errorMessage", "resultCount", "resultType", "durationMs", "costUsd", "errorCode")
            ):
                return "EVENT_STATE_INVALID"
            if display and event_type == "tool.completed":
                usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else None
                expected_cost = usage.get("actualCostUsd") if usage and usage.get("actualCostUsd") is not None else (usage.get("estimatedCostUsd") if usage else None)
                if (
                    display.get("resultCount") != payload.get("resultCount")
                    or display.get("durationMs") != payload.get("durationMs")
                    or display.get("costUsd") != expected_cost
                    or display.get("errorCode") is not None
                    or display.get("errorMessage") is not None
                ):
                    return "EVENT_STATE_INVALID"
            if display and event_type == "tool.failed":
                usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else None
                expected_cost = usage.get("actualCostUsd") if usage and usage.get("actualCostUsd") is not None else (usage.get("estimatedCostUsd") if usage else None)
                if (
                    display.get("errorCode") != payload.get("errorCode")
                    or display.get("resultSummary") is not None
                    or display.get("durationMs") != payload.get("durationMs")
                    or display.get("costUsd") != expected_cost
                ):
                    return "EVENT_STATE_INVALID"
            if display and event_type == "tool.unknown":
                usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else None
                if (
                    usage is None
                    or display.get("attemptStatus") != "unknown"
                    or display.get("errorCode") != payload.get("errorCode")
                    or display.get("resultSummary") is not None
                    or display.get("durationMs") != payload.get("durationMs")
                    or display.get("costUsd") != usage.get("estimatedCostUsd")
                    or usage.get("actualCostUsd") is not None
                    or (SearchAgentV2ContractValidator._usd_micros(usage.get("possibleDuplicateCostUsd")) or 0) <= 0
                    or payload.get("nextAction") != "check_operation"
                ):
                    return "EVENT_STATE_INVALID"
            if event_type in expected_status and event.get("status") != expected_status[event_type]:
                return "EVENT_STATE_INVALID"
            if event_type in TERMINAL_EVENT_TYPES and isinstance(payload.get("budget"), dict):
                if any(
                    isinstance(counter, dict)
                    and "reserved" in counter
                    and counter.get("reserved") not in {0, "0"}
                    for counter in payload["budget"].values()
                ):
                    return "BUDGET_INVALID"
        starts = [event["payload"].get("toolCallId") for event in events if event.get("type") == "tool.started"]
        ends = [
            event["payload"].get("toolCallId")
            for event in events
            if event.get("type") in {"tool.completed", "tool.failed", "tool.unknown"}
        ]
        if len(set(starts)) != len(starts) or len(set(ends)) != len(ends):
            return "TOOL_CALL_DUPLICATE"
        if len(starts) != len(ends) or any(call_id not in ends for call_id in starts):
            return "TOOL_CALL_DANGLING"
        node_starts = [event for event in events if event.get("type") == "node.started" and isinstance(event.get("payload"), dict)]
        node_ends = [
            event for event in events
            if event.get("type") in {"node.completed", "node.failed"} and isinstance(event.get("payload"), dict)
        ]
        started_node_ids = [event["payload"].get("nodeExecutionId") for event in node_starts]
        ended_node_ids = [event["payload"].get("nodeExecutionId") for event in node_ends]
        if len(set(started_node_ids)) != len(started_node_ids) or len(set(ended_node_ids)) != len(ended_node_ids):
            return "EVENT_STATE_INVALID"
        for ended in node_ends:
            payload = ended["payload"]
            execution_id = payload.get("nodeExecutionId")
            started = next((event for event in node_starts if event["payload"].get("nodeExecutionId") == execution_id), None)
            if (
                started is None
                or started.get("seq", -1) >= ended.get("seq", -1)
                or started.get("runId") != ended.get("runId")
                or started.get("inputRevision") != ended.get("inputRevision")
                or any(started["payload"].get(key) != payload.get(key) for key in ("node", "executionKind", "ordinal", "attemptNumber"))
            ):
                return "EVENT_STATE_INVALID"
        clarification_required = [
            event["payload"].get("clarificationId")
            for event in events
            if event.get("type") == "clarification.required"
        ]
        clarification_resumed = [
            event["payload"].get("clarificationId")
            for event in events
            if event.get("type") == "clarification.resumed"
        ]
        if (
            len(set(clarification_required)) != len(clarification_required)
            or len(set(clarification_resumed)) != len(clarification_resumed)
            or any(item not in clarification_required for item in clarification_resumed)
        ):
            return "EVENT_STATE_INVALID"
        message_starts = [event for event in events if event.get("type") == "message.started" and isinstance(event.get("payload"), dict)]
        message_completes = [event for event in events if event.get("type") == "message.completed" and isinstance(event.get("payload"), dict)]
        started_message_ids = [event["payload"].get("messageId") for event in message_starts]
        completed_message_ids = [event["payload"].get("messageId") for event in message_completes]
        if len(set(started_message_ids)) != len(started_message_ids) or len(set(completed_message_ids)) != len(completed_message_ids):
            return "EVENT_STATE_INVALID"
        for completed in message_completes:
            payload = completed["payload"]
            message_id = payload.get("messageId")
            started = next((event for event in message_starts if event["payload"].get("messageId") == message_id), None)
            refs = completed.get("refs") if isinstance(completed.get("refs"), dict) else {}
            if (
                started is None
                or started.get("seq", -1) >= completed.get("seq", -1)
                or started["payload"].get("role") != payload.get("role")
                or started.get("inputRevision") != completed.get("inputRevision")
                or refs.get("messageId") != message_id
                or (payload.get("role") == "assistant" and refs.get("responseId") != payload.get("responseId"))
            ):
                return "EVENT_STATE_INVALID"
        response = bundle.get("response") if isinstance(bundle.get("response"), dict) else None
        terminal_event = next((event for event in events if event.get("type") in TERMINAL_EVENT_TYPES), None)
        if terminal_event and any(execution_id not in ended_node_ids for execution_id in started_node_ids):
            return "EVENT_STATE_INVALID"
        if terminal_event and terminal_event.get("type") == "run.completed":
            payload = terminal_event.get("payload")
            terminal_revision = terminal_event.get("inputRevision", -1)
            verifications = [
                event for event in events
                if event.get("type") == "verification.completed"
                and event.get("inputRevision") == terminal_revision
                and isinstance(event.get("payload"), dict)
            ]
            verification = verifications[-1] if verifications else None
            assistant_message = next(
                (
                    event for event in reversed(message_completes)
                    if event.get("inputRevision") == terminal_revision and event["payload"].get("role") == "assistant"
                ),
                None,
            )
            if (
                response is None
                or verification is None
                or assistant_message is None
                or verification.get("seq", -1) >= assistant_message.get("seq", -1)
                or assistant_message.get("seq", -1) >= terminal_event.get("seq", -1)
                or payload.get("responseId") != response.get("responseId")
                or payload.get("responseStatus") != response.get("status")
                or payload.get("stopReason") != response.get("stopReason")
                or not same_json(payload.get("usage"), response.get("usage"))
                or assistant_message["payload"].get("responseId") != response.get("responseId")
                or assistant_message["payload"].get("verified") is not True
                or assistant_message.get("refs", {}).get("responseId") != response.get("responseId")
                or (response.get("status") == "completed" and verification["payload"].get("passed") is not True)
            ):
                return "EVENT_STATE_INVALID"
        memory_events = [event for event in events if event.get("type") == "memory.updated" and isinstance(event.get("payload"), dict)]
        if memory_events:
            if terminal_event is None or terminal_event.get("type") != "run.completed" or response is None:
                return "MEMORY_WRITE_INVALID"
            terminal_revision = terminal_event.get("inputRevision", -1)
            verification = next(
                (
                    event for event in reversed(events)
                    if event.get("type") == "verification.completed"
                    and event.get("inputRevision") == terminal_revision
                    and isinstance(event.get("payload"), dict)
                    and event["payload"].get("passed") is True
                ),
                None,
            )
            assistant_message = next(
                (
                    event for event in reversed(message_completes)
                    if event.get("inputRevision") == terminal_revision
                    and event["payload"].get("role") == "assistant"
                    and event["payload"].get("responseId") == response.get("responseId")
                ),
                None,
            )
            if verification is None or assistant_message is None:
                return "MEMORY_WRITE_INVALID"
            for memory_event in memory_events:
                if (
                    memory_event["payload"].get("sourceResponseId") != response.get("responseId")
                    or memory_event.get("seq", -1) <= assistant_message.get("seq", -1)
                    or memory_event.get("seq", -1) >= terminal_event.get("seq", -1)
                    or memory_event.get("inputRevision") != terminal_revision
                ):
                    return "MEMORY_WRITE_INVALID"
        return None

    @staticmethod
    def _validate_commands(bundle: dict[str, Any]) -> str | None:
        commands = [item for item in bundle.get("steeringCommands", []) if isinstance(item, dict)]
        if any(not same_scope(bundle.get("scope"), command.get("scope")) for command in commands):
            return "COMMAND_SCOPE_MISMATCH"
        state = bundle.get("agentState") if isinstance(bundle.get("agentState"), dict) else None
        events = [item for item in bundle.get("events", []) if isinstance(item, dict)]
        terminal_event = next((event for event in events if event.get("type") in TERMINAL_EVENT_TYPES), None)
        terminal_at = terminal_event.get("occurredAt") if terminal_event else (state.get("updatedAt") if state and state.get("terminalStatus") else None)
        if terminal_at and any(command.get("createdAt", "") > terminal_at for command in commands):
            return "COMMAND_AFTER_TERMINAL"

        by_command_id: dict[str, dict[str, Any]] = {}
        by_idempotency: dict[str, dict[str, Any]] = {}
        for command in commands:
            command_id = command.get("commandId")
            key = command.get("idempotencyKey")
            if not command_id or not key:
                return "COMMAND_REVISION_CONFLICT"
            previous_command = by_command_id.get(command_id)
            if previous_command and (
                previous_command.get("idempotencyKey") != key
                or previous_command.get("contentHash") != command.get("contentHash")
            ):
                return "COMMAND_REVISION_CONFLICT"
            previous = by_idempotency.get(key)
            if previous and (
                previous.get("commandId") != command.get("commandId")
                or previous.get("contentHash") != command.get("contentHash")
            ):
                return "COMMAND_REVISION_CONFLICT"
            by_command_id[command_id] = command
            by_idempotency[key] = command

        observed_revision: int | None = None
        latest_applied_input_revision = -1
        last_decision_command_seq = 0
        accepted_command_ids: set[str] = set()
        active_batch: dict[str, Any] | None = None

        def close_batch() -> bool:
            nonlocal active_batch, observed_revision, latest_applied_input_revision
            if active_batch is None or active_batch["appliedCount"] < 1:
                return False
            observed_revision = active_batch["next"]
            latest_applied_input_revision = active_batch["inputRevision"]
            active_batch = None
            return True

        for event in events:
            payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
            event_type = event.get("type")
            is_batch_decision = event_type in {"guidance.applied", "guidance.superseded"}
            if not is_batch_decision and active_batch is not None and not close_batch():
                return "COMMAND_REVISION_CONFLICT"

            if event_type == "guidance.accepted":
                command_id = payload.get("commandId")
                command = by_command_id.get(command_id)
                expected = payload.get("expectedSteeringRevision")
                current = payload.get("currentSteeringRevision")
                if (
                    command is None
                    or command_id in accepted_command_ids
                    or expected != command.get("expectedSteeringRevision")
                    or current != expected
                    or payload.get("idempotencyKey") != command.get("idempotencyKey")
                ):
                    return "COMMAND_REVISION_CONFLICT"
                if observed_revision is None:
                    observed_revision = current
                if current != observed_revision:
                    return "COMMAND_REVISION_CONFLICT"
                accepted_command_ids.add(command_id)

            if is_batch_decision:
                batch_id = payload.get("batchId")
                command_id = payload.get("commandId")
                command_seq = payload.get("commandSeq", -1)
                previous_revision = payload.get("previousSteeringRevision", -1)
                next_revision = payload.get("newSteeringRevision", -1)
                input_revision = event.get("inputRevision", -1)
                if (
                    not batch_id
                    or command_id not in accepted_command_ids
                    or command_seq <= last_decision_command_seq
                    or next_revision != previous_revision + 1
                ):
                    return "COMMAND_REVISION_CONFLICT"
                if active_batch is None:
                    if observed_revision is None:
                        observed_revision = previous_revision
                    if observed_revision != previous_revision:
                        return "COMMAND_REVISION_CONFLICT"
                    active_batch = {
                        "id": batch_id,
                        "previous": previous_revision,
                        "next": next_revision,
                        "inputRevision": input_revision,
                        "appliedCount": 0,
                    }
                elif (
                    active_batch["id"] != batch_id
                    or active_batch["previous"] != previous_revision
                    or active_batch["next"] != next_revision
                    or active_batch["inputRevision"] != input_revision
                ):
                    return "COMMAND_REVISION_CONFLICT"
                if event_type == "guidance.applied":
                    active_batch["appliedCount"] += 1
                last_decision_command_seq = command_seq

            if event_type == "guidance.rejected" and payload.get("code") == "COMMAND_REVISION_CONFLICT":
                command = by_command_id.get(payload.get("commandId"))
                if command is None or command.get("expectedSteeringRevision") == payload.get("actualSteeringRevision"):
                    return "COMMAND_REVISION_CONFLICT"

            if (
                latest_applied_input_revision >= 0
                and event_type in {"node.completed", "verification.completed", "message.completed", "run.completed"}
                and event.get("inputRevision", -1) < latest_applied_input_revision
            ):
                return "COMMAND_REVISION_CONFLICT"

        if active_batch is not None and not close_batch():
            return "COMMAND_REVISION_CONFLICT"
        if state is not None and observed_revision is not None and state.get("steeringRevision") != observed_revision:
            return "COMMAND_REVISION_CONFLICT"
        return None

    @staticmethod
    def _validate_queue(bundle: dict[str, Any]) -> str | None:
        queue_events = [item for item in bundle.get("queueEvents", []) if isinstance(item, dict)]
        latest_queue_payload = queue_events[-1]["payload"] if queue_events else None
        explicit_entries = [item for item in bundle.get("queueEntries", []) if isinstance(item, dict)]
        entries = explicit_entries or ([item for item in latest_queue_payload.get("entries", []) if isinstance(item, dict)] if latest_queue_payload else [])

        def validate_snapshot(snapshot_entries: list[dict[str, Any]], payload: dict[str, Any] | None, revision: int | None) -> str | None:
            if revision is not None and any(entry.get("queueRevision") != revision for entry in snapshot_entries):
                return "QUEUE_REVISION_CONFLICT"
            active_entries = [entry for entry in snapshot_entries if entry.get("status") in {"starting", "running"}]
            if len(active_entries) > 1:
                return "QUEUE_ACTIVE_RUN_CONFLICT"
            if payload is not None:
                active_run_ids = sorted(payload.get("activeRunIds", []))
                entry_run_ids = sorted(entry.get("runId") for entry in active_entries)
                if active_run_ids != entry_run_ids:
                    return "QUEUE_ACTIVE_RUN_CONFLICT"
            queued = sorted((entry for entry in snapshot_entries if entry.get("status") == "queued"), key=lambda item: item.get("position", 0))
            if any(entry.get("position") != index for index, entry in enumerate(queued)):
                return "QUEUE_ORDER_INVALID"
            if any(queued[index - 1].get("createdAt") > queued[index].get("createdAt") for index in range(1, len(queued))):
                return "QUEUE_ORDER_INVALID"
            return None

        previous_revision = -1
        previous_cursor = 0
        for event in queue_events:
            revision = event.get("queueRevision", -1)
            cursor = event.get("queueCursor", -1)
            expected_previous = event["payload"].get("expectedPreviousRevision", -1)
            if event.get("threadId") != event.get("scope", {}).get("threadId"):
                return "SCOPE_MISMATCH"
            if revision <= previous_revision or cursor <= previous_cursor:
                return "QUEUE_REVISION_CONFLICT"
            if expected_previous != (previous_revision if previous_revision >= 0 else revision - 1):
                return "QUEUE_REVISION_CONFLICT"
            previous_revision = revision
            previous_cursor = cursor
            if snapshot_error := validate_snapshot(
                [item for item in event["payload"].get("entries", []) if isinstance(item, dict)],
                event["payload"],
                revision,
            ):
                return snapshot_error
        snapshot_revision = previous_revision if previous_revision >= 0 else (entries[0].get("queueRevision") if entries else None)
        if entry_error := validate_snapshot(entries, latest_queue_payload, snapshot_revision):
            return entry_error

        terminal_event = next(
            (event for event in reversed(bundle.get("events", [])) if isinstance(event, dict) and event.get("type") in TERMINAL_EVENT_TYPES),
            None,
        )
        terminal_type = terminal_event.get("type") if terminal_event else None
        if queue_events and terminal_type == "run.cancelled" and (
            latest_queue_payload.get("paused") is not True or latest_queue_payload.get("pauseReason") != "stopped"
        ):
            return "QUEUE_PAUSE_INVALID"
        if queue_events and terminal_type == "run.failed" and (
            latest_queue_payload.get("paused") is not True or latest_queue_payload.get("pauseReason") != "failed"
        ):
            return "QUEUE_PAUSE_INVALID"
        if queue_events and terminal_event and queue_events[-1].get("occurredAt", "") < terminal_event.get("occurredAt", ""):
            return "QUEUE_REVISION_CONFLICT"
        auto_start = latest_queue_payload is not None and latest_queue_payload.get("autoStartNext") is True
        active_entries = [entry for entry in entries if entry.get("status") in {"starting", "running"}]
        if terminal_type == "run.completed" and auto_start and any(entry.get("status") == "queued" for entry in entries) and not active_entries:
            return "QUEUE_ORDER_INVALID"
        trigger = latest_queue_payload.get("trigger") if latest_queue_payload and isinstance(latest_queue_payload.get("trigger"), dict) else None
        if trigger and trigger.get("terminalStatus") == "cancelled" and (
            latest_queue_payload.get("paused") is not True or latest_queue_payload.get("pauseReason") != "stopped"
        ):
            return "QUEUE_PAUSE_INVALID"
        if trigger and trigger.get("terminalStatus") == "failed" and (
            latest_queue_payload.get("paused") is not True or latest_queue_payload.get("pauseReason") != "failed"
        ):
            return "QUEUE_PAUSE_INVALID"
        if trigger and trigger.get("terminalStatus") == "completed" and auto_start and any(
            entry.get("status") == "queued" for entry in entries
        ) and not active_entries:
            return "QUEUE_ORDER_INVALID"
        return None
