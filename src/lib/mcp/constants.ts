/** Ops Claude remote MCP — host-bound constants. */

export const MCP_OPS_ORIGIN = "https://ops.dropxlogistics.com";
export const MCP_RESOURCE = `${MCP_OPS_ORIGIN}/mcp`;
export const MCP_SCOPE = "ops_pulse.read";

export const MCP_CODE_TTL_MS = 5 * 60 * 1000;
export const MCP_ACCESS_TTL_SECONDS = 60 * 60;
export const MCP_REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Claude.ai + local connector loopback redirect URIs. */
export const MCP_ALLOWED_REDIRECT_URI_PREFIXES = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
  "http://127.0.0.1:",
  "http://localhost:",
  "http://[::1]:"
] as const;

export function mcpAuthorizationServerMetadataUrl(origin = MCP_OPS_ORIGIN) {
  return `${origin}/.well-known/oauth-authorization-server`;
}

export function mcpProtectedResourceMetadataUrl(origin = MCP_OPS_ORIGIN) {
  return `${origin}/.well-known/oauth-protected-resource`;
}
