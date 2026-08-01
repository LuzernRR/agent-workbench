"""Python Agent 到 Next BFF 的安全流事件。"""

from __future__ import annotations

import re
import uuid
from collections.abc import Callable
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

_FORBIDDEN_KEYS = {
    "reasoning",
    "reasoningcontent",
    "chainofthought",
    "authorization",
    "apikey",
    "cookie",
    "headers",
    "prompt",
    "systemprompt",
    "messages",
    "assistantmessage",
    "toolmessages",
    "rawrequest",
    "rawresponse",
    "requestheaders",
    "responseheaders",
    "providerbody",
    "rawprovider",
    "token",
    "toolarguments",
}

def utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


EventClock = Callable[[], str]


@dataclass
class EventScope:
    run_id: str
    stream_id: str
    clock: EventClock = utc_now
    sequence: int = 0


_EVENT_SCOPE: ContextVar[EventScope | None] = ContextVar(
    "search_agent_event_scope", default=None
)


def begin_event_scope(
    run_id: str,
    *,
    stream_id: str | None = None,
    clock: EventClock = utc_now,
) -> EventScope | None:
    """为一次 Harness 流建立唯一 streamId 与流内严格递增序号。"""
    previous = _EVENT_SCOPE.get()
    _EVENT_SCOPE.set(EventScope(
        run_id=run_id,
        stream_id=stream_id or f"stream_{uuid.uuid4().hex}",
        clock=clock,
    ))
    return previous


def end_event_scope(previous: EventScope | None) -> None:
    _EVENT_SCOPE.set(previous)


def safe_public_text(value: str | None, *, max_chars: int = 160) -> str | None:
    """把模型生成摘要规整为单段公开文本；空值不制造 fallback。"""
    text = re.sub(r"\s+", " ", (value or "").strip())
    text = text.replace("```", "")
    text = re.sub(r"^(?:#{1,6}\s+|[-*+]\s+|\d+[.)、]\s+)", "", text).strip()
    text = re.sub(r"\[([^\]]+)]\([^)]+\)", r"\1", text)
    text = re.sub(r"[*_`~]+", "", text).strip()
    if len(text) > max_chars:
        text = text[:max_chars].rstrip("，、；;:： ")
        if text and text[-1] not in "。！？.!?":
            text = f"{text[:max_chars - 1].rstrip('，、；;:： ')}。"
    return text or None


def _assert_public(value: Any, path: str = "event") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            normalized = re.sub(r"[^a-z0-9]", "", str(key).lower())
            if normalized in _FORBIDDEN_KEYS:
                raise ValueError(f"公开事件包含禁止字段：{path}.{key}")
            _assert_public(child, f"{path}.{key}")
    elif isinstance(value, (list, tuple)):
        for index, child in enumerate(value):
            _assert_public(child, f"{path}[{index}]")


def runtime_event(event_type: str, **payload: Any) -> dict[str, Any]:
    scope = _EVENT_SCOPE.get()
    if scope is None:
        sequence = 1
        stream_id = f"stream_{uuid.uuid4().hex}"
        event_id = f"event_{uuid.uuid4().hex}"
    else:
        scope.sequence += 1
        sequence = scope.sequence
        stream_id = scope.stream_id
        event_id = f"{scope.stream_id}_{sequence:06d}"
    event = {
        "version": 1,
        "eventId": event_id,
        "streamId": stream_id,
        "streamSeq": sequence,
        "seq": sequence,
        "type": event_type,
        "createdAt": scope.clock() if scope is not None else utc_now(),
        **payload,
    }
    _assert_public(event)
    return event
