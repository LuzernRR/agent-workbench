"""Search Agent 内部 API schema。"""

from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


def validate_run_id(value: str) -> str:
    if not _ID.fullmatch(value):
        raise ValueError("运行 ID 格式无效")
    return value


class ApiModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class HistoryMessage(ApiModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=20_000)


class SearchRunRequest(ApiModel):
    version: Literal[1]
    run_id: str = Field(alias="runId")
    tenant_id: str = Field(alias="tenantId")
    visitor_id: str = Field(alias="visitorId")
    project_id: str | None = Field(default=None, alias="projectId")
    thread_id: str = Field(alias="threadId")
    question: str = Field(min_length=1, max_length=20_000)
    model_id: str = Field(alias="modelId", min_length=1, max_length=120)
    reasoning_effort: Literal["medium", "high", "xhigh", "max"] = Field(
        alias="reasoningEffort"
    )
    history: list[HistoryMessage] = Field(default_factory=list, max_length=40)
    project_memory_context: str = Field(
        default="", alias="projectMemoryContext", max_length=20_000
    )
    depth: Literal["quick", "balanced", "deep"] = "balanced"
    resume: bool = False

    @field_validator("run_id", "tenant_id", "visitor_id", "thread_id", "project_id")
    @classmethod
    def validate_scope_id(cls, value: str | None) -> str | None:
        if value is not None and not _ID.fullmatch(value):
            raise ValueError("作用域 ID 格式无效")
        return value

    def context_text(self) -> str:
        turns = "\n\n".join(
            f"{('用户' if item.role == 'user' else '助手')}：{item.content}"
            for item in self.history[-20:]
        )
        parts = [part for part in [turns, self.project_memory_context] if part]
        return "\n\n".join(parts)[-20_000:]
