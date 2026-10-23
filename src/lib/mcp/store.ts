import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  MCP_ACCESS_TTL_SECONDS,
  MCP_CODE_TTL_MS,
  MCP_REFRESH_TTL_SECONDS,
  MCP_RESOURCE,
  MCP_SCOPE
} from "@/lib/mcp/constants";
import { hashOpaqueToken, randomToken } from "@/lib/mcp/crypto";

export type McpOAuthClient = {
  client_id: string;
  client_name: string | null;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
  grant_types: string[];
  response_types: string[];
};

function requireAdmin() {
  if (!supabaseAdmin) throw new Error("Database unavailable.");
  return supabaseAdmin;
}

export async function registerMcpClient(input: {
  clientName?: string | null;
  redirectUris: string[];
  clientUri?: string | null;
  logoUri?: string | null;
  contacts?: string[];
}): Promise<McpOAuthClient> {
  const db = requireAdmin();
  const clientId = `mcp_${randomToken(12)}`;
  const row = {
    client_id: clientId,
    client_name: input.clientName?.trim() || "Claude",
    redirect_uris: input.redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    client_uri: input.clientUri ?? null,
    logo_uri: input.logoUri ?? null,
    contacts: input.contacts ?? []
  };
  const { error } = await db.from("mcp_oauth_clients").insert(row);
  if (error) throw new Error(error.message);
  return {
    client_id: row.client_id,
    client_name: row.client_name,
    redirect_uris: row.redirect_uris,
    token_endpoint_auth_method: row.token_endpoint_auth_method,
    grant_types: row.grant_types,
    response_types: row.response_types
  };
}

export async function getMcpClient(clientId: string): Promise<McpOAuthClient | null> {
  const db = requireAdmin();
  const { data, error } = await db
    .from("mcp_oauth_clients")
    .select("client_id,client_name,redirect_uris,token_endpoint_auth_method,grant_types,response_types")
    .eq("client_id", clientId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return {
    client_id: data.client_id,
    client_name: data.client_name,
    redirect_uris: data.redirect_uris ?? [],
    token_endpoint_auth_method: data.token_endpoint_auth_method,
    grant_types: data.grant_types ?? [],
    response_types: data.response_types ?? []
  };
}

export async function upsertPublicClientDocument(input: {
  clientId: string;
  clientName?: string | null;
  redirectUris: string[];
}): Promise<McpOAuthClient> {
  const existing = await getMcpClient(input.clientId);
  if (existing) {
    const merged = Array.from(new Set([...existing.redirect_uris, ...input.redirectUris]));
    const db = requireAdmin();
    const { error } = await db
      .from("mcp_oauth_clients")
      .update({
        redirect_uris: merged,
        client_name: input.clientName?.trim() || existing.client_name,
        updated_at: new Date().toISOString()
      })
      .eq("client_id", input.clientId);
    if (error) throw new Error(error.message);
    return { ...existing, redirect_uris: merged, client_name: input.clientName?.trim() || existing.client_name };
  }
  const db = requireAdmin();
  const row = {
    client_id: input.clientId,
    client_name: input.clientName?.trim() || "Claude",
    redirect_uris: input.redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"]
  };
  const { error } = await db.from("mcp_oauth_clients").insert(row);
  if (error) throw new Error(error.message);
  return {
    client_id: row.client_id,
    client_name: row.client_name,
    redirect_uris: row.redirect_uris,
    token_endpoint_auth_method: row.token_endpoint_auth_method,
    grant_types: row.grant_types,
    response_types: row.response_types
  };
}

export async function createAuthorizationCode(input: {
  clientId: string;
  userId: string;
  companyId: string | null;
  redirectUri: string;
  codeChallenge: string;
  scope?: string;
  resource?: string | null;
}): Promise<string> {
  const db = requireAdmin();
  const code = randomToken(32);
  const codeHash = hashOpaqueToken(code);
  const expiresAt = new Date(Date.now() + MCP_CODE_TTL_MS).toISOString();
  const { error } = await db.from("mcp_oauth_codes").insert({
    code_hash: codeHash,
    client_id: input.clientId,
    user_id: input.userId,
    company_id: input.companyId,
    redirect_uri: input.redirectUri,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
    scope: input.scope ?? MCP_SCOPE,
    resource: input.resource ?? MCP_RESOURCE,
    expires_at: expiresAt
  });
  if (error) throw new Error(error.message);
  return code;
}

export async function consumeAuthorizationCode(code: string): Promise<{
  clientId: string;
  userId: string;
  companyId: string | null;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource: string | null;
} | null> {
  const db = requireAdmin();
  const codeHash = hashOpaqueToken(code);
  const { data, error } = await db
    .from("mcp_oauth_codes")
    .select("client_id,user_id,company_id,redirect_uri,code_challenge,scope,resource,expires_at,used_at")
    .eq("code_hash", codeHash)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || data.used_at) return null;
  if (new Date(data.expires_at).getTime() <= Date.now()) return null;
  const { error: updateError } = await db
    .from("mcp_oauth_codes")
    .update({ used_at: new Date().toISOString() })
    .eq("code_hash", codeHash)
    .is("used_at", null);
  if (updateError) throw new Error(updateError.message);
  return {
    clientId: data.client_id,
    userId: data.user_id,
    companyId: data.company_id,
    redirectUri: data.redirect_uri,
    codeChallenge: data.code_challenge,
    scope: data.scope,
    resource: data.resource
  };
}

export async function issueTokenPair(input: {
  clientId: string;
  userId: string;
  companyId: string | null;
  scope?: string;
  resource?: string | null;
}): Promise<{ accessToken: string; refreshToken: string; expiresIn: number; scope: string }> {
  const db = requireAdmin();
  const accessToken = randomToken(32);
  const refreshToken = randomToken(32);
  const accessHash = hashOpaqueToken(accessToken);
  const refreshHash = hashOpaqueToken(refreshToken);
  const scope = input.scope ?? MCP_SCOPE;
  const resource = input.resource ?? MCP_RESOURCE;
  const now = Date.now();
  const rows = [
    {
      token_hash: accessHash,
      token_type: "access",
      client_id: input.clientId,
      user_id: input.userId,
      company_id: input.companyId,
      scope,
      resource,
      expires_at: new Date(now + MCP_ACCESS_TTL_SECONDS * 1000).toISOString(),
      refresh_of_hash: null
    },
    {
      token_hash: refreshHash,
      token_type: "refresh",
      client_id: input.clientId,
      user_id: input.userId,
      company_id: input.companyId,
      scope,
      resource,
      expires_at: new Date(now + MCP_REFRESH_TTL_SECONDS * 1000).toISOString(),
      refresh_of_hash: accessHash
    }
  ];
  const { error } = await db.from("mcp_oauth_tokens").insert(rows);
  if (error) throw new Error(error.message);
  return {
    accessToken,
    refreshToken,
    expiresIn: MCP_ACCESS_TTL_SECONDS,
    scope
  };
}

export async function resolveAccessToken(token: string): Promise<{
  userId: string;
  companyId: string | null;
  clientId: string;
  scope: string;
  resource: string | null;
} | null> {
  const db = requireAdmin();
  const tokenHash = hashOpaqueToken(token);
  const { data, error } = await db
    .from("mcp_oauth_tokens")
    .select("user_id,company_id,client_id,scope,resource,expires_at,revoked_at,token_type")
    .eq("token_hash", tokenHash)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || data.token_type !== "access" || data.revoked_at) return null;
  if (new Date(data.expires_at).getTime() <= Date.now()) return null;
  return {
    userId: data.user_id,
    companyId: data.company_id,
    clientId: data.client_id,
    scope: data.scope,
    resource: data.resource
  };
}

export async function consumeRefreshToken(refreshToken: string): Promise<{
  clientId: string;
  userId: string;
  companyId: string | null;
  scope: string;
  resource: string | null;
} | null> {
  const db = requireAdmin();
  const tokenHash = hashOpaqueToken(refreshToken);
  const { data, error } = await db
    .from("mcp_oauth_tokens")
    .select("client_id,user_id,company_id,scope,resource,expires_at,revoked_at,token_type")
    .eq("token_hash", tokenHash)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || data.token_type !== "refresh" || data.revoked_at) return null;
  if (new Date(data.expires_at).getTime() <= Date.now()) return null;
  await db
    .from("mcp_oauth_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("token_hash", tokenHash)
    .is("revoked_at", null);
  return {
    clientId: data.client_id,
    userId: data.user_id,
    companyId: data.company_id,
    scope: data.scope,
    resource: data.resource
  };
}
