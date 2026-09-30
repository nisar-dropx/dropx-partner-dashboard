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

async function access() {
  const authorization = await getAuthorization();
  if (!authorization) return { error: NextResponse.json({ error: "Login required." }, { status: 401 }) };
  const companyId = requireCompanyId(authorization);
  const canManageFleet = authorization.isMasterOwner || hasPermission(authorization, "fleet_maintenance", "edit") || hasPermission(authorization, "fleet_vehicle_view", "edit");
  const canManageSettings = authorization.isMasterOwner || hasPermission(authorization, "fleet_settings", "edit") || hasPermission(authorization, "fleet_masters", "edit") || hasPermission(authorization, "app_settings", "edit") || hasPermission(authorization, "users", "edit");
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
    if (action === "service.schedule") return await scheduleService(context.companyId, context.authorization.userId, context.canManageFleet, body);
    if (action === "audit.schedule") return await scheduleAudit(context.companyId, context.authorization.userId, context.canManageFleet, body);
    if (action === "audit.reschedule") return await rescheduleAudit(context.companyId, context.authorization.userId, context.canManageFleet, body);
    if (action === "audit.cancel") return await cancelAudit(context.companyId, context.authorization.userId, context.canManageFleet, body);
    if (action === "audit.start") return await startAudit(context.companyId, context.authorization.userId, context.canManageFleet, body);
    if (action === "audit.complete") return await completeAudit(context.companyId, context.authorization.userId, context.canManageFleet, body);
    if (action === "checklist.create") return await createChecklistItem(context.companyId, context.canManageSettings, body);
    if (action === "checklist.update") return await updateChecklistItem(context.companyId, context.canManageSettings, body);
    if (action === "checklist.remove") return await removeChecklistItem(context.companyId, context.canManageSettings, body);
    if (action === "settings.update") return await updateSettings(context.companyId, context.authorization.userId, context.canManageSettings, body);
    if (action === "member.upsert") return await upsertMember(context.companyId, context.authorization.userId, context.canManageSettings, body);
    if (action === "status-recipient.upsert") return await upsertStatusRecipient(context.companyId, context.authorization.userId, context.canManageSettings, body);
    if (action === "status-recipient.remove") return await removeStatusRecipient(context.companyId, context.canManageSettings, body);
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
  const responses = Array.isArray(body.responses) ? body.responses : [];
  if (responses.length) {
    const rows = responses.map((response: Payload) => ({ company_id: companyId, audit_id: auditId, checklist_item_id: required(response.itemId, "Checklist item"), response_value: { value: response.value }, passed: response.passed == null ? null : Boolean(response.passed), comments: clean(response.comments) || null, responded_by: userId }));
    const saved = await supabaseAdmin!.from("fleet_audit_responses").upsert(rows, { onConflict: "audit_id,checklist_item_id" });
    if (saved.error) throw new Error(saved.error.message);
  }
  const evidence = Array.isArray(body.evidence) ? body.evidence.filter((item: Payload) => clean(item.url)) : [];
  const auditMode = /^\[mode:video\]/i.test(clean(auditResult.data.scheduled_reason)) ? "video" : "physical";
  if (auditMode === "video" && !evidence.some((item: Payload) => clean(item.type) === "video")) throw new Error("A complete walk-around video link is required for the remote video audit.");
  let checklistRuleQuery = supabaseAdmin!.from("fleet_audit_checklist_items").select("id,label,guidance,response_type,is_required,audit_mode").eq("company_id", companyId).eq("is_active", true);
  if (auditResult.data.template_id) checklistRuleQuery = checklistRuleQuery.eq("template_id", auditResult.data.template_id);
  const checklistRules = await checklistRuleQuery;
  if (checklistRules.error) throw new Error(checklistRules.error.message);
  for (const item of (checklistRules.data ?? []).filter((row: any) => !row.audit_mode || row.audit_mode === "both" || row.audit_mode === auditMode)) {
    const response = responses.find((entry: Payload) => clean(entry.itemId) === item.id);
    if (item.is_required && !clean(response?.value)) throw new Error(`${item.label} must be completed before the audit can be submitted.`);
    const rules = checklistEvidenceRules(item.guidance, item.response_type);
    const selectedRule = response?.passed === false ? rules.fail : rules.pass;
    if (response?.passed === false && rules.failRemarksRequired && !clean(response?.comments)) throw new Error(`${item.label} requires a remark when marked non-compliant.`);
    const evidenceType = selectedRule.type;
    const minimum = selectedRule.minimum;
    if (!minimum) continue;
    const attached = evidence.filter((entry: Payload) => clean(entry.itemId) === item.id && (evidenceType === "any" || clean(entry.type) === evidenceType)).length;
    if (attached < minimum) throw new Error(`${item.label} requires ${minimum} ${evidenceType === "any" ? "attachment" : evidenceType} ${minimum === 1 ? "link" : "links"} when marked ${response?.passed === false ? "non-compliant" : "compliant"}.`);
  }
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
  const values = checklistItemValues(body);
  const result = await supabaseAdmin!.from("fleet_audit_checklist_items").insert({ company_id: companyId, template_id: templateId, ...values }).select("id").single();
  if (result.error) throw new Error(result.error.message);
  return NextResponse.json({ ok: true, id: result.data.id, message: "Checklist item added." });
}

function checklistItemValues(body: Payload) {
  const pass = evidenceRule(body.passEvidenceType, body.passMinEvidence);
  const fail = evidenceRule(body.failEvidenceType, body.failMinEvidence);
  const guidance = `[remarks-fail:${body.failRemarksRequired === false ? "optional" : "required"}] [evidence-pass:${pass.type}:${pass.minimum}] [evidence-fail:${fail.type}:${fail.minimum}] ${clean(body.guidance)}`.trim();
  return { audit_mode: ["video", "physical"].includes(clean(body.auditMode)) ? clean(body.auditMode) : "both", category: required(body.category, "Category"), label: required(body.label, "Checklist item"), guidance, response_type: clean(body.responseType) || "pass_fail", is_required: body.isRequired !== false, failure_severity: clean(body.failureSeverity) || "medium", sort_order: Number(body.sortOrder ?? 999), is_active: true };
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

async function updateSettings(companyId: string, userId: string, allowed: boolean, body: Payload) {
  if (!allowed) return NextResponse.json({ error: "Fleet settings permission denied." }, { status: 403 });
  const result = await supabaseAdmin!.from("fleet_control_settings").upsert({ company_id: companyId, default_audit_cadence_days: Number(body.defaultAuditCadenceDays ?? 30), document_warning_days: Number(body.documentWarningDays ?? 30), service_warning_days: Number(body.serviceWarningDays ?? 14), auto_suggest_audits: Boolean(body.autoSuggestAudits), breakdown_vehicle_link_required: Boolean(body.breakdownVehicleLinkRequired), audit_email_enabled: Boolean(body.auditEmailEnabled), audit_video_required: Boolean(body.auditVideoRequired), daily_status_email_enabled: Boolean(body.dailyStatusEmailEnabled), daily_status_send_time: clean(body.dailyStatusSendTime) || "20:30", daily_status_only_affected: body.dailyStatusOnlyAffected !== false, updated_by: userId, updated_at: new Date().toISOString() });
  if (result.error) throw new Error(result.error.message);
  return NextResponse.json({ ok: true, message: "Fleet settings updated." });
}

async function upsertStatusRecipient(companyId: string, userId: string, allowed: boolean, body: Payload) {
  if (!allowed) return NextResponse.json({ error: "Fleet settings permission denied." }, { status: 403 });
  const email = required(body.email, "Recipient email").toLowerCase();
  if (!emailPattern.test(email)) throw new Error("Enter a valid recipient email.");
  const stationCodes = Array.isArray(body.stationCodes) ? [...new Set(body.stationCodes.map((value: unknown) => clean(value).toUpperCase()).filter(Boolean))] : [];
  const values = { company_id: companyId, name: clean(body.name) || email, email, station_codes: stationCodes, source: "manual", is_active: true, created_by: userId, updated_at: new Date().toISOString() };
  const result = await supabaseAdmin!.from("fleet_status_report_recipients").upsert(values, { onConflict: "company_id,email" }).select("id").single();
  if (result.error) throw new Error(result.error.message);
  return NextResponse.json({ ok: true, id: result.data.id, message: "Daily status recipient saved." });
}

async function removeStatusRecipient(companyId: string, allowed: boolean, body: Payload) {
  if (!allowed) return NextResponse.json({ error: "Fleet settings permission denied." }, { status: 403 });
  const recipientId = required(body.recipientId, "Recipient");
  const result = await supabaseAdmin!.from("fleet_status_report_recipients").update({ is_active: false, updated_at: new Date().toISOString() }).eq("company_id", companyId).eq("id", recipientId).select("id").maybeSingle();
  if (result.error) throw new Error(result.error.message);
  if (!result.data) throw new Error("Recipient was not found.");
  return NextResponse.json({ ok: true, message: "Daily status recipient removed." });
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
