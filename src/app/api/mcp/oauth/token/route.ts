import { MCP_RESOURCE } from "@/lib/mcp/constants";
import { verifyPkceS256 } from "@/lib/mcp/crypto";
import {
  consumeAuthorizationCode,
  consumeRefreshToken,
  getMcpClient,
  issueTokenPair
} from "@/lib/mcp/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function formValue(body: URLSearchParams, key: string) {
  return String(body.get(key) ?? "").trim();
}

function tokenError(error: string, description: string, status = 400) {
  return Response.json(
    { error, error_description: description },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*"
      }
    }
  );
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    }
  });
}

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  let params: URLSearchParams;
  try {
    if (contentType.includes("application/json")) {
      const json = (await request.json()) as Record<string, unknown>;
      params = new URLSearchParams();
      for (const [key, value] of Object.entries(json)) {
        if (value != null) params.set(key, String(value));
      }
    } else {
      params = new URLSearchParams(await request.text());
    }
  } catch {
    return tokenError("invalid_request", "Unable to parse token request");
  }

  const grantType = formValue(params, "grant_type");
  const clientId = formValue(params, "client_id");

  if (!clientId) return tokenError("invalid_client", "client_id required", 401);
  const client = await getMcpClient(clientId);
  if (!client) return tokenError("invalid_client", "Unknown client_id", 401);

  if (grantType === "authorization_code") {
    const code = formValue(params, "code");
    const redirectUri = formValue(params, "redirect_uri");
    const codeVerifier = formValue(params, "code_verifier");
    if (!code || !redirectUri || !codeVerifier) {
      return tokenError("invalid_request", "code, redirect_uri, and code_verifier required");
    }

    const consumed = await consumeAuthorizationCode(code);
    if (!consumed) return tokenError("invalid_grant", "Invalid or expired authorization code");
    if (consumed.clientId !== clientId) return tokenError("invalid_grant", "client_id mismatch");
    if (consumed.redirectUri !== redirectUri) return tokenError("invalid_grant", "redirect_uri mismatch");
    if (!verifyPkceS256(codeVerifier, consumed.codeChallenge)) {
      return tokenError("invalid_grant", "PKCE verification failed");
    }
    if (consumed.resource && consumed.resource !== MCP_RESOURCE && formValue(params, "resource") && formValue(params, "resource") !== consumed.resource) {
      return tokenError("invalid_target", "resource mismatch");
    }

    const tokens = await issueTokenPair({
      clientId,
      userId: consumed.userId,
      companyId: consumed.companyId,
      scope: consumed.scope,
      resource: consumed.resource
    });

    return Response.json(
      {
        access_token: tokens.accessToken,
        token_type: "Bearer",
        expires_in: tokens.expiresIn,
        refresh_token: tokens.refreshToken,
        scope: tokens.scope
      },
      {
        headers: {
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*"
        }
      }
    );
  }

  if (grantType === "refresh_token") {
    const refreshToken = formValue(params, "refresh_token");
    if (!refreshToken) return tokenError("invalid_request", "refresh_token required");
    const consumed = await consumeRefreshToken(refreshToken);
    if (!consumed) return tokenError("invalid_grant", "Invalid or expired refresh_token");
    if (consumed.clientId !== clientId) return tokenError("invalid_grant", "client_id mismatch");

    const tokens = await issueTokenPair({
      clientId,
      userId: consumed.userId,
      companyId: consumed.companyId,
      scope: consumed.scope,
      resource: consumed.resource
    });

    return Response.json(
      {
        access_token: tokens.accessToken,
        token_type: "Bearer",
        expires_in: tokens.expiresIn,
        refresh_token: tokens.refreshToken,
        scope: tokens.scope
      },
      {
        headers: {
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*"
        }
      }
    );
  }

  return tokenError("unsupported_grant_type", "Only authorization_code and refresh_token are supported");
}
