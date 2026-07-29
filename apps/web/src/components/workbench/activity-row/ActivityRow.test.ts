import { fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
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
      sources: [{ title: "进行中的来源", url: "https://example.com/live", verified: true }],
      createdAt: "2026-07-28T00:00:00.000Z"
    };
    const view = render(createElement(SearchActivitySummary, { items: [running] }));

    expect(screen.getByRole("button", { name: "收起搜索详情" })).toHaveAttribute("aria-expanded", "true");
    expect(view.container).toHaveTextContent("搜索中");
    expect(view.container.querySelector("[data-search-activity-details]")).toHaveTextContent("进行中的来源");

    view.rerender(createElement(SearchActivitySummary, {
      items: [{ ...running, status: "completed" as const }]
    }));
    expect(screen.getByRole("button", { name: "展开搜索详情" })).toHaveAttribute("aria-expanded", "false");
    expect(view.container).toHaveTextContent("找到 2 条结果，读取 1 个来源");
    expect(view.container.querySelector("[data-search-activity-details]")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "展开搜索详情" }));
    expect(view.container.querySelector("[data-search-activity-details]")).toHaveTextContent("进行中的来源");

    const nextRunning = {
      ...running,
      id: "tool:search-next",
      toolCallId: "search-next",
      resultCount: 3,
      sources: [{ title: "下一轮来源", url: "https://example.com/next", verified: true }]
    };
    view.rerender(createElement(SearchActivitySummary, {
      items: [{ ...running, status: "completed" as const }, nextRunning]
    }));
    expect(screen.getByRole("button", { name: "收起搜索详情" })).toHaveAttribute("aria-expanded", "true");
    expect(view.container).toHaveTextContent("搜索中");
    expect(view.container.querySelector("[data-search-activity-details]")).toHaveTextContent("下一轮来源");

    view.rerender(createElement(SearchActivitySummary, {
      items: [
        { ...running, status: "completed" as const },
        { ...nextRunning, status: "completed" as const }
      ]
    }));
    expect(screen.getByRole("button", { name: "展开搜索详情" })).toHaveAttribute("aria-expanded", "false");
    expect(view.container).toHaveTextContent("找到 5 条结果，读取 2 个来源");
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
          { title: "来源一重复", url: "https://example.com/one", verified: true },
          { title: "来源三", url: "https://example.com/three", verified: true }
        ],
        createdAt: "2026-07-28T00:00:01.000Z"
      }
    ];

    expect(summarizeSearchActivity(items)).toBe("找到 10 条结果，读取 2 个来源");
    const { container } = render(createElement(SearchActivitySummary, { items }));

    const line = container.querySelector("[data-search-activity-summary]");
    expect(line).toHaveTextContent("找到 10 条结果，读取 2 个来源");
    expect(line).toHaveAttribute("data-tool-call-count", "2");
    expect(line).toHaveAttribute("data-tool-call-ids", "search-1,search-2");
    const toggle = container.querySelector('button[aria-label="展开搜索详情"]');
    expect(toggle).not.toBeNull();
    fireEvent.click(toggle!);
    const detailPanel = container.querySelector("[data-search-activity-details]");
    expect(detailPanel).toHaveTextContent("来源二");
    expect(detailPanel).toHaveTextContent("X · @OpenAI：这条帖子介绍了状态图的公开实践。");
    expect(detailPanel).toHaveTextContent("来源二");
    expect(detailPanel).toHaveTextContent("来源三");
    expect(detailPanel).not.toHaveTextContent(/搜索服务|执行耗时|检索查询|检索计划|核验结论/u);
    expect(within(detailPanel as HTMLElement).queryByText("状态")).not.toBeInTheDocument();
    expect(detailPanel?.querySelectorAll("p")).toHaveLength(3);
    expect(detailPanel?.querySelectorAll("a")).toHaveLength(3);
    expect(container.querySelector("table")).toBeNull();
  });

  it("同一摘要行随真实完成事件逐次累加计数", () => {
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
    expect(view.container).toHaveTextContent("找到 5 条结果，读取 1 个来源");
    view.rerender(createElement(SearchActivitySummary, { items: [first, second] }));
    expect(view.container).toHaveTextContent("找到 10 条结果，读取 3 个来源");
    view.rerender(createElement(SearchActivitySummary, { items: [first, second, third] }));
    expect(view.container).toHaveTextContent("找到 15 条结果，读取 4 个来源");
  });
});

describe("ActivityRow activity disclosure", () => {
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
});
