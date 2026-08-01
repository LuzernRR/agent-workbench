import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { XiaohongshuVerificationView } from "./XiaohongshuVerificationView";

const challengeId = "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789";

describe("XiaohongshuVerificationView", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("直接展示当前工具会话二维码并轮询状态", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      version: 1,
      runId: "run_one",
      challengeId,
      status: "pending",
      expiresAt: new Date(Date.now() + 240_000).toISOString(),
      retryAfterMs: 10_000,
      reasonCode: null,
      message: "等待使用小红书 App 扫码验证工具账号"
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const view = render(<XiaohongshuVerificationView runId="run_one" challengeId={challengeId} />);

    expect(await screen.findByText("等待使用小红书 App 扫码验证工具账号")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "小红书工具账号安全验证二维码" }).getAttribute("src")).toContain(
      `/api/v1/runs/run_one/xiaohongshu-verifications/${challengeId}/qrcode`
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/runs/run_one/xiaohongshu-verifications/${challengeId}`,
      expect.objectContaining({ cache: "no-store" })
    ));
    view.unmount();
  });

  it("验证成功后明确告知原运行已自动继续", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      version: 1,
      runId: "run_one",
      challengeId,
      status: "succeeded",
      expiresAt: new Date(Date.now() + 240_000).toISOString(),
      retryAfterMs: 2000,
      reasonCode: null,
      message: "小红书工具账号验证成功"
    }), { status: 200, headers: { "content-type": "application/json" } }));

    render(<XiaohongshuVerificationView runId="run_one" challengeId={challengeId} />);

    expect(await screen.findByText("验证成功")).toBeInTheDocument();
    expect(screen.getByText("当前搜索正在后台继续，可关闭此页面。")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});
