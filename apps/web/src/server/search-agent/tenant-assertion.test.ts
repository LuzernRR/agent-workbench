import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signTenantAssertion, TenantAssertionError, verifyTenantAssertion } from "./tenant-assertion";

const subject = { tenantId: "tenant-a", runId: "run-one", visitorId: "visitor-one" };
const assertionSecret = "0123456789abcdef0123456789abcdef";
const original = {
  token: process.env.WORKBENCH_INTERNAL_TOKEN,
  assertionSecret: process.env.WORKBENCH_TENANT_ASSERTION_SECRET,
  allowInsecureLoopback: process.env.SEARCH_AGENT_ALLOW_INSECURE_LOOPBACK
};

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("Search Agent 租户断言", () => {
  beforeEach(() => {
    process.env.WORKBENCH_INTERNAL_TOKEN = "internal-transport-token";
    process.env.WORKBENCH_TENANT_ASSERTION_SECRET = assertionSecret;
    delete process.env.SEARCH_AGENT_ALLOW_INSECURE_LOOPBACK;
  });

  afterEach(() => {
    restore("WORKBENCH_INTERNAL_TOKEN", original.token);
    restore("WORKBENCH_TENANT_ASSERTION_SECRET", original.assertionSecret);
    restore("SEARCH_AGENT_ALLOW_INSECURE_LOOPBACK", original.allowInsecureLoopback);
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
    process.env.WORKBENCH_TENANT_ASSERTION_SECRET = "fedcba9876543210fedcba9876543210";
    const forged = signTenantAssertion(subject);
    process.env.WORKBENCH_TENANT_ASSERTION_SECRET = assertionSecret;
    expect(verifyTenantAssertion(forged, subject)).toBe(false);
  });

  it("仅知道内部传输 Token 无法伪造租户断言", () => {
    const payload = [subject.tenantId, subject.runId, subject.visitorId]
      .map((part) => `${Buffer.byteLength(part, "utf8")}:${part}`)
      .join("");
    const forged = `v1:${createHmac("sha256", process.env.WORKBENCH_INTERNAL_TOKEN!)
      .update(payload, "utf8")
      .digest("hex")}`;

    expect(verifyTenantAssertion(forged, subject)).toBe(false);
  });

  it("缺失、过弱或与内部 Token 相同的密钥均 fail-closed", () => {
    expect(verifyTenantAssertion(null, subject)).toBe(false);
    expect(verifyTenantAssertion("v1:abc", subject)).toBe(false);

    delete process.env.WORKBENCH_TENANT_ASSERTION_SECRET;
    expect(() => signTenantAssertion(subject)).toThrow(TenantAssertionError);
    expect(verifyTenantAssertion("v1:abc", subject)).toBe(false);

    process.env.WORKBENCH_TENANT_ASSERTION_SECRET = "不足三十二字节";
    expect(() => signTenantAssertion(subject)).toThrow(TenantAssertionError);

    process.env.WORKBENCH_INTERNAL_TOKEN = assertionSecret;
    process.env.WORKBENCH_TENANT_ASSERTION_SECRET = assertionSecret;
    expect(() => signTenantAssertion(subject)).toThrow(TenantAssertionError);
  });

  it("密钥强度按 UTF-8 字节数而不是字符数计算", () => {
    process.env.WORKBENCH_TENANT_ASSERTION_SECRET = "密".repeat(11);
    expect(Buffer.byteLength(process.env.WORKBENCH_TENANT_ASSERTION_SECRET, "utf8")).toBe(33);
    expect(signTenantAssertion(subject)).toMatch(/^v1:[0-9a-f]{64}$/u);
  });

  it("仅显式 loopback 开发模式可在无断言密钥时继续", () => {
    delete process.env.WORKBENCH_TENANT_ASSERTION_SECRET;
    process.env.SEARCH_AGENT_ALLOW_INSECURE_LOOPBACK = "1";

    expect(signTenantAssertion(subject, { serviceOrigin: "http://127.0.0.1:8100" })).toBeNull();
    expect(signTenantAssertion(subject, { serviceOrigin: "http://[::1]:8100" })).toBeNull();
    expect(() => signTenantAssertion(subject, { serviceOrigin: "http://search-agent:8100" })).toThrow(TenantAssertionError);
    expect(() => signTenantAssertion(subject, { serviceOrigin: "https://agent.example.com" })).toThrow(TenantAssertionError);
  });

  // Length-prefixed components mean a colon inside any field cannot shift the
  // boundary between fields. Without the prefix, ("a","b:c","d") and
  // ("a","b","c:d") would share a MAC.
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
    process.env.WORKBENCH_TENANT_ASSERTION_SECRET = assertionSecret;
    expect(signTenantAssertion({ tenantId: "tenant_1", runId: "run_1", visitorId: "visitor_1" })).toBe(
      "v1:d0cc50732b3b1a5892d4dee8613bd7093fc9c264feaa6d671a2e8719059aae34"
    );
  });

  it("同一运行恢复可复用作用域断言，但不能重放到另一运行或访客", () => {
    const recoveryAssertion = signTenantAssertion(subject);
    expect(verifyTenantAssertion(recoveryAssertion, subject)).toBe(true);
    expect(verifyTenantAssertion(recoveryAssertion, { ...subject, runId: "run-recovered-as-other" })).toBe(false);
    expect(verifyTenantAssertion(recoveryAssertion, { ...subject, visitorId: "visitor-other" })).toBe(false);
  });

  it("断言只携带版本与 MAC，不回显租户与运行标识", () => {
    const assertion = signTenantAssertion(subject);
    expect(assertion).toMatch(/^v1:[0-9a-f]{64}$/u);
    expect(assertion).not.toContain(subject.tenantId);
    expect(assertion).not.toContain(subject.runId);
  });
});
