import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PlanView } from "./AgentWorkspace";

describe("PlanView", () => {
  it("展示持久化的结构计划字段与真实步骤状态", () => {
    render(<PlanView steps={[
      {
        id: "step-official",
        planId: "plan-one",
        revision: 2,
        title: "读取官方定义与发布日期",
        facet: "官方定义",
        objective: "读取官方定义与发布日期",
        query: "Agent Workbench 官方定义 2026",
        channel: "web",
        dependsOn: [],
        priority: 100,
        evidenceNeeded: 1,
        canParallelize: true,
        status: "in_progress"
      },
      {
        id: "step-compare",
        planId: "plan-one",
        revision: 2,
        title: "核对架构差异",
        facet: "差异",
        objective: "核对架构差异",
        query: "Agent Workbench architecture comparison",
        channel: "x",
        dependsOn: ["step-official"],
        priority: 80,
        evidenceNeeded: 2,
        canParallelize: false,
        reasonCode: "PLAN_DEPENDENCY_BLOCKED",
        status: "blocked"
      }
    ]} />);

    expect(screen.getByLabelText("读取官方定义与发布日期，执行中")).toBeInTheDocument();
    expect(screen.getByText("查询：Agent Workbench 官方定义 2026")).toBeInTheDocument();
    expect(screen.getByText("渠道：网页")).toBeInTheDocument();
    expect(screen.getByText("证据目标：1")).toBeInTheDocument();
    expect(screen.getByText("可并行")).toBeInTheDocument();
    expect(screen.getByText("依赖：step-official")).toBeInTheDocument();
    expect(screen.getByText("状态码：PLAN_DEPENDENCY_BLOCKED")).toBeInTheDocument();
  });
});
