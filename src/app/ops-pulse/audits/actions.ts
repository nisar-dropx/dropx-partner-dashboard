"use server";
import {
  auditEvidenceSubmitError,
  isAuditEvidenceFolder,
} from "@/lib/ops-pulse/station-audit-evidence";
import {
  calculateAuditScore,
  type AuditAssessment,
} from "@/lib/ops-pulse/station-audit-scoring";
import {
  parseAuditTids,
  compareAuditTids,
  selectedAuditEmployees,
  type AuditEmployee,
} from "@/lib/ops-pulse/station-audit-reconciliation";
import { missingAuditPhotos } from "@/lib/ops-pulse/station-audit-photos";

import {
  canDeleteStationAudit,
  loadAuditAssignees,
} from "@/lib/ops-pulse/station-audit-people";
import {
  addAuditDays,
  auditDay,
  auditMonthRange,
  auditSlots,
  isMyAudit,
  isUnscheduledAudit,
  validAuditDate,
} from "@/lib/ops-pulse/station-audit-planning";
import { revalidatePath } from "next/cache";
import {
  requirePagePermission,
  type AuthorizationContext,
} from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { resolveStationAuditRecipients } from "@/lib/ops-pulse/station-audit-recipients";
import { sendStationAuditCompletedEmail } from "@/lib/ops-pulse/station-audit-email";
import { uploadOpsProof } from "@/lib/ops-pulse/upload";
import {
  auditSchemaPendingMessage,
  canAssignAnyStation,
  canManageStationAudits,
  canRespondToStationAudits,
  canUseStationAudit,
  canUseStationAuditLocation,
  isAuditSchemaPending,
  loadAuditReportees,
  stationAuditScope,
  createStationAudit,
  isStationAuditEligible,
  loadAuditStations,
  loadStationAuditMaster,
  writeStationAuditEvent,
  type AuditChecklistItem,
  type AuditStation,
  type AuditType,
  type StationAudit,
} from "@/lib/ops-pulse/station-audits";
import {
  auditCycle,
  auditTimestamp,
} from "@/lib/ops-pulse/station-audit-planning";
import { supabaseAdmin } from "@/lib/supabase-admin";

type ActionResult =
  | { ok: true; message: string }
  | { ok: false; message: string };
const message = (error: unknown): ActionResult => ({
  ok: false,
  message: error instanceof Error ? error.message : "Unable to save the audit.",
});
const clean = (value: FormDataEntryValue | null | undefined) =>
  String(value ?? "").trim();
const number = (value: FormDataEntryValue | null | undefined) => {
  if (!clean(value)) return null;
  const parsed = Number(clean(value));
  return Number.isFinite(parsed) ? parsed : null;
};

function db() {
  if (!supabaseAdmin) throw new Error("Database service is unavailable.");
  return supabaseAdmin;
}
function refreshAudits() {
  revalidatePath("/ops-pulse/audits");
  revalidatePath("/ops-pulse/master/audits");
  revalidatePath("/audits");
}
function auditDateTime(date: string, time: string) {
  if (Date.parse(auditTimestamp(date, time)) <= Date.now())
    throw new Error("Choose a future audit date and time.");
  return { date, time };
}
function localDeadline(value: string) {
  if (!value) return null;
  const [date, time] = value.split("T");
  return auditTimestamp(date, (time || "23:59").slice(0, 5));
}
function responseBehaviour(item: AuditChecklistItem, value: string) {
  const selected = item.response_options.find(
    (option) => option.value === value,
  );
  if (item.response_options.length && !selected)
    throw new Error(`Choose a valid outcome for: ${item.label}`);
  return {
    isCompliant: selected?.is_compliant ?? null,
    requiresAction: selected?.requires_action === true,
    requiresEvidence: selected?.requires_evidence === true,
  };
}
function parseShipments(value: string) {
  if (!value) return [] as Array<Record<string, unknown>>;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? (parsed.filter((row) => row && typeof row === "object") as Array<
          Record<string, unknown>
        >)
      : [];
  } catch {
    throw new Error(
      "Shipment exceptions could not be read. Refresh and try again.",
    );
  }
}

async function readAudit(
  companyId: string,
  auditId: string,
  authorization: AuthorizationContext,
) {
  const [result, master] = await Promise.all([
    db()
      .from("ops_station_audits")
      .select(
        "*,ops_audit_types(*),stations(id,station_code,station_name,city,cluster,cluster_name,station_email,station_manager_email,cluster_manager_email,ops_manager_email,finance_manager_email,location_model_id,is_ho)",
      )
      .eq("company_id", companyId)
      .eq("id", auditId)
      .is("deleted_at", null)
      .maybeSingle(),
    loadStationAuditMaster(companyId),
  ]);
  if (result.error) throw new Error(result.error.message);
  const station = Array.isArray(result.data?.stations)
    ? result.data.stations[0]
    : result.data?.stations;
  if (
    !result.data ||
    !station ||
    !canUseStationAudit(authorization, result.data) ||
    !isStationAuditEligible(station, master.programmeSettings)
  )
    throw new Error("This audit is unavailable in your station scope.");
  return result.data as StationAudit & {
    ops_audit_types: AuditType;
    stations: AuditStation;
  };
}

async function assertManager(action: "add" | "edit") {
  const own = await requirePagePermission("station_audits", action);
  const companyId = requireCompanyId(own);
  const master = await loadStationAuditMaster(companyId);
  if (!canManageStationAudits(own, master.programmeSettings))
    throw new Error(
      "Only roles selected in Audit Master can schedule and manage audits.",
    );
  // `own` keeps the person's station scope; `authorization` adds any-station
  // reach for the cross-audit roles chosen in Audit Master.
  return {
    authorization: stationAuditScope(own, master.programmeSettings),
    own,
    companyId,
    master,
  };
}

async function auditEmployees(
  companyId: string,
  stationId: string,
): Promise<AuditEmployee[]> {
  const result = await db().rpc("station_audit_employee_directory", {
    p_company: companyId,
    p_station: stationId,
  });
  if (result.error) throw new Error(result.error.message);
  return result.data || [];
}
// An in-progress audit's draft is one small private file per auditor, so it can be
// picked up on another device. It never touches the audit tables until submission.
const draftBucket = "ops-pulse-documents";
const draftLimit = 1_500_000;
async function draftTarget(auditId: string) {
  const { authorization, companyId } = await assertManager("edit");
  const audit = await readAudit(companyId, auditId, authorization);
  if (!isMyAudit(audit, authorization.userId))
    throw new Error("Only the assigned auditor keeps a draft for this audit.");
  return {
    audit,
    path: `${companyId}/station-audits/${audit.id}/draft/${authorization.userId}.json`,
  };
}
export async function saveStationAuditDraft(
  auditId: string,
  payload: string,
): Promise<ActionResult> {
  try {
    const { audit, path } = await draftTarget(auditId);
    if (audit.status_code !== "in_progress" || audit.completed_at)
      throw new Error("Only an audit in progress keeps a draft.");
    if (typeof payload !== "string" || !payload || payload.length > draftLimit)
      throw new Error("This draft is too large to keep on the server.");
    JSON.parse(payload);
    const saved = await db()
      .storage.from(draftBucket)
      .upload(path, new Blob([payload], { type: "application/json" }), {
        contentType: "application/json",
        upsert: true,
      });
    if (saved.error) throw new Error(saved.error.message);
    return { ok: true, message: "Draft saved." };
  } catch (error) {
    return message(error);
  }
}
export async function loadStationAuditDraft(
  auditId: string,
): Promise<{ ok: boolean; draft: string | null }> {
  try {
    const { audit, path } = await draftTarget(auditId);
    if (audit.status_code !== "in_progress" || audit.completed_at)
      return { ok: true, draft: null };
    const file = await db().storage.from(draftBucket).download(path);
    if (file.error || !file.data) return { ok: true, draft: null };
    const text = await file.data.text();
    return { ok: true, draft: text.length <= draftLimit ? text : null };
  } catch {
    return { ok: false, draft: null };
  }
}
export async function clearStationAuditDraft(
  auditId: string,
): Promise<ActionResult> {
  try {
    const { path } = await draftTarget(auditId);
    const removed = await db().storage.from(draftBucket).remove([path]);
    if (removed.error) throw new Error(removed.error.message);
    return { ok: true, message: "Draft cleared." };
  } catch (error) {
    return message(error);
  }
}
export async function loadAuditInspectionContext(auditId: string) {
  const viewer = await requirePagePermission("station_audits", "access");
  const company = requireCompanyId(viewer);
  const master = await loadStationAuditMaster(company);
  const auth = stationAuditScope(viewer, master.programmeSettings);
  const audit = await readAudit(company, auditId, auth);
  if (
    !canManageStationAudits(auth, master.programmeSettings) &&
    !audit.completed_at
  )
    throw new Error("Audit findings are not available yet.");
  const [people, lists] = await Promise.all([
    auditEmployees(company, audit.location_id),
    db()
      .from("ops_audit_shipment_lists")
      .select("expected,scanned")
      .eq("company_id", company)
      .eq("audit_id", audit.id)
      .maybeSingle(),
  ]);
  if (lists.error) throw new Error(lists.error.message);
  return {
    people,
    lists: lists.data as { expected: string[]; scanned: string[] } | null,
  };
}

/** Station figures shown at the top of an audit, for the people who run audits. */
export async function loadAuditSnapshot(auditId: string): Promise<{
  ok: boolean;
  message: string;
  snapshot:
    | import("@/lib/ops-pulse/station-audit-snapshot").AuditStationSnapshot
    | null;
}> {
  try {
    const viewer = await requirePagePermission("station_audits", "access");
    const company = requireCompanyId(viewer);
    const master = await loadStationAuditMaster(company);
    if (!canManageStationAudits(viewer, master.programmeSettings))
      throw new Error("Station figures are shown to audit managers only.");
    const audit = await readAudit(
      company,
      auditId,
      stationAuditScope(viewer, master.programmeSettings),
    );
    const { loadAuditStationSnapshot } = await import(
      "@/lib/ops-pulse/station-audit-snapshot"
    );
    return {
      ok: true,
      message: "",
      snapshot: await loadAuditStationSnapshot(company, {
        id: audit.location_id,
        station_code: audit.stations.station_code,
      }),
    };
  } catch (error) {
    return { ...message(error), snapshot: null };
  }
}

export async function scheduleStationAudit(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const { authorization, companyId } = await assertManager("add");
    const { date, time } = auditDateTime(
      clean(formData.get("scheduled_date")),
      clean(formData.get("scheduled_time")),
    );
    const audit = await createStationAudit({
      companyId,
      authorization,
      auditTypeId: clean(formData.get("audit_type_id")),
      locationId: clean(formData.get("location_id")),
      scheduledDate: date,
      scheduledTime: time,
      periodSlot: clean(formData.get("period_slot")) || undefined,
      assignedUserId: clean(formData.get("assigned_to")) || undefined,
      reason: clean(formData.get("reason")) || undefined,
    });
    refreshAudits();
    return { ok: true, message: `${audit.audit_number} scheduled.` };
  } catch (error) {
    if (
      error instanceof Error &&
      /already has an audit in this date window/i.test(error.message)
    ) {
      const existing = await describeAuditsInMonth(formData).catch(() => "");
      if (existing) {
        return {
          ok: false,
          message: `This station already has an audit in this date window. Booked for this station this month: ${existing}. Open the one in this window from Team tracker or Calendar to reschedule it instead of scheduling a new one.`,
        };
      }
    }
    return message(error);
  }
}

/** Names the audits already booked for this station and type in the chosen month. */
async function describeAuditsInMonth(formData: FormData) {
  const { companyId } = await assertManager("add");
  const month = clean(formData.get("scheduled_date")).slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) return "";
  const [year, monthNumber] = month.split("-").map(Number);
  const next =
    monthNumber === 12
      ? `${year + 1}-01`
      : `${year}-${String(monthNumber + 1).padStart(2, "0")}`;
  const result = await db()
    .from("ops_station_audits")
    .select("audit_number,scheduled_for,assigned_name")
    .eq("company_id", companyId)
    .eq("audit_type_id", clean(formData.get("audit_type_id")))
    .eq("location_id", clean(formData.get("location_id")))
    .is("deleted_at", null)
    .gte("scheduled_for", `${month}-01T00:00:00+05:30`)
    .lt("scheduled_for", `${next}-01T00:00:00+05:30`)
    .order("scheduled_for", { ascending: true })
    .limit(5);
  if (result.error) return "";
  return (result.data ?? [])
    .map((row) => {
      const when = new Date(row.scheduled_for).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      });
      return `${row.audit_number} on ${when} with ${row.assigned_name || "an unassigned auditor"}`;
    })
    .join("; ");
}

export async function rescheduleStationAudit(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const { authorization, companyId } = await assertManager("edit");
    const audit = await readAudit(
      companyId,
      clean(formData.get("audit_id")),
      authorization,
    );
    if (
      audit.status_code !== "scheduled" ||
      audit.started_at ||
      audit.completed_at
    )
      throw new Error("Only an audit that has not started can be rescheduled.");
    const date = clean(formData.get("scheduled_date"));
    const time = clean(formData.get("scheduled_time"));
    const scheduledFor = auditTimestamp(date, time);
    // A surprise visit already made may be dated back, but not without limit.
    if (date < addAuditDays(auditDay(), -31))
      throw new Error("Choose a date no more than 31 days back.");
    if (Date.parse(scheduledFor) === Date.parse(audit.scheduled_for))
      throw new Error("Choose a different date or time.");
    const reason = clean(formData.get("reason"));
    if (!reason || reason.length > 500)
      throw new Error("Enter a reason of up to 500 characters.");
    const originalDay = auditDay(audit.scheduled_for);
    const unscheduled = isUnscheduledAudit(audit);
    const earlier = date < originalDay;
    if (!unscheduled && !earlier && date.slice(0, 7) !== originalDay.slice(0, 7))
      throw new Error(
        "A planned audit can be postponed only within its month. Earlier dates are allowed.",
      );
    const originalSlot = auditSlots(audit.ops_audit_types).find(
      (s) =>
        Number(originalDay.slice(-2)) >= s.startDay &&
        Number(originalDay.slice(-2)) <= s.endDay,
    );
    // An unscheduled audit keeps its own slot. A planned audit pulled forward
    // takes the window its new date falls in; postponed, it stays in its own.
    const cycle = unscheduled
      ? { cycleKey: date.slice(0, 7), periodSlot: audit.period_slot }
      : earlier
        ? auditCycle(audit.ops_audit_types, date)
        : auditCycle(
            audit.ops_audit_types,
            date,
            originalSlot?.code || audit.period_slot,
          );
    const result = await db().rpc("reschedule_station_audit", {
      p_company_id: companyId,
      p_audit_id: audit.id,
      p_expected_date: clean(formData.get("original_scheduled_for")),
      p_scheduled_for: scheduledFor,
      p_cycle_key: cycle.cycleKey,
      p_period_slot: cycle.periodSlot,
      p_reason: reason,
      p_actor_id: authorization.userId,
      p_actor_name: authorization.fullName,
      p_actor_email: authorization.email,
      p_actor_role: authorization.roleName || authorization.roleCode,
    });
    if (result.error?.code === "23505")
      throw new Error(
        "That station already has an audit in this programme slot. Choose another slot or date.",
      );
    // Earlier and past dates need the newer database rules.
    if (
      result.error &&
      (Date.parse(scheduledFor) <= Date.now() || (earlier && !unscheduled)) &&
      /future date|original date window|same month/i.test(result.error.message)
    )
      throw new Error(auditSchemaPendingMessage);
    if (result.error) throw new Error(result.error.message);
    refreshAudits();
    return {
      ok: true,
      message:
        "Audit date changed. The original date and reason are saved in its history.",
    };
  } catch (error) {
    return message(error);
  }
}

type StartResult = ActionResult & { auditId?: string };
const allStations = { hasAllLocationAccess: true, locationScopeIds: [] };
const requestColumns =
  "id,location_id,audit_type_id,requested_by,requested_name,status,reason";
type RequestRow = {
  id: string;
  location_id: string;
  audit_type_id: string;
  requested_by: string;
  requested_name: string | null;
  status: string;
  reason: string;
};
function reasonText(formData: FormData) {
  const reason = clean(formData.get("reason"));
  if (!reason || reason.length > 500)
    throw new Error("Enter a reason of up to 500 characters.");
  return reason;
}
async function readRequest(companyId: string, requestId: string) {
  const found = await db()
    .from("ops_station_audit_requests")
    .select(requestColumns)
    .eq("company_id", companyId)
    .eq("id", requestId)
    .maybeSingle();
  if (found.error)
    throw new Error(
      isAuditSchemaPending(found.error)
        ? auditSchemaPendingMessage
        : found.error.message,
    );
  if (!found.data) throw new Error("This request is no longer available.");
  return found.data as RequestRow;
}
/** Cross-audit roles decide any request; a reporting manager decides their own team's. */
async function canDecideRequest(
  companyId: string,
  own: AuthorizationContext,
  anyStation: boolean,
  request: RequestRow,
) {
  if (request.requested_by === own.userId) return false;
  return (
    anyStation ||
    (await loadAuditReportees(companyId, own.userId)).includes(
      request.requested_by,
    )
  );
}

/** Stations, and for cross-audit managers the auditors, beyond the person's own scope. */
export async function loadAuditReach(): Promise<{
  ok: boolean;
  message: string;
  stations: { id: string; label: string }[];
  auditors: { id: string; name: string; role: string }[];
}> {
  try {
    const { own, companyId, master } = await assertManager("add");
    const settings = master.programmeSettings;
    const stations = await loadAuditStations(companyId, allStations, settings);
    const auditors = canAssignAnyStation(own, settings)
      ? await loadAuditAssignees(
          companyId,
          settings.scheduler_role_ids,
          stations.map((station) => station.id),
        )
      : [];
    return {
      ok: true,
      message: "",
      stations: stations.map((station) => ({
        id: station.id,
        label: `${station.station_code} · ${station.station_name || station.city || ""}`,
      })),
      auditors: auditors.map((p) => ({ id: p.id, name: p.name, role: p.role })),
    };
  } catch (error) {
    return { ...message(error), stations: [], auditors: [] };
  }
}

/**
 * Creates an audit outside the monthly programme. In the person's own stations it
 * needs no approval. At any other station it needs any-station reach, or a
 * cross-station request that this person is entitled to approve.
 */
export async function startStationAudit(
  formData: FormData,
): Promise<StartResult> {
  try {
    const { authorization, own, companyId, master } = await assertManager("add");
    const settings = master.programmeSettings;
    const anyStation = canAssignAnyStation(own, settings);
    const locationId = clean(formData.get("location_id"));
    const auditTypeId = clean(formData.get("audit_type_id"));
    const assignedUserId = clean(formData.get("assigned_to")) || own.userId;
    const requestId = clean(formData.get("request_id"));
    const reason = reasonText(formData);
    const startNow = clean(formData.get("when")) !== "later";
    const later = startNow
      ? { date: "", time: "" }
      : auditDateTime(
          clean(formData.get("scheduled_date")),
          clean(formData.get("scheduled_time")),
        );
    let request: RequestRow | null = null;
    if (requestId) {
      request = await readRequest(companyId, requestId);
      if (request.status !== "pending")
        throw new Error("This request has already been decided.");
      if (!(await canDecideRequest(companyId, own, anyStation, request)))
        throw new Error("You cannot approve this request.");
      if (
        request.location_id !== locationId ||
        request.audit_type_id !== auditTypeId
      )
        throw new Error(
          "Approve the station and audit type that were requested.",
        );
      if (!anyStation && assignedUserId !== request.requested_by)
        throw new Error("Assign this audit to the person who requested it.");
    } else if (!anyStation && !canUseStationAuditLocation(own, locationId))
      throw new Error(
        "This station is outside your stations. Send a cross-station request instead.",
      );
    if (request) {
      // Claim the request first so two approvers cannot both create an audit.
      const claimed = await db()
        .from("ops_station_audit_requests")
        .update({
          status: "approved",
          decided_by: own.userId,
          decided_name: own.fullName || own.email,
          decided_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("company_id", companyId)
        .eq("id", request.id)
        .eq("status", "pending")
        .select("id")
        .maybeSingle();
      if (claimed.error) throw new Error(claimed.error.message);
      if (!claimed.data)
        throw new Error("This request has already been decided.");
    }
    let audit: { id: string; audit_number: string };
    try {
      audit = await createStationAudit({
        companyId,
        authorization,
        auditTypeId,
        locationId,
        scheduledDate: later.date,
        scheduledTime: later.time,
        assignedUserId,
        reason,
        unscheduled: true,
        startNow,
        anyStation: anyStation || Boolean(request),
      });
    } catch (error) {
      if (request)
        await db()
          .from("ops_station_audit_requests")
          .update({
            status: "pending",
            decided_by: null,
            decided_name: null,
            decided_at: null,
          })
          .eq("company_id", companyId)
          .eq("id", request.id)
          .eq("status", "approved")
          .is("audit_id", null);
      throw error;
    }
    if (request)
      await db()
        .from("ops_station_audit_requests")
        .update({ audit_id: audit.id })
        .eq("company_id", companyId)
        .eq("id", request.id);
    refreshAudits();
    const mine = assignedUserId === own.userId;
    return {
      ok: true,
      auditId: audit.id,
      message: request
        ? `Request approved. ${audit.audit_number} is assigned.`
        : startNow && mine
          ? `${audit.audit_number} started. Record evidence as you go.`
          : `${audit.audit_number} created and assigned.`,
    };
  } catch (error) {
    return message(error);
  }
}

/** Asks a manager for one audit at a station outside the person's own stations. */
export async function requestCrossAudit(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const { own, companyId, master } = await assertManager("add");
    const settings = master.programmeSettings;
    if (!settings.cross_audit_ready) throw new Error(auditSchemaPendingMessage);
    const locationId = clean(formData.get("location_id"));
    const auditTypeId = clean(formData.get("audit_type_id"));
    const preferred = clean(formData.get("preferred_date"));
    const reason = reasonText(formData);
    if (canUseStationAuditLocation(own, locationId))
      throw new Error(
        "This station is already in your stations. Start the audit directly.",
      );
    if (preferred && (!validAuditDate(preferred) || preferred < auditDay()))
      throw new Error("Choose today or a later date.");
    const stations = await loadAuditStations(companyId, allStations, settings);
    if (!stations.some((station) => station.id === locationId))
      throw new Error("Choose a station that can be audited.");
    if (!master.auditTypes.some((t) => t.id === auditTypeId && t.is_active))
      throw new Error("Choose an active audit type from Audit Master.");
    const saved = await db().from("ops_station_audit_requests").insert({
      company_id: companyId,
      location_id: locationId,
      audit_type_id: auditTypeId,
      requested_by: own.userId,
      requested_name: own.fullName || own.email,
      preferred_date: preferred || null,
      reason,
    });
    if (saved.error?.code === "23505")
      throw new Error(
        "You already have an open request for this station and audit type.",
      );
    if (saved.error)
      throw new Error(
        isAuditSchemaPending(saved.error)
          ? auditSchemaPendingMessage
          : saved.error.message,
      );
    refreshAudits();
    return {
      ok: true,
      message:
        "Request sent. It appears under Requests until a manager approves or declines it.",
    };
  } catch (error) {
    return message(error);
  }
}

/** Declines a request (an approver) or withdraws it (the person who asked). */
export async function decideAuditRequest(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const { own, companyId, master } = await assertManager("add");
    const operation = clean(formData.get("operation"));
    const request = await readRequest(
      companyId,
      clean(formData.get("request_id")),
    );
    const note = clean(formData.get("note"));
    if (note.length > 500)
      throw new Error("Keep the note within 500 characters.");
    if (operation === "cancel") {
      if (request.requested_by !== own.userId)
        throw new Error("Only the person who asked can withdraw this request.");
    } else if (operation === "decline") {
      if (
        !(await canDecideRequest(
          companyId,
          own,
          canAssignAnyStation(own, master.programmeSettings),
          request,
        ))
      )
        throw new Error("You cannot decide this request.");
      if (!note) throw new Error("Say why this request is declined.");
    } else throw new Error("Invalid request action.");
    const saved = await db()
      .from("ops_station_audit_requests")
      .update({
        status: operation === "cancel" ? "cancelled" : "declined",
        decided_by: own.userId,
        decided_name: own.fullName || own.email,
        decided_at: new Date().toISOString(),
        decision_note: note || null,
        updated_at: new Date().toISOString(),
      })
      .eq("company_id", companyId)
      .eq("id", request.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (saved.error) throw new Error(saved.error.message);
    if (!saved.data) throw new Error("This request has already been decided.");
    refreshAudits();
    return {
      ok: true,
      message:
        operation === "cancel" ? "Request withdrawn." : "Request declined.",
    };
  } catch (error) {
    return message(error);
  }
}

/**
 * Changes the audit type, the auditor, or both before the audit is submitted.
 * A planned audit takes the new type's window for its date when that window is
 * free; otherwise it is kept as an unscheduled audit so nothing is double-booked.
 */
export async function changeStationAudit(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const { authorization, own, companyId, master } =
      await assertManager("edit");
    const settings = master.programmeSettings;
    const audit = await readAudit(
      companyId,
      clean(formData.get("audit_id")),
      authorization,
    );
    const reason = reasonText(formData);
    const typeId = clean(formData.get("audit_type_id")) || audit.audit_type_id;
    const assignedTo = clean(formData.get("assigned_to")) || audit.assigned_to;
    if (
      audit.completed_at ||
      !["scheduled", "in_progress"].includes(audit.status_code)
    )
      throw new Error(
        "Only an audit that has not been submitted can be changed.",
      );
    const typeChanged = typeId !== audit.audit_type_id;
    const auditorChanged =
      assignedTo !== audit.assigned_to || audit.assignment_verified !== true;
    if (!typeChanged && !auditorChanged)
      throw new Error("Choose a different audit type or auditor.");
    if (!assignedTo) throw new Error("Choose an auditor.");
    // Once fieldwork has begun, only the person doing it may switch the checklist.
    if (audit.status_code === "in_progress" && !isMyAudit(audit, own.userId))
      throw new Error(
        "This audit is in progress. Only the assigned auditor can change its type.",
      );
    let crossStation = audit.cross_station === true;
    if (auditorChanged) {
      if (audit.status_code !== "scheduled" || audit.started_at)
        throw new Error("Only an unstarted audit can be reassigned.");
      const anyStation = canAssignAnyStation(own, settings);
      const reach = anyStation
        ? (await loadAuditStations(companyId, allStations, settings)).map(
            (station) => station.id,
          )
        : [audit.location_id];
      const choice = (
        await loadAuditAssignees(companyId, settings.scheduler_role_ids, reach)
      ).find((p) => p.id === assignedTo);
      if (!choice)
        throw new Error(
          anyStation
            ? "Choose an active user who holds an audit manager role."
            : "Choose an active auditor authorized for this station.",
        );
      crossStation = !choice.stationIds.includes(audit.location_id);
    }
    const day = auditDay(audit.scheduled_for);
    const offProgramme = () => ({
      cycleKey: day.slice(0, 7),
      periodSlot: isUnscheduledAudit(audit)
        ? audit.period_slot
        : `unscheduled-${crypto.randomUUID().slice(0, 8)}`,
    });
    let cycle = { cycleKey: audit.cycle_key, periodSlot: audit.period_slot };
    let source = isUnscheduledAudit(audit) ? "unscheduled" : "manual";
    let typeName = "";
    if (typeChanged) {
      const type = master.auditTypes.find((t) => t.id === typeId && t.is_active);
      if (!type)
        throw new Error("Choose an active audit type from Audit Master.");
      typeName = type.name;
      let planned: { cycleKey: string; periodSlot: string } | null = null;
      if (source === "manual") {
        try {
          planned = auditCycle(type, day);
        } catch {
          planned = null;
        }
        if (planned) {
          const slot = auditSlots(type).find(
            (s) => s.code === planned!.periodSlot,
          );
          const month = day.slice(0, 7);
          const lastDay = Number(auditMonthRange(month).to.slice(-2));
          const pad = (value: number) => String(value).padStart(2, "0");
          const others = await db()
            .from("ops_station_audits")
            .select("id,cycle_key,period_slot,scheduled_for")
            .eq("company_id", companyId)
            .eq("audit_type_id", type.id)
            .eq("location_id", audit.location_id)
            .is("deleted_at", null)
            .neq("schedule_source", "unscheduled")
            .neq("id", audit.id)
            .gte("scheduled_for", `${month}-01T00:00:00+05:30`)
            .lte(
              "scheduled_for",
              `${month}-${pad(lastDay)}T23:59:59.999+05:30`,
            );
          if (others.error) throw new Error(others.error.message);
          const taken = (others.data ?? []).some((row) => {
            const date = Number(auditDay(row.scheduled_for).slice(-2));
            return (
              (row.cycle_key === planned!.cycleKey &&
                row.period_slot === planned!.periodSlot) ||
              (type.cadence_unit !== "weekly" &&
                Boolean(slot) &&
                date >= slot!.startDay &&
                date <= slot!.endDay)
            );
          });
          if (taken) planned = null;
        }
      }
      if (planned) cycle = planned;
      else {
        cycle = offProgramme();
        source = "unscheduled";
      }
    }
    const changed = await db().rpc("change_station_audit", {
      p_company_id: companyId,
      p_audit_id: audit.id,
      p_expected_updated_at: clean(formData.get("updated_at")),
      p_audit_type_id: typeId,
      p_cycle_key: cycle.cycleKey,
      p_period_slot: cycle.periodSlot,
      p_schedule_source: source,
      p_assigned_to: assignedTo,
      p_cross_station: crossStation,
      p_reason: reason,
      p_actor_id: own.userId,
      p_actor_name: own.fullName,
      p_actor_email: own.email,
      p_actor_role: own.roleName || own.roleCode,
    });
    if (changed.error && isAuditSchemaPending(changed.error)) {
      // Before the database update, an in-scope reassignment still works as it did.
      if (typeChanged || crossStation) throw new Error(auditSchemaPendingMessage);
      const legacy = await db().rpc("manage_station_audit", {
        p_company_id: companyId,
        p_audit_id: audit.id,
        p_operation: "reassign",
        p_expected_updated_at: clean(formData.get("updated_at")),
        p_assigned_to: assignedTo,
        p_reason: reason,
        p_actor_id: own.userId,
        p_actor_name: own.fullName,
        p_actor_email: own.email,
        p_actor_role: own.roleCode,
      });
      if (legacy.error) throw new Error(legacy.error.message);
    } else if (changed.error) throw new Error(changed.error.message);
    refreshAudits();
    const parts = [
      typeChanged ? `Audit type changed to ${typeName}.` : "",
      typeChanged && source === "unscheduled" && !isUnscheduledAudit(audit)
        ? `This station already has a planned ${typeName} for these dates, so this one is recorded as unscheduled.`
        : "",
      auditorChanged
        ? "Auditor changed. It now appears in the selected auditor’s queue."
        : "",
    ];
    return { ok: true, message: parts.filter(Boolean).join(" ") };
  } catch (error) {
    return message(error);
  }
}

export async function beginStationAudit(
  auditId: string,
): Promise<ActionResult> {
  try {
    const { authorization, companyId } = await assertManager("edit");
    const audit = await readAudit(companyId, auditId, authorization);
    if (!isMyAudit(audit, authorization.userId))
      throw new Error(
        "Only the assigned auditor can start. Reassign this audit first if responsibility has changed.",
      );
    if (audit.status_code !== "scheduled")
      throw new Error("Only scheduled audits can be started.");
    const update = await db()
      .from("ops_station_audits")
      .update({
        status_code: "in_progress",
        started_at: audit.started_at ?? new Date().toISOString(),
      })
      .eq("id", auditId)
      .eq("company_id", companyId)
      .eq("status_code", "scheduled")
      .eq("scheduled_for", audit.scheduled_for)
      .eq("assigned_to", authorization.userId)
      .eq("assignment_verified", true)
      .is("deleted_at", null)
      .select("id")
      .maybeSingle();
    if (update.error) throw new Error(update.error.message);
    if (!update.data)
      throw new Error("This audit changed. Refresh before starting it.");
    await writeStationAuditEvent({
      companyId,
      auditId,
      eventType: "started",
      authorization,
      before: { status: audit.status_code },
      after: { status: "in_progress" },
    });
    refreshAudits();
    return { ok: true, message: "Audit started. Record evidence as you go." };
  } catch (error) {
    return message(error);
  }
}

export async function submitStationAudit(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const { authorization, companyId } = await assertManager("edit");
    const auditId = clean(formData.get("audit_id"));
    const audit = await readAudit(companyId, auditId, authorization);
    if (clean(formData.get("updated_at")) !== audit.updated_at)
      throw new Error(
        "This audit changed. Reopen it before saving your findings.",
      );
    if (!isMyAudit(audit, authorization.userId))
      throw new Error("Only the assigned auditor can submit findings.");
    if (
      !["in_progress", "under_review", "awaiting_station_response"].includes(
        audit.status_code,
      ) ||
      !audit.started_at
    )
      throw new Error("Start this audit before submitting its findings.");
    const master = await loadStationAuditMaster(companyId);
    const type = master.auditTypes.find(
      (row) => row.id === audit.audit_type_id,
    );
    if (!type)
      throw new Error(
        "The audit type was retired. Restore it in Audit Master before submitting.",
      );
    const typeItems = master.checklistItems.filter(
      (item) => item.audit_type_id === type.id,
    );
    const people = typeItems.some(
      (i) => i.employee_selection && i.employee_selection !== "none",
    )
      ? await auditEmployees(companyId, audit.location_id)
      : [];
    const responses: Array<{
      company_id: string;
      audit_id: string;
      checklist_item_id: string;
      response_value: { value: string; employees: AuditEmployee[] };
      is_compliant: boolean | null;
      remarks: string | null;
      response_source: string;
      responded_by: string | null;
    }> = [];
    const requiredActions: Array<{
      item: AuditChecklistItem;
      action: string;
      preventive: string;
    }> = [];
    let requiresEvidence = false;
    for (const item of typeItems) {
      if (item.score_source && item.score_source !== "checklist") continue;
      const value = clean(formData.get(`check_${item.id}`));
      const remarks = clean(formData.get(`check_note_${item.id}`)) || null;
      if (item.is_required && !value)
        throw new Error(`Complete required check: ${item.label}`);
      if (!value) continue;
      const behaviour = responseBehaviour(item, value);
      if (
        (item.remarks_required ||
          behaviour.isCompliant === false ||
          value === "na") &&
        !remarks
      )
        throw new Error(`Add an observation for: ${item.label}`);
      const employees =
        item.employee_selection && item.employee_selection !== "none"
          ? selectedAuditEmployees(
              formData.getAll(`check_employee_${item.id}`).map(String),
              people,
            )
          : [];
      if (item.employee_selection === "single" && employees.length > 1)
        throw new Error(`Select one employee for: ${item.label}`);
      if (
        item.employee_selection &&
        item.employee_selection !== "none" &&
        behaviour.isCompliant === true &&
        !employees.length
      )
        throw new Error(`Select a key custodian / employee for: ${item.label}`);
      responses.push({
        company_id: companyId,
        audit_id: audit.id,
        checklist_item_id: item.id,
        response_value: { value, employees },
        is_compliant: behaviour.isCompliant,
        remarks,
        response_source: "auditor",
        responded_by: authorization.userId,
      });
      requiresEvidence =
        requiresEvidence ||
        behaviour.requiresEvidence ||
        item.evidence_rule === "always";
      if (behaviour.requiresAction) {
        const action = clean(formData.get(`check_action_${item.id}`));
        if (!action)
          throw new Error(`Add a corrective action for: ${item.label}`);
        requiredActions.push({
          item,
          action,
          preventive: clean(formData.get(`check_preventive_${item.id}`)),
        });
      }
    }
    const files = [
      ...formData.getAll("evidence_files"),
      formData.get("erp_evidence"),
      formData.get("variance_evidence"),
    ].filter((entry): entry is File => entry instanceof File && entry.size > 0);
    if (files.length > 8)
      throw new Error("Attach up to 8 audit evidence files at one time.");
    const existingProofs = await db()
      .from("ops_station_audit_evidence")
      .select("id,evidence_kind_code,checklist_item_id,content_type")
      .eq("company_id", companyId)
      .eq("audit_id", audit.id);
    if (existingProofs.error) throw new Error(existingProofs.error.message);
    const missingPhotos = missingAuditPhotos(
      typeItems.map((item) => ({
        ...item,
        photo_required:
          item.photo_required ||
          (item.photo_on_non_compliance &&
            responseBehaviour(item, clean(formData.get(`check_${item.id}`)))
              .isCompliant === false),
      })),
      existingProofs.data || [],
    );
    if (missingPhotos.length)
      throw new Error(
        `Photo required: ${missingPhotos.map((i) => i.label).join("; ")}`,
      );
    if (requiresEvidence && !files.length && !existingProofs.data?.length)
      throw new Error("Attach evidence for the selected checklist outcome.");
    const erp = formData.get("erp_evidence");
    if (
      !(erp instanceof File && erp.size > 0) &&
      !existingProofs.data?.some(
        (p) => p.evidence_kind_code === "erp_screenshot",
      )
    )
      throw new Error(
        "Attach the ERP screenshot or proof of the expected cash balance.",
      );
    for (const file of files)
      if (file.size > 30 * 1024 * 1024)
        throw new Error("Each proof must be under 30 MB.");
    const systemCash = number(formData.get("system_cash_amount"));
    if (systemCash == null || systemCash < 0)
      throw new Error(
        "Enter the expected cash from ERP, including zero when no cash is expected.",
      );
    const physicalCashEntered = number(formData.get("physical_cash_amount"));
    const denominations = master.options.filter(
      (option) => option.option_group === "cash_denomination",
    );
    const cashRows = denominations.map((option) => {
      const count = number(formData.get(`denomination_${option.id}`)) ?? 0;
      const amount = Number(option.metadata.value ?? option.code);
      if (
        !Number.isFinite(amount) ||
        amount <= 0 ||
        count < 0 ||
        !Number.isInteger(count)
      )
        throw new Error("Enter whole, non-negative denomination counts.");
      return { option, count, amount };
    });
    const countedCash = cashRows.reduce(
      (total, row) => total + row.count * row.amount,
      0,
    );
    if (
      physicalCashEntered != null &&
      Math.abs(physicalCashEntered - countedCash) > 0.009
    )
      throw new Error("Physical COD and denomination total must match.");
    if (
      physicalCashEntered != null &&
      !cashRows.some((row) => row.count > 0) &&
      physicalCashEntered !== 0
    )
      throw new Error(
        "Record the physical denomination count for the cash entered.",
      );
    const cashVariance = Math.round((countedCash - systemCash) * 100) / 100;
    const varianceReason = clean(formData.get("cash_variance_reason"));
    if (cashVariance && !varianceReason)
      throw new Error("Add a reason or finding for the cash difference.");
    const videoUrl = clean(formData.get("video_call_url"));
    const videoConfirmed = clean(formData.get("video_access_confirmed"));
    const hasFeedback =
      Boolean(
        clean(formData.get("overall_summary")) ||
          clean(formData.get("manager_summary")) ||
          clean(formData.get("evidence_caption")),
      ) ||
      responses.some((row) => Boolean(row.remarks)) ||
      Array.from(formData.keys()).some(
        (key) => key.startsWith("check_note_") && Boolean(clean(formData.get(key))),
      );
    const attachedCount = number(formData.get("attached_evidence_count")) ?? 0;
    const hasFileEvidence =
      files.length > 0 ||
      attachedCount > 0 ||
      Boolean(existingProofs.data?.length);
    const videoError = auditEvidenceSubmitError(
      type.requires_video_link,
      videoUrl,
      videoConfirmed,
      hasFileEvidence,
      hasFeedback,
    );
    if (videoError) throw new Error(videoError);
    const storedVideoUrl =
      type.requires_video_link && !isAuditEvidenceFolder(videoUrl)
        ? null
        : videoUrl || null;
    let shipments = parseShipments(clean(formData.get("shipments_json")));
    let reconciliation: { expected: string[]; scanned: string[] } | null = null;
    if (type.shipment_reconciliation_enabled) {
      if (clean(formData.get("shipment_scan_confirmed")) !== "yes")
        throw new Error(
          "Confirm that the ERP list and physical scan are complete (including zero shipments).",
        );
      const expected = parseAuditTids(clean(formData.get("expected_tids"))).ids;
      const scanned = parseAuditTids(clean(formData.get("scanned_tids"))).ids;
      const comparison = compareAuditTids(expected, scanned);
      let notes: Record<string, string>;
      try {
        notes = JSON.parse(clean(formData.get("tid_remarks")) || "{}");
      } catch {
        throw new Error("Invalid shipment remarks.");
      }
      reconciliation = { expected, scanned };
      shipments = [
        ...comparison.missing.map((trackingId) => ({
          trackingId,
          discrepancyCode: "missing",
          physicalStatusCode: "not_found",
          systemStatusCode: "in_ageing",
          remarks: String(notes[trackingId] || ""),
          requiredAction:
            "Station to investigate and respond with shipment status and remarks.",
          dueAt: "",
        })),
        ...comparison.excess.map((trackingId) => ({
          trackingId,
          discrepancyCode: "excess",
          physicalStatusCode: "found",
          systemStatusCode: "not_in_ageing",
          remarks: String(notes[trackingId] || ""),
          requiredAction:
            "Station to identify the excess shipment and confirm its system connection.",
          dueAt: "",
        })),
      ];
      if (shipments.some((row) => !String(row.remarks).trim()))
        throw new Error("Add an observation for each missing or excess TID.");
    }
    const shipmentRows = shipments.map((shipment) => {
      const trackingId = clean(String(shipment.trackingId ?? ""));
      if (!trackingId)
        throw new Error("Every shipment exception requires a tracking ID.");
      const discrepancy = clean(String(shipment.discrepancyCode ?? ""));
      const physicalStatus = clean(String(shipment.physicalStatusCode ?? ""));
      if (!discrepancy || !physicalStatus)
        throw new Error(
          `${trackingId}: choose both physical status and discrepancy.`,
        );
      return {
        company_id: companyId,
        audit_id: audit.id,
        tracking_id: trackingId,
        system_status_code:
          clean(String(shipment.systemStatusCode ?? "")) || null,
        physical_status_code: physicalStatus,
        discrepancy_code: discrepancy,
        remarks: clean(String(shipment.remarks ?? "")) || null,
        required_action: clean(String(shipment.requiredAction ?? "")) || null,
        due_at: localDeadline(clean(String(shipment.dueAt ?? ""))),
        is_resolved: false,
      };
    });
    const unresolvedShipments = shipmentRows.filter((row) => !row.is_resolved);
    const discrepancyOptions = new Map(
      master.options
        .filter((option) => option.option_group === "shipment_discrepancy")
        .map((option) => [option.code, option]),
    );
    const explicitDueAt = localDeadline(clean(formData.get("action_due_at")));
    const defaultResponseDueAt =
      explicitDueAt ||
      new Date(
        Date.now() + type.default_response_hours * 3600000,
      ).toISOString();
    const allActions = [
      ...requiredActions.map((row) => ({
        company_id: companyId,
        audit_id: audit.id,
        checklist_item_id: row.item.id,
        title: row.item.label,
        corrective_action: row.action,
        preventive_action: row.preventive || null,
        severity_code: row.item.default_severity_code,
        status_code: "open",
        owner_user_id: null,
        owner_name: null,
        owner_email: null,
        due_at: defaultResponseDueAt,
        created_by: authorization.userId,
      })),
      ...unresolvedShipments
        .filter((row) => row.required_action)
        .map((row) => ({
          company_id: companyId,
          audit_id: audit.id,
          checklist_item_id: null,
          title: `${row.tracking_id} · ${row.discrepancy_code}`,
          corrective_action: row.required_action!,
          preventive_action: null,
          severity_code:
            String(
              discrepancyOptions.get(row.discrepancy_code)?.metadata
                .default_severity_code ?? "",
            ) || null,
          status_code: "open",
          owner_user_id: null,
          owner_name: null,
          owner_email: null,
          due_at: row.due_at || defaultResponseDueAt,
          created_by: authorization.userId,
        })),
    ];
    if (cashVariance)
      allActions.push({
        company_id: companyId,
        audit_id: audit.id,
        checklist_item_id: null,
        title: `Cash ${cashVariance < 0 ? "shortage" : "excess"}: ₹${Math.abs(cashVariance).toLocaleString("en-IN")}`,
        corrective_action: varianceReason,
        preventive_action: null,
        severity_code: "high",
        status_code: "open",
        owner_user_id: null,
        owner_name: null,
        owner_email: null,
        due_at: defaultResponseDueAt,
        created_by: authorization.userId,
      });
    const responseDueAt = allActions.length ? defaultResponseDueAt : null;
    const nextStatus = allActions.length
      ? "awaiting_station_response"
      : "under_review";
    let assessments: Record<string, AuditAssessment> = {};
    try {
      assessments = JSON.parse(
        clean(formData.get("score_assessments")) || "{}",
      );
    } catch {
      throw new Error("Invalid responsibility assessment.");
    }
    for (const [key, assessment] of Object.entries(assessments)) {
      const uploadedId = clean(formData.get(`assessment_evidence_${key}`));
      if (uploadedId) assessment.evidenceId = uploadedId;
    }
    const scoreSnapshot = type.scoring_enabled
      ? calculateAuditScore({
          sections: master.sections.filter((s) => s.audit_type_id === type.id),
          items: typeItems,
          responses: Object.fromEntries(
            responses.map((r) => [r.checklist_item_id, r.response_value.value]),
          ),
          options: master.options.filter((o) =>
            ["audit_responsibility", "audit_rating_band"].includes(
              o.option_group,
            ),
          ),
          expectedCash: systemCash,
          actualCash: countedCash,
          expectedTids: reconciliation?.expected || [],
          scannedTids: reconciliation?.scanned || [],
          assessments,
          evidenceIds: (existingProofs.data || []).map((p) => p.id),
        })
      : null;
    const patch = {
      score: scoreSnapshot?.percentage ?? null,
      score_snapshot: scoreSnapshot,
      status_code: nextStatus,
      response_due_at: responseDueAt,
      cash_variance_reason: clean(formData.get("cash_variance_reason")) || null,
      station_response_status: allActions.length
        ? "requested"
        : "not_requested",
      system_cash_amount: systemCash,
      physical_cash_amount: countedCash,
      cash_variance_amount: cashVariance,
      shipment_reconciliation: reconciliation,
      system_shipment_count: reconciliation
        ? reconciliation.expected.length
        : number(formData.get("system_shipment_count")),
      physical_shipment_count: reconciliation
        ? reconciliation.scanned.length
        : number(formData.get("physical_shipment_count")),
      shipment_missing_count: shipmentRows.filter(
        (row) =>
          row.discrepancy_code === "missing" ||
          discrepancyOptions.get(row.discrepancy_code)?.metadata.count_as ===
            "missing",
      ).length,
      shipment_excess_count: shipmentRows.filter(
        (row) =>
          row.discrepancy_code === "excess" ||
          discrepancyOptions.get(row.discrepancy_code)?.metadata.count_as ===
            "excess",
      ).length,
      shipment_unresolved_count: unresolvedShipments.length,
      video_call_url: storedVideoUrl,
      video_call_verified_at: storedVideoUrl ? new Date().toISOString() : null,
      overall_summary:
        clean(formData.get("overall_summary")) ||
        (cashVariance
          ? `Cash difference ₹${cashVariance}: ${varianceReason}`
          : "Expected cash and counted cash match."),
      manager_summary: clean(formData.get("manager_summary")) || null,
      completed_at: audit.completed_at || new Date().toISOString(),
      completed_by: audit.completed_by || authorization.userId,
    };
    const countRows = cashRows
      .filter((row) => row.count > 0)
      .map((row) => ({
        company_id: companyId,
        audit_id: audit.id,
        cash_side: "physical",
        denomination_option_id: row.option.id,
        denomination_value: row.amount,
        note_count: row.count,
      }));
    const newEvidence: Array<Record<string, unknown>> = [];
    for (const [index, file] of files.entries()) {
      const proof = await uploadOpsProof({
        companyId,
        field: `audit-evidence-${index + 1}`,
        file,
        label: "Station audit evidence",
        section: "station-audits",
        submissionId: audit.id,
      });
      if (!proof) continue;
      newEvidence.push({
        company_id: companyId,
        audit_id: audit.id,
        evidence_kind_code:
          file === erp
            ? "erp_screenshot"
            : file === formData.get("variance_evidence")
              ? "cash_variance"
              : "document",
        file_name: proof.file_name,
        media_url: `storage://${proof.storage_bucket}/${proof.storage_path}`,
        caption:
          file === erp
            ? "ERP expected cash balance"
            : clean(formData.get("evidence_caption")) || null,
        uploaded_by: authorization.userId,
      });
    }
    const saved = await db().rpc("submit_station_audit_report", {
      p_company_id: companyId,
      p_audit_id: audit.id,
      p_expected_updated_at: clean(formData.get("updated_at")),
      p_patch: patch,
      p_checks: responses,
      p_counts: countRows,
      p_shipments: shipmentRows,
      p_actions: allActions,
      p_evidence: newEvidence,
      p_actor_id: authorization.userId,
      p_actor_name: authorization.fullName,
      p_actor_email: authorization.email,
      p_actor_role: authorization.roleCode,
    });
    if (saved.error) throw new Error(saved.error.message);
    const refreshed = {
      ...audit,
      ...patch,
      status_code: nextStatus,
      system_cash_amount: systemCash,
      physical_cash_amount: countedCash,
      cash_variance_amount: cashVariance,
      shipment_unresolved_count: unresolvedShipments.length,
    };
    const emailMessage = await sendAndRecordAuditEmail(
      companyId,
      {
        ...refreshed,
        station_response_status: allActions.length
          ? "requested"
          : "not_requested",
        response_due_at: responseDueAt,
      },
      type,
      audit.stations,
      allActions.length,
      authorization,
    );
    refreshAudits();
    return { ok: true, message: `Audit submitted for review.${emailMessage}` };
  } catch (error) {
    return message(error);
  }
}

export async function respondToStationAudit(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const authorization = await requirePagePermission(
      "station_audits",
      "access",
    );
    const companyId = requireCompanyId(authorization);
    const auditId = clean(formData.get("audit_id"));
    const master = await loadStationAuditMaster(companyId);
    if (!canRespondToStationAudits(authorization, master.programmeSettings))
      throw new Error(
        "Your role is not configured to respond to station audits.",
      );
    const audit = await readAudit(companyId, auditId, authorization);
    if (
      audit.status_code !== "awaiting_station_response" ||
      audit.station_response_status !== "requested"
    )
      throw new Error(
        "This audit is not currently awaiting a station response.",
      );
    const body = clean(formData.get("response"));
    if (!body) throw new Error("Add a response or progress update.");
    if (!audit.completed_at)
      throw new Error("Wait for the auditor to submit the report.");
    let shipmentResponses: unknown;
    try {
      shipmentResponses = JSON.parse(
        clean(formData.get("shipment_responses")) || "[]",
      );
    } catch {
      throw new Error("Invalid shipment responses.");
    }
    if (!Array.isArray(shipmentResponses) || shipmentResponses.length > 20000)
      throw new Error("Invalid shipment responses.");
    const actionId = clean(formData.get("action_id"));
    const files = formData
      .getAll("response_evidence")
      .filter(
        (entry): entry is File => entry instanceof File && entry.size > 0,
      );
    if (files.length > 6)
      throw new Error("Attach up to 6 response files at one time.");
    for (const [index, file] of files.entries()) {
      const proof = await uploadOpsProof({
        companyId,
        field: `station-response-${index + 1}`,
        file,
        label: "Station audit response evidence",
        section: "station-audits",
        submissionId: audit.id,
      });
      if (!proof) continue;
      const saved = await db()
        .from("ops_station_audit_evidence")
        .insert({
          company_id: companyId,
          audit_id: audit.id,
          evidence_kind_code: "document",
          file_name: proof.file_name,
          media_url: `storage://${proof.storage_bucket}/${proof.storage_path}`,
          caption: "Station response",
          uploaded_by: authorization.userId,
        });
      if (saved.error) throw new Error(saved.error.message);
    }
    const update = await db().rpc("respond_station_audit_report", {
      p_company: companyId,
      p_audit: audit.id,
      p_expected: clean(formData.get("updated_at")),
      p_body: body,
      p_shipments: shipmentResponses,
      p_action: actionId || null,
      p_actor: authorization.userId,
      p_name: authorization.fullName,
      p_email: authorization.email,
      p_role: authorization.roleCode,
    });
    if (update.error) throw new Error(update.error.message);
    refreshAudits();
    return { ok: true, message: "Response submitted to the audit manager." };
  } catch (error) {
    return message(error);
  }
}

export async function addAuditManagerComment(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const { authorization, companyId } = await assertManager("edit");
    const audit = await readAudit(
      companyId,
      clean(formData.get("audit_id")),
      authorization,
    );
    const body = clean(formData.get("comment"));
    if (!body) throw new Error("Write a follow-up before sending it.");
    if (!audit.completed_at)
      throw new Error("Complete the audit before sending a station follow-up.");
    const askResponse =
      clean(formData.get("request_station_response")) === "yes";
    const inserted = await db().from("ops_station_audit_comments").insert({
      company_id: companyId,
      audit_id: audit.id,
      body,
      audience: "station",
      requests_station_response: askResponse,
      created_by: authorization.userId,
      author_name: authorization.fullName,
      author_email: authorization.email,
    });
    if (inserted.error) throw new Error(inserted.error.message);
    const due =
      localDeadline(clean(formData.get("response_due_at"))) ||
      new Date(
        Date.now() + audit.ops_audit_types.default_response_hours * 3600000,
      ).toISOString();
    if (askResponse) {
      const update = await db()
        .from("ops_station_audits")
        .update({
          status_code: "awaiting_station_response",
          station_response_status: "requested",
          response_due_at: due,
        })
        .eq("company_id", companyId)
        .eq("id", audit.id)
        .is("deleted_at", null);
      if (update.error) throw new Error(update.error.message);
    }
    await writeStationAuditEvent({
      companyId,
      auditId: audit.id,
      eventType: "manager_comment",
      authorization,
      after: { requestsStationResponse: askResponse },
    });
    const openActions = askResponse
      ? await db()
          .from("ops_station_audit_actions")
          .select("id")
          .eq("company_id", companyId)
          .eq("audit_id", audit.id)
          .neq("status_code", "completed")
      : null;
    if (openActions?.error) throw new Error(openActions.error.message);
    const mailNotice = askResponse
      ? await sendAndRecordAuditEmail(
          companyId,
          {
            ...audit,
            station_response_status: "requested",
            response_due_at: due,
          },
          audit.ops_audit_types,
          audit.stations,
          openActions?.data?.length || 0,
          authorization,
        )
      : "";
    refreshAudits();
    return {
      ok: true,
      message: askResponse
        ? `Follow-up saved; station response requested.${mailNotice}`
        : "Manager note added.",
    };
  } catch (error) {
    return message(error);
  }
}

export async function closeStationAudit(
  auditId: string,
): Promise<ActionResult> {
  try {
    const { authorization, companyId } = await assertManager("edit");
    const audit = await readAudit(companyId, auditId, authorization);
    if (!audit.completed_at || audit.status_code !== "under_review")
      throw new Error("Only a completed audit under review can be closed.");
    if (audit.score_snapshot?.provisional)
      throw new Error(
        "Resolve the score responsibility review before closing this audit.",
      );
    const open = await db()
      .from("ops_station_audit_actions")
      .select("id")
      .eq("company_id", companyId)
      .eq("audit_id", audit.id)
      .neq("status_code", "completed")
      .limit(1);
    if (open.error) throw new Error(open.error.message);
    if (open.data?.length)
      throw new Error(
        "Complete or return the outstanding corrective actions before closing this audit.",
      );
    const update = await db()
      .from("ops_station_audits")
      .update({ status_code: "closed", station_response_status: "accepted" })
      .eq("company_id", companyId)
      .eq("id", audit.id)
      .is("deleted_at", null);
    if (update.error) throw new Error(update.error.message);
    await writeStationAuditEvent({
      companyId,
      auditId: audit.id,
      eventType: "closed",
      authorization,
      before: { status: audit.status_code },
      after: { status: "closed" },
    });
    refreshAudits();
    return { ok: true, message: "Audit closed." };
  } catch (error) {
    return message(error);
  }
}

export async function manageAuditAssignment(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const { authorization, companyId, master } = await assertManager("edit");
    const audit = await readAudit(
      companyId,
      clean(formData.get("audit_id")),
      authorization,
    );
    const operation = clean(formData.get("operation"));
    if (operation === "delete") {
      if (!canDeleteStationAudit(authorization, master.programmeSettings))
        throw new Error(
          "Only the named users authorized in Audit Master can delete audits.",
        );
    } else if (operation === "reassign") {
      const choices = await loadAuditAssignees(
        companyId,
        master.programmeSettings.scheduler_role_ids,
        [audit.location_id],
      );
      if (!choices.some((p) => p.id === clean(formData.get("assigned_to"))))
        throw new Error(
          "Choose an active auditor authorized for this station.",
        );
    } else throw new Error("Invalid audit action.");
    const result = await db().rpc("manage_station_audit", {
      p_company_id: companyId,
      p_audit_id: audit.id,
      p_operation: operation,
      p_expected_updated_at: clean(formData.get("updated_at")),
      p_assigned_to:
        operation === "reassign" ? clean(formData.get("assigned_to")) : null,
      p_reason: clean(formData.get("reason")),
      p_actor_id: authorization.userId,
      p_actor_name: authorization.fullName,
      p_actor_email: authorization.email,
      p_actor_role: authorization.roleCode,
    });
    if (result.error) throw new Error(result.error.message);
    refreshAudits();
    return {
      ok: true,
      message:
        operation === "delete"
          ? "Audit deleted from the queue. Its history and evidence are retained."
          : "Audit reassigned. It now appears in the selected auditor’s queue.",
    };
  } catch (error) {
    return message(error);
  }
}

async function sendAndRecordAuditEmail(
  companyId: string,
  audit: StationAudit,
  type: AuditType,
  station: AuditStation,
  openActions: number,
  authorization: AuthorizationContext,
) {
  try {
    const sent = await sendStationAuditCompletedEmail({
      companyId,
      audit,
      type,
      station,
      openActions,
    });
    const saved = await db()
      .from("ops_station_audits")
      .update({
        email_status: "sent",
        email_error: null,
        email_sent_at: new Date().toISOString(),
        email_recipients: [...sent.to, ...sent.cc],
      })
      .eq("company_id", companyId)
      .eq("id", audit.id)
      .is("deleted_at", null);
    if (saved.error) throw new Error(saved.error.message);
    await writeStationAuditEvent({
      companyId,
      auditId: audit.id,
      eventType: "email_sent",
      authorization,
      after: { to: sent.to, cc: sent.cc },
    });
    return " Email sent to the station and configured managers.";
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Delivery failed";
    const saved = await db()
      .from("ops_station_audits")
      .update({ email_status: "failed", email_error: detail })
      .eq("company_id", companyId)
      .eq("id", audit.id)
      .is("deleted_at", null);
    if (saved.error)
      return " Audit saved, but email status could not be recorded. Check the report before retrying.";
    await writeStationAuditEvent({
      companyId,
      auditId: audit.id,
      eventType: "email_failed",
      authorization,
      after: { error: detail },
    });
    return ` Audit saved; email needs attention: ${detail}`;
  }
}
export async function previewStationAuditEmail(auditId: string) {
  const { authorization, companyId } = await assertManager("edit");
  const audit = await readAudit(companyId, auditId, authorization);
  if (!audit.completed_at)
    throw new Error("Submit the audit before sending its report.");
  return resolveStationAuditRecipients(
    companyId,
    audit.stations,
    audit.ops_audit_types.recipient_rules,
    audit.ops_audit_types.cc_rules,
  );
}

export async function retryStationAuditEmail(
  auditId: string,
  resend = false,
): Promise<ActionResult> {
  try {
    const { authorization, companyId } = await assertManager("edit");
    const audit = await readAudit(companyId, auditId, authorization);
    if (!audit.completed_at || (audit.email_status === "sent" && !resend))
      throw new Error(
        "Retry is available only for an unsent completed audit report.",
      );
    const actions = await db()
      .from("ops_station_audit_actions")
      .select("id")
      .eq("company_id", companyId)
      .eq("audit_id", audit.id)
      .neq("status_code", "completed");
    if (actions.error) throw new Error(actions.error.message);
    const notice = await sendAndRecordAuditEmail(
      companyId,
      audit,
      audit.ops_audit_types,
      audit.stations,
      actions.data?.length || 0,
      authorization,
    );
    refreshAudits();
    return { ok: true, message: notice };
  } catch (error) {
    return message(error);
  }
}

export async function reviewStationAuditScore(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const { authorization, companyId } = await assertManager("edit");
    const audit = await readAudit(
      companyId,
      clean(formData.get("audit_id")),
      authorization,
    );
    if (
      !audit.completed_at ||
      audit.status_code === "closed" ||
      !audit.score_snapshot?.inputs
    )
      throw new Error(
        "Only an open, scored audit can have responsibility reviewed.",
      );
    const input = audit.score_snapshot.inputs;
    const submitted = JSON.parse(
      clean(formData.get("score_assessments")) || "{}",
    );
    const assessments = { ...input.assessments };
    for (const key of Object.keys(audit.score_snapshot.assessments)) {
      const value = submitted[key] || audit.score_snapshot.assessments[key];
      assessments[key] = {
        code: String(value.code || "pending"),
        reason: String(value.reason || ""),
        evidenceId:
          clean(formData.get(`assessment_evidence_${key}`)) ||
          String(value.evidenceId || ""),
      };
    }
    const proofs = await db()
      .from("ops_station_audit_evidence")
      .select("id")
      .eq("company_id", companyId)
      .eq("audit_id", audit.id);
    if (proofs.error) throw new Error(proofs.error.message);
    const snapshot = calculateAuditScore({
      ...input,
      assessments,
      evidenceIds: (proofs.data || []).map((p) => p.id),
    });
    const saved = await db().rpc("review_station_audit_score", {
      p_company: companyId,
      p_audit: audit.id,
      p_updated_at: clean(formData.get("updated_at")),
      p_snapshot: snapshot,
      p_actor: authorization.userId,
      p_name: authorization.fullName,
      p_email: authorization.email,
      p_role: authorization.roleCode,
    });
    if (saved.error) throw new Error(saved.error.message);
    const actions = await db()
      .from("ops_station_audit_actions")
      .select("id")
      .eq("company_id", companyId)
      .eq("audit_id", audit.id)
      .neq("status_code", "completed");
    if (actions.error) throw new Error(actions.error.message);
    const mail = await sendAndRecordAuditEmail(
      companyId,
      { ...audit, score: snapshot.percentage, score_snapshot: snapshot },
      audit.ops_audit_types,
      audit.stations,
      actions.data?.length || 0,
      authorization,
    );
    refreshAudits();
    return {
      ok: true,
      message: `Responsibility reviewed. Original weights and score rules retained.${mail}`,
    };
  } catch (error) {
    return message(error);
  }
}
