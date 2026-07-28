import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  projectS01ProcessFixture
} from "@/server/mock/s01-event-fixtures";
import {
  projectV2ProcessView,
  type V2ToolActivityView
} from "@/lib/agent-events/v2/process-view-model";
import { V2ToolActivityList } from "./V2ToolActivityRow";

afterEach(cleanup);

function scenarioTools(
  scenario: Parameters<typeof projectS01ProcessFixture>[0]
) {
  return projectV2ProcessView(projectS01ProcessFixture(scenario)).tools;
}

function renderScenario(
  scenario: Parameters<typeof projectS01ProcessFixture>[0]
) {
  return render(<V2ToolActivityList tools={scenarioTools(scenario)} />);
}

function toolRow(toolCallId: string) {
  const row = document.querySelector(`[data-tool-call-id="${toolCallId}"]`);
  if (!(row instanceof HTMLElement)) throw new Error(`Missing tool row ${toolCallId}`);
  return row;
}

function openTool(toolCallId: string) {
  const row = toolRow(toolCallId);
  fireEvent.click(within(row).getByRole("button", { name: /展开工具活动/u }));
  return row;
}

describe("V2ToolActivityList", () => {
  it("shows one safe row for a completed tool and its typed result details", () => {
    renderScenario("tool_success");
    const row = toolRow("call_tool_1");

    expect(within(row).getByText("网页搜索")).toBeInTheDocument();
    expect(within(row).getByText("已完成")).toBeInTheDocument();
    expect(within(row).getByText("1 项")).toBeInTheDocument();

    openTool("call_tool_1");
    expect(within(row).getByText("返回 1 个公开来源")).toBeInTheDocument();
    expect(within(row).getByText("链接")).toBeInTheDocument();
    expect(within(row).getByText("USD 0.002")).toBeInTheDocument();
  });

  it("keeps progress and retrying as typed lifecycle states", () => {
    const progress = renderScenario("tool_progress");
    expect(screen.getByText("执行中")).toBeInTheDocument();
    expect(screen.getByText("2 项")).toBeInTheDocument();
    progress.unmount();

    renderScenario("tool_retrying");
    const row = openTool("call_tool_1");
    expect(within(row).getAllByText("正在重试").length).toBeGreaterThan(0);
    expect(within(row).getByText("请求频率受限，等待后重试")).toBeInTheDocument();
    expect(within(row).getByText("RATE_LIMITED")).toBeInTheDocument();
    expect(within(row).getByText("2")).toBeInTheDocument();
  });

  it("associates approval state with the existing tool row", () => {
    const waiting = renderScenario("tool_waiting_approval");
    expect(document.querySelectorAll("[data-tool-call-id='call_tool_1']")).toHaveLength(1);
    const waitingRow = openTool("call_tool_1");
    expect(within(waitingRow).getAllByText("等待审批").length).toBeGreaterThan(0);
    expect(within(waitingRow).getByText("查询公开网页")).toBeInTheDocument();
    expect(within(waitingRow).getByText("访问公开网络")).toBeInTheDocument();
    waiting.unmount();

    renderScenario("tool_approval_decided");
    expect(document.querySelectorAll("[data-tool-call-id='call_tool_1']")).toHaveLength(1);
    expect(screen.getByText("审批已通过")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /允许|拒绝|修改/u })).not.toBeInTheDocument();
  });

  it("preserves started order while parallel tools finish out of order", () => {
    renderScenario("tool_parallel");
    const rows = [...document.querySelectorAll("[data-tool-call-id]")]
      .map((row) => row.getAttribute("data-tool-call-id"));

    expect(rows).toEqual(["call_parallel_a", "call_parallel_b"]);
    expect(screen.getByText("官方文档搜索")).toBeInTheDocument();
    expect(screen.getByText("页面读取")).toBeInTheDocument();
  });

  it("renders an empty successful result as zero instead of missing data", () => {
    renderScenario("tool_empty");
    const row = openTool("call_tool_1");

    expect(within(row).getByText("0 项")).toBeInTheDocument();
    expect(within(row).getByText("0")).toBeInTheDocument();
    expect(within(row).getByText("无结果")).toBeInTheDocument();
    expect(within(row).getByText("未返回匹配结果")).toBeInTheDocument();
  });

  it("shows only normalized failure fields and does not invent a next action", () => {
    renderScenario("tool_failed");
    const row = openTool("call_failed_1");

    expect(within(row).getAllByText("失败").length).toBeGreaterThan(0);
    expect(within(row).getByText("页面读取超时")).toBeInTheDocument();
    expect(within(row).getByText("FETCH_TIMEOUT")).toBeInTheDocument();
    expect(within(row).getByText("是")).toBeInTheDocument();
    expect(within(row).queryByText(/换源|重新执行|建议重试/u)).not.toBeInTheDocument();
  });

  it("keeps unknown distinct and exposes only operation lookup and duplicate-cost facts", () => {
    renderScenario("tool_unknown");
    const row = openTool("call_publish_unknown_1");

    expect(within(row).getAllByText("结果未确认").length).toBeGreaterThan(0);
    expect(within(row).getByText("结果尚未确认")).toBeInTheDocument();
    expect(within(row).getByText("operation_publish_unknown_1")).toBeInTheDocument();
    expect(within(row).getByText("查询操作状态")).toBeInTheDocument();
    expect(within(row).getByText("可能重复费用").parentElement).toHaveTextContent("USD 0.01");
    expect(within(row).queryByRole("button", { name: /重试/u })).not.toBeInTheDocument();
  });

  it("does not enumerate private or untyped fields from a tool state", () => {
    const base = scenarioTools("tool_success")[0];
    const withPrivateFields = {
      ...base,
      arguments: { apiKey: "secret-api-key" },
      providerBody: "raw-provider-body",
      reasoning_content: "private-chain",
      outputHash: "internal-output-hash"
    } as V2ToolActivityView;
    const view = render(<V2ToolActivityList tools={[withPrivateFields]} />);

    fireEvent.click(screen.getByRole("button", { name: /展开工具活动/u }));
    expect(view.container).not.toHaveTextContent(
      /secret-api-key|raw-provider-body|private-chain|internal-output-hash/u
    );
  });

  it("keeps long safe summaries wrappable at narrow widths", () => {
    renderScenario("tool_long");
    const row = openTool("call_tool_1");
    const title = within(row).getByText(/跨平台公开资料与官方文档联合检索工具/u);

    expect(title).toHaveClass("whitespace-normal", "break-words");
    expect(within(row).getByText(/仅保留允许公开的参数摘要/u)).toHaveClass(
      "whitespace-normal",
      "break-words"
    );
    expect(within(row).getByText(/Tool Gateway 白名单投影/u)).toHaveClass(
      "whitespace-normal",
      "break-words"
    );
  });

  it("renders no tool list for direct runs", () => {
    const view = render(<V2ToolActivityList tools={scenarioTools("direct")} />);
    expect(view.container).toBeEmptyDOMElement();
  });
});
