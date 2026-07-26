export function attachmentDisposition(filename: string, fallback = "download") {
  const safe = filename.replace(/["\\\r\n]/g, "_");
  const extension = safe.match(/\.[a-z0-9]+$/i)?.[0] || "";
  const basename = extension ? safe.slice(0, -extension.length) : safe;
  const asciiBase = basename
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/[^a-z0-9._ -]/gi, "_")
    .replace(/_+/g, "_")
    .replace(/^[_ .-]+|[_ .-]+$/g, "");
  const ascii = `${asciiBase || fallback}${extension}`;
  const encoded = encodeURIComponent(safe).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
