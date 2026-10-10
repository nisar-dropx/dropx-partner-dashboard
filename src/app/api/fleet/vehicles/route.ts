import { fleetAuditContext } from "@/lib/fleet/audit-context";
import { availabilityDateError, registrationNumber } from "@/lib/fleet/vehicle-maintenance";
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
import { hasActiveFleetMembership, mapVehicle } from "@/lib/fleet-control";

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
  if (payload.status === "archived") return NextResponse.json({error:"Create a current vehicle before archiving it."},{status:400});
  if (!payload.ownership_type) payload.ownership_type = "own";
  if (!payload.vehicle_no) return NextResponse.json({ error: "Vehicle number is required." }, { status: 400 });
  const conflict=await registrationConflict(access.companyId,payload.vehicle_no);
  if(conflict)return conflict;
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
    const registration=registrationNumber(body.registration_number);
    if(!registration)return NextResponse.json({error:"Enter the actual vehicle registration number."},{status:400});
    if (registration !== vehicleNo) {
      const conflict=await registrationConflict(access.companyId,registration,guard.vehicle.id);
      if(conflict)return conflict;
      payload.vehicle_no=registration;
    }
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
  if (guard.vehicle.status === "archived") return NextResponse.json({error:"This vehicle is archived. Restore it before editing."},{status:409});
  if (payload.status === "archived") return NextResponse.json({error:"Use Delete / archive vehicle and provide a reason."},{status:400});
  if (payload.status) {
    const definition = await supabaseAdmin.from("fleet_vehicle_status_master").select("id,status_key,label,is_active,is_operational,requires_reason,requires_expected_date").eq("company_id", access.companyId).eq("status_key", payload.status).maybeSingle();
    if (definition.error) return mutationError(definition.error.message);
    if (!definition.data || (definition.data.is_active === false && payload.status !== guard.vehicle.status)) return NextResponse.json({ error: "Choose an active status from Fleet Masters." }, { status: 400 });
    const operational = Boolean(definition.data.is_operational);
    let reason: { id: string; reason_key: string; label: string } | null = null;
    const reasonId = normalizeText("status_reason_id" in body ? body.status_reason_id : guard.vehicle.status === payload.status ? guard.vehicle.status_reason_id : null);
    if (!operational && reasonId) {
      const result = await supabaseAdmin.from("fleet_vehicle_status_reason_master").select("id,reason_key,label,is_active").eq("company_id", access.companyId).eq("status_id", definition.data.id).eq("id", reasonId).maybeSingle();
      if (result.error) return mutationError(result.error.message);
      reason = result.data && (result.data.is_active !== false || (payload.status === guard.vehicle.status && reasonId === guard.vehicle.status_reason_id)) ? result.data : null;
    }
    if (!operational && definition.data.requires_reason && !reason) return NextResponse.json({ error: `Choose a reason for ${definition.data.label}.` }, { status: 400 });
    payload.status_reason_id = operational ? null : reason?.id ?? null;
    payload.status_reason_key = operational ? null : reason?.reason_key ?? null;
    payload.status_comment = operational ? null : ("status_comment" in payload ? payload.status_comment : guard.vehicle.status_comment);
    payload.non_operational_since = operational ? null : (payload.non_operational_since || (guard.vehicle.status === payload.status ? guard.vehicle.non_operational_since : null) || new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()));
    payload.expected_operational_date = operational ? null : ("expected_operational_date" in payload ? payload.expected_operational_date : guard.vehicle.status === payload.status ? guard.vehicle.expected_operational_date : null);
    if (!operational && definition.data.requires_expected_date && !payload.expected_operational_date) return NextResponse.json({ error: `Expected operational date is required for ${definition.data.label}.` }, { status: 400 });
    body.status_reason_label = reason?.label ?? "";
  }

  const dateError = availabilityDateError("non_operational_since" in payload ? payload.non_operational_since : guard.vehicle.non_operational_since, "expected_operational_date" in payload ? payload.expected_operational_date : guard.vehicle.expected_operational_date, new Intl.DateTimeFormat("en-CA", {timeZone:"Asia/Kolkata"}).format(new Date()));
  if (("non_operational_since" in payload || "expected_operational_date" in payload) && dateError) return NextResponse.json({error:dateError},{status:400});

  const availabilityStamp = ["status","expected_operational_date","non_operational_since","status_comment","status_reason_id"].some(key=>key in payload) ? {status_updated_at:new Date().toISOString(),status_updated_by:access.authorization.userId} : {};
  const placementStamp = ["deployment_status","current_location_type","current_location_label"].some(key=>key in payload) ? {current_location_updated_at:new Date().toISOString(),current_location_updated_by:access.authorization.userId} : {};
  let { data, error } = await supabaseAdmin
    .from("fleet_vehicles")
    .update({ ...payload, ...availabilityStamp, ...placementStamp, updated_at: new Date().toISOString() })
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
      .update({ ...fallbackPayload, ...availabilityStamp, ...placementStamp, updated_at: new Date().toISOString() })
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
  if (fromStatus !== toStatus || reasonChanged || guard.vehicle.expected_operational_date !== data?.expected_operational_date || guard.vehicle.non_operational_since !== data?.non_operational_since) {
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
      metadata: { previous_expected_operational_date:guard.vehicle.expected_operational_date, expected_operational_date:data?.expected_operational_date, previous_non_operational_since:guard.vehicle.non_operational_since, non_operational_since:data?.non_operational_since, from_status: fromStatus, to_status: toStatus, reason_key: normalizeText(data?.status_reason_key), reason: normalizeText(body.status_reason_label) || "Status updated in Fleet", comment: normalizeText(data?.status_comment) },
      request
    });
  }
  const before:Record<string,unknown>={}, after:Record<string,unknown>={};
  for (const key of ["da_name","da_contact_number","vendor_name","vendor_contact_number"] as const) {
    if (guard.vehicle[key] !== data?.[key]) {before[key]=guard.vehicle[key];after[key]=data?.[key];}
  }
  let warning:string|undefined;
  if(Object.keys(after).length){
    const context=fleetAuditContext.getStore();
    const log=await supabaseAdmin.from("fleet_system_logs").insert({company_id:access.companyId,entity:"fleet_vehicles",entity_id:guard.vehicle.id,event_kind:"change",subject:data.vehicle_no,station_code:data.station_code,action:"update",actor_user_id:context?.actorId||access.authorization.userId,actor_label:context?.actorLabel||access.authorization.fullName||access.authorization.email,request_id:context?.requestId,route:"/api/fleet/vehicles",before_values:before,after_values:after});
    if(log.error){console.error("Vehicle contact history unavailable",log.error.code);warning="Details saved, but contact-change history could not be recorded. Contact your administrator.";}
  }
  return NextResponse.json({ vehicle: data, warning });
}

// Soft deletion uses a reserved lifecycle state; linked rows and historical numbers remain intact.
async function handleDELETE(request: Request) {
  if (!supabaseAdmin) return setupError("Fleet data is unavailable.");
  const access = await requireFleetMutationPermission("edit");
  if ("error" in access) return access.error;
  const body = await request.json().catch(() => ({}));
  const vehicleNo = normalizeText(body.vehicle_no || new URL(request.url).searchParams.get("vehicle_no")).toUpperCase();
  const reason = normalizeText(body.reason);
  if (!vehicleNo || reason.length < 5 || reason.length > 500) return NextResponse.json({error:"Enter the vehicle number and an archive reason (5–500 characters)."},{status:400});
  const guard = await requireVehicleScope(access.companyId, vehicleNo, access.stationCodes);
  if ("error" in guard) return guard.error;
  if (guard.vehicle.status === "archived") return NextResponse.json({ok:true,archived:true});
  const [audits,service,findings] = await Promise.all([
    supabaseAdmin.from("fleet_audits").select("id").eq("company_id",access.companyId).eq("vehicle_id",guard.vehicle.id).in("status",["scheduled","in_progress"]).limit(1),
    supabaseAdmin.from("fleet_service_history").select("id").eq("company_id",access.companyId).eq("vehicle_id",guard.vehicle.id).in("status",["scheduled","in_progress"]).limit(1),
    supabaseAdmin.from("fleet_audit_findings").select("id,fleet_audits!inner(vehicle_id)").eq("company_id",access.companyId).eq("fleet_audits.vehicle_id",guard.vehicle.id).in("status",["open","in_progress"]).limit(1),
  ]);
  if ([audits,service,findings].some(r=>r.error)) return NextResponse.json({error:"Unable to check outstanding vehicle work. Retry; the vehicle has not been archived."},{status:503});
  if ([audits,service,findings].some(r=>r.data?.length)) return NextResponse.json({error:"Complete or cancel scheduled audits/service and close open audit findings before archiving this vehicle."},{status:409});
  const now = new Date().toISOString();
  const {data,error} = await supabaseAdmin.from("fleet_vehicles").update({status:"archived",deployment_status:"not_deployed",status_reason_id:null,status_reason_key:null,status_comment:reason,expected_operational_date:null,status_updated_at:now,status_updated_by:access.authorization.userId,updated_at:now})
    .eq("company_id",access.companyId).eq("id",guard.vehicle.id).eq("status",guard.vehicle.status).select("id").maybeSingle();
  if (error) return mutationError(error.message);
  if (!data) return NextResponse.json({error:"The vehicle changed while you were editing. Refresh and retry."},{status:409});
  return NextResponse.json({ok:true,archived:true});
}

async function handlePUT(request: Request) {
  if (!supabaseAdmin) return setupError("Fleet data is unavailable.");
  const access=await requireFleetMutationPermission("edit");
  if ("error" in access) return access.error;
  const body=await request.json();
  const vehicleNo=normalizeText(body.vehicle_no).toUpperCase(), reason=normalizeText(body.reason);
  if(reason.length<5||reason.length>500)return NextResponse.json({error:"Enter a restore reason (5–500 characters)."},{status:400});
  const guard=await requireVehicleScope(access.companyId,vehicleNo,access.stationCodes);
  if("error" in guard)return guard.error;
  if(guard.vehicle.status!=="archived")return NextResponse.json({error:"Only archived vehicles can be restored."},{status:409});
  const now=new Date().toISOString();
  const result=await supabaseAdmin.from("fleet_vehicles").update({status:"inactive",deployment_status:"not_deployed",status_comment:`Restored: ${reason}`,status_reason_id:null,status_reason_key:null,non_operational_since:new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Kolkata"}).format(new Date()),expected_operational_date:null,status_updated_at:now,status_updated_by:access.authorization.userId,updated_at:now}).eq("company_id",access.companyId).eq("id",guard.vehicle.id).eq("status","archived").select("id").maybeSingle();
  if(result.error)return mutationError(result.error.message);
  if(!result.data)return NextResponse.json({error:"This vehicle changed. Refresh and retry."},{status:409});
  return NextResponse.json({ok:true,message:"Restored as inactive and not deployed. Review availability and placement before use."});
}

export async function GET(request: Request) {
  if (!supabaseAdmin) return setupError("Fleet data is unavailable.");
  const access = await requireFleetMutationPermission("edit");
  if ("error" in access) return access.error;
  const params = new URL(request.url).searchParams;
  const historyNo=normalizeText(params.get("history")).toUpperCase();
  if(historyNo){
    const guard=await requireVehicleScope(access.companyId,historyNo,access.stationCodes);
    if("error" in guard)return guard.error;
    const page=Math.max(1,Math.min(10000,Math.floor(Number(params.get("page")))||1));
    const result=await supabaseAdmin.from("fleet_system_logs").select("id,created_at,actor_label,action,before_values,after_values",{count:"exact"}).eq("company_id",access.companyId).eq("entity","fleet_vehicles").eq("entity_id",guard.vehicle.id).eq("event_kind","change").order("created_at",{ascending:false}).order("id").range((page-1)*20,page*20-1);
    if(result.error)return NextResponse.json({error:"Unable to load vehicle history."},{status:503});
    return NextResponse.json({rows:result.data,total:result.count},{headers:{"Cache-Control":"private, no-store"}});
  }
  const page = Math.max(1,Math.min(10000,Math.floor(Number(params.get("page")))||1));
  let query = supabaseAdmin.from("fleet_vehicles").select("*",{count:"exact"}).eq("company_id",access.companyId).eq("status","archived").order("status_updated_at",{ascending:false}).order("id");
  if (access.stationCodes) query=query.in("station_code",access.stationCodes);
  const search=normalizeText(params.get("search")).replace(/[^a-zA-Z0-9 -]/g,"").slice(0,80);
  if (search) query=query.or(`vehicle_no.ilike.%${search}%,station_code.ilike.%${search}%,model.ilike.%${search}%`);
  const result=await query.range((page-1)*20,page*20-1);
  if(result.error)return mutationError(result.error.message);
  return NextResponse.json({vehicles:(result.data??[]).map(row=>({id:row.id,vehicle_no:row.vehicle_no,model:row.model,station_code:row.station_code,status_comment:row.status_comment,status_updated_at:row.status_updated_at,vehicle:{...mapVehicle(row as any,new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Kolkata"}).format(new Date())),sourceId:row.source_id}})),total:result.count,page},{headers:{"Cache-Control":"private, no-store"}});
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
    .select("id,vehicle_no,da_name,da_contact_number,vendor_name,vendor_contact_number,station_code,status,deployment_status,current_location_type,current_location_code,current_location_label,non_operational_since,expected_operational_date,status_comment,status_reason_id,status_reason_key")
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

async function registrationConflict(companyId:string, number:string, vehicleId?:string) {
  const current=await supabaseAdmin!.from("fleet_vehicles").select("id").eq("vehicle_no",number).limit(1);
  if(current.error)return mutationError(current.error.message);
  if(current.data?.some(v=>v.id!==vehicleId))return NextResponse.json({error:"This registration already belongs to a vehicle. Check the existing entry."},{status:409});
  let query=supabaseAdmin!.from("fleet_system_logs").select("entity_id").eq("company_id",companyId).eq("entity","fleet_vehicles").eq("event_kind","change").eq("before_values->>vehicle_no",number);
  if(vehicleId)query=query.neq("entity_id",vehicleId);
  const prior=await query.limit(1);
  if(prior.error)return NextResponse.json({error:"Unable to check registration history. Retry; nothing has been changed."},{status:503});
  if(prior.data?.length)return NextResponse.json({error:"This number belongs to another vehicle’s history. Restore or correct that vehicle instead of reusing the number."},{status:409});
  return null;
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
  if (/duplicate key|unique constraint/i.test(error)) return NextResponse.json({error:"This registration is already in use. Open the existing vehicle or enter a different number."},{status:409});
  if (/foreign key/i.test(error)) return NextResponse.json({error:"This vehicle has linked records that prevent this change. No vehicle data was removed."},{status:409});
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

export const PUT = withFleetSystemLog(handlePUT);
