"""Private query-strategy contracts and deterministic admission gates.

The model proposes a brief and executable queries. This module never invents
user intent: it validates bounded structure, channel syntax, hard-constraint
retention, lineage, and duplicate risk before any external tool can run.
"""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from collections.abc import Iterable, Mapping, Sequence
from datetime import date
from difflib import SequenceMatcher
from typing import Annotated, Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    WithJsonSchema,
    field_validator,
    model_validator,
)

ResearchChannel = Literal["web", "x", "xiaohongshu"]
QueryComplexity = Literal["simple", "multi_faceted", "multi_hop"]
EvidenceType = Literal[
    "official",
    "primary",
    "independent",
    "social",
    "comparison",
    "field",
]
RewriteStrategy = Literal[
    "initial_precise",
    "terminology_variant",
    "facet_expansion",
    "source_targeting",
    "broaden_should",
    "date_narrowing",
    "channel_fallback",
    "conflict_resolution",
    "field_completion",
]
GapKind = Literal[
    "no_results",
    "no_readable_evidence",
    "missing_claim",
    "missing_constraint",
    "missing_channel",
    "conflicting_sources",
    "missing_field",
]

_SUBJECT_GAP_KINDS = frozenset({
    "missing_claim",
    "conflicting_sources",
    "missing_field",
})

_ID_PATTERN = r"^[A-Za-z0-9_.:-]+$"
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
_INTERNAL_DIRECTIVE = re.compile(
    r"(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|prior|system|developer)"
    r"|(?:reveal|print|show|return).{0,40}(?:system\s+prompt|developer\s+message|"
    r"hidden\s+(?:prompt|instruction|chain\s+of\s+thought))"
    r"|(?:system|developer)\s+(?:prompt|message|instruction)"
    r"|(?:忽略|覆盖).{0,16}(?:系统|开发者|先前|以上).{0,12}(?:提示|指令|消息)"
    r"|(?:泄露|显示|输出).{0,16}(?:系统提示|开发者消息|隐藏指令|思维链)",
    re.IGNORECASE,
)
_KNOWN_CHANNELS = frozenset({"web", "x", "xiaohongshu"})
_PROVIDER_ISO_DATE_SCHEMA = {
    "type": "string",
    "pattern": r"^\d{4}-\d{2}-\d{2}$",
}
ProviderIsoDate = Annotated[date, WithJsonSchema(_PROVIDER_ISO_DATE_SCHEMA)]


class QueryGateError(ValueError):
    """Fail-closed query admission error with a stable machine code."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class QueryStrategyModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


def _bounded_text(value: str, *, maximum: int, label: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{label} 必须是文本")
    if not value or len(value) > maximum:
        raise ValueError(f"{label} 长度必须在 1 到 {maximum} 之间")
    if _CONTROL.search(value):
        raise ValueError(f"{label} 不得包含控制字符")
    normalized = " ".join(unicodedata.normalize("NFKC", value).split())
    if not normalized or _INTERNAL_DIRECTIVE.search(normalized):
        raise ValueError(f"{label} 包含内部指令式内容")
    return normalized


def _bounded_text_list(
    values: list[str],
    *,
    maximum_items: int,
    maximum_chars: int,
    label: str,
) -> list[str]:
    if len(values) > maximum_items:
        raise ValueError(f"{label} 数量不得超过 {maximum_items}")
    normalized = [
        _bounded_text(item, maximum=maximum_chars, label=label) for item in values
    ]
    if len(normalized) != len({item.casefold() for item in normalized}):
        raise ValueError(f"{label} 不得重复")
    return normalized


class QueryConstraint(QueryStrategyModel):
    constraint_id: str = Field(min_length=1, max_length=64, pattern=_ID_PATTERN)
    text: str = Field(min_length=1, max_length=160)
    terms: list[str] = Field(min_length=1, max_length=6)

    @field_validator("text")
    @classmethod
    def validate_text(cls, value: str) -> str:
        return _bounded_text(value, maximum=160, label="约束")

    @field_validator("terms")
    @classmethod
    def validate_terms(cls, value: list[str]) -> list[str]:
        return _bounded_text_list(
            value,
            maximum_items=6,
            maximum_chars=80,
            label="约束词",
        )


class QueryTimeRange(QueryStrategyModel):
    start_date: ProviderIsoDate
    end_date: ProviderIsoDate
    source_text: str = Field(min_length=1, max_length=120)
    resolved_on: ProviderIsoDate

    @field_validator("source_text")
    @classmethod
    def validate_source_text(cls, value: str) -> str:
        return _bounded_text(value, maximum=120, label="时间原文")

    @model_validator(mode="after")
    def validate_range(self) -> QueryTimeRange:
        if self.start_date > self.end_date:
            raise ValueError("time_range end_date 不得早于 start_date")
        return self


class EvidenceFacet(QueryStrategyModel):
    facet_id: str = Field(min_length=1, max_length=64, pattern=_ID_PATTERN)
    description: str = Field(min_length=1, max_length=240)
    evidence_type: EvidenceType
    required_fields: list[str] = Field(min_length=1, max_length=12)

    @field_validator("description")
    @classmethod
    def validate_description(cls, value: str) -> str:
        return _bounded_text(value, maximum=240, label="证据分面")

    @field_validator("required_fields")
    @classmethod
    def validate_required_fields(cls, value: list[str]) -> list[str]:
        return _bounded_text_list(
            value,
            maximum_items=12,
            maximum_chars=80,
            label="请求字段",
        )


class QueryBrief(QueryStrategyModel):
    version: Literal[1]
    objective: str = Field(min_length=1, max_length=500)
    complexity: QueryComplexity
    entities: list[str] = Field(max_length=12)
    must: list[QueryConstraint] = Field(max_length=12)
    should: list[QueryConstraint] = Field(max_length=12)
    exclude: list[QueryConstraint] = Field(max_length=12)
    time_range: QueryTimeRange | None
    locations: list[str] = Field(max_length=8)
    languages: list[str] = Field(max_length=8)
    required_channels: list[ResearchChannel] = Field(max_length=3)
    requested_fields: list[str] = Field(max_length=12)
    evidence_facets: list[EvidenceFacet] = Field(min_length=1, max_length=8)

    @field_validator("objective")
    @classmethod
    def validate_objective(cls, value: str) -> str:
        return _bounded_text(value, maximum=500, label="检索目标")

    @field_validator("entities")
    @classmethod
    def validate_entities(cls, value: list[str]) -> list[str]:
        return _bounded_text_list(
            value,
            maximum_items=12,
            maximum_chars=120,
            label="实体",
        )

    @field_validator("locations")
    @classmethod
    def validate_locations(cls, value: list[str]) -> list[str]:
        return _bounded_text_list(
            value,
            maximum_items=8,
            maximum_chars=100,
            label="地域",
        )

    @field_validator("languages")
    @classmethod
    def validate_languages(cls, value: list[str]) -> list[str]:
        normalized = _bounded_text_list(
            value,
            maximum_items=8,
            maximum_chars=35,
            label="语言",
        )
        if any(not re.fullmatch(r"[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,8})?", item) for item in normalized):
            raise ValueError("语言必须使用 BCP-47 风格标签")
        return normalized

    @field_validator("requested_fields")
    @classmethod
    def validate_requested_fields(cls, value: list[str]) -> list[str]:
        return _bounded_text_list(
            value,
            maximum_items=12,
            maximum_chars=80,
            label="请求字段",
        )

    @model_validator(mode="after")
    def validate_unique_ids(self) -> QueryBrief:
        constraints = [*self.must, *self.should, *self.exclude]
        constraint_ids = [item.constraint_id for item in constraints]
        if len(constraint_ids) != len(set(constraint_ids)):
            raise ValueError("约束 constraint_id 必须唯一")
        facet_ids = [item.facet_id for item in self.evidence_facets]
        if len(facet_ids) != len(set(facet_ids)):
            raise ValueError("证据 facet_id 必须唯一")
        if len(self.required_channels) != len(set(self.required_channels)):
            raise ValueError("required_channels 不得重复")
        return self


class EvidenceGapProposal(QueryStrategyModel):
    gap_id: str = Field(min_length=1, max_length=64, pattern=_ID_PATTERN)
    facet_id: str = Field(min_length=1, max_length=64, pattern=_ID_PATTERN)
    kind: GapKind
    subject: str | None
    description: str = Field(min_length=1, max_length=300)
    missing_constraint_ids: list[str] = Field(max_length=12)
    required_channel: ResearchChannel | None
    evidence_type: EvidenceType
    priority: int = Field(ge=0, le=100)

    @field_validator("description")
    @classmethod
    def validate_description(cls, value: str) -> str:
        return _bounded_text(value, maximum=300, label="证据缺口")

    @field_validator("subject")
    @classmethod
    def validate_subject(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return _bounded_text(value, maximum=100, label="缺口目标")

    @field_validator("missing_constraint_ids")
    @classmethod
    def validate_missing_ids(cls, value: list[str]) -> list[str]:
        if len(value) != len(set(value)):
            raise ValueError("missing_constraint_ids 不得重复")
        if any(not re.fullmatch(_ID_PATTERN, item) for item in value):
            raise ValueError("missing_constraint_ids 格式无效")
        return value

    @model_validator(mode="after")
    def validate_subject_contract(self) -> EvidenceGapProposal:
        if self.kind in _SUBJECT_GAP_KINDS and self.subject is None:
            raise ValueError("主张、冲突或字段缺口必须显式指定 subject")
        if self.kind not in _SUBJECT_GAP_KINDS and self.subject is not None:
            raise ValueError("分面、约束或渠道级缺口的 subject 必须为 null")
        return self


def _canonical_text(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


def normalize_query_brief(
    raw: QueryBrief | Mapping[str, Any] | None,
    *,
    question: str,
    channels: Sequence[str],
    current_date: str,
) -> QueryBrief:
    """Load current state strictly; upgrade pre-v1 checkpoints conservatively."""

    try:
        resolved = date.fromisoformat(current_date)
    except ValueError as exc:
        raise QueryGateError("QUERY_BRIEF_DATE_INVALID", "运行日期格式无效") from exc

    def ensure_current_date(value: QueryBrief) -> QueryBrief:
        if value.time_range is not None and value.time_range.resolved_on != resolved:
            raise QueryGateError(
                "QUERY_BRIEF_DATE_STALE",
                "相对时间查询简报不是在当前运行日期解析的",
            )
        return value

    if isinstance(raw, QueryBrief):
        return ensure_current_date(raw)
    if isinstance(raw, Mapping):
        if raw.get("version") == 1:
            try:
                return ensure_current_date(QueryBrief.model_validate(raw))
            except ValidationError as exc:
                raise QueryGateError("QUERY_BRIEF_INVALID", "查询简报状态无效") from exc
        if "version" in raw:
            raise QueryGateError(
                "QUERY_BRIEF_VERSION_UNSUPPORTED",
                "查询简报版本不受支持",
            )
        if set(raw) - {"objective"} or (
            "objective" in raw and not isinstance(raw.get("objective"), str)
        ):
            raise QueryGateError(
                "QUERY_BRIEF_INVALID",
                "无版本查询简报不是可识别的旧 checkpoint",
            )
    del question
    allowed = [
        item for item in dict.fromkeys(str(value) for value in channels)
        if item in _KNOWN_CHANNELS
    ]
    return QueryBrief(
        version=1,
        objective="检索当前用户请求所需的可核验证据",
        complexity="multi_faceted",
        entities=[],
        must=[],
        should=[],
        exclude=[],
        time_range=None,
        locations=[],
        languages=[],
        required_channels=allowed or ["web"],  # type: ignore[arg-type]
        requested_fields=[],
        evidence_facets=[EvidenceFacet(
            facet_id="general",
            description="当前用户请求的可核验证据",
            evidence_type="independent",
            required_fields=["可核验证据"],
        )],
    )


def _location_id(value: str) -> str:
    digest = hashlib.sha256(_canonical_text(value).encode("utf-8")).hexdigest()[:12]
    return f"location:{digest}"


def hard_constraint_ids(brief: QueryBrief) -> tuple[str, ...]:
    values = [item.constraint_id for item in brief.must]
    values.extend(item.constraint_id for item in brief.exclude)
    if brief.time_range is not None:
        values.append("time_range")
    values.extend(_location_id(item) for item in brief.locations)
    values.extend(f"required_channel:{item}" for item in brief.required_channels)
    return tuple(values)


def constraint_signature(brief: QueryBrief) -> str:
    payload = {
        "must": [item.model_dump(mode="json") for item in brief.must],
        "exclude": [item.model_dump(mode="json") for item in brief.exclude],
        "timeRange": (
            brief.time_range.model_dump(mode="json")
            if brief.time_range is not None
            else None
        ),
        "locations": brief.locations,
        "requiredChannels": brief.required_channels,
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def complete_retained_should_metadata(
    brief: QueryBrief,
    proposal: Mapping[str, Any],
) -> dict[str, Any]:
    """Complete only redundant should IDs already proven by the query text."""

    repaired = dict(proposal)
    retained = list(_value(repaired, "retained_constraint_ids", []) or [])
    relaxed = set(_value(repaired, "relaxed_should_ids", []) or [])
    accounted = set(retained) | relaxed
    query = str(_value(repaired, "query") or "")
    for item in brief.should:
        if item.constraint_id in accounted:
            continue
        if (
            any(_positive_term_present(query, term) for term in item.terms)
            and not _negative_term_present(query, item.terms)
        ):
            retained.append(item.constraint_id)
            accounted.add(item.constraint_id)
    repaired["retained_constraint_ids"] = retained
    return repaired


_CHANNEL_OPERATOR_VALUE = re.compile(
    r'(?<!\S)-?[A-Za-z_]+:(?:"[^"\r\n]*"|\S+)'
)
_NEGATED_QUERY_VALUE = re.compile(r'(?<!\S)-(?:"[^"\r\n]*"|\S+)')
_BOOLEAN_QUERY_OPERATOR = re.compile(r"(?<!\S)(?:AND|OR|NOT)(?!\S)", re.IGNORECASE)


def _remove_query_term(value: str, term: str) -> str:
    normalized_term = unicodedata.normalize("NFKC", term).strip().strip('"')
    if not normalized_term:
        return value
    if re.search(r"[A-Za-z0-9]", normalized_term):
        pattern = rf"(?<![A-Za-z0-9_]){re.escape(normalized_term)}(?![A-Za-z0-9_])"
        return re.sub(pattern, " ", value, flags=re.IGNORECASE)
    return re.sub(re.escape(normalized_term), " ", value)


def _xiaohongshu_natural_query(brief: QueryBrief, query: str) -> str:
    """Remove cross-channel syntax without weakening the private brief.

    Xiaohongshu accepts compact natural keywords, not Web/X operators or
    boolean exclusions.  The adapter removes only syntax and terms the brief
    explicitly marks as excluded; the normal admission gate then re-adds and
    verifies every positive hard/retained constraint from the model brief.
    """

    normalized = " ".join(unicodedata.normalize("NFKC", query).split())
    normalized = _CHANNEL_OPERATOR_VALUE.sub(" ", normalized)
    normalized = _NEGATED_QUERY_VALUE.sub(" ", normalized)
    normalized = _BOOLEAN_QUERY_OPERATOR.sub(" ", normalized)
    for item in brief.exclude:
        for term in item.terms:
            normalized = _remove_query_term(normalized, term)
    tokens = [
        token for token in normalized.split()
        if token.strip('"\'') and not token.startswith("-")
    ]
    return " ".join(tokens)


def complete_query_constraint_terms(
    brief: QueryBrief,
    proposal: Mapping[str, Any],
    *,
    complete_all_should: bool = False,
) -> dict[str, Any]:
    """Repair a proposal only with constraints already present in ``brief``.

    Positive constraints are repaired additively and the requested channel is
    never changed.  Xiaohongshu receives one bounded syntax-only normalization
    before the same hard-constraint and exclusion gates run.
    """

    raw = dict(proposal)
    strategy = str(_value(raw, "strategy") or "")
    should_ids = {item.constraint_id for item in brief.should}
    raw_relaxed = list(_value(raw, "relaxed_should_ids", []) or [])
    if strategy == "broaden_should":
        raw["relaxed_should_ids"] = [
            item for item in raw_relaxed if item in should_ids
        ]
    else:
        # A relaxation is meaningful only when the strategy records it.  Keep
        # the constraint in the query instead of silently honoring a mismatch.
        raw["relaxed_should_ids"] = []
    repaired = complete_retained_should_metadata(brief, raw)
    channel = str(_value(repaired, "channel") or "")
    query = " ".join(unicodedata.normalize("NFKC", str(_value(repaired, "query") or "")).split())
    if channel == "xiaohongshu":
        query = _xiaohongshu_natural_query(brief, query)
    additions: list[str] = []
    retained = list(_value(repaired, "retained_constraint_ids", []) or [])
    relaxed_ids = list(_value(repaired, "relaxed_should_ids", []) or [])
    relaxed = set(relaxed_ids)
    for constraint_id in hard_constraint_ids(brief):
        if constraint_id not in retained:
            retained.append(constraint_id)
    for item in brief.must:
        if (
            not any(_positive_term_present(query, term) for term in item.terms)
            or _negative_term_present(query, item.terms)
        ):
            additions.append(item.terms[0])
    for item in brief.should:
        if (
            item.constraint_id in retained
            and item.constraint_id not in relaxed
            and not any(_positive_term_present(query, term) for term in item.terms)
            and not _negative_term_present(query, item.terms)
        ):
            additions.append(item.terms[0])
    if complete_all_should:
        for item in brief.should:
            if item.constraint_id in retained or item.constraint_id in relaxed:
                continue
            if strategy == "broaden_should":
                if not any(_positive_term_present(query, term) for term in item.terms):
                    relaxed.add(item.constraint_id)
                    relaxed_ids.append(item.constraint_id)
            else:
                retained.append(item.constraint_id)
                additions.append(item.terms[0])
    for location in brief.locations:
        if not _positive_term_present(query, location) or _negative_term_present(query, [location]):
            additions.append(location)
    if brief.time_range is not None:
        start = brief.time_range.start_date.isoformat()
        end = brief.time_range.end_date.isoformat()
        if channel == "web":
            if not _positive_term_present(query, f"after:{start}"):
                additions.append(f"after:{start}")
            if not _positive_term_present(query, f"before:{end}"):
                additions.append(f"before:{end}")
        elif channel == "x":
            if not _positive_term_present(query, f"since:{start}"):
                additions.append(f"since:{start}")
            if not _positive_term_present(query, f"until:{end}"):
                additions.append(f"until:{end}")
        elif not _positive_term_present(query, start):
            additions.append(start)
        if channel == "xiaohongshu" and not _positive_term_present(query, end):
            additions.append(end)
    for item in brief.exclude:
        if channel == "xiaohongshu" or _negative_term_present(query, item.terms):
            continue
        term = item.terms[0]
        additions.append(f'-"{term}"' if " " in term else f"-{term}")
    required = set(brief.required_channels)
    if required and channel not in required and strategy == "channel_fallback" and channel == "web":
        markers = {
            "x": "site:x.com",
            "xiaohongshu": "site:xiaohongshu.com",
        }
        for required_channel in required:
            marker = markers.get(required_channel)
            if marker and marker not in _canonical_text(query):
                additions.append(marker)
    if additions:
        query = " ".join([query, *additions]).strip()
    repaired["query"] = query
    query_terms = list(_value(repaired, "query_terms", []) or [])
    for term in additions:
        if term not in query_terms and len(query_terms) < 12:
            query_terms.append(term)
    repaired["query_terms"] = query_terms
    repaired["retained_constraint_ids"] = retained
    repaired["relaxed_should_ids"] = relaxed_ids
    return repaired


def complete_query_lineage(
    proposal: Mapping[str, Any],
    *,
    prior_attempts: Sequence[Mapping[str, Any]],
    open_gaps: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    """Repair a follow-up parent while keeping the gap lineage bounded.

    A normal feedback gap must continue from the latest attempt on its own
    facet.  A facet-discovery gap is the one deliberate exception: when the
    newly discovered facet has never been searched, it may start from the
    latest real attempt anywhere in the run.  The validator applies the same
    narrow rule, so this repair cannot broaden lineage for legacy gaps.
    """

    repaired = dict(proposal)
    gap_id = str(_value(repaired, "gap_id") or "")
    if not gap_id or str(_value(repaired, "strategy") or "") == "initial_precise":
        return repaired
    gap = next(
        (
            item
            for item in open_gaps
            if str(item.get("gap_id") or "") == gap_id
            and item.get("status") == "open"
        ),
        None,
    )
    facet_id = str(_value(repaired, "facet_id") or "")
    if gap is None or facet_id != str(gap.get("facet_id") or ""):
        return repaired
    facet_candidates = [
        str(item.get("attempt_id") or "")
        for item in prior_attempts
        if str(item.get("facet_id") or "") == facet_id
        and str(item.get("attempt_id") or "")
    ]
    if facet_candidates:
        candidates = facet_candidates
    elif gap.get("origin") == "facet_discovery":
        candidates = [
            str(item.get("attempt_id") or "")
            for item in prior_attempts
            if str(item.get("attempt_id") or "")
        ]
    else:
        return repaired
    if not candidates:
        # A discovery gap still needs a concrete prior attempt.  Do not turn
        # an empty history into an IndexError or a fabricated lineage.
        return repaired
    parent_id = str(_value(repaired, "parent_attempt_id") or "")
    valid_parent = parent_id in candidates
    if not valid_parent:
        repaired["parent_attempt_id"] = candidates[-1]
    return repaired


def complete_initial_plan_should_metadata(
    brief: QueryBrief,
    proposals: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    """Distribute uncovered optional terms to one bounded initial query."""

    repaired = [dict(item) for item in proposals]
    if not repaired:
        return repaired
    should_by_id = {item.constraint_id: item for item in brief.should}
    accounted = {
        constraint_id
        for item in repaired
        for constraint_id in list(_value(item, "retained_constraint_ids", []) or [])
        if constraint_id in should_by_id
    }
    missing = [
        item for constraint_id, item in should_by_id.items()
        if constraint_id not in accounted
    ]
    for constraint in missing:
        target = min(
            repaired,
            key=lambda item: len(str(_value(item, "query") or "")),
        )
        query = " ".join(
            unicodedata.normalize("NFKC", str(_value(target, "query") or "")).split()
        )
        term = constraint.terms[0]
        if not _positive_term_present(query, term):
            query = f"{query} {term}".strip()
        target["query"] = query
        retained = list(_value(target, "retained_constraint_ids", []) or [])
        if constraint.constraint_id not in retained:
            retained.append(constraint.constraint_id)
        target["retained_constraint_ids"] = retained
        query_terms = list(_value(target, "query_terms", []) or [])
        if term not in query_terms and len(query_terms) < 12:
            query_terms.append(term)
        target["query_terms"] = query_terms
        accounted.add(constraint.constraint_id)
    return repaired


_OPERATOR = re.compile(r"(?<!\S)-?([A-Za-z_]+):")
_WEB_ONLY_OPERATORS = frozenset({"site", "filetype", "after", "before"})
_X_OPERATORS = frozenset({
    "from",
    "to",
    "since",
    "until",
    "lang",
    "has",
    "is",
    "url",
    "conversation_id",
    "in_reply_to_tweet_id",
    "retweets_of",
    "context",
    "entity",
    "place",
    "point_radius",
    "bounding_box",
})


def validate_channel_query(query: str, channel: str) -> str:
    if channel not in _KNOWN_CHANNELS:
        raise QueryGateError("QUERY_CHANNEL_INVALID", "检索渠道无效")
    if not isinstance(query, str) or _CONTROL.search(query):
        raise QueryGateError("QUERY_TEXT_INVALID", "查询文本无效")
    normalized = " ".join(unicodedata.normalize("NFKC", query).split())
    if len(normalized) < 2 or len(normalized) > 300:
        raise QueryGateError("QUERY_LENGTH_INVALID", "查询长度越界")
    operators = {
        match.group(1).casefold()
        for match in _OPERATOR.finditer(normalized)
        if not (
            match.group(1).casefold() in {"http", "https"}
            and normalized[match.end():match.end() + 2] == "//"
        )
    }
    if channel == "web":
        if operators - _WEB_ONLY_OPERATORS:
            raise QueryGateError("QUERY_OPERATOR_UNSUPPORTED", "web 查询包含其他渠道操作符")
    elif channel == "x":
        if operators - _X_OPERATORS:
            raise QueryGateError("QUERY_OPERATOR_UNSUPPORTED", "X 查询包含不支持的操作符")
    else:
        if len(normalized) > 80:
            raise QueryGateError("QUERY_TOO_LONG_FOR_CHANNEL", "小红书查询必须保持紧凑")
        if operators or re.search(
            r"(?:^|\s)(?:AND|OR|NOT)(?:\s|$)",
            normalized,
            re.IGNORECASE,
        ):
            raise QueryGateError("QUERY_OPERATOR_UNSUPPORTED", "小红书查询只允许自然关键词")
        if any(token.startswith("-") for token in normalized.split()):
            raise QueryGateError("QUERY_OPERATOR_UNSUPPORTED", "小红书不支持布尔排除操作符")
    return normalized


def _value(item: Any, key: str, default: Any = None) -> Any:
    if isinstance(item, Mapping):
        return item.get(key, default)
    return getattr(item, key, default)


def _term_matches(query: str, term: str) -> list[re.Match[str]]:
    target = _canonical_text(term).strip('"')
    normalized = _canonical_text(query).strip('"')
    if not target:
        return []
    if not re.search(r"[a-z0-9]", target):
        return list(re.finditer(re.escape(target), normalized))
    return list(re.finditer(
        rf"(?<![a-z0-9_]){re.escape(target)}(?![a-z0-9_])",
        normalized,
    ))


def _negative_occurrence(query: str, start: int) -> bool:
    normalized = _canonical_text(query).strip('"')
    prefix = normalized[:start]
    token_start = prefix.rfind(" ") + 1
    token_prefix = prefix[token_start:]
    if token_prefix.lstrip('"(').startswith("-") or token_prefix.startswith("-"):
        return True
    previous = prefix[:token_start].rstrip()
    return bool(re.search(r"(?:^|\s)(?:not|-)$", previous, re.IGNORECASE))


def _contains_term(query: str, term: str) -> bool:
    return bool(_term_matches(query, term))


def _positive_term_present(query: str, term: str) -> bool:
    return any(not _negative_occurrence(query, match.start()) for match in _term_matches(query, term))


def _has_query_token(query: str, token: str) -> bool:
    normalized = _canonical_text(query)
    target = _canonical_text(token)
    return re.search(
        rf"(?<!\S){re.escape(target)}(?!\S)",
        normalized,
    ) is not None


def _negative_term_present(query: str, terms: Iterable[str]) -> bool:
    normalized = _canonical_text(query)
    negative_operands = {
        _canonical_text(quoted or token).strip('"')
        for quoted, token in re.findall(
            r'(?:^|[\s(])(?:-|not\s+)(?:"([^"]+)"|([^\s)]+))',
            normalized,
        )
    }
    return any(
        _canonical_text(term).strip('"') in negative_operands
        for term in terms
    )


def _time_preserved(brief: QueryBrief, query: str, channel: str) -> bool:
    time_range = brief.time_range
    if time_range is None:
        return True
    start = time_range.start_date.isoformat()
    end = time_range.end_date.isoformat()
    normalized = _canonical_text(query)
    if channel == "web":
        terms = (f"after:{start}", f"before:{end}")
        return all(_positive_term_present(normalized, item) for item in terms)
    if channel == "x":
        terms = (f"since:{start}", f"until:{end}")
        return all(_positive_term_present(normalized, item) for item in terms)
    return all(_positive_term_present(normalized, item) for item in (start, end))


def _site_scope_polarity(query: str, domains: Sequence[str]) -> tuple[bool, bool]:
    positive = False
    negative = False
    normalized = _canonical_text(query)
    for match in re.finditer(
        r"(?:^|\s)(-?)site:([a-z0-9.-]+)(?=\s|$)",
        normalized,
    ):
        host = match.group(2).rstrip(".")
        if not any(host == domain or host.endswith(f".{domain}") for domain in domains):
            continue
        if match.group(1):
            negative = True
        else:
            positive = True
    return positive, negative


def _exact_positive_token(query: str, token: str) -> bool:
    target = _canonical_text(token)
    values = [
        item.strip('\"\'()[]{}.,;')
        for item in _canonical_text(query).split()
    ]
    return target in values


def _platform_boundary_preserved(
    brief: QueryBrief,
    query: str,
    channel: str,
    strategy: str,
    initial: bool,
) -> bool:
    required = set(brief.required_channels)
    if not required or channel in required:
        return True
    if initial or strategy != "channel_fallback" or channel != "web":
        return False
    normalized = _canonical_text(query)
    domains = {
        "x": ("x.com", "twitter.com"),
        "xiaohongshu": ("xiaohongshu.com",),
        "web": (),
    }
    natural_markers = {
        "x": ("twitter",),
        "xiaohongshu": ("小红书",),
        "web": (),
    }
    for item in required:
        positive_site, negative_site = _site_scope_polarity(normalized, domains[item])
        markers = natural_markers[item]
        positive_natural = any(
            _positive_term_present(normalized, marker)
            if not re.search(r"[a-z0-9]", marker)
            else _exact_positive_token(normalized, marker)
            for marker in markers
        )
        negative_natural = _negative_term_present(normalized, markers)
        if negative_site or negative_natural or not (positive_site or positive_natural):
            return False
    return True


_STRATEGIES_BY_GAP: dict[str, frozenset[str]] = {
    "no_results": frozenset({"terminology_variant", "facet_expansion", "broaden_should"}),
    "no_readable_evidence": frozenset({"source_targeting", "channel_fallback"}),
    "missing_claim": frozenset({"facet_expansion", "source_targeting"}),
    "missing_constraint": frozenset({"facet_expansion", "source_targeting", "date_narrowing"}),
    "missing_channel": frozenset({"channel_fallback", "source_targeting"}),
    "conflicting_sources": frozenset({"conflict_resolution", "source_targeting"}),
    "missing_field": frozenset({"field_completion", "source_targeting"}),
}


def _token_set(value: str) -> set[str]:
    normalized = _canonical_text(value)
    latin = re.findall(r"[a-z0-9_.+-]+", normalized)
    cjk_runs = re.findall(r"[\u3400-\u9fff]+", normalized)
    cjk = [
        run if len(run) == 1 else run[index:index + 2]
        for run in cjk_runs
        for index in range(max(1, len(run) - 1))
    ]
    return {*latin, *cjk}


def is_near_duplicate(candidate: Mapping[str, Any], prior: Sequence[Mapping[str, Any]]) -> bool:
    query = _canonical_text(str(candidate.get("query") or ""))
    signature = str(candidate.get("constraint_signature") or "")
    scope = (
        str(candidate.get("channel") or ""),
        str(candidate.get("facet_id") or ""),
        str(candidate.get("gap_id") or ""),
        str(candidate.get("strategy") or ""),
        signature,
    )
    candidate_tokens = _token_set(query)
    for item in prior:
        other_scope = (
            str(item.get("channel") or ""),
            str(item.get("facet_id") or ""),
            str(item.get("gap_id") or ""),
            str(item.get("strategy") or ""),
            str(item.get("constraint_signature") or ""),
        )
        if scope != other_scope:
            continue
        other_query = _canonical_text(str(item.get("query") or ""))
        if query == other_query:
            return True
        other_tokens = _token_set(other_query)
        union = candidate_tokens | other_tokens
        jaccard = len(candidate_tokens & other_tokens) / len(union) if union else 1.0
        if jaccard >= 0.82 or SequenceMatcher(None, query, other_query).ratio() >= 0.9:
            return True
    return False


def stable_attempt_id(run_id: str, iteration: int, proposal: Mapping[str, Any]) -> str:
    payload = {
        "runId": run_id,
        "iteration": iteration,
        "facetId": proposal.get("facet_id"),
        "gapId": proposal.get("gap_id"),
        "parentAttemptId": proposal.get("parent_attempt_id"),
        "strategy": proposal.get("strategy"),
        "query": _canonical_text(str(proposal.get("query") or "")),
        "channel": proposal.get("channel"),
        "constraintSignature": proposal.get("constraint_signature"),
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(encoded.encode("utf-8")).hexdigest()[:24]
    return f"attempt_{digest}"


def _stable_gap_id(run_id: str, proposal: EvidenceGapProposal | Mapping[str, Any]) -> str:
    payload = {
        "runId": run_id,
        "facetId": _value(proposal, "facet_id"),
        "kind": _value(proposal, "kind"),
        "missingConstraintIds": sorted(_value(proposal, "missing_constraint_ids", []) or []),
        "requiredChannel": _value(proposal, "required_channel"),
        "evidenceType": _value(proposal, "evidence_type"),
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(encoded.encode("utf-8")).hexdigest()[:24]
    return f"gap_{digest}"


def _subject_qualified_gap_id(base_id: str, subject: str) -> str:
    encoded = json.dumps(
        {"baseId": base_id, "subject": _canonical_text(subject)},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    digest = hashlib.sha256(encoded.encode("utf-8")).hexdigest()[:24]
    return f"gap_{digest}"


def _gap_subject(
    brief: QueryBrief,
    *,
    facet_id: str,
    kind: str,
    subject: Any,
    description: str,
    infer_legacy: bool,
) -> str | None:
    if kind not in _SUBJECT_GAP_KINDS:
        if subject is not None:
            raise QueryGateError(
                "EVIDENCE_GAP_SUBJECT_INVALID",
                "分面、约束或渠道级 EvidenceGap 不得携带 subject",
            )
        return None
    facet = next(
        (item for item in brief.evidence_facets if item.facet_id == facet_id),
        None,
    )
    allowed_values = [
        *(facet.required_fields if facet is not None else []),
        *brief.requested_fields,
    ]
    allowed = {
        _canonical_text(item): item
        for item in allowed_values
    }
    resolved = subject
    if resolved is None and infer_legacy:
        normalized_description = _canonical_text(description)
        matches = [
            value for key, value in allowed.items()
            if key and key in normalized_description
        ]
        if len(matches) == 1:
            resolved = matches[0]
        elif len(allowed) == 1:
            resolved = next(iter(allowed.values()))
    if resolved is None:
        raise QueryGateError(
            "EVIDENCE_GAP_SUBJECT_MISSING",
            "主张、冲突或字段 EvidenceGap 必须指定稳定目标",
        )
    normalized = _canonical_text(str(resolved))
    if normalized not in allowed:
        raise QueryGateError(
            "EVIDENCE_GAP_SUBJECT_UNKNOWN",
            "EvidenceGap subject 未引用对应分面的已知字段",
        )
    return allowed[normalized]


def reconcile_evidence_gaps(
    brief: QueryBrief,
    prior_gaps: Sequence[Mapping[str, Any]],
    proposals: Sequence[EvidenceGapProposal],
    attempts: Sequence[Mapping[str, Any]],
    *,
    run_id: str,
    iteration: int,
    sufficient: bool,
) -> tuple[list[dict[str, Any]], dict[str, str]]:
    """Assign stable gap IDs and close only after objective linked progress."""

    facet_ids = {item.facet_id for item in brief.evidence_facets}
    constraint_ids = {
        item.constraint_id for item in [*brief.must, *brief.should, *brief.exclude]
    } | set(hard_constraint_ids(brief))
    attempted_facets = {
        str(item.get("facet_id") or "") for item in attempts
    }
    by_id: dict[str, dict[str, Any]] = {}
    semantic_ids: dict[tuple[str, str], str] = {}
    for raw_gap in prior_gaps:
        gap = dict(raw_gap)
        gap_id = str(gap.get("gap_id") or "")
        if not gap_id or gap_id in by_id:
            raise QueryGateError(
                "EVIDENCE_GAP_DUPLICATE",
                "EvidenceGap 稳定 ID 重复或为空",
            )
        if str(gap.get("facet_id") or "") not in facet_ids:
            raise QueryGateError(
                "EVIDENCE_GAP_FACET_UNKNOWN",
                "已有 EvidenceGap 引用了未知分面",
            )
        if not set(gap.get("missing_constraint_ids") or []) <= constraint_ids:
            raise QueryGateError(
                "EVIDENCE_GAP_CONSTRAINT_UNKNOWN",
                "已有 EvidenceGap 引用了未知约束",
            )
        status = gap.get("status")
        if status not in {"open", "closed"}:
            raise QueryGateError(
                "EVIDENCE_GAP_STATE_INVALID",
                "EvidenceGap 状态无效",
            )
        closed_iteration = gap.get("closed_iteration")
        resolver = gap.get("resolved_by_attempt_id")
        if status == "open" and (closed_iteration is not None or resolver is not None):
            raise QueryGateError(
                "EVIDENCE_GAP_STATE_INVALID",
                "open EvidenceGap 不得携带关闭元数据",
            )
        if status == "closed" and closed_iteration is None:
            raise QueryGateError(
                "EVIDENCE_GAP_STATE_INVALID",
                "closed EvidenceGap 必须记录关闭轮次",
            )
        subject = _gap_subject(
            brief,
            facet_id=str(gap.get("facet_id") or ""),
            kind=str(gap.get("kind") or ""),
            subject=gap.get("subject"),
            description=str(gap.get("description") or ""),
            infer_legacy=True,
        )
        gap["subject"] = subject
        semantic_key = (
            _stable_gap_id(run_id, gap),
            _canonical_text(subject or ""),
        )
        if semantic_key in semantic_ids:
            raise QueryGateError(
                "EVIDENCE_GAP_DUPLICATE",
                "已有 EvidenceGap 语义目标重复",
            )
        semantic_ids[semantic_key] = gap_id
        by_id[gap_id] = gap

    prepared: list[tuple[EvidenceGapProposal, str, str | None, tuple[str, str]]] = []
    proposal_semantics: set[tuple[str, str]] = set()
    for proposal in proposals:
        if proposal.facet_id not in facet_ids:
            raise QueryGateError(
                "EVIDENCE_GAP_FACET_UNKNOWN",
                "EvidenceGap 引用了未知分面",
            )
        if not set(proposal.missing_constraint_ids) <= constraint_ids:
            raise QueryGateError(
                "EVIDENCE_GAP_CONSTRAINT_UNKNOWN",
                "EvidenceGap 引用了未知约束",
            )
        subject = _gap_subject(
            brief,
            facet_id=proposal.facet_id,
            kind=proposal.kind,
            subject=proposal.subject,
            description=proposal.description,
            infer_legacy=False,
        )
        base_id = _stable_gap_id(run_id, proposal)
        semantic_key = (base_id, _canonical_text(subject or ""))
        if semantic_key in proposal_semantics:
            raise QueryGateError(
                "EVIDENCE_GAP_DUPLICATE",
                "本轮 EvidenceGap 语义目标重复",
            )
        proposal_semantics.add(semantic_key)
        prepared.append((proposal, base_id, subject, semantic_key))

    proposed_ids: set[str] = set()
    local_to_stable: dict[str, str] = {}
    for proposal, base_id, subject, semantic_key in prepared:
        if proposal.gap_id in local_to_stable:
            raise QueryGateError(
                "EVIDENCE_GAP_DUPLICATE",
                "本轮 EvidenceGap 局部 ID 重复",
            )
        existing_semantic_id = semantic_ids.get(semantic_key)
        gap_id = existing_semantic_id or (
            _subject_qualified_gap_id(base_id, subject)
            if subject is not None
            else base_id
        )
        if gap_id in by_id and existing_semantic_id is None:
            raise QueryGateError(
                "EVIDENCE_GAP_ID_COLLISION",
                "EvidenceGap 稳定 ID 发生冲突",
            )
        local_to_stable[proposal.gap_id] = gap_id
        proposed_ids.add(gap_id)
        existing = by_id.get(gap_id)
        if existing is not None and existing.get("status") == "closed":
            continue
        opened_iteration = (
            int(existing.get("opened_iteration") or iteration)
            if existing is not None
            else iteration
        )
        origin = str(
            existing.get("origin")
            if existing is not None and existing.get("origin")
            else (
                "attempt_feedback"
                if proposal.facet_id in attempted_facets
                else "facet_discovery"
            )
        )
        by_id[gap_id] = {
            "gap_id": gap_id,
            "facet_id": proposal.facet_id,
            "kind": proposal.kind,
            "subject": subject,
            "description": proposal.description,
            "missing_constraint_ids": list(proposal.missing_constraint_ids),
            "required_channel": proposal.required_channel,
            "evidence_type": proposal.evidence_type,
            "priority": proposal.priority,
            "origin": origin,
            "status": "open",
            "opened_iteration": opened_iteration,
            "closed_iteration": None,
            "resolved_by_attempt_id": None,
        }

    progress_by_gap: dict[str, str] = {}
    for attempt in attempts:
        gap_id = str(attempt.get("gap_id") or "")
        attempt_id = str(attempt.get("attempt_id") or "")
        if gap_id and attempt_id and bool(attempt.get("progress")):
            progress_by_gap[gap_id] = attempt_id

    for gap_id, gap in by_id.items():
        if gap_id in proposed_ids or gap.get("status") == "closed":
            continue
        resolver = progress_by_gap.get(gap_id)
        if sufficient or resolver:
            gap["status"] = "closed"
            gap["closed_iteration"] = iteration
            gap["resolved_by_attempt_id"] = resolver

    ordered = sorted(
        by_id.values(),
        key=lambda item: (
            int(item.get("opened_iteration") or 0),
            -int(item.get("priority") or 0),
            str(item.get("gap_id") or ""),
        ),
    )
    if len(ordered) > 24:
        raise QueryGateError("EVIDENCE_GAP_LIMIT", "EvidenceGap 状态超过硬上限")
    return ordered, local_to_stable


def validate_query_proposal(
    brief: QueryBrief,
    proposal: Mapping[str, Any] | Any,
    *,
    run_id: str,
    iteration: int,
    initial: bool,
    allowed_channels: set[str],
    prior_attempts: Sequence[Mapping[str, Any]],
    open_gaps: Sequence[Mapping[str, Any]],
    require_complete_should_accounting: bool = True,
) -> dict[str, Any]:
    raw = proposal if isinstance(proposal, Mapping) else proposal.model_dump()
    query = validate_channel_query(str(_value(raw, "query") or ""), str(_value(raw, "channel") or ""))
    channel = str(_value(raw, "channel") or "")
    if channel not in allowed_channels:
        raise QueryGateError("QUERY_CHANNEL_NOT_ALLOWED", "查询使用了未授权渠道")
    facet_id = str(_value(raw, "facet_id") or "")
    if facet_id not in {item.facet_id for item in brief.evidence_facets}:
        raise QueryGateError("QUERY_FACET_UNKNOWN", "查询引用未知证据分面")
    strategy = str(_value(raw, "strategy") or "")
    gap_id = _value(raw, "gap_id")
    parent_attempt_id = _value(raw, "parent_attempt_id")
    query_terms = list(_value(raw, "query_terms", []) or [])
    if not 1 <= len(query_terms) <= 12:
        raise QueryGateError("QUERY_TERMS_INVALID", "query_terms 数量必须在 1 到 12 之间")
    try:
        query_terms = _bounded_text_list(
            query_terms,
            maximum_items=12,
            maximum_chars=80,
            label="查询词",
        )
    except ValueError as exc:
        raise QueryGateError("QUERY_TERMS_INVALID", str(exc)) from exc
    relaxed = list(_value(raw, "relaxed_should_ids", []) or [])
    should_ids = {item.constraint_id for item in brief.should}
    if (
        len(relaxed) != len(set(relaxed))
        or not set(relaxed) <= should_ids
        or (relaxed and strategy != "broaden_should")
        or (strategy == "broaden_should" and not relaxed)
    ):
        raise QueryGateError("QUERY_RELAXATION_NOT_ALLOWED", "只能显式放宽 QueryBrief.should")

    if initial:
        if strategy != "initial_precise" or gap_id is not None or parent_attempt_id is not None:
            raise QueryGateError("QUERY_INITIAL_LINEAGE_INVALID", "首轮查询不得伪造 gap 或父尝试")
    else:
        if strategy == "initial_precise" or not gap_id or not parent_attempt_id:
            raise QueryGateError("QUERY_FOLLOW_UP_LINEAGE_REQUIRED", "补搜必须绑定 gap 与父尝试")
        gaps = {
            str(item.get("gap_id") or ""): item
            for item in open_gaps
            if item.get("status") == "open"
        }
        gap = gaps.get(str(gap_id))
        if gap is None:
            raise QueryGateError("QUERY_GAP_NOT_OPEN", "补搜引用的 gap 不存在或已闭合")
        if str(gap.get("facet_id") or "") != facet_id:
            raise QueryGateError("QUERY_GAP_FACET_MISMATCH", "补搜 facet 与 gap 不一致")
        parent_attempt = next(
            (
                item
                for item in prior_attempts
                if item.get("attempt_id") == parent_attempt_id
            ),
            None,
        )
        if parent_attempt is None:
            raise QueryGateError("QUERY_PARENT_ATTEMPT_UNKNOWN", "补搜父尝试不存在")
        if str(parent_attempt.get("facet_id") or "") != facet_id and not (
            gap.get("origin") == "facet_discovery"
            and not any(
                str(item.get("facet_id") or "") == facet_id
                for item in prior_attempts
            )
        ):
            raise QueryGateError(
                "QUERY_PARENT_ATTEMPT_FACET_MISMATCH",
                "补搜父尝试与证据分面不一致",
            )
        allowed = _STRATEGIES_BY_GAP.get(str(gap.get("kind") or ""), frozenset())
        if strategy not in allowed:
            raise QueryGateError("QUERY_STRATEGY_GAP_MISMATCH", "改写策略与证据缺口不匹配")

    retained = list(_value(raw, "retained_constraint_ids", []) or [])
    expected = set(hard_constraint_ids(brief))
    retained_ids = set(retained)
    relaxed_ids = set(relaxed)
    if not expected <= retained_ids:
        raise QueryGateError("QUERY_CONSTRAINT_SIGNATURE_DROPPED", "查询丢失硬约束签名")
    known_ids = expected | should_ids
    if len(retained) != len(retained_ids) or not retained_ids <= known_ids:
        raise QueryGateError("QUERY_CONSTRAINT_SIGNATURE_INVALID", "查询声明了未知约束")
    if retained_ids & relaxed_ids:
        raise QueryGateError("QUERY_SHOULD_CONSTRAINT_CONFLICT", "should 约束不能同时保留和放宽")
    if (
        require_complete_should_accounting
        and should_ids != (retained_ids & should_ids) | relaxed_ids
    ):
        raise QueryGateError(
            "QUERY_SHOULD_CONSTRAINT_UNACCOUNTED",
            "每个 should 约束必须显式保留或放宽",
        )
    for item in brief.must:
        if (
            not any(_positive_term_present(query, term) for term in item.terms)
            or _negative_term_present(query, item.terms)
        ):
            raise QueryGateError(
                "QUERY_MUST_CONSTRAINT_DROPPED",
                "查询丢失 must 约束",
            )
    for item in brief.should:
        if (
            item.constraint_id in retained_ids
            and (
                not any(_positive_term_present(query, term) for term in item.terms)
                or _negative_term_present(query, item.terms)
            )
        ):
            raise QueryGateError(
                "QUERY_SHOULD_CONSTRAINT_DROPPED",
                "查询声明保留的 should 约束未出现在查询中",
            )
    if any(
        not _positive_term_present(query, location)
        or _negative_term_present(query, [location])
        for location in brief.locations
    ):
        raise QueryGateError("QUERY_LOCATION_DROPPED", "查询丢失地域约束")
    if not _time_preserved(brief, query, channel):
        raise QueryGateError("QUERY_TIME_RANGE_DROPPED", "查询丢失时间范围")
    for item in brief.exclude:
        if channel == "xiaohongshu":
            if any(_contains_term(query, term) for term in item.terms):
                raise QueryGateError("QUERY_EXCLUSION_DROPPED", "小红书查询包含排除项")
        elif (
            not _negative_term_present(query, item.terms)
            or any(_positive_term_present(query, term) for term in item.terms)
        ):
            raise QueryGateError("QUERY_EXCLUSION_DROPPED", "查询排除语义缺失或自相矛盾")
    if not _platform_boundary_preserved(brief, query, channel, strategy, initial):
        raise QueryGateError("QUERY_REQUIRED_CHANNEL_DROPPED", "查询丢失指定平台边界")
    accepted = {
        "facet_id": facet_id,
        "query_terms": query_terms,
        "strategy": strategy,
        "query": query,
        "channel": channel,
        "gap_id": gap_id,
        "parent_attempt_id": parent_attempt_id,
        "retained_constraint_ids": retained,
        "relaxed_should_ids": relaxed,
        "constraint_signature": constraint_signature(brief),
    }
    if is_near_duplicate(accepted, prior_attempts):
        raise QueryGateError("QUERY_NEAR_DUPLICATE", "查询与同一缺口的既有尝试近似重复")
    accepted["attempt_id"] = stable_attempt_id(run_id, iteration, accepted)
    return accepted


__all__ = [
    "EvidenceFacet",
    "EvidenceGapProposal",
    "EvidenceType",
    "GapKind",
    "QueryBrief",
    "QueryComplexity",
    "QueryConstraint",
    "QueryGateError",
    "QueryTimeRange",
    "ResearchChannel",
    "RewriteStrategy",
    "complete_initial_plan_should_metadata",
    "complete_query_constraint_terms",
    "complete_query_lineage",
    "complete_retained_should_metadata",
    "constraint_signature",
    "hard_constraint_ids",
    "is_near_duplicate",
    "normalize_query_brief",
    "reconcile_evidence_gaps",
    "stable_attempt_id",
    "validate_channel_query",
    "validate_query_proposal",
]
