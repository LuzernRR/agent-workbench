"""节点的结构化输出 schema。

每个模型节点通过 `with_structured_output` 强制返回这些 Pydantic 模型，
避免解析自由文本。字段刻意精简，只保留驱动流程和生成思考摘要所需的内容。

所有 `summary` 字段都是面向用户的思考摘要，模型被要求写成
一句简短中文，不含私有推理过程。
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class IntentResult(StrictModel):
    """classify_intent 节点产出。"""

    task_type: Literal[
        "direct_answer", "fact_lookup", "research", "comparison", "recommendation"
    ] = Field(description="任务类型")
    need_search: bool = Field(description="是否需要联网搜索才能可靠回答")
    summary: str = Field(description="一句话说明你如何理解这个任务，面向用户，不超过80字")


class PlanResult(StrictModel):
    """plan_research 节点产出。"""

    queries: list[str] = Field(
        description="2到4条用于搜索的查询词，覆盖问题的不同方面，保留关键实体",
        min_length=1,
        max_length=4,
    )
    summary: str = Field(description="一句话说明你的检索计划，面向用户，不超过80字")


class ReflectResult(StrictModel):
    """reflect 节点产出：判断证据是否足够。"""

    sufficient: bool = Field(description="现有证据是否足以回答问题")
    missing: str = Field(default="", description="若不足，缺什么；若足够，留空")
    extra_queries: list[str] = Field(
        default_factory=list,
        description="若不足，补充的查询词（最多2条）；若足够，空列表",
        max_length=2,
    )
    summary: str = Field(description="一句话说明证据评估结论，面向用户，不超过80字")


class ComposeResult(StrictModel):
    """compose 节点产出：基于证据的答案。"""

    answer_markdown: str = Field(description="基于证据的完整中文回答，使用Markdown")
    summary: str = Field(description="一句话说明你如何组织了这个回答，面向用户，不超过80字")


class VerifyResult(StrictModel):
    """verify 节点产出：核验答案。"""

    passed: bool = Field(description="回答是否忠实于证据、无明显编造")
    action: Literal["pass", "rewrite", "research_more"] = Field(
        description="通过选pass；仅需改写选rewrite；缺证据选research_more"
    )
    issue: str = Field(default="", description="若未通过，指出问题；通过则留空")
    extra_queries: list[str] = Field(
        default_factory=list,
        description="research_more 时给出最多2条补充查询，否则为空",
        max_length=2,
    )
    summary: str = Field(description="一句话说明核验结论，面向用户，不超过80字")
