import { describe, expect, it } from "vitest";
import type { AgentThreadState } from "@/lib/agent-events/types";
import { extractArtifactMarkdown, findArtifactReview, isDuplicateConversationArtifact } from "./AgentWorkspace";

describe("extractArtifactMarkdown", () => {
  it("extracts markdown from a research.report envelope", () => {
    expect(extractArtifactMarkdown(JSON.stringify({ type: "research.report", content: "# 市场结论\n\n证据充分。" }))).toBe("# 市场结论\n\n证据充分。");
  });

  it("removes code fences and escaped newlines", () => {
    expect(extractArtifactMarkdown("```json\n{\"content\":\"## 结论\\n\\n第一项\"}\n```" )).toBe("## 结论\n\n第一项");
  });

  it("does not expose unsupported structured data", () => {
    expect(extractArtifactMarkdown(JSON.stringify({ type: "research.graph", nodes: [{ id: "private" }] }))).toBe("成果内容暂不可预览");
  });

  it("hides an artifact that duplicates the assistant answer after markdown normalization", () => {
    const state = {
      items: {
        answer: {
          kind: "message",
          id: "answer",
          runId: "run-1",
          role: "assistant",
          text: "# 调研结论\n\n**核心判断**：证据充分。",
          status: "completed",
          createdAt: "2026-07-24T00:00:00Z"
        }
      },
      itemOrder: ["answer"]
    } as unknown as AgentThreadState;

    expect(isDuplicateConversationArtifact(JSON.stringify({
      type: "research.report",
      content: "# 调研结论\n\n**核心判断**：证据充分。"
    }), state)).toBe(true);
  });

  it("keeps evidence artifacts that add information beyond the answer", () => {
    const state = {
      items: {
        answer: {
          kind: "message",
          id: "answer",
          runId: "run-1",
          role: "assistant",
          text: "结论：支持上线。",
          status: "completed",
          createdAt: "2026-07-24T00:00:00Z"
        }
      },
      itemOrder: ["answer"]
    } as unknown as AgentThreadState;

    expect(isDuplicateConversationArtifact("| 来源 | 结论 |\n| --- | --- |\n| 官方文档 | 支持上线 |", state)).toBe(false);
  });
});

describe("findArtifactReview", () => {
  it("recognizes the server-side DeepSeek artifact review tool", () => {
    const state = {
      items: {
        review: { kind: "tool", id: "review", runId: "run-1", toolCallId: "deepseek-artifact-review", name: "成果审核", summary: "重构中", status: "running", createdAt: "2026-07-24T00:00:00Z" }
      },
      itemOrder: ["review"]
    } as unknown as AgentThreadState;

    expect(findArtifactReview(state)?.status).toBe("running");
  });
});
