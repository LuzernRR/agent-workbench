import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signTenantAssertion, verifyTenantAssertion } from "./tenant-assertion";

const subject = { tenantId: "tenant-a", runId: "run-one", visitorId: "visitor-one" };
let original: string | undefined;

describe("Search Agent 租户断言", () => {
  beforeEach(() => {
    original = process.env.WORKBENCH_INTERNAL_TOKEN;
    process.env.WORKBENCH_INTERNAL_TOKEN = "secret-token";
  });

  afterEach(() => {
    if (original === undefined) delete process.env.WORKBENCH_INTERNAL_TOKEN;
    else process.env.WORKBENCH_INTERNAL_TOKEN = original;
  });

  it("签名绑定租户、运行与访客三者", () => {
    const assertion = signTenantAssertion(subject);
    expect(assertion).toMatch(/^v1:[0-9a-f]{64}$/u);
    expect(verifyTenantAssertion(assertion, subject)).toBe(true);
  });

  it("把断言重放到其他租户的运行上会被拒绝", () => {
    const assertion = signTenantAssertion(subject);
    expect(verifyTenantAssertion(assertion, { ...subject, tenantId: "tenant-b" })).toBe(false);
    expect(verifyTenantAssertion(assertion, { ...subject, runId: "run-two" })).toBe(false);
    expect(verifyTenantAssertion(assertion, { ...subject, visitorId: "visitor-two" })).toBe(false);
  });

  it("换用其他密钥签发的断言无法通过验证", () => {
    process.env.WORKBENCH_INTERNAL_TOKEN = "other-token";
    const forged = signTenantAssertion(subject);
    process.env.WORKBENCH_INTERNAL_TOKEN = "secret-token";
    expect(verifyTenantAssertion(forged, subject)).toBe(false);
  });

  it("缺失断言或未配置密钥时 fail-closed", () => {
    expect(verifyTenantAssertion(null, subject)).toBe(false);
    expect(verifyTenantAssertion("v1:abc", subject)).toBe(false);
    delete process.env.WORKBENCH_INTERNAL_TOKEN;
    expect(signTenantAssertion(subject)).toBeNull();
    expect(verifyTenantAssertion("v1:abc", subject)).toBe(false);
  });

  // The MAC payload joins three fields with ":" and does not escape them, so a
  // colon inside any component would let two different triples share one MAC.
  // Today tenant is CHECK-constrained to [A-Za-z0-9_-] and run/visitor IDs are
  // UUID-derived, but those invariants live in other files. This locks the
  // assumption here so widening an ID format fails loudly instead of silently
  // making assertions ambiguous.
  // Length-prefixed components mean a colon inside any field cannot shift the
  // boundary between fields. Without it, ("a","b:c","d") and ("a","b","c:d")
  // would share a MAC — so this stays a test, not a comment.
  it("组件含分隔符时断言不发生碰撞", () => {
    const shifted = signTenantAssertion({ tenantId: "a", runId: "b:c", visitorId: "d" });
    const other = signTenantAssertion({ tenantId: "a", runId: "b", visitorId: "c:d" });
    expect(shifted).not.toBe(other);
    expect(verifyTenantAssertion(shifted, { tenantId: "a", runId: "b", visitorId: "c:d" })).toBe(false);
  });

  // Cross-language known-answer vector. The Python verifier in
  // services/search-agent/tests/test_tenant_assertion.py pins this same digest,
  // so changing the payload format on one side fails both suites.
  it("与 Python 校验端共享固定向量", () => {
    process.env.WORKBENCH_INTERNAL_TOKEN = "golden-secret";
    expect(signTenantAssertion({ tenantId: "tenant_1", runId: "run_1", visitorId: "visitor_1" })).toBe(
      "v1:246dd156b8524e835ff30c6dae169aec7d3dccff0fb4a703f3acb8f44572abd0"
    );
  });

  it("断言只携带版本与 MAC，不回显租户与运行标识", () => {
    const assertion = signTenantAssertion(subject);
    expect(assertion).toMatch(/^v1:[0-9a-f]{64}$/u);
    expect(assertion).not.toContain(subject.tenantId);
    expect(assertion).not.toContain(subject.runId);
  });
});
