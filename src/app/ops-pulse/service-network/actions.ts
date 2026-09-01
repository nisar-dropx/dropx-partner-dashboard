"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePagePermission, type AuthorizationContext } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { startOfPlanningWeek } from "@/lib/ops-pulse/network-planning";
import { supabaseAdmin } from "@/lib/supabase-admin";

function clean(value: FormDataEntryValue | null) { return String(value ?? "").trim(); }
function date(value: FormDataEntryValue | null, label: string) { const result = clean(value); if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) throw new Error(`${label} is required.`); return result; }
function integer(value: FormDataEntryValue | null, label: string, minimum = 0) { const result = Number(value); if (!Number.isInteger(result) || result < minimum) throw new Error(`${label} must be ${minimum} or more.`); return result; }
function id(value: FormDataEntryValue | null, label: string) { const result = clean(value); if (!/^[0-9a-f-]{36}$/i.test(result)) throw new Error(`${label} is invalid.`); return result; }
function bool(value: FormDataEntryValue | null) { return value === "on" || value === "true" || value === "1"; }
function pincodes(value: FormDataEntryValue | null) {
  const rows = [...new Set(clean(value).split(/[,\s]+/).filter(Boolean))];
  if (rows.some(row => !/^\d{6}$/.test(row))) throw new Error("Every route pincode must contain six digits.");
  return rows;
}
function errorMessage(error: unknown) { return error instanceof Error ? error.message : "Unable to update the route plan."; }

function finish(formData: FormData, result: { notice?: string; error?: string }): never {
  const query = new URLSearchParams();
  for (const key of ["station", "client", "from", "to", "week", "date", "view"] as const) {
    const value = clean(formData.get(key));
    if (value) query.set(key, value);
  }
  if (result.notice) query.set("notice", result.notice);
  if (result.error) query.set("error", result.error);
  redirect(`/ops-pulse/service-network?${query}`);
}

function database() {
  if (!supabaseAdmin) throw new Error("Database service is unavailable.");
  return supabaseAdmin;
}

async function assertStationAccess(authorization: AuthorizationContext, companyId: string, stationId: string) {
  const db = database();
  const { data, error } = await db.from("stations").select("id,station_code,is_active").eq("company_id", companyId).eq("id", stationId).eq("is_active", true).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("This station is not active in OpsPulse.");
  if (!authorization.hasAllLocationAccess && !authorization.locationScopeIds.includes(stationId)) throw new Error("Station access denied.");
  return data;
}

async function assertSectorAccess(authorization: AuthorizationContext, companyId: string, stationId: string, sectorId: string, planDate: string) {
  const db = database();
  const { data: sector, error } = await db.from("ops_network_sectors").select("id,tl_user_id,ssa_user_id").eq("company_id", companyId).eq("station_id", stationId).eq("id", sectorId).eq("is_active", true).maybeSingle();
  if (error) throw new Error(error.message);
  if (!sector) throw new Error("Sector is not available for this station.");
  if (!["TEAM_LEADER", "SSA"].includes(String(authorization.roleCode ?? "").toUpperCase())) return sector;
  if (sector.tl_user_id === authorization.userId || sector.ssa_user_id === authorization.userId) return sector;
  const { data: delegation, error: delegationError } = await db.from("ops_network_delegations").select("id").eq("company_id", companyId).eq("station_id", stationId).eq("assigned_to_user_id", authorization.userId).eq("is_active", true).in("permission_level", ["plan", "approve"]).lte("effective_from", planDate).or(`effective_to.is.null,effective_to.gte.${planDate}`).or(`sector_id.is.null,sector_id.eq.${sectorId}`).limit(1).maybeSingle();
  if (delegationError) throw new Error(delegationError.message);
  if (!delegation) throw new Error("This sector has not been assigned or delegated to you.");
  return sector;
}

async function routeContext(companyId: string, stationId: string, routePlanId: string) {
  const { data, error } = await database().from("ops_route_plans").select("id,sector_id,plan_date,vehicle_type,status,route_code").eq("company_id", companyId).eq("station_id", stationId).eq("id", routePlanId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Route plan was not found.");
  return data;
}

function refresh() {
  revalidatePath("/ops-pulse/service-network");
  revalidatePath("/ops-pulse/service-network/share");
}

export async function createRoutePlan(formData: FormData) {
  const authorization = await requirePagePermission("service_network", "edit");
  const companyId = requireCompanyId(authorization);
  try {
    const stationId = id(formData.get("station_id"), "Station");
    const sectorId = id(formData.get("sector_id"), "Sector");
    const planDate = date(formData.get("plan_date"), "Plan date");
    await assertStationAccess(authorization, companyId, stationId);
    await assertSectorAccess(authorization, companyId, stationId, sectorId, planDate);
    const vehicleType = clean(formData.get("vehicle_type"));
    if (!["bike", "van", "mixed"].includes(vehicleType)) throw new Error("Choose Bike, Van, or Mixed.");
    const routeCode = clean(formData.get("route_code")).toUpperCase();
    const routeName = clean(formData.get("route_name"));
    if (!routeCode || !routeName) throw new Error("Route code and route name are required.");
    const routePincodes = pincodes(formData.get("pincodes"));
    if (routePincodes.length) {
      const sectorPincodes = await database().from("ops_network_sector_pincodes").select("pincode").eq("company_id", companyId).eq("station_id", stationId).eq("sector_id", sectorId).in("service_state", ["active", "temporary", "split"]);
      if (sectorPincodes.error) throw new Error(sectorPincodes.error.message);
      const approved = new Set((sectorPincodes.data ?? []).map(row => row.pincode));
      const outside = routePincodes.filter(pincode => !approved.has(pincode));
      if (outside.length && !bool(formData.get("manual_override"))) throw new Error(`${outside.join(", ")} is outside this sector. Enable manual override for a temporary or cross-sector route.`);
    }
    const result = await database().from("ops_route_plans").insert({
      company_id: companyId,
      station_id: stationId,
      sector_id: sectorId,
      plan_date: planDate,
      route_code: routeCode,
      route_name: routeName,
      pincodes: routePincodes,
      expected_volume: integer(formData.get("expected_volume"), "Expected volume"),
      vehicle_type: vehicleType,
      shift_code: clean(formData.get("shift_code")) || "general",
      planned_start_time: clean(formData.get("planned_start_time")) || null,
      planned_end_time: clean(formData.get("planned_end_time")) || null,
      capacity_override: clean(formData.get("capacity_override")) ? integer(formData.get("capacity_override"), "Capacity override", 1) : null,
      status: bool(formData.get("publish")) ? "published" : "draft",
      is_temporary: bool(formData.get("is_temporary")),
      change_reason: clean(formData.get("change_reason")) || null,
      notes: clean(formData.get("notes")) || null,
      created_by: authorization.userId
    });
    if (result.error) throw new Error(result.error.message);
    refresh();
  } catch (error) { finish(formData, { error: errorMessage(error) }); }
  finish(formData, { notice: "Route added to the OpsPulse station plan." });
}

export async function assignFieldExecutive(formData: FormData) {
  const authorization = await requirePagePermission("service_network", "edit");
  const companyId = requireCompanyId(authorization);
  try {
    const stationId = id(formData.get("station_id"), "Station");
    const routePlanId = id(formData.get("route_plan_id"), "Route");
    const fieldExecutiveId = id(formData.get("field_executive_id"), "Field Executive");
    const manualOverride = bool(formData.get("manual_override"));
    await assertStationAccess(authorization, companyId, stationId);
    const route = await routeContext(companyId, stationId, routePlanId);
    await assertSectorAccess(authorization, companyId, stationId, route.sector_id, route.plan_date);
    const { data: executive, error } = await database().from("workforce").select("id,vehicle_type,full_name").eq("company_id", companyId).eq("location_id", stationId).eq("id", fieldExecutiveId).eq("is_active", true).maybeSingle();
    if (error) throw new Error(error.message);
    if (!executive) throw new Error("The selected Field Executive is not active at this station.");
    if (!manualOverride && route.vehicle_type !== "mixed" && executive.vehicle_type && route.vehicle_type !== executive.vehicle_type) throw new Error(`This route needs a ${route.vehicle_type} FE. Enable manual override to cross-allocate.`);

    const dayRoutes = await database().from("ops_route_plans").select("id").eq("company_id", companyId).eq("station_id", stationId).eq("plan_date", route.plan_date).neq("status", "cancelled");
    if (dayRoutes.error) throw new Error(dayRoutes.error.message);
    const routeIds = (dayRoutes.data ?? []).map(row => row.id);
    if (routeIds.length && !manualOverride) {
      const existing = await database().from("ops_route_roster").select("id").eq("company_id", companyId).eq("field_executive_id", fieldExecutiveId).in("route_plan_id", routeIds).not("roster_status", "in", "(released,leave)").limit(1);
      if (existing.error) throw new Error(existing.error.message);
      if (existing.data?.length) throw new Error("This FE already has a route on the selected day. Enable manual override for cross-route support.");
    }

    const oldAssignmentId = clean(formData.get("replace_assignment_id"));
    if (oldAssignmentId) {
      const released = await database().from("ops_route_roster").update({ roster_status: "released", notes: "Quick reassignment" }).eq("company_id", companyId).eq("station_id", stationId).eq("id", oldAssignmentId).eq("route_plan_id", routePlanId);
      if (released.error) throw new Error(released.error.message);
    }
    const result = await database().from("ops_route_roster").upsert({
      company_id: companyId,
      station_id: stationId,
      route_plan_id: routePlanId,
      field_executive_id: fieldExecutiveId,
      roster_status: oldAssignmentId ? "replacement" : "planned",
      allocation_source: manualOverride ? "manual" : "sector",
      is_cross_sector: manualOverride,
      shift_code: clean(formData.get("shift_code")) || "general",
      created_by: authorization.userId
    }, { onConflict: "route_plan_id,field_executive_id" });
    if (result.error) throw new Error(result.error.message);
    refresh();
  } catch (error) { finish(formData, { error: errorMessage(error) }); }
  finish(formData, { notice: "FE allocation updated." });
}

export async function removeRosterAssignment(formData: FormData) {
  const authorization = await requirePagePermission("service_network", "edit");
  const companyId = requireCompanyId(authorization);
  try {
    const stationId = id(formData.get("station_id"), "Station");
    const routePlanId = id(formData.get("route_plan_id"), "Route");
    const assignmentId = id(formData.get("assignment_id"), "Allocation");
    await assertStationAccess(authorization, companyId, stationId);
    const route = await routeContext(companyId, stationId, routePlanId);
    await assertSectorAccess(authorization, companyId, stationId, route.sector_id, route.plan_date);
    const result = await database().from("ops_route_roster").update({ roster_status: "released", notes: clean(formData.get("notes")) || "Released from route" }).eq("company_id", companyId).eq("station_id", stationId).eq("route_plan_id", routePlanId).eq("id", assignmentId);
    if (result.error) throw new Error(result.error.message);
    refresh();
  } catch (error) { finish(formData, { error: errorMessage(error) }); }
  finish(formData, { notice: "FE released from the route." });
}

export async function markAbsenceAndReplace(formData: FormData) {
  const authorization = await requirePagePermission("service_network", "edit");
  const companyId = requireCompanyId(authorization);
  let replacementName = "";
  try {
    const stationId = id(formData.get("station_id"), "Station");
    const routePlanId = id(formData.get("route_plan_id"), "Route");
    const assignmentId = id(formData.get("assignment_id"), "Allocation");
    await assertStationAccess(authorization, companyId, stationId);
    const route = await routeContext(companyId, stationId, routePlanId);
    await assertSectorAccess(authorization, companyId, stationId, route.sector_id, route.plan_date);
    const db = database();
    const assignment = await db.from("ops_route_roster").select("id,field_executive_id").eq("company_id", companyId).eq("station_id", stationId).eq("route_plan_id", routePlanId).eq("id", assignmentId).maybeSingle();
    if (assignment.error) throw new Error(assignment.error.message);
    if (!assignment.data) throw new Error("Roster allocation was not found.");
    const absent = await db.from("ops_route_roster").update({ roster_status: "absent", notes: clean(formData.get("reason")) || "Marked absent in Network Planning" }).eq("id", assignmentId);
    if (absent.error) throw new Error(absent.error.message);

    if (bool(formData.get("auto_replace"))) {
      const dayRoutes = await db.from("ops_route_plans").select("id").eq("company_id", companyId).eq("station_id", stationId).eq("plan_date", route.plan_date).neq("status", "cancelled");
      if (dayRoutes.error) throw new Error(dayRoutes.error.message);
      const routeIds = (dayRoutes.data ?? []).map(row => row.id);
      const allocated = routeIds.length ? await db.from("ops_route_roster").select("field_executive_id").in("route_plan_id", routeIds).not("roster_status", "in", "(released,leave,absent)") : { data: [], error: null };
      if (allocated.error) throw new Error(allocated.error.message);
      const allocatedIds = new Set((allocated.data ?? []).map(row => row.field_executive_id));
      const pool = await db.from("ops_network_backup_pool").select("field_executive_id,vehicle_type,priority").eq("company_id", companyId).eq("station_id", stationId).eq("is_active", true).lte("effective_from", route.plan_date).or(`effective_to.is.null,effective_to.gte.${route.plan_date}`).order("priority");
      if (pool.error) throw new Error(pool.error.message);
      const candidates = (pool.data ?? []).filter(row => !allocatedIds.has(row.field_executive_id));
      const workforceIds = candidates.map(row => row.field_executive_id);
      const workforceProfiles = workforceIds.length
        ? await db.from("workforce").select("id,full_name,is_active").eq("company_id", companyId).in("id", workforceIds)
        : { data: [], error: null };
      if (workforceProfiles.error) throw new Error(workforceProfiles.error.message);
      const workforceById = new Map((workforceProfiles.data ?? []).map(profile => [profile.id, profile]));
      const availableCandidates = candidates.filter(row => workforceById.get(row.field_executive_id)?.is_active);
      const candidate = availableCandidates.find(row => route.vehicle_type === "mixed" || row.vehicle_type === route.vehicle_type) ?? availableCandidates[0];
      if (candidate) {
        const executive = workforceById.get(candidate.field_executive_id);
        if (executive) {
          const replacement = await db.from("ops_route_roster").upsert({
            company_id: companyId,
            station_id: stationId,
            route_plan_id: routePlanId,
            field_executive_id: candidate.field_executive_id,
            roster_status: "replacement",
            replacement_for_id: assignment.data.field_executive_id,
            allocation_source: candidate.vehicle_type === route.vehicle_type || route.vehicle_type === "mixed" ? "backup_pool" : "cross_sector",
            is_cross_sector: candidate.vehicle_type !== route.vehicle_type && route.vehicle_type !== "mixed",
            created_by: authorization.userId
          }, { onConflict: "route_plan_id,field_executive_id" });
          if (replacement.error) throw new Error(replacement.error.message);
          replacementName = executive.full_name;
        }
      }
    }
    refresh();
  } catch (error) { finish(formData, { error: errorMessage(error) }); }
  finish(formData, { notice: replacementName ? `Absence recorded. ${replacementName} was allocated from the backup pool.` : "Absence recorded. No available matching backup FE was found." });
}

export async function saveBackupPoolMember(formData: FormData) {
  const authorization = await requirePagePermission("service_network", "edit");
  const companyId = requireCompanyId(authorization);
  try {
    const stationId = id(formData.get("station_id"), "Station");
    const fieldExecutiveId = id(formData.get("field_executive_id"), "Field Executive");
    await assertStationAccess(authorization, companyId, stationId);
    const fe = await database().from("workforce").select("id,vehicle_type").eq("company_id", companyId).eq("location_id", stationId).eq("id", fieldExecutiveId).eq("is_active", true).maybeSingle();
    if (fe.error) throw new Error(fe.error.message);
    if (!fe.data?.vehicle_type) throw new Error("Set the FE vehicle type before adding them to the backup pool.");
    const effectiveFrom = date(formData.get("effective_from"), "Effective from");
    const result = await database().from("ops_network_backup_pool").upsert({
      company_id: companyId,
      station_id: stationId,
      field_executive_id: fieldExecutiveId,
      vehicle_type: fe.data.vehicle_type,
      effective_from: effectiveFrom,
      effective_to: clean(formData.get("effective_to")) || null,
      priority: integer(formData.get("priority"), "Priority", 1),
      is_active: true,
      notes: clean(formData.get("notes")) || null,
      created_by: authorization.userId
    }, { onConflict: "company_id,station_id,field_executive_id,effective_from" });
    if (result.error) throw new Error(result.error.message);
    refresh();
  } catch (error) { finish(formData, { error: errorMessage(error) }); }
  finish(formData, { notice: "Backup FE pool updated." });
}

export async function delegateSectorPlanning(formData: FormData) {
  const authorization = await requirePagePermission("service_network", "edit");
  const companyId = requireCompanyId(authorization);
  try {
    const stationId = id(formData.get("station_id"), "Station");
    const sectorId = clean(formData.get("sector_id")) ? id(formData.get("sector_id"), "Sector") : null;
    const assignedToUserId = id(formData.get("assigned_to_user_id"), "Assignee");
    const effectiveFrom = date(formData.get("effective_from"), "Effective from");
    await assertStationAccess(authorization, companyId, stationId);
    if (["TEAM_LEADER", "SSA"].includes(String(authorization.roleCode ?? "").toUpperCase())) throw new Error("Only the Station Manager or a higher ops role can delegate planning authority.");
    const assignee = await database().from("profiles").select("id,location_scope_ids,user_roles(code,location_access_mode)").eq("company_id", companyId).eq("id", assignedToUserId).eq("is_active", true).maybeSingle();
    if (assignee.error) throw new Error(assignee.error.message);
    const assigneeRole = Array.isArray(assignee.data?.user_roles) ? assignee.data?.user_roles[0] : assignee.data?.user_roles;
    if (!assignee.data || !["TEAM_LEADER", "SSA"].includes(String(assigneeRole?.code ?? "").toUpperCase())) throw new Error("Delegation can be assigned only to an active TL or SSA.");
    if (assigneeRole?.location_access_mode !== "all_locations" && !(Array.isArray(assignee.data.location_scope_ids) && assignee.data.location_scope_ids.includes(stationId))) throw new Error("The assignee does not have access to this station.");
    const permissionLevel = clean(formData.get("permission_level"));
    if (!["view", "plan", "approve"].includes(permissionLevel)) throw new Error("Choose a valid delegation level.");
    const result = await database().from("ops_network_delegations").insert({
      company_id: companyId,
      station_id: stationId,
      sector_id: sectorId,
      delegated_by_user_id: authorization.userId,
      assigned_to_user_id: assignedToUserId,
      permission_level: permissionLevel,
      effective_from: effectiveFrom,
      effective_to: clean(formData.get("effective_to")) || null,
      reason: clean(formData.get("reason")) || null
    });
    if (result.error) throw new Error(result.error.message);
    refresh();
  } catch (error) { finish(formData, { error: errorMessage(error) }); }
  finish(formData, { notice: "Planning authority delegated." });
}

export async function reportVehicleIncident(formData: FormData) {
  const authorization = await requirePagePermission("service_network", "edit");
  const companyId = requireCompanyId(authorization);
  try {
    const stationId = id(formData.get("station_id"), "Station");
    const routePlanId = clean(formData.get("route_plan_id")) ? id(formData.get("route_plan_id"), "Route") : null;
    await assertStationAccess(authorization, companyId, stationId);
    if (routePlanId) {
      const route = await routeContext(companyId, stationId, routePlanId);
      await assertSectorAccess(authorization, companyId, stationId, route.sector_id, route.plan_date);
    }
    const vehicleType = clean(formData.get("vehicle_type"));
    const incidentType = clean(formData.get("incident_type"));
    if (!["bike", "van"].includes(vehicleType)) throw new Error("Choose the affected vehicle type.");
    if (!["breakdown", "accident", "unavailable", "capacity_restriction", "other"].includes(incidentType)) throw new Error("Choose an incident type.");
    const fieldExecutiveId = clean(formData.get("field_executive_id")) || null;
    if (fieldExecutiveId) {
      const executive = await database().from("workforce").select("id").eq("company_id", companyId).eq("location_id", stationId).eq("id", fieldExecutiveId).maybeSingle();
      if (executive.error) throw new Error(executive.error.message);
      if (!executive.data) throw new Error("The selected FE does not belong to this station.");
    }
    const result = await database().from("ops_vehicle_incidents").insert({
      company_id: companyId,
      station_id: stationId,
      route_plan_id: routePlanId,
      field_executive_id: fieldExecutiveId,
      incident_date: date(formData.get("incident_date"), "Incident date"),
      vehicle_type: vehicleType,
      incident_type: incidentType,
      status: "open",
      details: clean(formData.get("details")) || null,
      reported_by: authorization.userId
    });
    if (result.error) throw new Error(result.error.message);
    refresh();
  } catch (error) { finish(formData, { error: errorMessage(error) }); }
  finish(formData, { notice: "Vehicle exception recorded and added to the control tower." });
}

export async function updateRouteStatus(formData: FormData) {
  const authorization = await requirePagePermission("service_network", "edit");
  const companyId = requireCompanyId(authorization);
  try {
    const stationId = id(formData.get("station_id"), "Station");
    const routePlanId = id(formData.get("route_plan_id"), "Route");
    await assertStationAccess(authorization, companyId, stationId);
    const route = await routeContext(companyId, stationId, routePlanId);
    await assertSectorAccess(authorization, companyId, stationId, route.sector_id, route.plan_date);
    const status = clean(formData.get("status"));
    if (!["draft", "published", "in_progress", "completed", "cancelled"].includes(status)) throw new Error("Choose a valid route status.");
    const result = await database().from("ops_route_plans").update({ status, change_reason: clean(formData.get("change_reason")) || null }).eq("company_id", companyId).eq("station_id", stationId).eq("id", routePlanId);
    if (result.error) throw new Error(result.error.message);
    refresh();
  } catch (error) { finish(formData, { error: errorMessage(error) }); }
  finish(formData, { notice: "Route status updated." });
}

export async function saveWeeklyRosterTemplate(formData: FormData) {
  const authorization = await requirePagePermission("service_network", "edit");
  const companyId = requireCompanyId(authorization);
  try {
    const stationId = id(formData.get("station_id"), "Station");
    const weekStart = startOfPlanningWeek(date(formData.get("week"), "Week"));
    await assertStationAccess(authorization, companyId, stationId);
    const weekEndDate = new Date(`${weekStart}T00:00:00Z`); weekEndDate.setUTCDate(weekEndDate.getUTCDate() + 6);
    const weekEnd = weekEndDate.toISOString().slice(0, 10);
    const routeResult = await database().from("ops_route_plans").select("id,sector_id,plan_date,route_code,route_name,pincodes,expected_volume,vehicle_type,shift_code,planned_start_time,planned_end_time,capacity_override,status,is_temporary,notes").eq("company_id", companyId).eq("station_id", stationId).gte("plan_date", weekStart).lte("plan_date", weekEnd).neq("status", "cancelled");
    if (routeResult.error) throw new Error(routeResult.error.message);
    const routeIds = (routeResult.data ?? []).map(row => row.id);
    const rosterResult = routeIds.length ? await database().from("ops_route_roster").select("route_plan_id,field_executive_id,shift_code").in("route_plan_id", routeIds).not("roster_status", "in", "(released,leave,absent)") : { data: [], error: null };
    if (rosterResult.error) throw new Error(rosterResult.error.message);
    const start = new Date(`${weekStart}T00:00:00Z`);
    const payload = {
      routes: (routeResult.data ?? []).map(route => ({
        dayOffset: Math.round((new Date(`${route.plan_date}T00:00:00Z`).getTime() - start.getTime()) / 86400000),
        sectorId: route.sector_id,
        routeCode: route.route_code,
        routeName: route.route_name,
        pincodes: route.pincodes,
        expectedVolume: route.expected_volume,
        vehicleType: route.vehicle_type,
        shiftCode: route.shift_code,
        plannedStartTime: route.planned_start_time,
        plannedEndTime: route.planned_end_time,
        capacityOverride: route.capacity_override,
        isTemporary: route.is_temporary,
        notes: route.notes,
        fieldExecutiveIds: (rosterResult.data ?? []).filter(item => item.route_plan_id === route.id).map(item => item.field_executive_id)
      }))
    };
    const name = clean(formData.get("template_name"));
    if (!name) throw new Error("Template name is required.");
    const result = await database().from("ops_weekly_roster_templates").upsert({ company_id: companyId, station_id: stationId, name, sector_id: clean(formData.get("sector_id")) || null, template_payload: payload, is_default: bool(formData.get("is_default")), is_active: true, created_by: authorization.userId }, { onConflict: "company_id,station_id,name" });
    if (result.error) throw new Error(result.error.message);
    refresh();
  } catch (error) { finish(formData, { error: errorMessage(error) }); }
  finish(formData, { notice: "Weekly roster template saved." });
}

export async function applyWeeklyRosterTemplate(formData: FormData) {
  const authorization = await requirePagePermission("service_network", "edit");
  const companyId = requireCompanyId(authorization);
  try {
    const stationId = id(formData.get("station_id"), "Station");
    const templateId = id(formData.get("template_id"), "Template");
    const weekStart = startOfPlanningWeek(date(formData.get("week"), "Week"));
    await assertStationAccess(authorization, companyId, stationId);
    const templateResult = await database().from("ops_weekly_roster_templates").select("template_payload").eq("company_id", companyId).eq("station_id", stationId).eq("id", templateId).eq("is_active", true).maybeSingle();
    if (templateResult.error) throw new Error(templateResult.error.message);
    if (!templateResult.data) throw new Error("Roster template was not found.");
    const payload = templateResult.data.template_payload as { routes?: Array<Record<string, unknown>> };
    const routes = Array.isArray(payload?.routes) ? payload.routes : [];
    for (const route of routes) {
      const sectorId = String(route.sectorId ?? "");
      const target = new Date(`${weekStart}T00:00:00Z`); target.setUTCDate(target.getUTCDate() + Math.max(0, Math.min(6, Number(route.dayOffset ?? 0))));
      const planDate = target.toISOString().slice(0, 10);
      await assertSectorAccess(authorization, companyId, stationId, sectorId, planDate);
      const inserted = await database().from("ops_route_plans").upsert({
        company_id: companyId, station_id: stationId, sector_id: sectorId, plan_date: planDate,
        route_code: String(route.routeCode ?? "").toUpperCase(), route_name: String(route.routeName ?? "Route"),
        pincodes: Array.isArray(route.pincodes) ? route.pincodes : [], expected_volume: numberFromUnknown(route.expectedVolume),
        vehicle_type: String(route.vehicleType ?? "bike"), shift_code: String(route.shiftCode ?? "general"),
        planned_start_time: route.plannedStartTime || null, planned_end_time: route.plannedEndTime || null,
        capacity_override: numberFromUnknown(route.capacityOverride) || null, status: "draft", is_temporary: Boolean(route.isTemporary),
        notes: route.notes ? String(route.notes) : null, created_by: authorization.userId
      }, { onConflict: "company_id,station_id,plan_date,route_code" }).select("id").single();
      if (inserted.error) throw new Error(inserted.error.message);
      const fieldExecutiveIds = Array.isArray(route.fieldExecutiveIds) ? route.fieldExecutiveIds.map(String).filter(Boolean) : [];
      if (fieldExecutiveIds.length) {
        const roster = await database().from("ops_route_roster").upsert(fieldExecutiveIds.map(fieldExecutiveId => ({ company_id: companyId, station_id: stationId, route_plan_id: inserted.data.id, field_executive_id: fieldExecutiveId, roster_status: "planned", allocation_source: "manual", shift_code: String(route.shiftCode ?? "general"), created_by: authorization.userId })), { onConflict: "route_plan_id,field_executive_id" });
        if (roster.error) throw new Error(roster.error.message);
      }
    }
    refresh();
  } catch (error) { finish(formData, { error: errorMessage(error) }); }
  finish(formData, { notice: "Template applied as a draft week. Review capacity and publish when ready." });
}

function numberFromUnknown(value: unknown) {
  const result = Number(value ?? 0);
  return Number.isFinite(result) && result >= 0 ? Math.round(result) : 0;
}
