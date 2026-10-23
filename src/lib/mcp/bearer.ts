import { loadAuthorizationForMcpUser, assertMcpScope, mcpUserHasFleetAccess } from "@/lib/mcp/authorization";
import { resolveAccessToken } from "@/lib/mcp/store";
import type { AuthorizationContext } from "@/lib/authorization";

export type McpBearerResult =
  | { ok: true; authorization: AuthorizationContext; scope: string }
  | { ok: false; reason: "missing" | "invalid" | "forbidden" };

export function extractBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? request.headers.get("Authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

export async function authorizeMcpRequest(request: Request): Promise<McpBearerResult> {
  const token = extractBearerToken(request);
  if (!token) return { ok: false, reason: "missing" };
  const resolved = await resolveAccessToken(token);
  if (!resolved || !assertMcpScope(resolved.scope)) return { ok: false, reason: "invalid" };
  const authorization = await loadAuthorizationForMcpUser(resolved.userId);
  if (!authorization || !mcpUserHasFleetAccess(authorization)) return { ok: false, reason: "forbidden" };
  if (resolved.companyId && authorization.companyId && resolved.companyId !== authorization.companyId) {
    return { ok: false, reason: "forbidden" };
  }
  return { ok: true, authorization, scope: resolved.scope };
}
