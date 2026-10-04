import { auditApplies, evaluateAuditResponse, normalizeAuditConfig } from "@/lib/fleet/audit-rules";
import { todayKolkata } from "@/lib/ops-pulse/cod";
import { NextResponse } from "next/server";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { sendEmail } from "@/lib/email";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { normalizeFleetDailyStatusEmailConfig } from "@/lib/fleet/daily-status-email";
import { buildFleetAuditEmail } from "@/lib/fleet/audit-email";
import { auditProgrammeFromRiskWeights, normalizeFleetAuditProgrammeConfig } from "@/lib/fleet/audit-programme-config";
import { generateFleetAuditProgramme } from "@/lib/fleet/audit-programme";
import { fleetAccessPageCodes } from "@/lib/access-surface";
import { hasActiveFleetMembership } from "@/lib/fleet-control";

type Payload = Record<string, any>;
const emailPattern = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
function clean(value: unknown) { return String(value ?? "").trim(); }
function numberOrNull(value: unknown) { const parsed = Number(value); return value == null || value === "" || !Number.isFinite(parsed) ? null : parsed; }
function required(value: unknown, label: string) { const result = clean(value); if (!result) throw new Error(`${label} is required.`); return result; }
function setupError(message: string) { return /does not exist|schema cache|could not find the table/i.test(message) ? `${message} Apply the Fleet Control migration before using this action.` : message; }
const evidenceTypes = ["none", "photo", "video", "document", "any"];
function evidenceRule(typeValue: unknown, minimumValue: unknown) {
  const type = evidenceTypes.includes(clean(typeValue)) ? clean(typeValue) : "none";
  return { type, minimum: type === "none" ? 0 : Math.max(0, Math.min(10, Number(minimumValue ?? 0) || 0)) };
}
function checklistEvidenceRules(guidanceValue: unknown, responseType: unknown) {
  const raw = clean(guidanceValue);
  const remarksMarker = raw.match(/^\[remarks-fail:(required|optional)\]\s*/i);
  const failRemarksRequired = remarksMarker ? remarksMarker[1].toLowerCase() === "required" : ["pass_fail", "yes_no"].includes(clean(responseType));
  const withoutRemarks = raw.replace(/^\[remarks-fail:(?:required|optional)\]\s*/i, "");
  const pass = withoutRemarks.match(/^\[evidence-pass:(none|photo|video|document|any):(\d+)\]/i);
  const afterPass = withoutRemarks.replace(/^\[evidence-pass:(?:none|photo|video|document|any):\d+\]\s*/i, "");
  const fail = afterPass.match(/^\[evidence-fail:(none|photo|video|document|any):(\d+)\]/i);
  const legacy = raw.match(/^\[evidence:(none|photo|video|document|any):(\d+)\]/i);
  const fallbackType = legacy?.[1]?.toLowerCase() || (responseType === "photo" ? "photo" : responseType === "video" ? "video" : "none");
  const fallbackMinimum = legacy ? Number(legacy[2]) || 0 : fallbackType === "none" ? 0 : 1;
  return { pass: evidenceRule(pass?.[1] || (legacy ? fallbackType : "none"), pass?.[2] || (legacy ? fallbackMinimum : 0)), fail: evidenceRule(fail?.[1] || fallbackType, fail?.[2] || fallbackMinimum), failRemarksRequired };
}

async function assertAuditDateAllowed(companyId: string, value: string) {
  const parsed = new Date(`${value}T12:00:00+05:30`);
  if (Number.isNaN(parsed.getTime())) throw new Error("Choose a valid audit date.");
  const settings = await supabaseAdmin!.from("fleet_control_settings").select("risk_weights").eq("company_id", companyId).maybeSingle();
  if (settings.error) throw new Error(settings.error.message);
  const config = auditProgrammeFromRiskWeights(settings.data?.risk_weights);
  if (config.excludedWeekdays.includes(parsed.getDay())) throw new Error("This weekday is excluded in Settings → Vehicle audit programme. Choose another date.");
}

async function access() {
  const authorization = await getAuthorization();
  if (!authorization) return { error: NextResponse.json({ error: "Login required." }, { status: 401 }) };
  const companyId = requireCompanyId(authorization);
  const hasMembership = authorization.isMasterOwner || await hasActiveFleetMembership(companyId, authorization.userId);
  const hasFleetPermission = fleetAccessPageCodes.some((code) => hasPermission(authorization, code, "access"));
  if (!hasMembership || !hasFleetPermission) return { error: NextResponse.json({ error: "Fleet portal access has not been assigned. Contact HR or your department administrator." }, { status: 403 }) };
  const canManageFleet = authorization.isMasterOwner || hasPermission(authorization, "fleet_audits", "edit") || hasPermission(authorization, "fleet_maintenance", "edit") || hasPermission(authorization, "fleet_vehicle_view", "edit");
  const canManageSettings = authorization.isMasterOwner || hasPermission(authorization, "fleet_settings", "edit") || hasPermission(authorization, "fleet_masters", "edit");
  return { authorization, companyId, canManageFleet, canManageSettings };
}

export async function POST(request: Request) {
  if (!supabaseAdmin) return NextResponse.json({ error: "Database service is unavailable." }, { status: 500 });
  const context = await access();
  if ("error" in context) return context.error;
  let body: Payload;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid request body." }, { status: 400 }); }
  const action = clean(body.action);
  try {
    const canAudit = context.authorization.isMasterOwner || hasPermission(context.authorization, "fleet_audits", "edit");
    const canService = context.authorization.isMasterOwner || hasPermission(context.authorization, "fleet_maintenance", "edit");
    if ((action.startsWith("audit.") && !canAudit) || (action.startsWith("service.") && !canService) || (action === "finding.update" && !canAudit && !canService)) return NextResponse.json({error:"You do not have permission for this action."},{status:403});
    if (action === "audit.auto-schedule" && !context.authorization.isMasterOwner && !context.authorization.hasAllLocationAccess) return NextResponse.json({error:"Company-wide scheduling requires access to all locations."},{status:403});
    if (body.otherAuditId && !context.authorization.isMasterOwner && !context.authorization.hasAllLocationAccess) {
      const other = await supabaseAdmin.from("fleet_audits").select("fleet_vehicles!inner(station_code)").eq("company_id",context.companyId).eq("id",body.otherAuditId).single();
      const otherVehicle = Array.isArray(other.data?.fleet_vehicles) ? other.data.fleet_vehicles[0] : other.data?.fleet_vehicles;
      const locations = await supabaseAdmin.from("stations").select("station_code").eq("company_id",context.companyId).in("id",context.authorization.locationScopeIds.length ? context.authorization.locationScopeIds : ["00000000-0000-0000-0000-000000000000"]);
      if(other.error || locations.error || !otherVehicle || !locations.data?.some(s=>s.station_code===otherVehicle.station_code)) return NextResponse.json({error:"The other audit is outside your assigned locations."},{status:403});
    }
    if (body.auditId || body.vehicleId || body.findingId) {
      let vehicleId = clean(body.vehicleId);
      let auditId = clean(body.auditId);
      if (body.findingId) { const f = await supabaseAdmin.from("fleet_audit_findings").select("audit_id").eq("company_id",context.companyId).eq("id",body.findingId).single(); if(f.error) throw new Error("Finding not found."); auditId=f.data.audit_id; }
      if (auditId) { const a = await supabaseAdmin.from("fleet_audits").select("vehicle_id").eq("company_id",context.companyId).eq("id",auditId).single(); if(a.error) throw new Error("Audit not found."); vehicleId=a.data.vehicle_id; }
      if (vehicleId && !context.authorization.isMasterOwner && !context.authorization.hasAllLocationAccess) {
        const v = await assertVehicle(context.companyId,vehicleId);
        const stations = await supabaseAdmin.from("stations").select("station_code").eq("company_id",context.companyId).in("id",context.authorization.locationScopeIds.length ? context.authorization.locationScopeIds : ["00000000-0000-0000-0000-000000000000"]);
        if(stations.error || !(stations.data ?? []).some(x=>x.station_code === v.station_code)) return NextResponse.json({error:"This vehicle is outside your assigned locations."},{status:403});
      }
    }
    if (action === "service.create") return await createService(context.companyId, context.authorization.userId, context.canManageFleet, body);
    if (action === "service.schedule") return await scheduleService(context.companyId, context.authorization.userId, context.canManageFleet, body);
    if (action === "audit.schedule") return await scheduleAudit(context.companyId, context.authorization.userId, context.canManageFleet, body);
    if (action === "audit.reschedule") return await rescheduleAudit(context.companyId, context.authorization.userId, context.canManageFleet, body);
    if (action === "audit.swap") return await swapAudits(context.companyId, context.authorization.userId, context.canManageFleet, body);
    if (action === "audit.auto-schedule") return context.canManageFleet ? NextResponse.json({ ok: true, ...await generateFleetAuditProgramme(context.companyId, required(body.month, "Audit month"), context.authorization.userId) }) : NextResponse.json({ error: "Fleet audit permission denied." }, { status: 403 });
    if (action === "audit.cancel") return await cancelAudit(context.companyId, context.authorization.userId, context.canManageFleet, body);
    if (action === "audit.start") return await startAudit(context.companyId, context.authorization.userId, context.canManageFleet, body);
    if (action === "audit.draft") return await saveAuditDraft(context.companyId, context.canManageFleet, body);
    if (action === "finding.update") return await updateFinding(context.companyId, context.canManageFleet, body);
    if (action === "audit.complete") return await completeAudit(context.companyId, context.authorization.userId, context.canManageFleet, body);
    if (action === "checklist.create") return await createChecklistItem(context.companyId, context.canManageSettings, body);
    if (action === "checklist.update") return await updateChecklistItem(context.companyId, context.canManageSettings, body);
    if (action === "checklist.remove") return await removeChecklistItem(context.companyId, context.canManageSettings, body);
    if (action === "audit-template.upsert") return await upsertAuditTemplate(context.companyId, context.authorization.userId, context.canManageSettings, body);
    if (action === "audit-template.remove") return await removeAuditTemplate(context.companyId, context.canManageSettings, body);
    if (action === "document-type.upsert") return await upsertDocumentType(context.companyId, context.canManageSettings, body);
    if (action === "document-type.remove") return await removeDocumentType(context.companyId, context.canManageSettings, body);
    if (action === "vehicle-status.upsert") return await upsertVehicleStatus(context.companyId, context.canManageSettings, body);
    if (action === "vehicle-status.remove") return await removeVehicleStatus(context.companyId, context.canManageSettings, body);
    if (action === "vehicle-status-reason.upsert") return await upsertVehicleStatusReason(context.companyId, context.canManageSettings, body);
    if (action === "vehicle-status-reason.remove") return await removeVehicleStatusReason(context.companyId, context.canManageSettings, body);
    if (action === "settings.update") return await updateSettings(context.companyId, context.authorization.userId, context.canManageSettings, body);
    if (action === "settings.update-audit-programme") return await updateAuditProgrammeSettings(context.companyId, context.authorization.userId, context.canManageSettings, body);
    if (action === "settings.update-mail") return await updateMailSettings(context.companyId, context.authorization.userId, context.canManageSettings, body);
    if (action === "member.upsert") return await upsertMember(context.companyId, context.authorization.userId, context.canManageSettings, body);
    if (action === "status-recipient.upsert") return await upsertStatusRecipient(context.companyId, context.authorization.userId, context.canManageSettings, body);
    if (action === "status-recipient.remove") return await removeStatusRecipient(context.companyId, context.canManageSettings, body);
    if (action === "status-recipient.toggle") return await toggleStatusRecipient(context.companyId, context.canManageSettings, body);
    if (action === "status-recipient.delete") return await deleteStatusRecipient(context.companyId, context.canManageSettings, body);
    return NextResponse.json({ error: "Unsupported Fleet Control action." }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: setupError(error instanceof Error ? error.message : "Fleet action failed.") }, { status: 400 });
  }
}

async function assertVehicle(companyId: string, vehicleId: string) {
  const result = await supabaseAdmin!.from("fleet_vehicles").select("id,vehicle_no,station_code,model").eq("company_id", companyId).eq("id", vehicleId).maybeSingle();
  if (result.error) throw new Error(result.error.message);
  if (!result.data) throw new Error("Vehicle was not found in this company.");
  return result.data;
}

async function createService(companyId: string, userId: string, allowed: boolean, body: Payload) {
  if (!allowed) return NextResponse.json({ error: "Fleet maintenance permission denied." }, { status: 403 });
  const vehicleId = required(body.vehicleId, "Vehicle");
  await assertVehicle(companyId, vehicleId);
  const result = await supabaseAdmin!.from("fleet_service_history").insert({
    company_id: companyId, vehicle_id: vehicleId, service_date: required(body.serviceDate, "Service date"), service_type: required(body.serviceType, "Service type"),
    odometer_km: numberOrNull(body.odometerKm), vendor_name: clean(body.vendorName) || null, vendor_contact: clean(body.vendorContact) || null,
    amount: numberOrNull(body.amount) ?? 0, status: clean(body.status) || "completed", description: clean(body.description) || null,
    invoice_url: clean(body.invoiceUrl) || null, next_service_date: clean(body.nextServiceDate) || null,
    next_service_odometer_km: numberOrNull(body.nextServiceOdometerKm), downtime_hours: numberOrNull(body.downtimeHours), created_by: userId
  }).select("id").single();
  if (result.error) throw new Error(result.error.message);
  return NextResponse.json({ ok: true, id: result.data.id, message: "Service history saved." });
}

async function scheduleService(companyId: string, userId: string, allowed: boolean, body: Payload) {
  if (!allowed) return NextResponse.json({ error: "Fleet maintenance permission denied." }, { status: 403 });
  const vehicleId = required(body.vehicleId, "Vehicle");
  await assertVehicle(companyId, vehicleId);
  const serviceDate = required(body.serviceDate, "Next service date");
  const values = {
    service_date: serviceDate,
    service_type: clean(body.serviceType) || "Regular Service",
    next_service_date: serviceDate,
    next_service_odometer_km: numberOrNull(body.nextServiceOdometerKm),
    description: clean(body.description) || "Scheduled from the vehicle service plan",
    status: "scheduled",
    amount: 0,
    updated_at: new Date().toISOString()
  };
  const existing = await supabaseAdmin!.from("fleet_service_history").select("id").eq("company_id", companyId).eq("vehicle_id", vehicleId).eq("status", "scheduled").order("service_date", { ascending: true }).limit(1).maybeSingle();
  if (existing.error) throw new Error(existing.error.message);
  const result = existing.data?.id
    ? await supabaseAdmin!.from("fleet_service_history").update(values).eq("company_id", companyId).eq("id", existing.data.id).select("id").single()
    : await supabaseAdmin!.from("fleet_service_history").insert({ company_id: companyId, vehicle_id: vehicleId, created_by: userId, ...values }).select("id").single();
  if (result.error) throw new Error(result.error.message);
  return NextResponse.json({ ok: true, id: result.data.id, message: existing.data?.id ? "Next service plan updated." : "Next service scheduled." });
}

async function scheduleAudit(companyId: string, userId: string, allowed: boolean, body: Payload) {
  if (!allowed) return NextResponse.json({ error: "Fleet audit permission denied." }, { status: 403 });
  const vehicleId = required(body.vehicleId, "Vehicle");
  await assertVehicle(companyId, vehicleId);
  let templateId = clean(body.templateId) || null;
  if (!templateId) {
    const template = await supabaseAdmin!.from("fleet_audit_templates").select("id").eq("company_id", companyId).eq("is_default", true).eq("is_active", true).maybeSingle();
    if (template.error) throw new Error(template.error.message);
    templateId = template.data?.id ?? null;
  }
  const requestedMode = clean(body.auditMode) || "physical";
  const modes = requestedMode === "both" ? ["video", "physical"] : [requestedMode];
  if (modes.some((mode) => !["video", "physical"].includes(mode))) throw new Error("Choose video review, physical inspection or both audits.");
  const reason = clean(body.scheduledReason) || "Routine monthly audit";
  const rows = modes.map((mode) => ({ company_id: companyId, vehicle_id: vehicleId, template_id: templateId,
    scheduled_for: required(mode === "video" ? body.videoDate || body.scheduledFor : body.physicalDate || body.scheduledFor, `${mode === "video" ? "Video review" : "Physical inspection"} date`),
    scheduled_reason: `[mode:${mode}] ${reason}`,
    risk_score: Math.max(0, Math.min(100, Number(body.riskScore ?? 0))), status: "scheduled", assigned_to: clean(body.assignedTo) || null, created_by: userId
  }));
  for (const row of rows) await assertAuditDateAllowed(companyId, row.scheduled_for);
  if (new Set(rows.map((row) => row.scheduled_for.slice(0, 7))).size > 1) throw new Error("Both audits must be scheduled in the same month.");
  const duplicateChecks = await Promise.all(rows.map((row) => {
    const monthStart = `${row.scheduled_for.slice(0, 7)}-01`;
    const nextMonth = new Date(`${monthStart}T12:00:00+05:30`); nextMonth.setMonth(nextMonth.getMonth() + 1);
    const nextMonthStart = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, "0")}-01`;
    return supabaseAdmin!.from("fleet_audits").select("id").eq("company_id", companyId).eq("vehicle_id", vehicleId).gte("scheduled_for", monthStart).lt("scheduled_for", nextMonthStart).like("scheduled_reason", `${row.scheduled_reason.split(" ")[0]}%`).neq("status", "cancelled").limit(1);
  }));
  const duplicateError = duplicateChecks.find((check) => check.error)?.error;
  if (duplicateError) throw new Error(duplicateError.message);
  const newRows = rows.filter((_, index) => !(duplicateChecks[index].data ?? []).length);
  if (!newRows.length) return NextResponse.json({ ok: true, ids: [], message: "This vehicle already has the selected monthly audit scheduled." });
  const result = await supabaseAdmin!.from("fleet_audits").insert(newRows).select("id");
  if (result.error) throw new Error(result.error.message);
  return NextResponse.json({ ok: true, ids: (result.data ?? []).map((row) => row.id), message: newRows.length === 2 ? "Both monthly vehicle audits scheduled." : modes.length === 2 ? "Missing monthly audit scheduled; the existing audit was kept." : "Vehicle audit scheduled." });
}

async function rescheduleAudit(companyId: string, userId: string, allowed: boolean, body: Payload) {
  if (!allowed) return NextResponse.json({ error: "Fleet audit permission denied." }, { status: 403 });
  const auditId = required(body.auditId, "Audit");
  const scheduledFor = required(body.scheduledFor, "New audit date");
  await assertAuditDateAllowed(companyId, scheduledFor);
  const reason = required(body.rescheduleReason, "Reschedule reason");
  const current = await supabaseAdmin!.from("fleet_audits").select("id,vehicle_id,scheduled_for,scheduled_reason,status").eq("company_id", companyId).eq("id", auditId).maybeSingle();
  if (current.error) throw new Error(current.error.message);
  if (!current.data) throw new Error("Audit was not found.");
  if (!['scheduled','in_progress'].includes(clean(current.data.status))) throw new Error("Only an open audit can be moved.");
  const mode = /^\[mode:video\]/i.test(clean(current.data.scheduled_reason)) ? "video" : "physical";
  const monthStart = `${scheduledFor.slice(0, 7)}-01`;
  const nextMonth = new Date(`${monthStart}T12:00:00+05:30`); nextMonth.setMonth(nextMonth.getMonth() + 1);
  const nextMonthStart = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, "0")}-01`;
  const duplicate = await supabaseAdmin!.from("fleet_audits").select("id").eq("company_id", companyId).eq("vehicle_id", current.data.vehicle_id).neq("id", auditId).gte("scheduled_for", monthStart).lt("scheduled_for", nextMonthStart).like("scheduled_reason", `[mode:${mode}]%`).neq("status", "cancelled").limit(1);
  if (duplicate.error) throw new Error(duplicate.error.message);
  if ((duplicate.data ?? []).length) throw new Error(`This vehicle already has a ${mode === "video" ? "video review" : "physical inspection"} in the selected month.`);
  const plainReason = clean(current.data.scheduled_reason).replace(/^\[mode:(?:video|physical)\]\s*/i, "").replace(/\s*\[moved:[^\]]+\]\s*$/i, "") || "Routine monthly audit";
  const update = await supabaseAdmin!.from("fleet_audits").update({ scheduled_for: scheduledFor, scheduled_reason: `[mode:${mode}] ${plainReason} [moved:${clean(current.data.scheduled_for)}|${reason}]`, updated_at: new Date().toISOString() }).eq("company_id", companyId).eq("id", auditId);
  if (update.error) throw new Error(update.error.message);
  await supabaseAdmin!.from("dashboard_app_event_logs").insert({ company_id: companyId, module: "fleet", platform: "dashboard", event_code: "fleet_audit_rescheduled", subject_id: auditId, subject_code: auditId, actor_user_id: userId, actor_label: "Fleet user", metadata: { from_date: current.data.scheduled_for, to_date: scheduledFor, reason } });
  return NextResponse.json({ ok: true, message: "Audit moved to the new date." });
}

async function swapAudits(companyId: string, userId: string, allowed: boolean, body: Payload) {
  if (!allowed) return NextResponse.json({ error: "Fleet audit permission denied." }, { status: 403 });
  const auditId = required(body.auditId, "Audit");
  const otherAuditId = required(body.otherAuditId, "Swap audit");
  if (auditId === otherAuditId) throw new Error("Choose a different audit to swap.");
  const audits = await supabaseAdmin!.from("fleet_audits").select("id,scheduled_for,scheduled_reason,status").eq("company_id", companyId).in("id", [auditId, otherAuditId]);
  if (audits.error) throw new Error(audits.error.message);
  if ((audits.data ?? []).length !== 2 || (audits.data ?? []).some((audit) => audit.status !== "scheduled")) throw new Error("Both audits must be scheduled and not started.");
  const first = audits.data!.find((audit) => audit.id === auditId)!; const second = audits.data!.find((audit) => audit.id === otherAuditId)!;
  const now = new Date().toISOString();
  const [firstUpdate, secondUpdate] = await Promise.all([
    supabaseAdmin!.from("fleet_audits").update({ scheduled_for: second.scheduled_for, scheduled_reason: `${clean(first.scheduled_reason).replace(/\s*\[swapped:[^\]]+\]/g, "")} [swapped:${first.scheduled_for}]`, updated_at: now }).eq("company_id", companyId).eq("id", first.id).eq("status", "scheduled"),
    supabaseAdmin!.from("fleet_audits").update({ scheduled_for: first.scheduled_for, scheduled_reason: `${clean(second.scheduled_reason).replace(/\s*\[swapped:[^\]]+\]/g, "")} [swapped:${second.scheduled_for}]`, updated_at: now }).eq("company_id", companyId).eq("id", second.id).eq("status", "scheduled")
  ]);
  if (firstUpdate.error || secondUpdate.error) throw new Error(firstUpdate.error?.message || secondUpdate.error?.message || "Audit dates could not be swapped.");
  await supabaseAdmin!.from("dashboard_app_event_logs").insert({ company_id: companyId, module: "fleet", platform: "dashboard", event_code: "fleet_audit_swapped", subject_id: auditId, subject_code: auditId, actor_user_id: userId, actor_label: "Fleet user", metadata: { other_audit_id: otherAuditId, first_date: first.scheduled_for, second_date: second.scheduled_for } });
  return NextResponse.json({ ok: true, message: "Audit dates swapped without changing either monthly requirement." });
}

async function cancelAudit(companyId: string, userId: string, allowed: boolean, body: Payload) {
  if (!allowed) return NextResponse.json({ error: "Fleet audit permission denied." }, { status: 403 });
  const auditId = required(body.auditId, "Audit");
  const reason = required(body.reason, "Cancellation reason");
  const current = await supabaseAdmin!.from("fleet_audits").select("id,vehicle_id,scheduled_for,scheduled_reason,status").eq("company_id", companyId).eq("id", auditId).maybeSingle();
  if (current.error) throw new Error(current.error.message);
  if (!current.data) throw new Error("Audit was not found.");
  if (clean(current.data.status) !== "scheduled") throw new Error("Only an audit that has not started can be removed from the schedule.");
  const update = await supabaseAdmin!.from("fleet_audits").update({ status: "cancelled", summary: `Schedule removed: ${reason}`, updated_at: new Date().toISOString() }).eq("company_id", companyId).eq("id", auditId).eq("status", "scheduled");
  if (update.error) throw new Error(update.error.message);
  await supabaseAdmin!.from("dashboard_app_event_logs").insert({ company_id: companyId, module: "fleet", platform: "dashboard", event_code: "fleet_audit_cancelled", subject_id: auditId, subject_code: auditId, actor_user_id: userId, actor_label: "Fleet user", metadata: { scheduled_for: current.data.scheduled_for, reason } });
  return NextResponse.json({ ok: true, message: "Audit removed from the schedule. The monthly slot is open again." });
}

async function startAudit(companyId: string, userId: string, allowed: boolean, body: Payload) {
  if (!allowed) return NextResponse.json({ error: "Fleet audit permission denied." }, { status: 403 });
  const auditId = required(body.auditId, "Audit");
  const audit = await supabaseAdmin!.from("fleet_audits").select("id,status").eq("company_id", companyId).eq("id", auditId).maybeSingle();
  if (audit.error) throw new Error(audit.error.message);
  if (!audit.data) throw new Error("Audit was not found.");
  if (audit.data.status === "in_progress") return NextResponse.json({ ok: true, message: "Audit is already in progress." });
  if (audit.data.status !== "scheduled") throw new Error("Only a scheduled audit can be started.");
  const update = await supabaseAdmin!.from("fleet_audits").update({ status: "in_progress", started_at: new Date().toISOString(), assigned_to: userId, updated_at: new Date().toISOString() }).eq("company_id", companyId).eq("id", auditId).eq("status", "scheduled");
  if (update.error) throw new Error(update.error.message);
  await supabaseAdmin!.from("dashboard_app_event_logs").insert({ company_id: companyId, module: "fleet", platform: "dashboard", event_code: "fleet_audit_started", subject_id: auditId, subject_code: auditId, actor_user_id: userId, actor_label: "Fleet user", metadata: {} });
  return NextResponse.json({ ok: true, message: "Audit started. Complete the checklist and attach the required evidence." });
}

async function completeAudit(companyId: string, userId: string, allowed: boolean, body: Payload) {
  if (!allowed) return NextResponse.json({ error: "Fleet audit permission denied." }, { status: 403 });
  const auditId = required(body.auditId, "Audit");
  const auditResult = await supabaseAdmin!.from("fleet_audits").select("id,vehicle_id,template_id,scheduled_for,scheduled_reason,status,fleet_vehicles!inner(vehicle_no,station_code,model)").eq("company_id", companyId).eq("id", auditId).maybeSingle();
  if (auditResult.error) throw new Error(auditResult.error.message);
  if (!auditResult.data) throw new Error("Audit was not found.");
  if (!["scheduled", "in_progress"].includes(clean(auditResult.data.status))) throw new Error("Only an open audit can be completed.");
  const input = Array.isArray(body.responses) ? body.responses : [];
  const evidence = Array.isArray(body.evidence) ? body.evidence.filter((item: Payload) => clean(item.url)) : [];
  for (const item of evidence) {
    if (!['photo','video','document'].includes(item.type)) throw new Error('Invalid evidence type.');
    const url = clean(item.url);
    if (!/^https:\/\//i.test(url) && !url.startsWith('/api/fleet/audit-evidence?')) throw new Error('Evidence must be a secure link or an uploaded file.');
    if (url.startsWith('/api/fleet/audit-evidence?') && !new URL(url,'https://fleet.dropxlogistics.com').searchParams.get('path')?.startsWith(`${companyId}/audits/${auditId}/`)) throw new Error('Evidence belongs to a different audit.');
  }
  const auditMode = /^\[mode:video\]/i.test(clean(auditResult.data.scheduled_reason)) ? "video" : "physical";
  const settings = await supabaseAdmin!.from('fleet_control_settings').select('audit_video_required,audit_email_enabled').eq('company_id',companyId).maybeSingle();
  if(settings.error) throw new Error(settings.error.message);
  if (auditMode === 'video' && settings.data?.audit_video_required !== false && !evidence.some((item: Payload)=>item.type==='video' && !item.itemId)) throw new Error('Attach the complete walk-around video.');
  const vehicle = await supabaseAdmin!.from('fleet_vehicles').select('fuel_type').eq('company_id',companyId).eq('id',auditResult.data.vehicle_id).single();
  if(vehicle.error) throw new Error(vehicle.error.message);
  let query = supabaseAdmin!.from('fleet_audit_checklist_items').select('*').eq('company_id',companyId).eq('is_active',true);
  if(auditResult.data.template_id) query=query.eq('template_id',auditResult.data.template_id);
  const checklist = await query;
  if(checklist.error) throw new Error(checklist.error.message);
  const items = (checklist.data ?? []).filter(item=>(item.audit_mode === 'both' || item.audit_mode === auditMode) && auditApplies(normalizeAuditConfig(item.response_config),vehicle.data.fuel_type));
  if(!items.length) throw new Error('Configure an audit checklist before completing the audit.');
  const allowedIds = new Set(items.map(i=>i.id));
  if(input.some((r:Payload)=>!allowedIds.has(r.itemId)) || new Set(input.map((r:Payload)=>r.itemId)).size !== input.length) throw new Error('Checklist changed. Reopen the audit and review its questions.');
  if(evidence.some((e:Payload)=>e.itemId && !allowedIds.has(e.itemId))) throw new Error('Evidence references an invalid checklist item.');
  const responses: Payload[]=[];
  const findings: Payload[]=[];
  for(const item of items) {
    const r=input.find((x:Payload)=>x.itemId===item.id) || {};
    const value=clean(r.value), comments=clean(r.comments);
    if(item.is_required && !value) throw new Error(`${item.label}: choose a response.`);
    const config=normalizeAuditConfig(item.response_config);
    let passed: boolean|null=null, minimum=0, type='none';
    if(config) {
      let evaluation;
      try { evaluation=evaluateAuditResponse(config,value,comments,r.days,todayKolkata()); } catch(e) { throw new Error(`${item.label}: ${e instanceof Error ? e.message : 'Invalid response'}`); }
      passed=evaluation.passed; minimum=evaluation.option?.photos || 0; type='photo';
      if(evaluation.option?.issue) findings.push({itemId:item.id,category:item.category,finding:`${item.label}: ${evaluation.option.label}${comments ? ' — '+comments : ''}`,severity:evaluation.option.severity,actionRequired:clean(r.action) || (evaluation.option.followUp==='immediate' ? 'Immediate inspection / repair before next route' : 'Review and complete follow-up'),expectedCompletionDate:evaluation.due});
      if(evaluation.option?.followUp !== 'none' && evaluation.option?.issue && !clean(r.action)) throw new Error(`${item.label}: describe the follow-up action.`);
    } else {
      if(['pass_fail','yes_no'].includes(item.response_type) && value && !['pass','fail','yes','no','na'].includes(value)) throw new Error(`${item.label}: invalid response.`);
      passed=['pass','yes'].includes(value) ? true : ['fail','no'].includes(value) ? false : null;
      const rules=checklistEvidenceRules(item.guidance,item.response_type), rule=passed===false ? rules.fail : rules.pass;
      minimum=rule.minimum; type=rule.type;
      if(passed===false && rules.failRemarksRequired && !comments) throw new Error(`${item.label}: add a remark.`);
      if(passed===false) findings.push({itemId:item.id,category:item.category,finding:`${item.label}: ${comments || value}`,severity:item.failure_severity,actionRequired:'Review and rectify',expectedCompletionDate:todayKolkata()});
    }
    if(value && new Set(evidence.filter((e:Payload)=>e.itemId===item.id && (type==='any' || e.type===type)).map((e:Payload)=>clean(e.url))).size < minimum) throw new Error(`${item.label}: attach ${minimum} ${type} evidence.`);
    responses.push({itemId:item.id,passed,comments,snapshot:{value,label:item.label,config,days:r.days || null,action:clean(r.action)}});
  }
  if(clean(body.finding)) findings.push({category:clean(body.findingCategory)||'General',finding:clean(body.finding),severity:['low','medium','high','critical'].includes(body.severity)?body.severity:'medium',actionRequired:clean(body.actionRequired),expectedCompletionDate:clean(body.expectedCompletionDate)||null});
  const failed=responses.some(r=>r.passed===false);
  const scored=responses.filter(r=>r.passed!==null);
  const score=scored.length ? Math.round(scored.filter(r=>r.passed).length/scored.length*100) : null;
  const update = await supabaseAdmin!.rpc('fleet_complete_audit_v2',{p_company:companyId,p_audit:auditId,p_user:userId,p_data:{responses,evidence,findings,status:failed?'failed':'passed',score,summary:clean(body.summary),odometerKm:numberOrNull(body.odometerKm)}});
  if(update.error) throw new Error(update.error.message);
  let emailStatus = "not_sent";
  if (body.sendEmail !== false && settings.data?.audit_email_enabled !== false) emailStatus = await sendAuditEmail(companyId, auditId, auditResult.data as Payload, failed, score, clean(body.summary), findings, evidence);
  return NextResponse.json({ ok: true, message: emailStatus === "sent" ? "Audit completed and summary emailed." : "Audit completed.", emailStatus });
}

async function sendAuditEmail(companyId: string, auditId: string, audit: Payload, failed: boolean, score: number | null, summary: string, findings: Payload[], evidence: Payload[]) {
  const vehicle = Array.isArray(audit.fleet_vehicles) ? audit.fleet_vehicles[0] : audit.fleet_vehicles;
  const station = await supabaseAdmin!.from("stations").select("station_email,station_manager_email").eq("company_id", companyId).eq("station_code", vehicle.station_code).maybeSingle();
  const admins = await supabaseAdmin!.from("fleet_portal_memberships").select("profiles:user_id(email)").eq("company_id", companyId).eq("is_active", true).in("access_level", ["administrator", "approver"]);
  const to = [station.data?.station_email, station.data?.station_manager_email].map(clean).filter((email) => emailPattern.test(email));
  const cc = (admins.data ?? []).flatMap((row: any) => { const profile = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles; return clean(profile?.email); }).filter((email: string) => emailPattern.test(email) && !to.includes(email));
  if (!to.length) { await supabaseAdmin!.from("fleet_audits").update({ email_status: "failed" }).eq("id", auditId); return "failed"; }
  const settings = await supabaseAdmin!.from("fleet_control_settings").select("risk_weights").eq("company_id", companyId).maybeSingle();
  const config = auditProgrammeFromRiskWeights(settings.data?.risk_weights);
  const mail = buildFleetAuditEmail({ auditId, auditDate: audit.scheduled_for, auditMode: /^\[mode:video\]/i.test(clean(audit.scheduled_reason)) ? "video" : "physical", stationCode: vehicle.station_code, vehicleNo: vehicle.vehicle_no, model: vehicle.model, failed, score, summary, findings, evidence: evidence.map(item=>({...item,url:clean(item.url).startsWith("/api/fleet/audit-evidence?") ? `https://fleet.dropxlogistics.com${item.url}` : item.url})), config });
  try { await sendEmail({ companyId, subject: mail.subject, body: mail.text, html: mail.html, to, cc, messageId: `<dropx.fleet-audit.${auditId}@partner.dropxlogistics.com>` }); await supabaseAdmin!.from("fleet_audits").update({ email_status: "sent", email_sent_at: new Date().toISOString(), email_recipients: { to, cc } }).eq("id", auditId); return "sent"; }
  catch { await supabaseAdmin!.from("fleet_audits").update({ email_status: "failed", email_recipients: { to, cc } }).eq("id", auditId); return "failed"; }
}

async function createChecklistItem(companyId: string, allowed: boolean, body: Payload) {
  if (!allowed) return NextResponse.json({ error: "Fleet settings permission denied." }, { status: 403 });
  const templateId = required(body.templateId, "Template");
  const template = await supabaseAdmin!.from("fleet_audit_templates").select("id").eq("company_id", companyId).eq("id", templateId).maybeSingle();
  if (template.error) throw new Error(template.error.message); if (!template.data) throw new Error("Audit template was not found.");
  const values = checklistItemValues(body);
  const result = await supabaseAdmin!.from("fleet_audit_checklist_items").insert({ company_id: companyId, template_id: templateId, ...values }).select("id").single();
  if (result.error) throw new Error(result.error.message);
  return NextResponse.json({ ok: true, id: result.data.id, message: "Checklist item added." });
}

function checklistItemValues(body: Payload) {
  const pass = evidenceRule(body.passEvidenceType, body.passMinEvidence);
  const fail = evidenceRule(body.failEvidenceType, body.failMinEvidence);
  const guidance = `[remarks-fail:${body.failRemarksRequired === false ? "optional" : "required"}] [evidence-pass:${pass.type}:${pass.minimum}] [evidence-fail:${fail.type}:${fail.minimum}] ${clean(body.guidance)}`.trim();
  return { response_config: normalizeAuditConfig(body.responseConfig ? (typeof body.responseConfig === "string" ? JSON.parse(body.responseConfig) : body.responseConfig) : null), audit_mode: ["video", "physical"].includes(clean(body.auditMode)) ? clean(body.auditMode) : "both", category: required(body.category, "Category"), label: required(body.label, "Checklist item"), guidance, response_type: clean(body.responseType) || "pass_fail", is_required: body.isRequired !== false, failure_severity: clean(body.failureSeverity) || "medium", sort_order: Number(body.sortOrder ?? 999), is_active: true };
}

async function updateChecklistItem(companyId: string, allowed: boolean, body: Payload) {
  if (!allowed) return NextResponse.json({ error: "Fleet settings permission denied." }, { status: 403 });
  const itemId = required(body.itemId, "Checklist item");
  const result = await supabaseAdmin!.from("fleet_audit_checklist_items").update(checklistItemValues(body)).eq("company_id", companyId).eq("id", itemId).select("id").maybeSingle();
  if (result.error) throw new Error(result.error.message);
  if (!result.data) throw new Error("Checklist item was not found.");
  return NextResponse.json({ ok: true, message: "Checklist item updated." });
}

async function removeChecklistItem(companyId: string, allowed: boolean, body: Payload) {
  if (!allowed) return NextResponse.json({ error: "Fleet settings permission denied." }, { status: 403 });
  const itemId = required(body.itemId, "Checklist item");
  const result = await supabaseAdmin!.from("fleet_audit_checklist_items").update({ is_active: false, updated_at: new Date().toISOString() }).eq("company_id", companyId).eq("id", itemId).eq("is_active", true).select("id").maybeSingle();
  if (result.error) throw new Error(result.error.message);
  if (!result.data) throw new Error("Checklist item was already removed or could not be found.");
  return NextResponse.json({ ok: true, message: "Checklist item removed from future audits." });
}

async function upsertAuditTemplate(companyId: string, userId: string, allowed: boolean, body: Payload) {
  if (!allowed) return NextResponse.json({ error: "Fleet Masters permission denied." }, { status: 403 });
  const id = clean(body.id);
  const makeDefault = Boolean(body.isDefault);
  const values = {
    company_id: companyId,
    name: required(body.name, "Template name"),
    description: clean(body.description) || null,
    cadence_days: Math.max(1, Math.min(365, Number(body.cadenceDays ?? 30) || 30)),
    is_default: makeDefault,
    is_active: true,
    updated_at: new Date().toISOString()
  };
  if (makeDefault) {
    const cleared = await supabaseAdmin!.from("fleet_audit_templates").update({ is_default: false, updated_at: new Date().toISOString() }).eq("company_id", companyId).eq("is_default", true);
    if (cleared.error) throw new Error(cleared.error.message);
  }
  const result = id
    ? await supabaseAdmin!.from("fleet_audit_templates").update(values).eq("company_id", companyId).eq("id", id).select("id").maybeSingle()
    : await supabaseAdmin!.from("fleet_audit_templates").insert({ ...values, created_by: userId }).select("id").single();
  if (result.error) throw new Error(result.error.message);
  if (!result.data) throw new Error("Audit template was not found.");
  return NextResponse.json({ ok: true, id: result.data.id, message: id ? "Audit template updated." : "Audit template added." });
}

async function removeAuditTemplate(companyId: string, allowed: boolean, body: Payload) {
  if (!allowed) return NextResponse.json({ error: "Fleet Masters permission denied." }, { status: 403 });
  const id = required(body.id, "Audit template");
  const [template, controls, audits] = await Promise.all([
    supabaseAdmin!.from("fleet_audit_templates").select("id,is_default").eq("company_id", companyId).eq("id", id).eq("is_active", true).maybeSingle(),
    supabaseAdmin!.from("fleet_audit_checklist_items").select("id", { count: "exact", head: true }).eq("company_id", companyId).eq("template_id", id).eq("is_active", true),
    supabaseAdmin!.from("fleet_audits").select("id", { count: "exact", head: true }).eq("company_id", companyId).eq("template_id", id)
  ]);
  if (template.error || controls.error || audits.error) throw new Error(template.error?.message ?? controls.error?.message ?? audits.error?.message ?? "Template could not be checked.");
  if (!template.data) throw new Error("Audit template was not found.");
  if (template.data.is_default) throw new Error("Set another template as default before removing this one.");
  if ((controls.count ?? 0) > 0 || (audits.count ?? 0) > 0) throw new Error("Remove its checklist controls first. Templates already used by an audit are retained for history.");
  const result = await supabaseAdmin!.from("fleet_audit_templates").update({ is_active: false, updated_at: new Date().toISOString() }).eq("company_id", companyId).eq("id", id);
  if (result.error) throw new Error(result.error.message);
  return NextResponse.json({ ok: true, message: "Audit template removed." });
}

function documentTypeCode(value: unknown, name: unknown) {
  const raw = clean(value || name).toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!raw) throw new Error("Document code is required.");
  return raw.startsWith("FLEET_") ? raw : `FLEET_${raw}`;
}

async function upsertDocumentType(companyId: string, allowed: boolean, body: Payload) {
  if (!allowed) return NextResponse.json({ error: "Fleet Masters permission denied." }, { status: 403 });
  const id = clean(body.id);
  const code = documentTypeCode(body.code, body.name);
  const expiryMode = clean(body.expiryMode);
  const values = {
    company_id: companyId,
    code,
    name: required(body.name, "Document name"),
    description: clean(body.description) || null,
    requires_expiry: expiryMode === "required",
    reminder_days: Math.max(0, Math.min(365, Number(body.reminderDays ?? 30) || 0)),
    sort_order: Math.max(0, Number(body.sortOrder ?? 100) || 0),
    document_module: "fleet",
    doc_scope: "fleet",
    is_active: true,
    updated_at: new Date().toISOString()
  };
  const result = id
    ? await supabaseAdmin!.from("document_types").update(values).eq("company_id", companyId).eq("id", id).eq("document_module", "fleet").select("id").maybeSingle()
    : await supabaseAdmin!.from("document_types").insert(values).select("id").single();
  if (result.error) throw new Error(result.error.message);
  if (!result.data) throw new Error("Document type was not found.");
  return NextResponse.json({ ok: true, id: result.data.id, message: id ? "Document rule updated." : "Document rule added." });
}

async function removeDocumentType(companyId: string, allowed: boolean, body: Payload) {
  if (!allowed) return NextResponse.json({ error: "Fleet Masters permission denied." }, { status: 403 });
  const id = required(body.id, "Document type");
  const type = await supabaseAdmin!.from("document_types").select("id,code").eq("company_id", companyId).eq("id", id).eq("document_module", "fleet").eq("is_active", true).maybeSingle();
  if (type.error) throw new Error(type.error.message);
  if (!type.data) throw new Error("Document type was not found.");
  const used = await supabaseAdmin!.from("fleet_vehicle_documents").select("id", { count: "exact", head: true }).eq("company_id", companyId).eq("document_type", type.data.code).eq("is_active", true);
  if (used.error) throw new Error(used.error.message);
  if ((used.count ?? 0) > 0) throw new Error("This document type is used by vehicle files. Keep it for history or remove those files first.");
  const result = await supabaseAdmin!.from("document_types").update({ is_active: false, updated_at: new Date().toISOString() }).eq("company_id", companyId).eq("id", id);
  if (result.error) throw new Error(result.error.message);
  return NextResponse.json({ ok: true, message: "Document rule removed." });
}

function masterKey(value: unknown, label: string) {
  const key = clean(value).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!key) throw new Error(`${label} is required.`);
  return key;
}

async function upsertVehicleStatus(companyId: string, allowed: boolean, body: Payload) {
  if (!allowed) return NextResponse.json({ error: "Fleet Masters permission denied." }, { status: 403 });
  const id = clean(body.id);
  const values = {
    company_id: companyId,
    status_key: masterKey(body.key || body.label, "Status key"),
    label: required(body.label, "Status name"),
    helper_text: clean(body.helper) || null,
    tone: ["good", "info", "warn", "bad", "neutral"].includes(clean(body.tone)) ? clean(body.tone) : "neutral",
    is_operational: Boolean(body.isOperational),
    is_terminal: Boolean(body.isTerminal),
    requires_reason: Boolean(body.requiresReason),
    requires_expected_date: Boolean(body.requiresExpectedDate),
    sort_order: Number(body.sortOrder ?? 100),
    is_active: true,
    updated_at: new Date().toISOString()
  };
  const result = id
    ? await supabaseAdmin!.from("fleet_vehicle_status_master").update(values).eq("company_id", companyId).eq("id", id).select("id").maybeSingle()
    : await supabaseAdmin!.from("fleet_vehicle_status_master").insert(values).select("id").single();
  if (result.error) throw new Error(result.error.message);
  if (!result.data) throw new Error("Vehicle status was not found.");
  return NextResponse.json({ ok: true, id: result.data.id, message: id ? "Vehicle status updated." : "Vehicle status added." });
}

async function removeVehicleStatus(companyId: string, allowed: boolean, body: Payload) {
  if (!allowed) return NextResponse.json({ error: "Fleet Masters permission denied." }, { status: 403 });
  const id = required(body.id, "Vehicle status");
  const current = await supabaseAdmin!.from("fleet_vehicle_status_master").select("status_key").eq("company_id", companyId).eq("id", id).maybeSingle();
  if (current.error) throw new Error(current.error.message);
  if (!current.data) throw new Error("Vehicle status was not found.");
  if (current.data.status_key === "active") throw new Error("Active is the required operational status and cannot be removed.");
  const inUse = await supabaseAdmin!.from("fleet_vehicles").select("id", { count: "exact", head: true }).eq("company_id", companyId).eq("status", current.data.status_key);
  if (inUse.error) throw new Error(inUse.error.message);
  if (inUse.count) throw new Error(`Move ${inUse.count} vehicle${inUse.count === 1 ? "" : "s"} to another status before removing this one.`);
  const result = await supabaseAdmin!.from("fleet_vehicle_status_master").update({ is_active: false, updated_at: new Date().toISOString() }).eq("company_id", companyId).eq("id", id);
  if (result.error) throw new Error(result.error.message);
  return NextResponse.json({ ok: true, message: "Vehicle status removed from new updates." });
}

async function upsertVehicleStatusReason(companyId: string, allowed: boolean, body: Payload) {
  if (!allowed) return NextResponse.json({ error: "Fleet Masters permission denied." }, { status: 403 });
  const id = clean(body.id);
  const statusId = required(body.statusId, "Vehicle status");
  const status = await supabaseAdmin!.from("fleet_vehicle_status_master").select("id").eq("company_id", companyId).eq("id", statusId).maybeSingle();
  if (status.error) throw new Error(status.error.message);
  if (!status.data) throw new Error("Vehicle status was not found.");
  const values = { company_id: companyId, status_id: statusId, reason_key: masterKey(body.key || body.label, "Reason key"), label: required(body.label, "Reason name"), helper_text: clean(body.helper) || null, sort_order: Number(body.sortOrder ?? 100), is_active: true, updated_at: new Date().toISOString() };
  const result = id
    ? await supabaseAdmin!.from("fleet_vehicle_status_reason_master").update(values).eq("company_id", companyId).eq("id", id).select("id").maybeSingle()
    : await supabaseAdmin!.from("fleet_vehicle_status_reason_master").insert(values).select("id").single();
  if (result.error) throw new Error(result.error.message);
  if (!result.data) throw new Error("Status reason was not found.");
  return NextResponse.json({ ok: true, id: result.data.id, message: id ? "Status reason updated." : "Status reason added." });
}

async function removeVehicleStatusReason(companyId: string, allowed: boolean, body: Payload) {
  if (!allowed) return NextResponse.json({ error: "Fleet Masters permission denied." }, { status: 403 });
  const id = required(body.id, "Status reason");
  const result = await supabaseAdmin!.from("fleet_vehicle_status_reason_master").update({ is_active: false, updated_at: new Date().toISOString() }).eq("company_id", companyId).eq("id", id).select("id").maybeSingle();
  if (result.error) throw new Error(result.error.message);
  if (!result.data) throw new Error("Status reason was not found.");
  return NextResponse.json({ ok: true, message: "Status reason removed from new updates." });
}

async function updateSettings(companyId: string, userId: string, allowed: boolean, body: Payload) {
  if (!allowed) return NextResponse.json({ error: "Fleet settings permission denied." }, { status: 403 });
  const result = await supabaseAdmin!.from("fleet_control_settings").upsert({ company_id: companyId, default_audit_cadence_days: Number(body.defaultAuditCadenceDays ?? 30), document_warning_days: Number(body.documentWarningDays ?? 30), service_warning_days: Number(body.serviceWarningDays ?? 14), auto_suggest_audits: Boolean(body.autoSuggestAudits), breakdown_vehicle_link_required: Boolean(body.breakdownVehicleLinkRequired), audit_email_enabled: Boolean(body.auditEmailEnabled), audit_video_required: Boolean(body.auditVideoRequired), updated_by: userId, updated_at: new Date().toISOString() });
  if (result.error) throw new Error(result.error.message);
  return NextResponse.json({ ok: true, message: "Fleet settings updated." });
}

async function updateAuditProgrammeSettings(companyId: string, userId: string, allowed: boolean, body: Payload) {
  if (!allowed) return NextResponse.json({ error: "Fleet settings permission denied." }, { status: 403 });
  const existing = await supabaseAdmin!.from("fleet_control_settings").select("risk_weights").eq("company_id", companyId).maybeSingle();
  if (existing.error) throw new Error(existing.error.message);
  const riskWeights = existing.data?.risk_weights && typeof existing.data.risk_weights === "object" ? existing.data.risk_weights as Record<string, unknown> : {};
  const auditProgramme = normalizeFleetAuditProgrammeConfig(body.auditProgramme);
  const result = await supabaseAdmin!.from("fleet_control_settings").upsert({ company_id: companyId, risk_weights: { ...riskWeights, audit_programme: auditProgramme }, updated_by: userId, updated_at: new Date().toISOString() });
  if (result.error) throw new Error(result.error.message);
  return NextResponse.json({ ok: true, message: auditProgramme.enabled ? "Automatic audit programme and email design saved." : "Audit programme settings saved on hold." });
}

async function updateMailSettings(companyId: string, userId: string, allowed: boolean, body: Payload) {
  if (!allowed) return NextResponse.json({ error: "Fleet settings permission denied." }, { status: 403 });
  const enabled = Boolean(body.dailyStatusEmailEnabled);
  const emailConfig = normalizeFleetDailyStatusEmailConfig(body.dailyStatusEmailConfig);
  const result = await supabaseAdmin!.from("fleet_control_settings").upsert({ company_id: companyId, daily_status_email_enabled: enabled, daily_status_send_time: clean(body.dailyStatusSendTime) || "20:00", daily_status_only_affected: body.dailyStatusOnlyAffected !== false, daily_status_email_config: emailConfig, updated_by: userId, updated_at: new Date().toISOString() });
  if (result.error) throw new Error(result.error.message);
  return NextResponse.json({ ok: true, message: enabled ? "Daily Fleet mail configuration saved and scheduled." : "Daily Fleet mail configuration saved on hold." });
}

async function upsertStatusRecipient(companyId: string, userId: string, allowed: boolean, body: Payload) {
  if (!allowed) return NextResponse.json({ error: "Fleet settings permission denied." }, { status: 403 });
  const email = required(body.email, "Recipient email").toLowerCase();
  if (!emailPattern.test(email)) throw new Error("Enter a valid recipient email.");
  const stationCodes = Array.isArray(body.stationCodes) ? [...new Set(body.stationCodes.map((value: unknown) => clean(value).toUpperCase()).filter(Boolean))] : [];
  const values = { company_id: companyId, name: clean(body.name) || email, email, station_codes: stationCodes, source: "manual", is_active: true, created_by: userId, updated_at: new Date().toISOString() };
  const recipientId = clean(body.recipientId);
  const result = recipientId
    ? await supabaseAdmin!.from("fleet_status_report_recipients").update(values).eq("company_id", companyId).eq("id", recipientId).select("id").maybeSingle()
    : await supabaseAdmin!.from("fleet_status_report_recipients").upsert(values, { onConflict: "company_id,email" }).select("id").single();
  if (result.error) throw new Error(result.error.message);
  if (!result.data) throw new Error("Daily status recipient was not found.");
  return NextResponse.json({ ok: true, id: result.data.id, message: recipientId ? "Daily status recipient updated." : "Daily status recipient added." });
}

async function removeStatusRecipient(companyId: string, allowed: boolean, body: Payload) {
  if (!allowed) return NextResponse.json({ error: "Fleet settings permission denied." }, { status: 403 });
  const recipientId = required(body.recipientId, "Recipient");
  const result = await supabaseAdmin!.from("fleet_status_report_recipients").update({ is_active: false, updated_at: new Date().toISOString() }).eq("company_id", companyId).eq("id", recipientId).select("id").maybeSingle();
  if (result.error) throw new Error(result.error.message);
  if (!result.data) throw new Error("Recipient was not found.");
  return NextResponse.json({ ok: true, message: "Daily status recipient removed." });
}

async function toggleStatusRecipient(companyId: string, allowed: boolean, body: Payload) {
  if (!allowed) return NextResponse.json({ error: "Fleet settings permission denied." }, { status: 403 });
  const recipientId = required(body.recipientId, "Recipient");
  const result = await supabaseAdmin!.from("fleet_status_report_recipients").update({ is_active: body.isActive !== false, updated_at: new Date().toISOString() }).eq("company_id", companyId).eq("id", recipientId).select("id").maybeSingle();
  if (result.error) throw new Error(result.error.message);
  if (!result.data) throw new Error("Recipient was not found.");
  return NextResponse.json({ ok: true, message: body.isActive !== false ? "Recipient resumed." : "Recipient placed on hold." });
}

async function deleteStatusRecipient(companyId: string, allowed: boolean, body: Payload) {
  if (!allowed) return NextResponse.json({ error: "Fleet settings permission denied." }, { status: 403 });
  const recipientId = required(body.recipientId, "Recipient");
  const result = await supabaseAdmin!.from("fleet_status_report_recipients").delete().eq("company_id", companyId).eq("id", recipientId).select("id").maybeSingle();
  if (result.error) throw new Error(result.error.message);
  if (!result.data) throw new Error("Recipient was not found.");
  return NextResponse.json({ ok: true, message: "Recipient deleted." });
}

async function upsertMember(companyId: string, userId: string, allowed: boolean, body: Payload) {
  if (!allowed) return NextResponse.json({ error: "User access permission denied." }, { status: 403 });
  const email = required(body.email, "User email").toLowerCase(); if (!emailPattern.test(email)) throw new Error("Enter a valid user email.");
  const profile = await supabaseAdmin!.from("profiles").select("id").eq("company_id", companyId).ilike("email", email).eq("is_active", true).maybeSingle();
  if (profile.error) throw new Error(profile.error.message); if (!profile.data) throw new Error("This email does not have an active dashboard user in the company.");
  const scopeIds = Array.isArray(body.locationScopeIds) ? body.locationScopeIds.map(clean).filter(Boolean) : [];
  const result = await supabaseAdmin!.from("fleet_portal_memberships").upsert({ company_id: companyId, user_id: profile.data.id, access_level: clean(body.accessLevel) || "viewer", has_all_location_access: Boolean(body.hasAllLocationAccess), location_scope_ids: scopeIds, is_active: body.isActive !== false, created_by: userId, updated_at: new Date().toISOString() }, { onConflict: "company_id,user_id" });
  if (result.error) throw new Error(result.error.message);
  return NextResponse.json({ ok: true, message: "Fleet user access updated." });
}

async function saveAuditDraft(companyId:string,allowed:boolean,body:Payload) {
 if(!allowed) return NextResponse.json({error:'Audit permission denied.'},{status:403});
 const draft=body.draft && typeof body.draft==='object' ? body.draft : {};
 if(Array.isArray(draft) || Object.values(draft).some(value=>typeof value!=='string')) throw new Error('Draft answers must be text values.');
 if(JSON.stringify(draft).length>200000) throw new Error('Draft is too large.');
 const result=await supabaseAdmin!.from('fleet_audits').update({draft,updated_at:new Date().toISOString()}).eq('company_id',companyId).eq('id',required(body.auditId,'Audit')).in('status',['scheduled','in_progress']).select('id').maybeSingle();
 if(result.error || !result.data) throw new Error(result.error?.message || 'Audit is no longer open.');
 return NextResponse.json({ok:true,message:'Draft saved. You can continue on any device.'});
}
async function updateFinding(companyId:string,allowed:boolean,body:Payload) {
 if(!allowed) return NextResponse.json({error:'Maintenance permission denied.'},{status:403});
 const status=clean(body.status);
 if(!['open','in_progress','resolved'].includes(status)) throw new Error('Choose a valid action status.');
 const note=required(body.resolutionNote,'Update / resolution note');
 const result=await supabaseAdmin!.from('fleet_audit_findings').update({status,resolution_note:note,resolved_at:status==='resolved'?new Date().toISOString():null,updated_at:new Date().toISOString()}).eq('company_id',companyId).eq('id',required(body.findingId,'Finding')).select('id').maybeSingle();
 if(result.error || !result.data) throw new Error(result.error?.message || 'Finding not found.');
 return NextResponse.json({ok:true,message:status==='resolved'?'Finding resolved.':'Follow-up updated.'});
}
