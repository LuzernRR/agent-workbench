import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyThreadState } from "@/lib/agent-events/reducer";
import type { ThinkingItem } from "@/lib/agent-events/types";
import type { S01ProcessFixtureCatalog } from "@/lib/agent-events/v2/process-view-model";
import { createS01ProcessFixtureCatalog } from "@/server/mock/s01-event-fixtures";
import { Conversation, ConversationSkeleton, formatAssistantReply, ThinkingResult } from "./Conversation";

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

function renderConversation(
  fixture: S01ProcessFixtureCatalog | null,
  onStartRun = vi.fn(async () => undefined),
  options: { state?: ReturnType<typeof createEmptyThreadState>; isStarting?: boolean; pendingStartedAt?: string | null } = {}
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });
  const state = options.state || createEmptyThreadState(null, "thread-product");

  const view = render(
    <QueryClientProvider client={queryClient}>
      <Conversation
        state={state}
        composerThreadId="thread-product"
        onStartRun={onStartRun}
        onStopRun={vi.fn(async () => undefined)}
        onResolveApproval={vi.fn(async () => undefined)}
        isResolvingApproval={false}
        isStarting={options.isStarting ?? false}
        pendingStartedAt={options.pendingStartedAt}
        s01ProcessFixture={fixture}
      />
    </QueryClientProvider>
  );
  return { ...view, onStartRun, queryClient };
}

describe("即时运行反馈", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("在模型首个事件到达前立即显示已处理计时", () => {
    const startedAt = "2026-08-07T00:00:00.000Z";
    const state = {
      ...createEmptyThreadState(null, "thread-product"),
      activeRunId: "run-live",
      runStatus: "running" as const,
      runStartedAt: startedAt,
      runTimings: { "run-live": { startedAt } }
    };

    renderConversation(null, undefined, { state });

    const elapsed = screen.getByTestId("run-elapsed");
    const responseRoot = document.querySelector('[data-assistant-response-run-id="run-live"]');
    expect(elapsed).toHaveTextContent("已处理 0 秒");
    expect(responseRoot).toContainElement(elapsed);
    expect(responseRoot).toHaveAttribute("data-assistant-response-placeholder", "true");
    expect(responseRoot?.firstElementChild).toBe(elapsed);
    expect(responseRoot).toHaveClass("group", "max-w-none");
  });

  it("把计时放在助手回答容器左上角、首个回答活动之前", () => {
    const startedAt = "2026-08-07T00:00:00.000Z";
    const userMessage = {
      kind: "message" as const,
      id: "user-live",
      runId: "run-live",
      role: "user" as const,
      text: "请检索并核验奖学金信息",
      status: "completed" as const,
      createdAt: startedAt
    };
    const thinking = {
      kind: "thinking" as const,
      id: "thinking-live",
      runId: "run-live",
      activityKind: "thinking" as const,
      paragraphs: [{ id: "paragraph-live", text: "正在拆解搜索约束。" }],
      status: "streaming" as const,
      createdAt: startedAt
    };
    const state = {
      ...createEmptyThreadState(null, "thread-product"),
      activeRunId: "run-live",
      runStatus: "running" as const,
      runStartedAt: startedAt,
      items: { [userMessage.id]: userMessage, [thinking.id]: thinking },
      itemOrder: [userMessage.id, thinking.id],
      runTimings: { "run-live": { startedAt } },
      runStatuses: { "run-live": "running" as const }
    };

    renderConversation(null, undefined, { state });

    const elapsed = screen.getByTestId("run-elapsed");
    const userRoot = document.querySelector('[data-message-id="user-live"]');
    const userText = screen.getByText(userMessage.text);
    const thinkingRoot = document.querySelector<HTMLElement>('[data-thinking-id="thinking-live"]');
    const responseRoot = document.querySelector('[data-assistant-response-run-id="run-live"]');
    expect(userRoot).not.toContainElement(elapsed);
    expect(responseRoot).toContainElement(elapsed);
    expect(responseRoot).toContainElement(thinkingRoot);
    expect(userText.compareDocumentPosition(elapsed) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(elapsed.compareDocumentPosition(thinkingRoot!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it("正式用户锚点与临时开始时间并存时只显示一个计时", () => {
    const startedAt = "2026-08-07T00:00:00.000Z";
    const userMessage = {
      kind: "message" as const,
      id: "user-handoff",
      runId: "run-handoff",
      role: "user" as const,
      text: "接管计时锚点",
      status: "completed" as const,
      createdAt: startedAt
    };
    const state = {
      ...createEmptyThreadState(null, "thread-product"),
      activeRunId: "run-handoff",
      runStatus: "running" as const,
      runStartedAt: startedAt,
      items: { [userMessage.id]: userMessage },
      itemOrder: [userMessage.id],
      runTimings: { "run-handoff": { startedAt } },
      runStatuses: { "run-handoff": "running" as const }
    };
    renderConversation(null, undefined, {
      state,
      pendingStartedAt: startedAt
    });

    const elapsed = screen.getAllByTestId("run-elapsed");
    const userRoot = document.querySelector('[data-message-id="user-handoff"]');
    const responseRoot = document.querySelector('[data-assistant-response-run-id="run-handoff"]');
    expect(elapsed).toHaveLength(1);
    expect(userRoot).not.toContainElement(elapsed[0]);
    expect(responseRoot).toContainElement(elapsed[0]);
    expect(userRoot!.compareDocumentPosition(responseRoot!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it("会话身份切换骨架把同一运行计时放在回答占位左上角", () => {
    render(<ConversationSkeleton pendingStartedAt="2026-08-07T00:00:00.000Z" />);

    const elapsed = screen.getByTestId("run-elapsed");
    const userPlaceholder = document.querySelector("[data-skeleton-user-message]");
    const responseRoot = document.querySelector('[data-assistant-response-run-id="pending"]');
    expect(elapsed).toHaveTextContent("已处理 0 秒");
    expect(userPlaceholder).not.toBeNull();
    expect(responseRoot).toContainElement(elapsed);
    expect(responseRoot).toHaveAttribute("data-assistant-response-placeholder", "true");
    expect(responseRoot?.firstElementChild).toBe(elapsed);
    expect(userPlaceholder!.compareDocumentPosition(elapsed) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(screen.getByRole("status", { name: "正在加载会话" })).toBeInTheDocument();
  });

  it("等待期间递增，并在运行结束后冻结最终耗时", () => {
    const startedAt = "2026-08-07T00:00:00.000Z";
    const userMessage = {
      kind: "message" as const,
      id: "user-live",
      runId: "run-live",
      role: "user" as const,
      text: "整理计划",
      status: "completed" as const,
      createdAt: startedAt
    };
    const running = {
      ...createEmptyThreadState(null, "thread-product"),
      activeRunId: "run-live",
      runStatus: "running" as const,
      runStartedAt: startedAt,
      items: { [userMessage.id]: userMessage },
      itemOrder: [userMessage.id],
      runTimings: { "run-live": { startedAt } },
      runStatuses: { "run-live": "running" as const }
    };
    const view = renderConversation(null, undefined, { state: running });

    act(() => {
      vi.advanceTimersByTime(2_100);
    });
    expect(screen.getByTestId("run-elapsed")).toHaveTextContent("已处理 2 秒");

    const completedAt = "2026-08-07T00:00:03.000Z";
    view.rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <Conversation
          state={{
            ...running,
            activeRunId: null,
            runStatus: "completed",
            runTimings: { "run-live": { startedAt, completedAt } },
            runStatuses: { "run-live": "completed" }
          }}
          composerThreadId="thread-product"
          onStartRun={vi.fn(async () => undefined)}
          onStopRun={vi.fn(async () => undefined)}
          onResolveApproval={vi.fn(async () => undefined)}
          isResolvingApproval={false}
          isStarting={false}
        />
      </QueryClientProvider>
    );
    expect(screen.queryByTestId("run-elapsed")).not.toBeInTheDocument();
    expect(screen.getByTestId("run-elapsed-history")).toHaveTextContent("已处理 3 秒");
    expect(document.querySelector('[data-message-id="user-live"]')).not.toContainElement(screen.getByTestId("run-elapsed-history"));
    expect(document.querySelector('[data-assistant-response-run-id="run-live"]')).toContainElement(screen.getByTestId("run-elapsed-history"));
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByTestId("run-elapsed-history")).toHaveTextContent("已处理 3 秒");
  });

  it.each(["failed", "stopped"] as const)("%s 终态冻结并保留该轮耗时", (terminalStatus) => {
    const startedAt = "2026-08-07T00:00:00.000Z";
    const completedAt = "2026-08-07T00:00:04.000Z";
    const userMessage = {
      kind: "message" as const,
      id: `user-${terminalStatus}`,
      runId: `run-${terminalStatus}`,
      role: "user" as const,
      text: `${terminalStatus} 请求`,
      status: "completed" as const,
      createdAt: startedAt
    };
    const state = {
      ...createEmptyThreadState(null, "thread-product"),
      runStatus: terminalStatus,
      items: { [userMessage.id]: userMessage },
      itemOrder: [userMessage.id],
      runTimings: { [userMessage.runId]: { startedAt, completedAt } },
      runStatuses: { [userMessage.runId]: terminalStatus }
    };

    renderConversation(null, undefined, { state });

    const elapsed = screen.getByTestId("run-elapsed-history");
    expect(elapsed).toHaveTextContent("已处理 4 秒");
    expect(document.querySelector(`[data-message-id="${userMessage.id}"]`)).not.toContainElement(elapsed);
    const responseRoot = document.querySelector(`[data-assistant-response-run-id="${userMessage.runId}"]`);
    expect(responseRoot).toContainElement(elapsed);
    expect(responseRoot).toHaveAttribute("data-assistant-response-placeholder", "true");
    expect(responseRoot?.firstElementChild).toBe(elapsed);
  });

  it("多轮会话把每个冻结计时绑定到各自助手回答", () => {
    const firstUser = {
      kind: "message" as const,
      id: "user-first",
      runId: "run-first",
      role: "user" as const,
      text: "第一轮",
      status: "completed" as const,
      createdAt: "2026-08-07T00:00:00.000Z"
    };
    const secondUser = {
      ...firstUser,
      id: "user-second",
      runId: "run-second",
      text: "第二轮",
      createdAt: "2026-08-07T00:01:00.000Z"
    };
    const state = {
      ...createEmptyThreadState(null, "thread-product"),
      runStatus: "completed" as const,
      items: { [firstUser.id]: firstUser, [secondUser.id]: secondUser },
      itemOrder: [firstUser.id, secondUser.id],
      runTimings: {
        [firstUser.runId]: { startedAt: firstUser.createdAt, completedAt: "2026-08-07T00:00:02.000Z" },
        [secondUser.runId]: { startedAt: secondUser.createdAt, completedAt: "2026-08-07T00:01:05.000Z" }
      },
      runStatuses: { [firstUser.runId]: "completed" as const, [secondUser.runId]: "completed" as const }
    };

    renderConversation(null, undefined, { state });

    const elapsed = screen.getAllByTestId("run-elapsed-history");
    expect(elapsed).toHaveLength(2);
    expect(document.querySelector('[data-message-id="user-first"]')).not.toContainElement(elapsed[0]);
    expect(document.querySelector('[data-assistant-response-run-id="run-first"]')).toContainElement(elapsed[0]);
    expect(elapsed[0]).toHaveTextContent("已处理 2 秒");
    expect(document.querySelector('[data-message-id="user-second"]')).not.toContainElement(elapsed[1]);
    expect(document.querySelector('[data-assistant-response-run-id="run-second"]')).toContainElement(elapsed[1]);
    expect(elapsed[1]).toHaveTextContent("已处理 5 秒");
  });
});

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  HTMLElement.prototype.scrollTo = vi.fn();
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
    expect(screen.getByRole("button", { name: "填入案例：学生 · 英国硕士奖学金" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "填入案例：女性通勤 · 油敏皮夏季防晒" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "填入案例：求职学生 · AI 产品岗位动态" })).toBeInTheDocument();
    expect(screen.queryByText("测试数据")).not.toBeInTheDocument();
  });

  it("fills and focuses the selected example without automatically starting a run", async () => {
    const { onStartRun } = renderConversation(null);
    const input = screen.getByRole("textbox", { name: "任务输入" });

    fireEvent.click(screen.getByRole("button", { name: "填入案例：女性通勤 · 油敏皮夏季防晒" }));

    await screen.findByDisplayValue(/请搜索小红书上关于“油敏皮夏季通勤防晒”的近期使用笔记/);
    expect(input).toHaveFocus();
    expect(onStartRun).not.toHaveBeenCalled();
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

    expect(view.container.querySelector("[data-thinking-id]")).toHaveClass("workbench-disclosure-row");
    expect(view.container.querySelector("[data-thinking-id]")).not.toHaveClass("mb-2");
    expect(screen.getByRole("button", { name: "思考中" })).toHaveClass("workbench-disclosure-trigger");
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

describe("assistant reply citations", () => {
  it("labels citations as source links and includes safe URLs in the copied reply", () => {
    const copied = formatAssistantReply([{
      text: "三条经验均来自已读正文。",
      citations: [
        { label: "油敏皮防晒决赛圈", url: "https://www.xiaohongshu.com/explore/note_one" },
        { label: "危险来源", url: "javascript:alert(1)" }
      ]
    }]);

    expect(copied).toContain("来源链接");
    expect(copied).toContain("[1] 油敏皮防晒决赛圈：https://www.xiaohongshu.com/explore/note_one");
    expect(copied).not.toContain("javascript:");
  });
});
