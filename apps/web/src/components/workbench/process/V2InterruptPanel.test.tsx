import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { V2PreviewInteractionRuntime } from "@/lib/agent-events/v2/use-v2-preview-interaction";
import type {
  V2ApprovalView,
  V2ClarificationView
} from "@/lib/agent-events/v2/process-view-model";
import { projectS01ProcessFixture } from "@/server/mock/s01-event-fixtures";
import { V2InterruptPanel } from "./V2InterruptPanel";

afterEach(() => {
  cleanup();
});

const clarification: V2ClarificationView = {
  clarificationId: "clarification_1",
  checkpointRef: "checkpoint_1",
  question: "需要比较哪个时间范围？",
  stateRevision: 4,
  status: "waiting",
  seq: 5
};

const approval: V2ApprovalView = {
  approvalId: "approval_1",
  toolCallId: "tool_call_1",
  actionSummary: "读取受限项目文档",
  permissionSummary: "需要项目读取权限",
  status: "waiting",
  seq: 6
};

function command(status: "applied" | "rejected", errorCode: string | null = null) {
  return {
    commandId: "command_1",
    kind: "clarification_resume" as const,
    idempotencyKey: "idem_1",
    contentHash: "a".repeat(64),
    status,
    snapshot: { content: "最近一年", attachmentRefs: [] },
    errorCode,
    retryable: false
  };
}

function runtime(
  patch: Partial<V2PreviewInteractionRuntime>
): V2PreviewInteractionRuntime {
  return {
    activeRun: true,
    runState: projectS01ProcessFixture("composer_active"),
    controllerState: { order: [], commands: {} },
    feedback: null,
    submitComposer: vi.fn(async () => command("applied")),
    resumeClarification: vi.fn(async () => command("applied")),
    decideApproval: vi.fn(async () => ({
      ...command("applied"),
      kind: "approval_decision" as const
    })),
    ingestEvidence: vi.fn(() => true),
    retry: vi.fn(async () => null),
    stop: vi.fn(async () => true),
    ...patch
  };
}

describe("V2InterruptPanel", () => {
  it("submits clarification only through the resume adapter", async () => {
    const interaction = runtime({});
    render(<V2InterruptPanel
      clarifications={[clarification]}
      approvals={[]}
      interaction={interaction}
    />);

    fireEvent.change(screen.getByRole("textbox", { name: "澄清回答" }), {
      target: { value: "最近一年" }
    });
    fireEvent.click(screen.getByRole("button", { name: "提交澄清回答" }));

    await waitFor(() => expect(interaction.resumeClarification).toHaveBeenCalledWith({
      clarificationId: "clarification_1",
      checkpointRef: "checkpoint_1",
      expectedStateRevision: 4,
      content: "最近一年",
      attachmentRefs: []
    }));
    expect(interaction.submitComposer).not.toHaveBeenCalled();
    expect(interaction.decideApproval).not.toHaveBeenCalled();
  });

  it("retains clarification text after a stale checkpoint rejection", async () => {
    const interaction = runtime({
      resumeClarification: vi.fn(async () => command(
        "rejected",
        "CLARIFICATION_STALE_CHECKPOINT"
      ))
    });
    render(<V2InterruptPanel
      clarifications={[clarification]}
      approvals={[]}
      interaction={interaction}
    />);

    const textbox = screen.getByRole("textbox", { name: "澄清回答" });
    fireEvent.change(textbox, { target: { value: "最近一年" } });
    fireEvent.click(screen.getByRole("button", { name: "提交澄清回答" }));

    expect(await screen.findByText("澄清检查点已变化，请重新读取后再提交")).toBeInTheDocument();
    expect(textbox).toHaveValue("最近一年");
  });

  it("offers allow once and deny only, with no v1 always-allow or edit control", async () => {
    const interaction = runtime({});
    render(<V2InterruptPanel
      clarifications={[]}
      approvals={[approval]}
      interaction={interaction}
    />);

    expect(screen.getByRole("button", { name: "仅允许本次工具操作" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "拒绝工具操作" })).toBeInTheDocument();
    expect(screen.queryByText(/始终允许|编辑参数/u)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "仅允许本次工具操作" }));
    await waitFor(() => expect(interaction.decideApproval).toHaveBeenCalledWith({
      approvalId: "approval_1",
      toolCallId: "tool_call_1",
      decision: "allow_once"
    }));
    expect(interaction.submitComposer).not.toHaveBeenCalled();
    expect(interaction.resumeClarification).not.toHaveBeenCalled();
  });

  it("renders edit as read-only and terminal clarification as stopped", () => {
    render(<V2InterruptPanel
      clarifications={[{ ...clarification, status: "stopped" }]}
      approvals={[{ ...approval, status: "edit_readonly" }]}
      interaction={runtime({})}
    />);

    expect(screen.getByText("任务已停止，无法继续回答")).toBeInTheDocument();
    expect(screen.getByText("等待调整或重新确认")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "仅允许本次工具操作" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "澄清回答" })).not.toBeInTheDocument();
  });

  it("closes the double-click window for clarification and approval", async () => {
    const approvalResult = {
      ...command("applied"),
      kind: "approval_decision" as const
    };
    let releaseClarification!: (value: ReturnType<typeof command>) => void;
    let releaseApproval!: (value: typeof approvalResult) => void;
    const clarificationPending = new Promise<ReturnType<typeof command>>((resolve) => {
      releaseClarification = resolve;
    });
    const approvalPending = new Promise<typeof approvalResult>((resolve) => {
      releaseApproval = resolve;
    });
    const resumeClarification = vi.fn(() => clarificationPending);
    const decideApproval = vi.fn(() => approvalPending);
    const interaction = runtime({ resumeClarification, decideApproval });
    render(<V2InterruptPanel
      clarifications={[clarification]}
      approvals={[approval]}
      interaction={interaction}
    />);

    fireEvent.change(screen.getByRole("textbox", { name: "澄清回答" }), {
      target: { value: "最近一年" }
    });
    const clarificationButton = screen.getByRole("button", { name: "提交澄清回答" });
    fireEvent.click(clarificationButton);
    fireEvent.click(clarificationButton);
    expect(resumeClarification).toHaveBeenCalledTimes(1);

    const approvalButton = screen.getByRole("button", { name: "仅允许本次工具操作" });
    fireEvent.click(approvalButton);
    fireEvent.click(approvalButton);
    expect(decideApproval).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseClarification(command("applied"));
      releaseApproval(approvalResult);
      await Promise.all([clarificationPending, approvalPending]);
    });
  });
});
