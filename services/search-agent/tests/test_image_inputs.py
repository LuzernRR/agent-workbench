"""图片输入的内部 API 只允许不可逆引用，当前不允许任何图片内容穿透。"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.api.schemas import SearchRunRequest


def request(image_inputs: list[dict[str, object]]) -> dict[str, object]:
    return {
        "version": 1,
        "runId": "run_image_1",
        "tenantId": "tenant_1",
        "visitorId": "visitor_1",
        "projectId": "project_1",
        "threadId": "thread_1",
        "question": "请分析我上传的图片",
        "modelId": "deepseek-v4-flash",
        "reasoningEffort": "high",
        "checkpointSessionId": "checkpoint_image_1",
        "imageInputs": image_inputs,
    }


def test_image_reference_accepts_only_safe_metadata() -> None:
    payload = SearchRunRequest.model_validate(
        request(
            [
                {
                    "attachmentId": "att_image_1",
                    "mimeType": "image/png",
                    "sizeBytes": 24,
                    "sha256": "a" * 64,
                }
            ]
        )
    )

    assert payload.image_inputs[0].attachment_id == "att_image_1"
    assert payload.model_dump(by_alias=True)["imageInputs"] == [
        {
            "attachmentId": "att_image_1",
            "mimeType": "image/png",
            "sizeBytes": 24,
            "sha256": "a" * 64,
        }
    ]


@pytest.mark.parametrize(
    "image_input",
    [
        {
            "attachmentId": "att_image_1",
            "mimeType": "image/svg+xml",
            "sizeBytes": 24,
            "sha256": "a" * 64,
        },
        {
            "attachmentId": "att_image_1",
            "mimeType": "image/png",
            "sizeBytes": 24,
            "sha256": "not-a-hash",
        },
        {
            "attachmentId": "att_image_1",
            "mimeType": "image/png",
            "sizeBytes": 24,
            "sha256": "a" * 64,
            "url": "https://private.example/image.png",
        },
        {
            "attachmentId": "att_image_1",
            "mimeType": "image/png",
            "sizeBytes": 24,
            "sha256": "a" * 64,
            "base64": "iVBORw0KGgo=",
        },
    ],
)
def test_image_reference_rejects_untrusted_or_sensitive_fields(
    image_input: dict[str, object],
) -> None:
    with pytest.raises(ValidationError):
        SearchRunRequest.model_validate(request([image_input]))
