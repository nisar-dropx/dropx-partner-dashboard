import { authorizeMcpRequest } from "@/lib/mcp/bearer";
import { mcpOriginFromHost } from "@/lib/mcp/constants";
import { wwwAuthenticateResourceMetadataHeader } from "@/lib/mcp/oauth-metadata";
import { handleMcpJsonRpc, type JsonRpcRequest } from "@/lib/mcp/protocol";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

function originFromRequest(request: Request) {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "";
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  return mcpOriginFromHost(host, proto);
}

function unauthorized(origin: string) {
  return new Response(JSON.stringify({ error: "unauthorized", error_description: "Bearer token required" }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": wwwAuthenticateResourceMetadataHeader(origin),
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "WWW-Authenticate"
    }
  });
}

function forbidden() {
  return Response.json(
    { error: "forbidden", error_description: "Fleet access required" },
    {
      status: 403,
      headers: { "Access-Control-Allow-Origin": "*" }
    }
  );
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version",
      "Access-Control-Expose-Headers": "WWW-Authenticate"
    }
  });
}

export async function GET(request: Request) {
  const origin = originFromRequest(request);
  const auth = await authorizeMcpRequest(request);
  if (!auth.ok) {
    if (auth.reason === "forbidden") return forbidden();
    return unauthorized(origin);
  }
  return Response.json(
    {
      name: "dropx-fleet-mcp",
      version: "1.0.0",
      transport: "http",
      resource: `${origin}/mcp`
    },
    { headers: { "Access-Control-Allow-Origin": "*" } }
  );
}

export async function POST(request: Request) {
  const origin = originFromRequest(request);
  const auth = await authorizeMcpRequest(request);
  if (!auth.ok) {
    if (auth.reason === "forbidden") return forbidden();
    return unauthorized(origin);
  }

  let body: JsonRpcRequest | JsonRpcRequest[];
  try {
    body = (await request.json()) as JsonRpcRequest | JsonRpcRequest[];
  } catch {
    return Response.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { status: 400, headers: { "Access-Control-Allow-Origin": "*" } }
    );
  }

  const result = await handleMcpJsonRpc(auth.authorization, body);
  return Response.json(result, {
    headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" }
  });
}
