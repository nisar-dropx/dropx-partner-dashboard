import "server-only";

import type { ConnectAccount } from "./connect-auth";
import { supabaseAdmin } from "./supabase-admin";

type MetricFact = {
  batch_id: string;
  report_year: number | null;
  report_week: number | null;
  station_code: string | null;
  row_label: string | null;
  raw_text: string | null;
  values_json: unknown;
  created_at: string;
};

type CpsFact = {
  work_date: string;
  station_code: string | null;
  overall_cps: number | null;
  target_cps: number | null;
  target_gap: number | null;
};

type PerformanceTarget = {
  metricKey: string;
  label: string;
  short?: string;
  reportType: "daily" | "sls";
  sourceIndex: number | null;
  target: number | null;
  direction: "higher" | "lower";
  weight: number;
  unit: "percent" | "dpmo" | "ratio";
  displayOrder: number;
  isActive: boolean;
};

export type ConnectPerformanceMetric = {
  key: string;
  label: string;
  value: number | null;
  target: number | null;
  direction: "higher" | "lower";
  weight: number;
  unit: "percent" | "dpmo" | "ratio";
  status: "achieved" | "near" | "missed" | "reference";
};

export type ConnectStationPerformance = {
  id: string;
  code: string;
  name: string;
  region: string | null;
  model: string | null;
  unitType: "station" | "store" | "hub" | "location";
  sls: {
    score: number;
    standing: string;
    achievedWeight: number;
    availableWeight: number;
    attainment: number;
    metrics: ConnectPerformanceMetric[];
  } | null;
  cps: {
    date: string;
    value: number;
    target: number | null;
    gap: number | null;
    onTarget: boolean | null;
  } | null;
};

export type ConnectOperationalPerformance = {
  configured: boolean;
  scopeLabel: string;
  stationCount: number;
  availableWeeks: number[];
  selectedWeek: number | null;
  selectedYear: number | null;
  averageSls: number | null;
  averageAttainment: number | null;
  availableCpsMonths: string[];
  selectedCpsMonth: string;
  cpsPeriodState: "mtd" | "closed";
  cpsPeriodLabel: string;
  cpsLatestDate: string | null;
  averageCps: number | null;
  cpsOnTarget: number;
  cpsMeasured: number;
  standingCounts: Record<string, number>;
  stations: ConnectStationPerformance[];
};

function db() {
  if (!supabaseAdmin) throw new Error("Database configuration is unavailable.");
  return supabaseAdmin;
}

function today() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}

function currentMonthStart(value = today()) {
  return `${value.slice(0, 7)}-01`;
}

function monthKey(value = today()) {
  return value.slice(0, 7);
}

function validMonth(value: unknown) {
  const candidate = String(value ?? "").trim();
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(candidate) && candidate <= monthKey() ? candidate : monthKey();
}

function monthEnd(value: string) {
  const [year, month] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function monthLabel(value = monthKey()) {
  return new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "Asia/Kolkata" }).format(new Date(`${value}-15T12:00:00+05:30`));
}

function monthRange(first: string | null, last = monthKey()) {
  const start = /^\d{4}-\d{2}$/.test(first ?? "") ? first! : last;
  const [startYear, startMonth] = start.split("-").map(Number);
  const [lastYear, lastMonth] = last.split("-").map(Number);
  const values: string[] = [];
  for (let cursor = new Date(Date.UTC(startYear, startMonth - 1, 1)); cursor <= new Date(Date.UTC(lastYear, lastMonth - 1, 1)); cursor.setUTCMonth(cursor.getUTCMonth() + 1)) {
    values.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return values.reverse();
}

function locationUnit(modelCode: unknown): ConnectStationPerformance["unitType"] {
  const value = code(modelCode);
  if (value === "NOW") return "store";
  if (value === "ODH" || value === "MDH") return "hub";
  if (value === "EDSP" || value === "XPT") return "station";
  return "location";
}

function code(value: unknown) {
  return String(value ?? "").trim().toUpperCase();
}

function numeric(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function values(row: Pick<MetricFact, "values_json">) {
  if (Array.isArray(row.values_json)) return row.values_json.map(numeric);
  if (row.values_json && typeof row.values_json === "object") {
    const payload = row.values_json as Record<string, unknown>;
    const nested = payload.values ?? payload.metrics ?? payload.data;
    if (Array.isArray(nested)) return nested.map(numeric);
    return Object.entries(payload)
      .filter(([key]) => /^\d+$/.test(key))
      .sort(([left], [right]) => Number(left) - Number(right))
      .map(([, value]) => numeric(value));
  }
  return [];
}

function standing(row: Pick<MetricFact, "row_label" | "raw_text">) {
  const source = `${row.raw_text ?? ""} ${row.row_label ?? ""}`;
  return source.match(/\b(FANTASTIC|GREAT|FAIR|POOR)\b/i)?.[1]?.toUpperCase() ?? "Not rated";
}

function metricStatus(value: number | null, target: number | null, direction: "higher" | "lower"): ConnectPerformanceMetric["status"] {
  if (value == null || target == null) return "reference";
  if (direction === "higher") {
    if (value >= target) return "achieved";
    return value >= target * 0.95 ? "near" : "missed";
  }
  if (value <= target) return "achieved";
  return value <= Math.max(target * 2, target + 0.005) ? "near" : "missed";
}

function parseTarget(row: { description: string | null }) {
  try {
    const target = JSON.parse(row.description ?? "{}") as PerformanceTarget;
    return target.reportType === "sls" && target.isActive !== false ? target : null;
  } catch {
    return null;
  }
}

async function performanceLocationScope(account: ConnectAccount, personId: string, engagementId: string) {
  const day = today();
  const locationIds = new Set<string>();
  let allLocations = false;

  const ownAssignments = await db().from("hr_work_assignments")
    .select("id,location_id")
    .eq("company_id", account.companyId)
    .eq("engagement_id", engagementId)
    .eq("is_primary", true)
    .lte("effective_from", day)
    .or(`effective_to.is.null,effective_to.gte.${day}`)
    .order("effective_from", { ascending: false });
  if (ownAssignments.error) throw new Error(ownAssignments.error.message);
  const ownAssignmentIds = (ownAssignments.data ?? []).map((row) => String(row.id));
  for (const row of ownAssignments.data ?? []) if (row.location_id) locationIds.add(String(row.location_id));

  const link = await db().from("hr_user_person_links")
    .select("user_id")
    .eq("company_id", account.companyId)
    .eq("person_id", personId)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  if (link.error) throw new Error(link.error.message);

  if (link.data?.user_id) {
    const userId = String(link.data.user_id);
    const [profile, access, memberships, positionAssignments] = await Promise.all([
      db().from("profiles").select("role_id,location_scope_ids,is_master_owner").eq("company_id", account.companyId).eq("id", userId).maybeSingle(),
      db().from("hr_user_access").select("location_ids,all_locations").eq("company_id", account.companyId).eq("user_id", userId).eq("is_active", true).maybeSingle(),
      db().from("company_product_memberships").select("location_scope_ids,has_all_location_access").eq("company_id", account.companyId).eq("user_id", userId).eq("is_active", true),
      db().from("position_assignments").select("position_id").eq("company_id", account.companyId).eq("profile_id", userId).eq("is_active", true).lte("valid_from", day).or(`valid_until.is.null,valid_until.gte.${day}`)
    ]);
    const setupError = profile.error ?? access.error ?? memberships.error ?? positionAssignments.error;
    if (setupError) throw new Error(setupError.message);
    allLocations = Boolean(profile.data?.is_master_owner || access.data?.all_locations || (memberships.data ?? []).some((row) => row.has_all_location_access));
    for (const id of profile.data?.location_scope_ids ?? []) locationIds.add(String(id));
    for (const id of access.data?.location_ids ?? []) locationIds.add(String(id));
    for (const row of memberships.data ?? []) for (const id of row.location_scope_ids ?? []) locationIds.add(String(id));

    const positionIds = (positionAssignments.data ?? []).map((row) => row.position_id).filter(Boolean);
    if (positionIds.length) {
      const positions = await db().from("org_positions").select("location_access_mode,location_scope_ids").eq("company_id", account.companyId).eq("is_active", true).in("id", positionIds);
      if (positions.error) throw new Error(positions.error.message);
      allLocations ||= (positions.data ?? []).some((row) => row.location_access_mode === "all_locations");
      for (const row of positions.data ?? []) for (const id of row.location_scope_ids ?? []) locationIds.add(String(id));
    }
  }

  if (ownAssignmentIds.length) {
    const relationships = await db().from("hr_reporting_relationships")
      .select("subject_assignment_id,manager_assignment_id")
      .eq("company_id", account.companyId)
      .eq("relationship_type", "solid_line")
      .eq("is_primary", true)
      .lte("effective_from", day)
      .or(`effective_to.is.null,effective_to.gte.${day}`);
    if (relationships.error) throw new Error(relationships.error.message);
    const managed = new Set(ownAssignmentIds);
    let changed = true;
    while (changed) {
      changed = false;
      for (const relationship of relationships.data ?? []) {
        if (!managed.has(String(relationship.manager_assignment_id)) || managed.has(String(relationship.subject_assignment_id))) continue;
        managed.add(String(relationship.subject_assignment_id));
        changed = true;
      }
    }
    const reporteeIds = [...managed].filter((id) => !ownAssignmentIds.includes(id));
    if (reporteeIds.length) {
      const assignments = await db().from("hr_work_assignments")
        .select("location_id")
        .eq("company_id", account.companyId)
        .in("id", reporteeIds)
        .lte("effective_from", day)
        .or(`effective_to.is.null,effective_to.gte.${day}`);
      if (assignments.error) throw new Error(assignments.error.message);
      for (const row of assignments.data ?? []) if (row.location_id) locationIds.add(String(row.location_id));
    }
  }

  return { allLocations, locationIds: [...locationIds] };
}

export async function loadConnectOperationalPerformance(input: {
  account: ConnectAccount;
  personId: string;
  engagementId: string;
  requestedWeek?: number | null;
  requestedCpsMonth?: string | null;
}): Promise<ConnectOperationalPerformance> {
  const selectedCpsMonth = validMonth(input.requestedCpsMonth);
  const cpsPeriodState = selectedCpsMonth === monthKey() ? "mtd" : "closed";
  const scope = await performanceLocationScope(input.account, input.personId, input.engagementId);
  let stationQuery = db().from("stations")
    .select("id,station_code,station_name,region,location_models(code,name)")
    .eq("company_id", input.account.companyId)
    .eq("is_active", true)
    .or("hide_from_location_list.is.null,hide_from_location_list.eq.false")
    .order("station_code");
  if (!scope.allLocations) stationQuery = stationQuery.in("id", scope.locationIds.length ? scope.locationIds : ["00000000-0000-0000-0000-000000000000"]);
  const stationsResult = await stationQuery;
  if (stationsResult.error) throw new Error(stationsResult.error.message);
  const stationRows = stationsResult.data ?? [];
  const stationCodes = stationRows.map((row) => code(row.station_code)).filter(Boolean);
  if (!stationCodes.length) return {
    configured: true,
    scopeLabel: scope.allLocations ? "All locations" : "No mapped station",
    stationCount: 0,
    availableWeeks: [],
    selectedWeek: null,
    selectedYear: null,
    averageSls: null,
    averageAttainment: null,
    availableCpsMonths: [selectedCpsMonth],
    selectedCpsMonth,
    cpsPeriodState,
    cpsPeriodLabel: `${monthLabel(selectedCpsMonth)} · ${cpsPeriodState === "mtd" ? "MTD" : "Closed"}`,
    cpsLatestDate: null,
    averageCps: null,
    cpsOnTarget: 0,
    cpsMeasured: 0,
    standingCounts: {},
    stations: []
  };

  const [factsResult, cpsResult, oldestCpsResult, targetsResult] = await Promise.all([
    db().from("report_metric_facts")
      .select("batch_id,report_year,report_week,station_code,row_label,raw_text,values_json,created_at")
      .eq("company_id", input.account.companyId)
      .eq("source_type", "edsp_sls_scorecard")
      .in("station_code", stationCodes)
      .order("report_year", { ascending: false })
      .order("report_week", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(7000),
    db().from("cps_station_daily")
      .select("work_date,station_code,overall_cps,target_cps,target_gap")
      .eq("company_id", input.account.companyId)
      .in("station_code", stationCodes)
      .gte("work_date", currentMonthStart(`${selectedCpsMonth}-01`))
      .lte("work_date", cpsPeriodState === "mtd" ? today() : monthEnd(selectedCpsMonth))
      .order("work_date", { ascending: false })
      .limit(5000),
    db().from("cps_station_daily")
      .select("work_date")
      .eq("company_id", input.account.companyId)
      .in("station_code", stationCodes)
      .lte("work_date", today())
      .order("work_date", { ascending: true })
      .limit(1)
      .maybeSingle(),
    db().from("report_import_master")
      .select("description")
      .eq("company_id", input.account.companyId)
      .eq("parser_type", "performance_target")
      .eq("is_active", true)
  ]);
  const loadError = factsResult.error ?? cpsResult.error ?? oldestCpsResult.error ?? targetsResult.error;
  if (loadError) throw new Error(loadError.message);

  const facts = (factsResult.data ?? []) as MetricFact[];
  const weekKeys = [...new Set(facts.filter((row) => row.report_year && row.report_week).map((row) => Number(row.report_year) * 100 + Number(row.report_week)))].sort((a, b) => b - a);
  const requestedKey = input.requestedWeek ? weekKeys.find((key) => key % 100 === input.requestedWeek) : null;
  const selectedKey = requestedKey ?? weekKeys[0] ?? null;
  const selectedYear = selectedKey ? Math.floor(selectedKey / 100) : null;
  const selectedWeek = selectedKey ? selectedKey % 100 : null;
  const candidates = selectedKey ? facts.filter((row) => row.report_year === selectedYear && row.report_week === selectedWeek) : [];
  const factByStation = new Map<string, MetricFact>();
  for (const row of candidates) {
    const stationCode = code(row.station_code);
    const rowValues = values(row);
    if (!stationCode || rowValues.length < 3 || rowValues[1] <= 0 || rowValues[1] > 1) continue;
    const current = factByStation.get(stationCode);
    const quality = (candidate: MetricFact) => {
      const candidateValues = values(candidate);
      return candidateValues.slice(1, 23).filter((item) => item !== 0).length + (/\b(FANTASTIC|GREAT|FAIR|POOR)\b/i.test(`${candidate.raw_text} ${candidate.row_label}`) ? 50 : 0);
    };
    if (!current || quality(row) > quality(current)) factByStation.set(stationCode, row);
  }

  const targets = (targetsResult.data ?? []).map(parseTarget).filter((row): row is PerformanceTarget => Boolean(row)).sort((a, b) => a.displayOrder - b.displayOrder);
  const cpsByStation = new Map<string, CpsFact>();
  for (const row of (cpsResult.data ?? []) as CpsFact[]) {
    const stationCode = code(row.station_code);
    if (stationCode && !cpsByStation.has(stationCode)) cpsByStation.set(stationCode, row);
  }

  const cards: ConnectStationPerformance[] = stationRows.flatMap((station) => {
    const stationCode = code(station.station_code);
    const fact = factByStation.get(stationCode) ?? null;
    const cps = cpsByStation.get(stationCode) ?? null;
    if (!fact && !cps) return [];
    const factValues = fact ? values(fact) : [];
    const metrics: ConnectPerformanceMetric[] = fact ? targets.map((target) => {
      const value = target.sourceIndex == null ? null : factValues[target.sourceIndex] ?? null;
      return {
        key: target.metricKey,
        label: target.short || target.label,
        value,
        target: target.target,
        direction: target.direction,
        weight: numeric(target.weight),
        unit: target.unit,
        status: metricStatus(value, target.target, target.direction)
      };
    }) : [];
    const weightedMetrics = metrics.filter((metric) => metric.target != null && metric.weight > 0);
    const availableWeight = weightedMetrics.reduce((sum, metric) => sum + metric.weight, 0);
    const achievedWeight = weightedMetrics.filter((metric) => metric.status === "achieved").reduce((sum, metric) => sum + metric.weight, 0);
    const target = cps?.target_cps == null ? null : numeric(cps.target_cps);
    const cpsValue = cps ? numeric(cps.overall_cps) : null;
    const modelRelation = Array.isArray(station.location_models) ? station.location_models[0] : station.location_models;
    return [{
      id: String(station.id),
      code: stationCode,
      name: station.station_name || stationCode,
      region: station.region ?? null,
      model: modelRelation?.name || modelRelation?.code || null,
      unitType: locationUnit(modelRelation?.code),
      sls: fact ? {
        score: numeric(factValues[1]),
        standing: standing(fact),
        achievedWeight,
        availableWeight,
        attainment: availableWeight ? Math.round(achievedWeight / availableWeight * 100) : 0,
        metrics
      } : null,
      cps: cps && cpsValue != null ? {
        date: String(cps.work_date),
        value: cpsValue,
        target,
        gap: cps.target_gap == null ? null : numeric(cps.target_gap),
        onTarget: target == null ? null : cpsValue <= target
      } : null
    }];
  }).sort((left, right) => (right.sls?.score ?? -1) - (left.sls?.score ?? -1) || left.code.localeCompare(right.code));

  const slsCards = cards.filter((card) => card.sls);
  const cpsCards = cards.filter((card) => card.cps);
  const standingCounts = slsCards.reduce<Record<string, number>>((counts, card) => {
    const key = card.sls?.standing ?? "Not rated";
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
  return {
    configured: true,
    scopeLabel: scope.allLocations ? "All locations" : `${stationRows.length} mapped location${stationRows.length === 1 ? "" : "s"}`,
    stationCount: stationRows.length,
    availableWeeks: weekKeys.map((key) => key % 100),
    selectedWeek,
    selectedYear,
    averageSls: slsCards.length ? slsCards.reduce((sum, card) => sum + (card.sls?.score ?? 0), 0) / slsCards.length : null,
    averageAttainment: slsCards.length ? Math.round(slsCards.reduce((sum, card) => sum + (card.sls?.attainment ?? 0), 0) / slsCards.length) : null,
    availableCpsMonths: monthRange(oldestCpsResult.data?.work_date?.slice(0, 7) ?? null),
    selectedCpsMonth,
    cpsPeriodState,
    cpsPeriodLabel: `${monthLabel(selectedCpsMonth)} · ${cpsPeriodState === "mtd" ? "MTD" : "Closed"}`,
    cpsLatestDate: cpsCards.map((card) => card.cps?.date ?? "").sort().at(-1) || null,
    averageCps: cpsCards.length ? cpsCards.reduce((sum, card) => sum + (card.cps?.value ?? 0), 0) / cpsCards.length : null,
    cpsOnTarget: cpsCards.filter((card) => card.cps?.onTarget).length,
    cpsMeasured: cpsCards.length,
    standingCounts,
    stations: cards
  };
}
