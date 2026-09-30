import { NextResponse } from "next/server";
import { type AuthorizationContext, getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { writeEventLog } from "@/lib/event-log";
import { supabaseAdmin } from "@/lib/supabase-admin";

const editableFields = [
  "vehicle_no",
  "station_code",
  "rc_location",
  "model",
  "fuel_type",
  "ownership_type",
  "registration_expiry",
  "insurance_expiry",
  "puc_expiry",
  "fitness_expiry",
  "tax_expiry",
  "status",
  "non_operational_since",
  "expected_operational_date",
  "status_comment",
  "transfer_date",
  "sale_date",
  "dispose_date"
] as const;

export async function POST(request: Request) {
  if (!supabaseAdmin) return setupError("Supabase service role key is not configured.");
  const access = await requireFleetMutationPermission("add");
  if ("error" in access) return access.error;
  const body = await request.json();
  const payload: Record<string, string | null> = { ...sanitizePayload(body), company_id: access.companyId };
  if (!payload.status) payload.status = "active";
  if (!payload.ownership_type) payload.ownership_type = "own";
  if (!payload.vehicle_no) return NextResponse.json({ error: "Vehicle number is required." }, { status: 400 });
  if (!payload.station_code) return NextResponse.json({ error: "Location is required." }, { status: 400 });
  if (!payload.model) return NextResponse.json({ error: "Model is required." }, { status: 400 });
  if (!payload.fuel_type) return NextResponse.json({ error: "Fuel type is required." }, { status: 400 });
  if (!canAccessStation(access.stationCodes, payload.station_code)) {
    return NextResponse.json({ error: "This location is not allocated to your user." }, { status: 403 });
  }

  const { data, error } = await supabaseAdmin
    .from("fleet_vehicles")
    .insert(payload)
    .select()
    .single();

  if (error) return mutationError(error.message);
  return NextResponse.json({ vehicle: data });
}

export async function PATCH(request: Request) {
  if (!supabaseAdmin) return setupError("Supabase service role key is not configured.");
  const access = await requireFleetMutationPermission("edit");
  if ("error" in access) return access.error;
  const body = await request.json();
  const vehicleNo = normalizeText(body.vehicle_no).toUpperCase();
  if (!vehicleNo) return NextResponse.json({ error: "Vehicle number is required." }, { status: 400 });

  const payload = sanitizePayload(body);
  delete payload.vehicle_no;
  const guard = await requireVehicleScope(access.companyId, vehicleNo, access.stationCodes);
  if ("error" in guard) return guard.error;
  if (payload.station_code && !canAccessStation(access.stationCodes, payload.station_code)) {
    return NextResponse.json({ error: "This location is not allocated to your user." }, { status: 403 });
  }
  if (payload.status) {
    const active = payload.status === "active";
    payload.status_comment = active ? null : (payload.status_comment || normalizeText(body.status_reason) || null);
    payload.non_operational_since = active ? null : (payload.non_operational_since || new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()));
    payload.expected_operational_date = active ? null : (payload.expected_operational_date || null);
  }

  let { data, error } = await supabaseAdmin
    .from("fleet_vehicles")
    .update({ ...payload, ...(payload.status ? { status_updated_at: new Date().toISOString(), status_updated_by: access.authorization.userId } : {}), updated_at: new Date().toISOString() })
    .eq("company_id", access.companyId)
    .eq("vehicle_no", vehicleNo)
    .select()
    .single();

  if (error && isMissingActionDateColumn(error.message)) {
    const fallbackPayload = { ...payload };
    delete fallbackPayload.transfer_date;
    delete fallbackPayload.sale_date;
    delete fallbackPayload.dispose_date;
    const fallback = await supabaseAdmin
      .from("fleet_vehicles")
      .update({ ...fallbackPayload, updated_at: new Date().toISOString() })
      .eq("company_id", access.companyId)
      .eq("vehicle_no", vehicleNo)
      .select()
      .single();
    data = fallback.data;
    error = fallback.error;
  }

  if (error) return mutationError(error.message);
  const fromStation = normalizeText(guard.vehicle.station_code).toUpperCase() || "UNASSIGNED";
  const toStation = normalizeText(data?.station_code).toUpperCase() || fromStation;
  if (fromStation !== toStation) {
    await writeEventLog({
      companyId: access.companyId,
      platform: "dashboard",
      eventCode: "fleet_vehicle_transferred",
      module: "fleet",
      action: "update",
      outcome: "success",
      actorType: "fleet_user",
      actorUserId: access.authorization.userId,
      actorLabel: access.authorization.fullName || access.authorization.email,
      actorIdentifier: access.authorization.email,
      subjectType: "fleet_vehicle",
      subjectId: guard.vehicle.id,
      subjectCode: vehicleNo,
      subjectLabel: vehicleNo,
      route: "/api/fleet/vehicles",
      method: "PATCH",
      metadata: { from_station: fromStation, to_station: toStation, reason: normalizeText(body.transfer_reason) || "Placement changed in Fleet" },
      request
    });
  }
  const fromStatus = normalizeText(guard.vehicle.status).toLowerCase();
  const toStatus = normalizeText(data?.status).toLowerCase() || fromStatus;
  if (fromStatus !== toStatus) {
    await writeEventLog({
      companyId: access.companyId,
      platform: "dashboard",
      eventCode: "fleet_vehicle_status_changed",
      module: "fleet",
      action: "update",
      outcome: "success",
      actorType: "fleet_user",
      actorUserId: access.authorization.userId,
      actorLabel: access.authorization.fullName || access.authorization.email,
      actorIdentifier: access.authorization.email,
      subjectType: "fleet_vehicle",
      subjectId: guard.vehicle.id,
      subjectCode: vehicleNo,
      subjectLabel: vehicleNo,
      route: "/api/fleet/vehicles",
      method: "PATCH",
      metadata: { from_status: fromStatus, to_status: toStatus, reason: normalizeText(body.status_reason) || "Status changed in Fleet" },
      request
    });
  }
  return NextResponse.json({ vehicle: data });
}

export async function DELETE(request: Request) {
  if (!supabaseAdmin) return setupError("Supabase service role key is not configured.");
  const access = await requireFleetMutationPermission("edit");
  if ("error" in access) return access.error;
  const { searchParams } = new URL(request.url);
  const vehicleNo = normalizeText(searchParams.get("vehicle_no")).toUpperCase();
  if (!vehicleNo) return NextResponse.json({ error: "Vehicle number is required." }, { status: 400 });
  const guard = await requireVehicleScope(access.companyId, vehicleNo, access.stationCodes);
  if ("error" in guard) return guard.error;

  const { error } = await supabaseAdmin
    .from("fleet_vehicles")
    .delete()
    .eq("company_id", access.companyId)
    .eq("vehicle_no", vehicleNo);

  if (error) return mutationError(error.message);
  return NextResponse.json({ ok: true });
}

async function requireFleetMutationPermission(action: "add" | "edit") {
  const authorization = await getAuthorization();
  if (!authorization) return { error: NextResponse.json({ error: "Login required." }, { status: 401 }) };
  const companyId = requireCompanyId(authorization);
  const allowed = action === "add"
    ? hasPermission(authorization, "fleet_vehicle_view", "add") || hasPermission(authorization, "fleet", "add")
    : hasPermission(authorization, "fleet_vehicle_view", "edit") || hasPermission(authorization, "fleet_date_view", "edit") || hasPermission(authorization, "fleet", "edit");
  if (!allowed) return { error: NextResponse.json({ error: "Fleet permission denied." }, { status: 403 }) };
  return { companyId, authorization, stationCodes: await resolveFleetLocationAccess(authorization, companyId) };
}

async function resolveFleetLocationAccess(authorization: AuthorizationContext, companyId: string) {
  if (authorization.isMasterOwner || authorization.hasAllLocationAccess) return null;
  if (!supabaseAdmin || !authorization.locationScopeIds.length) return [];

  const { data, error } = await supabaseAdmin
    .from("stations")
    .select("station_code")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .in("id", authorization.locationScopeIds);

  if (error) return [];
  return Array.from(new Set((data ?? [])
    .map((row) => String(row.station_code ?? "").trim().toUpperCase())
    .filter(Boolean)));
}

function canAccessStation(stationCodes: string[] | null, stationCode: string | null) {
  if (!stationCodes) return true;
  return stationCodes.includes(String(stationCode ?? "").trim().toUpperCase());
}

async function requireVehicleScope(companyId: string, vehicleNo: string, stationCodes: string[] | null) {
  if (!supabaseAdmin) return { error: setupError("Supabase service role key is not configured.") };
  const { data, error } = await supabaseAdmin
    .from("fleet_vehicles")
    .select("id,station_code,status,non_operational_since,expected_operational_date,status_comment")
    .eq("company_id", companyId)
    .eq("vehicle_no", vehicleNo)
    .maybeSingle();

  if (error) return { error: mutationError(error.message) };
  if (!data) return { error: NextResponse.json({ error: "Vehicle not found." }, { status: 404 }) };
  if (stationCodes && !canAccessStation(stationCodes, data.station_code)) {
    return { error: NextResponse.json({ error: "This vehicle is not allocated to your user." }, { status: 403 }) };
  }
  return { ok: true, vehicle: data };
}

function sanitizePayload(input: Record<string, unknown>) {
  const payload: Record<string, string | null> = {};
  editableFields.forEach((field) => {
    if (!(field in input)) return;
    const value = normalizeText(input[field]);
    payload[field] = value || null;
  });
  if (payload.vehicle_no) payload.vehicle_no = payload.vehicle_no.toUpperCase();
  if (payload.station_code) payload.station_code = payload.station_code.toUpperCase();
  return payload;
}

function normalizeText(value: unknown) {
  return String(value ?? "").trim();
}

function setupError(error: string) {
  return NextResponse.json({ error }, { status: 500 });
}

function mutationError(error: string) {
  if (error.includes("fleet_vehicles")) {
    return NextResponse.json({ error: `${error} Run scripts/fleet_vehicles_v1.sql in Supabase SQL Editor.` }, { status: 500 });
  }
  return NextResponse.json({ error }, { status: 500 });
}

function isMissingActionDateColumn(error: string) {
  return ["transfer_date", "sale_date", "dispose_date"].some((field) => error.includes(field));
}
