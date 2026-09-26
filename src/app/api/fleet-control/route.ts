import { NextResponse } from "next/server";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { sendEmail } from "@/lib/email";
import { supabaseAdmin } from "@/lib/supabase-admin";

type Payload = Record<string, any>;
const emailPattern = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
function clean(value: unknown) { return String(value ?? "").trim(); }
function numberOrNull(value: unknown) { const parsed = Number(value); return value == null || value === "" || !Number.isFinite(parsed) ? null : parsed; }
function required(value: unknown, label: string) { const result = clean(value); if (!result) throw new Error(`${label} is required.`); return result; }
function setupError(message: string) { return /does not exist|schema cache|could not find the table/i.test(message) ? `${message} Apply the Fleet Control migration before using this action.` : message; }

async function access() {
  const authorization = await getAuthorization();
  if (!authorization) return { error: NextResponse.json({ error: "Login required." }, { status: 401 }) };
  const companyId = requireCompanyId(authorization);
  const canManageFleet = authorization.isMasterOwner || hasPermission(authorization, "fleet_maintenance", "edit") || hasPermission(authorization, "fleet_vehicle_view", "edit");
  const canManageSettings = authorization.isMasterOwner || hasPermission(authorization, "app_settings", "edit") || hasPermission(authorization, "users", "edit");
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
    if (action === "service.create") return await createService(context.companyId, context.authorization.userId, context.canManageFleet, body);
    if (action === "audit.schedule") return await scheduleAudit(context.companyId, context.authorization.userId, context.canManageFleet, body);
    if (action === "audit.complete") return await completeAudit(context.companyId, context.authorization.userId, context.canManageFleet, body);
    if (action === "checklist.create") return await createChecklistItem(context.companyId, context.canManageSettings, body);
    if (action === "settings.update") return await updateSettings(context.companyId, context.authorization.userId, context.canManageSettings, body);
    if (action === "member.upsert") return await upsertMember(context.companyId, context.authorization.userId, context.canManageSettings, body);
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
  const result = await supabaseAdmin!.from("fleet_audits").insert({ company_id: companyId, vehicle_id: vehicleId, template_id: templateId,
    scheduled_for: required(body.scheduledFor, "Scheduled date"), scheduled_reason: clean(body.scheduledReason) || "Routine audit",
    risk_score: Math.max(0, Math.min(100, Number(body.riskScore ?? 0))), status: "scheduled", assigned_to: clean(body.assignedTo) || null, created_by: userId
  }).select("id").single();
  if (result.error) throw new Error(result.error.message);
  return NextResponse.json({ ok: true, id: result.data.id, message: "Vehicle audit scheduled." });
}

async function completeAudit(companyId: string, userId: string, allowed: boolean, body: Payload) {
  if (!allowed) return NextResponse.json({ error: "Fleet audit permission denied." }, { status: 403 });
  const auditId = required(body.auditId, "Audit");
  const auditResult = await supabaseAdmin!.from("fleet_audits").select("id,vehicle_id,scheduled_for,fleet_vehicles!inner(vehicle_no,station_code,model)").eq("company_id", companyId).eq("id", auditId).maybeSingle();
  if (auditResult.error) throw new Error(auditResult.error.message);
  if (!auditResult.data) throw new Error("Audit was not found.");
  const responses = Array.isArray(body.responses) ? body.responses : [];
  if (responses.length) {
    const rows = responses.map((response: Payload) => ({ company_id: companyId, audit_id: auditId, checklist_item_id: required(response.itemId, "Checklist item"), response_value: { value: response.value }, passed: response.passed == null ? null : Boolean(response.passed), comments: clean(response.comments) || null, responded_by: userId }));
    const saved = await supabaseAdmin!.from("fleet_audit_responses").upsert(rows, { onConflict: "audit_id,checklist_item_id" });
    if (saved.error) throw new Error(saved.error.message);
  }
  const evidence = Array.isArray(body.evidence) ? body.evidence.filter((item: Payload) => clean(item.url)) : [];
  if (evidence.length) {
    const saved = await supabaseAdmin!.from("fleet_audit_evidence").insert(evidence.map((item: Payload) => ({ company_id: companyId, audit_id: auditId, checklist_item_id: clean(item.itemId) || null, media_type: ["photo", "video", "document"].includes(clean(item.type)) ? clean(item.type) : "photo", media_url: clean(item.url), caption: clean(item.caption) || null, captured_at: clean(item.capturedAt) || null, uploaded_by: userId })));
    if (saved.error) throw new Error(saved.error.message);
  }
  const findings = Array.isArray(body.findings) ? body.findings.filter((item: Payload) => clean(item.finding)) : [];
  if (findings.length) {
    const saved = await supabaseAdmin!.from("fleet_audit_findings").insert(findings.map((item: Payload) => ({ company_id: companyId, audit_id: auditId, category: clean(item.category) || "General", finding: clean(item.finding), severity: clean(item.severity) || "medium", action_required: clean(item.actionRequired) || null, expected_completion_date: clean(item.expectedCompletionDate) || null })));
    if (saved.error) throw new Error(saved.error.message);
  }
  const failed = responses.some((response: Payload) => response.passed === false) || findings.some((item: Payload) => ["critical", "high"].includes(clean(item.severity)));
  const scored = responses.filter((response: Payload) => response.passed != null);
  const score = scored.length ? Math.round((scored.filter((response: Payload) => response.passed).length / scored.length) * 10000) / 100 : null;
  const update = await supabaseAdmin!.from("fleet_audits").update({ status: failed ? "failed" : "passed", score, summary: clean(body.summary) || (failed ? "Issues found during routine vehicle audit." : "No critical issues found."), odometer_km: numberOrNull(body.odometerKm), completed_at: new Date().toISOString(), completed_by: userId, updated_at: new Date().toISOString(), email_status: body.sendEmail === false ? "not_sent" : "queued" }).eq("company_id", companyId).eq("id", auditId);
  if (update.error) throw new Error(update.error.message);
  let emailStatus = "not_sent";
  if (body.sendEmail !== false) emailStatus = await sendAuditEmail(companyId, auditId, auditResult.data as Payload, failed, clean(body.summary), findings, evidence);
  return NextResponse.json({ ok: true, message: emailStatus === "sent" ? "Audit completed and summary emailed." : "Audit completed.", emailStatus });
}

async function sendAuditEmail(companyId: string, auditId: string, audit: Payload, failed: boolean, summary: string, findings: Payload[], evidence: Payload[]) {
  const vehicle = Array.isArray(audit.fleet_vehicles) ? audit.fleet_vehicles[0] : audit.fleet_vehicles;
  const station = await supabaseAdmin!.from("stations").select("station_email,station_manager_email").eq("company_id", companyId).eq("station_code", vehicle.station_code).maybeSingle();
  const admins = await supabaseAdmin!.from("fleet_portal_memberships").select("profiles:user_id(email)").eq("company_id", companyId).eq("is_active", true).in("access_level", ["administrator", "approver"]);
  const to = [station.data?.station_email, station.data?.station_manager_email].map(clean).filter((email) => emailPattern.test(email));
  const cc = (admins.data ?? []).flatMap((row: any) => { const profile = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles; return clean(profile?.email); }).filter((email: string) => emailPattern.test(email) && !to.includes(email));
  if (!to.length) { await supabaseAdmin!.from("fleet_audits").update({ email_status: "failed" }).eq("id", auditId); return "failed"; }
  const subject = `Routine Van Audit Key Findings - ${vehicle.station_code} ${vehicle.vehicle_no}, ${vehicle.model} | ${audit.scheduled_for}`;
  const findingLines = findings.length ? findings.map((item) => `- ${clean(item.finding)}${clean(item.actionRequired) ? ` — Action: ${clean(item.actionRequired)}` : ""}`).join("\n") : "- No material issue recorded.";
  const evidenceLines = evidence.length ? evidence.map((item) => `- ${clean(item.type)}: ${clean(item.url)}`).join("\n") : "- No evidence link recorded.";
  const body = `Vehicle Audit Details\nStation: ${vehicle.station_code}\nVehicle: ${vehicle.vehicle_no}\nModel: ${vehicle.model}\nAudit date: ${audit.scheduled_for}\nResult: ${failed ? "Issues found" : "Passed"}\n\nSummary\n${summary || (failed ? "Issues found during the inspection." : "Vehicle passed the routine inspection.")}\n\nKey findings and required action\n${findingLines}\n\nPhoto / video evidence\n${evidenceLines}`;
  try { await sendEmail({ companyId, subject, body, to, cc, messageId: `<dropx.fleet-audit.${auditId}@partner.dropxlogistics.com>` }); await supabaseAdmin!.from("fleet_audits").update({ email_status: "sent", email_sent_at: new Date().toISOString(), email_recipients: { to, cc } }).eq("id", auditId); return "sent"; }
  catch { await supabaseAdmin!.from("fleet_audits").update({ email_status: "failed", email_recipients: { to, cc } }).eq("id", auditId); return "failed"; }
}

async function createChecklistItem(companyId: string, allowed: boolean, body: Payload) {
  if (!allowed) return NextResponse.json({ error: "Fleet settings permission denied." }, { status: 403 });
  const templateId = required(body.templateId, "Template");
  const template = await supabaseAdmin!.from("fleet_audit_templates").select("id").eq("company_id", companyId).eq("id", templateId).maybeSingle();
  if (template.error) throw new Error(template.error.message); if (!template.data) throw new Error("Audit template was not found.");
  const result = await supabaseAdmin!.from("fleet_audit_checklist_items").insert({ company_id: companyId, template_id: templateId, category: required(body.category, "Category"), label: required(body.label, "Checklist item"), guidance: clean(body.guidance) || null, response_type: clean(body.responseType) || "pass_fail", is_required: body.isRequired !== false, failure_severity: clean(body.failureSeverity) || "medium", sort_order: Number(body.sortOrder ?? 999) }).select("id").single();
  if (result.error) throw new Error(result.error.message);
  return NextResponse.json({ ok: true, id: result.data.id, message: "Checklist item added." });
}

async function updateSettings(companyId: string, userId: string, allowed: boolean, body: Payload) {
  if (!allowed) return NextResponse.json({ error: "Fleet settings permission denied." }, { status: 403 });
  const result = await supabaseAdmin!.from("fleet_control_settings").upsert({ company_id: companyId, default_audit_cadence_days: Number(body.defaultAuditCadenceDays ?? 30), document_warning_days: Number(body.documentWarningDays ?? 30), service_warning_days: Number(body.serviceWarningDays ?? 14), auto_suggest_audits: Boolean(body.autoSuggestAudits), breakdown_vehicle_link_required: Boolean(body.breakdownVehicleLinkRequired), audit_email_enabled: Boolean(body.auditEmailEnabled), audit_video_required: Boolean(body.auditVideoRequired), updated_by: userId, updated_at: new Date().toISOString() });
  if (result.error) throw new Error(result.error.message);
  return NextResponse.json({ ok: true, message: "Fleet settings updated." });
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
