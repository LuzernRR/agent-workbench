import { createHash, randomUUID } from "node:crypto";
import { VISITOR_COOKIE, isVisitorToken } from "@/lib/visitor-session";
import { query } from "@/server/persistence/database";

export class VisitorSessionError extends Error {
  constructor(message = "匿名会话凭证无效") {
    super(message);
    this.name = "VisitorSessionError";
  }
}

function cookieValue(request: Request, name: string) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return null;
}

export type VisitorPrincipal = {
  id: string;
  /**
   * Server-derived tenant. It is read back from the visitor row rather than
   * taken from a request field or an env constant, so a caller cannot claim a
   * tenant it does not own. `DEFAULT_TENANT_ID` seeds new sessions only.
   */
  tenantId: string;
};

export const DEFAULT_TENANT_ID = "local";

const TENANT_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

/** Reject a malformed configured tenant instead of writing it and failing the CHECK. */
export function configuredDefaultTenant(): string {
  const configured = (process.env.WORKBENCH_TENANT || "").trim();
  return TENANT_PATTERN.test(configured) ? configured : DEFAULT_TENANT_ID;
}

export async function resolveVisitor(request: Request): Promise<VisitorPrincipal> {
  const token = cookieValue(request, VISITOR_COOKIE);
  if (!isVisitorToken(token)) throw new VisitorSessionError();
  const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");
  const id = randomUUID();
  // The tenant is only seeded when the session row is first created. An
  // existing visitor keeps its stored tenant even if the environment changes,
  // so redeploying with a different WORKBENCH_TENANT cannot silently migrate
  // live sessions into another tenant's data.
  const result = await query<{ id: string; tenant_id: string }>(`
    INSERT INTO wb_visitors (id, token_hash, tenant_id)
    VALUES ($1, $2, $3)
    ON CONFLICT (token_hash)
    DO UPDATE SET last_seen_at = now()
    RETURNING id, tenant_id
  `, [id, tokenHash, configuredDefaultTenant()]);
  return { id: result.rows[0].id, tenantId: result.rows[0].tenant_id };
}
