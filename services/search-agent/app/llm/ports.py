"""模型 Gateway 与 Provider adapter 端口。"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Protocol

from pydantic import BaseModel

from app.llm.contracts import ModelRequest, ModelResult, ModelUsage


class ModelProvider(Protocol):
    provider_name: str
    gen_ai_system: str

    async def generate_structured(
        self,
        request: ModelRequest,
        schema: type[BaseModel],
        *,
        model_id: str,
    ) -> ModelResult: ...

    def stream_text(
        self,
        request: ModelRequest,
        *,
        model_id: str,
    ) -> AsyncIterator[str | ModelResult]: ...


class ModelGateway(Protocol):
    async def generate_structured[SchemaT: BaseModel](
        self,
        request: ModelRequest,
        schema: type[SchemaT],
        *,
        allow_repair: bool = False,
    ) -> tuple[SchemaT, ModelUsage]: ...

    def stream_text(
        self,
        request: ModelRequest,
    ) -> AsyncIterator[str | ModelUsage]: ...
