export type McpToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

const WRITE_NAME_PATTERN = /(write|create|update|delete|mutate|insert|upsert|patch|remove|approve|reject|submit)/i;

export const MCP_READ_ONLY_TOOLS: McpToolDefinition[] = [
  {
    name: "ops_capacity_snapshot",
    description: "Read-only Capacity SPR / headcount snapshot for permitted Amazon EDSP/XPT stations.",
    inputSchema: {
      type: "object",
      properties: {
        asOf: { type: "string", description: "ISO date YYYY-MM-DD (Asia/Kolkata reporting day). Defaults to yesterday." },
        stationCodes: {
          type: "array",
          items: { type: "string" },
          description: "Optional station codes; intersected with the caller's location scope."
        }
      }
    }
  },
  {
    name: "ops_station_delivery_summary",
    description: "Read-only delivery / SPR / attendance summary by station for a date range.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "ISO start date YYYY-MM-DD" },
        to: { type: "string", description: "ISO end date YYYY-MM-DD" },
        stationCodes: { type: "array", items: { type: "string" } }
      },
      required: ["from", "to"]
    }
  },
  {
    name: "ops_cod_summary",
    description: "Read-only COD submission totals (pending/deposited/validated) for permitted stations.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string" },
        to: { type: "string" },
        stationCodes: { type: "array", items: { type: "string" } }
      },
      required: ["from", "to"]
    }
  },
  {
    name: "ops_loss_case_summary",
    description: "Read-only NL/SLP loss case counts and amounts by station (scoped).",
    inputSchema: {
      type: "object",
      properties: {
        period: { type: "string", description: "Optional loss period label (e.g. 2026-10)" },
        stationCodes: { type: "array", items: { type: "string" } }
      }
    }
  },
  {
    name: "ops_list_permitted_stations",
    description: "List station codes the caller may query via MCP.",
    inputSchema: { type: "object", properties: {} }
  }
];

export function isWriteLikeToolName(name: string) {
  return WRITE_NAME_PATTERN.test(name);
}

export function listMcpTools() {
  return MCP_READ_ONLY_TOOLS;
}

export function assertReadOnlyToolName(name: string) {
  if (isWriteLikeToolName(name) || !MCP_READ_ONLY_TOOLS.some((tool) => tool.name === name)) {
    const error = new Error(`Unknown or unsupported tool: ${name}`) as Error & { code: number };
    error.code = -32601;
    throw error;
  }
}
