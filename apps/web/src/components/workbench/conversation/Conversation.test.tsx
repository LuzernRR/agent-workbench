import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyThreadState } from "@/lib/agent-events/reducer";
import type { ThinkingItem } from "@/lib/agent-events/types";
import type { S01ProcessFixtureCatalog } from "@/lib/agent-events/v2/process-view-model";
import { createS01ProcessFixtureCatalog } from "@/server/mock/s01-event-fixtures";
import { Conversation, ThinkingResult } from "./Conversation";

vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>();
  return {
    ...actual,
    workbenchApi: {
      ...actual.workbenchApi,
      agents: vi.fn(async () => [{
        id: "assistant",
        name: "对话",
        description: "测试",
        toolIds: []
      }]),
      models: vi.fn(async () => [{
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        description: "测试",
        reasoningEfforts: ["medium"],
        defaultReasoningEffort: "medium"
      }]),
      uploadAttachments: vi.fn(async () => [])
    }
  };
});

function renderConversation(fixture: S01ProcessFixtureCatalog | null) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });
  const state = createEmptyThreadState(null, "thread-product");

  return render(
    <QueryClientProvider client={queryClient}>
      <Conversation
        state={state}
        composerThreadId="thread-product"
        onStartRun={vi.fn(async () => undefined)}
        onStopRun={vi.fn(async () => undefined)}
        onResolveApproval={vi.fn(async () => undefined)}
        isResolvingApproval={false}
        isStarting={false}
        s01ProcessFixture={fixture}
      />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Conversation S01 preview placement", () => {
  it("renders an explicit fixture above the composer when the thread has no user anchor", () => {
    renderConversation(createS01ProcessFixtureCatalog("composer_active"));

    const processPanel = screen.getByTestId("v2-process-panel");
    expect(processPanel).toHaveAttribute("data-run-id", "run_s01_composer_active");
    expect(processPanel).toHaveAttribute("data-source", "fixture");
    expect(processPanel.closest('[data-preview-placement="above-composer"]')).not.toBeNull();
    expect(screen.getByText("测试数据")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "任务输入" })).toBeInTheDocument();
  });

  it("keeps the production empty-thread branch unchanged when no fixture is provided", () => {
    renderConversation(null);

    expect(screen.queryByTestId("v2-process-panel")).not.toBeInTheDocument();
    expect(document.querySelector('[data-preview-placement="above-composer"]')).toBeNull();
    expect(screen.getByRole("heading", { name: "今天想做什么？" })).toBeInTheDocument();
    expect(screen.queryByText("测试数据")).not.toBeInTheDocument();
  });
});

describe("ThinkingResult progressive disclosure", () => {
  const thinking: ThinkingItem = {
    kind: "thinking",
    id: "thinking-one",
    runId: "run-one",
    activityKind: "thinking",
    paragraphs: [{ id: "paragraph-one", text: "先判断需要检索的事实边界。" }],
    status: "streaming",
    createdAt: "2026-07-28T00:00:00.000Z"
  };

  it("思考中自动展开并流式显示，结束后自动折叠且可再次展开", () => {
    const view = render(<ThinkingResult item={thinking} />);

    expect(screen.getByRole("button", { name: "思考中" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("先判断需要检索的事实边界。")).toBeInTheDocument();
    expect(screen.getByText("先判断需要检索的事实边界。")).toHaveClass("streaming-cursor");

    view.rerender(<ThinkingResult item={{ ...thinking, status: "completed" }} />);
    const completed = screen.getByRole("button", { name: "思考结束" });
    expect(completed).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("先判断需要检索的事实边界。")).not.toBeInTheDocument();

    fireEvent.click(completed);
    expect(screen.getByText("先判断需要检索的事实边界。")).toBeInTheDocument();
    expect(screen.getByText("先判断需要检索的事实边界。")).not.toHaveClass("streaming-cursor");
  });

  it("当前思考完成后保持展开，直到下一个步骤出现才折叠", () => {
    const view = render(<ThinkingResult item={thinking} isCurrentStep />);

    view.rerender(<ThinkingResult item={{ ...thinking, status: "completed" }} isCurrentStep />);
    expect(screen.getByRole("button", { name: "思考结束" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("先判断需要检索的事实边界。")).toBeInTheDocument();

    view.rerender(<ThinkingResult item={{ ...thinking, status: "completed" }} isCurrentStep={false} />);
    expect(screen.getByRole("button", { name: "思考结束" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("先判断需要检索的事实边界。")).not.toBeInTheDocument();
  });

  it("核验使用独立标题并遵循同样的展开折叠规则", () => {
    const verification = { ...thinking, id: "verification-one", activityKind: "verification" as const };
    const view = render(<ThinkingResult item={verification} />);

    expect(view.container.querySelector('[data-activity-kind="verification"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: "核验中" })).toHaveAttribute("aria-expanded", "true");
    view.rerender(<ThinkingResult item={{ ...verification, status: "completed" }} />);
    expect(screen.getByRole("button", { name: "核验结束" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("先判断需要检索的事实边界。")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "核验结束" }));
    expect(screen.getByText("先判断需要检索的事实边界。")).toBeInTheDocument();
  });
});
