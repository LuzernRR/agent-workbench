"""从公开事件流派生 run/node/tool span 的追踪边界。

tracer 只消费 `runtime_event` 已产出的公开事件，因此不改变事件流本身；
span attributes 再次通过 `_assert_public` 复核，任何 sink 故障都被吞掉并计数。
"""

from __future__ import annotations

from contextvars import ContextVar
from typing import Any
from urllib.parse import urlsplit

from app.events.runtime import _EVENT_SCOPE, _assert_public, utc_now
from app.observability.sink import NoopSink, SpanSink
from app.observability.span import Span, SpanStatus

# 只允许标量/小字典进入 span，避免把正文、摘要、结果集复制进 trace。
_ATTRIBUTE_KEYS = frozenset(
    {
        "action",
        "agent",
        "answerModelCalls",
        "answerSource",
        "attempt",
        "cached",
        "channel",
        "durationMs",
        "effectiveProvider",
        "evidenceCount",
        "iteration",
        "modelCalls",
        "nextAction",
        "node",
        "nodeRunId",
        "operation",
        "operationRef",
        "outcomeStatus",
        "passed",
        "planId",
        "planSource",
        "planStepId",
        "primaryProvider",
        "promptVersion",
        "provider",
        "reasonCode",
        "responseStatus",
        "resultCount",
        "retryable",
        "revision",
        "status",
        "stopReason",
        "toolCallId",
        "toolCalls",
        "toolName",
        "usage",
        "verificationPassed",
    }
)

_MODEL_ATTRIBUTE_KEYS = frozenset(
    {
        "attempts",
        "costUsd",
        "durationMs",
        "effectiveModelId",
        "fallbacks",
        "formatRepairs",
        "inputTokens",
        "modelId",
        "networkRetries",
        "outputTokens",
        "provider",
        "reasonCode",
        "role",
        "totalTokens",
    }
)

# OTel GenAI 约定的 gen_ai.system 已知取值。Provider 由配置决定（base_url 可换），
# 因此按 host 后缀判定；不在名单内按约定记为 _OTHER，不猜测、不硬编码单一厂商。
_KNOWN_GEN_AI_SYSTEMS: tuple[tuple[str, str], ...] = (
    ("deepseek.com", "deepseek"),
    ("openai.com", "openai"),
    ("anthropic.com", "anthropic"),
    ("mistral.ai", "mistral_ai"),
    ("groq.com", "groq"),
    ("perplexity.ai", "perplexity"),
    ("x.ai", "xai"),
    ("cohere.com", "cohere"),
)
# OTel 约定的未知 Provider 取值；调用方取不到配置时也降级用它。
OTHER_GEN_AI_SYSTEM = "_OTHER"


def gen_ai_system(base_url: str) -> str:
    """按 OTel GenAI 约定从 base_url 判定 gen_ai.system；未知 Provider 记 _OTHER。"""
    host = urlsplit(base_url if "//" in base_url else f"//{base_url}").hostname or ""
    host = host.lower()
    for suffix, system in _KNOWN_GEN_AI_SYSTEMS:
        if host == suffix or host.endswith(f".{suffix}"):
            return system
    return OTHER_GEN_AI_SYSTEM

_NODE_TERMINALS = {"node.completed": "ok", "node.failed": "error"}
_TOOL_TERMINALS = {
    "tool.completed": "ok",
    "tool.failed": "error",
    "tool.unknown": "unknown",
}
_RUN_TERMINALS = {
    "run.completed": "ok",
    "run.failed": "error",
    "run.stopped": "unknown",
}

# OTel GenAI 语义约定属性名映射（事件字段名 → gen_ai.* 标准名）。
# 只重命名；不在此列的字段按原名保留。
_ATTR_RENAME: dict[str, str] = {
    "modelId": "gen_ai.request.model",
    "effectiveModelId": "gen_ai.response.model",
    "inputTokens": "gen_ai.usage.input_tokens",
    "outputTokens": "gen_ai.usage.output_tokens",
    "toolName": "gen_ai.tool.name",
    "toolCallId": "gen_ai.tool.call.id",
    "agent": "gen_ai.agent.name",
}

# span kind → gen_ai.operation.name
_OPERATION_BY_KIND: dict[str, str] = {
    "model": "chat",
    "tool": "execute_tool",
    "node": "invoke_agent",
}


def _attributes(event: dict[str, Any]) -> dict[str, Any]:
    selected = {
        key: value
        for key, value in event.items()
        if key in _ATTRIBUTE_KEYS and value is not None
    }
    _assert_public(selected, "span.attributes")
    # 重命名为 OTel GenAI 标准属性名；不在映射表中的键按原名保留。
    return {_ATTR_RENAME.get(k, k): v for k, v in selected.items()}


class RunTracer:
    """把一次 run 的公开事件折叠成 span 树。"""

    def __init__(self, run_id: str, *, sink: SpanSink | None = None) -> None:
        self._trace_id = run_id
        self._sink = sink or NoopSink()
        self._span_seq = 0
        self._sink_failures = 0
        self._open_nodes: dict[str, Span] = {}
        self._open_tools: dict[str, Span] = {}
        self._event_counts: dict[str, int] = {}
        self._root = self._new_span(
            kind="run",
            name=f"run:{run_id}",
            parent_span_id=None,
            started_at="",
        )

    @property
    def trace_id(self) -> str:
        return self._trace_id

    @property
    def sink_failures(self) -> int:
        return self._sink_failures

    @property
    def event_counts(self) -> dict[str, int]:
        return dict(self._event_counts)

    def _new_span(
        self,
        *,
        kind: str,
        name: str,
        parent_span_id: str | None,
        started_at: str,
    ) -> Span:
        self._span_seq += 1
        span = Span(
            span_id=f"{self._trace_id}-{self._span_seq:04d}",
            parent_span_id=parent_span_id,
            trace_id=self._trace_id,
            kind=kind,  # type: ignore[arg-type]
            name=name,
            started_at=started_at,
            ended_at=None,
            status="unknown",
            attributes={},
            events=[],
        )
        op = _OPERATION_BY_KIND.get(kind)
        if op is not None:
            span.attributes["gen_ai.operation.name"] = op
        return span

    def note_failure(self) -> None:
        """记一次观测侧失败；仅用于计数，绝不抛出。"""
        self._sink_failures += 1

    def _emit(self, span: Span) -> None:
        try:
            self._sink.emit(span)
        except Exception:  # noqa: BLE001 - trace 故障不得影响运行
            self._sink_failures += 1

    def _close(
        self,
        span: Span,
        *,
        status: SpanStatus,
        event: dict[str, Any] | None,
    ) -> None:
        span.status = status
        if event is not None:
            span.ended_at = event.get("createdAt")
            span.attributes.update(_attributes(event))
        self._emit(span)

    def record_model_call(
        self,
        *,
        role: str,
        model_id: str,
        system: str,
        started_at: str,
        ended_at: str,
        status: SpanStatus,
        attributes: dict[str, Any],
    ) -> None:
        """记录一次模型调用为 model span；只接受受控标量属性。"""
        span = self._new_span(
            kind="model",
            name=f"model:{role}",
            parent_span_id=self._root.span_id,
            started_at=started_at,
        )
        span.ended_at = ended_at
        span.status = status
        raw = {"role": role, "modelId": model_id, **attributes}
        selected = {
            key: value
            for key, value in raw.items()
            if key in _MODEL_ATTRIBUTE_KEYS and value is not None
        }
        _assert_public(selected, "span.attributes")
        renamed = {_ATTR_RENAME.get(k, k): v for k, v in selected.items()}
        renamed["gen_ai.system"] = system
        span.attributes.update(renamed)
        self._emit(span)

    def observe(self, event: dict[str, Any]) -> None:
        """消费一个公开事件；本方法不修改也不返回事件。"""
        event_type = str(event.get("type") or "")
        if not event_type:
            return
        self._event_counts[event_type] = self._event_counts.get(event_type, 0) + 1
        created_at = event.get("createdAt") or ""
        if not self._root.started_at:
            self._root.started_at = created_at

        if event_type == "node.started":
            key = str(event.get("nodeRunId") or "")
            if key and key not in self._open_nodes:
                span = self._new_span(
                    kind="node",
                    name=str(event.get("node") or "node"),
                    parent_span_id=self._root.span_id,
                    started_at=created_at,
                )
                span.attributes.update(_attributes(event))
                self._open_nodes[key] = span
            return

        if event_type in _NODE_TERMINALS:
            span = self._open_nodes.pop(str(event.get("nodeRunId") or ""), None)
            if span is not None:
                self._close(span, status=_NODE_TERMINALS[event_type], event=event)  # type: ignore[arg-type]
            return

        if event_type == "tool.started":
            key = str(event.get("toolCallId") or "")
            if key and key not in self._open_tools:
                span = self._new_span(
                    kind="tool",
                    name=str(event.get("toolName") or "tool"),
                    parent_span_id=self._root.span_id,
                    started_at=created_at,
                )
                span.attributes.update(_attributes(event))
                self._open_tools[key] = span
            return

        if event_type in _TOOL_TERMINALS:
            span = self._open_tools.pop(str(event.get("toolCallId") or ""), None)
            if span is not None:
                self._close(span, status=_TOOL_TERMINALS[event_type], event=event)  # type: ignore[arg-type]
            return

        if event_type in _RUN_TERMINALS:
            self._root.attributes.update(_attributes(event))
            self._root.status = _RUN_TERMINALS[event_type]  # type: ignore[assignment]
            self._root.ended_at = created_at
            return

        # 其余事件（plan/evidence/memory/verification/tool.progress 等）
        # 作为轻量标记挂在最近的父 span 上。
        marker = {"type": event_type, "createdAt": created_at, **_attributes(event)}
        _assert_public(marker, "span.event")
        target = self._root
        node_run_id = str(event.get("nodeRunId") or "")
        tool_call_id = str(event.get("toolCallId") or "")
        if tool_call_id and tool_call_id in self._open_tools:
            target = self._open_tools[tool_call_id]
        elif node_run_id and node_run_id in self._open_nodes:
            target = self._open_nodes[node_run_id]
        target.events.append(marker)

    def finish(self) -> Span:
        """收尾：未闭合的 node/tool span 记为 unknown，随后落盘 root。"""
        for span in list(self._open_nodes.values()):
            self._close(span, status="unknown", event=None)
        self._open_nodes.clear()
        for span in list(self._open_tools.values()):
            self._close(span, status="unknown", event=None)
        self._open_tools.clear()
        self._root.attributes["eventCounts"] = dict(self._event_counts)
        self._root.attributes["sinkFailures"] = self._sink_failures
        self._emit(self._root)
        try:
            self._sink.flush()
        except Exception:  # noqa: BLE001 - flush 故障同样不得影响运行
            self._sink_failures += 1
        return self._root


class TracerFactory:
    """按 run 构造 tracer；未启用时返回 None。"""

    def __init__(self, sink: SpanSink | None = None) -> None:
        self._sink = sink

    def __call__(self, run_id: str) -> RunTracer | None:
        if self._sink is None:
            return None
        return RunTracer(run_id, sink=self._sink)


# 模型调用层通过该 contextvar 找到当前 tracer；未开启 tracing 时为 None，
# 模型层的记录调用随即变成空操作，不产生任何额外开销或事件。
_ACTIVE_TRACER: ContextVar[RunTracer | None] = ContextVar(
    "search_agent_active_tracer", default=None
)


def bind_tracer(tracer: RunTracer | None) -> RunTracer | None:
    """把 tracer 绑定到当前上下文；返回此前的值供恢复。"""
    previous = _ACTIVE_TRACER.get()
    _ACTIVE_TRACER.set(tracer)
    return previous


def unbind_tracer(previous: RunTracer | None) -> None:
    _ACTIVE_TRACER.set(previous)


def tracing_enabled() -> bool:
    """当前上下文是否已绑定 tracer；模型层用它跳过全部计时开销。"""
    return _ACTIVE_TRACER.get() is not None


def span_now() -> str:
    """span 时间戳与事件流共用同一时钟，注入测试时钟后仍可复现。"""
    scope = _EVENT_SCOPE.get()
    return scope.clock() if scope is not None else utc_now()


def record_model_call(
    *,
    role: str,
    model_id: str,
    system: str = OTHER_GEN_AI_SYSTEM,
    started_at: str,
    ended_at: str,
    status: SpanStatus,
    attributes: dict[str, Any],
) -> None:
    """由模型调用层调用；tracing 关闭时为空操作，异常绝不外泄。"""
    tracer = _ACTIVE_TRACER.get()
    if tracer is None:
        return
    try:
        tracer.record_model_call(
            role=role,
            model_id=model_id,
            system=system,
            started_at=started_at,
            ended_at=ended_at,
            status=status,
            attributes=attributes,
        )
    except Exception:  # noqa: BLE001 - 观测失败不得影响模型调用
        tracer.note_failure()
