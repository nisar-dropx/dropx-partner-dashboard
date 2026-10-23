import { NextRequest, NextResponse } from "next/server";
import { getAuthorization } from "@/lib/authorization";
import { mcpUserHasFleetAccess } from "@/lib/mcp/authorization";
import { MCP_RESOURCE, MCP_SCOPE } from "@/lib/mcp/constants";
import { isAllowedMcpRedirectUri } from "@/lib/mcp/redirect-uri";
import { createAuthorizationCode, getMcpClient, upsertPublicClientDocument } from "@/lib/mcp/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function oauthErrorRedirect(redirectUri: string, error: string, description: string, state: string | null) {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state) url.searchParams.set("state", state);
  return NextResponse.redirect(url);
}

/**
 * OAuth 2.1 authorization endpoint.
 * Unauthenticated users are sent to DropX login, then back here, then to consent.
 */
export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const clientId = String(url.searchParams.get("client_id") ?? "").trim();
  const redirectUri = String(url.searchParams.get("redirect_uri") ?? "").trim();
  const responseType = String(url.searchParams.get("response_type") ?? "").trim();
  const state = url.searchParams.get("state");
  const codeChallenge = String(url.searchParams.get("code_challenge") ?? "").trim();
  const codeChallengeMethod = String(url.searchParams.get("code_challenge_method") ?? "S256").trim();
  const scope = String(url.searchParams.get("scope") ?? MCP_SCOPE).trim() || MCP_SCOPE;
  const resource = String(url.searchParams.get("resource") ?? MCP_RESOURCE).trim() || MCP_RESOURCE;

  if (!clientId || !redirectUri) {
    return NextResponse.json({ error: "invalid_request", error_description: "client_id and redirect_uri required" }, { status: 400 });
  }
  if (!isAllowedMcpRedirectUri(redirectUri)) {
    return NextResponse.json({ error: "invalid_request", error_description: "redirect_uri not allowed" }, { status: 400 });
  }
  if (responseType !== "code") {
    return oauthErrorRedirect(redirectUri, "unsupported_response_type", "Only response_type=code is supported", state);
  }
  if (codeChallengeMethod !== "S256" || !codeChallenge) {
    return oauthErrorRedirect(redirectUri, "invalid_request", "PKCE S256 code_challenge required", state);
  }

  let client = await getMcpClient(clientId);
  if (!client) {
    // CIMD public client id (URL or stable id) — register on first authorize.
    try {
      client = await upsertPublicClientDocument({
        clientId,
        clientName: "Claude",
        redirectUris: [redirectUri]
      });
    } catch {
      return oauthErrorRedirect(redirectUri, "unauthorized_client", "Unknown client_id", state);
    }
  }
  if (!client.redirect_uris.includes(redirectUri)) {
    try {
      client = await upsertPublicClientDocument({
        clientId: client.client_id,
        clientName: client.client_name,
        redirectUris: [redirectUri]
      });
    } catch {
      return oauthErrorRedirect(redirectUri, "invalid_request", "redirect_uri not registered", state);
    }
  }

  const authorization = await getAuthorization();
  if (!authorization) {
    const login = new URL("/login", request.url);
    const next = `/api/mcp/oauth/authorize?${url.searchParams.toString()}`;
    login.searchParams.set("next", next);
    return NextResponse.redirect(login);
  }
  if (!mcpUserHasFleetAccess(authorization)) {
    return oauthErrorRedirect(redirectUri, "access_denied", "Fleet access required", state);
  }

  const consent = new URL("/mcp/consent", request.url);
  consent.searchParams.set("client_id", clientId);
  consent.searchParams.set("redirect_uri", redirectUri);
  consent.searchParams.set("code_challenge", codeChallenge);
  consent.searchParams.set("code_challenge_method", "S256");
  consent.searchParams.set("scope", scope);
  consent.searchParams.set("resource", resource);
  if (state) consent.searchParams.set("state", state);
  return NextResponse.redirect(consent);
}

export async function POST(request: NextRequest) {
  const form = await request.formData().catch(() => null);
  if (!form) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const decision = String(form.get("decision") ?? "");
  const clientId = String(form.get("client_id") ?? "").trim();
  const redirectUri = String(form.get("redirect_uri") ?? "").trim();
  const codeChallenge = String(form.get("code_challenge") ?? "").trim();
  const state = form.get("state") ? String(form.get("state")) : null;
  const scope = String(form.get("scope") ?? MCP_SCOPE).trim() || MCP_SCOPE;
  const resource = String(form.get("resource") ?? MCP_RESOURCE).trim() || MCP_RESOURCE;

  if (!clientId || !redirectUri || !isAllowedMcpRedirectUri(redirectUri)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  if (decision !== "allow") {
    return oauthErrorRedirect(redirectUri, "access_denied", "User denied consent", state);
  }

  const authorization = await getAuthorization();
  if (!authorization || !mcpUserHasFleetAccess(authorization)) {
    const login = new URL("/login", request.url);
    login.searchParams.set("next", "/mcp/consent");
    return NextResponse.redirect(login);
  }

  const client = await getMcpClient(clientId);
  if (!client || !client.redirect_uris.includes(redirectUri)) {
    return oauthErrorRedirect(redirectUri, "unauthorized_client", "Unknown client", state);
  }
  if (!codeChallenge) {
    return oauthErrorRedirect(redirectUri, "invalid_request", "code_challenge required", state);
  }

  try {
    const code = await createAuthorizationCode({
      clientId,
      userId: authorization.userId,
      companyId: authorization.companyId,
      redirectUri,
      codeChallenge,
      scope,
      resource
    });
    const target = new URL(redirectUri);
    target.searchParams.set("code", code);
    if (state) target.searchParams.set("state", state);
    return NextResponse.redirect(target);
  } catch (error) {
    const message = error instanceof Error ? error.message : "server_error";
    return oauthErrorRedirect(redirectUri, "server_error", message, state);
  }
}
