import type { AuthorizationContext } from "@/lib/authorization";
import { loadFleetControlData } from "@/lib/fleet-control";
import { fleetAttention } from "@/lib/fleet/attention";
import { loadMappingMailConfig, mappingMailSnapshot } from "@/lib/fleet/mapping-mail-server";
import { mappingMailClock } from "@/lib/fleet/mapping-mail";
import { indiaDate, parseStationCodes } from "@/lib/mcp/dates";
import { resolveScopedLocations } from "@/lib/mcp/scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

function stationFilter(codes: Set<string>, stationCode: string) {
  if (!codes.size) return true;
  return codes.has(stationCode.toUpperCase());
}

export async function summarizeFleetAvailability(
  authorization: AuthorizationContext,
  requested: string[]
) {
  const { locations, missing, companyId } = await resolveScopedLocations(authorization, requested);
  const allowed = new Set(locations.map((row) => row.station_code.toUpperCase()));
  const data = await loadFleetControlData(companyId, authorization);
  const vehicles = data.vehicles.filter((vehicle) => stationFilter(allowed, vehicle.stationCode));
  const operational = vehicles.filter((vehicle) => data.vehicleStatuses?.find((s) => s.key === vehicle.status)?.isOperational ?? vehicle.status === "active").length;
  const underService = vehicles.filter((vehicle) => vehicle.status === "under_service").length;
  const unavailable = vehicles.length - operational - underService;
  const documentAttention = vehicles.filter((vehicle) => vehicle.nextDocumentDays != null && vehicle.nextDocumentDays <= data.settings.documentWarningDays).length;
  return {
    asOf: data.today,
    missing,
    totals: {
      vehicles: vehicles.length,
      operational,
      underService,
      unavailable,
      documentAttention
    },
    byStation: Array.from(
      vehicles.reduce((map, vehicle) => {
        const key = vehicle.stationCode || "UNASSIGNED";
        const row = map.get(key) ?? { stationCode: key, vehicles: 0, operational: 0, unavailable: 0 };
        row.vehicles += 1;
        const isOperational = data.vehicleStatuses?.find((s) => s.key === vehicle.status)?.isOperational ?? vehicle.status === "active";
        if (isOperational) row.operational += 1;
        else row.unavailable += 1;
        map.set(key, row);
        return map;
      }, new Map<string, { stationCode: string; vehicles: number; operational: number; unavailable: number }>()).values()
    ).sort((a, b) => a.stationCode.localeCompare(b.stationCode))
  };
}

export async function summarizeFleetServiceDue(
  authorization: AuthorizationContext,
  requested: string[]
) {
  const { locations, missing, companyId } = await resolveScopedLocations(authorization, requested);
  const allowed = new Set(locations.map((row) => row.station_code.toUpperCase()));
  const data = await loadFleetControlData(companyId, authorization);
  const warningEnd = new Date(Date.parse(`${data.today}T00:00:00Z`) + data.settings.serviceWarningDays * 86400000)
    .toISOString()
    .slice(0, 10);
  const due = data.vehicles.filter(
    (vehicle) =>
      stationFilter(allowed, vehicle.stationCode) &&
      vehicle.nextServiceDate &&
      vehicle.nextServiceDate <= warningEnd
  );
  const byStation = new Map<string, { stationCode: string; due: number; overdue: number }>();
  for (const vehicle of due) {
    const key = vehicle.stationCode || "UNASSIGNED";
    const row = byStation.get(key) ?? { stationCode: key, due: 0, overdue: 0 };
    row.due += 1;
    if (vehicle.nextServiceDate && vehicle.nextServiceDate < data.today) row.overdue += 1;
    byStation.set(key, row);
  }
  return {
    asOf: data.today,
    serviceWarningDays: data.settings.serviceWarningDays,
    missing,
    totals: { vehiclesDue: due.length, overdue: due.filter((v) => v.nextServiceDate && v.nextServiceDate < data.today).length },
    byStation: [...byStation.values()].sort((a, b) => a.stationCode.localeCompare(b.stationCode))
  };
}

export async function summarizeFleetAuditRisk(
  authorization: AuthorizationContext,
  requested: string[]
) {
  const { locations, missing, companyId } = await resolveScopedLocations(authorization, requested);
  const allowed = new Set(locations.map((row) => row.station_code.toUpperCase()));
  const data = await loadFleetControlData(companyId, authorization);
  const audits = data.audits.filter((audit) => stationFilter(allowed, audit.stationCode));
  const byStatus: Record<string, number> = {};
  const byStation = new Map<string, { stationCode: string; scheduled: number; inProgress: number; completed: number; avgRisk: number | null }>();
  let riskSum = 0;
  let riskCount = 0;
  for (const audit of audits) {
    byStatus[audit.status] = (byStatus[audit.status] ?? 0) + 1;
    const key = audit.stationCode || "UNASSIGNED";
    const row = byStation.get(key) ?? { stationCode: key, scheduled: 0, inProgress: 0, completed: 0, avgRisk: null };
    if (audit.status === "scheduled") row.scheduled += 1;
    if (audit.status === "in_progress") row.inProgress += 1;
    if (audit.status === "completed") row.completed += 1;
    byStation.set(key, row);
    if (typeof audit.riskScore === "number" && Number.isFinite(audit.riskScore)) {
      riskSum += audit.riskScore;
      riskCount += 1;
    }
  }
  return {
    asOf: data.today,
    missing,
    totals: {
      audits: audits.length,
      openFindings: data.findings.filter((finding) => !["resolved", "accepted"].includes(finding.status)).length,
      avgRiskScore: riskCount ? Math.round((riskSum / riskCount) * 10) / 10 : null
    },
    byStatus,
    byStation: [...byStation.values()].sort((a, b) => a.stationCode.localeCompare(b.stationCode))
  };
}

export async function summarizeFleetPaymentInbox(authorization: AuthorizationContext) {
  const companyId = authorization.companyId;
  if (!companyId) throw new Error("Company scope missing.");
  const data = await loadFleetControlData(companyId, authorization);
  const pending = data.payments.filter((payment) => payment.status === "pending" || payment.status === "submitted");
  const awaitingApproval = data.payments.filter((payment) => payment.canApprove);
  return {
    asOf: data.today,
    totals: {
      pendingRequests: pending.length,
      pendingAmount: Math.round(pending.reduce((sum, row) => sum + row.amount, 0)),
      awaitingYourApproval: awaitingApproval.length,
      adHocToday: data.counts.adHocToday,
      adHocTodayAmount: data.counts.adHocTodayAmount
    }
  };
}

export async function summarizeFleetAttention(
  authorization: AuthorizationContext,
  requested: string[]
) {
  const { locations, missing, companyId } = await resolveScopedLocations(authorization, requested);
  const allowed = new Set(locations.map((row) => row.station_code.toUpperCase()));
  const data = await loadFleetControlData(companyId, authorization);
  const items = fleetAttention(data).filter((item) => stationFilter(allowed, item.station));
  const byCategory = new Map<string, { category: string; open: number; resolved: number }>();
  for (const item of items) {
    const row = byCategory.get(item.category) ?? { category: item.category, open: 0, resolved: 0 };
    if (item.resolved) row.resolved += 1;
    else row.open += 1;
    byCategory.set(item.category, row);
  }
  return {
    asOf: data.today,
    missing,
    totals: { open: items.filter((item) => !item.resolved).length, resolved: items.filter((item) => item.resolved).length },
    byCategory: [...byCategory.values()].sort((a, b) => a.category.localeCompare(b.category))
  };
}

export async function summarizeFleetMappingMail(authorization: AuthorizationContext) {
  const companyId = authorization.companyId;
  if (!companyId || !supabaseAdmin) throw new Error("Database unavailable.");
  const { date } = mappingMailClock();
  let configured = false;
  let recipientCount = 0;
  let pendingVehicleDays = 0;
  let deliverableRecipients = 0;
  try {
    const setting = await loadMappingMailConfig(companyId);
    configured = Boolean(setting?.config);
    if (setting?.config) {
      const snapshot = await mappingMailSnapshot(companyId, setting.config, date);
      recipientCount = snapshot.recipients.length;
      pendingVehicleDays = snapshot.rows.reduce((sum, row) => sum + row.pending_count, 0);
      deliverableRecipients = snapshot.recipients.filter((row) => !row.skipReason && row.rows.length).length;
    }
  } catch {
    configured = false;
  }
  const logs = await supabaseAdmin
    .from("fleet_mapping_mail_logs")
    .select("status", { count: "exact", head: false })
    .eq("company_id", companyId)
    .eq("report_date", date);
  const byStatus: Record<string, number> = {};
  for (const row of logs.data ?? []) {
    const status = String(row.status ?? "unknown");
    byStatus[status] = (byStatus[status] ?? 0) + 1;
  }
  return {
    asOf: date,
    configured,
    totals: { recipients: recipientCount, deliverableRecipients, pendingVehicleDays },
    deliveryLogToday: byStatus
  };
}

export { indiaDate, parseStationCodes };
