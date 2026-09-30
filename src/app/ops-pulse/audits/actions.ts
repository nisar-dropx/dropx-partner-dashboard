"use server";

import { revalidatePath } from "next/cache";
import { hasPermission, requirePagePermission, type AuthorizationContext } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { sendStationAuditCompletedEmail } from "@/lib/ops-pulse/station-audit-email";
import { uploadOpsProof } from "@/lib/ops-pulse/upload";
import { canManageStationAudits, canUseStationAuditLocation, createStationAudit, ensureAuditProgramme, isGoogleDriveUrl, loadAuditStations, loadStationAuditMaster, writeStationAuditEvent, type AuditChecklistItem, type AuditStation, type AuditType, type StationAudit } from "@/lib/ops-pulse/station-audits";
import { supabaseAdmin } from "@/lib/supabase-admin";

type ActionResult = { ok: true; message: string } | { ok: false; message: string };
const message = (error: unknown): ActionResult => ({ ok: false, message: error instanceof Error ? error.message : "Unable to save the audit." });
const clean = (value: FormDataEntryValue | null | undefined) => String(value ?? "").trim();
const number = (value: FormDataEntryValue | null | undefined) => { const parsed = Number(clean(value)); return Number.isFinite(parsed) ? parsed : null; };

function db() { if (!supabaseAdmin) throw new Error("Database service is unavailable."); return supabaseAdmin; }
function refreshAudits() { revalidatePath("/ops-pulse/audits"); revalidatePath("/ops-pulse/master/audits"); revalidatePath("/audits"); }
function auditDateTime(date: string, time: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) throw new Error("Choose a valid audit date and time.");
  return { date, time };
}
function responseBehaviour(item: AuditChecklistItem, value: string) {
  const selected = item.response_options.find((option) => option.value === value);
  return {
    isCompliant: selected?.is_compliant ?? null,
    requiresAction: selected?.requires_action === true,
    requiresEvidence: selected?.requires_evidence === true
  };
}
function parseShipments(value: string) {
  if (!value) return [] as Array<Record<string, unknown>>;
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter((row) => row && typeof row === "object") as Array<Record<string, unknown>> : []; }
  catch { throw new Error("Shipment exceptions could not be read. Refresh and try again."); }
}

async function readAudit(companyId: string, auditId: string, authorization: AuthorizationContext) {
  const result = await db().from("ops_station_audits").select("*,ops_audit_types(*),stations(id,station_code,station_name,city,cluster,cluster_name,station_email,station_manager_email,cluster_manager_email,ops_manager_email,finance_manager_email)")
    .eq("company_id", companyId).eq("id", auditId).maybeSingle();
  if (result.error) throw new Error(result.error.message);
  if (!result.data || !canUseStationAuditLocation(authorization, result.data.location_id)) throw new Error("This audit is unavailable in your station scope.");
  return result.data as StationAudit & { ops_audit_types: AuditType; stations: AuditStation };
}

async function assertManager(action: "add" | "edit") {
  const authorization = await requirePagePermission("station_audits", action);
  if (!canManageStationAudits(authorization)) throw new Error("Your Audit access is view only.");
  return authorization;
}

export async function scheduleStationAudit(formData: FormData): Promise<ActionResult> {
  try {
    const authorization = await assertManager("add"); const companyId = requireCompanyId(authorization);
    const { date, time } = auditDateTime(clean(formData.get("scheduled_date")), clean(formData.get("scheduled_time")));
    const audit = await createStationAudit({ companyId, authorization, auditTypeId: clean(formData.get("audit_type_id")), locationId: clean(formData.get("location_id")), scheduledDate: date, scheduledTime: time, periodSlot: clean(formData.get("period_slot")) || undefined, assignedName: clean(formData.get("assigned_name")) || undefined, reason: clean(formData.get("reason")) || undefined });
    refreshAudits(); return { ok: true, message: `${audit.audit_number} scheduled.` };
  } catch (error) { return message(error); }
}

export async function generateStationAuditProgramme(): Promise<ActionResult> {
  try {
    const authorization = await assertManager("add"); const companyId = requireCompanyId(authorization);
    const generated = await ensureAuditProgramme(companyId);
    refreshAudits();
    return { ok: true, message: generated.errors.length ? `${generated.created} audits generated. ${generated.errors.join(" ")}` : `${generated.created} audit slots generated from Audit Master.` };
  } catch (error) { return message(error); }
}

export async function beginStationAudit(auditId: string): Promise<ActionResult> {
  try {
    const authorization = await assertManager("edit"); const companyId = requireCompanyId(authorization); const audit = await readAudit(companyId, auditId, authorization);
    if (!['scheduled', 'in_progress'].includes(audit.status_code)) throw new Error("Only scheduled audits can be started.");
    const update = await db().from("ops_station_audits").update({ status_code: "in_progress", started_at: audit.started_at ?? new Date().toISOString(), assigned_to: authorization.userId, assigned_name: authorization.fullName, assigned_email: authorization.email }).eq("id", auditId).eq("company_id", companyId);
    if (update.error) throw new Error(update.error.message);
    await writeStationAuditEvent({ companyId, auditId, eventType: "started", authorization, before: { status: audit.status_code }, after: { status: "in_progress" } });
    refreshAudits(); return { ok: true, message: "Audit started. Record evidence as you go." };
  } catch (error) { return message(error); }
}

export async function submitStationAudit(formData: FormData): Promise<ActionResult> {
  try {
    const authorization = await assertManager("edit"); const companyId = requireCompanyId(authorization); const auditId = clean(formData.get("audit_id"));
    const audit = await readAudit(companyId, auditId, authorization);
    if (!['scheduled', 'in_progress', 'under_review', 'awaiting_station_response'].includes(audit.status_code)) throw new Error("This audit has already been closed.");
    const master = await loadStationAuditMaster(companyId);
    const type = master.auditTypes.find((row) => row.id === audit.audit_type_id);
    if (!type) throw new Error("The audit type was retired. Restore it in Audit Master before submitting.");
    const typeItems = master.checklistItems.filter((item) => item.audit_type_id === type.id);
    const responses: Array<{ company_id: string; audit_id: string; checklist_item_id: string; response_value: { value: string }; is_compliant: boolean | null; remarks: string | null; response_source: string; responded_by: string | null }> = [];
    const requiredActions: Array<{ item: AuditChecklistItem; action: string; preventive: string }> = [];
    let requiresEvidence = false;
    for (const item of typeItems) {
      const value = clean(formData.get(`check_${item.id}`));
      const remarks = clean(formData.get(`check_note_${item.id}`)) || null;
      if (item.is_required && !value) throw new Error(`Complete required check: ${item.label}`);
      if (!value) continue;
      const behaviour = responseBehaviour(item, value);
      responses.push({ company_id: companyId, audit_id: audit.id, checklist_item_id: item.id, response_value: { value }, is_compliant: behaviour.isCompliant, remarks, response_source: "auditor", responded_by: authorization.userId });
      requiresEvidence = requiresEvidence || behaviour.requiresEvidence;
      if (behaviour.requiresAction) {
        const action = clean(formData.get(`check_action_${item.id}`));
        if (!action) throw new Error(`Add a corrective action for: ${item.label}`);
        requiredActions.push({ item, action, preventive: clean(formData.get(`check_preventive_${item.id}`)) });
      }
    }
    const files = formData.getAll("evidence_files").filter((entry): entry is File => entry instanceof File && entry.size > 0);
    if (files.length > 8) throw new Error("Attach up to 8 audit evidence files at one time.");
    if (requiresEvidence && !files.length) throw new Error("Attach evidence for the selected checklist outcome.");
    const systemCash = number(formData.get("system_cash_amount"));
    const physicalCashEntered = number(formData.get("physical_cash_amount"));
    const denominations = master.options.filter((option) => option.option_group === "cash_denomination");
    const cashRows = denominations.map((option) => {
      const count = number(formData.get(`denomination_${option.id}`)) ?? 0;
      const amount = Number(option.metadata.value ?? option.code);
      if (!Number.isFinite(amount) || amount <= 0 || count < 0 || !Number.isInteger(count)) throw new Error("Enter whole, non-negative denomination counts.");
      return { option, count, amount };
    });
    const countedCash = cashRows.reduce((total, row) => total + row.count * row.amount, 0);
    if (physicalCashEntered != null && Math.abs(physicalCashEntered - countedCash) > 0.009) throw new Error("Physical COD and denomination total must match.");
    if (physicalCashEntered != null && !cashRows.some((row) => row.count > 0) && physicalCashEntered !== 0) throw new Error("Record the physical denomination count for the cash entered.");
    const videoUrl = clean(formData.get("video_call_url"));
    if (type.requires_video_link && !isGoogleDriveUrl(videoUrl)) throw new Error("Add a valid Google Drive video link for the virtual COD audit.");
    if (type.requires_video_link && clean(formData.get("video_access_confirmed")) !== "yes") throw new Error("Confirm that anyone with the video link can view the recording.");
    const shipments = parseShipments(clean(formData.get("shipments_json")));
    const shipmentRows = shipments.map((shipment) => {
      const trackingId = clean(String(shipment.trackingId ?? ""));
      if (!trackingId) throw new Error("Every shipment exception requires a tracking ID.");
      const discrepancy = clean(String(shipment.discrepancyCode ?? ""));
      const physicalStatus = clean(String(shipment.physicalStatusCode ?? ""));
      if (!discrepancy || !physicalStatus) throw new Error(`${trackingId}: choose both physical status and discrepancy.`);
      return { company_id: companyId, audit_id: audit.id, tracking_id: trackingId, system_status_code: clean(String(shipment.systemStatusCode ?? "")) || null, physical_status_code: physicalStatus, discrepancy_code: discrepancy, remarks: clean(String(shipment.remarks ?? "")) || null, required_action: clean(String(shipment.requiredAction ?? "")) || null, due_at: clean(String(shipment.dueAt ?? "")) || null, is_resolved: false };
    });
    const unresolvedShipments = shipmentRows.filter((row) => !row.is_resolved);
    const discrepancyOptions = new Map(master.options.filter((option) => option.option_group === "shipment_discrepancy").map((option) => [option.code, option]));
    const allActions = [
      ...requiredActions.map((row) => ({ company_id: companyId, audit_id: audit.id, checklist_item_id: row.item.id, title: row.item.label, corrective_action: row.action, preventive_action: row.preventive || null, severity_code: row.item.default_severity_code, status_code: "open", owner_user_id: null, owner_name: null, owner_email: null, due_at: clean(formData.get("action_due_at")) || audit.response_due_at, created_by: authorization.userId })),
      ...unresolvedShipments.filter((row) => row.required_action).map((row) => ({ company_id: companyId, audit_id: audit.id, checklist_item_id: null, title: `${row.tracking_id} · ${row.discrepancy_code}`, corrective_action: row.required_action!, preventive_action: null, severity_code: String(discrepancyOptions.get(row.discrepancy_code)?.metadata.default_severity_code ?? "") || null, status_code: "open", owner_user_id: null, owner_name: null, owner_email: null, due_at: row.due_at || audit.response_due_at, created_by: authorization.userId }))
    ];
    const nextStatus = allActions.length ? "awaiting_station_response" : "under_review";
    const update = await db().from("ops_station_audits").update({ status_code: nextStatus, station_response_status: allActions.length ? "requested" : "not_requested", system_cash_amount: systemCash, physical_cash_amount: physicalCashEntered == null ? null : countedCash, cash_variance_amount: systemCash == null || physicalCashEntered == null ? null : countedCash - systemCash, system_shipment_count: number(formData.get("system_shipment_count")), physical_shipment_count: number(formData.get("physical_shipment_count")), shipment_missing_count: shipmentRows.filter((row) => discrepancyOptions.get(row.discrepancy_code)?.metadata.count_as === "missing").length, shipment_excess_count: shipmentRows.filter((row) => discrepancyOptions.get(row.discrepancy_code)?.metadata.count_as === "excess").length, shipment_unresolved_count: unresolvedShipments.length, video_call_url: videoUrl || null, video_call_verified_at: videoUrl ? new Date().toISOString() : null, overall_summary: clean(formData.get("overall_summary")) || null, manager_summary: clean(formData.get("manager_summary")) || null, completed_at: new Date().toISOString(), completed_by: authorization.userId }).eq("company_id", companyId).eq("id", audit.id);
    if (update.error) throw new Error(update.error.message);
    const deleteRelated = await Promise.all([
      db().from("ops_station_audit_check_responses").delete().eq("company_id", companyId).eq("audit_id", audit.id),
      db().from("ops_station_audit_cash_counts").delete().eq("company_id", companyId).eq("audit_id", audit.id),
      db().from("ops_station_audit_shipments").delete().eq("company_id", companyId).eq("audit_id", audit.id),
      db().from("ops_station_audit_actions").delete().eq("company_id", companyId).eq("audit_id", audit.id).eq("status_code", "open")
    ]);
    const deleteError = deleteRelated.find((result) => result.error)?.error; if (deleteError) throw new Error(deleteError.message);
    if (responses.length) { const inserted = await db().from("ops_station_audit_check_responses").insert(responses); if (inserted.error) throw new Error(inserted.error.message); }
    const countRows = cashRows.filter((row) => row.count > 0).map((row) => ({ company_id: companyId, audit_id: audit.id, cash_side: "physical", denomination_option_id: row.option.id, denomination_value: row.amount, note_count: row.count }));
    if (countRows.length) { const inserted = await db().from("ops_station_audit_cash_counts").insert(countRows); if (inserted.error) throw new Error(inserted.error.message); }
    if (shipmentRows.length) { const inserted = await db().from("ops_station_audit_shipments").insert(shipmentRows); if (inserted.error) throw new Error(inserted.error.message); }
    if (allActions.length) { const inserted = await db().from("ops_station_audit_actions").insert(allActions); if (inserted.error) throw new Error(inserted.error.message); }
    for (const [index, file] of files.entries()) {
      const proof = await uploadOpsProof({ companyId, field: `audit-evidence-${index + 1}`, file, label: "Station audit evidence", section: "station-audits", submissionId: audit.id });
      if (!proof) continue;
      const saved = await db().from("ops_station_audit_evidence").insert({ company_id: companyId, audit_id: audit.id, evidence_kind_code: "document", file_name: proof.file_name, media_url: `storage://${proof.storage_bucket}/${proof.storage_path}`, caption: clean(formData.get("evidence_caption")) || null, uploaded_by: authorization.userId });
      if (saved.error) throw new Error(saved.error.message);
    }
    await writeStationAuditEvent({ companyId, auditId: audit.id, eventType: "submitted", authorization, before: { status: audit.status_code }, after: { status: nextStatus, actionCount: allActions.length, shipmentCount: shipmentRows.length } });
    const refreshed = { ...audit, status_code: nextStatus, system_cash_amount: systemCash, physical_cash_amount: physicalCashEntered == null ? null : countedCash, cash_variance_amount: systemCash == null || physicalCashEntered == null ? null : countedCash - systemCash, shipment_unresolved_count: unresolvedShipments.length };
    let emailMessage = "";
    try {
      const sent = await sendStationAuditCompletedEmail({ companyId, audit: refreshed, type, station: audit.stations, openActions: allActions.length });
      await db().from("ops_station_audits").update({ email_status: "sent", email_sent_at: new Date().toISOString(), email_recipients: [...sent.to, ...sent.cc] }).eq("id", audit.id).eq("company_id", companyId);
    } catch (emailError) {
      await db().from("ops_station_audits").update({ email_status: "failed" }).eq("id", audit.id).eq("company_id", companyId);
      emailMessage = ` Audit saved; email needs attention: ${emailError instanceof Error ? emailError.message : "delivery failed"}`;
    }
    refreshAudits(); return { ok: true, message: `Audit submitted for review.${emailMessage}` };
  } catch (error) { return message(error); }
}

export async function respondToStationAudit(formData: FormData): Promise<ActionResult> {
  try {
    const authorization = await requirePagePermission("station_audits", "access"); const companyId = requireCompanyId(authorization); const auditId = clean(formData.get("audit_id"));
    const audit = await readAudit(companyId, auditId, authorization);
    if (!hasPermission(authorization, "station_audits", "add") && !hasPermission(authorization, "station_audits", "edit")) throw new Error("Your Audit access is view only.");
    const body = clean(formData.get("response")); if (!body) throw new Error("Add a response or progress update.");
    const comment = await db().from("ops_station_audit_comments").insert({ company_id: companyId, audit_id: audit.id, body, audience: "managers", requests_station_response: false, created_by: authorization.userId, author_name: authorization.fullName, author_email: authorization.email });
    if (comment.error) throw new Error(comment.error.message);
    const actionId = clean(formData.get("action_id"));
    if (actionId) {
      const action = await db().from("ops_station_audit_actions").update({ status_code: "completed", completed_at: new Date().toISOString(), completion_note: body }).eq("company_id", companyId).eq("audit_id", audit.id).eq("id", actionId);
      if (action.error) throw new Error(action.error.message);
    }
    const files = formData.getAll("response_evidence").filter((entry): entry is File => entry instanceof File && entry.size > 0);
    if (files.length > 6) throw new Error("Attach up to 6 response files at one time.");
    for (const [index, file] of files.entries()) {
      const proof = await uploadOpsProof({ companyId, field: `station-response-${index + 1}`, file, label: "Station audit response evidence", section: "station-audits", submissionId: audit.id });
      if (!proof) continue;
      const saved = await db().from("ops_station_audit_evidence").insert({ company_id: companyId, audit_id: audit.id, evidence_kind_code: "document", file_name: proof.file_name, media_url: `storage://${proof.storage_bucket}/${proof.storage_path}`, caption: "Station response", uploaded_by: authorization.userId });
      if (saved.error) throw new Error(saved.error.message);
    }
    const update = await db().from("ops_station_audits").update({ status_code: "under_review", station_response_status: "submitted", station_summary: body }).eq("company_id", companyId).eq("id", audit.id);
    if (update.error) throw new Error(update.error.message);
    await writeStationAuditEvent({ companyId, auditId: audit.id, eventType: "station_responded", authorization, before: { status: audit.status_code }, after: { status: "under_review" } });
    refreshAudits(); return { ok: true, message: "Response submitted to the audit manager." };
  } catch (error) { return message(error); }
}

export async function addAuditManagerComment(formData: FormData): Promise<ActionResult> {
  try {
    const authorization = await assertManager("edit"); const companyId = requireCompanyId(authorization); const audit = await readAudit(companyId, clean(formData.get("audit_id")), authorization);
    const body = clean(formData.get("comment")); if (!body) throw new Error("Write a follow-up before sending it.");
    const askResponse = clean(formData.get("request_station_response")) === "yes";
    const inserted = await db().from("ops_station_audit_comments").insert({ company_id: companyId, audit_id: audit.id, body, audience: "station", requests_station_response: askResponse, created_by: authorization.userId, author_name: authorization.fullName, author_email: authorization.email });
    if (inserted.error) throw new Error(inserted.error.message);
    if (askResponse) {
      const update = await db().from("ops_station_audits").update({ status_code: "awaiting_station_response", station_response_status: "requested", response_due_at: clean(formData.get("response_due_at")) || audit.response_due_at }).eq("company_id", companyId).eq("id", audit.id);
      if (update.error) throw new Error(update.error.message);
    }
    await writeStationAuditEvent({ companyId, auditId: audit.id, eventType: "manager_comment", authorization, after: { requestsStationResponse: askResponse } });
    refreshAudits(); return { ok: true, message: askResponse ? "Follow-up sent; station response requested." : "Manager note added." };
  } catch (error) { return message(error); }
}

export async function closeStationAudit(auditId: string): Promise<ActionResult> {
  try {
    const authorization = await assertManager("edit"); const companyId = requireCompanyId(authorization); const audit = await readAudit(companyId, auditId, authorization);
    const open = await db().from("ops_station_audit_actions").select("id").eq("company_id", companyId).eq("audit_id", audit.id).neq("status_code", "completed").limit(1);
    if (open.error) throw new Error(open.error.message); if (open.data?.length) throw new Error("Complete or return the outstanding corrective actions before closing this audit.");
    const update = await db().from("ops_station_audits").update({ status_code: "closed", station_response_status: "accepted" }).eq("company_id", companyId).eq("id", audit.id);
    if (update.error) throw new Error(update.error.message);
    await writeStationAuditEvent({ companyId, auditId: audit.id, eventType: "closed", authorization, before: { status: audit.status_code }, after: { status: "closed" } });
    refreshAudits(); return { ok: true, message: "Audit closed." };
  } catch (error) { return message(error); }
}
