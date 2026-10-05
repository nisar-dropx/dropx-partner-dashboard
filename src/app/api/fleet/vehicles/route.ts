import { withFleetSystemLog } from "@/lib/fleet/system-log";
import { resolveVehicleSource } from "@/lib/fleet/vehicle-sources-server";
import { parseVehicleContact } from "@/lib/fleet/vehicle-contact";
import { deploymentDateError } from "@/lib/fleet/source-policy";
import { parseVehicleRent } from "@/lib/fleet/vehicle-rent";
import { NextResponse } from "next/server";
import { type AuthorizationContext, getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { writeEventLog } from "@/lib/event-log";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { hasActiveFleetMembership } from "@/lib/fleet-control";

const editableFields = [
  "vehicle_no",
  "station_code",
  "rc_location",
  "model",
  "fuel_type",
  "ownership_type",
  "source_id",
  "registration_expiry",
  "insurance_expiry",
  "puc_expiry",
  "fitness_expiry",
  "tax_expiry",
  "status",
  "non_operational_since",
  "expected_operational_date",
  "status_comment",
  "status_reason_id",
  "status_reason_key",
  "deployment_status",
  "deployment_date",
  "current_location_type",
  "current_location_code",
  "current_location_label",
  "transfer_date",
  "sale_date",
  "dispose_date"
] as const;

async function handlePOST(request: Request) {
  if (!supabaseAdmin) return setupError("Supabase service role key is not configured.");
  const access = await requireFleetMutationPermission("add");
  if ("error" in access) return access.error;
  const body = await request.json();
  if (body.source_id) {
    try { body.ownership_type=await resolveVehicleSource(access.companyId,String(body.source_id)); }
    catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Invalid source."},{status:400});}
  }
  const contact = parseVehicleContact(body);
  if (contact.error) return NextResponse.json({error:contact.error},{status:400});
  const rent = parseVehicleRent(body);
  if (rent.error) return NextResponse.json({ error: rent.error }, { status: 400 });
  const payload: Record<string, string | null> = { ...sanitizePayload(body), ...rent.values, ...contact.values, company_id: access.companyId };
  const dateError = deploymentDateError(payload.deployment_date ?? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()), new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()));
  if (dateError) return NextResponse.json({error:dateError},{status:400});
  if (!payload.status) payload.status = "active";
  if (!payload.ownership_type) payload.ownership_type = "own";
  if (!payload.vehicle_no) return NextResponse.json({ error: "Vehicle number is required." }, { status: 400 });
  if (!payload.station_code) return NextResponse.json({ error: "Location is required." }, { status: 400 });
  if (!payload.model) payload.model = "";
  if (!payload.fuel_type) return NextResponse.json({ error: "Fuel type is required." }, { status: 400 });
  if (!payload.deployment_status) payload.deployment_status = "deployed";
  if (!payload.current_location_type) payload.current_location_type = "station";
  if (!payload.current_location_code) payload.current_location_code = payload.station_code;
  if (!payload.current_location_label) payload.current_location_label = payload.station_code;
  if (!canAccessStation(access.stationCodes, payload.station_code)) {
    return NextResponse.json({ error: "This location is not allocated to your user." }, { status: 403 });
  }

  const statusPolicy = await supabaseAdmin.from("fleet_vehicle_status_master").select("id,is_operational,requires_reason,requires_expected_date").eq("company_id",access.companyId).eq("status_key",payload.status).eq("is_active",true).maybeSingle();
  if(statusPolicy.error) return mutationError(statusPolicy.error.message);
  if(!statusPolicy.data) return NextResponse.json({error:"Choose an active status from Fleet Masters."},{status:400});
  if(statusPolicy.data.requires_expected_date && !payload.expected_operational_date) return NextResponse.json({error:"Expected return date is required."},{status:400});
  if(statusPolicy.data.requires_reason) {
    const reason=await supabaseAdmin.from("fleet_vehicle_status_reason_master").select("id,reason_key").eq("company_id",access.companyId).eq("status_id",statusPolicy.data.id).eq("id",payload.status_reason_id || "00000000-0000-0000-0000-000000000000").eq("is_active",true).maybeSingle();
    if(reason.error || !reason.data) return NextResponse.json({error:"Choose a valid status reason."},{status:400});
    payload.status_reason_key=reason.data.reason_key;
  }
  if(!statusPolicy.data.is_operational) payload.non_operational_since ||= new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Kolkata"}).format(new Date());

  const { data, error } = await supabaseAdmin
    .from("fleet_vehicles")
    .insert({ ...payload, current_location_updated_at: new Date().toISOString(), current_location_updated_by: access.authorization.userId })
    .select()
    .single();

  if (error) return mutationError(error.message);
  return NextResponse.json({ vehicle: data });
}

async function handlePATCH(request: Request) {
  if (!supabaseAdmin) return setupError("Supabase service role key is not configured.");
  const access = await requireFleetMutationPermission("edit");
  if ("error" in access) return access.error;
  const body = await request.json();
  if (body.source_id) {
    try { body.ownership_type=await resolveVehicleSource(access.companyId,String(body.source_id)); }
    catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Invalid source."},{status:400});}
  }
  const contact = parseVehicleContact(body);
  if (contact.error) return NextResponse.json({error:contact.error},{status:400});
  const rent = parseVehicleRent(body);
  if (rent.error) return NextResponse.json({ error: rent.error }, { status: 400 });
  const vehicleNo = normalizeText(body.vehicle_no).toUpperCase();
  if (!vehicleNo) return NextResponse.json({ error: "Vehicle number is required." }, { status: 400 });

  const payload = { ...sanitizePayload(body), ...rent.values, ...contact.values };
  delete payload.vehicle_no;
  if ("deployment_date" in payload) {
    const dateError=deploymentDateError(payload.deployment_date,new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Kolkata"}).format(new Date()));
    if(dateError)return NextResponse.json({error:dateError},{status:400});
  }
  const guard = await requireVehicleScope(access.companyId, vehicleNo, access.stationCodes);
  if ("error" in guard) return guard.error;
  if (normalizeText(body.registration_number)) {
    if(!vehicleNo.startsWith("PENDING-"))return NextResponse.json({error:"Registration can be completed here only for a pending entry."},{status:400});
    const registration=normalizeText(body.registration_number).replace(/\s/g,"").toUpperCase();
    if(!/^[A-Z0-9]{6,20}$/.test(registration))return NextResponse.json({error:"Enter the actual vehicle registration number."},{status:400});
    payload.vehicle_no=registration;
  }
  if (payload.station_code && !canAccessStation(access.stationCodes, payload.station_code)) {
    return NextResponse.json({ error: "This location is not allocated to your user." }, { status: 403 });
  }
  if (payload.deployment_status && !["deployed", "not_deployed"].includes(payload.deployment_status)) {
    return NextResponse.json({ error: "Choose Deployed or Not deployed." }, { status: 400 });
  }
  if (payload.current_location_type && !["station", "ho", "workshop", "in_transit", "other"].includes(payload.current_location_type)) {
    return NextResponse.json({ error: "Choose a valid current location type." }, { status: 400 });
  }
  if (("deployment_status" in payload || "current_location_type" in payload || "current_location_label" in payload) && !payload.current_location_label) {
    return NextResponse.json({ error: "Enter where the vehicle is currently located." }, { status: 400 });
  }
  if (payload.status) {
    const definition = await supabaseAdmin.from("fleet_vehicle_status_master").select("id,status_key,label,is_operational,requires_reason,requires_expected_date").eq("company_id", access.companyId).eq("status_key", payload.status).eq("is_active", true).maybeSingle();
    if (definition.error) return mutationError(definition.error.message);
    if (!definition.data) return NextResponse.json({ error: "Choose an active status from Fleet Masters." }, { status: 400 });
    const operational = Boolean(definition.data.is_operational);
    let reason: { id: string; reason_key: string; label: string } | null = null;
    const reasonId = normalizeText(body.status_reason_id);
    if (!operational && reasonId) {
      const result = await supabaseAdmin.from("fleet_vehicle_status_reason_master").select("id,reason_key,label").eq("company_id", access.companyId).eq("status_id", definition.data.id).eq("id", reasonId).eq("is_active", true).maybeSingle();
      if (result.error) return mutationError(result.error.message);
      reason = result.data;
    }
    if (!operational && definition.data.requires_reason && !reason) return NextResponse.json({ error: `Choose a reason for ${definition.data.label}.` }, { status: 400 });
    payload.status_reason_id = operational ? null : reason?.id ?? null;
    payload.status_reason_key = operational ? null : reason?.reason_key ?? null;
    payload.status_comment = operational ? null : (payload.status_comment || null);
    payload.non_operational_since = operational ? null : (payload.non_operational_since || new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()));
    payload.expected_operational_date = operational ? null : (payload.expected_operational_date || null);
    if (!operational && definition.data.requires_expected_date && !payload.expected_operational_date) return NextResponse.json({ error: `Expected operational date is required for ${definition.data.label}.` }, { status: 400 });
    body.status_reason_label = reason?.label ?? "";
  }

  let { data, error } = await supabaseAdmin
    .from("fleet_vehicles")
    .update({ ...payload, ...(payload.status ? { status_updated_at: new Date().toISOString(), status_updated_by: access.authorization.userId } : {}), ...(("deployment_status" in payload || "current_location_type" in payload || "current_location_label" in payload) ? { current_location_updated_at: new Date().toISOString(), current_location_updated_by: access.authorization.userId } : {}), updated_at: new Date().toISOString() })
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
  const fromDeployment = normalizeText(guard.vehicle.deployment_status) || "deployed";
  const toDeployment = normalizeText(data?.deployment_status) || fromDeployment;
  const fromLocation = normalizeText(guard.vehicle.current_location_label || guard.vehicle.current_location_code || guard.vehicle.station_code);
  const toLocation = normalizeText(data?.current_location_label || data?.current_location_code || data?.station_code) || fromLocation;
  const fromLocationType = normalizeText(guard.vehicle.current_location_type) || "station";
  const toLocationType = normalizeText(data?.current_location_type) || fromLocationType;
  if (fromDeployment !== toDeployment || fromLocation !== toLocation || fromLocationType !== toLocationType) {
    await writeEventLog({
      companyId: access.companyId,
      platform: "dashboard",
      eventCode: "fleet_vehicle_location_updated",
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
      metadata: { from_deployment: fromDeployment, to_deployment: toDeployment, from_location: fromLocation, to_location: toLocation, from_location_type: fromLocationType, to_location_type: toLocationType, reason: normalizeText(body.transfer_reason) || "Deployment or physical location updated in Fleet" },
      request
    });
  }
  const fromStatus = normalizeText(guard.vehicle.status).toLowerCase();
  const toStatus = normalizeText(data?.status).toLowerCase() || fromStatus;
  const reasonChanged = normalizeText(guard.vehicle.status_reason_id) !== normalizeText(data?.status_reason_id) || normalizeText(guard.vehicle.status_comment) !== normalizeText(data?.status_comment);
  if (fromStatus !== toStatus || reasonChanged) {
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
      metadata: { from_status: fromStatus, to_status: toStatus, reason_key: normalizeText(data?.status_reason_key), reason: normalizeText(body.status_reason_label) || "Status updated in Fleet", comment: normalizeText(data?.status_comment) },
      request
    });
  }
  return NextResponse.json({ vehicle: data });
}

async function handleDELETE(request: Request) {
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
  if (!authorization.isMasterOwner && !await hasActiveFleetMembership(companyId, authorization.userId)) return { error: NextResponse.json({ error: "You do not have access to DropX Fleet. Contact HR or your department administrator." }, { status: 403 }) };
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
    .select("id,station_code,status,deployment_status,current_location_type,current_location_code,current_location_label,non_operational_since,expected_operational_date,status_comment,status_reason_id,status_reason_key")
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
  if (payload.current_location_code) payload.current_location_code = payload.current_location_code.toUpperCase();
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

export const POST = withFleetSystemLog(handlePOST);

export const PATCH = withFleetSystemLog(handlePATCH);

export const DELETE = withFleetSystemLog(handleDELETE);
