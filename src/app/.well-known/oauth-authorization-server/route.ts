import { buildAuthorizationServerMetadata } from "@/lib/mcp/oauth-metadata";
import { MCP_OPS_ORIGIN } from "@/lib/mcp/constants";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function originFromRequest(request: Request) {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "";
  if (host.toLowerCase().startsWith("ops.") || host.toLowerCase().startsWith("ops-")) {
    const proto = request.headers.get("x-forwarded-proto") ?? "https";
    return `${proto}://${host.split(":")[0]}`;
  }
  return MCP_OPS_ORIGIN;
}

export async function GET(request: Request) {
  const origin = originFromRequest(request);
  return Response.json(buildAuthorizationServerMetadata(origin), {
    headers: {
      "Cache-Control": "public, max-age=60",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type"
    }
  });
}
