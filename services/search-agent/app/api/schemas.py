"""Search Agent 内部 API schema。"""

from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_CHECKPOINT_NAMESPACE_CONTROL = re.compile(r"[\r\n\x00]")
_SHA256 = re.compile(r"^[a-f0-9]{64}$")


def validate_run_id(value: str) -> str:
    if not _ID.fullmatch(value):
        raise ValueError("运行 ID 格式无效")
    return value


def is_valid_checkpoint_identifier(value: object) -> bool:
    return isinstance(value, str) and _ID.fullmatch(value) is not None


def is_valid_checkpoint_namespace(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) <= 256
        and _CHECKPOINT_NAMESPACE_CONTROL.search(value) is None
    )


class ApiModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class HistoryMessage(ApiModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=20_000)


class ImageInputReference(ApiModel):
    """跨服务图片引用；不接受 URL、base64 或原始 bytes。"""

    attachment_id: str = Field(alias="attachmentId")
    mime_type: Literal["image/jpeg", "image/png", "image/webp", "image/gif"] = Field(
        alias="mimeType"
    )
    size_bytes: int = Field(alias="sizeBytes", ge=1, le=10 * 1024 * 1024)
    sha256: str = Field(min_length=64, max_length=64)

    @field_validator("attachment_id")
    @classmethod
    def validate_attachment_id(cls, value: str) -> str:
        if not _ID.fullmatch(value):
            raise ValueError("附件 ID 格式无效")
        return value

    @field_validator("sha256")
    @classmethod
    def validate_sha256(cls, value: str) -> str:
        if not _SHA256.fullmatch(value):
            raise ValueError("图片摘要格式无效")
        return value


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
    # 当前模型没有视觉 adapter，只接收不可逆引用供链路协商和未来实现使用。
    image_inputs: list[ImageInputReference] = Field(
        default_factory=list, alias="imageInputs", max_length=4
    )
    depth: Literal["quick", "balanced", "deep"] = "balanced"
    resume: bool = False
    checkpoint_id: str | None = Field(default=None, alias="checkpointId")
    checkpoint_ns: str | None = Field(default=None, alias="checkpointNs")
    checkpoint_session_id: str = Field(
        alias="checkpointSessionId", min_length=1, max_length=128
    )

    @field_validator("run_id", "tenant_id", "visitor_id", "thread_id", "project_id")
    @classmethod
    def validate_scope_id(cls, value: str | None) -> str | None:
        if value is not None and not _ID.fullmatch(value):
            raise ValueError("作用域 ID 格式无效")
        return value

    @field_validator("checkpoint_id", "checkpoint_session_id")
    @classmethod
    def validate_checkpoint_id(cls, value: str | None) -> str | None:
        if value is not None and not is_valid_checkpoint_identifier(value):
            raise ValueError("Checkpoint 标识符格式无效")
        return value

    @field_validator("checkpoint_ns")
    @classmethod
    def validate_checkpoint_ns(cls, value: str | None) -> str | None:
        if value is not None and not is_valid_checkpoint_namespace(value):
            raise ValueError("Checkpoint namespace 格式无效")
        return value

    @model_validator(mode="after")
    def validate_checkpoint_resume(self) -> SearchRunRequest:
        has_checkpoint = self.checkpoint_id is not None
        has_namespace = self.checkpoint_ns is not None
        if has_checkpoint != has_namespace or self.resume != has_checkpoint:
            raise ValueError(
                "resume、checkpointId 与 checkpointNs 必须组成完整恢复引用"
            )
        return self

    def context_text(self) -> str:
        turns = "\n\n".join(
            f"{('用户' if item.role == 'user' else '助手')}：{item.content}"
            for item in self.history[-20:]
        )
        parts = [part for part in [turns, self.project_memory_context] if part]
        return "\n\n".join(parts)[-20_000:]
