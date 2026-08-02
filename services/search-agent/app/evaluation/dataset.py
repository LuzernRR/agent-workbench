"""Gold 数据集：离线评测用的确定性 run 记录与期望。

transcript 只保存事件类型与业务载荷，不保存 eventId/streamSeq/createdAt 等
envelope 字段——回放时由 `runtime_event` 重新生成，使隐私门控同样作用于
Gold 数据本身，并保证事件序号确定。
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class GoldEvent(BaseModel):
    """一条待回放的公开事件。"""

    model_config = ConfigDict(extra="forbid")

    type: str
    payload: dict[str, Any] = Field(default_factory=dict)


class GoldExpectation(BaseModel):
    """可确定判定的期望；留空表示该维度不参与打分。"""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    terminal_type: Literal["run.completed", "run.failed", "run.stopped"] = Field(
        alias="terminalType"
    )
    answer_source: Literal["model", "none"] | None = Field(
        default=None, alias="answerSource"
    )
    channels: list[str] | None = None
    reason_code: str | None = Field(default=None, alias="reasonCode")
    response_status: str | None = Field(default=None, alias="responseStatus")
    verification_passed: bool | None = Field(default=None, alias="verificationPassed")
    min_citations: int | None = Field(default=None, alias="minCitations")
    min_evidence_cited: int | None = Field(default=None, alias="minEvidenceCited")
    max_duration_ms: int | None = Field(default=None, alias="maxDurationMs")


class GoldCase(BaseModel):
    """一个离线评测用例。"""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    case_id: str = Field(alias="caseId")
    question: str
    depth: Literal["quick", "balanced", "deep"] = "balanced"
    model_id: str = Field(default="deepseek-v4-flash", alias="modelId")
    reasoning_effort: Literal["low", "medium", "high"] = Field(
        default="high", alias="reasoningEffort"
    )
    tags: list[str] = Field(default_factory=list)
    transcript: list[GoldEvent] = Field(default_factory=list)
    final_state: dict[str, Any] | None = Field(default=None, alias="finalState")
    expect: GoldExpectation


class GoldDataset(BaseModel):
    """版本化 Gold 数据集。"""

    model_config = ConfigDict(extra="forbid")

    version: Literal[1]
    name: str
    cases: list[GoldCase]


def default_dataset_path() -> Path:
    """默认数据集路径；`SEARCH_AGENT_EVAL_DATASET` 可覆盖。"""
    override = os.environ.get("SEARCH_AGENT_EVAL_DATASET")
    if override:
        return Path(override).resolve()
    return (
        Path(__file__).resolve().parents[2]
        / "evaluation"
        / "gold"
        / "search-agent.json"
    )


def load_dataset(path: Path | None = None) -> GoldDataset:
    """读取并校验 Gold 数据集。"""
    resolved = path or default_dataset_path()
    raw = json.loads(resolved.read_text(encoding="utf-8"))
    dataset = GoldDataset.model_validate(raw)
    seen: set[str] = set()
    for case in dataset.cases:
        if case.case_id in seen:
            raise ValueError(f"Gold 数据集存在重复 caseId：{case.case_id}")
        seen.add(case.case_id)
    return dataset
