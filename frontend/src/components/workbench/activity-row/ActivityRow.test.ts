import { fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { ActivityRow, isPlaceholderTool } from "./ActivityRow";

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
});
