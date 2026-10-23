export type McpToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Ops access page code(s); user needs access to any one. */
  pageCodes: string[];
};

const WRITE_NAME_PATTERN = /(write|create|update|delete|mutate|insert|upsert|patch|remove|approve|reject|submit)/i;

const stationCodesProp = {
  type: "array",
  items: { type: "string" },
  description: "Optional station codes; intersected with the caller's location scope."
};

const dateRangeProps = {
  from: { type: "string", description: "ISO start date YYYY-MM-DD" },
  to: { type: "string", description: "ISO end date YYYY-MM-DD" },
  stationCodes: stationCodesProp
};

export const MCP_READ_ONLY_TOOLS: McpToolDefinition[] = [
  {
    name: "ops_list_permitted_stations",
    description: "List station codes the caller may query via MCP.",
    pageCodes: ["ops_pulse"],
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "ops_command_center",
    description: "Read-only Command Center summary (CPS/performance/reviews/loss recovery) for permitted stations.",
    pageCodes: ["ops_pulse"],
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string" },
        to: { type: "string" },
        stationCodes: stationCodesProp
      }
    }
  },
  {
    name: "ops_capacity_snapshot",
    description: "Read-only Capacity SPR / headcount snapshot for permitted Amazon EDSP/XPT stations.",
    pageCodes: ["capacity"],
    inputSchema: {
      type: "object",
      properties: {
        asOf: { type: "string", description: "ISO date YYYY-MM-DD. Defaults to yesterday." },
        stationCodes: stationCodesProp
      }
    }
  },
  {
    name: "ops_station_delivery_summary",
    description: "Read-only delivery / SPR / attendance summary by station for a date range.",
    pageCodes: ["ops_pulse"],
    inputSchema: { type: "object", properties: dateRangeProps, required: ["from", "to"] }
  },
  {
    name: "ops_cod_summary",
    description: "Read-only COD submission totals (pending/deposited/validated) for permitted stations.",
    pageCodes: ["cod"],
    inputSchema: { type: "object", properties: dateRangeProps, required: ["from", "to"] }
  },
  {
    name: "ops_cod_ageing",
    description: "Read-only COD ageing bands by station (no associate line detail).",
    pageCodes: ["cod_reports"],
    inputSchema: {
      type: "object",
      properties: {
        asOf: { type: "string", description: "Upload/report date YYYY-MM-DD. Defaults to today." },
        stationCodes: stationCodesProp
      }
    }
  },
  {
    name: "ops_cod_status",
    description: "List COD status-eligible Amazon EDSP/XPT/AMXL stations in the caller's scope.",
    pageCodes: ["cod_reports"],
    inputSchema: { type: "object", properties: { stationCodes: stationCodesProp } }
  },
  {
    name: "ops_loss_case_summary",
    description: "Read-only NL/SLP loss case counts and amounts by station.",
    pageCodes: ["ops_losses"],
    inputSchema: {
      type: "object",
      properties: {
        period: { type: "string", description: "Optional loss period label (e.g. 2026-10)" },
        stationCodes: stationCodesProp
      }
    }
  },
  {
    name: "ops_loss_recovery_summary",
    description: "Read-only loss recovery command summary (awaiting station/cluster/SLP, due, overdue).",
    pageCodes: ["ops_losses"],
    inputSchema: { type: "object", properties: { stationCodes: stationCodesProp } }
  },
  {
    name: "ops_review_status",
    description: "Read-only performance review status counts by station/status for a date range.",
    pageCodes: ["performance_review_status"],
    inputSchema: { type: "object", properties: dateRangeProps, required: ["from", "to"] }
  },
  {
    name: "ops_performance_snapshot",
    description: "Read-only Hawkeye daily performance fact counts for permitted stations on a report date.",
    pageCodes: ["performance"],
    inputSchema: {
      type: "object",
      properties: {
        asOf: { type: "string", description: "Report date YYYY-MM-DD. Defaults to yesterday." },
        stationCodes: stationCodesProp
      }
    }
  },
  {
    name: "ops_edd_network_summary",
    description: "Read-only EDD / delivery-performance network summary for permitted stations.",
    pageCodes: ["edd_dashboard"],
    inputSchema: { type: "object", properties: { stationCodes: stationCodesProp } }
  },
  {
    name: "ops_cps_snapshot",
    description: "Read-only CPS station-day cost summary (no associate pay lines).",
    pageCodes: ["cps_overview"],
    inputSchema: { type: "object", properties: dateRangeProps, required: ["from", "to"] }
  },
  {
    name: "ops_cpu_snapshot",
    description: "Read-only Dark Store CPU summary for NOW-model stations in scope.",
    pageCodes: ["cpu_overview"],
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string" },
        to: { type: "string" },
        stationCodes: stationCodesProp
      }
    }
  },
  {
    name: "ops_station_audit_summary",
    description: "Read-only LM station audit status counts (no findings text).",
    pageCodes: ["station_audits"],
    inputSchema: { type: "object", properties: dateRangeProps, required: ["from", "to"] }
  },
  {
    name: "ops_store_audit_summary",
    description: "Read-only store audit status/score counts (no proofs or findings).",
    pageCodes: ["store_audits"],
    inputSchema: { type: "object", properties: dateRangeProps, required: ["from", "to"] }
  },
  {
    name: "ops_si_handover_summary",
    description: "Read-only SI handover checklist status counts by station.",
    pageCodes: ["si_handover"],
    inputSchema: { type: "object", properties: dateRangeProps, required: ["from", "to"] }
  },
  {
    name: "ops_store_ops_summary",
    description: "Read-only store ops checklist status counts by station.",
    pageCodes: ["store_ops"],
    inputSchema: { type: "object", properties: dateRangeProps, required: ["from", "to"] }
  },
  {
    name: "ops_roster_summary",
    description: "Read-only rostering capabilities and pending approval counts for the caller.",
    pageCodes: ["ops_rostering"],
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "ops_attendance_headcount",
    description: "Read-only attendance headcount by station/status (no names or biometric IDs).",
    pageCodes: ["ops_rostering"],
    inputSchema: {
      type: "object",
      properties: {
        asOf: { type: "string", description: "Punch date YYYY-MM-DD. Defaults to today." },
        stationCodes: stationCodesProp
      }
    }
  },
  {
    name: "ops_fleet_daily_report",
    description: "Read-only fleet daily KM/fuel summary by vehicle for permitted stations.",
    pageCodes: ["fleet_reports", "fleet"],
    inputSchema: { type: "object", properties: dateRangeProps, required: ["from", "to"] }
  },
  {
    name: "ops_payment_inbox_summary",
    description: "Read-only payment inbox badge counts (no bank details or request payloads).",
    pageCodes: ["ops_workforce_payouts", "payments", "payment_approvals", "payment_requests"],
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "ops_unplanned_leaves_summary",
    description: "Read-only unplanned leave counts by station (no person names).",
    pageCodes: ["ops_unplanned_leaves"],
    inputSchema: {
      type: "object",
      properties: {
        asOf: { type: "string", description: "Attendance date YYYY-MM-DD. Defaults to yesterday." }
      }
    }
  },
  {
    name: "ops_report_catalog",
    description: "List Ops report catalog entries the caller may generate (names/descriptions only).",
    pageCodes: ["ops_reports"],
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

/** Tools the caller may see in tools/list (any matching pageCode). Always requires ops_pulse. */
export function listMcpToolsForAuth(canAccess: McpPermissionCheck): McpToolDefinition[] {
  if (!canAccess("ops_pulse")) return [];
  return MCP_READ_ONLY_TOOLS.filter((tool) => tool.pageCodes.some((code) => canAccess(code)));
}

export function toolToListEntry(tool: McpToolDefinition) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema
  };
}
