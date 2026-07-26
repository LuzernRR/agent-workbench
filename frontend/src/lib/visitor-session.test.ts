import { describe, expect, it } from "vitest";
import { createVisitorToken, isVisitorToken } from "./visitor-session";

describe("匿名访客凭证", () => {
  it("生成 256 位随机且符合 Base64URL 格式的凭证", () => {
    const tokens = Array.from({ length: 64 }, createVisitorToken);
    expect(new Set(tokens)).toHaveLength(tokens.length);
    for (const token of tokens) {
      expect(token).toMatch(/^wbv_[A-Za-z0-9_-]{43}$/u);
      expect(isVisitorToken(token)).toBe(true);
      const encoded = token.slice(4).replaceAll("-", "+").replaceAll("_", "/");
      expect(Uint8Array.from(atob(`${encoded}=`), (character) => character.charCodeAt(0))).toHaveLength(32);
    }
  });

  it("拒绝缺失、截断和非 Base64URL 凭证", () => {
    expect(isVisitorToken(null)).toBe(false);
    expect(isVisitorToken("wbv_short")).toBe(false);
    expect(isVisitorToken(`wbv_${"a".repeat(42)}+`)).toBe(false);
    expect(isVisitorToken(`wbv_${"a".repeat(44)}`)).toBe(false);
  });
});
