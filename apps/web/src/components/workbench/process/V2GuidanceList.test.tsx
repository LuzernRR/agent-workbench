import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { V2GuidanceList } from "./V2GuidanceList";

describe("V2GuidanceList", () => {
  it("shows persisted lifecycle states in command sequence order without private content", () => {
    render(<V2GuidanceList guidance={[
      {
        commandId: "command_1",
        commandSeq: 1,
        status: "accepted_pending",
        expectedSteeringRevision: 2,
        currentSteeringRevision: 2,
        newSteeringRevision: null,
        appliedAtNode: null,
        impact: null,
        supersededByCommandId: null,
        lastSeq: 9,
        firstSeq: 9,
        inputRevision: 1,
        errorCode: null,
        retryable: null
      },
      {
        commandId: "command_2",
        commandSeq: 2,
        status: "rejected",
        expectedSteeringRevision: 1,
        currentSteeringRevision: 2,
        newSteeringRevision: null,
        appliedAtNode: null,
        impact: null,
        supersededByCommandId: null,
        lastSeq: 10,
        firstSeq: 10,
        inputRevision: 1,
        errorCode: "COMMAND_REVISION_CONFLICT",
        retryable: false
      }
    ]} />);

    expect(screen.getByText("已接收，等待应用")).toBeInTheDocument();
    expect(screen.getByText("引导版本已变化，请重新读取后再提交")).toHaveAttribute(
      "data-error-code",
      "COMMAND_REVISION_CONFLICT"
    );
    expect(screen.queryByText(/contentHash|idempotency|reasoning_content|prompt/iu)).not.toBeInTheDocument();
  });
});
