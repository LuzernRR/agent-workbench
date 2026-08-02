import { describe, expect, it } from "vitest";
import { buildScript } from "./scripts";

describe("mock 脚本过程文案", () => {
  it("每个工具步骤都自带非空名称与过程文案，前端无需自撰兜底", () => {
    // 覆盖 buildScript 的两条分支：普通任务与需要审批的任务。
    expect(buildScript("请运行代码并提交").filter((step) => step.kind === "tool")).toHaveLength(2);
    for (const message of ["整理这份资料", "请运行代码并提交"]) {
      const tools = buildScript(message).filter((step) => step.kind === "tool");
      expect(tools.length).toBeGreaterThan(0);
      for (const tool of tools) {
        expect(tool.name.trim()).not.toBe("");
        expect(tool.summary.trim()).not.toBe("");
      }
    }
  });
});
