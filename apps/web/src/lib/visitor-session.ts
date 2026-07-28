export const VISITOR_COOKIE = "workbench_visitor";

const TOKEN_PATTERN = /^wbv_[A-Za-z0-9_-]{43}$/u;

export function createVisitorToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const binary = Array.from(bytes, (value) => String.fromCharCode(value)).join("");
  return `wbv_${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")}`;
}

export function isVisitorToken(value: string | null | undefined): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}
