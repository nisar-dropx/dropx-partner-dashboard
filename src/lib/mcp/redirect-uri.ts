import { MCP_ALLOWED_REDIRECT_URI_PREFIXES } from "./constants.ts";

export function isAllowedMcpRedirectUri(uri: string): boolean {
  const value = String(uri ?? "").trim();
  if (!value) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) return false;
  if (parsed.protocol === "https:") {
    return MCP_ALLOWED_REDIRECT_URI_PREFIXES.some(
      (prefix) => prefix.startsWith("https:") && value.startsWith(prefix)
    );
  }
  if (parsed.protocol === "http:") {
    const host = parsed.hostname.toLowerCase();
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]" && host !== "::1") {
      return false;
    }
    return true;
  }
  return false;
}

export function normalizeRedirectUris(uris: unknown): string[] {
  if (!Array.isArray(uris)) return [];
  const out: string[] = [];
  for (const item of uris) {
    const value = String(item ?? "").trim();
    if (!value || !isAllowedMcpRedirectUri(value)) continue;
    if (!out.includes(value)) out.push(value);
  }
  return out;
}
