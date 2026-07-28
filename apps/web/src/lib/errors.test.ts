import { describe, expect, it } from "vitest";
import { getRunFailureMessage, getWorkbenchErrorMessage } from "./errors";

describe("getWorkbenchErrorMessage", () => {
  it.each(["Failed to fetch", "Load failed", "Network request failed", "NetworkError when attempting to fetch resource."])("将浏览器网络错误转换为中文：%s", (message) => {
    expect(getWorkbenchErrorMessage(new Error(message), "服务暂时不可用")).toBe("服务暂时不可用");
  });

  it("保留后端提供的业务错误", () => {
    expect(getWorkbenchErrorMessage(new Error("助手配置暂不可用"))).toBe("助手配置暂不可用");
  });

  it.each([
    ["Thread not found", "会话不存在"],
    ["Backend unavailable", "工作台服务暂不可用"],
    ["Internal Server Error", "工作台服务发生错误"],
    ["private implementation failure", "任务请求失败"]
  ])("不会把英文后端错误直接展示给用户：%s", (message, expected) => {
    expect(getWorkbenchErrorMessage(new Error(message), "任务请求失败")).toBe(expected);
  });

  it("为未知错误返回中文兜底", () => {
    expect(getWorkbenchErrorMessage(null, "附件上传失败")).toBe("附件上传失败");
  });

  it("即使异常中含中文也不泄露 RuntimeError 或内部错误码", () => {
    expect(getWorkbenchErrorMessage(new Error("RuntimeError: 模型执行失败 WORKBENCH_RUNTIME_UNAVAILABLE"), "任务请求失败"))
      .toBe("任务请求失败");
  });

  it("隐藏运行环境配置键并保留失败含义", () => {
    expect(getRunFailureMessage("工作台 LangGraph runtime 未配置。请注入 workbench.runtime-command。"))
      .toBe("工作台运行环境未配置");
  });

  it("将真实证据门禁失败转换为中文且不泄露内部码", () => {
    const visible = getRunFailureMessage(
      "citation failed the Java evidence gate: required_claim_facets_missing"
    );

    expect(visible).toBe("引用未覆盖任务要求的关键结论");
    expect(visible).not.toMatch(/Java|evidence|gate|required_claim/u);
  });

  it.each([
    ["citation failed the Java evidence gate: unexpected_reason", "引用未通过证据质量检查"],
    ["AGENT_RUNTIME_ERROR: Agent execution failed", "任务运行失败"],
    [
      "### Error updating database. Cause: java.sql.SQLIntegrityConstraintViolationException: Duplicate entry 'run-fetch_content-0' for key 'wb_tool_call.uq_wb_tool_call'",
      "任务状态发生冲突，请重新发起任务"
    ],
    ["IllegalArgumentException: private implementation detail", "任务执行失败，请稍后重试"]
  ])("隐藏未知实现细节：%s", (message, expected) => {
    expect(getRunFailureMessage(message)).toBe(expected);
  });
});
