"use server";

import { revalidatePath } from "next/cache";
import { hasPermission, isCompanyOwner, requirePagePermission, type AuthorizationContext } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import {
  addRosterDays,
  canUseRosterLocation,
  indiaToday,
  loadOpsRosterCapabilities,
  loadOpsRosteringPolicy,
  resolveOpsRosterApprovalRoute,
  rosterMonday,
  rosterPlanLocationIds
} from "@/lib/ops-pulse/rostering";
import { loadOpsStationManpower } from "@/lib/ops-pulse/station-manpower";
import { supabaseAdmin } from "@/lib/supabase-admin";

type RosterChange = {
  workerType: "employee" | "contractor";
  workerId: string;
  date: string;
  dayType?: "working" | "weekly_off";
  shiftId?: string | null;
  notes?: string | null;
  remove?: boolean;
};

type PreparedRosterEntry = {
  workerType: "employee" | "contractor";
  workerId: string;
  rosterDate: string;
  dayType: "working" | "weekly_off";
  shiftId: string | null;
  notes: string | null;
};

type ActionResult = {
  ok: true;
  message: string;
  planId?: string;
  periodStart?: string;
  entries?: PreparedRosterEntry[];
} | { ok: false; message: string };

function db() {
  if (!supabaseAdmin) throw new Error("Database service is unavailable.");
  return supabaseAdmin;
}

function validDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function rosterChangeInstant(date: string, startTime = "00:00") {
  return new Date(`${date}T${startTime.slice(0, 5)}:00+05:30`).getTime();
}

function rosterCutoffMessage(hours: number) {
  return `Roster changes are allowed only until ${hours} hours before the rostered shift. Past and locked dates cannot be edited.`;
}

function isoWeekday(value: string) {
  const day = new Date(`${value}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

function nextRosterMonday(today: string, leadDays: number) {
  const earliest = addRosterDays(today, Math.max(0, leadDays));
  const date = new Date(`${earliest}T00:00:00Z`);
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + (weekday === 1 ? 0 : 8 - weekday));
  return date.toISOString().slice(0, 10);
}

async function assertPlanner(authorization: AuthorizationContext) {
  const capabilities = await loadOpsRosterCapabilities(authorization);
  if (!capabilities.canPlan) throw new Error("Your designation is not authorised to plan rosters. Contact HR.");
  return capabilities;
}

async function authorisedStation(companyId: string, authorization: AuthorizationContext, locationId: string) {
  if (!locationId || !canUseRosterLocation(authorization, locationId)) throw new Error("This station is outside your OpsPulse location access.");
  const result = await db().from("stations")
    .select("id,station_code,station_name")
    .eq("company_id", companyId)
    .eq("id", locationId)
    .eq("is_active", true)
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);
  if (!result.data) throw new Error("This station is not available.");
  return result.data;
}

async function loadPlan(companyId: string, authorization: AuthorizationContext, planId: string) {
  const result = await db().from("hr_roster_plans")
    .select("id,name,period_start,period_end,status,location_id,created_by,roster_kind,effective_from,revision_no,supersedes_plan_id,hr_roster_plan_locations(location_id)")
    .eq("company_id", companyId)
    .eq("id", planId)
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);
  if (!result.data || !rosterPlanLocationIds(result.data).every((locationId) => canUseRosterLocation(authorization, locationId))) {
    throw new Error("This roster is outside your OpsPulse location access.");
  }
  return result.data;
}

function refreshRosterViews() {
  revalidatePath("/ops-pulse/rostering");
  revalidatePath("/rostering");
  revalidatePath("/attendance");
  revalidatePath("/people-pulse");
  revalidatePath("/payroll");
}

export async function prepareOpsRoster(locationId: string): Promise<ActionResult> {
  try {
    const authorization = await requirePagePermission("ops_rostering", "add");
    const companyId = requireCompanyId(authorization);
    await assertPlanner(authorization);
    const station = await authorisedStation(companyId, authorization, locationId);

    const open = await db().from("hr_roster_plans")
      .select("id,status,period_start,hr_roster_entries(worker_type,worker_id,roster_date,day_type,shift_id,notes)")
      .eq("company_id", companyId)
      .eq("location_id", locationId)
      .eq("roster_kind", "recurring_weekly")
      .in("status", ["draft", "returned", "pending_approval"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (open.error) throw new Error(open.error.message);
    if (open.data?.status === "pending_approval") return { ok: false, message: `${station.station_code} already has a roster change awaiting approval.` };
    if (open.data) return {
      ok: true,
      planId: open.data.id,
      periodStart: open.data.period_start,
      entries: (open.data.hr_roster_entries ?? []).map((entry) => ({
        workerType: entry.worker_type as "employee" | "contractor",
        workerId: entry.worker_id,
        rosterDate: entry.roster_date,
        dayType: entry.day_type as "working" | "weekly_off",
        shiftId: entry.shift_id,
        notes: entry.notes
      })),
      message: "The open roster change is ready."
    };

    const previous = await db().from("hr_roster_plans")
      .select("id,period_start,revision_no,hr_roster_entries(worker_type,worker_id,location_id,roster_date,day_type,shift_id,notes)")
      .eq("company_id", companyId)
      .eq("location_id", locationId)
      .eq("roster_kind", "recurring_weekly")
      .eq("status", "approved")
      .is("superseded_at", null)
      .order("effective_from", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (previous.error) throw new Error(previous.error.message);
    const policy = await loadOpsRosteringPolicy(companyId, locationId);
    const start = previous.data ? nextRosterMonday(indiaToday(), policy.submissionLeadDays) : rosterMonday(indiaToday());
    const revision = Number(previous.data?.revision_no ?? 0) + 1;
    const created = await db().from("hr_roster_plans").insert({
      company_id: companyId,
      name: `${station.station_code} weekly roster · v${revision}`,
      location_id: locationId,
      period_start: start,
      period_end: addRosterDays(start, 6),
      roster_kind: "recurring_weekly",
      effective_from: start,
      supersedes_plan_id: previous.data?.id ?? null,
      revision_no: revision,
      created_by: authorization.userId,
      updated_by: authorization.userId
    }).select("id").single();
    if (created.error || !created.data) throw new Error(created.error?.message ?? "The roster change could not be prepared.");

    const linked = await db().from("hr_roster_plan_locations").insert({ company_id: companyId, plan_id: created.data.id, location_id: locationId });
    if (linked.error) {
      await db().from("hr_roster_plans").delete().eq("company_id", companyId).eq("id", created.data.id);
      throw new Error(linked.error.message);
    }

    const currentPeople = await loadOpsStationManpower(companyId, [station], indiaToday());
    const allowedPeople = new Set(currentPeople.people.map((person) => `${person.workerType}:${person.id}`));
    const copied = (previous.data?.hr_roster_entries ?? [])
      .filter((entry) => allowedPeople.has(`${entry.worker_type}:${entry.worker_id}`))
      .map((entry) => ({
        company_id: companyId,
        plan_id: created.data.id,
        worker_type: entry.worker_type,
        worker_id: entry.worker_id,
        location_id: locationId,
        roster_date: addRosterDays(start, isoWeekday(entry.roster_date) - 1),
        day_type: entry.day_type,
        shift_id: entry.shift_id,
        notes: entry.notes
      }));
    if (copied.length) {
      const copy = await db().from("hr_roster_entries").insert(copied);
      if (copy.error) throw new Error(`The roster was created, but its current pattern could not be copied: ${copy.error.message}`);
    }
    refreshRosterViews();
    return {
      ok: true,
      planId: created.data.id,
      periodStart: start,
      entries: copied.map((entry) => ({
        workerType: entry.worker_type as "employee" | "contractor",
        workerId: entry.worker_id,
        rosterDate: entry.roster_date,
        dayType: entry.day_type as "working" | "weekly_off",
        shiftId: entry.shift_id,
        notes: entry.notes
      })),
      message: "Roster change prepared. Update only what needs to change."
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "The roster change could not be prepared." };
  }
}

export async function saveOpsRosterAssignments(input: { planId: string; changes: RosterChange[] }): Promise<ActionResult> {
  try {
    const authorization = await requirePagePermission("ops_rostering", "edit");
    const companyId = requireCompanyId(authorization);
    await assertPlanner(authorization);
    if (!input?.planId || !Array.isArray(input.changes) || !input.changes.length || input.changes.length > 3000) {
      return { ok: false, message: "Save between 1 and 3,000 roster changes at a time." };
    }
    const plan = await loadPlan(companyId, authorization, input.planId);
    if (!["draft", "returned"].includes(plan.status) || !plan.location_id) return { ok: false, message: "This roster is no longer editable." };
    const station = await authorisedStation(companyId, authorization, plan.location_id);
    const [manpower, shifts, policy, existingEntries] = await Promise.all([
      loadOpsStationManpower(companyId, [station], indiaToday()),
      db().from("hr_shifts").select("id,start_time").eq("company_id", companyId).eq("is_active", true),
      loadOpsRosteringPolicy(companyId, plan.location_id),
      db().from("hr_roster_entries").select("worker_type,worker_id,roster_date,shift_id,day_type").eq("company_id", companyId).eq("plan_id", input.planId)
    ]);
    if (shifts.error) throw new Error(shifts.error.message);
    if (existingEntries.error) throw new Error(existingEntries.error.message);
    const people = new Set(manpower.people.map((person) => `${person.workerType}:${person.id}`));
    const shiftIds = new Set((shifts.data ?? []).map((shift) => shift.id));
    const shiftStartById = new Map((shifts.data ?? []).map((shift) => [shift.id, shift.start_time]));
    const existingByKey = new Map((existingEntries.data ?? []).map((entry) => [`${entry.worker_type}:${entry.worker_id}:${entry.roster_date}`, entry]));
    const unique = new Map<string, RosterChange>();
    for (const change of input.changes) unique.set(`${change.workerType}:${change.workerId}:${change.date}`, change);
    for (const change of unique.values()) {
      const validPerson = people.has(`${change.workerType}:${change.workerId}`);
      const validAssignment = change.remove || (change.dayType === "weekly_off" || (change.dayType === "working" && Boolean(change.shiftId && shiftIds.has(change.shiftId))));
      if (!validPerson || !validDate(change.date) || change.date < plan.period_start || change.date > plan.period_end || !validAssignment) {
        return { ok: false, message: "A selected person, shift or date is outside this roster." };
      }
      const existing = existingByKey.get(`${change.workerType}:${change.workerId}:${change.date}`);
      const startTime = change.dayType === "working" && change.shiftId
        ? shiftStartById.get(change.shiftId)
        : change.remove && existing?.shift_id
          ? shiftStartById.get(existing.shift_id)
          : "00:00";
      if (rosterChangeInstant(change.date, startTime) - Date.now() < policy.changeCutoffHours * 60 * 60 * 1000) {
        return { ok: false, message: rosterCutoffMessage(policy.changeCutoffHours) };
      }
    }

    const touched = await db().from("hr_roster_plans")
      .update({ updated_by: authorization.userId, updated_at: new Date().toISOString() })
      .eq("company_id", companyId)
      .eq("id", input.planId)
      .in("status", ["draft", "returned"])
      .select("id")
      .maybeSingle();
    if (touched.error || !touched.data) throw new Error(touched.error?.message ?? "This roster is no longer editable.");

    const upserts = [...unique.values()].filter((change) => !change.remove).map((change) => ({
      company_id: companyId,
      plan_id: input.planId,
      worker_type: change.workerType,
      worker_id: change.workerId,
      location_id: plan.location_id,
      roster_date: change.date,
      day_type: change.dayType,
      shift_id: change.dayType === "weekly_off" ? null : change.shiftId,
      notes: change.notes?.trim() || null
    }));
    if (upserts.length) {
      const saved = await db().from("hr_roster_entries").upsert(upserts, { onConflict: "company_id,plan_id,worker_type,worker_id,roster_date" });
      if (saved.error) throw new Error(saved.error.message);
    }
    for (const change of [...unique.values()].filter((item) => item.remove)) {
      const removed = await db().from("hr_roster_entries").delete()
        .eq("company_id", companyId)
        .eq("plan_id", input.planId)
        .eq("worker_type", change.workerType)
        .eq("worker_id", change.workerId)
        .eq("roster_date", change.date);
      if (removed.error) throw new Error(removed.error.message);
    }
    refreshRosterViews();
    return { ok: true, message: `${unique.size} roster ${unique.size === 1 ? "change" : "changes"} saved.` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Roster changes could not be saved." };
  }
}

async function publishPlan(companyId: string, authorization: AuthorizationContext, plan: Awaited<ReturnType<typeof loadPlan>>, note: string, preserveSubmission = false) {
  const now = new Date().toISOString();
  const ended = await db().from("hr_roster_plans")
    .update({ superseded_at: plan.effective_from })
    .eq("company_id", companyId)
    .eq("location_id", plan.location_id)
    .eq("roster_kind", "recurring_weekly")
    .eq("status", "approved")
    .is("superseded_at", null)
    .neq("id", plan.id);
  if (ended.error) throw new Error(ended.error.message);
  const approvalUpdate: Record<string, unknown> = {
      status: "approved",
      approver_user_id: null,
      updated_by: authorization.userId,
      updated_at: now,
      decided_at: now,
      decision_note: note
  };
  if (!preserveSubmission) {
    approvalUpdate.submitted_at = now;
    approvalUpdate.submitted_by = authorization.userId;
  }
  const approved = await db().from("hr_roster_plans")
    .update(approvalUpdate)
    .eq("company_id", companyId)
    .eq("id", plan.id)
    .in("status", ["draft", "returned", "pending_approval"])
    .select("id")
    .maybeSingle();
  if (approved.error || !approved.data) throw new Error(approved.error?.message ?? "This roster is no longer available.");
}

export async function submitOpsRoster(planId: string): Promise<ActionResult> {
  try {
    const authorization = await requirePagePermission("ops_rostering", "edit");
    const companyId = requireCompanyId(authorization);
    await assertPlanner(authorization);
    const plan = await loadPlan(companyId, authorization, planId);
    if (!["draft", "returned"].includes(plan.status) || plan.roster_kind !== "recurring_weekly" || !plan.location_id || !plan.effective_from) {
      return { ok: false, message: "This roster is not available for submission." };
    }
    const station = await authorisedStation(companyId, authorization, plan.location_id);
    const people = await loadOpsStationManpower(companyId, [station], indiaToday());
    const count = await db().from("hr_roster_entries").select("id", { count: "exact", head: true }).eq("company_id", companyId).eq("plan_id", planId);
    if (count.error) throw new Error(count.error.message);
    if (!people.people.length || !count.count) return { ok: false, message: "Add at least one roster assignment before applying this pattern." };
    const policy = await loadOpsRosteringPolicy(companyId, plan.location_id);
    if (plan.supersedes_plan_id && plan.effective_from < addRosterDays(indiaToday(), policy.submissionLeadDays)) {
      return { ok: false, message: `This change missed the submission deadline. Its effective Monday must be at least ${policy.submissionLeadDays} days ahead.` };
    }
    const route = await resolveOpsRosterApprovalRoute(authorization, policy);
    if (route.direct) {
      await publishPlan(companyId, authorization, plan, "Applied under Rostering Policy");
      refreshRosterViews();
      return { ok: true, message: "Weekly roster applied." };
    }
    if (route.error || !route.steps.length) return { ok: false, message: route.error ?? "No roster approval route is configured." };
    const cleared = await db().from("hr_roster_approval_steps").delete().eq("company_id", companyId).eq("plan_id", planId);
    if (cleared.error) throw new Error(cleared.error.message);
    const staged = await db().from("hr_roster_approval_steps").insert(route.steps.map((step, index) => ({
      company_id: companyId,
      plan_id: planId,
      stage_no: step.stageNo,
      stage_type: step.stageType,
      approver_user_id: step.approverUserId,
      route_id: step.routeId ?? null,
      resolved_via: step.resolvedVia ?? null,
      original_approver_person_id: step.originalApproverPersonId ?? null,
      fallback_reason: step.fallbackReason ?? null,
      status: index === 0 ? "pending" : "waiting"
    })));
    if (staged.error) throw new Error(staged.error.message);
    const now = new Date().toISOString();
    const submitted = await db().from("hr_roster_plans").update({
      status: "pending_approval",
      approver_user_id: route.steps[0].approverUserId,
      submitted_at: now,
      submitted_by: authorization.userId,
      updated_by: authorization.userId,
      updated_at: now,
      decision_note: null
    }).eq("company_id", companyId).eq("id", planId).in("status", ["draft", "returned"]).select("id").maybeSingle();
    if (submitted.error || !submitted.data) throw new Error(submitted.error?.message ?? "This roster is no longer editable.");
    refreshRosterViews();
    return { ok: true, message: `Weekly roster sent for approval. ${route.summary}` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "The roster could not be submitted." };
  }
}

export async function decideOpsRoster(input: { planId: string; stepId: string; decision: "approved" | "returned" | "rejected"; note: string }): Promise<ActionResult> {
  try {
    const authorization = await requirePagePermission("ops_rostering", "edit");
    const companyId = requireCompanyId(authorization);
    if (!input.planId || !input.stepId || !["approved", "returned", "rejected"].includes(input.decision)) return { ok: false, message: "Select a valid roster decision." };
    if (input.decision !== "approved" && input.note.trim().length < 3) return { ok: false, message: "Add a short reason before returning or rejecting the roster." };
    const capabilities = await loadOpsRosterCapabilities(authorization);
    if (!capabilities.canApprove) return { ok: false, message: "Your designation is not authorised to approve rosters. Contact HR." };
    const stepResult = await db().from("hr_roster_approval_steps")
      .select("id,stage_no,stage_type,approver_user_id,status")
      .eq("company_id", companyId)
      .eq("plan_id", input.planId)
      .eq("id", input.stepId)
      .maybeSingle();
    if (stepResult.error) throw new Error(stepResult.error.message);
    const step = stepResult.data;
    if (!step || step.status !== "pending") return { ok: false, message: "This approval is no longer pending." };
    const authorised = isCompanyOwner(authorization) || step.approver_user_id === authorization.userId || (step.stage_type === "hr" && !step.approver_user_id && capabilities.canApproveHr);
    if (!authorised) return { ok: false, message: "This approval belongs to another approver." };
    const stageAllowed = isCompanyOwner(authorization) || (step.stage_type === "level_1" ? capabilities.canApproveL1 : step.stage_type === "level_2" ? capabilities.canApproveL2 : capabilities.canApproveHr);
    if (!stageAllowed) return { ok: false, message: "Your designation is not configured for this approval stage." };
    const plan = await loadPlan(companyId, authorization, input.planId);
    if (plan.status !== "pending_approval") return { ok: false, message: "This roster is no longer awaiting approval." };
    const now = new Date().toISOString();
    const decided = await db().from("hr_roster_approval_steps").update({
      status: input.decision,
      decision_note: input.note.trim() || null,
      decided_by: authorization.userId,
      decided_at: now,
      updated_at: now
    }).eq("company_id", companyId).eq("id", step.id).eq("status", "pending");
    if (decided.error) throw new Error(decided.error.message);
    if (input.decision !== "approved") {
      const skipped = await db().from("hr_roster_approval_steps").update({ status: "skipped", updated_at: now }).eq("company_id", companyId).eq("plan_id", input.planId).eq("status", "waiting");
      if (skipped.error) throw new Error(skipped.error.message);
      const finished = await db().from("hr_roster_plans").update({ status: input.decision, decision_note: input.note.trim(), decided_at: now, approver_user_id: null, updated_by: authorization.userId, updated_at: now }).eq("company_id", companyId).eq("id", input.planId).eq("status", "pending_approval");
      if (finished.error) throw new Error(finished.error.message);
    } else {
      const next = await db().from("hr_roster_approval_steps").select("id,approver_user_id").eq("company_id", companyId).eq("plan_id", input.planId).eq("status", "waiting").order("stage_no").limit(1).maybeSingle();
      if (next.error) throw new Error(next.error.message);
      if (next.data) {
        const activated = await db().from("hr_roster_approval_steps").update({ status: "pending", updated_at: now }).eq("company_id", companyId).eq("id", next.data.id);
        if (activated.error) throw new Error(activated.error.message);
        const routed = await db().from("hr_roster_plans").update({ approver_user_id: next.data.approver_user_id ?? null, updated_by: authorization.userId, updated_at: now }).eq("company_id", companyId).eq("id", input.planId);
        if (routed.error) throw new Error(routed.error.message);
      } else {
        await publishPlan(companyId, authorization, plan, input.note.trim() || "All approvals complete", true);
      }
    }
    refreshRosterViews();
    return { ok: true, message: `Weekly roster ${input.decision}.` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "The roster decision could not be saved." };
  }
}

export async function canEditOpsRoster(authorization: AuthorizationContext) {
  return hasPermission(authorization, "ops_rostering", "edit") && (await loadOpsRosterCapabilities(authorization)).canPlan;
}
