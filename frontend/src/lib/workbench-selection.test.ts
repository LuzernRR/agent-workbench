import { describe, expect, it } from "vitest";
import { workbenchSelectionPath } from "./workbench-selection";

describe("工作台选择路由", () => {
  it("为草稿、项目和会话生成唯一可恢复地址", () => {
    expect(workbenchSelectionPath(null, null)).toBe("/workbench");
    expect(workbenchSelectionPath("proj 中文", null)).toBe("/workbench/p/proj%20%E4%B8%AD%E6%96%87");
    expect(workbenchSelectionPath(undefined, "thread/one")).toBe("/workbench/t/thread%2Fone");
  });

  it("会话地址不携带项目标识，项目归属由会话快照决定", () => {
    expect(workbenchSelectionPath("project-a", "thread-a")).toBe("/workbench/t/thread-a");
    expect(workbenchSelectionPath(null, "thread-a")).toBe("/workbench/t/thread-a");
  });
});
