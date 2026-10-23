import { MCP_SCOPE } from "@/lib/mcp/constants";
import { normalizeRedirectUris } from "@/lib/mcp/redirect-uri";
import { registerMcpClient, upsertPublicClientDocument } from "@/lib/mcp/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid_client_metadata" }, { status: 400 });
  }

  const redirectUris = normalizeRedirectUris(body.redirect_uris);
  if (!redirectUris.length) {
    return Response.json(
      { error: "invalid_redirect_uri", error_description: "No allowed redirect_uris" },
      { status: 400 }
    );
  }

  const clientName = typeof body.client_name === "string" ? body.client_name : "Claude";
  const clientUri = typeof body.client_uri === "string" ? body.client_uri : null;
  const logoUri = typeof body.logo_uri === "string" ? body.logo_uri : null;
  const contacts = Array.isArray(body.contacts)
    ? body.contacts.map((item) => String(item)).filter(Boolean)
    : [];

  // CIMD: Claude may present a stable public client_id (URL) without a secret.
  const requestedClientId =
    typeof body.client_id === "string" && body.client_id.trim() ? body.client_id.trim() : null;

  try {
    const client = requestedClientId
      ? await upsertPublicClientDocument({
          clientId: requestedClientId,
          clientName,
          redirectUris
        })
      : await registerMcpClient({
          clientName,
          redirectUris,
          clientUri,
          logoUri,
          contacts
        });

    return Response.json(
      {
        client_id: client.client_id,
        client_name: client.client_name,
        redirect_uris: client.redirect_uris,
        grant_types: client.grant_types,
        response_types: client.response_types,
        token_endpoint_auth_method: "none",
        scope: MCP_SCOPE
      },
      {
        status: 201,
        headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" }
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "registration_failed";
    return Response.json({ error: "server_error", error_description: message }, { status: 500 });
  }
}
