import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Header carrying a server-signed tenant assertion. The Search Agent verifies
 * this instead of trusting the `tenantId` body field, so a caller holding the
 * transport token still cannot claim a tenant it does not own.
 */
export const TENANT_ASSERTION_HEADER = "X-Workbench-Tenant-Assertion";
const MIN_SECRET_BYTES = 32;

type TenantAssertionOptions = {
  serviceOrigin?: string;
};

export class TenantAssertionError extends Error {
  constructor(message = "租户断言签名不可用") {
    super(message);
    this.name = "TenantAssertionError";
  }
}

function explicitInsecureLoopback(options?: TenantAssertionOptions): boolean {
  if (process.env.SEARCH_AGENT_ALLOW_INSECURE_LOOPBACK !== "1" || !options?.serviceOrigin) return false;
  try {
    const hostname = new URL(options.serviceOrigin).hostname.toLowerCase().replace(/^\[|\]$/gu, "");
    if (hostname === "localhost" || hostname === "::1") return true;
    const octets = hostname.split(".");
    return octets.length === 4
      && octets[0] === "127"
      && octets.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255);
  } catch {
    return false;
  }
}

function signingSecret(options?: TenantAssertionOptions): string | null {
  const secret = (process.env.WORKBENCH_TENANT_ASSERTION_SECRET || "").trim();
  if (!secret) {
    if (explicitInsecureLoopback(options)) return null;
    throw new TenantAssertionError("租户断言密钥未配置");
  }
  if (Buffer.byteLength(secret, "utf8") < MIN_SECRET_BYTES) {
    throw new TenantAssertionError("租户断言密钥至少需要 32 个 UTF-8 字节");
  }
  const internalToken = (process.env.WORKBENCH_INTERNAL_TOKEN || "").trim();
  if (internalToken && secret === internalToken) {
    throw new TenantAssertionError("租户断言密钥必须与内部服务 Token 独立");
  }
  return secret;
}

/**
 * Tenant, run, and visitor bound together under one MAC. Binding the run and
 * visitor prevents replaying a valid assertion onto another tenant's run.
 *
 * Each component is prefixed with its UTF-8 byte length so no two different
 * triples can produce the same payload. Plain `a:b:c` joining would make
 * `("a", "b:c", "d")` and `("a", "b", "c:d")` collide. Byte length (not
 * `String.length`) keeps this identical to the Python verifier, which counts
 * bytes rather than UTF-16 code units.
 */
function macPayload(input: { tenantId: string; runId: string; visitorId: string }) {
  return [input.tenantId, input.runId, input.visitorId]
    .map((part) => `${Buffer.byteLength(part, "utf8")}:${part}`)
    .join("");
}

export function signTenantAssertion(
  input: { tenantId: string; runId: string; visitorId: string },
  options?: TenantAssertionOptions
): string | null {
  const secret = signingSecret(options);
  if (!secret) return null;
  const mac = createHmac("sha256", secret).update(macPayload(input), "utf8").digest("hex");
  return `v1:${mac}`;
}

/** Constant-time verification; any shape or MAC mismatch is a rejection. */
export function verifyTenantAssertion(
  assertion: string | null,
  expected: { tenantId: string; runId: string; visitorId: string }
): boolean {
  try {
    const secret = signingSecret();
    if (!secret || !assertion) return false;
    const mac = createHmac("sha256", secret).update(macPayload(expected), "utf8").digest("hex");
    const got = Buffer.from(assertion, "utf8");
    const reference = Buffer.from(`v1:${mac}`, "utf8");
    if (got.length !== reference.length) return false;
    return timingSafeEqual(got, reference);
  } catch (error) {
    if (error instanceof TenantAssertionError) return false;
    throw error;
  }
}
