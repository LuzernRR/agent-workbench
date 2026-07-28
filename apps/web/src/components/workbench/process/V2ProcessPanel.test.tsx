import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  projectS01ProcessFixture,
  S01_COMPLEX_RUN_EVENTS
} from "@/server/mock/s01-event-fixtures";
import {
  isLegacyTimelineItemVisibleInS01Preview,
  projectV2ProcessView
} from "@/lib/agent-events/v2/process-view-model";
import { mergeV2RunInput } from "@/lib/agent-events/v2/run-reducer";
import type { V2RunState } from "@/lib/agent-events/v2/run-reducer";
import type { MessageItem } from "@/lib/agent-events/types";
import type { V2ReasonCode } from "@/lib/agent-events/v2/types";
import { V2ProcessPanel } from "./V2ProcessPanel";

function renderPanel(state: V2RunState, preferenceRunId = state.runId) {
  return render(<V2ProcessPanel state={state} preferenceRunId={preferenceRunId} />);
}

function withVerificationReasons(
  state: V2RunState,
  reasonCodes: readonly V2ReasonCode[]
): V2RunState {
  const verificationId = state.processOrder.find((id) =>
    state.processById[id]?.type === "verification.completed"
  );
  if (!verificationId) throw new Error("Fixture has no verification event");
  return {
    ...state,
    processById: {
      ...state.processById,
      [verificationId]: {
        ...state.processById[verificationId],
        reasonCodes
      }
    }
  };
}

beforeEach(() => {
  window.localStorage.clear();
  cleanup();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("V2ProcessPanel", () => {
  it("opens active runs by default and displays only persisted public paragraphs", () => {
    renderPanel(projectS01ProcessFixture("active"));

    expect(screen.getByRole("button", { name: "收起执行过程" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("执行中")).toBeInTheDocument();
    expect(screen.getByText("已根据问题范围完成处理路径选择。")).toBeInTheDocument();
    expect(screen.getByText("测试数据")).toBeInTheDocument();
  });

  it("collapses completed runs automatically while failed and waiting runs stay open", () => {
    const completed = renderPanel(projectS01ProcessFixture("complex"));
    expect(screen.getByRole("button", { name: "展开执行过程" })).toHaveAttribute("aria-expanded", "false");
    completed.unmount();

    renderPanel(projectS01ProcessFixture("verification_failed"));
    expect(screen.getByRole("button", { name: "收起执行过程" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("未完成")).toBeInTheDocument();
    cleanup();

    renderPanel(projectS01ProcessFixture("waiting"));
    expect(screen.getByRole("button", { name: "收起执行过程" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("等待中")).toBeInTheDocument();
  });

  it("does not let event-driven status changes override a manual choice", () => {
    const view = renderPanel(projectS01ProcessFixture("active"), "runtime_run_manual");
    fireEvent.click(screen.getByRole("button", { name: "收起执行过程" }));
    expect(screen.getByRole("button", { name: "展开执行过程" })).toHaveAttribute("aria-expanded", "false");

    view.rerender(
      <V2ProcessPanel
        state={projectS01ProcessFixture("waiting")}
        preferenceRunId="runtime_run_manual"
      />
    );
    expect(screen.getByRole("button", { name: "展开执行过程" })).toHaveAttribute("aria-expanded", "false");
  });

  it("restores the manual state after remounting", () => {
    const first = renderPanel(projectS01ProcessFixture("complex"), "runtime_run_refresh");
    fireEvent.click(screen.getByRole("button", { name: "展开执行过程" }));
    expect(screen.getByRole("button", { name: "收起执行过程" })).toHaveAttribute("aria-expanded", "true");
    first.unmount();

    renderPanel(projectS01ProcessFixture("complex"), "runtime_run_refresh");
    expect(screen.getByRole("button", { name: "收起执行过程" })).toHaveAttribute("aria-expanded", "true");
  });

  it("uses the event-driven default when the localStorage getter throws", () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("Storage blocked", "SecurityError");
    });

    expect(() => renderPanel(projectS01ProcessFixture("complex"))).not.toThrow();
    expect(screen.getByRole("button", { name: "展开执行过程" })).toHaveAttribute(
      "aria-expanded",
      "false"
    );
  });

  it("keeps the current React state when localStorage setItem throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage full", "QuotaExceededError");
    });
    renderPanel(projectS01ProcessFixture("complex"));

    expect(() => {
      fireEvent.click(screen.getByRole("button", { name: "展开执行过程" }));
    }).not.toThrow();
    expect(screen.getByRole("button", { name: "收起执行过程" })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
  });

  it("does not render an empty plan for direct runs", () => {
    renderPanel(projectS01ProcessFixture("direct"));
    fireEvent.click(screen.getByRole("button", { name: "展开执行过程" }));

    expect(screen.queryByText("计划")).not.toBeInTheDocument();
    expect(screen.getByText("核验通过")).toBeInTheDocument();
  });

  it("updates a complex plan in place without retaining the old revision", () => {
    const active = projectS01ProcessFixture("active");
    const basePlan = structuredClone(S01_COMPLEX_RUN_EVENTS[0]) as Record<string, unknown>;
    const first = mergeV2RunInput(active, {
      ...basePlan,
      eventId: "plan_revision_1",
      runId: active.runId,
      seq: active.cursor + 1,
      refs: { planRef: "plan_runtime" },
      payload: {
        ...(basePlan.payload as Record<string, unknown>),
        planRef: "plan_runtime",
        revision: 1,
        publicText: "先核对来源，再整理关键结论。"
      }
    });
    expect(first.accepted).toBe(true);
    const second = mergeV2RunInput(first.state, {
      ...basePlan,
      eventId: "plan_revision_2",
      runId: active.runId,
      seq: first.state.cursor + 1,
      refs: { planRef: "plan_runtime" },
      payload: {
        ...(basePlan.payload as Record<string, unknown>),
        planRef: "plan_runtime",
        revision: 2,
        publicText: "先核对官方来源，再对冲突结论逐项复核。"
      }
    });
    expect(second.accepted).toBe(true);

    renderPanel(second.state);
    expect(screen.getByText("先核对官方来源，再对冲突结论逐项复核。")).toBeInTheDocument();
    expect(screen.queryByText("先核对来源，再整理关键结论。")).not.toBeInTheDocument();
    expect(screen.getAllByText("计划")).toHaveLength(1);
  });

  it("keeps complex fixture conclusions consistent with its search plan", () => {
    const model = projectV2ProcessView(projectS01ProcessFixture("complex"));

    expect(model.entries.map((entry) => entry.text)).toContain(
      "该任务需要比较多个来源，后续结论需要证据支持。"
    );
    expect(model.entries.map((entry) => entry.text)).not.toContain(
      "该问题可直接回答，不需要外部搜索。"
    );
  });

  it("does not invent fallback process text when publicText is null", () => {
    renderPanel(projectS01ProcessFixture("waiting"));

    expect(screen.queryByText(/已理解问题|正在制定计划|正在验证/u)).not.toBeInTheDocument();
    expect(screen.getByTestId("v2-process-panel").querySelectorAll("p")).toHaveLength(0);
  });

  it("shows verification failure without exposing drafts, refs or private reasoning", () => {
    const failed = projectS01ProcessFixture("verification_failed");
    const stateWithPrivateField = {
      ...failed,
      reasoning_content: "private chain",
      rawCoT: "hidden"
    } as V2RunState;
    renderPanel(stateWithPrivateField);

    expect(screen.getByText("核验未通过", { selector: "div" })).toBeInTheDocument();
    expect(screen.getByText("现有结果未通过核验，不能作为最终答复。")).toBeInTheDocument();
    expect(screen.queryByText(/private chain|hidden|resultRef|resultHash|contentRef/u)).not.toBeInTheDocument();
    expect(projectV2ProcessView(failed).finalAnswerVisible).toBe(false);
  });

  it("derives partial verification and final-answer visibility from accepted terminal state", () => {
    const partial = projectS01ProcessFixture("partial");
    const direct = projectS01ProcessFixture("direct");
    const failed = projectS01ProcessFixture("verification_failed");

    renderPanel(partial);
    fireEvent.click(screen.getByRole("button", { name: "展开执行过程" }));
    expect(screen.getByText("部分核验")).toBeInTheDocument();
    expect(screen.getByText("预算已耗尽")).toHaveAttribute(
      "data-reason-code",
      "budget_exhausted"
    );
    expect(projectV2ProcessView(partial).finalAnswerVisible).toBe(true);
    expect(projectV2ProcessView(direct).finalAnswerVisible).toBe(true);
    expect(projectV2ProcessView(failed).finalAnswerVisible).toBe(false);
  });

  it.each([
    "direct",
    "partial",
    "verification_failed",
    "waiting",
    "stopped"
  ] as const)("never exposes an unbound v1 assistant message for %s", (scenario) => {
    const state = projectS01ProcessFixture(scenario);
    const unboundAssistant: MessageItem = {
      kind: "message",
      id: "legacy_message_other",
      runId: "anchor_run",
      role: "assistant",
      text: "这是一条未绑定到 v2 response 的旧正文。",
      status: "completed",
      createdAt: "2026-07-27T01:00:00Z"
    };

    expect(projectV2ProcessView(state).finalAnswerVisible).toBe(
      scenario === "direct" || scenario === "partial"
    );
    expect(
      isLegacyTimelineItemVisibleInS01Preview(unboundAssistant, "anchor_run")
    ).toBe(false);
  });

  it("shows only stable verification reason codes without exposing internal refs", () => {
    renderPanel(withVerificationReasons(projectS01ProcessFixture("verification_failed"), [
      "insufficient_evidence",
      "conflicting_evidence",
      "verification_failed"
    ]));

    expect(screen.getByText("原因：")).toBeInTheDocument();
    expect(screen.getByText("证据不足、")).toHaveAttribute(
      "data-reason-code",
      "insufficient_evidence"
    );
    expect(screen.getByText("来源冲突、")).toHaveAttribute(
      "data-reason-code",
      "conflicting_evidence"
    );
    expect(screen.getByText("核验未通过", { selector: "[data-reason-code]" })).toHaveAttribute(
      "data-reason-code",
      "verification_failed"
    );
    expect(screen.queryByText(/resultRef|resultHash|contentRef/u)).not.toBeInTheDocument();
  });
});
