import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Header carrying a server-signed tenant assertion. The Search Agent verifies
 * this instead of trusting the `tenantId` body field, so a caller holding the
 * shared internal token still cannot claim a tenant it does not own.
 */
export const TENANT_ASSERTION_HEADER = "X-Workbench-Tenant-Assertion";

export class TenantAssertionError extends Error {
  constructor(message = "租户断言签名不可用") {
    super(message);
    this.name = "TenantAssertionError";
  }
}

function signingSecret(): string | null {
  const secret = (process.env.WORKBENCH_INTERNAL_TOKEN || "").trim();
  return secret || null;
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

export function signTenantAssertion(input: { tenantId: string; runId: string; visitorId: string }): string | null {
  const secret = signingSecret();
  if (!secret) return null;
  const mac = createHmac("sha256", secret).update(macPayload(input), "utf8").digest("hex");
  return `v1:${mac}`;
}

/** Constant-time verification; any shape or MAC mismatch is a rejection. */
export function verifyTenantAssertion(
  assertion: string | null,
  expected: { tenantId: string; runId: string; visitorId: string }
): boolean {
  const secret = signingSecret();
  if (!secret || !assertion) return false;
  const want = signTenantAssertion(expected);
  if (!want) return false;
  const got = Buffer.from(assertion, "utf8");
  const reference = Buffer.from(want, "utf8");
  if (got.length !== reference.length) return false;
  return timingSafeEqual(got, reference);
}
