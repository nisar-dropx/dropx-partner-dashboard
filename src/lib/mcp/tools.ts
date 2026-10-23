import { hasPermission, type AuthorizationContext } from "@/lib/authorization";
import { mcpUserHasFleetAccess } from "@/lib/mcp/authorization";
import { parseStationCodes } from "@/lib/mcp/dates";
import { resolveScopedLocations } from "@/lib/mcp/scope";
import {
  assertReadOnlyToolName,
  findMcpTool,
  listMcpTools,
  listMcpToolsForAuth,
  isWriteLikeToolName,
  type McpToolDefinition
} from "@/lib/mcp/tools-policy";
import * as summaries from "@/lib/mcp/summaries";

export type { McpToolDefinition };
export { isWriteLikeToolName, listMcpTools, listMcpToolsForAuth };

function requireToolPages(authorization: AuthorizationContext, pageCodes: string[]) {
  if (!pageCodes.some((code) => hasPermission(authorization, code, "access"))) {
    throw Object.assign(new Error(`Permission denied for ${pageCodes.join(" / ")}.`), { code: -32003 });
  }
}

export function mcpToolsVisibleTo(authorization: AuthorizationContext) {
  return listMcpToolsForAuth((pageCode) => hasPermission(authorization, pageCode, "access"));
}

export async function callMcpTool(
  authorization: AuthorizationContext,
  name: string,
  args: Record<string, unknown> = {}
): Promise<unknown> {
  assertReadOnlyToolName(name);
  const tool = findMcpTool(name);
  if (!tool) throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32601 });
  if (!mcpUserHasFleetAccess(authorization)) {
    throw Object.assign(new Error("Permission denied for Fleet MCP."), { code: -32003 });
  }
  requireToolPages(authorization, tool.pageCodes);

  const requested = parseStationCodes(args.stationCodes ?? args.station_codes);

  switch (name) {
    case "fleet_list_permitted_stations": {
      const { locations, companyId } = await resolveScopedLocations(authorization, []);
      return {
        asOf: summaries.indiaDate(),
        companyId,
        missing: [],
        rows: locations.map((row) => ({
          stationCode: row.station_code,
          name: row.station_name,
          city: row.city,
          region: row.region,
          cluster: row.cluster
        }))
      };
    }
    case "fleet_availability_snapshot":
      return summaries.summarizeFleetAvailability(authorization, requested);
    case "fleet_service_due_summary":
      return summaries.summarizeFleetServiceDue(authorization, requested);
    case "fleet_audit_risk_summary":
      return summaries.summarizeFleetAuditRisk(authorization, requested);
    case "fleet_payment_inbox_summary":
      return summaries.summarizeFleetPaymentInbox(authorization);
    case "fleet_attention_summary":
      return summaries.summarizeFleetAttention(authorization, requested);
    case "fleet_mapping_mail_summary":
      return summaries.summarizeFleetMappingMail(authorization);
    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32601 });
  }
}
