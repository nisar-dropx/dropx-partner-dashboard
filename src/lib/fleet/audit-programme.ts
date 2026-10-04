import "server-only";

import { auditProgrammeFromRiskWeights, type FleetAuditProgrammeConfig } from "@/lib/fleet/audit-programme-config";
import { supabaseAdmin } from "@/lib/supabase-admin";

type Vehicle = { id: string; vehicle_no: string; station_code: string; status: string | null };
type Station = { station_code: string; latitude: number | string | null; longitude: number | string | null };
type ExistingAudit = { id: string; vehicle_id: string; scheduled_for: string; scheduled_reason: string | null; status: string; assigned_to: string | null };

const clean = (value: unknown) => String(value ?? "").trim();
const modeOf = (reason: unknown) => /^\[mode:video\]/i.test(clean(reason)) ? "video" as const : "physical" as const;
const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;
const dateString = (year: number, month: number, day: number) => `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

function distance(a?: Station, b?: Station) {
  const values = [a?.latitude, a?.longitude, b?.latitude, b?.longitude].map(Number);
  if (values.some((value) => !Number.isFinite(value))) return a?.station_code === b?.station_code ? 0 : 1;
  const [lat1, lon1, lat2, lon2] = values.map((value) => value * Math.PI / 180);
  const h = Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function eligibleDates(month: string, config: FleetAuditProgrammeConfig, leaveDates: Set<string>) {
  const [year, monthNumber] = month.split("-").map(Number);
  const days = new Date(year, monthNumber, 0).getDate();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const startDay = today.startsWith(month) ? Math.min(days, Number(today.slice(8, 10))) : 1;
  const result: string[] = [];
  for (let day = startDay; day <= days; day += 1) {
    const value = dateString(year, monthNumber, day);
    const weekday = new Date(`${value}T12:00:00+05:30`).getDay();
    if (!config.excludedWeekdays.includes(weekday) && !leaveDates.has(value)) result.push(value);
  }
  return result;
}

async function inspectorContext(companyId: string, month: string, enabled: boolean) {
  const membership = await supabaseAdmin!.from("fleet_portal_memberships").select("user_id,access_level,profiles:user_id(email)").eq("company_id", companyId).eq("is_active", true).in("access_level", ["administrator", "approver"]).order("created_at").limit(1).maybeSingle();
  const userId = membership.data?.user_id ?? null;
  if (!enabled || !userId) return { userId, leaveDates: new Set<string>() };
  const profile = Array.isArray((membership.data as any)?.profiles) ? (membership.data as any).profiles[0] : (membership.data as any)?.profiles;
  const email = clean(profile?.email).toLowerCase();
  if (!email) return { userId, leaveDates: new Set<string>() };
  const employee = await supabaseAdmin!.from("employees").select("id").eq("company_id", companyId).ilike("email", email).eq("is_active", true).maybeSingle();
  if (!employee.data?.id) return { userId, leaveDates: new Set<string>() };
  const [year, monthNumber] = month.split("-").map(Number);
  const monthEnd = dateString(year, monthNumber, new Date(year, monthNumber, 0).getDate());
  const leaves = await supabaseAdmin!.from("hr_leave_requests").select("start_date,end_date").eq("company_id", companyId).eq("employee_id", employee.data.id).eq("status", "approved").lte("start_date", monthEnd).gte("end_date", `${month}-01`);
  const dates = new Set<string>();
  for (const leave of leaves.data ?? []) {
    const cursor = new Date(`${leave.start_date}T12:00:00+05:30`); const end = new Date(`${leave.end_date}T12:00:00+05:30`);
    while (cursor <= end) { const value = cursor.toISOString().slice(0, 10); if (value.startsWith(month)) dates.add(value); cursor.setDate(cursor.getDate() + 1); }
  }
  return { userId, leaveDates: dates };
}

export async function generateFleetAuditProgramme(companyId: string, month: string, actorUserId?: string | null) {
  if (!supabaseAdmin) throw new Error("Database service is unavailable.");
  if (!monthPattern.test(month)) throw new Error("Audit month must be YYYY-MM.");
  const [year, monthNumber] = month.split("-").map(Number);
  const nextMonthDate = new Date(year, monthNumber, 1);
  const nextMonth = `${nextMonthDate.getFullYear()}-${String(nextMonthDate.getMonth() + 1).padStart(2, "0")}-01`;
  const [settings, vehiclesResult, auditsResult, stationsResult, templateResult] = await Promise.all([
    supabaseAdmin.from("fleet_control_settings").select("risk_weights").eq("company_id", companyId).maybeSingle(),
    supabaseAdmin.from("fleet_vehicles").select("id,vehicle_no,station_code,status").eq("company_id", companyId).order("station_code").order("vehicle_no"),
    supabaseAdmin.from("fleet_audits").select("id,vehicle_id,scheduled_for,scheduled_reason,status,assigned_to").eq("company_id", companyId).gte("scheduled_for", `${month}-01`).lt("scheduled_for", nextMonth),
    supabaseAdmin.from("stations").select("station_code,latitude,longitude").eq("company_id", companyId),
    supabaseAdmin.from("fleet_audit_templates").select("id").eq("company_id", companyId).eq("is_default", true).eq("is_active", true).maybeSingle()
  ]);
  const firstError = [settings, vehiclesResult, auditsResult, stationsResult, templateResult].find((result) => result.error)?.error;
  if (firstError) throw new Error(firstError.message);
  const config = auditProgrammeFromRiskWeights(settings.data?.risk_weights);
  if (!config.enabled) return { created: 0, moved: 0, vehicles: 0, message: "Automatic audit scheduling is on hold in Settings." };
  const vehicles = (vehiclesResult.data ?? []).filter((vehicle: Vehicle) => !["sold", "disposed", "returned"].includes(clean(vehicle.status).toLowerCase())) as Vehicle[];
  const existing = (auditsResult.data ?? []) as ExistingAudit[];
  const inspector = await inspectorContext(companyId, month, config.autoMoveForLeave);
  const dates = eligibleDates(month, config, inspector.leaveDates);
  if (!dates.length) throw new Error("No eligible audit date remains in this month after Sunday and approved-leave exclusions.");
  const stations = new Map((stationsResult.data ?? []).map((station: Station) => [clean(station.station_code).toUpperCase(), station]));
  const byStation = new Map<string, Vehicle[]>();
  for (const vehicle of vehicles) { const code = clean(vehicle.station_code).toUpperCase() || "UNASSIGNED"; const list = byStation.get(code) ?? []; list.push(vehicle); byStation.set(code, list); }
  const stationCodes = [...byStation.keys()].sort();
  const rows: Record<string, unknown>[] = [];
  const physicalAssignments = new Map<string, string>();
  let physicalCursor = 0;
  for (const stationCode of stationCodes) {
    const stationVehicles = byStation.get(stationCode) ?? [];
    for (let index = 0; index < stationVehicles.length; index += 1) {
      const vehicle = stationVehicles[index];
      if (existing.some((audit) => audit.vehicle_id === vehicle.id && modeOf(audit.scheduled_reason) === "physical" && audit.status !== "cancelled")) continue;
      const slot = Math.floor(index / config.maxPhysicalPerDay);
      const scheduledFor = dates[(physicalCursor + slot) % dates.length];
      physicalAssignments.set(vehicle.id, scheduledFor);
      rows.push({ company_id: companyId, vehicle_id: vehicle.id, template_id: templateResult.data?.id ?? null, scheduled_for: scheduledFor, scheduled_reason: `[mode:physical] Auto programme · station visit ${stationCode}`, risk_score: 0, status: "scheduled", assigned_to: inspector.userId, created_by: actorUserId || inspector.userId });
    }
    physicalCursor += Math.max(1, Math.ceil(stationVehicles.length / config.maxPhysicalPerDay));
  }
  const physicalDays = [...new Set([...existing.filter((audit) => modeOf(audit.scheduled_reason) === "physical" && audit.status !== "cancelled").map((audit) => audit.scheduled_for), ...physicalAssignments.values()])];
  let virtualCursor = 0;
  const virtualByDate = new Map<string, number>();
  existing.filter((audit) => modeOf(audit.scheduled_reason) === "video" && audit.status !== "cancelled").forEach((audit) => virtualByDate.set(audit.scheduled_for, (virtualByDate.get(audit.scheduled_for) ?? 0) + 1));
  const physicalStationForDate = (value: string) => vehicles.find((vehicle) => physicalAssignments.get(vehicle.id) === value)?.station_code;
  for (const vehicle of vehicles) {
    if (existing.some((audit) => audit.vehicle_id === vehicle.id && modeOf(audit.scheduled_reason) === "video" && audit.status !== "cancelled")) continue;
    const origin = stations.get(clean(vehicle.station_code).toUpperCase());
    const ranked = (physicalDays.length ? physicalDays : dates).map((scheduledFor) => ({ scheduledFor, physicalStation: physicalStationForDate(scheduledFor) })).sort((left, right) => {
      const leftDistance = distance(origin, stations.get(clean(left.physicalStation).toUpperCase()));
      const rightDistance = distance(origin, stations.get(clean(right.physicalStation).toUpperCase()));
      return rightDistance - leftDistance;
    });
    const available = ranked.filter((candidate) => (virtualByDate.get(candidate.scheduledFor) ?? 0) < config.maxVirtualPerDay);
    const scheduledFor = (available.length ? available : ranked)[virtualCursor % (available.length || ranked.length)]?.scheduledFor ?? dates[virtualCursor % dates.length];
    virtualCursor += 1;
    virtualByDate.set(scheduledFor, (virtualByDate.get(scheduledFor) ?? 0) + 1);
    rows.push({ company_id: companyId, vehicle_id: vehicle.id, template_id: templateResult.data?.id ?? null, scheduled_for: scheduledFor, scheduled_reason: `[mode:video] Auto programme · remote review paired with physical route`, risk_score: 0, status: "scheduled", assigned_to: inspector.userId, created_by: actorUserId || inspector.userId });
  }
  if (rows.length) { const inserted = await supabaseAdmin.from("fleet_audits").insert(rows); if (inserted.error) throw new Error(inserted.error.message); }
  let moved = 0;
  if (config.autoMoveForLeave) {
    for (const audit of existing.filter((item) => item.status === "scheduled" && (config.excludedWeekdays.includes(new Date(`${item.scheduled_for}T12:00:00+05:30`).getDay()) || inspector.leaveDates.has(item.scheduled_for)))) {
      const next = dates.find((date) => date > audit.scheduled_for) ?? dates[0];
      if (next && next !== audit.scheduled_for) { const update = await supabaseAdmin.from("fleet_audits").update({ scheduled_for: next, scheduled_reason: `${clean(audit.scheduled_reason).replace(/\s*\[auto-moved:[^\]]+\]/g, "")} [auto-moved:${audit.scheduled_for}]`, updated_at: new Date().toISOString() }).eq("company_id", companyId).eq("id", audit.id).eq("status", "scheduled"); if (!update.error) moved += 1; }
    }
  }
  return { created: rows.length, moved, vehicles: vehicles.length, message: `${rows.length} missing audit slot${rows.length === 1 ? "" : "s"} scheduled for ${vehicles.length} vehicles${moved ? `; ${moved} moved around Sunday or approved leave` : ""}.` };
}
