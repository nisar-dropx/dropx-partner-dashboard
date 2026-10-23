export type McpToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Fleet access page code(s); user needs access to any one. */
  pageCodes: string[];
};

const WRITE_NAME_PATTERN = /(write|create|update|delete|mutate|insert|upsert|patch|remove|approve|reject|submit|proof|bank)/i;

const stationCodesProp = {
  type: "array",
  items: { type: "string" },
  description: "Optional station codes; intersected with the caller's location scope."
};

export const MCP_READ_ONLY_TOOLS: McpToolDefinition[] = [
  {
    name: "fleet_list_permitted_stations",
    description: "List station codes the caller may query via Fleet MCP.",
    pageCodes: ["fleet_vehicle_view", "fleet_action_center"],
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "fleet_availability_snapshot",
    description: "Read-only fleet vehicle availability counts (operational, unavailable, document attention) for permitted stations.",
    pageCodes: ["fleet_action_center"],
    inputSchema: {
      type: "object",
      properties: { stationCodes: stationCodesProp }
    }
  },
  {
    name: "fleet_service_due_summary",
    description: "Read-only scheduled service due counts by station (no workshop invoices or vendor contact).",
    pageCodes: ["fleet_maintenance"],
    inputSchema: {
      type: "object",
      properties: { stationCodes: stationCodesProp }
    }
  },
  {
    name: "fleet_audit_risk_summary",
    description: "Read-only vehicle audit status and risk score aggregates (no evidence URLs or finding text).",
    pageCodes: ["fleet_audits"],
    inputSchema: {
      type: "object",
      properties: { stationCodes: stationCodesProp }
    }
  },
  {
    name: "fleet_payment_inbox_summary",
    description: "Read-only fleet payment inbox badge counts (no bank details, proofs, or request payloads).",
    pageCodes: ["payment_approvals", "expense_requests"],
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "fleet_attention_summary",
    description: "Read-only Action Center attention counts grouped by category (no vehicle-level detail rows).",
    pageCodes: ["fleet_action_center"],
    inputSchema: {
      type: "object",
      properties: { stationCodes: stationCodesProp }
    }
  },
  {
    name: "fleet_mapping_mail_summary",
    description: "Read-only Vehicle DA mapping mail configuration and today's pending-recipient counts (no email bodies).",
    pageCodes: ["fleet_settings"],
    inputSchema: { type: "object", properties: {} }
  }
];

export function isWriteLikeToolName(name: string) {
  return WRITE_NAME_PATTERN.test(name);
}

export function listMcpTools() {
  return MCP_READ_ONLY_TOOLS;
}

export function findMcpTool(name: string) {
  return MCP_READ_ONLY_TOOLS.find((tool) => tool.name === name) ?? null;
}

export function assertReadOnlyToolName(name: string) {
  if (isWriteLikeToolName(name) || !findMcpTool(name)) {
    const error = new Error(`Unknown or unsupported tool: ${name}`) as Error & { code: number };
    error.code = -32601;
    throw error;
  }
}

export type McpPermissionCheck = (pageCode: string) => boolean;

export function fleetMcpHasAnyToolAccess(canAccess: McpPermissionCheck) {
  return MCP_READ_ONLY_TOOLS.some((tool) => tool.pageCodes.some((code) => canAccess(code)));
}

/** Tools the caller may see in tools/list (any matching pageCode). */
export function listMcpToolsForAuth(canAccess: McpPermissionCheck): McpToolDefinition[] {
  if (!fleetMcpHasAnyToolAccess(canAccess)) return [];
  return MCP_READ_ONLY_TOOLS.filter((tool) => tool.pageCodes.some((code) => canAccess(code)));
}

export function toolToListEntry(tool: McpToolDefinition) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema
  };
}
