import {
  MCP_OPS_ORIGIN,
  MCP_RESOURCE,
  MCP_SCOPE,
  mcpAuthorizationServerMetadataUrl,
  mcpProtectedResourceMetadataUrl
} from "./constants.ts";

export function buildProtectedResourceMetadata(origin = MCP_OPS_ORIGIN) {
  return {
    resource: MCP_RESOURCE,
    authorization_servers: [origin],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ["header"],
    resource_documentation: `${origin}/mcp/consent`
  };
}

export function buildAuthorizationServerMetadata(origin = MCP_OPS_ORIGIN) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/api/mcp/oauth/authorize`,
    token_endpoint: `${origin}/api/mcp/oauth/token`,
    registration_endpoint: `${origin}/api/mcp/oauth/register`,
    scopes_supported: [MCP_SCOPE],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true,
    revocation_endpoint_auth_methods_supported: ["none"],
    service_documentation: `${origin}/mcp/consent`
  };
}

export function wwwAuthenticateResourceMetadataHeader(origin = MCP_OPS_ORIGIN) {
  const resourceMetadata = mcpProtectedResourceMetadataUrl(origin);
  return `Bearer realm="DropX Ops MCP", resource_metadata="${resourceMetadata}"`;
}

export { mcpAuthorizationServerMetadataUrl, mcpProtectedResourceMetadataUrl };
