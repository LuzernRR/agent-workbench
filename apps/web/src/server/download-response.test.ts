import { describe, expect, it } from "vitest";
import { attachmentDisposition } from "./download-response";

describe("attachmentDisposition", () => {
  it("keeps a safe ASCII fallback and emits an encoded UTF-8 filename", () => {
    const value = attachmentDisposition("工作台实施计划.md", "artifact");
    expect(value).toContain('filename="artifact.md"');
    expect(value).toContain("filename*=UTF-8''%E5%B7%A5");
  });

  it("removes header-breaking characters", () => {
    const value = attachmentDisposition("report\r\nInjected.md");
    expect(value).not.toContain("\r");
    expect(value).not.toContain("\n");
  });
});
