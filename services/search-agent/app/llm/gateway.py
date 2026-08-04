"""统一 Model Gateway：路由、deadline、重试、fallback 与调用记账。"""

from __future__ import annotations

import asyncio
import random
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field

from pydantic import BaseModel, ValidationError

from app.llm.contracts import (
    ModelAttempt,
    ModelErrorKind,
    ModelMessage,
    ModelRequest,
    ModelResult,
    ModelUsage,
    StructuredOutputError,
    WriterStreamError,
)
from app.llm.ports import ModelProvider
from app.observability.trace import record_model_call, span_now, tracing_enabled
from app.reliability.deadline import DeadlineBudget
from app.reliability.retry import ErrorKind, RetryPolicy, next_delay

_REPAIR_MESSAGE = (
    "上一轮没有返回可通过 Schema 校验的函数结果。"
    "请只调用已提供的结构化输出函数，并严格满足所有字段、类型与枚举约束。"
)


class ModelProviderError(RuntimeError):
    """Provider adapter 归一后的安全错误。"""

    def __init__(
        self,
        kind: ModelErrorKind,
        message: str,
        *,
        retry_after_seconds: float | None = None,
    ) -> None:
        super().__init__(message)
        self.kind = kind
        self.retry_after_seconds = retry_after_seconds


@dataclass
class _Totals:
    primary_model: str
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0
    network_retries: int = 0
    format_repairs: int = 0
    fallbacks: int = 0
    effective_model: str | None = None
    attempts: list[ModelAttempt] = field(default_factory=list)

    def add_result(self, result: ModelResult) -> None:
        self.input_tokens += result.input_tokens
        self.output_tokens += result.output_tokens
        self.cost_usd = round(self.cost_usd + result.cost_usd, 8)
        self.effective_model = result.model

    def usage(self) -> ModelUsage:
        return ModelUsage(
            input_tokens=self.input_tokens,
            output_tokens=self.output_tokens,
            total_tokens=self.input_tokens + self.output_tokens,
            cost_usd=self.cost_usd,
            attempts=len(self.attempts),
            network_retries=self.network_retries,
            format_repairs=self.format_repairs,
            fallbacks=self.fallbacks,
            primary_model=self.primary_model,
            effective_model=self.effective_model,
            attempt_details=tuple(self.attempts),
        )


def _retry_kind(kind: ModelErrorKind) -> ErrorKind:
    if kind is ModelErrorKind.RATE_LIMIT:
        return ErrorKind.RATE_LIMIT
    if kind is ModelErrorKind.TIMEOUT:
        return ErrorKind.TIMEOUT
    if kind is ModelErrorKind.TRANSIENT:
        return ErrorKind.TRANSIENT
    return ErrorKind.PERMANENT


class DefaultModelGateway:
    def __init__(
        self,
        provider: ModelProvider,
        *,
        retry_policy: RetryPolicy,
        fallback_models: dict[str, tuple[str, ...]] | None = None,
        sleeper: Callable[[float], Awaitable[None]] | None = None,
        clock: Callable[[], float] | None = None,
        random_source: Callable[[], float] | None = None,
    ) -> None:
        self._provider = provider
        self._policy = retry_policy
        self._fallback_models = fallback_models or {}
        self._sleep = sleeper or asyncio.sleep
        self._clock = clock or time.monotonic
        self._random = random_source or random.random

    def _routes(
        self,
        request: ModelRequest,
        override: tuple[str, ...] | None = None,
    ) -> tuple[str, ...]:
        candidates = override or (
            request.model_id,
            *self._fallback_models.get(request.model_id, ()),
        )
        return tuple(dict.fromkeys(candidates))

    def _deadline(self, request: ModelRequest) -> DeadlineBudget:
        return DeadlineBudget.after(
            min(self._policy.max_elapsed_seconds, request.latency_slo_ms / 1000),
            clock=self._clock,
        )

    def _append_attempt(
        self,
        totals: _Totals,
        *,
        model: str,
        phase: str,
        status: str,
        started_at: float,
        error_kind: ModelErrorKind | None = None,
    ) -> None:
        totals.attempts.append(ModelAttempt(
            attempt=len(totals.attempts) + 1,
            provider=self._provider.provider_name,
            model=model,
            phase=phase,  # type: ignore[arg-type]
            status=status,  # type: ignore[arg-type]
            error_kind=error_kind,
            latency_ms=max(0, int((self._clock() - started_at) * 1000)),
        ))
        totals.effective_model = model

    def _phase_name(
        self,
        *,
        format_repair: bool,
        route_index: int,
        local_attempt: int,
    ) -> str:
        if route_index > 0:
            return "fallback"
        if local_attempt > 0:
            return "network_retry"
        return "format_repair" if format_repair else "primary"

    async def _structured_phase(
        self,
        request: ModelRequest,
        schema: type[BaseModel],
        deadline: DeadlineBudget,
        totals: _Totals,
        *,
        format_repair: bool,
        routes: tuple[str, ...] | None = None,
    ) -> ModelResult:
        candidates = self._routes(request, routes)
        phase_attempts = 0
        last_error: ModelProviderError | None = None
        phase_limit = min(
            self._policy.max_attempts,
            request.max_provider_attempts - len(totals.attempts),
        )
        for route_index, model_id in enumerate(candidates):
            remaining_routes = len(candidates) - route_index - 1
            allowance = max(1, phase_limit - phase_attempts - remaining_routes)
            if route_index > 0:
                totals.fallbacks += 1
            for local_attempt in range(allowance):
                if phase_attempts >= phase_limit or deadline.expired:
                    break
                started_at = self._clock()
                phase = self._phase_name(
                    format_repair=format_repair,
                    route_index=route_index,
                    local_attempt=local_attempt,
                )
                if local_attempt > 0:
                    totals.network_retries += 1
                try:
                    async with asyncio.timeout(deadline.remaining_seconds()):
                        result = await self._provider.generate_structured(
                            request,
                            schema,
                            model_id=model_id,
                        )
                except TimeoutError:
                    error = ModelProviderError(
                        ModelErrorKind.TIMEOUT,
                        "模型请求超时",
                    )
                except ModelProviderError as exc:
                    error = exc
                else:
                    self._append_attempt(
                        totals,
                        model=model_id,
                        phase=phase,
                        status="ok",
                        started_at=started_at,
                    )
                    totals.add_result(result)
                    return result

                phase_attempts += 1
                last_error = error
                self._append_attempt(
                    totals,
                    model=model_id,
                    phase=phase,
                    status="error",
                    started_at=started_at,
                    error_kind=error.kind,
                )
                if error.kind is ModelErrorKind.PERMANENT or deadline.expired:
                    raise error
                can_retry_same_model = local_attempt + 1 < allowance
                if not can_retry_same_model:
                    break
                remaining = deadline.remaining_seconds()
                elapsed = max(0.0, self._policy.max_elapsed_seconds - remaining)
                delay = next_delay(
                    self._policy,
                    error_kind=_retry_kind(error.kind),
                    attempt=phase_attempts,
                    elapsed_seconds=elapsed,
                    random_value=self._random(),
                    retry_after_seconds=error.retry_after_seconds,
                )
                if delay is None:
                    raise error
                await self._sleep(delay)
            if phase_attempts >= phase_limit or deadline.expired:
                break
        if last_error is not None:
            raise last_error
        raise ModelProviderError(ModelErrorKind.TIMEOUT, "模型请求超时")

    def _mark_invalid_output(self, totals: _Totals) -> None:
        latest = totals.attempts[-1]
        totals.attempts[-1] = latest.model_copy(update={
            "status": "invalid_output",
            "error_kind": ModelErrorKind.INVALID_OUTPUT,
        })

    def _record_span(
        self,
        request: ModelRequest,
        totals: _Totals,
        started_at: str,
        status: str,
    ) -> None:
        """把一次 Gateway 调用（含全部 attempts）记为 model span。

        primary/effective model 分列，fallback、网络重试与格式修复次数独立上报，
        因此 span 能区分「请求的模型」与「真正应答的模型」。未开启 tracing 时为空操作。
        """
        if not started_at:
            return
        usage = totals.usage()
        failure = next(
            (
                item.error_kind
                for item in reversed(totals.attempts)
                if item.error_kind is not None
            ),
            None,
        )
        record_model_call(
            role=request.task_type,
            model_id=usage.primary_model or request.model_id,
            system=self._provider.gen_ai_system,
            started_at=started_at,
            ended_at=span_now(),
            status=status,  # type: ignore[arg-type]
            attributes={
                "provider": self._provider.provider_name,
                "effectiveModelId": usage.effective_model,
                "inputTokens": usage.input_tokens,
                "outputTokens": usage.output_tokens,
                "totalTokens": usage.total_tokens,
                "costUsd": usage.cost_usd,
                "attempts": usage.attempts,
                "networkRetries": usage.network_retries,
                "formatRepairs": usage.format_repairs,
                "fallbacks": usage.fallbacks,
                "reasonCode": failure.value if failure is not None else None,
            },
        )

    async def generate_structured[SchemaT: BaseModel](
        self,
        request: ModelRequest,
        schema: type[SchemaT],
        *,
        allow_repair: bool = False,
    ) -> tuple[SchemaT, ModelUsage]:
        started_at = span_now() if tracing_enabled() else ""
        totals = _Totals(primary_model=request.model_id)
        try:
            parsed = await self._generate_structured(
                request,
                schema,
                totals,
                allow_repair=allow_repair,
            )
        except BaseException:
            # CancelledError 也走这里：只补记 span，异常本身原样向上传播。
            self._record_span(request, totals, started_at, "error")
            raise
        self._record_span(request, totals, started_at, "ok")
        return parsed, totals.usage()

    async def _generate_structured[SchemaT: BaseModel](
        self,
        request: ModelRequest,
        schema: type[SchemaT],
        totals: _Totals,
        *,
        allow_repair: bool,
    ) -> SchemaT:
        deadline = self._deadline(request)
        result = await self._structured_phase(
            request,
            schema,
            deadline,
            totals,
            format_repair=False,
        )
        try:
            parsed = schema.model_validate(result.output)
        except ValidationError:
            parsed = None
        if parsed is not None:
            return parsed

        self._mark_invalid_output(totals)
        if (
            not allow_repair
            or deadline.expired
            or len(totals.attempts) >= request.max_provider_attempts
        ):
            raise StructuredOutputError(totals.usage())

        totals.format_repairs += 1
        repair_request = request.model_copy(update={
            "model_id": result.model,
            "messages": (
                *request.messages,
                ModelMessage(role="user", content=_REPAIR_MESSAGE),
            ),
        })
        repaired = await self._structured_phase(
            repair_request,
            schema,
            deadline,
            totals,
            format_repair=True,
            routes=(result.model,),
        )
        try:
            parsed = schema.model_validate(repaired.output)
        except ValidationError:
            parsed = None
        if parsed is None:
            self._mark_invalid_output(totals)
            raise StructuredOutputError(totals.usage())
        return parsed

    async def stream_text(
        self,
        request: ModelRequest,
    ) -> AsyncIterator[str | ModelUsage]:
        started_at = span_now() if tracing_enabled() else ""
        totals = _Totals(primary_model=request.model_id)
        try:
            async for item in self._stream_text(request, totals):
                yield item
        except BaseException:
            self._record_span(request, totals, started_at, "error")
            raise
        self._record_span(request, totals, started_at, "ok")

    async def _stream_text(
        self,
        request: ModelRequest,
        totals: _Totals,
    ) -> AsyncIterator[str | ModelUsage]:
        deadline = self._deadline(request)
        candidates = self._routes(request)
        phase_attempts = 0
        last_error: ModelProviderError | None = None
        phase_limit = min(self._policy.max_attempts, request.max_provider_attempts)

        for route_index, model_id in enumerate(candidates):
            remaining_routes = len(candidates) - route_index - 1
            allowance = max(1, phase_limit - phase_attempts - remaining_routes)
            if route_index > 0:
                totals.fallbacks += 1
            for local_attempt in range(allowance):
                if phase_attempts >= phase_limit or deadline.expired:
                    break
                started_at = self._clock()
                phase = self._phase_name(
                    format_repair=False,
                    route_index=route_index,
                    local_attempt=local_attempt,
                )
                if local_attempt > 0:
                    totals.network_retries += 1
                produced = False
                final_result: ModelResult | None = None
                iterator = self._provider.stream_text(request, model_id=model_id)
                try:
                    while True:
                        remaining = deadline.remaining_seconds()
                        if remaining <= 0:
                            raise TimeoutError
                        try:
                            async with asyncio.timeout(remaining):
                                item = await anext(iterator)
                        except StopAsyncIteration:
                            break
                        if isinstance(item, str):
                            produced = True
                            yield item
                        else:
                            final_result = item
                except TimeoutError:
                    error = ModelProviderError(ModelErrorKind.TIMEOUT, "模型请求超时")
                except ModelProviderError as exc:
                    error = exc
                else:
                    self._append_attempt(
                        totals,
                        model=model_id,
                        phase=phase,
                        status="ok" if produced and final_result is not None else "invalid_output",
                        started_at=started_at,
                        error_kind=(
                            None if produced and final_result is not None
                            else ModelErrorKind.INVALID_OUTPUT
                        ),
                    )
                    if final_result is not None:
                        totals.add_result(final_result)
                    if not produced or final_result is None:
                        raise WriterStreamError(totals.usage())
                    yield totals.usage()
                    return
                finally:
                    await iterator.aclose()

                phase_attempts += 1
                last_error = error
                self._append_attempt(
                    totals,
                    model=model_id,
                    phase=phase,
                    status="error",
                    started_at=started_at,
                    error_kind=error.kind,
                )
                if produced:
                    raise WriterStreamError(totals.usage()) from error
                if error.kind is ModelErrorKind.PERMANENT or deadline.expired:
                    raise WriterStreamError(totals.usage()) from error
                can_retry_same_model = local_attempt + 1 < allowance
                if not can_retry_same_model:
                    break
                remaining = deadline.remaining_seconds()
                elapsed = max(0.0, self._policy.max_elapsed_seconds - remaining)
                delay = next_delay(
                    self._policy,
                    error_kind=_retry_kind(error.kind),
                    attempt=phase_attempts,
                    elapsed_seconds=elapsed,
                    random_value=self._random(),
                    retry_after_seconds=error.retry_after_seconds,
                )
                if delay is None:
                    raise WriterStreamError(totals.usage()) from error
                await self._sleep(delay)
            if phase_attempts >= phase_limit or deadline.expired:
                break

        if last_error is not None:
            raise WriterStreamError(totals.usage()) from last_error
        raise WriterStreamError(totals.usage())
