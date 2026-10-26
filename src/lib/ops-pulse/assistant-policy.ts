import { MCP_READ_ONLY_TOOLS, type McpToolDefinition } from "../mcp/tools-policy.ts";
import { parseIsoDate } from "../mcp/dates.ts";
const stationCodes = { type: "array", items: { type: "string" } };
export const ASSISTANT_EXTRA_TOOLS: McpToolDefinition[] = [
  { name: "ops_attendance_analysis", description: "Person-level attendance and punctuality trends, best attendance, reliable pickers, late arrivals and confirmed absences over a date range. Uses People punches, approved shifts, leave and holidays. Returns rankings with sample sizes and unresolved records. Use for comparisons and trends, not only today's shift snapshot.", pageCodes: ["ops_rostering"], inputSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, stationCodes, role: { type: "string", description: "Optional designation filter, e.g. Picker. Omit for all roles." }, person: { type: "string", description: "Optional person name or employee code." } } } },
  { name: "ops_store_health_analysis", description: "Dark Store Store Health scores, metric details and review actions over a period. Use for operational performance, what improved, what went wrong, and recommendations. Scores are usually published D-2; missing dates are not zero.", pageCodes: ["performance_review"], inputSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, stationCodes } } },
  { name: "ops_shift_status", description: "Current or historical shift attendance from approved rosters and People punches: working, upcoming, late, missing, leave and off. Works in Last Mile and Dark Store; use for shift or attendance questions, not SPR.", pageCodes: ["ops_rostering"], inputSchema: { type: "object", properties: { asOf: { type: "string", description: "ISO date; defaults to today in India." }, stationCodes } } },
  { name: "ops_business_documents", description: "Business document names, scope, expiry and status in this workspace. Does not read file contents.", pageCodes: ["business_documents"], inputSchema: { type: "object", properties: { stationCodes } } }
];
export function assistantCatalog(can: (code: string) => boolean, darkStore: boolean) {
  const lmOnly = new Set(["ops_capacity_snapshot", "ops_station_delivery_summary", "ops_cod_summary", "ops_cod_ageing", "ops_cod_status", "ops_loss_case_summary", "ops_loss_recovery_summary", "ops_review_status", "ops_performance_snapshot", "ops_edd_network_summary", "ops_cps_snapshot", "ops_station_audit_summary", "ops_command_center"]);
  const dsOnly = new Set(["ops_store_health_analysis", "ops_cpu_snapshot", "ops_store_audit_summary", "ops_si_handover_summary", "ops_store_ops_summary"]);
  return [...MCP_READ_ONLY_TOOLS, ...ASSISTANT_EXTRA_TOOLS].filter(t => can("ops_pulse") && t.pageCodes.some(can)
    && !(darkStore ? lmOnly : dsOnly).has(t.name) && t.name !== "ops_attendance_headcount").map(t => t.name === "ops_cod_status" ? { ...t, description: "Current COD worker snapshot: DA reconciliation, prepared deposit and submitted remittance amounts, variance and source freshness. Up to five selected stations; historical questions use COD reports or ageing." } : t);
}
/** Offline routing is explicit. Unknown questions never silently become SPR. */
export function suggestedTools(question: string, darkStore: boolean) {
  const q = question.toLowerCase();
  if (/punctual|reliab|best.*picker|good.*attendance|attendance.*(good|best|trend|rank|compar)|late.*(repeat|trend)|absen|attendance.*(week|month|days)/.test(q)) return ["ops_attendance_analysis"];
  if (/shift|attendance|punch|who.*(working|present)|reported|roster.*(status|today)/.test(q)) return ["ops_shift_status"];
  if (/document|licen[cs]e|fssai|\bgst\b|expir/.test(q)) return ["ops_business_documents"];
  if (/audit/.test(q)) return [darkStore ? "ops_store_audit_summary" : "ops_station_audit_summary"];
  if (/handover|\bsi\b/.test(q)) return ["ops_si_handover_summary"];
  if (/checklist|store.*(operation|report)|opening|closing/.test(q)) return ["ops_store_ops_summary"];
  if (/\bcpu\b|cost per unit/.test(q)) return ["ops_cpu_snapshot"];
  if (/\bcps\b|cost per shipment/.test(q)) return ["ops_cps_snapshot"];
  if (/\bcod\b|remittance|deposit|cash/.test(q)) return [/ag(e|ei)ng/.test(q) ? "ops_cod_ageing" : "ops_cod_status"];
  if (/loss|recover|\bnl\b|\bslp\b/.test(q)) return ["ops_loss_case_summary", "ops_loss_recovery_summary"];
  if (/payment|approval|payout/.test(q)) return ["ops_payment_inbox_summary"];
  if (/roster/.test(q)) return ["ops_roster_summary"];
  if (/leave/.test(q)) return ["ops_unplanned_leaves_summary"];
  if (/fleet|vehicle|fuel|kilomet/.test(q)) return ["ops_fleet_daily_report"];
  if (/capacity|\bspr\b|headcount|hiring|external da/.test(q)) return ["ops_capacity_snapshot"];
  if (/review/.test(q)) return [darkStore ? "ops_store_health_analysis" : "ops_review_status"];
  if (/edd|pending delivery/.test(q)) return ["ops_edd_network_summary"];
  if (/performance|hawkeye|store health|scorecard|what.*(wrong|good|improv)/.test(q)) return [darkStore ? "ops_store_health_analysis" : "ops_performance_snapshot"];
  if (/delivery|delivered|shipment|volume/.test(q)) return ["ops_station_delivery_summary"];
  if (/report/.test(q)) return ["ops_report_catalog"];
  if (/overview|priority|attention|summary/.test(q)) return [darkStore ? "ops_store_ops_summary" : "ops_command_center"];
  return [];
}
export function checkedArguments(args: Record<string, unknown>, allowed: string[], defaults: { from: string; to: string; asOf: string }) {
  const raw = args.stationCodes;
  if (raw != null && !Array.isArray(raw)) throw Error("Choose station codes from the current scope.");
  const requested = raw == null ? [] : (raw as unknown[]).map(v => String(v).toUpperCase());
  if (requested.some(code => !allowed.includes(code))) throw Error("That location is outside the selected workspace. Change your scope to query it.");
  const dates = { ...defaults };
  for (const key of ["from", "to", "asOf"] as const) if (args[key] != null) {
    const parsed = parseIsoDate(args[key]);
    if (!parsed) throw Error("Use valid dates in YYYY-MM-DD format.");
    dates[key] = parsed;
  }
  if (dates.from > dates.to || (Date.parse(dates.to) - Date.parse(dates.from)) / 86400000 > 92) throw Error("Choose a date range of 93 days or fewer.");
  return { ...args, ...dates, stationCodes: requested.length ? [...new Set(requested)] : allowed };
}
export function assistantDates(question: string, today: string) {
  const ago = (days: number) => new Date(Date.parse(today) - days * 86400000).toISOString().slice(0, 10);
  const dates = question.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? [];
  const valid = dates.filter(d => parseIsoDate(d));
  if (valid.length !== dates.length) throw Error("One of those dates is invalid.");
  if (valid.length) return { from: valid[0], to: valid[1] || valid[0], asOf: valid[1] || valid[0] };
  if (/yesterday/i.test(question)) return { from: ago(1), to: ago(1), asOf: ago(1) };
  const lastDays = question.match(/last (\d{1,2}) days/i);
  if (lastDays && Number(lastDays[1]) > 0) return { from: ago(Number(lastDays[1]) - 1), to: today, asOf: today };
  if (/last month/i.test(question)) { const end = new Date(Date.parse(today.slice(0, 8) + "01") - 86400000).toISOString().slice(0, 10); return { from: end.slice(0, 8) + "01", to: end, asOf: end }; }
  if (/last (7|seven) days|week/i.test(question)) return { from: ago(6), to: today, asOf: today };
  if (/today|current|now/i.test(question)) return { from: today, to: today, asOf: today };
  return { from: today.slice(0, 8) + "01", to: today, asOf: today };
}
const sourcePages: Record<string, [string, string]> = {
  ops_attendance_analysis: ["Attendance & punctuality", "/performance?view=reviews"], ops_store_health_analysis: ["Store Health & review actions", "/performance?view=reviews"],
  ops_shift_status: ["Shift Attendance", "/ops-pulse?view=manpower"], ops_business_documents: ["Business Documents", "/business-documents"],
  ops_capacity_snapshot: ["Capacity", "/capacity"], ops_cps_snapshot: ["CPS", "/cps"], ops_cpu_snapshot: ["CPU", "/cpu"],
  ops_store_audit_summary: ["Store Audits", "/store-audits"], ops_station_audit_summary: ["Station Audits", "/audits"],
  ops_cod_status: ["COD Status", "/cod/status"], ops_cod_summary: ["COD submissions", "/cod/submission"], ops_cod_ageing: ["COD Reports", "/cod/reports"],
  ops_payment_inbox_summary: ["Your payment inbox", "/payments/approvals"], ops_roster_summary: ["Rostering", "/rostering"],
  ops_loss_case_summary: ["Loss cases", "/team-ops/losses/nl"], ops_loss_recovery_summary: ["Loss recovery", "/team-ops/losses/nl"],
  ops_fleet_daily_report: ["Fleet reports", "/fleet/reports"], ops_report_catalog: ["Reports", "/reports"],
};
export function assistantSource(name: string) {
  const [label, href] = sourcePages[name] || [name.replace(/^ops_/, "").replaceAll("_", " "), "/ops-pulse"];
  return { label, href };
}
