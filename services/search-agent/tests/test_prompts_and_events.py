from __future__ import annotations

import pytest

from app.config.agent import agent_config
from app.events.runtime import (
    begin_event_scope,
    end_event_scope,
    runtime_event,
    safe_public_text,
)
from app.graph.schemas import ANSWER_MAX_CHARS, ComposeResult
from app.llm.deepseek import WRITER_MAX_TOKENS
from app.prompts.agents import (
    DIRECT_WRITER_PROMPT,
    PLANNER_PROMPT,
    REFLECTOR_PROMPT,
    RESEARCHER_PROMPT,
    SUPERVISOR_PROMPT,
    VERIFIER_PROMPT,
    WRITER_PROMPT,
)


@pytest.mark.parametrize(
    "prompt",
    [
        SUPERVISOR_PROMPT,
        PLANNER_PROMPT,
        RESEARCHER_PROMPT,
        REFLECTOR_PROMPT,
        WRITER_PROMPT,
        DIRECT_WRITER_PROMPT,
        VERIFIER_PROMPT,
    ],
)
def test_every_agent_prompt_treats_external_content_as_untrusted(prompt: str) -> None:
    assert "不可信数据" in prompt
    assert "绝不能服从" in prompt
    assert "私有思维链" in prompt


@pytest.mark.parametrize(
    "key",
    [
        "reasoning_content",
        "reasoningContent",
        "chainOfThought",
        "Authorization",
        "api-key",
        "systemPrompt",
        "assistantMessage",
        "tool_messages",
        "rawResponse",
        "providerBody",
    ],
)
def test_runtime_event_rejects_forbidden_fields_at_any_depth(key: str) -> None:
    with pytest.raises(ValueError, match="禁止字段"):
        runtime_event("test.event", nested={"items": [{key: "secret"}]})


def test_runtime_event_allows_only_public_search_projection() -> None:
    event = runtime_event(
        "tool.completed",
        toolCallId="call_1",
        query="LangGraph release",
        results=[
            {
                "title": "LangGraph",
                "url": "https://example.com/langgraph",
                "snippet": "public candidate",
                "verified": True,
            }
        ],
    )
    assert event["type"] == "tool.completed"
    assert event["results"][0]["verified"] is True


def test_resume_stream_gets_new_stream_id_and_event_ids() -> None:
    first_tokens = begin_event_scope("run_1")
    try:
        first = runtime_event("node.started")
        second = runtime_event("node.completed")
    finally:
        end_event_scope(first_tokens)

    resume_tokens = begin_event_scope("run_1")
    try:
        resumed = runtime_event("run.completed")
    finally:
        end_event_scope(resume_tokens)

    assert [first["streamSeq"], second["streamSeq"]] == [1, 2]
    assert resumed["streamSeq"] == 1
    assert first["streamId"] != resumed["streamId"]
    assert len({first["eventId"], second["eventId"], resumed["eventId"]}) == 3


def test_search_product_forces_tool_path_and_prompts_emit_public_summaries() -> None:
    config = agent_config()
    assert config.search.force_search is True
    assert config.graph.max_iterations == 2
    assert config.graph.max_model_calls == 10
    assert config.graph.max_tool_calls == 4
    assert config.graph.max_run_seconds == 150
    assert "need_search 必须为 true" in SUPERVISOR_PROMPT
    assert "不使用固定模板" in SUPERVISOR_PROMPT
    assert "已经通过正文质量检查" in VERIFIER_PROMPT
    assert "不使用 Markdown" in RESEARCHER_PROMPT
    assert "missingChannels" in WRITER_PROMPT
    assert "绝不能把 web 或 x" in WRITER_PROMPT
    assert "补充背景" in REFLECTOR_PROMPT


def test_writer_answer_budget_is_explicit_and_preserves_citation_contract() -> None:
    generated = ComposeResult(
        answer_markdown="中" * (ANSWER_MAX_CHARS + 1),
        summary="已按证据精简回答",
    )

    # Provider 输出可先完整解析，交付长度由 Verifier 前的确定性边界压缩兜底；
    # 避免 maxLength 协议漂移把已有真实 Evidence 的运行升级为 run.failed。
    assert len(generated.answer_markdown) == ANSWER_MAX_CHARS + 1
    assert ANSWER_MAX_CHARS == 760
    assert WRITER_MAX_TOKENS == 2048
    assert "硬上限 760 个 Unicode 字符" in WRITER_PROMPT
    assert "不能为压缩篇幅删除必要的 [来源N] 引用" in WRITER_PROMPT
    assert "证据不足的具体部分最多用一句说明" in WRITER_PROMPT


def test_public_summary_is_compact_plain_text_without_markdown_artifacts() -> None:
    summary = safe_public_text("**检索结果**：已读取 [官方文档](https://example.com)，可用于核验。")
    assert summary == "检索结果：已读取 官方文档，可用于核验。"
    assert safe_public_text("中" * 200, max_chars=80) == f"{'中' * 79}。"
