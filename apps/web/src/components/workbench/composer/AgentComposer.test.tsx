import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
  type ChatModelAdapter
} from "@assistant-ui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { V2ClientCommandState } from "@/lib/agent-events/v2/interaction-controller";
import type { V2PreviewInteractionRuntime } from "@/lib/agent-events/v2/use-v2-preview-interaction";
import { projectS01ProcessFixture } from "@/server/mock/s01-event-fixtures";
import { useWorkbenchUiStore } from "@/stores/workbench-ui-store";
import { AgentComposer } from "./AgentComposer";

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

const modelRun = vi.fn(async function* () {
    yield { content: [{ type: "text" as const, text: "unused" }] };
  });

const modelAdapter: ChatModelAdapter = {
  run: modelRun
};

function result(
  status: V2ClientCommandState["status"],
  errorCode: string | null = null
): V2ClientCommandState {
  return {
    commandId: "command_1",
    kind: "enqueue",
    idempotencyKey: "idem_1",
    contentHash: "a".repeat(64),
    status,
    snapshot: { content: "消息", attachmentRefs: [] },
    errorCode,
    retryable: false
  };
}

function preview(
  patch: Partial<V2PreviewInteractionRuntime> = {}
): V2PreviewInteractionRuntime {
  return {
    activeRun: true,
    runState: projectS01ProcessFixture("composer_active"),
    controllerState: { order: [], commands: {} },
    feedback: null,
    submitComposer: vi.fn(async () => result("accepted_pending")),
    resumeClarification: vi.fn(async () => result("applied")),
    decideApproval: vi.fn(async () => result("applied")),
    ingestEvidence: vi.fn(() => true),
    retry: vi.fn(async () => result("accepted_pending")),
    stop: vi.fn(async () => true),
    ...patch
  };
}

function Harness({
  interaction,
  prefillRequest = null
}: {
  interaction: V2PreviewInteractionRuntime | null;
  prefillRequest?: { readonly id: string; readonly text: string } | null;
}) {
  const runtime = useLocalRuntime(modelAdapter);
  const [client] = useState(() => new QueryClient({
    defaultOptions: { queries: { retry: false } }
  }));
  return (
    <QueryClientProvider client={client}>
      <AssistantRuntimeProvider runtime={runtime}>
        <AgentComposer
          threadId="thread-product"
          previewInteraction={interaction}
          prefillRequest={prefillRequest}
        />
      </AssistantRuntimeProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  modelRun.mockClear();
  useWorkbenchUiStore.setState({
    agentId: "assistant",
    modelId: "deepseek-v4-flash",
    reasoningEffort: "medium",
    pendingAttachments: [],
    pendingDraftAttachments: []
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AgentComposer v2 preview routing", () => {
  it("writes an externally selected example into the composer and does not send it", async () => {
    render(<Harness interaction={null} prefillRequest={{
      id: "example-web-1",
      text: "请搜索 LangGraph 的官方发布说明。"
    }} />);

    const input = screen.getByRole("textbox", { name: "任务输入" });
    await waitFor(() => expect(input).toHaveValue("请搜索 LangGraph 的官方发布说明。"));
    expect(input).toHaveFocus();
    expect(modelRun).not.toHaveBeenCalled();
  });

  it("routes Enter to enqueue and Ctrl/Cmd+Enter to steer", async () => {
    const interaction = preview();
    render(<Harness interaction={interaction} />);
    const input = screen.getByRole("textbox", { name: "任务输入" });

    fireEvent.change(input, { target: { value: "下一条消息" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(interaction.submitComposer).toHaveBeenCalledWith(
      "enqueue",
      "下一条消息",
      []
    ));

    fireEvent.change(input, { target: { value: "调整方向" } });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(interaction.submitComposer).toHaveBeenCalledWith(
      "steer",
      "调整方向",
      []
    ));

    fireEvent.change(input, { target: { value: "再次调整" } });
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    await waitFor(() => expect(interaction.submitComposer).toHaveBeenCalledWith(
      "steer",
      "再次调整",
      []
    ));
  });

  it("preserves newline, IME input and repeated keydown without submitting", () => {
    const interaction = preview();
    render(<Harness interaction={interaction} />);
    const input = screen.getByRole("textbox", { name: "任务输入" });
    fireEvent.change(input, { target: { value: "仍在输入" } });

    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(input, { key: "Enter", repeat: true });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });

    expect(interaction.submitComposer).not.toHaveBeenCalled();
    expect(input).toHaveValue("仍在输入");
  });

  it("prevents a keydown and click from double-submitting the same draft", async () => {
    let resolveSubmission!: (value: V2ClientCommandState) => void;
    const pending = new Promise<V2ClientCommandState>((resolve) => {
      resolveSubmission = resolve;
    });
    const interaction = preview({
      submitComposer: vi.fn(() => pending)
    });
    render(<Harness interaction={interaction} />);
    const input = screen.getByRole("textbox", { name: "任务输入" });
    fireEvent.change(input, { target: { value: "只提交一次" } });

    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "发送下一条消息" }));
    expect(interaction.submitComposer).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSubmission({
        ...result("accepted_pending"),
        snapshot: { content: "只提交一次", attachmentRefs: [] }
      });
      await pending;
    });
    expect(input).toHaveValue("");
  });

  it("uses the explicit compact mode selector and keeps stop separate", async () => {
    const interaction = preview();
    render(<Harness interaction={interaction} />);
    const input = screen.getByRole("textbox", { name: "任务输入" });
    const mode = screen.getByRole("combobox", { name: "运行中发送模式" });

    fireEvent.change(mode, { target: { value: "steer" } });
    fireEvent.change(input, { target: { value: "移动端引导" } });
    fireEvent.click(screen.getByRole("button", { name: "引导当前任务" }));
    await waitFor(() => expect(interaction.submitComposer).toHaveBeenCalledWith(
      "steer",
      "移动端引导",
      []
    ));

    fireEvent.click(screen.getByRole("button", { name: "停止执行" }));
    await waitFor(() => expect(interaction.stop).toHaveBeenCalledTimes(1));
  });

  it("retries the stored command identity and clears only its unchanged snapshot", async () => {
    const failed = {
      ...result("failed", "NETWORK_ERROR"),
      retryable: true,
      snapshot: { content: "原始引导", attachmentRefs: [] }
    };
    const retry = vi.fn(async () => ({
      ...failed,
      status: "accepted_pending" as const,
      errorCode: null,
      retryable: false
    }));
    const interaction = preview({
      feedback: "提交失败，内容已保留",
      controllerState: {
        order: [failed.commandId],
        commands: { [failed.commandId]: failed }
      },
      retry
    });
    render(<Harness interaction={interaction} />);
    const input = screen.getByRole("textbox", { name: "任务输入" });
    fireEvent.change(input, { target: { value: "原始引导" } });

    fireEvent.click(screen.getByRole("button", { name: "重试上次提交" }));
    await waitFor(() => expect(retry).toHaveBeenCalledWith(failed.commandId));
    expect(input).toHaveValue("");
  });

  it("retains the draft on revision conflict and hides preview controls in v1 mode", async () => {
    useWorkbenchUiStore.setState({
      pendingAttachments: [{
        id: "attachment_1",
        name: "范围说明.txt",
        mimeType: "text/plain",
        sizeBytes: 12,
        kind: "document",
        url: "/api/attachments/attachment_1"
      }]
    });
    const interaction = preview({
      feedback: "引导版本已变化，请保留内容并重新读取后再提交",
      submitComposer: vi.fn(async () => result(
        "rejected",
        "COMMAND_REVISION_CONFLICT"
      ))
    });
    const view = render(<Harness interaction={interaction} />);
    const input = screen.getByRole("textbox", { name: "任务输入" });
    fireEvent.change(input, { target: { value: "保留这段引导" } });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });

    await waitFor(() => expect(interaction.submitComposer).toHaveBeenCalled());
    expect(input).toHaveValue("保留这段引导");
    expect(useWorkbenchUiStore.getState().pendingAttachments).toHaveLength(1);
    expect(screen.getByText("范围说明.txt")).toBeInTheDocument();
    expect(screen.getByText("引导版本已变化，请保留内容并重新读取后再提交")).toHaveAttribute(
      "aria-live",
      "polite"
    );

    view.unmount();
    render(<Harness interaction={null} />);
    expect(screen.queryByRole("combobox", { name: "运行中发送模式" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送" })).toBeInTheDocument();
  });

  // 阻断项 1：提交挂起时停止仍可点击（停止不复用提交锁）。
  it("keeps stop clickable while a submit is still in flight", async () => {
    let resolveSubmission!: (value: V2ClientCommandState) => void;
    const pending = new Promise<V2ClientCommandState>((resolve) => {
      resolveSubmission = resolve;
    });
    const stop = vi.fn(async () => true);
    const interaction = preview({
      submitComposer: vi.fn(() => pending),
      stop
    });
    render(<Harness interaction={interaction} />);
    const input = screen.getByRole("textbox", { name: "任务输入" });
    fireEvent.change(input, { target: { value: "提交但先不结束" } });

    // 发起一次提交，让它悬而未决（提交锁被占用）。
    fireEvent.keyDown(input, { key: "Enter" });
    expect(interaction.submitComposer).toHaveBeenCalledTimes(1);

    // 停止按钮此刻仍可用，并能真正触发 stop。
    const stopButton = screen.getByRole("button", { name: "停止执行" });
    expect(stopButton).not.toBeDisabled();
    fireEvent.click(stopButton);
    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));

    await act(async () => {
      resolveSubmission({
        ...result("accepted_pending"),
        snapshot: { content: "提交但先不结束", attachmentRefs: [] }
      });
      await pending;
    });
    expect(input).toHaveValue("提交但先不结束");
  });

  it("does not send a second stop while the first stop is in flight", async () => {
    let resolveStop!: (value: boolean) => void;
    const stopPending = new Promise<boolean>((resolve) => {
      resolveStop = resolve;
    });
    const stop = vi.fn(() => stopPending);
    const interaction = preview({ stop });
    render(<Harness interaction={interaction} />);

    const stopButton = screen.getByRole("button", { name: "停止执行" });
    fireEvent.click(stopButton);
    fireEvent.click(stopButton);
    expect(stop).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveStop(true);
      await stopPending;
    });
  });

  it("does not clear text entered while an earlier submission is pending", async () => {
    let resolveSubmission!: (value: V2ClientCommandState) => void;
    const pending = new Promise<V2ClientCommandState>((resolve) => {
      resolveSubmission = resolve;
    });
    const interaction = preview({ submitComposer: vi.fn(() => pending) });
    render(<Harness interaction={interaction} />);
    const input = screen.getByRole("textbox", { name: "任务输入" });

    fireEvent.change(input, { target: { value: "原提交" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "提交期间的新输入" } });

    await act(async () => {
      resolveSubmission({
        ...result("accepted_pending"),
        snapshot: { content: "原提交", attachmentRefs: [] }
      });
      await pending;
    });
    expect(input).toHaveValue("提交期间的新输入");
  });

  it("automatically restores cleared text and attachments after late failure", async () => {
    const attachment = {
      id: "attachment_restore",
      name: "恢复范围.txt",
      mimeType: "text/plain",
      sizeBytes: 16,
      kind: "document" as const,
      url: "/api/attachments/attachment_restore"
    };
    useWorkbenchUiStore.setState({ pendingAttachments: [attachment] });
    const acceptedCommand: V2ClientCommandState = {
      ...result("accepted_pending"),
      snapshot: {
        content: "消息",
        attachmentRefs: [attachment.id]
      }
    };
    const initial = preview({
      submitComposer: vi.fn(async () => acceptedCommand)
    });
    const view = render(<Harness interaction={initial} />);
    const input = screen.getByRole("textbox", { name: "任务输入" });
    fireEvent.change(input, { target: { value: "消息" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(input).toHaveValue(""));
    expect(useWorkbenchUiStore.getState().pendingAttachments).toHaveLength(0);

    const failedCommand: V2ClientCommandState = {
      ...acceptedCommand,
      status: "failed",
      errorCode: "NETWORK_ERROR",
      retryable: true
    };
    view.rerender(<Harness interaction={preview({
      controllerState: {
        order: [failedCommand.commandId],
        commands: { [failedCommand.commandId]: failedCommand }
      },
      feedback: "提交失败，内容已保留"
    })} />);

    await waitFor(() => expect(input).toHaveValue("消息"));
    expect(useWorkbenchUiStore.getState().pendingAttachments).toEqual([attachment]);
    expect(screen.getByText("恢复范围.txt")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "恢复原提交内容" })).not.toBeInTheDocument();
  });

  it("offers explicit restore without overwriting newer input after late rejection", async () => {
    const acceptedCommand: V2ClientCommandState = {
      ...result("accepted_pending"),
      snapshot: { content: "原提交", attachmentRefs: [] }
    };
    const view = render(<Harness interaction={preview({
      submitComposer: vi.fn(async () => acceptedCommand)
    })} />);
    const input = screen.getByRole("textbox", { name: "任务输入" });
    fireEvent.change(input, { target: { value: "原提交" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(input).toHaveValue(""));

    fireEvent.change(input, { target: { value: "用户的新输入" } });
    const rejectedCommand: V2ClientCommandState = {
      ...acceptedCommand,
      status: "rejected",
      errorCode: "COMMAND_REVISION_CONFLICT"
    };
    view.rerender(<Harness interaction={preview({
      controllerState: {
        order: [rejectedCommand.commandId],
        commands: { [rejectedCommand.commandId]: rejectedCommand }
      },
      feedback: "请求已拒绝，内容已保留"
    })} />);

    expect(input).toHaveValue("用户的新输入");
    const restore = await screen.findByRole("button", { name: "恢复原提交内容" });
    expect(input).toHaveValue("用户的新输入");
    fireEvent.click(restore);
    await waitFor(() => expect(input).toHaveValue("原提交"));
  });

  // 阻断项 5：非运行态 Ctrl/Cmd+Enter 是普通发送，不触发 v2 preview 提交。
  it.each([
    ["Ctrl", { ctrlKey: true }],
    ["Cmd", { metaKey: true }]
  ] as const)("treats non-running %s+Enter as an ordinary send", async (_label, modifier) => {
    const interaction = preview({ activeRun: false });
    render(<Harness interaction={interaction} />);
    const input = screen.getByRole("textbox", { name: "任务输入" });
    fireEvent.change(input, { target: { value: "非运行态普通发送" } });

    fireEvent.keyDown(input, { key: "Enter", ...modifier });

    await waitFor(() => expect(modelRun).toHaveBeenCalledTimes(1));
    expect(interaction.submitComposer).not.toHaveBeenCalled();
  });
});
