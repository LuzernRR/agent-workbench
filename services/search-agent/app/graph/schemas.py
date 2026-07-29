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


ResearchChannel = Literal["web", "x", "xiaohongshu"]


class PlannedSearch(StrictModel):
    query: str = Field(min_length=2, max_length=300)
    channel: ResearchChannel


class IntentResult(StrictModel):
    """classify_intent 节点产出。"""

    task_type: Literal[
        "direct_answer", "fact_lookup", "research", "comparison", "recommendation"
    ] = Field(description="任务类型")
    need_search: bool = Field(description="是否需要联网搜索才能可靠回答")
    channels: list[ResearchChannel] = Field(
        description="完成任务需要的只读搜索渠道；只允许 web、x、xiaohongshu",
        min_length=1,
        max_length=3,
    )
    summary: str = Field(description="一句话说明你如何理解这个任务，面向用户，不超过80字")


class PlanResult(StrictModel):
    """plan_research 节点产出。"""

    searches: list[PlannedSearch] = Field(
        description="1到4个查询与渠道组合，覆盖问题的不同方面并保留关键实体",
        min_length=1,
        max_length=4,
    )
    summary: str = Field(description="一句话说明你的检索计划，面向用户，不超过80字")


class SourcePresentation(StrictModel):
    """Reflector 对真实候选生成的公开单行说明。"""

    url: str = Field(min_length=8, max_length=2048)
    text: str = Field(
        min_length=1,
        max_length=500,
        description="只基于该候选可见字段写成的一句中文，不补造未读取事实；节点会再压缩到180字",
    )


class ReflectResult(StrictModel):
    """reflect 节点产出：判断证据是否足够。"""

    sufficient: bool = Field(description="现有证据是否足以回答问题")
    missing: str = Field(default="", description="若不足，缺什么；若足够，留空")
    extra_searches: list[PlannedSearch] = Field(
        default_factory=list,
        description="若不足，给出互补的查询与渠道组合；节点只接受前2个合法新组合",
        max_length=4,
    )
    source_presentations: list[SourcePresentation] = Field(
        default_factory=list,
        description="仅为当前轮候选 URL 生成逐条单行公开说明；节点只接受真实候选 URL",
        max_length=50,
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
    extra_searches: list[PlannedSearch] = Field(
        default_factory=list,
        description="research_more 时给出补充查询与渠道组合，否则为空；节点只接受前2个合法新组合",
        max_length=4,
    )
    summary: str = Field(description="一句话说明核验结论，面向用户，不超过80字")
