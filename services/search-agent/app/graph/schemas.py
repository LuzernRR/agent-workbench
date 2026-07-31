"""节点的结构化输出 schema。

每个模型节点通过 `with_structured_output` 强制返回这些 Pydantic 模型，
避免解析自由文本。字段刻意精简，只保留驱动流程和生成思考摘要所需的内容。

所有 `summary` 字段都是面向用户的思考摘要，模型被要求写成
一句简短中文，不含私有推理过程。
"""

from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


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
    include_in_details: bool = Field(
        description=(
            "只有该来源直接支持用户当前问题、且符合用户的筛选条件时才为 true；"
            "不相关、不适用、过期或仅用于排除的来源必须为 false"
        )
    )
    text: str = Field(
        min_length=0,
        max_length=500,
        description=(
            "include_in_details=true 时，只基于已读取正文写成一句有效中文；"
            "false 时必须为空字符串。节点会再压缩到180字"
        ),
    )


_INEFFECTIVE_PRESENTATION_TEXT = re.compile(
    r"(?:未(?:成功)?(?:读取|加载|获取|核验|验证)|"
    r"仅(?:发现|检索到).{0,12}(?:候选|索引)|"
    r"(?:仅|只).{0,12}(?:标题|标签|话题|关键词)|"
    r"(?:未|没有).{0,6}(?:展开|涉及|提及|覆盖|包含|提供).{0,60}"
    r"(?:对比|区别|内容|信息|说明|细节|证据)|"
    r"(?:无|没有|缺少).{0,12}(?:有效|实质|相关).{0,8}"
    r"(?:内容|信息|证据|说明))",
)


class CuratedSourcePresentation(SourcePresentation):
    """Source Curator 必须返回能直接展示的有效说明。"""

    @model_validator(mode="after")
    def require_effective_text(self) -> CuratedSourcePresentation:
        if not self.include_in_details:
            if self.text:
                raise ValueError("不纳入详情的来源不得生成公开说明")
            return self
        if not self.text or _INEFFECTIVE_PRESENTATION_TEXT.search(self.text):
            raise ValueError("来源说明必须包含正文中的有效信息")
        return self


class SourcePresentationResult(StrictModel):
    """独立 Source Curator Agent 的结构化结果。"""

    source_presentations: list[CuratedSourcePresentation] = Field(
        description="只为直接支持用户问题的已读取来源生成可直接展示的中文说明；可以为空",
        min_length=0,
        max_length=10,
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
        description="为当前轮每一条已读取 Evidence URL 各生成一条有效说明；未读候选不得出现",
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
