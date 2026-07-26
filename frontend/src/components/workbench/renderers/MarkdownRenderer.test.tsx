import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownRenderer } from "./MarkdownRenderer";

describe("MarkdownRenderer", () => {
  it("renders semantic markdown while replacing a raw URL label", () => {
    render(<MarkdownRenderer>{"# 调研结论\n\n- 已验证\n\n[https://example.com/report](https://example.com/report)"}</MarkdownRenderer>);

    expect(screen.getByRole("heading", { level: 1, name: "调研结论" })).toBeVisible();
    expect(screen.getByRole("list")).toBeVisible();
    const link = screen.getByRole("link", { name: "访问 example.com" });
    expect(link).toHaveAttribute("href", "https://example.com/report");
    expect(screen.queryByText("https://example.com/report")).not.toBeInTheDocument();
  });

  it("does not create executable links or unsafe images", () => {
    const { container } = render(<MarkdownRenderer>{"[危险链接](javascript:alert(1))\n\n![https://bad.example/x](data:text/html,test)"}</MarkdownRenderer>);

    expect(screen.queryByRole("link", { name: "危险链接" })).not.toBeInTheDocument();
    expect(screen.getByText("危险链接")).toBeVisible();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.queryByText(/https:\/\/bad\.example/u)).not.toBeInTheDocument();
  });

  it("keeps comparison tables semantic inside a responsive scroll region", () => {
    const { container } = render(<MarkdownRenderer>{"| 模型 | 上下文 |\n| --- | --- |\n| DeepSeek | 128K |"}</MarkdownRenderer>);

    expect(screen.getByRole("table")).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "模型" })).toBeVisible();
    expect(container.querySelector(".markdown-table-scroll > table")).toBe(screen.getByRole("table"));
  });
});
