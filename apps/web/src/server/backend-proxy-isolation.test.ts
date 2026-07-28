import { afterEach, describe, expect, it, vi } from "vitest";

const originalOrigin = process.env.WORKBENCH_API_ORIGIN;
const originalMode = process.env.WORKBENCH_LLM_MODE;

describe("3110 deterministic mock 隔离", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("@/server/mock/handler");
    vi.doUnmock("@/server/live/handler");
    restore("WORKBENCH_API_ORIGIN", originalOrigin);
    restore("WORKBENCH_LLM_MODE", originalMode);
  });

  it("mock 模式只进入 fixture handler，绝不启动 live Search Agent", async () => {
    delete process.env.WORKBENCH_API_ORIGIN;
    process.env.WORKBENCH_LLM_MODE = "mock";
    const handleMock = vi.fn(async () => Response.json({ mode: "mock" }));
    const handleLive = vi.fn(async () => Response.json({ mode: "live" }));
    vi.doMock("@/server/mock/handler", () => ({ handleMock }));
    vi.doMock("@/server/live/handler", () => ({ handleLive }));
    const { proxyJson } = await import("./backend-proxy");

    const response = await proxyJson(new Request("http://localhost:3110/api/v1/agents"), "/api/v1/agents");

    await expect(response.json()).resolves.toEqual({ mode: "mock" });
    expect(handleMock).toHaveBeenCalledTimes(1);
    expect(handleLive).not.toHaveBeenCalled();
  });
});

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
