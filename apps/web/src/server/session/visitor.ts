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

export async function resolveVisitor(request: Request) {
  const token = cookieValue(request, VISITOR_COOKIE);
  if (!isVisitorToken(token)) throw new VisitorSessionError();
  const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");
  const id = randomUUID();
  const result = await query<{ id: string }>(`
    INSERT INTO wb_visitors (id, token_hash)
    VALUES ($1, $2)
    ON CONFLICT (token_hash)
    DO UPDATE SET last_seen_at = now()
    RETURNING id
  `, [id, tokenHash]);
  return { id: result.rows[0].id };
}
