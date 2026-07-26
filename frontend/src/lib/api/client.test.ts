import { describe, expect, it, vi } from "vitest";
import { normalizeDisplayText, normalizeProjectName, safeLinkLabel, safeWorkbenchHref } from "./client";

describe("normalizeDisplayText", () => {
  it("replaces irrecoverable question-mark titles", () => {
    expect(normalizeDisplayText(Array.from({ length: 4 }, () => "?").join(""), "新对话")).toBe("新对话");
  });

  it("recovers UTF-8 text decoded as Latin-1", () => {
    const mojibake = [...new TextEncoder().encode("项目规划")].map((byte) => String.fromCharCode(byte)).join("");
    expect(normalizeDisplayText(mojibake, "未命名项目")).toBe("项目规划");
  });

  it("保留项目名称，不改写用户内容", () => {
    expect(normalizeProjectName("统一工作台")).toBe("统一工作台");
  });
});

describe("safe workbench links", () => {
  it("allows http(s) and same-origin paths but rejects executable protocols", () => {
    expect(safeWorkbenchHref("https://example.com/report")).toBe("https://example.com/report");
    expect(safeWorkbenchHref("/api/v1/artifacts/one")).toBe("/api/v1/artifacts/one");
    expect(safeWorkbenchHref("javascript:alert(1)")).toBe("");
    expect(safeWorkbenchHref("data:text/html,test")).toBe("");
  });

  it("never displays a raw URL as the link title", () => {
    expect(safeLinkLabel("https://example.com/report", "来源 1")).toBe("来源 1");
    expect(safeLinkLabel("官方报告", "来源 1")).toBe("官方报告");
  });
});

describe("UTF-8 API contract", () => {
  it("declares UTF-8 for JSON request bodies", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, data: { status: "ok" } }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { workbenchApi } = await import("./client");
    await workbenchApi.stopRun("run-utf8");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/runs/run-utf8/stop"),
      expect.objectContaining({ method: "POST" }),
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(headers.get("accept")).toBe("application/json; charset=utf-8");
    vi.unstubAllGlobals();
  });

  it("rejects malformed UTF-8 instead of introducing replacement characters", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(Uint8Array.from([0xc3, 0x28]), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" }
    })));
    const { workbenchApi } = await import("./client");
    await expect(workbenchApi.projects()).rejects.toThrow("响应不是有效的 UTF-8");
    vi.unstubAllGlobals();
  });
});
