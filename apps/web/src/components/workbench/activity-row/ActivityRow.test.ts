import { fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { createEmptyThreadState, reduceAgentEvents } from "@/lib/agent-events/reducer";
import type { AgentEvent } from "@/lib/agent-events/types";
import { parseSearchAgentEvent } from "@/server/search-agent/events";
import { mapSearchAgentEvent } from "@/server/search-agent/mapper";
import { ActivityRow, isPlaceholderTool, SearchActivitySummary, summarizeSearchActivity } from "./ActivityRow";

describe("isPlaceholderTool", () => {
  it("filters generic activity placeholders", () => {
    expect(isPlaceholderTool({ name: "工具", summary: "正在准备" })).toBe(true);
    expect(isPlaceholderTool({ name: "网页搜索", summary: "正在准备" })).toBe(false);
  });

  it("does not render raw tool output or internal English errors", () => {
    render(createElement(ActivityRow, { item: {
      kind: "tool",
      id: "tool:search",
      runId: "run-one",
      toolCallId: "search",
      name: "网页搜索",
      summary: "搜索未完成",
      status: "failed",
      output: "{\"mimeType\":\"application/json\",\"private\":true}",
      error: "Internal Server Error",
      createdAt: "2026-07-24T00:00:00.000Z"
    } }));

    fireEvent.click(screen.getByRole("button", { name: "展开工具调用：网页搜索" }));
    expect(screen.getByText("工作台服务发生错误")).toBeInTheDocument();
    expect(screen.queryByText(/mimeType|application\/json|Internal Server Error/u)).not.toBeInTheDocument();
  });

  it("显示安全查询、结果计数与可点击来源，不渲染危险 URL", () => {
    render(createElement(ActivityRow, { item: {
      kind: "tool",
      id: "tool:search-safe",
      runId: "run-one",
      toolCallId: "search-safe",
      name: "网页搜索",
      summary: "找到 2 条结果",
      status: "completed",
      query: "LangGraph 官方文档",
      provider: "tavily",
      resultCount: 2,
      evidenceCount: 1,
      sources: [
        { title: "LangGraph 文档", url: "https://docs.langchain.com/oss/python/langgraph", verified: true },
        { title: "危险来源", url: "javascript:alert(1)", verified: false }
      ],
      createdAt: "2026-07-24T00:00:00.000Z"
    } }));

    fireEvent.click(screen.getByRole("button", { name: "展开工具调用：网页搜索" }));
    expect(screen.getByText("LangGraph 官方文档")).toBeInTheDocument();
    expect(screen.getByText("2 条候选，1 条已读取来源")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "LangGraph 文档" })).toHaveAttribute("href", "https://docs.langchain.com/oss/python/langgraph");
    expect(screen.queryByRole("link", { name: "危险来源" })).not.toBeInTheDocument();
    expect(screen.queryByText("执行中")).not.toBeInTheDocument();
  });

  it("unknown 工具明确提示未自动重试", () => {
    render(createElement(ActivityRow, { item: {
      kind: "tool",
      id: "tool:unknown",
      runId: "run-one",
      toolCallId: "unknown",
      name: "网页搜索",
      summary: "工具结果状态未知",
      status: "unknown",
      error: "OUTCOME_UNKNOWN",
      createdAt: "2026-07-24T00:00:00.000Z"
    } }));
    fireEvent.click(screen.getByRole("button", { name: "展开工具调用：网页搜索" }));
    expect(screen.getByText("结果状态未知，系统未自动重试")).toBeInTheDocument();
  });
});

describe("SearchActivitySummary", () => {
  it("安全验证直接提供当前工具会话链接，且不暴露内部错误码", () => {
    const base = {
      kind: "tool" as const,
      id: "tool:xiaohongshu-safety",
      runId: "run-one",
      toolCallId: "xiaohongshu-safety",
      name: "小红书搜索",
      summary: "搜索未完成",
      status: "waiting" as const,
      outcomeStatus: "failed" as const,
      channel: "xiaohongshu" as const,
      resultCount: 0,
      evidenceCount: 0,
      createdAt: "2026-08-01T00:00:00.000Z"
    };
    const view = render(createElement(SearchActivitySummary, {
      items: [{
        ...base,
        reasonCode: "CAPTCHA_REQUIRED",
        verificationStatus: "pending" as const,
        verificationHref: "/workbench/verify/xiaohongshu/run-one/abcdefghijklmnopqrstuvwxyzABCDEFGH123456789"
      }]
    }));

    expect(within(view.container).getByRole("button", { name: "收起搜索详情" })).toHaveAttribute("aria-expanded", "true");
    expect(within(view.container).getByRole("status")).toHaveTextContent("小红书工具账号需要安全验证");
    expect(view.container).toHaveTextContent("成功后当前搜索会自动继续");
    expect(within(view.container).getByRole("link", { name: "立即验证" })).toHaveAttribute(
      "href",
      "/workbench/verify/xiaohongshu/run-one/abcdefghijklmnopqrstuvwxyzABCDEFGH123456789"
    );
    expect(view.container).not.toHaveTextContent("CAPTCHA_REQUIRED");

    view.rerender(createElement(SearchActivitySummary, {
      items: [{ ...base, status: "failed" as const, reasonCode: "AUTH_REQUIRED", nextAction: "reconnect_account" as const }]
    }));
    expect(within(view.container).getByRole("status")).toHaveTextContent("当前无法安全确认原账号");
    expect(view.container).toHaveTextContent("不会打开无关页面或收集登录凭据");
    expect(within(view.container).queryByRole("link")).not.toBeInTheDocument();
    expect(view.container).not.toHaveTextContent("AUTH_REQUIRED");
  });

  it("已结束的当前搜索保持展开，下一步骤出现后再折叠", () => {
    const item = {
      kind: "tool" as const,
      id: "tool:search-current",
      runId: "run-one",
      toolCallId: "search-current",
      name: "网页搜索",
      summary: "找到 1 条结果",
      status: "completed" as const,
      resultCount: 1,
      evidenceCount: 1,
      sources: [{
        title: "已读来源",
        url: "https://example.com/current",
        verified: true,
        displayText: "这条来源文字已经完整流式展示。"
      }],
      createdAt: "2026-07-29T00:00:00.000Z"
    };
    const view = render(createElement(SearchActivitySummary, {
      items: [item],
      isCurrentStep: true
    }));

    expect(view.container.querySelector("[data-search-activity-summary]")).toHaveClass("workbench-disclosure-row");
    expect(view.container.querySelector("[data-search-activity-summary]")).not.toHaveClass("my-2");
    expect(within(view.container).getByRole("button", { name: "收起搜索详情" })).toHaveClass("workbench-disclosure-trigger");
    expect(within(view.container).getByRole("button", { name: "收起搜索详情" })).toHaveAttribute("aria-expanded", "true");
    expect(view.container.querySelector("[data-search-activity-details]")).toHaveTextContent("这条来源文字已经完整流式展示。");

    view.rerender(createElement(SearchActivitySummary, {
      items: [item],
      isCurrentStep: false
    }));
    expect(within(view.container).getByRole("button", { name: "展开搜索详情" })).toHaveAttribute("aria-expanded", "false");
    expect(view.container.querySelector("[data-search-activity-details]")).toBeNull();
  });

  it("搜索进行中自动展开，完成后折叠并保留真实累计计数与手动展开", () => {
    const running = {
      kind: "tool" as const,
      id: "tool:search-live",
      runId: "run-one",
      toolCallId: "search-live",
      name: "网页搜索",
      summary: "找到 2 条结果",
      status: "running" as const,
      resultCount: 2,
      evidenceCount: 1,
      sources: [{ title: "进行中的来源", url: "https://example.com/live", verified: true, displayText: "该来源给出了当前检索所需的有效信息。" }],
      createdAt: "2026-07-28T00:00:00.000Z"
    };
    const view = render(createElement(SearchActivitySummary, { items: [running] }));

    expect(within(view.container).getByRole("button", { name: "收起搜索详情" })).toHaveAttribute("aria-expanded", "true");
    expect(view.container).toHaveTextContent("搜索记录");
    expect(view.container.querySelector("[data-search-activity-details]")).toHaveTextContent("该来源给出了当前检索所需的有效信息。");

    view.rerender(createElement(SearchActivitySummary, {
      items: [{ ...running, status: "completed" as const }]
    }));
    expect(within(view.container).getByRole("button", { name: "展开搜索详情" })).toHaveAttribute("aria-expanded", "false");
    expect(view.container).toHaveTextContent("搜索记录");
    expect(view.container.querySelector("[data-search-activity-details]")).toBeNull();

    fireEvent.click(within(view.container).getByRole("button", { name: "展开搜索详情" }));
    expect(view.container.querySelector("[data-search-settlement]")).toHaveTextContent("找到 2 条结果，读取 1 个来源");
    expect(view.container.querySelector("[data-search-activity-details]")).toHaveTextContent("该来源给出了当前检索所需的有效信息。");

    const nextRunning = {
      ...running,
      id: "tool:search-next",
      toolCallId: "search-next",
      resultCount: 3,
      sources: [{ title: "下一轮来源", url: "https://example.com/next", verified: true, displayText: "下一轮读取了另一条有效来源。" }]
    };
    view.rerender(createElement(SearchActivitySummary, {
      items: [{ ...running, status: "completed" as const }, nextRunning]
    }));
    expect(within(view.container).getByRole("button", { name: "收起搜索详情" })).toHaveAttribute("aria-expanded", "true");
    expect(view.container.querySelectorAll("[data-search-settlement]")).toHaveLength(1);
    expect(view.container.querySelector("[data-search-settlement]")).toHaveTextContent("找到 2 条结果，读取 1 个来源");
    expect(view.container.querySelector("[data-search-activity-details]")).toHaveTextContent("下一轮读取了另一条有效来源。");

    view.rerender(createElement(SearchActivitySummary, {
      items: [
        { ...running, status: "completed" as const },
        { ...nextRunning, status: "completed" as const }
      ]
    }));
    expect(within(view.container).getByRole("button", { name: "展开搜索详情" })).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(within(view.container).getByRole("button", { name: "展开搜索详情" }));
    const settlements = view.container.querySelectorAll("[data-search-settlement]");
    expect(settlements).toHaveLength(2);
    expect(settlements[0]).toHaveTextContent("找到 2 条结果，读取 1 个来源");
    expect(settlements[1]).toHaveTextContent("找到 3 条结果，读取 1 个来源");
  });

  it("来源文字仍在流式展示时重新展开，展示完成后自动折叠", () => {
    const item = {
      kind: "tool" as const,
      id: "tool:source-stream",
      runId: "run-one",
      toolCallId: "source-stream",
      name: "小红书搜索",
      summary: "搜索完成",
      status: "completed" as const,
      resultCount: 3,
      evidenceCount: 1,
      sourcePresentationActive: true,
      sources: [{
        title: "已读取来源",
        url: "https://example.com/read",
        verified: true,
        channel: "xiaohongshu" as const,
        displayText: "正在增长"
      }],
      createdAt: "2026-07-29T00:00:00.000Z"
    };
    const view = render(createElement(SearchActivitySummary, { items: [item] }));
    expect(within(view.container).getByRole("button", { name: "收起搜索详情" })).toHaveAttribute("aria-expanded", "true");
    expect(view.container.querySelector("[data-search-activity-details]")).toHaveTextContent("正在增长");

    view.rerender(createElement(SearchActivitySummary, {
      items: [{ ...item, sourcePresentationActive: false }]
    }));
    expect(within(view.container).getByRole("button", { name: "展开搜索详情" })).toHaveAttribute("aria-expanded", "false");
    expect(view.container.querySelector("[data-search-activity-details]")).toBeNull();
  });

  it("把多次真实搜索合并成一条纯文字，并按 URL 去重来源", () => {
    const items = [
      {
        kind: "tool" as const,
        id: "tool:search-1",
        runId: "run-one",
        toolCallId: "search-1",
        name: "网页搜索",
        summary: "找到 5 条结果",
        status: "completed" as const,
        resultCount: 5,
        evidenceCount: 1,
        sources: [
          { title: "来源一", url: "https://example.com/one", verified: true, channel: "x" as const, author: "OpenAI", displayText: "这条帖子介绍了状态图的公开实践。" },
          { title: "来源二", url: "https://example.com/two", verified: false }
        ],
        createdAt: "2026-07-28T00:00:00.000Z"
      },
      {
        kind: "tool" as const,
        id: "tool:search-2",
        runId: "run-one",
        toolCallId: "search-2",
        name: "网页搜索",
        summary: "找到 5 条结果",
        status: "completed" as const,
        resultCount: 5,
        evidenceCount: 2,
        sources: [
          { title: "来源一重复", url: "https://example.com/one", verified: true, channel: "web" as const, displayText: "后一轮对同一来源给出了更新说明。" },
          { title: "来源三", url: "https://example.com/three", verified: true, displayText: "另一来源补充了状态持久化的实现细节。" }
        ],
        createdAt: "2026-07-28T00:00:01.000Z"
      }
    ];

    expect(summarizeSearchActivity(items)).toBe("找到 10 条结果，读取 2 个来源");
    const { container } = render(createElement(SearchActivitySummary, { items }));

    const line = container.querySelector("[data-search-activity-summary]");
    expect(line).toHaveTextContent("搜索记录");
    expect(line).toHaveAttribute("data-tool-call-count", "2");
    expect(line).toHaveAttribute("data-tool-call-ids", "search-1,search-2");
    const toggle = container.querySelector('button[aria-label="展开搜索详情"]');
    expect(toggle).not.toBeNull();
    fireEvent.click(toggle!);
    const detailPanel = container.querySelector("[data-search-activity-details]");
    const settlements = detailPanel?.querySelectorAll("[data-search-settlement]");
    expect(settlements).toHaveLength(2);
    expect(settlements?.[0]).toHaveTextContent("找到 5 条结果，读取 1 个来源");
    expect(settlements?.[1]).toHaveTextContent("找到 5 条结果，读取 2 个来源");
    expect(detailPanel).toHaveTextContent("网页 · 后一轮对同一来源给出了更新说明。");
    expect(detailPanel).not.toHaveTextContent("这条帖子介绍了状态图的公开实践。");
    expect(detailPanel).toHaveTextContent("另一来源补充了状态持久化的实现细节。");
    expect(detailPanel).not.toHaveTextContent("来源二");
    expect(detailPanel).not.toHaveTextContent(/搜索服务|执行耗时|检索查询|检索计划|核验结论/u);
    expect(within(detailPanel as HTMLElement).queryByText("状态")).not.toBeInTheDocument();
    expect(detailPanel?.querySelectorAll("p")).toHaveLength(4);
    expect(detailPanel?.querySelectorAll("a")).toHaveLength(2);
    expect(container.querySelector("table")).toBeNull();
  });

  it("把末尾斜杠不同的同一来源合并为一个可展开详情", () => {
    const base = {
      kind: "tool" as const,
      runId: "run-one",
      name: "网页搜索",
      summary: "搜索完成",
      status: "completed" as const,
      resultCount: 1,
      evidenceCount: 1,
      createdAt: "2026-07-29T00:00:00.000Z"
    };
    const items = [
      {
        ...base,
        id: "tool:slash-one",
        toolCallId: "slash-one",
        sources: [{
          title: "来源一",
          url: "https://example.com/topic",
          verified: true,
          displayText: "该来源提供了可核验的主题说明。"
        }]
      },
      {
        ...base,
        id: "tool:slash-two",
        toolCallId: "slash-two",
        sources: [{
          title: "来源一规范地址",
          url: "https://example.com/topic/",
          verified: true,
          displayText: "该来源的说明已由 Agent 润色。"
        }]
      }
    ];
    const { container } = render(createElement(SearchActivitySummary, { items }));

    expect(container).toHaveTextContent("搜索记录");
    fireEvent.click(within(container).getByRole("button", { name: "展开搜索详情" }));
    expect(container.querySelectorAll("[data-search-settlement]")).toHaveLength(2);
    expect(container.querySelectorAll("[data-search-activity-details] a")).toHaveLength(1);
    expect(container.querySelector("[data-search-activity-details]")).toHaveTextContent("该来源的说明已由 Agent 润色。");
  });

  it("每个真实完成事件新增一条不可改写的完成记录", () => {
    const first = {
      kind: "tool" as const,
      id: "tool:search-1",
      runId: "run-one",
      toolCallId: "search-1",
      name: "网页搜索",
      summary: "找到 5 条结果",
      status: "completed" as const,
      resultCount: 5,
      evidenceCount: 1,
      sources: [{ title: "来源一", url: "https://example.com/one", verified: true }],
      createdAt: "2026-07-28T00:00:00.000Z"
    };
    const second = {
      ...first,
      id: "tool:search-2",
      toolCallId: "search-2",
      evidenceCount: 2,
      sources: [
        { title: "来源二", url: "https://example.com/two", verified: true },
        { title: "来源三", url: "https://example.com/three", verified: true }
      ]
    };
    const third = {
      ...first,
      id: "tool:search-3",
      toolCallId: "search-3",
      evidenceCount: 2,
      sources: [
        { title: "来源三重复", url: "https://example.com/three", verified: true },
        { title: "来源四", url: "https://example.com/four", verified: true }
      ]
    };
    const view = render(createElement(SearchActivitySummary, { items: [first] }));
    fireEvent.click(within(view.container).getByRole("button", { name: "展开搜索详情" }));
    expect(view.container.querySelectorAll("[data-search-settlement]")).toHaveLength(1);
    expect(view.container.querySelector("[data-search-settlement]")).toHaveTextContent("找到 5 条结果，读取 1 个来源");
    view.rerender(createElement(SearchActivitySummary, { items: [first, second] }));
    fireEvent.click(within(view.container).getByRole("button", { name: "展开搜索详情" }));
    let settlements = view.container.querySelectorAll("[data-search-settlement]");
    expect(settlements).toHaveLength(2);
    expect(settlements[0]).toHaveTextContent("找到 5 条结果，读取 1 个来源");
    expect(settlements[1]).toHaveTextContent("找到 5 条结果，读取 2 个来源");
    view.rerender(createElement(SearchActivitySummary, { items: [first, second, third] }));
    fireEvent.click(within(view.container).getByRole("button", { name: "展开搜索详情" }));
    settlements = view.container.querySelectorAll("[data-search-settlement]");
    expect(settlements).toHaveLength(3);
    expect(settlements[0]).toHaveTextContent("找到 5 条结果，读取 1 个来源");
    expect(settlements[1]).toHaveTextContent("找到 5 条结果，读取 2 个来源");
    expect(settlements[2]).toHaveTextContent("找到 5 条结果，读取 2 个来源");
  });
});

describe("ActivityRow activity disclosure", () => {
  it("完整保留受控降级事件并在刷新重建后显示首选与实际服务", () => {
    const eventBase = {
      version: 1 as const,
      streamId: "stream_degraded",
      createdAt: "2026-08-01T00:00:00.000Z"
    };
    const started = parseSearchAgentEvent({
      ...eventBase,
      eventId: "event_degraded_1",
      streamSeq: 1,
      seq: 1,
      type: "tool.started",
      toolCallId: "call_degraded",
      toolName: "web_search",
      query: "AI 编程工具",
      channel: "xiaohongshu",
      cached: false
    });
    const completed = parseSearchAgentEvent({
      ...eventBase,
      eventId: "event_degraded_2",
      streamSeq: 2,
      seq: 2,
      type: "tool.completed",
      toolCallId: "call_degraded",
      toolName: "web_search",
      query: "AI 编程工具",
      channel: "xiaohongshu",
      provider: "xiaohongshu-mcp",
      status: "degraded",
      primaryProvider: "xiaohongshu-mcp",
      effectiveProvider: "tavily",
      reasonCode: "MCP_TIMEOUT",
      message: "小红书读取超时，已使用受控备用渠道",
      retryable: true,
      nextAction: "use_fallback",
      summary: "已使用备用公开搜索读取 1 个来源",
      resultCount: 3,
      evidenceCount: 1,
      results: [{
        channel: "web",
        provider: "tavily",
        query: "AI 编程工具",
        title: "公开来源",
        url: "https://example.com/evidence",
        snippet: "可核验正文",
        verified: true,
        author: null,
        published_at: null,
        metrics: {},
        limitation: null,
        provenance: {
          discovery_provider: "tavily",
          detail_provider: "trafilatura",
          source_kind: "public_page",
          observed_at: "2026-08-01T00:00:00.000Z",
          confidence: "high"
        }
      }],
      cached: false,
      durationMs: 4200
    });
    const persisted = [started, completed].flatMap((sourceEvent) =>
      mapSearchAgentEvent(sourceEvent, "run-degraded").events
    ).map((projected, index) => ({
      id: `persisted-${index + 1}`,
      projectId: "project",
      threadId: "thread",
      runId: "run-degraded",
      seq: index + 1,
      type: projected.type,
      payload: projected.payload,
      createdAt: "2026-08-01T00:00:00.000Z"
    } satisfies AgentEvent));
    const state = reduceAgentEvents(createEmptyThreadState("project", "thread"), persisted);
    const rebuilt = reduceAgentEvents(createEmptyThreadState("project", "thread"), persisted);
    expect(rebuilt).toEqual(state);

    const item = state.items["tool:call_degraded"];
    expect(item).toMatchObject({
      kind: "tool",
      outcomeStatus: "degraded",
      primaryProvider: "xiaohongshu-mcp",
      effectiveProvider: "tavily",
      reasonCode: "MCP_TIMEOUT",
      retryable: true,
      nextAction: "use_fallback"
    });
    if (!item || item.kind !== "tool") throw new Error("缺少受控降级工具项");
    const view = render(createElement(ActivityRow, { item }));
    fireEvent.click(within(view.container).getByRole("button", { name: "展开工具调用：小红书搜索" }));
    expect(view.container).toHaveTextContent("受控降级");
    expect(view.container).toHaveTextContent("小红书读取超时，已使用受控备用渠道");
    expect(view.container).toHaveTextContent("搜索服务tavily");
    expect(view.container).toHaveTextContent("首选服务xiaohongshu-mcp");
    expect(view.container).toHaveTextContent("已使用受控备用渠道");
    expect(within(view.container).getByRole("link", { name: "公开来源" })).toHaveAttribute("href", "https://example.com/evidence");
  });

  it("普通工具进行中自动展开，完成后折叠且允许手动查看", () => {
    const running = {
      kind: "tool" as const,
      id: "tool:context",
      runId: "run-one",
      toolCallId: "context",
      name: "上下文读取",
      summary: "读取项目文档",
      status: "running" as const,
      createdAt: "2026-07-28T00:00:00.000Z"
    };
    const view = render(createElement(ActivityRow, { item: running }));

    expect(view.container.querySelector('[data-tool-call-id="context"]')).toHaveClass("workbench-disclosure-row");
    expect(view.container.querySelector('[data-tool-call-id="context"]')).not.toHaveClass("my-2");
    expect(screen.getByRole("button", { name: "收起工具调用：上下文读取" })).toHaveClass("workbench-disclosure-trigger");
    expect(screen.getByRole("button", { name: "收起工具调用：上下文读取" })).toHaveAttribute("aria-expanded", "true");
    expect(view.container).toHaveTextContent("执行耗时");

    view.rerender(createElement(ActivityRow, {
      item: { ...running, status: "completed" as const }
    }));
    expect(screen.getByRole("button", { name: "展开工具调用：上下文读取" })).toHaveAttribute("aria-expanded", "false");
    expect(view.container).not.toHaveTextContent("执行耗时");

    fireEvent.click(screen.getByRole("button", { name: "展开工具调用：上下文读取" }));
    expect(within(view.container).getAllByText("已完成")).toHaveLength(2);
  });

  it("显示公开 Evidence 生命周期状态", () => {
    render(createElement(ActivityRow, { item: {
      kind: "tool",
      id: "tool:evidence",
      runId: "run-one",
      toolCallId: "evidence",
      name: "网页搜索",
      summary: "搜索完成",
      status: "completed",
      sources: [{
        title: "被答案引用的来源",
        url: "https://example.com/source",
        verified: true,
        evidenceId: "evidence_one",
        sourceId: "source_one",
        contentHash: "d".repeat(64),
        evidenceStatus: "cited",
        evidenceReasonCode: "ANSWER_CITED",
        evidenceUpdatedAt: "2026-08-01T00:00:01Z"
      }],
      createdAt: "2026-08-01T00:00:00Z"
    } }));

    fireEvent.click(screen.getByRole("button", { name: "展开工具调用：网页搜索" }));
    expect(screen.getByText("已引用")).toBeInTheDocument();
  });
});
