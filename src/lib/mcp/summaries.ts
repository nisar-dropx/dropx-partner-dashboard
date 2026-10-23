import type { AuthorizationContext } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { indiaDate, parseIsoDate } from "@/lib/mcp/dates";
import { resolveScopedLocations } from "@/lib/mcp/scope";
import { loadCommandCenter } from "@/lib/ops-pulse/command-center-data";
import { loadCodAgeing } from "@/lib/ops-pulse/cod-ageing-data";
import { loadCodStatusLocations } from "@/lib/ops-pulse/cod-status-server";
import { loadLossRecoveryCommand } from "@/lib/ops-pulse/loss-recovery-command";
import { loadReviewStatusDataset } from "@/lib/ops-pulse/review-status-data";
import { loadStationEddNetworkSummary } from "@/lib/ops-pulse/station-edd-summary";
import { loadCpsSnapshot } from "@/lib/ops-pulse/cps-snapshot";
import { loadCpu } from "@/lib/ops-pulse/dark-store";
import { loadOpsRosterCapabilities, loadAssignedOpsRosterApprovals } from "@/lib/ops-pulse/rostering";
import { loadDailyReport } from "@/lib/fleet/report-data";
import { loadPaymentNotificationSnapshot } from "@/lib/payment-notification-counts";
import { loadOpsUnplannedLeaves } from "@/lib/ops-pulse/unplanned-leaves-data";
import { reportsForWorkspace } from "@/lib/ops-pulse/report-catalog";
import { ACTIVE_DAILY_PERFORMANCE_SOURCE } from "@/lib/ops-pulse/performance-source-policy";
import { hasPermission } from "@/lib/authorization";

const ROW_CAP = 50;

function capRows<T>(rows: T[], limit = ROW_CAP) {
  return {
    rows: rows.slice(0, limit),
    truncated: rows.length > limit,
    total: rows.length
  };
}

function requireRange(args: Record<string, unknown>) {
  const from = parseIsoDate(args.from);
  const to = parseIsoDate(args.to);
  if (!from || !to || from > to) {
    throw Object.assign(new Error("Invalid from/to ISO dates."), { code: -32602 });
  }
  return { from, to };
}

export async function summarizeCommandCenter(
  authorization: AuthorizationContext,
  args: Record<string, unknown>,
  requested: string[]
) {
  const to = parseIsoDate(args.to) ?? indiaDate();
  const from = parseIsoDate(args.from) ?? indiaDate(-6);
  if (from > to) throw Object.assign(new Error("Invalid from/to ISO dates."), { code: -32602 });
  const days = Math.max(1, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1);
  const { locations, missing } = await resolveScopedLocations(authorization, requested);
  const result = await loadCommandCenter(authorization, locations, { from, to, days }, true, to);
  const model = result.model;
  const network = {
    total: model.total,
    expected: model.expected,
    observed: model.observed,
    missingDays: model.missingDays,
    aboveTarget: model.aboveTarget,
    missingTargets: model.missingTargets,
    dataGaps: model.dataGaps,
    performanceRisk: model.performanceRisk,
    performanceMissing: model.performanceMissing,
    reviewCount: model.reviewCount,
    latest: model.latest,
    provisional: model.provisional,
    costs: model.costs
  };
  const stations = model.rows.map((row) => ({
    code: row.code,
    name: row.name,
    members: row.members,
    owner: row.owner,
    missingDays: row.missingDays,
    gaps: row.gaps,
    missed: row.missed,
    openReviews: row.openReviews,
    provisional: row.provisional,
    aboveTarget: row.aboveTarget,
    priority: row.priority,
    cps: row.summary
      ? {
          total: row.summary.total,
          shipments: row.summary.shipments,
          gap: row.summary.gap,
          target: row.summary.target,
          provisional: row.summary.provisional
        }
      : null
  }));
  return {
    asOf: to,
    from,
    to,
    missing,
    errors: result.errors,
    canCost: result.canCost,
    canPerformance: result.canPerformance,
    canReview: result.canReview,
    canLosses: result.canLosses,
    performanceDate: result.performanceDate,
    lossRecovery: result.lossRecovery,
    network,
    ...capRows(stations)
  };
}

export async function summarizeCodAgeing(
  authorization: AuthorizationContext,
  args: Record<string, unknown>,
  requested: string[]
) {
  if (!supabaseAdmin) throw Object.assign(new Error("Database unavailable."), { code: -32000 });
  const asOf = parseIsoDate(args.asOf ?? args.as_of) ?? indiaDate();
  const { locations, missing, companyId } = await resolveScopedLocations(authorization, requested);
  const codes = locations.map((row) => row.station_code);
  const snapshot = await loadCodAgeing(supabaseAdmin, companyId, asOf, codes);
  const stations = (snapshot.stations ?? []).map((station) => ({
    stationCode: station.stationCode,
    bands: station.bands,
    total: station.total,
    overTwo: station.overTwo,
    recent: station.recent
  }));
  return {
    asOf,
    dataDate: snapshot.dataDate,
    error: snapshot.error,
    missing,
    ...capRows(stations)
  };
}

export async function summarizeCodStatus(authorization: AuthorizationContext, requested: string[]) {
  const locations = await loadCodStatusLocations(authorization);
  const requestedSet = requested.length ? new Set(requested.map((code) => code.toUpperCase())) : null;
  const rows = locations
    .filter((row) => !requestedSet || requestedSet.has(row.station_code.toUpperCase()))
    .map((row) => ({
      stationCode: row.station_code,
      name: row.station_name,
      city: row.city,
      cluster: row.cluster,
      region: row.region
    }));
  const missing = requested.filter(
    (code) => !locations.some((row) => row.station_code.toUpperCase() === code.toUpperCase())
  );
  return { asOf: indiaDate(), missing, ...capRows(rows) };
}

export async function summarizeLossRecovery(authorization: AuthorizationContext, requested: string[]) {
  const { locations, missing } = await resolveScopedLocations(authorization, requested);
  const result = await loadLossRecoveryCommand(authorization, locations);
  return {
    asOf: indiaDate(),
    missing,
    summary: result.summary,
    byStation: capRows(result.summary?.by_station ?? []).rows,
    truncated: (result.summary?.by_station?.length ?? 0) > ROW_CAP
  };
}

export async function summarizeReviewStatus(
  authorization: AuthorizationContext,
  args: Record<string, unknown>,
  requested: string[]
) {
  const { from, to } = requireRange(args);
  const { locations, missing, companyId } = await resolveScopedLocations(authorization, requested);
  const codes = locations.map((row) => row.station_code);
  const dataset = await loadReviewStatusDataset(companyId, codes, from, to);
  const byStatus = new Map<string, number>();
  const byStation = new Map<string, { stationCode: string; open: number; closed: number; total: number }>();
  for (const review of dataset.reviews) {
    byStatus.set(review.status, (byStatus.get(review.status) ?? 0) + 1);
    const key = review.station_code;
    const row = byStation.get(key) ?? { stationCode: key, open: 0, closed: 0, total: 0 };
    row.total += 1;
    if (review.status === "closed") row.closed += 1;
    else row.open += 1;
    byStation.set(key, row);
  }
  return {
    asOf: to,
    from,
    to,
    missing,
    error: dataset.error,
    reviewCount: dataset.reviews.length,
    byStatus: Object.fromEntries(byStatus),
    ...capRows([...byStation.values()].sort((a, b) => b.total - a.total))
  };
}

export async function summarizePerformance(
  authorization: AuthorizationContext,
  args: Record<string, unknown>,
  requested: string[]
) {
  if (!supabaseAdmin) throw Object.assign(new Error("Database unavailable."), { code: -32000 });
  const asOf = parseIsoDate(args.asOf ?? args.as_of) ?? indiaDate(-1);
  const { locations, missing, companyId } = await resolveScopedLocations(authorization, requested);
  const codes = locations.map((row) => row.station_code);
  if (!codes.length) return { asOf, missing, rows: [], truncated: false, total: 0 };
  const { data, error } = await supabaseAdmin
    .from("report_metric_facts")
    .select("station_code,report_date,created_at")
    .eq("company_id", companyId)
    .eq("source_type", ACTIVE_DAILY_PERFORMANCE_SOURCE)
    .eq("report_date", asOf)
    .in("station_code", codes)
    .limit(5000);
  if (error) throw Object.assign(new Error(error.message), { code: -32000 });
  const counts = new Map<string, number>();
  for (const row of data ?? []) {
    counts.set(row.station_code, (counts.get(row.station_code) ?? 0) + 1);
  }
  const rows = codes.map((stationCode) => ({
    stationCode,
    factCount: counts.get(stationCode) ?? 0,
    hasData: (counts.get(stationCode) ?? 0) > 0
  }));
  return { asOf, source: ACTIVE_DAILY_PERFORMANCE_SOURCE, missing, ...capRows(rows) };
}

export async function summarizeEdd(authorization: AuthorizationContext, requested: string[]) {
  const { locations, missing } = await resolveScopedLocations(authorization, requested);
  const codes = locations.map((row) => row.station_code);
  const summary = await loadStationEddNetworkSummary(codes, 15000);
  return {
    asOf: summary.today,
    computedAt: summary.computedAt,
    pending: summary.pending,
    failed: summary.failed,
    missing,
    ...capRows(summary.stations)
  };
}

export async function summarizeCps(
  authorization: AuthorizationContext,
  args: Record<string, unknown>,
  requested: string[]
) {
  const { from, to } = requireRange(args);
  const { locations, missing, companyId } = await resolveScopedLocations(authorization, requested);
  const snapshot = await loadCpsSnapshot(companyId, from, to, locations);
  const byStation = new Map<
    string,
    { stationCode: string; days: number; totalCost: number; deliveries: number; latestTarget: number | null }
  >();
  for (const day of snapshot.daily ?? []) {
    const row = byStation.get(day.station_code) ?? {
      stationCode: day.station_code,
      days: 0,
      totalCost: 0,
      deliveries: 0,
      latestTarget: null
    };
    row.days += 1;
    row.totalCost += Number(day.total ?? 0) || 0;
    row.deliveries += Number(day.deliveries ?? 0) || 0;
    if (day.target != null) row.latestTarget = Number(day.target);
    byStation.set(day.station_code, row);
  }
  return {
    asOf: to,
    from,
    to,
    missing,
    generatedAt: snapshot.generated_at,
    gapCount: (snapshot.gaps ?? []).length,
    ...capRows([...byStation.values()].sort((a, b) => b.totalCost - a.totalCost))
  };
}

export async function summarizeCpu(
  authorization: AuthorizationContext,
  args: Record<string, unknown>,
  requested: string[]
) {
  const to = parseIsoDate(args.to) ?? indiaDate();
  const from = parseIsoDate(args.from) ?? indiaDate(-30);
  if (from > to) throw Object.assign(new Error("Invalid from/to ISO dates."), { code: -32602 });
  const result = await loadCpu(authorization, {
    period: "custom",
    from,
    to,
    scope: requested.length ? requested.join(",") : undefined
  });
  const rows = result.rows.map((row) => ({
    stationCode: row.code,
    name: row.name,
    cpu: row.cpu,
    cost: row.cost,
    units: row.units,
    days: row.days,
    provisional: row.provisional,
    notes: row.notes
  }));
  return {
    asOf: to,
    from,
    to,
    period: result.period,
    ...capRows(rows)
  };
}

async function checklistStatusSummary(
  table: "ops_si_shift_checklists" | "ops_store_ops_checklists",
  dateColumn: "shift_date" | "work_date",
  authorization: AuthorizationContext,
  from: string,
  to: string,
  requested: string[]
) {
  if (!supabaseAdmin) throw Object.assign(new Error("Database unavailable."), { code: -32000 });
  const { locations, missing, companyId } = await resolveScopedLocations(authorization, requested);
  const locationIds = locations.map((row) => row.id);
  if (!locationIds.length) return { asOf: to, from, to, missing, rows: [], truncated: false, total: 0 };
  let query = supabaseAdmin
    .from(table)
    .select("id,location_id,status")
    .eq("company_id", companyId)
    .in("location_id", locationIds)
    .is("deleted_at", null)
    .limit(5000);
  query = dateColumn === "shift_date"
    ? query.gte("shift_date", from).lte("shift_date", to)
    : query.gte("work_date", from).lte("work_date", to);
  const { data, error } = await query;
  if (error) throw Object.assign(new Error(error.message), { code: -32000 });
  const byLocation = new Map(locations.map((row) => [row.id, row.station_code]));
  const counts = new Map<string, { stationCode: string; total: number; byStatus: Record<string, number> }>();
  for (const row of (data ?? []) as Array<{ location_id: string; status: string | null }>) {
    const stationCode = byLocation.get(row.location_id) ?? "UNKNOWN";
    const entry = counts.get(stationCode) ?? { stationCode, total: 0, byStatus: {} };
    entry.total += 1;
    const status = String(row.status ?? "unknown");
    entry.byStatus[status] = (entry.byStatus[status] ?? 0) + 1;
    counts.set(stationCode, entry);
  }
  return { asOf: to, from, to, missing, ...capRows([...counts.values()]) };
}

export async function summarizeStationAudits(
  authorization: AuthorizationContext,
  args: Record<string, unknown>,
  requested: string[]
) {
  const { from, to } = requireRange(args);
  if (!supabaseAdmin) throw Object.assign(new Error("Database unavailable."), { code: -32000 });
  const { locations, missing, companyId } = await resolveScopedLocations(authorization, requested);
  const locationIds = locations.map((row) => row.id);
  if (!locationIds.length) return { asOf: to, from, to, missing, rows: [], truncated: false, total: 0 };
  const { data, error } = await supabaseAdmin
    .from("ops_station_audits")
    .select("id,location_id,status_code,scheduled_for")
    .eq("company_id", companyId)
    .in("location_id", locationIds)
    .is("deleted_at", null)
    .gte("scheduled_for", `${from}T00:00:00+05:30`)
    .lte("scheduled_for", `${to}T23:59:59+05:30`)
    .limit(5000);
  if (error) throw Object.assign(new Error(error.message), { code: -32000 });
  const byLocation = new Map(locations.map((row) => [row.id, row.station_code]));
  const counts = new Map<string, { stationCode: string; total: number; byStatus: Record<string, number> }>();
  for (const row of data ?? []) {
    const stationCode = byLocation.get(row.location_id) ?? "UNKNOWN";
    const entry = counts.get(stationCode) ?? { stationCode, total: 0, byStatus: {} };
    entry.total += 1;
    const status = String(row.status_code ?? "unknown");
    entry.byStatus[status] = (entry.byStatus[status] ?? 0) + 1;
    counts.set(stationCode, entry);
  }
  return { asOf: to, from, to, missing, ...capRows([...counts.values()]) };
}

export async function summarizeStoreAudits(
  authorization: AuthorizationContext,
  args: Record<string, unknown>,
  requested: string[]
) {
  const { from, to } = requireRange(args);
  if (!supabaseAdmin) throw Object.assign(new Error("Database unavailable."), { code: -32000 });
  const { locations, missing, companyId } = await resolveScopedLocations(authorization, requested);
  const locationIds = locations.map((row) => row.id);
  if (!locationIds.length) return { asOf: to, from, to, missing, rows: [], truncated: false, total: 0 };
  const { data, error } = await supabaseAdmin
    .from("ops_store_audits")
    .select("id,location_id,status,score,score_band,audit_type,scheduled_for")
    .eq("company_id", companyId)
    .in("location_id", locationIds)
    .is("deleted_at", null)
    .gte("scheduled_for", `${from}T00:00:00+05:30`)
    .lte("scheduled_for", `${to}T23:59:59+05:30`)
    .limit(5000);
  if (error) throw Object.assign(new Error(error.message), { code: -32000 });
  const byLocation = new Map(locations.map((row) => [row.id, row.station_code]));
  const counts = new Map<
    string,
    { stationCode: string; total: number; byStatus: Record<string, number>; avgScore: number | null }
  >();
  const scoreSums = new Map<string, { sum: number; n: number }>();
  for (const row of data ?? []) {
    const stationCode = byLocation.get(row.location_id) ?? "UNKNOWN";
    const entry = counts.get(stationCode) ?? { stationCode, total: 0, byStatus: {}, avgScore: null };
    entry.total += 1;
    const status = String(row.status ?? "unknown");
    entry.byStatus[status] = (entry.byStatus[status] ?? 0) + 1;
    if (row.score != null && Number.isFinite(Number(row.score))) {
      const score = scoreSums.get(stationCode) ?? { sum: 0, n: 0 };
      score.sum += Number(row.score);
      score.n += 1;
      scoreSums.set(stationCode, score);
    }
    counts.set(stationCode, entry);
  }
  for (const [code, entry] of counts) {
    const score = scoreSums.get(code);
    entry.avgScore = score && score.n ? Number((score.sum / score.n).toFixed(1)) : null;
  }
  return { asOf: to, from, to, missing, ...capRows([...counts.values()]) };
}

export async function summarizeSiHandover(
  authorization: AuthorizationContext,
  args: Record<string, unknown>,
  requested: string[]
) {
  const { from, to } = requireRange(args);
  return checklistStatusSummary("ops_si_shift_checklists", "shift_date", authorization, from, to, requested);
}

export async function summarizeStoreOps(
  authorization: AuthorizationContext,
  args: Record<string, unknown>,
  requested: string[]
) {
  const { from, to } = requireRange(args);
  return checklistStatusSummary("ops_store_ops_checklists", "work_date", authorization, from, to, requested);
}

export async function summarizeRoster(authorization: AuthorizationContext) {
  const [capabilities, approvals] = await Promise.all([
    loadOpsRosterCapabilities(authorization),
    loadAssignedOpsRosterApprovals(authorization).catch(() => [])
  ]);
  return {
    asOf: indiaDate(),
    capabilities: {
      canPlan: capabilities.canPlan,
      canApprove: capabilities.canApprove,
      canApproveL1: capabilities.canApproveL1,
      canApproveL2: capabilities.canApproveL2,
      canApproveHr: capabilities.canApproveHr,
      canPublishDirect: capabilities.canPublishDirect,
      designationName: capabilities.designationName
    },
    pendingApprovals: approvals.length
  };
}

export async function summarizeAttendanceHeadcount(
  authorization: AuthorizationContext,
  args: Record<string, unknown>,
  requested: string[]
) {
  if (!supabaseAdmin) throw Object.assign(new Error("Database unavailable."), { code: -32000 });
  const asOf = parseIsoDate(args.asOf ?? args.as_of) ?? indiaDate();
  const { locations, missing, companyId } = await resolveScopedLocations(authorization, requested);
  const codes = locations.map((row) => row.station_code);
  if (!codes.length) return { asOf, missing, rows: [], truncated: false, total: 0 };
  const { data, error } = await supabaseAdmin
    .from("attendance_daily")
    .select("station_code,status,enrolment_id")
    .eq("company_id", companyId)
    .eq("punch_date", asOf)
    .in("station_code", codes)
    .limit(30000);
  if (error) throw Object.assign(new Error(error.message), { code: -32000 });
  const rows = locations.map((location) => {
    const stationRows = (data ?? []).filter((row) => row.station_code === location.station_code);
    const byStatus: Record<string, number> = {};
    for (const row of stationRows) {
      const status = String(row.status ?? "unknown").toUpperCase();
      byStatus[status] = (byStatus[status] ?? 0) + 1;
    }
    const present = stationRows.filter((row) => /^(P|PRESENT)$/i.test(row.status ?? "")).length;
    return {
      stationCode: location.station_code,
      headcount: stationRows.length,
      present,
      byStatus
    };
  });
  return { asOf, missing, ...capRows(rows) };
}

export async function summarizeFleet(
  authorization: AuthorizationContext,
  args: Record<string, unknown>
) {
  const { from, to } = requireRange(args);
  const report = await loadDailyReport(authorization, from, to);
  const rows = report.rows.map((row) => ({
    vehicleNo: row.vehicle_no,
    stationCode: row.station_code,
    date: row.date,
    model: row.model,
    fuelType: row.fuel_type,
    status: row.status,
    km: row.km,
    litres: row.litres,
    fuelAmount: row.fuelAmount,
    dataStatus: row.dataStatus
  }));
  return {
    asOf: to,
    from,
    to,
    generatedAt: report.generatedAt,
    vehicleCount: report.vehicles.length,
    latestKmDate: report.latestKmDate,
    latestFuelDate: report.latestFuelDate,
    ...capRows(rows)
  };
}

export async function summarizePaymentInbox(authorization: AuthorizationContext) {
  const snapshot = await loadPaymentNotificationSnapshot(authorization);
  return {
    asOf: indiaDate(),
    total: snapshot.total,
    badges: snapshot.badges,
    items: snapshot.items.map((item) => ({
      key: item.key,
      label: item.label,
      count: item.count,
      href: item.href
    }))
  };
}

export async function summarizeUnplannedLeaves(
  authorization: AuthorizationContext,
  args: Record<string, unknown>
) {
  const asOf = parseIsoDate(args.asOf ?? args.as_of) ?? indiaDate(-1);
  const workspace = await loadOpsUnplannedLeaves(authorization, asOf);
  const byStation = new Map<string, number>();
  for (const row of workspace.rows) {
    const code = row.station_code || "UNKNOWN";
    byStation.set(code, (byStation.get(code) ?? 0) + 1);
  }
  return {
    asOf: workspace.date,
    checkedAt: workspace.checkedAt,
    enabled: workspace.enabled,
    scope: workspace.scope,
    totalPeople: workspace.rows.length,
    managerCount: workspace.managers.length,
    ...capRows(
      [...byStation.entries()]
        .map(([stationCode, count]) => ({ stationCode, count }))
        .sort((a, b) => b.count - a.count)
    )
  };
}

export async function summarizeReportCatalog(authorization: AuthorizationContext) {
  const canCpu = hasPermission(authorization, "cpu_overview", "access");
  const reports = [
    ...reportsForWorkspace("lm", canCpu),
    ...reportsForWorkspace("ds", canCpu)
  ];
  const seen = new Set<string>();
  const rows = [];
  for (const report of reports) {
    if (seen.has(report.type)) continue;
    seen.add(report.type);
    rows.push({
      type: report.type,
      title: report.title,
      group: report.group,
      description: report.description,
      format: report.format,
      workspace: report.workspace
    });
  }
  return { asOf: indiaDate(), rows };
}
