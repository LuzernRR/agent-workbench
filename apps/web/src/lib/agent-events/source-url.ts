/**
 * Validate an externally supplied source URL without accepting embedded
 * credentials. The returned href remains suitable for navigation.
 */
export function safeSourceUrl(value: unknown) {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "";
    return url.href;
  } catch {
    return "";
  }
}

/**
 * Build a stable identity for the same public page when a fetcher reports the
 * canonical spelling with a trailing slash while discovery omitted it.
 * Query parameters remain intact because they can identify different pages.
 */
export function sourceUrlIdentity(value: unknown) {
  const href = safeSourceUrl(value);
  if (!href) return "";
  const url = new URL(href);
  url.hash = "";
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.href;
}
