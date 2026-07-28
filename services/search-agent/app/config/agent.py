"""Search Agent 的非密钥运行配置。

配置统一位于仓库根目录 ``config/search-agent.json``。API Key 仍只存在于
被 Git 忽略的 ``config/*.local.json``，本模块不会读取或返回密钥。
"""

from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, model_validator


class ServiceConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    origin: HttpUrl
    request_timeout_ms: int = Field(alias="requestTimeoutMs", ge=30_000, le=600_000)


class GraphConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    default_depth: Literal["quick", "balanced", "deep"] = Field(alias="defaultDepth")
    recursion_limit: int = Field(alias="recursionLimit", ge=8, le=96)
    max_iterations: int = Field(alias="maxIterations", ge=1, le=3)
    max_model_calls: int = Field(alias="maxModelCalls", ge=4, le=32)
    max_tool_calls: int = Field(alias="maxToolCalls", ge=1, le=12)
    max_run_seconds: int = Field(alias="maxRunSeconds", ge=30, le=600)
    max_total_tokens: int = Field(alias="maxTotalTokens", ge=4_000, le=500_000)
    max_cost_usd: float = Field(alias="maxCostUsd", gt=0, le=5)
    no_progress_limit: int = Field(alias="noProgressLimit", ge=1, le=3)
    max_results_per_call: int = Field(alias="maxResultsPerCall", ge=1, le=8)
    max_pages_per_call: int = Field(alias="maxPagesPerCall", ge=1, le=5)


class SearchConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    force_search: bool = Field(alias="forceSearch")
    default_provider: Literal["tavily", "duckduckgo"] = Field(alias="defaultProvider")
    allow_duckduckgo_fallback: bool = Field(alias="allowDuckDuckGoFallback")


class MilvusConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool
    uri: str = Field(min_length=1)
    collection: str = Field(pattern=r"^[A-Za-z][A-Za-z0-9_]{2,63}$")
    data_directory: str = Field(alias="dataDirectory", min_length=3)
    embedding_model_version: str = Field(
        alias="embeddingModelVersion", pattern=r"^[A-Za-z0-9_.-]{3,80}$"
    )
    embedding_dimension: int = Field(alias="embeddingDimension", ge=64, le=4096)
    recall_limit: int = Field(alias="recallLimit", ge=1, le=10)


class ModelPrice(BaseModel):
    model_config = ConfigDict(extra="forbid")

    input_cache_miss_usd_per_million: float = Field(
        alias="inputCacheMissUsdPerMillion", ge=0
    )
    output_usd_per_million: float = Field(alias="outputUsdPerMillion", ge=0)


class PricingConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    verified_at: str = Field(alias="verifiedAt", pattern=r"^\d{4}-\d{2}-\d{2}$")
    source: HttpUrl
    models: dict[str, ModelPrice]


class AgentConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    version: Literal[1]
    service: ServiceConfig
    graph: GraphConfig
    search: SearchConfig
    milvus: MilvusConfig
    pricing: PricingConfig

    @model_validator(mode="after")
    def validate_cross_field_limits(self) -> AgentConfig:
        if self.graph.max_pages_per_call > self.graph.max_results_per_call:
            raise ValueError("maxPagesPerCall 不能超过 maxResultsPerCall")
        return self


def agent_config_path() -> Path:
    override = os.environ.get("SEARCH_AGENT_CONFIG_PATH")
    if override:
        return Path(override).resolve()
    repo_root = Path(__file__).resolve().parents[4]
    return repo_root / "config" / "search-agent.json"


def load_agent_config(path: Path | None = None) -> AgentConfig:
    target = path or agent_config_path()
    if not target.is_file():
        raise RuntimeError(f"Search Agent 配置不存在：{target}")
    try:
        raw = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError("Search Agent 配置不是有效 JSON") from exc
    milvus_uri = os.environ.get("SEARCH_AGENT_MILVUS_URI")
    if milvus_uri:
        raw.setdefault("milvus", {})["uri"] = milvus_uri
    milvus_data_directory = os.environ.get("SEARCH_AGENT_MILVUS_DATA_DIRECTORY")
    if milvus_data_directory:
        raw.setdefault("milvus", {})["dataDirectory"] = milvus_data_directory
    return AgentConfig.model_validate(raw)


@lru_cache(maxsize=1)
def agent_config() -> AgentConfig:
    return load_agent_config()
