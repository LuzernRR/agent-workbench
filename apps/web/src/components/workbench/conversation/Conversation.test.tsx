import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyThreadState } from "@/lib/agent-events/reducer";
import type { S01ProcessFixtureCatalog } from "@/lib/agent-events/v2/process-view-model";
import { createS01ProcessFixtureCatalog } from "@/server/mock/s01-event-fixtures";
import { Conversation } from "./Conversation";

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
