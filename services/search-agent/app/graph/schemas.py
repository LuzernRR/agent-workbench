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

from app.graph.query_strategy import (
    EvidenceGapProposal,
    QueryBrief,
    RewriteStrategy,
)


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


ResearchChannel = Literal["web", "x", "xiaohongshu"]
ANSWER_MAX_CHARS = 760
STRUCTURED_ANSWER_MAX_CHARS = 1100


class PlannedSearch(StrictModel):
    query: str = Field(min_length=2, max_length=300)
    channel: ResearchChannel


class FollowUpSearch(StrictModel):
    """Reflector/Verifier proposal bound to one observed evidence gap."""

    query: str = Field(min_length=2, max_length=300)
    channel: ResearchChannel
    facet_id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_.:-]+$")
    query_terms: list[str] = Field(min_length=1, max_length=12)
    strategy: RewriteStrategy
    gap_id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_.:-]+$")
    parent_attempt_id: str = Field(
        min_length=1,
        max_length=64,
        pattern=r"^[A-Za-z0-9_.:-]+$",
    )
    retained_constraint_ids: list[str] = Field(max_length=40)
    relaxed_should_ids: list[str] = Field(max_length=12)

    @model_validator(mode="after")
    def validate_ids(self) -> FollowUpSearch:
        for label, values in (
            ("query_terms", self.query_terms),
            ("retained_constraint_ids", self.retained_constraint_ids),
            ("relaxed_should_ids", self.relaxed_should_ids),
        ):
            if len(values) != len(set(values)):
                raise ValueError(f"{label} 不得重复")
        return self


class PlannedStep(StrictModel):
    """Planner 生成的局部步骤；稳定运行时 ID 由服务端分配。"""

    local_id: str = Field(
        min_length=1,
        max_length=64,
        pattern=r"^[A-Za-z0-9_.:-]+$",
        description="计划内唯一局部标识，例如 source_a；不得包含用户数据或密钥",
    )
    facet_id: str = Field(
        min_length=1,
        max_length=64,
        pattern=r"^[A-Za-z0-9_.:-]+$",
    )
    facet: str = Field(min_length=1, max_length=200)
    objective: str = Field(min_length=1, max_length=500)
    query_terms: list[str] = Field(min_length=1, max_length=12)
    strategy: RewriteStrategy
    query: str = Field(min_length=2, max_length=300)
    channel: ResearchChannel
    gap_id: str | None = Field(
        description="首轮必须为 null；补搜必须引用私有 open gapId"
    )
    parent_attempt_id: str | None = Field(
        description="首轮必须为 null；补搜必须引用已确认 attemptId"
    )
    retained_constraint_ids: list[str] = Field(max_length=40)
    relaxed_should_ids: list[str] = Field(max_length=12)
    depends_on: list[str] = Field(
        description="依赖的本计划 local_id；没有依赖时也必须显式返回空数组",
        max_length=4,
    )
    priority: int = Field(ge=0, le=100)
    evidence_needed: int = Field(ge=0, le=10)
    can_parallelize: bool

    @model_validator(mode="after")
    def validate_query_metadata(self) -> PlannedStep:
        for label, values in (
            ("query_terms", self.query_terms),
            ("retained_constraint_ids", self.retained_constraint_ids),
            ("relaxed_should_ids", self.relaxed_should_ids),
        ):
            if len(values) != len(set(values)):
                raise ValueError(f"{label} 不得重复")
        if self.strategy == "initial_precise":
            if self.gap_id is not None or self.parent_attempt_id is not None:
                raise ValueError("首轮策略不得携带 gap_id 或 parent_attempt_id")
        elif self.gap_id is None or self.parent_attempt_id is None:
            raise ValueError("补搜策略必须携带 gap_id 与 parent_attempt_id")
        return self


class IntentResult(StrictModel):
    """classify_intent 节点产出。"""

    task_type: Literal[
        "direct_answer", "fact_lookup", "research", "comparison", "recommendation"
    ] = Field(description="任务类型")
    need_search: bool = Field(description="是否需要联网搜索才能可靠回答")
    channels: list[ResearchChannel] = Field(
        description="需要搜索时的只读渠道；直接回答时必须为空数组",
        min_length=0,
        max_length=3,
    )
    use_history: bool = Field(
        description="当前消息是否含有必须依赖会话历史才能消解的明确指代"
    )
    evidence_depth: Literal["single_fact", "multi_source"] = Field(
        description=(
            "取证深度：single_fact 表示一次检索读到权威正文即可确定答案；"
            "multi_source 表示需要多来源交叉。必须按语义判断，不得套关键词或固定问答模板"
        )
    )
    fast_search: PlannedSearch | None = Field(
        description="single_fact 时唯一一次检索的 query 与渠道；其余情况必须为 null"
    )
    query_brief: QueryBrief | None = Field(
        description="搜索任务的私有结构化查询简报；直接回答时必须为 null"
    )
    summary: str = Field(description="一句话说明你如何理解这个任务，面向用户，不超过80字")

    @model_validator(mode="after")
    def validate_route(self) -> IntentResult:
        if self.need_search and not self.channels:
            raise ValueError("需要搜索的任务必须至少选择一个渠道")
        if not self.need_search and self.channels:
            raise ValueError("直接回答不得携带搜索渠道")
        if not self.need_search and self.task_type != "direct_answer":
            raise ValueError("无需搜索的任务必须路由为 direct_answer")
        if self.need_search and self.query_brief is None:
            raise ValueError("需要搜索的任务必须显式返回 query_brief")
        if not self.need_search and self.query_brief is not None:
            raise ValueError("直接回答不得携带 query_brief")
        if self.query_brief is not None:
            required = set(self.query_brief.required_channels)
            if not required <= set(self.channels):
                raise ValueError("query_brief.required_channels 必须属于 channels")
        # 不搜索就不存在取证深度，只允许中性取值，避免出现无意义组合。
        if not self.need_search and self.evidence_depth != "multi_source":
            raise ValueError("无需搜索的任务取证深度必须为 multi_source")
        if self.evidence_depth == "single_fact":
            if self.fast_search is None:
                raise ValueError("single_fact 必须给出 fast_search")
            # 多渠道即多来源，与「一次检索即可确定」自相矛盾。
            if len(self.channels) != 1:
                raise ValueError("single_fact 只允许一个渠道")
            if self.fast_search.channel not in self.channels:
                raise ValueError("fast_search 渠道必须在 channels 内")
        elif self.fast_search is not None:
            raise ValueError("非 single_fact 不得携带 fast_search")
        return self


class PlanResult(StrictModel):
    """plan_research 节点产出。"""

    steps: list[PlannedStep] = Field(
        description="1到4个原子检索步骤，包含目标、查询、渠道、依赖与证据要求",
        min_length=1,
        max_length=4,
    )
    summary: str = Field(description="一句话说明你的检索计划，面向用户，不超过80字")

    @model_validator(mode="after")
    def validate_step_graph(self) -> PlanResult:
        ids = [step.local_id for step in self.steps]
        if len(ids) != len(set(ids)):
            raise ValueError("计划步骤 local_id 必须唯一")
        known = set(ids)
        dependencies: dict[str, list[str]] = {}
        query_keys: set[tuple[str, ResearchChannel]] = set()
        roots = 0
        for step in self.steps:
            if len(step.depends_on) != len(set(step.depends_on)):
                raise ValueError("计划步骤依赖不得重复")
            if step.local_id in step.depends_on:
                raise ValueError("计划步骤不得依赖自身")
            if any(dependency not in known for dependency in step.depends_on):
                raise ValueError("计划步骤包含未知依赖")
            dependencies[step.local_id] = list(step.depends_on)
            roots += int(not step.depends_on)
            query_key = (" ".join(step.query.casefold().split()), step.channel)
            if query_key in query_keys:
                raise ValueError("计划不得重复 query+channel")
            query_keys.add(query_key)
        if roots == 0:
            raise ValueError("计划至少需要一个无依赖根步骤")

        visiting: set[str] = set()
        visited: set[str] = set()

        def has_cycle(step_id: str) -> bool:
            if step_id in visiting:
                return True
            if step_id in visited:
                return False
            visiting.add(step_id)
            if any(has_cycle(dependency) for dependency in dependencies[step_id]):
                return True
            visiting.remove(step_id)
            visited.add(step_id)
            return False

        if any(has_cycle(step_id) for step_id in ids):
            raise ValueError("计划依赖图不得包含环")
        return self


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
    missing: str = Field(description="若不足，缺什么；若足够，必须显式返回空字符串")
    extra_searches: list[FollowUpSearch] = Field(
        description=(
            "若不足，给出互补的查询与渠道组合；节点只接受前2个合法新组合；"
            "无需补搜时也必须显式返回空数组"
        ),
        max_length=4,
    )
    evidence_gaps: list[EvidenceGapProposal] = Field(
        description="证据不足时的 typed gap；充分时必须为空数组",
        max_length=8,
    )
    source_presentations: list[SourcePresentation] = Field(
        description=(
            "为当前轮每一条已读取 Evidence URL 各生成一条有效说明；未读候选不得出现；"
            "没有可展示来源时也必须显式返回空数组"
        ),
        max_length=50,
    )
    summary: str = Field(description="一句话说明证据评估结论，面向用户，不超过80字")

    @model_validator(mode="after")
    def validate_gap_links(self) -> ReflectResult:
        gap_id_values = [item.gap_id for item in self.evidence_gaps]
        gap_ids = set(gap_id_values)
        if len(gap_id_values) != len(gap_ids):
            raise ValueError("evidence_gaps gap_id 不得重复")
        if self.sufficient and (self.extra_searches or self.evidence_gaps):
            raise ValueError("证据充分时不得返回补搜或 evidence_gaps")
        if not self.sufficient and not self.evidence_gaps:
            raise ValueError("证据不足时必须返回 typed evidence_gaps")
        if any(item.gap_id not in gap_ids for item in self.extra_searches):
            raise ValueError("补搜必须绑定本次 evidence_gaps")
        return self


class VerifyResult(StrictModel):
    """verify 节点产出：核验答案。"""

    passed: bool = Field(description="回答是否忠实于证据、无明显编造")
    action: Literal["pass", "rewrite", "research_more"] = Field(
        description="通过选pass；仅需改写选rewrite；缺证据选research_more"
    )
    issue: str = Field(description="若未通过，指出问题；通过时必须显式返回空字符串")
    extra_searches: list[FollowUpSearch] = Field(
        description=(
            "research_more 时给出补充查询与渠道组合，否则必须显式返回空数组；"
            "节点只接受前2个合法新组合"
        ),
        max_length=4,
    )
    evidence_gaps: list[EvidenceGapProposal] = Field(
        description="research_more 时的 typed gap；其余动作必须为空数组",
        max_length=8,
    )
    summary: str = Field(description="一句话说明核验结论，面向用户，不超过80字")

    @model_validator(mode="after")
    def validate_gap_links(self) -> VerifyResult:
        if self.passed:
            if self.action != "pass" or self.issue or self.extra_searches or self.evidence_gaps:
                raise ValueError(
                    "passed=true 必须使用 pass，且不得携带问题、补搜或 evidence_gaps"
                )
        else:
            if self.action == "pass":
                raise ValueError("passed=false 不得使用 pass")
            if not self.issue.strip():
                raise ValueError("passed=false 必须说明未通过问题")
        gap_id_values = [item.gap_id for item in self.evidence_gaps]
        gap_ids = set(gap_id_values)
        if len(gap_id_values) != len(gap_ids):
            raise ValueError("evidence_gaps gap_id 不得重复")
        if self.action == "research_more":
            if not self.evidence_gaps:
                raise ValueError("research_more 必须返回 typed evidence_gaps")
            if any(item.gap_id not in gap_ids for item in self.extra_searches):
                raise ValueError("补搜必须绑定本次 evidence_gaps")
        elif self.extra_searches or self.evidence_gaps:
            raise ValueError("pass/rewrite 不得返回补搜或 evidence_gaps")
        return self
