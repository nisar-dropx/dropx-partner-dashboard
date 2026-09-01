import { supabaseAdmin } from "@/lib/supabase-admin";
import type { ServiceNetworkRule } from "@/lib/ops-pulse/service-network";

export type NetworkSector = {
  id: string;
  code: string;
  name: string;
  color: string;
  expectedDailyVolume: number;
  bikeVolumePercent: number;
  tlUserId: string | null;
  tlName: string | null;
  ssaUserId: string | null;
  ssaName: string | null;
  notes: string | null;
  pincodes: Array<{ id: string; pincode: string; serviceState: string; notes: string | null }>;
};

export type NetworkFieldExecutive = {
  id: string;
  name: string;
  dropxId: string | null;
  vehicleType: "bike" | "van" | null;
  mobile: string | null;
};

export type NetworkRosterEntry = {
  id: string;
  fieldExecutiveId: string;
  fieldExecutiveName: string;
  vehicleType: "bike" | "van" | null;
  rosterStatus: string;
  replacementForId: string | null;
  allocationSource: string;
  isCrossSector: boolean;
  shiftCode: string;
  attendanceStatus: string | null;
};

export type NetworkRoute = {
  id: string;
  sectorId: string;
  sectorName: string;
  sectorColor: string;
  planDate: string;
  routeCode: string;
  routeName: string;
  pincodes: string[];
  expectedVolume: number;
  vehicleType: "bike" | "van" | "mixed";
  shiftCode: string;
  status: string;
  isTemporary: boolean;
  changeReason: string | null;
  notes: string | null;
  plannedHeadcount: number;
  actualHeadcount: number;
  requiredHeadcount: number | null;
  plannedCapacity: number | null;
  loadPerFE: number | null;
  signal: "covered" | "overloaded" | "unassigned" | "absence";
  roster: NetworkRosterEntry[];
};

export type NetworkPlanner = {
  id: string;
  name: string;
  email: string | null;
  roleCode: string;
  roleName: string;
};

export type NetworkPlanningData = {
  schemaReady: boolean;
  attendanceLinked: boolean;
  error: string | null;
  sectors: NetworkSector[];
  routes: NetworkRoute[];
  fieldExecutives: NetworkFieldExecutive[];
  planners: NetworkPlanner[];
  backupPool: Array<{ id: string; fieldExecutiveId: string; fieldExecutiveName: string; vehicleType: string; priority: number }>;
  delegations: Array<{ id: string; sectorId: string | null; assignedToUserId: string; assignedToName: string; permissionLevel: string; effectiveFrom: string; effectiveTo: string | null }>;
  incidents: Array<{ id: string; routePlanId: string | null; incidentDate: string; vehicleType: string; incidentType: string; status: string; details: string | null }>;
  templates: Array<{ id: string; name: string; sectorId: string | null; isDefault: boolean; payload: Record<string, unknown> }>;
  summary: {
    expectedVolume: number;
    plannedHeadcount: number;
    actualHeadcount: number;
    requiredHeadcount: number | null;
    unassignedRoutes: number;
    overloadedRoutes: number;
    absentExecutives: number;
    coverageGaps: number;
    feUtilizationPercent: number;
  };
};

type Relation<T> = T | T[] | null | undefined;

function relation<T>(value: Relation<T>): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function number(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function dateFrom(value: string) {
  return new Date(`${value}T00:00:00Z`);
}

function isoDay(value: Date) {
  return value.toISOString().slice(0, 10);
}

export function startOfPlanningWeek(value: string) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? dateFrom(value) : new Date();
  const day = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - (day === 0 ? 6 : day - 1));
  return isoDay(date);
}

export function endOfPlanningWeek(value: string) {
  const date = dateFrom(startOfPlanningWeek(value));
  date.setUTCDate(date.getUTCDate() + 6);
  return isoDay(date);
}

export function planningWeekDays(value: string) {
  const start = dateFrom(startOfPlanningWeek(value));
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + index);
    return isoDay(date);
  });
}

function missingSchema(error: unknown) {
  const message = String((error as { message?: unknown })?.message ?? "").toLowerCase();
  return message.includes("ops_network_sectors") || message.includes("schema cache") || (message.includes("relation") && message.includes("does not exist"));
}

function emptyPlanningData(error: string | null, schemaReady = true): NetworkPlanningData {
  return {
    schemaReady,
    attendanceLinked: false,
    error,
    sectors: [],
    routes: [],
    fieldExecutives: [],
    planners: [],
    backupPool: [],
    delegations: [],
    incidents: [],
    templates: [],
    summary: {
      expectedVolume: 0,
      plannedHeadcount: 0,
      actualHeadcount: 0,
      requiredHeadcount: null,
      unassignedRoutes: 0,
      overloadedRoutes: 0,
      absentExecutives: 0,
      coverageGaps: 0,
      feUtilizationPercent: 0
    }
  };
}

function presentByAttendance(status: string | null) {
  if (!status) return null;
  return ["P", "PRESENT", "HLF", "HALF DAY", "HALF_DAY"].includes(status.trim().toUpperCase());
}

function requiredForRoute(route: { expected_volume: unknown; vehicle_type: string; capacity_override?: unknown }, sector: NetworkSector | undefined, rule?: ServiceNetworkRule) {
  if (number(route.capacity_override) > 0) return null;
  if (!rule?.bikeSpr || !rule.vanSpr) return null;
  const volume = number(route.expected_volume);
  const buffer = 1 + Math.max(0, rule.bufferPercent) / 100;
  if (route.vehicle_type === "bike") return Math.ceil(volume / rule.bikeSpr * buffer);
  if (route.vehicle_type === "van") return Math.ceil(volume / rule.vanSpr * buffer);
  const bikeShare = Math.max(0, Math.min(100, sector?.bikeVolumePercent ?? 70)) / 100;
  return Math.ceil(volume * bikeShare / rule.bikeSpr * buffer) + Math.ceil(volume * (1 - bikeShare) / rule.vanSpr * buffer);
}

export async function loadNetworkPlanning(input: {
  companyId: string;
  stationId: string;
  weekStart: string;
  selectedDate: string;
  rule?: ServiceNetworkRule;
}) {
  if (!supabaseAdmin) return emptyPlanningData("Database service is unavailable.", false);

  const sectorResult = await supabaseAdmin
    .from("ops_network_sectors")
    .select("id,code,name,color,expected_daily_volume,bike_volume_percent,tl_user_id,ssa_user_id,notes")
    .eq("company_id", input.companyId)
    .eq("station_id", input.stationId)
    .eq("is_active", true)
    .order("code");
  if (sectorResult.error) {
    return emptyPlanningData(
      missingSchema(sectorResult.error)
        ? "Network Planning setup is pending. Run scripts/ops_network_planning_v1.sql, then refresh."
        : sectorResult.error.message,
      !missingSchema(sectorResult.error)
    );
  }

  const weekStart = startOfPlanningWeek(input.weekStart);
  const weekEnd = endOfPlanningWeek(weekStart);
  const routeResult = await supabaseAdmin.from("ops_route_plans").select("id,sector_id,plan_date,route_code,route_name,pincodes,expected_volume,vehicle_type,shift_code,status,is_temporary,change_reason,notes,capacity_override").eq("company_id", input.companyId).eq("station_id", input.stationId).gte("plan_date", weekStart).lte("plan_date", weekEnd).order("plan_date").order("route_code");
  if (routeResult.error) return emptyPlanningData(routeResult.error.message);
  const weekRouteIds = (routeResult.data ?? []).map(route => route.id);
  const [pincodeResult, rosterResult, feResult, attendanceResult, backupResult, delegationResult, incidentResult, templateResult, plannerResult] = await Promise.all([
    supabaseAdmin.from("ops_network_sector_pincodes").select("id,sector_id,pincode,service_state,notes").eq("company_id", input.companyId).eq("station_id", input.stationId).lte("effective_from", weekEnd).or(`effective_to.is.null,effective_to.gte.${weekStart}`).order("pincode"),
    supabaseAdmin.from("ops_route_roster").select("id,route_plan_id,field_executive_id,roster_status,replacement_for_id,allocation_source,is_cross_sector,shift_code").eq("company_id", input.companyId).eq("station_id", input.stationId).in("route_plan_id", weekRouteIds.length ? weekRouteIds : ["00000000-0000-0000-0000-000000000000"]),
    supabaseAdmin.from("workforce").select("id,full_name,dropx_id,vehicle_type,mobile").eq("company_id", input.companyId).eq("location_id", input.stationId).eq("is_active", true).order("full_name"),
    supabaseAdmin.from("attendance_daily").select("field_executive_id,punch_date,status").eq("company_id", input.companyId).eq("location_id", input.stationId).gte("punch_date", weekStart).lte("punch_date", weekEnd).not("field_executive_id", "is", null),
    supabaseAdmin.from("ops_network_backup_pool").select("id,field_executive_id,vehicle_type,priority").eq("company_id", input.companyId).eq("station_id", input.stationId).eq("is_active", true).lte("effective_from", weekEnd).or(`effective_to.is.null,effective_to.gte.${weekStart}`).order("priority"),
    supabaseAdmin.from("ops_network_delegations").select("id,sector_id,assigned_to_user_id,permission_level,effective_from,effective_to").eq("company_id", input.companyId).eq("station_id", input.stationId).eq("is_active", true).lte("effective_from", weekEnd).or(`effective_to.is.null,effective_to.gte.${weekStart}`),
    supabaseAdmin.from("ops_vehicle_incidents").select("id,route_plan_id,incident_date,vehicle_type,incident_type,status,details").eq("company_id", input.companyId).eq("station_id", input.stationId).gte("incident_date", weekStart).lte("incident_date", weekEnd).order("incident_date", { ascending: false }),
    supabaseAdmin.from("ops_weekly_roster_templates").select("id,name,sector_id,is_default,template_payload").eq("company_id", input.companyId).eq("station_id", input.stationId).eq("is_active", true).order("is_default", { ascending: false }).order("name"),
    supabaseAdmin.from("profiles").select("id,full_name,email,location_scope_ids,user_roles(code,name,location_access_mode)").eq("company_id", input.companyId).eq("is_active", true).order("full_name")
  ]);

  const firstError = [pincodeResult, routeResult, rosterResult, feResult, backupResult, delegationResult, incidentResult, templateResult, plannerResult]
    .map(result => result.error?.message)
    .find(Boolean) ?? null;
  const fieldExecutives: NetworkFieldExecutive[] = (feResult.data ?? []).map(row => ({
    id: row.id,
    name: row.full_name,
    dropxId: row.dropx_id,
    vehicleType: row.vehicle_type === "bike" || row.vehicle_type === "van" ? row.vehicle_type : null,
    mobile: row.mobile
  }));
  const feById = new Map(fieldExecutives.map(row => [row.id, row]));

  const plannerRows = (plannerResult.data ?? []).map(row => {
    const role = relation(row.user_roles as Relation<{ code?: string | null; name?: string | null; location_access_mode?: string | null }>);
    return { row, role };
  }).filter(({ row, role }) => {
    const code = String(role?.code ?? "").toUpperCase();
    const scoped = role?.location_access_mode === "all_locations" || (Array.isArray(row.location_scope_ids) && row.location_scope_ids.includes(input.stationId));
    return scoped && ["OWNER", "ADMIN", "STATION_MANAGER", "TEAM_LEADER", "SSA"].includes(code);
  });
  const planners: NetworkPlanner[] = plannerRows.map(({ row, role }) => ({
    id: row.id,
    name: row.full_name || row.email || "Ops user",
    email: row.email,
    roleCode: String(role?.code ?? "").toUpperCase(),
    roleName: role?.name || String(role?.code ?? "Ops user")
  }));
  const plannerById = new Map(planners.map(row => [row.id, row]));

  const pincodes = pincodeResult.data ?? [];
  const sectors: NetworkSector[] = (sectorResult.data ?? []).map(row => ({
    id: row.id,
    code: row.code,
    name: row.name,
    color: row.color,
    expectedDailyVolume: number(row.expected_daily_volume),
    bikeVolumePercent: number(row.bike_volume_percent),
    tlUserId: row.tl_user_id,
    tlName: row.tl_user_id ? plannerById.get(row.tl_user_id)?.name ?? "Assigned user" : null,
    ssaUserId: row.ssa_user_id,
    ssaName: row.ssa_user_id ? plannerById.get(row.ssa_user_id)?.name ?? "Assigned user" : null,
    notes: row.notes,
    pincodes: pincodes.filter(item => item.sector_id === row.id).map(item => ({ id: item.id, pincode: item.pincode, serviceState: item.service_state, notes: item.notes }))
  }));
  const sectorById = new Map(sectors.map(row => [row.id, row]));
  const attendance = new Map((attendanceResult.data ?? []).map(row => [`${row.field_executive_id}:${row.punch_date}`, row.status]));
  const rosterByRoute = new Map<string, NetworkRosterEntry[]>();
  for (const row of rosterResult.data ?? []) {
    const route = (routeResult.data ?? []).find(item => item.id === row.route_plan_id);
    const fe = feById.get(row.field_executive_id);
    const attendanceStatus = route ? attendance.get(`${row.field_executive_id}:${route.plan_date}`) ?? null : null;
    const entry: NetworkRosterEntry = {
      id: row.id,
      fieldExecutiveId: row.field_executive_id,
      fieldExecutiveName: fe?.name ?? "Inactive FE",
      vehicleType: fe?.vehicleType ?? null,
      rosterStatus: row.roster_status,
      replacementForId: row.replacement_for_id,
      allocationSource: row.allocation_source,
      isCrossSector: Boolean(row.is_cross_sector),
      shiftCode: row.shift_code,
      attendanceStatus
    };
    rosterByRoute.set(row.route_plan_id, [...(rosterByRoute.get(row.route_plan_id) ?? []), entry]);
  }

  const routes: NetworkRoute[] = (routeResult.data ?? []).map(row => {
    const sector = sectorById.get(row.sector_id);
    const roster = rosterByRoute.get(row.id) ?? [];
    const plannedRoster = roster.filter(item => !["released", "leave"].includes(item.rosterStatus));
    const activeRoster = plannedRoster.filter(item => {
      const attendancePresent = presentByAttendance(item.attendanceStatus);
      if (attendancePresent != null) return attendancePresent;
      return !["absent", "leave", "released"].includes(item.rosterStatus);
    });
    const required = requiredForRoute(row, sector, input.rule);
    const plannedCapacity = number(row.capacity_override) > 0
      ? number(row.capacity_override)
      : input.rule
        ? activeRoster.reduce((sum, item) => sum + (item.vehicleType === "van" ? input.rule!.vanSpr : input.rule!.bikeSpr), 0)
        : null;
    const unassigned = plannedRoster.length === 0;
    const absence = roster.some(item => item.rosterStatus === "absent" || presentByAttendance(item.attendanceStatus) === false);
    const overloaded = plannedCapacity != null && number(row.expected_volume) > plannedCapacity;
    return {
      id: row.id,
      sectorId: row.sector_id,
      sectorName: sector?.name ?? "Unmapped sector",
      sectorColor: sector?.color ?? "#64748b",
      planDate: row.plan_date,
      routeCode: row.route_code,
      routeName: row.route_name,
      pincodes: Array.isArray(row.pincodes) ? row.pincodes : [],
      expectedVolume: number(row.expected_volume),
      vehicleType: row.vehicle_type === "van" || row.vehicle_type === "mixed" ? row.vehicle_type : "bike",
      shiftCode: row.shift_code,
      status: row.status,
      isTemporary: Boolean(row.is_temporary),
      changeReason: row.change_reason,
      notes: row.notes,
      plannedHeadcount: plannedRoster.length,
      actualHeadcount: activeRoster.length,
      requiredHeadcount: required,
      plannedCapacity,
      loadPerFE: activeRoster.length ? number(row.expected_volume) / activeRoster.length : null,
      signal: unassigned ? "unassigned" : absence ? "absence" : overloaded || (required != null && activeRoster.length < required) ? "overloaded" : "covered",
      roster
    };
  });

  const selectedRoutes = routes.filter(route => route.planDate === input.selectedDate && route.status !== "cancelled");
  const selectedRoster = selectedRoutes.flatMap(route => route.roster);
  const plannedIds = new Set(selectedRoster.filter(item => !["released", "leave"].includes(item.rosterStatus)).map(item => item.fieldExecutiveId));
  const actualIds = new Set(selectedRoster.filter(item => {
    const attendancePresent = presentByAttendance(item.attendanceStatus);
    return attendancePresent ?? !["absent", "leave", "released"].includes(item.rosterStatus);
  }).map(item => item.fieldExecutiveId));
  const requiredValues = selectedRoutes.map(route => route.requiredHeadcount);
  const requiredHeadcount = requiredValues.some(value => value == null) ? null : requiredValues.reduce<number>((sum, value) => sum + number(value), 0);
  const absentIds = new Set(selectedRoster.filter(item => item.rosterStatus === "absent" || presentByAttendance(item.attendanceStatus) === false).map(item => item.fieldExecutiveId));

  return {
    schemaReady: true,
    attendanceLinked: !attendanceResult.error && (attendanceResult.data ?? []).length > 0,
    error: firstError,
    sectors,
    routes,
    fieldExecutives,
    planners,
    backupPool: (backupResult.data ?? []).map(row => ({ id: row.id, fieldExecutiveId: row.field_executive_id, fieldExecutiveName: feById.get(row.field_executive_id)?.name ?? "Inactive FE", vehicleType: row.vehicle_type, priority: number(row.priority) })),
    delegations: (delegationResult.data ?? []).map(row => ({ id: row.id, sectorId: row.sector_id, assignedToUserId: row.assigned_to_user_id, assignedToName: plannerById.get(row.assigned_to_user_id)?.name ?? "Assigned user", permissionLevel: row.permission_level, effectiveFrom: row.effective_from, effectiveTo: row.effective_to })),
    incidents: (incidentResult.data ?? []).map(row => ({ id: row.id, routePlanId: row.route_plan_id, incidentDate: row.incident_date, vehicleType: row.vehicle_type, incidentType: row.incident_type, status: row.status, details: row.details })),
    templates: (templateResult.data ?? []).map(row => ({ id: row.id, name: row.name, sectorId: row.sector_id, isDefault: Boolean(row.is_default), payload: (row.template_payload ?? {}) as Record<string, unknown> })),
    summary: {
      expectedVolume: selectedRoutes.reduce((sum, route) => sum + route.expectedVolume, 0),
      plannedHeadcount: plannedIds.size,
      actualHeadcount: actualIds.size,
      requiredHeadcount,
      unassignedRoutes: selectedRoutes.filter(route => route.signal === "unassigned").length,
      overloadedRoutes: selectedRoutes.filter(route => route.signal === "overloaded").length,
      absentExecutives: absentIds.size,
      coverageGaps: selectedRoutes.filter(route => route.signal !== "covered").length,
      feUtilizationPercent: fieldExecutives.length ? plannedIds.size / fieldExecutives.length * 100 : 0
    }
  } satisfies NetworkPlanningData;
}

export function routePlanShareText(stationCode: string, date: string, routes: NetworkRoute[]) {
  const lines = [`OpsPulse Network Plan · ${stationCode} · ${date}`];
  for (const route of routes.filter(item => item.planDate === date && item.status !== "cancelled")) {
    const names = route.roster.filter(item => !["released", "leave", "absent"].includes(item.rosterStatus)).map(item => item.fieldExecutiveName).join(", ") || "UNASSIGNED";
    lines.push(`${route.routeCode} · ${route.sectorName} · ${route.pincodes.join("/") || "Pincode pending"} · ${route.expectedVolume} vol · ${names}`);
  }
  return lines.join("\n");
}
