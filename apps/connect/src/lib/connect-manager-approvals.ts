import "server-only";

import type { ConnectAccount } from "./connect-auth";
import { connectApproverIdentity, expenseWorkerType } from "./connect-expense-data";
import { resolveConnectApproverUserId } from "./connect-approver-identity";
import { notifyAttendanceApprovalRequired } from "../../../../src/lib/connect-attendance-notifications";
import { connectReporteeMatches, type ConnectReporteeAccess } from "./connect-reportee-scope";
import { notifyConnectExitOutcome, notifyExitApprovalRequired } from "./connect-exit-notifications";
import { todayInIndia } from "./india-date";
import { supabaseAdmin } from "./supabase-admin";

type Decision = "approved" | "returned" | "rejected";

function db() {
  if (!supabaseAdmin) throw new Error("Database configuration is unavailable.");
  return supabaseAdmin;
}

function clean(value: unknown) {
  return String(value ?? "").trim();
}

const TEAM_LEAD_DESIGNATION_CODES = new Set(["TL", "ATL", "TEAM_LEAD", "ASST_TEAM_LEAD"]);

function isTeamLeadManagerAssignment(
  designationCode: string | null | undefined,
  positionTitle: string | null | undefined
) {
  const code = String(designationCode ?? "").trim().toUpperCase();
  if (code && TEAM_LEAD_DESIGNATION_CODES.has(code)) return true;
  const title = String(positionTitle ?? "").trim().toUpperCase();
  if (!title) return false;
  return /\b(TL|ATL|TEAM LEAD|ASST\.?\s*TEAM LEAD|ASSISTANT TEAM LEAD)\b/.test(title);
}

async function isTeamLeadRegularizationApprover(account: ConnectAccount) {
  try {
    const identity = await connectApproverIdentity(account);
    let designationCode: string | null = null;
    if (identity.assignment.designation_id) {
      const designation = await db().from("designations").select("code")
        .eq("company_id", account.companyId).eq("id", identity.assignment.designation_id).maybeSingle();
      if (designation.error) throw new Error(designation.error.message);
      designationCode = designation.data?.code ?? null;
    }
    return isTeamLeadManagerAssignment(designationCode, identity.assignment.position_title);
  } catch {
    return false;
  }
}

function one<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

async function approverUserId(account: ConnectAccount) {
  if (account.profileType === "user") return account.id;
  try {
    const identity = await connectApproverIdentity(account);
    if (identity.userId) return identity.userId;
    return resolveConnectApproverUserId(account.companyId, identity.personId);
  } catch {
    const workerType = expenseWorkerType(account.profileType);
    if (!workerType) return null;
    const workerColumn = workerType === "employee" ? "employee_id" : "contractor_id";
    const engagement = await db().from("hr_engagements").select("person_id,status")
      .eq("company_id", account.companyId).eq("worker_type", workerType).eq(workerColumn, account.id)
      .eq("status", "active").limit(1).maybeSingle();
    if (engagement.error || !engagement.data) return null;
    return resolveConnectApproverUserId(account.companyId, engagement.data.person_id);
  }
}

async function canConnectFinalizeAttendance(companyId: string, userId: string) {
  const pageResult = await db().from("hr_permission_pages")
    .select("id").eq("company_id", companyId).eq("code", "attendance").eq("is_active", true).maybeSingle();
  if (pageResult.error || !pageResult.data) return false;
  const permissionResult = await db().from("hr_role_page_permissions")
    .select("role_id").eq("company_id", companyId).eq("page_id", pageResult.data.id).eq("can_approve", true);
  if (permissionResult.error) throw new Error(permissionResult.error.message);
  const roleIds = [...new Set((permissionResult.data ?? []).map((row) => row.role_id))];
  if (!roleIds.length) return false;
  const today = todayInIndia();
  const grantResult = await db().from("hr_access_grants").select("id")
    .eq("company_id", companyId).eq("user_id", userId).eq("is_active", true).in("role_id", roleIds)
    .lte("effective_from", today).or(`effective_to.is.null,effective_to.gte.${today}`).limit(1);
  if (grantResult.error && !String(grantResult.error.message).toLowerCase().includes("does not exist")) {
    throw new Error(grantResult.error.message);
  }
  if ((grantResult.data ?? []).length) return true;
  const legacyResult = await db().from("hr_user_access").select("id")
    .eq("company_id", companyId).eq("user_id", userId).eq("is_active", true).in("role_id", roleIds).limit(1);
  if (legacyResult.error && !String(legacyResult.error.message).toLowerCase().includes("does not exist")) {
    throw new Error(legacyResult.error.message);
  }
  return Boolean((legacyResult.data ?? []).length);
}

async function signedEvidence(path: string | null | undefined) {
  if (!path) return null;
  const result = await db().storage.from("employee-profile-documents").createSignedUrl(path, 60 * 15);
  return result.data?.signedUrl ?? null;
}

export async function listConnectAttendanceApprovals(account: ConnectAccount, reportees: ConnectReporteeAccess) {
  const actorUserId = await approverUserId(account);
  if (!actorUserId) return [];
  if (await isTeamLeadRegularizationApprover(account)) return [];
  const stepsResult = await db().from("attendance_regularization_approval_steps")
    .select("id,request_id,step_order,step_name")
    .eq("company_id", account.companyId).eq("approver_user_id", actorUserId).eq("status", "pending")
    .order("created_at");
  if (stepsResult.error) throw new Error(stepsResult.error.message);
  const steps = stepsResult.data ?? [];
  if (!steps.length) return [];
  const requestsResult = await db().from("attendance_regularization_requests")
    .select("id,profile_type,profile_id,dropx_id,full_name,attendance_date,current_in_time,current_out_time,requested_in_time,requested_out_time,reason_code,remarks,attachment_path,status,created_at")
    .eq("company_id", account.companyId).is("request_kind", null).eq("status", "pending_manager")
    .in("id", [...new Set(steps.map((step) => step.request_id))]);
  if (requestsResult.error) throw new Error(requestsResult.error.message);
  const requestById = new Map((requestsResult.data ?? [])
    .filter((request) => connectReporteeMatches(reportees, request.profile_type, request.profile_id))
    .map((request) => [request.id, request]));
  return Promise.all(steps.flatMap((step) => {
    const request = requestById.get(step.request_id);
    return request ? [{ step, request }] : [];
  }).map(async ({ step, request }) => ({
    id: step.id,
    requestId: request.id,
    stepName: step.step_name,
    stepOrder: step.step_order,
    workerName: request.full_name || "Team member",
    workerCode: request.dropx_id || "",
    profileType: request.profile_type === "contractor" ? "contractor" : "employee",
    attendanceDate: request.attendance_date,
    currentInTime: request.current_in_time,
    currentOutTime: request.current_out_time,
    requestedInTime: request.requested_in_time,
    requestedOutTime: request.requested_out_time,
    reasonCode: request.reason_code,
    remarks: request.remarks,
    evidenceUrl: await signedEvidence(request.attachment_path),
    createdAt: request.created_at,
    queue: "manager" as const
  })));
}

export async function listConnectAttendanceHrApprovals(account: ConnectAccount, reportees: ConnectReporteeAccess) {
  const actorUserId = await approverUserId(account);
  if (!actorUserId) return [];
  if (!(await canConnectFinalizeAttendance(account.companyId, actorUserId))) return [];
  const requestsResult = await db().from("attendance_regularization_requests")
    .select("id,profile_type,profile_id,dropx_id,full_name,attendance_date,current_in_time,current_out_time,requested_in_time,requested_out_time,reason_code,remarks,attachment_path,status,created_at")
    .eq("company_id", account.companyId).is("request_kind", null)
    .in("status", ["pending_hr", "pending"])
    .order("created_at");
  if (requestsResult.error) throw new Error(requestsResult.error.message);
  const rows = ((requestsResult.data ?? []) as Array<{
    id: string;
    profile_type: string;
    profile_id: string;
    dropx_id: string | null;
    full_name: string | null;
    attendance_date: string;
    current_in_time: string | null;
    current_out_time: string | null;
    requested_in_time: string | null;
    requested_out_time: string | null;
    reason_code: string;
    remarks: string | null;
    attachment_path: string | null;
    status: string;
    created_at: string;
  }>).filter((request) => connectReporteeMatches(reportees, request.profile_type, request.profile_id));
  const filtered = [];
  for (const request of rows) {
    if (request.status === "pending_hr") {
      filtered.push(request);
      continue;
    }
    const stepsResult = await db().from("attendance_regularization_approval_steps")
      .select("id").eq("company_id", account.companyId).eq("request_id", request.id).limit(1);
    if (stepsResult.error) throw new Error(stepsResult.error.message);
    if (!(stepsResult.data ?? []).length) filtered.push(request);
  }
  return Promise.all(filtered.map(async (request) => ({
    id: request.id,
    requestId: request.id,
    stepName: "HR finalization",
    stepOrder: 0,
    workerName: request.full_name || "Team member",
    workerCode: request.dropx_id || "",
    profileType: request.profile_type === "contractor" ? "contractor" as const : "employee" as const,
    attendanceDate: request.attendance_date,
    currentInTime: request.current_in_time,
    currentOutTime: request.current_out_time,
    requestedInTime: request.requested_in_time,
    requestedOutTime: request.requested_out_time,
    reasonCode: request.reason_code,
    remarks: request.remarks,
    evidenceUrl: await signedEvidence(request.attachment_path),
    createdAt: request.created_at,
    queue: "hr" as const
  })));
}

export async function decideConnectAttendanceHrApproval(
  account: ConnectAccount,
  requestIdValue: unknown,
  decisionValue: unknown,
  noteValue: unknown
) {
  const actorUserId = await approverUserId(account);
  if (!actorUserId) throw new Error("A linked People login is required to finalize attendance.");
  if (!(await canConnectFinalizeAttendance(account.companyId, actorUserId))) {
    throw new Error("Attendance finalization is not enabled for this account.");
  }
  const requestId = clean(requestIdValue);
  const decision = clean(decisionValue);
  const note = clean(noteValue);
  if (!/^[0-9a-f-]{36}$/i.test(requestId) || !["approved", "returned", "rejected"].includes(decision)) {
    throw new Error("Choose Apply correction, Return, or Reject.");
  }
  if (decision !== "approved" && note.length < 3) throw new Error("Add a note when returning or rejecting.");
  const request = await db().from("attendance_regularization_requests").select("attachment_path")
    .eq("company_id", account.companyId).eq("id", requestId).is("request_kind", null).maybeSingle();
  if (request.error || !request.data) throw new Error(request.error?.message ?? "Attendance request was not found.");
  if (decision === "approved" && !(await signedEvidence(request.data.attachment_path))) {
    throw new Error("Correction cannot be applied. Workplace CCTV proof is missing or unavailable.");
  }
  const result = await db().rpc("hr_review_attendance_regularization", {
    p_company_id: account.companyId,
    p_request_id: requestId,
    p_decision: decision,
    p_review_remarks: note,
    p_reviewer_id: actorUserId,
    p_reviewer_name: account.name ?? account.reference ?? "HR reviewer"
  });
  if (result.error) throw new Error(result.error.message);
  if (decision === "approved") return "Attendance correction applied to the register.";
  if (decision === "returned") return "Attendance correction returned to the worker.";
  return "Attendance correction rejected.";
}

export async function decideConnectAttendanceApproval(account: ConnectAccount, requestIdValue: unknown, decisionValue: unknown, noteValue: unknown) {
  const actorUserId = await approverUserId(account);
  if (!actorUserId) throw new Error("A linked People login is required to approve attendance.");
  if (await isTeamLeadRegularizationApprover(account)) {
    throw new Error("Team leads cannot approve attendance regularizations.");
  }
  const requestId = clean(requestIdValue);
  const decision = clean(decisionValue);
  const note = clean(noteValue);
  if (!/^[0-9a-f-]{36}$/i.test(requestId) || !["approved", "rejected"].includes(decision)) throw new Error("Choose Approve or Reject.");
  const assigned = await db().from("attendance_regularization_approval_steps").select("id")
    .eq("company_id", account.companyId).eq("request_id", requestId).eq("approver_user_id", actorUserId).eq("status", "pending").maybeSingle();
  if (assigned.error || !assigned.data) throw new Error(assigned.error?.message ?? "This attendance approval is no longer assigned to you.");
  const request = await db().from("attendance_regularization_requests").select("attachment_path")
    .eq("company_id", account.companyId).eq("id", requestId).is("request_kind", null).maybeSingle();
  if (request.error || !request.data) throw new Error(request.error?.message ?? "Attendance request was not found.");
  if (decision === "approved" && !(await signedEvidence(request.data.attachment_path))) {
    throw new Error("Approval blocked. Timestamped workplace proof is missing or unavailable.");
  }
  const result = await db().rpc("hr_decide_attendance_regularization_step", {
    p_company_id: account.companyId,
    p_request_id: requestId,
    p_actor_user_id: actorUserId,
    p_decision: decision,
    p_note: note
  });
  if (result.error) throw new Error(result.error.message);
  if (result.data === "pending_manager") {
    const [requestRow, nextStep] = await Promise.all([
      db().from("attendance_regularization_requests").select("full_name,attendance_date")
        .eq("company_id", account.companyId).eq("id", requestId).maybeSingle(),
      db().from("attendance_regularization_approval_steps").select("approver_user_id")
        .eq("company_id", account.companyId).eq("request_id", requestId).eq("status", "pending")
        .order("step_order", { ascending: true }).limit(1).maybeSingle()
    ]);
    if (!requestRow.error && !nextStep.error && nextStep.data?.approver_user_id) {
      await notifyAttendanceApprovalRequired({
        companyId: account.companyId,
        requestId,
        recipientUserId: nextStep.data.approver_user_id,
        workerName: requestRow.data?.full_name || "Team member",
        attendanceDate: String(requestRow.data?.attendance_date ?? "")
      });
    }
    return "Attendance step approved and routed to the next manager.";
  }
  if (result.data === "approved") return "Attendance regularization approved.";
  if (result.data === "pending_hr") return "Manager approvals complete. People will perform final attendance validation.";
  return "Attendance regularization rejected.";
}

async function canApproveUnassignedRosterHr(account: ConnectAccount) {
  if (/owner/i.test(account.role ?? "")) return true;
  const userId = await approverUserId(account);
  if (!userId) return false;
  const result = await db().from("hr_user_access").select("role_code")
    .eq("company_id", account.companyId).eq("user_id", userId).eq("is_active", true).maybeSingle();
  if (result.error) throw new Error(result.error.message);
  return [
    "OWNER", "OWNER_BREAK_GLASS", "PEOPLE_MANAGING_PARTNER",
    "HR_HEAD", "HR_HAEAD", "HR_OPERATIONS", "HR_EXECUTIVE",
    "PEOPLE_HRM", "PEOPLE_HRE"
  ].includes(String(result.data?.role_code ?? "").toUpperCase());
}

export async function listConnectRosterApprovals(account: ConnectAccount) {
  const actorUserId = await approverUserId(account);
  if (!actorUserId) return [];
  const [stepsResult, canApproveHr] = await Promise.all([
    db().from("hr_roster_approval_steps")
      .select("id,plan_id,stage_no,stage_type,approver_user_id,status,hr_roster_plans!inner(id,name,location_id,period_start,period_end,status,roster_kind,effective_from,revision_no,submitted_at,stations!hr_roster_plans_location_id_fkey(station_code,station_name),hr_roster_entries(id))")
      .eq("company_id", account.companyId).eq("status", "pending").order("created_at"),
    canApproveUnassignedRosterHr(account)
  ]);
  if (stepsResult.error) throw new Error(stepsResult.error.message);
  const staged = (stepsResult.data ?? []).filter((step) => step.approver_user_id === actorUserId || (step.stage_type === "hr" && !step.approver_user_id && canApproveHr));
  const rows = staged.flatMap((step) => {
    const plan = one(step.hr_roster_plans);
    const station = one(plan?.stations);
    return plan ? [{
      id: step.id,
      planId: plan.id,
      stepId: step.id,
      stageType: step.stage_type,
      stageNumber: step.stage_no,
      name: plan.name,
      stationCode: station?.station_code ?? "—",
      stationName: station?.station_name ?? "",
      effectiveFrom: plan.effective_from ?? plan.period_start,
      periodEnd: plan.period_end,
      revision: plan.revision_no ?? 1,
      rowCount: plan.hr_roster_entries?.length ?? 0
    }] : [];
  });
  const legacyResult = await db().from("hr_roster_plans")
    .select("id,name,location_id,period_start,period_end,status,roster_kind,effective_from,revision_no,stations!hr_roster_plans_location_id_fkey(station_code,station_name),hr_roster_entries(id)")
    .eq("company_id", account.companyId).eq("approver_user_id", actorUserId).eq("status", "pending_approval").order("submitted_at");
  if (legacyResult.error) throw new Error(legacyResult.error.message);
  const stagedPlanIds = new Set(rows.map((row) => row.planId));
  return [...rows, ...(legacyResult.data ?? []).flatMap((plan) => {
    if (stagedPlanIds.has(plan.id)) return [];
    const station = one(plan.stations);
    return [{ id: `legacy:${plan.id}`, planId: plan.id, stepId: null, stageType: "level_1", stageNumber: 1, name: plan.name, stationCode: station?.station_code ?? "—", stationName: station?.station_name ?? "", effectiveFrom: plan.effective_from ?? plan.period_start, periodEnd: plan.period_end, revision: plan.revision_no ?? 1, rowCount: plan.hr_roster_entries?.length ?? 0 }];
  })];
}

export async function decideConnectRosterApproval(account: ConnectAccount, planIdValue: unknown, stepIdValue: unknown, decisionValue: unknown, noteValue: unknown) {
  const actorUserId = await approverUserId(account);
  if (!actorUserId) throw new Error("A linked People login is required to approve a roster.");
  const planId = clean(planIdValue);
  const stepId = clean(stepIdValue);
  const decision = clean(decisionValue) as Decision;
  const note = clean(noteValue);
  if (!/^[0-9a-f-]{36}$/i.test(planId) || !["approved", "returned", "rejected"].includes(decision)) throw new Error("Choose a valid roster decision.");
  if (decision !== "approved" && note.length < 3) throw new Error("Add a decision note when returning or rejecting a roster.");
  const now = new Date().toISOString();
  if (!stepId) {
    const legacy = await db().from("hr_roster_plans").select("id,location_id,effective_from,status,approver_user_id")
      .eq("company_id", account.companyId).eq("id", planId).eq("status", "pending_approval").maybeSingle();
    if (legacy.error || !legacy.data || legacy.data.approver_user_id !== actorUserId) throw new Error(legacy.error?.message ?? "This roster approval is no longer assigned to you.");
    if (decision === "approved" && legacy.data.location_id && legacy.data.effective_from) {
      const ended = await db().from("hr_roster_plans").update({ superseded_at: legacy.data.effective_from })
        .eq("company_id", account.companyId).eq("location_id", legacy.data.location_id).eq("roster_kind", "recurring_weekly")
        .eq("status", "approved").is("superseded_at", null).neq("id", planId);
      if (ended.error) throw new Error(ended.error.message);
    }
    const update = await db().from("hr_roster_plans").update({ status: decision, decision_note: note || "Approved", decided_at: now, approver_user_id: null })
      .eq("company_id", account.companyId).eq("id", planId).eq("status", "pending_approval");
    if (update.error) throw new Error(update.error.message);
    return `Weekly roster ${decision}.`;
  }
  const stepResult = await db().from("hr_roster_approval_steps")
    .select("id,stage_no,stage_type,approver_user_id,status,hr_roster_plans!inner(id,location_id,effective_from,status)")
    .eq("company_id", account.companyId).eq("plan_id", planId).eq("id", stepId).maybeSingle();
  if (stepResult.error || !stepResult.data || stepResult.data.status !== "pending") throw new Error(stepResult.error?.message ?? "This roster approval is no longer pending.");
  const step = stepResult.data;
  const canApproveHr = step.stage_type === "hr" && !step.approver_user_id ? await canApproveUnassignedRosterHr(account) : false;
  if (step.approver_user_id !== actorUserId && !canApproveHr) throw new Error("This roster approval belongs to another approver.");
  const decided = await db().from("hr_roster_approval_steps").update({ status: decision, decision_note: note || null, decided_by: actorUserId, decided_at: now, updated_at: now })
    .eq("company_id", account.companyId).eq("id", stepId).eq("status", "pending");
  if (decided.error) throw new Error(decided.error.message);
  const plan = one(step.hr_roster_plans);
  if (!plan) throw new Error("Weekly roster not found.");
  if (decision !== "approved") {
    const skipped = await db().from("hr_roster_approval_steps").update({ status: "skipped", updated_at: now }).eq("company_id", account.companyId).eq("plan_id", planId).eq("status", "waiting");
    if (skipped.error) throw new Error(skipped.error.message);
    const finished = await db().from("hr_roster_plans").update({ status: decision, decision_note: note, decided_at: now, approver_user_id: null }).eq("company_id", account.companyId).eq("id", planId).eq("status", "pending_approval");
    if (finished.error) throw new Error(finished.error.message);
    return `Weekly roster ${decision}.`;
  }
  const next = await db().from("hr_roster_approval_steps").select("id,approver_user_id").eq("company_id", account.companyId).eq("plan_id", planId).eq("status", "waiting").order("stage_no").limit(1).maybeSingle();
  if (next.error) throw new Error(next.error.message);
  if (next.data) {
    const activated = await db().from("hr_roster_approval_steps").update({ status: "pending", updated_at: now }).eq("company_id", account.companyId).eq("id", next.data.id);
    if (activated.error) throw new Error(activated.error.message);
    const routed = await db().from("hr_roster_plans").update({ approver_user_id: next.data.approver_user_id ?? null }).eq("company_id", account.companyId).eq("id", planId);
    if (routed.error) throw new Error(routed.error.message);
    return "Roster step approved and routed to the next approver.";
  }
  const ended = await db().from("hr_roster_plans").update({ superseded_at: plan.effective_from }).eq("company_id", account.companyId).eq("location_id", plan.location_id).eq("roster_kind", "recurring_weekly").eq("status", "approved").is("superseded_at", null).neq("id", planId);
  if (ended.error) throw new Error(ended.error.message);
  const published = await db().from("hr_roster_plans").update({ status: "approved", decision_note: note || "All approvals complete", decided_at: now, approver_user_id: null }).eq("company_id", account.companyId).eq("id", planId).eq("status", "pending_approval");
  if (published.error) throw new Error(published.error.message);
  return "Weekly roster approved and published to attendance.";
}

async function actorRoleIds(companyId: string, actorUserId: string) {
  const today = todayInIndia();
  const [grants, legacy] = await Promise.all([
    db().from("hr_access_grants").select("role_id").eq("company_id", companyId).eq("user_id", actorUserId).eq("is_active", true).lte("effective_from", today).or(`effective_to.is.null,effective_to.gte.${today}`),
    db().from("hr_user_access").select("role_id").eq("company_id", companyId).eq("user_id", actorUserId).eq("is_active", true)
  ]);
  if (grants.error && !/does not exist|schema cache/i.test(grants.error.message)) throw new Error(grants.error.message);
  if (legacy.error) throw new Error(legacy.error.message);
  return new Set([...(grants.data ?? []), ...(legacy.data ?? [])].map((row) => row.role_id).filter(Boolean));
}

export async function listConnectExitApprovals(account: ConnectAccount) {
  const actorUserId = await approverUserId(account);
  if (!actorUserId) return [];
  const roles = await actorRoleIds(account.companyId, actorUserId);
  const stepsResult = await db().from("hr_exit_approvals")
    .select("id,case_id,workflow_step_id,step_order,step_name,approver_source,approver_role_id,assigned_user_id,is_required,status,created_at")
    .eq("company_id", account.companyId).eq("status", "pending").order("created_at");
  if (stepsResult.error) throw new Error(stepsResult.error.message);
  const candidates = (stepsResult.data ?? []).filter((step) => step.assigned_user_id === actorUserId || (!step.assigned_user_id && step.approver_role_id && roles.has(step.approver_role_id)));
  if (!candidates.length) return [];
  const caseIds = [...new Set(candidates.map((step) => step.case_id))];
  const [casesResult, allStepsResult] = await Promise.all([
    db().from("hr_exit_cases").select("id,case_number,worker_type,requested_last_working_date,employee_reason,status,submitted_at,employees(full_name,employee_code),contractors(full_name,dropx_id)").eq("company_id", account.companyId).in("id", caseIds),
    db().from("hr_exit_approvals").select("id,case_id,step_order,status,is_required").eq("company_id", account.companyId).in("case_id", caseIds)
  ]);
  if (casesResult.error || allStepsResult.error) throw new Error(casesResult.error?.message ?? allStepsResult.error?.message ?? "Exit approvals could not be loaded.");
  const caseById = new Map((casesResult.data ?? []).map((item) => [item.id, item]));
  const allSteps = allStepsResult.data ?? [];
  return candidates.flatMap((step) => {
    const exitCase = caseById.get(step.case_id);
    const blocked = allSteps.some((item) => item.case_id === step.case_id && item.is_required && item.step_order < step.step_order && item.status !== "approved");
    if (!exitCase || blocked || ["rejected", "closed", "cancelled", "withdrawn"].includes(exitCase.status)) return [];
    const employee = one(exitCase.employees);
    const contractor = one(exitCase.contractors);
    return [{
      id: step.id,
      caseId: exitCase.id,
      caseNumber: exitCase.case_number,
      stepName: step.step_name,
      stepOrder: step.step_order,
      requesterName: employee?.full_name ?? contractor?.full_name ?? "Team member",
      requesterCode: employee?.employee_code ?? contractor?.dropx_id ?? "",
      profileType: exitCase.worker_type === "contractor" ? "contractor" : "employee",
      requestedLastWorkingDate: exitCase.requested_last_working_date,
      reason: exitCase.employee_reason ?? "No additional comment",
      submittedAt: exitCase.submitted_at
    }];
  });
}

export async function decideConnectExitApproval(account: ConnectAccount, approvalIdValue: unknown, decisionValue: unknown, noteValue: unknown) {
  const actorUserId = await approverUserId(account);
  if (!actorUserId) throw new Error("A linked People login is required to approve an exit request.");
  const approvalId = clean(approvalIdValue);
  const decision = clean(decisionValue);
  const comments = clean(noteValue);
  if (!/^[0-9a-f-]{36}$/i.test(approvalId) || !["approved", "rejected"].includes(decision)) throw new Error("Choose Approve or Reject.");
  if (decision === "rejected" && comments.length < 3) throw new Error("Add a reason when rejecting an exit request.");
  const approvalResult = await db().from("hr_exit_approvals").select("*").eq("company_id", account.companyId).eq("id", approvalId).maybeSingle();
  const approval = approvalResult.data;
  if (approvalResult.error || !approval || approval.status !== "pending") throw new Error(approvalResult.error?.message ?? "This exit approval is no longer pending.");
  const roles = await actorRoleIds(account.companyId, actorUserId);
  if (approval.assigned_user_id !== actorUserId && (!approval.approver_role_id || !roles.has(approval.approver_role_id))) throw new Error("This exit approval belongs to another approver.");
  const earlier = await db().from("hr_exit_approvals").select("id").eq("company_id", account.companyId).eq("case_id", approval.case_id).eq("is_required", true).lt("step_order", approval.step_order).neq("status", "approved").limit(1);
  if (earlier.error) throw new Error(earlier.error.message);
  if (earlier.data?.length) throw new Error("Complete the earlier approval step first.");
  const updated = await db().from("hr_exit_approvals").update({ status: decision, comments: comments || null, acted_by: actorUserId, acted_at: new Date().toISOString() }).eq("company_id", account.companyId).eq("id", approvalId).eq("status", "pending");
  if (updated.error) throw new Error(updated.error.message);
  await db().from("hr_exit_events").insert({ company_id: account.companyId, case_id: approval.case_id, event_code: decision === "approved" ? "APPROVAL_COMPLETED" : "CASE_REJECTED", title: `${approval.step_name} ${decision}`, actor_name: account.name ?? "Approver", details: { comments } });
  if (decision === "rejected") {
    const rejected = await db().from("hr_exit_cases").update({ status: "rejected", reviewed_by: actorUserId, reviewed_at: new Date().toISOString() }).eq("company_id", account.companyId).eq("id", approval.case_id);
    if (rejected.error) throw new Error(rejected.error.message);
    await notifyConnectExitOutcome({ companyId: account.companyId, caseId: approval.case_id, event: "CASE_REJECTED" });
    return "Exit request rejected and the requester was notified.";
  }
  const nextResult = await db().from("hr_exit_approvals").select("id,workflow_step_id").eq("company_id", account.companyId).eq("case_id", approval.case_id).eq("is_required", true).eq("status", "pending").order("step_order").limit(1).maybeSingle();
  if (nextResult.error) throw new Error(nextResult.error.message);
  if (nextResult.data) {
    if (nextResult.data.workflow_step_id) await notifyExitApprovalRequired({ companyId: account.companyId, caseId: approval.case_id, approvalStepId: nextResult.data.workflow_step_id });
    return "Exit step approved and routed to the next configured approver.";
  }
  const caseResult = await db().from("hr_exit_cases").select("approved_last_working_date,effective_date,requested_last_working_date").eq("company_id", account.companyId).eq("id", approval.case_id).maybeSingle();
  if (caseResult.error || !caseResult.data) throw new Error(caseResult.error?.message ?? "Exit case was not found.");
  const lastDate = caseResult.data.approved_last_working_date ?? caseResult.data.effective_date ?? caseResult.data.requested_last_working_date;
  const approved = await db().from("hr_exit_cases").update({ status: "approved", current_stage: "notice", approved_last_working_date: lastDate, reviewed_by: actorUserId, reviewed_at: new Date().toISOString() }).eq("company_id", account.companyId).eq("id", approval.case_id);
  if (approved.error) throw new Error(approved.error.message);
  await db().from("hr_exit_events").insert({ company_id: account.companyId, case_id: approval.case_id, event_code: "CASE_APPROVED", title: "Exit request fully approved", actor_name: account.name ?? "Approver", details: {} });
  await notifyConnectExitOutcome({ companyId: account.companyId, caseId: approval.case_id, event: "CASE_APPROVED" });
  return "Exit request fully approved and the requester was notified.";
}

async function workerDisplay(companyId: string, workerType: string, workerId: string) {
  if (workerType === "employee") {
    const result = await db().from("employees").select("full_name,employee_code").eq("id", workerId).maybeSingle();
    if (result.error) throw new Error(result.error.message);
    return { name: result.data?.full_name ?? "Team member", code: result.data?.employee_code ?? "" };
  }
  const result = await db().from("contractors").select("full_name,dropx_id").eq("id", workerId).maybeSingle();
  if (result.error) throw new Error(result.error.message);
  return { name: result.data?.full_name ?? "Team member", code: result.data?.dropx_id ?? "" };
}

export async function listConnectRosterSwapApprovals(account: ConnectAccount) {
  const actorUserId = await approverUserId(account);
  if (!actorUserId) return [];
  const result = await db().from("hr_roster_swap_requests")
    .select("id,roster_date,status,requester_worker_type,requester_worker_id,partner_worker_type,partner_worker_id,requester_day_type,partner_day_type,requester_shift_id,partner_shift_id,requester_note,partner_note,requested_at")
    .eq("company_id", account.companyId)
    .eq("approver_user_id", actorUserId)
    .eq("status", "pending_manager")
    .order("requested_at", { ascending: false });
  if (result.error) throw new Error(result.error.message);
  const shiftIds = [...new Set((result.data ?? []).flatMap((row) => [row.requester_shift_id, row.partner_shift_id]).filter(Boolean))] as string[];
  const shiftsResult = shiftIds.length
    ? await db().from("hr_shifts").select("id,name,code,start_time,end_time").in("id", shiftIds)
    : { data: [], error: null };
  if (shiftsResult.error) throw new Error(shiftsResult.error.message);
  const shifts = new Map((shiftsResult.data ?? []).map((shift) => [shift.id, shift]));
  return Promise.all((result.data ?? []).map(async (row) => {
    const [requester, partner] = await Promise.all([
      workerDisplay(account.companyId, row.requester_worker_type, row.requester_worker_id),
      workerDisplay(account.companyId, row.partner_worker_type, row.partner_worker_id)
    ]);
    const requesterShift = row.requester_shift_id ? shifts.get(row.requester_shift_id) ?? null : null;
    const partnerShift = row.partner_shift_id ? shifts.get(row.partner_shift_id) ?? null : null;
    return {
      id: row.id,
      rosterDate: row.roster_date,
      requestedAt: row.requested_at,
      requesterName: requester.name,
      requesterCode: requester.code,
      partnerName: partner.name,
      partnerCode: partner.code,
      requesterDayType: row.requester_day_type,
      partnerDayType: row.partner_day_type,
      requesterShift,
      partnerShift,
      requesterNote: row.requester_note,
      partnerNote: row.partner_note
    };
  }));
}

async function notifyRosterSwapWorkers(input: {
  companyId: string;
  requesterWorkerType: string;
  requesterWorkerId: string;
  partnerWorkerType: string;
  partnerWorkerId: string;
  requestId: string;
  rosterDate: string;
  approved: boolean;
}) {
  const event = input.approved ? "roster_swap_approved" : "roster_swap_rejected";
  const title = input.approved ? "Shift swap approved" : "Shift swap rejected";
  const body = input.approved
    ? `Your manager approved the shift swap for ${input.rosterDate}.`
    : `Your manager rejected the shift swap for ${input.rosterDate}.`;
  await Promise.all([
    db().from("mob_app_notifications").upsert({
      company_id: input.companyId,
      recipient_profile_type: input.requesterWorkerType,
      recipient_account_id: input.requesterWorkerId,
      event_code: event,
      source_key: input.requestId,
      title,
      body,
      route: "roster",
      data: { requestId: input.requestId, rosterDate: input.rosterDate },
      push_status: "not_configured"
    }, { onConflict: "company_id,event_code,source_key,recipient_account_id", ignoreDuplicates: true }),
    db().from("mob_app_notifications").upsert({
      company_id: input.companyId,
      recipient_profile_type: input.partnerWorkerType,
      recipient_account_id: input.partnerWorkerId,
      event_code: event,
      source_key: input.requestId,
      title,
      body,
      route: "roster",
      data: { requestId: input.requestId, rosterDate: input.rosterDate },
      push_status: "not_configured"
    }, { onConflict: "company_id,event_code,source_key,recipient_account_id", ignoreDuplicates: true })
  ]);
}

export async function decideConnectRosterSwapApproval(account: ConnectAccount, requestIdValue: unknown, decisionValue: unknown, noteValue: unknown) {
  const actorUserId = await approverUserId(account);
  if (!actorUserId) throw new Error("A linked People login is required to approve a shift swap.");
  const requestId = clean(requestIdValue);
  const decision = clean(decisionValue);
  const note = clean(noteValue).slice(0, 500);
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw new Error("Shift swap request is invalid.");
  if (decision !== "approved" && decision !== "rejected") throw new Error("Choose Approve or Reject.");
  const accept = decision === "approved";

  const rpc = await db().rpc("hr_manager_decide_roster_swap", {
    p_company_id: account.companyId,
    p_request_id: requestId,
    p_actor_user_id: actorUserId,
    p_accept: accept,
    p_note: note || null
  });
  if (!rpc.error) {
    const decided = rpc.data as {
      status: string;
      approver_user_id: string | null;
      roster_date: string;
      requester_worker_type: string;
      requester_worker_id: string;
      partner_worker_type: string;
      partner_worker_id: string;
    };
    if (accept && decided.status === "pending_manager" && decided.approver_user_id) {
      await db().from("people_web_notifications").upsert({
        company_id: account.companyId,
        recipient_user_id: decided.approver_user_id,
        event_code: "roster_swap_approval_required",
        title: "Shift swap awaiting approval",
        body: `A shift swap for ${decided.roster_date} is ready for your approval.`,
        href: "/approvals",
        source_key: requestId,
        data: { requestId, rosterDate: decided.roster_date }
      }, { onConflict: "company_id,event_code,source_key,recipient_user_id", ignoreDuplicates: true });
      return "Approval recorded and sent to the next approver.";
    }
    await notifyRosterSwapWorkers({
      companyId: account.companyId,
      requesterWorkerType: decided.requester_worker_type,
      requesterWorkerId: decided.requester_worker_id,
      partnerWorkerType: decided.partner_worker_type,
      partnerWorkerId: decided.partner_worker_id,
      requestId,
      rosterDate: decided.roster_date,
      approved: accept
    });
    return accept ? "Shift swap approved." : "Shift swap rejected.";
  }
  const missingRpc = /Could not find the function|schema cache|does not exist/i.test(rpc.error.message);
  if (!missingRpc) throw new Error(rpc.error.message);

  const current = await db().from("hr_roster_swap_requests")
    .select("id,status,approver_user_id,roster_date,requester_entry_id,partner_entry_id,requester_worker_type,requester_worker_id,partner_worker_type,partner_worker_id,requester_shift_id,partner_shift_id,requester_day_type,partner_day_type")
    .eq("company_id", account.companyId)
    .eq("id", requestId)
    .maybeSingle();
  if (current.error || !current.data) throw new Error(current.error?.message ?? "Shift swap request was not found.");
  const swap = current.data;
  if (swap.status !== "pending_manager") throw new Error("This shift swap is no longer awaiting manager approval.");
  if (swap.approver_user_id !== actorUserId) throw new Error("This shift swap belongs to another approver.");

  const now = new Date().toISOString();
  if (accept) {
    const [requesterUpdate, partnerUpdate] = await Promise.all([
      db().from("hr_roster_entries").update({
        shift_id: swap.partner_shift_id,
        day_type: swap.partner_day_type,
        updated_at: now
      }).eq("company_id", account.companyId).eq("id", swap.requester_entry_id),
      db().from("hr_roster_entries").update({
        shift_id: swap.requester_shift_id,
        day_type: swap.requester_day_type,
        updated_at: now
      }).eq("company_id", account.companyId).eq("id", swap.partner_entry_id)
    ]);
    if (requesterUpdate.error || partnerUpdate.error) {
      throw new Error(requesterUpdate.error?.message ?? partnerUpdate.error?.message ?? "Roster could not be updated.");
    }
  }

  const finished = await db().from("hr_roster_swap_requests").update({
    status: accept ? "approved" : "rejected",
    updated_at: now,
    ...(note ? { manager_note: note } : {})
  }).eq("company_id", account.companyId).eq("id", requestId).eq("status", "pending_manager");
  if (finished.error) {
    if (/manager_note/i.test(finished.error.message)) {
      const retry = await db().from("hr_roster_swap_requests").update({
        status: accept ? "approved" : "rejected",
        updated_at: now
      }).eq("company_id", account.companyId).eq("id", requestId).eq("status", "pending_manager");
      if (retry.error) throw new Error(retry.error.message);
    } else {
      throw new Error(finished.error.message);
    }
  }

  await notifyRosterSwapWorkers({
    companyId: account.companyId,
    requesterWorkerType: swap.requester_worker_type,
    requesterWorkerId: swap.requester_worker_id,
    partnerWorkerType: swap.partner_worker_type,
    partnerWorkerId: swap.partner_worker_id,
    requestId,
    rosterDate: swap.roster_date,
    approved: accept
  });

  return accept ? "Shift swap approved." : "Shift swap rejected.";
}

export async function listConnectReturnedRosters(account: ConnectAccount) {
  const actorUserId = await approverUserId(account);
  if (!actorUserId) return [];
  const result = await db().from("hr_roster_plans")
    .select("id,name,location_id,period_start,period_end,status,decision_note,approval_history,revision_no,submitted_at,updated_at,stations!hr_roster_plans_location_id_fkey(station_code,station_name),hr_roster_approval_steps(stage_no,stage_type,status,decision_note,decided_at)")
    .eq("company_id", account.companyId)
    .eq("roster_kind", "recurring_weekly")
    .eq("status", "returned")
    .eq("created_by", actorUserId)
    .order("updated_at", { ascending: false })
    .limit(20);
  if (result.error) throw new Error(result.error.message);
  return (result.data ?? []).map((plan) => {
    const station = one(plan.stations);
    const steps = Array.isArray(plan.hr_roster_approval_steps) ? plan.hr_roster_approval_steps : [];
    const lastNote = plan.decision_note || steps.find((step) => step.decision_note)?.decision_note || "";
    return {
      planId: plan.id,
      name: plan.name,
      stationCode: station?.station_code ?? "—",
      stationName: station?.station_name ?? "",
      revisionNo: plan.revision_no ?? 1,
      periodStart: plan.period_start,
      periodEnd: plan.period_end,
      returnedNote: lastNote,
      approvalHistory: Array.isArray(plan.approval_history) ? plan.approval_history : [],
      updatedAt: plan.updated_at
    };
  });
}

async function archiveConnectRosterApprovalRound(companyId: string, planId: string) {
  const [planResult, stepsResult] = await Promise.all([
    db().from("hr_roster_plans").select("status,decision_note,approval_history").eq("company_id", companyId).eq("id", planId).maybeSingle(),
    db().from("hr_roster_approval_steps").select("stage_no,stage_type,status,decision_note,decided_at,decided_by,approver_user_id").eq("company_id", companyId).eq("plan_id", planId).order("stage_no")
  ]);
  if (planResult.error) throw new Error(planResult.error.message);
  if (stepsResult.error) throw new Error(stepsResult.error.message);
  const priorHistory = Array.isArray(planResult.data?.approval_history) ? planResult.data.approval_history : [];
  const steps = stepsResult.data ?? [];
  if (!steps.length && !planResult.data?.decision_note) return;
  const nextHistory = [...priorHistory, {
    round: priorHistory.length + 1,
    archivedAt: new Date().toISOString(),
    planStatus: planResult.data?.status ?? null,
    decisionNote: planResult.data?.decision_note ?? null,
    steps: steps.map((step) => ({
      stage_no: step.stage_no,
      stage_type: step.stage_type,
      status: step.status,
      decision_note: step.decision_note,
      decided_at: step.decided_at,
      approver_user_id: step.approver_user_id
    }))
  }];
  const saved = await db().from("hr_roster_plans").update({ approval_history: nextHistory }).eq("company_id", companyId).eq("id", planId);
  if (saved.error) throw new Error(saved.error.message);
}

const rosterDays = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;

function rosterDayDate(periodStart: string, dayIndex: number) {
  const date = new Date(`${periodStart}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + dayIndex);
  return date.toISOString().slice(0, 10);
}

export async function loadConnectReturnedRosterEditor(account: ConnectAccount, planIdValue: unknown) {
  const actorUserId = await approverUserId(account);
  if (!actorUserId) throw new Error("A linked People login is required to edit a returned roster.");
  const planId = clean(planIdValue);
  if (!/^[0-9a-f-]{36}$/i.test(planId)) throw new Error("Choose a valid roster.");
  const plan = await db().from("hr_roster_plans")
    .select("id,status,location_id,period_start,period_end,decision_note,approval_history,created_by")
    .eq("company_id", account.companyId)
    .eq("id", planId)
    .maybeSingle();
  if (plan.error || !plan.data) throw new Error(plan.error?.message ?? "Roster not found.");
  if (plan.data.status !== "returned" || plan.data.created_by !== actorUserId) throw new Error("This returned roster is no longer editable.");
  if (!plan.data.location_id) throw new Error("Station is missing on this roster.");
  const [entriesResult, employeesResult, contractorsResult, shiftsResult] = await Promise.all([
    db().from("hr_roster_entries").select("id,worker_type,worker_id,roster_date,day_type,shift_id,hr_shifts(id,code,name)").eq("company_id", account.companyId).eq("plan_id", planId),
    db().from("employees").select("id,employee_code,full_name").eq("company_id", account.companyId).eq("location_id", plan.data.location_id).eq("is_active", true).order("full_name"),
    db().from("contractors").select("id,dropx_id,full_name").eq("company_id", account.companyId).eq("location_id", plan.data.location_id).eq("is_active", true).order("full_name"),
    db().from("hr_shifts").select("id,code,name").eq("company_id", account.companyId).eq("is_active", true).order("code")
  ]);
  const loadError = entriesResult.error ?? employeesResult.error ?? contractorsResult.error ?? shiftsResult.error;
  if (loadError) throw new Error(loadError.message);
  const people = [
    ...(employeesResult.data ?? []).map((row) => ({ workerType: "employee" as const, workerId: row.id, code: row.employee_code ?? "—", name: row.full_name })),
    ...(contractorsResult.data ?? []).map((row) => ({ workerType: "contractor" as const, workerId: row.id, code: row.dropx_id ?? "—", name: row.full_name }))
  ];
  const entryByKey = new Map((entriesResult.data ?? []).map((entry) => [`${entry.worker_type}:${entry.worker_id}:${entry.roster_date}`, entry]));
  const rows = people.map((person) => ({
    workerType: person.workerType,
    workerId: person.workerId,
    code: person.code,
    name: person.name,
    days: rosterDays.map((day, index) => {
      const date = rosterDayDate(plan.data!.period_start, index);
      const entry = entryByKey.get(`${person.workerType}:${person.workerId}:${date}`);
      const shift = one(entry?.hr_shifts);
      return {
        day,
        date,
        dayType: (entry?.day_type ?? "working") as "working" | "weekly_off",
        shiftId: entry?.shift_id ?? "",
        shiftCode: shift?.code ?? ""
      };
    })
  }));
  return {
    planId: plan.data.id,
    periodStart: plan.data.period_start,
    periodEnd: plan.data.period_end,
    decisionNote: plan.data.decision_note ?? "",
    approvalHistory: Array.isArray(plan.data.approval_history) ? plan.data.approval_history : [],
    shifts: (shiftsResult.data ?? []).map((shift) => ({ id: shift.id, code: shift.code, name: shift.name })),
    rows
  };
}

export async function updateConnectReturnedRosterCell(account: ConnectAccount, body: Record<string, unknown>) {
  const actorUserId = await approverUserId(account);
  if (!actorUserId) throw new Error("A linked People login is required to edit a returned roster.");
  const planId = clean(body.planId);
  const workerType = clean(body.workerType);
  const workerId = clean(body.workerId);
  const rosterDate = clean(body.rosterDate);
  const dayType = clean(body.dayType);
  const shiftId = clean(body.shiftId);
  if (!/^[0-9a-f-]{36}$/i.test(planId) || !/^[0-9a-f-]{36}$/i.test(workerId)) throw new Error("Roster cell selection is invalid.");
  if (workerType !== "employee" && workerType !== "contractor") throw new Error("Worker type is invalid.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rosterDate)) throw new Error("Roster date is invalid.");
  if (dayType !== "working" && dayType !== "weekly_off") throw new Error("Day type is invalid.");
  const plan = await db().from("hr_roster_plans").select("id,status,location_id,period_start,period_end,created_by").eq("company_id", account.companyId).eq("id", planId).maybeSingle();
  if (plan.error || !plan.data) throw new Error(plan.error?.message ?? "Roster not found.");
  if (plan.data.status !== "returned" || plan.data.created_by !== actorUserId) throw new Error("This returned roster is no longer editable.");
  if (rosterDate < plan.data.period_start || rosterDate > plan.data.period_end) throw new Error("Date is outside the weekly pattern.");
  const workerTable = workerType === "employee" ? "employees" : "contractors";
  const worker = await db().from(workerTable).select("location_id").eq("company_id", account.companyId).eq("id", workerId).eq("is_active", true).maybeSingle();
  if (worker.error || !worker.data?.location_id || worker.data.location_id !== plan.data.location_id) throw new Error("This person is not active at the roster station.");
  const effectiveShiftId = dayType === "weekly_off" ? null : shiftId || null;
  if (dayType === "working" && !effectiveShiftId) throw new Error("Select a shift or mark weekly off.");
  if (effectiveShiftId) {
    const shift = await db().from("hr_shifts").select("id").eq("company_id", account.companyId).eq("id", effectiveShiftId).eq("is_active", true).maybeSingle();
    if (shift.error || !shift.data) throw new Error("Select an active shift.");
  }
  const saved = await db().from("hr_roster_entries").upsert({
    company_id: account.companyId,
    plan_id: planId,
    worker_type: workerType,
    worker_id: workerId,
    location_id: worker.data.location_id,
    roster_date: rosterDate,
    day_type: dayType,
    shift_id: effectiveShiftId,
    updated_at: new Date().toISOString()
  }, { onConflict: "company_id,plan_id,worker_type,worker_id,roster_date" });
  if (saved.error) throw new Error(saved.error.message);
  await db().from("hr_roster_plans").update({ updated_by: actorUserId, updated_at: new Date().toISOString() }).eq("company_id", account.companyId).eq("id", planId);
  return "Roster cell updated.";
}

export async function resubmitConnectReturnedRoster(account: ConnectAccount, planIdValue: unknown, noteValue: unknown) {
  const actorUserId = await approverUserId(account);
  if (!actorUserId) throw new Error("A linked People login is required to resubmit a roster.");
  const planId = clean(planIdValue);
  if (!/^[0-9a-f-]{36}$/i.test(planId)) throw new Error("Choose a valid roster.");
  const plan = await db().from("hr_roster_plans")
    .select("id,status,location_id,effective_from,created_by")
    .eq("company_id", account.companyId)
    .eq("id", planId)
    .maybeSingle();
  if (plan.error || !plan.data) throw new Error(plan.error?.message ?? "Roster not found.");
  if (plan.data.status !== "returned" || plan.data.created_by !== actorUserId) throw new Error("This returned roster is no longer available for resubmission.");
  const resubmitNote = clean(noteValue);
  if (resubmitNote.length >= 3) {
    await db().from("hr_roster_plans").update({ notes: resubmitNote, updated_by: actorUserId, updated_at: new Date().toISOString() }).eq("company_id", account.companyId).eq("id", planId);
  }
  const count = await db().from("hr_roster_entries").select("id", { count: "exact", head: true }).eq("company_id", account.companyId).eq("plan_id", planId);
  if (count.error) throw new Error(count.error.message);
  if (!count.count) throw new Error("Add roster assignments before resubmitting.");
  await archiveConnectRosterApprovalRound(account.companyId, planId);
  await db().from("hr_roster_approval_steps").delete().eq("company_id", account.companyId).eq("plan_id", planId);
  const archivedPlan = await db().from("hr_roster_plans").select("approval_history").eq("company_id", account.companyId).eq("id", planId).maybeSingle();
  const history = Array.isArray(archivedPlan.data?.approval_history) ? archivedPlan.data.approval_history : [];
  const lastRound = history[history.length - 1] as { steps?: Array<{ stage_no: number; stage_type: string; approver_user_id?: string | null }> } | undefined;
  const policy = await db().from("hr_roster_location_policies").select("approval_required,approval_levels,hr_approval_required").eq("company_id", account.companyId).eq("location_id", plan.data.location_id).maybeSingle();
  const settings = await db().from("hr_company_settings").select("roster_approval_required,roster_approval_levels,roster_hr_approval_required").eq("company_id", account.companyId).maybeSingle();
  const approvalRequired = Boolean(policy.data?.approval_required ?? settings.data?.roster_approval_required ?? true);
  const now = new Date().toISOString();
  if (!approvalRequired) {
    if (plan.data.location_id && plan.data.effective_from) {
      await db().from("hr_roster_plans").update({ superseded_at: plan.data.effective_from }).eq("company_id", account.companyId).eq("location_id", plan.data.location_id).eq("roster_kind", "recurring_weekly").eq("status", "approved").is("superseded_at", null).neq("id", planId);
    }
    const published = await db().from("hr_roster_plans").update({ status: "approved", submitted_at: now, submitted_by: actorUserId, decided_at: now, decision_note: resubmitNote || "Resubmitted from DropX One", updated_by: actorUserId, updated_at: now }).eq("company_id", account.companyId).eq("id", planId).eq("status", "returned");
    if (published.error) throw new Error(published.error.message);
    return "Returned roster published.";
  }
  const templateSteps = lastRound?.steps?.length ? lastRound.steps : [{ stage_no: 1, stage_type: "level_1", approver_user_id: null }];
  const staged = await db().from("hr_roster_approval_steps").insert(templateSteps.map((step, index) => ({
    company_id: account.companyId,
    plan_id: planId,
    stage_no: step.stage_no,
    stage_type: step.stage_type,
    approver_user_id: step.approver_user_id ?? null,
    status: index === 0 ? "pending" : "waiting"
  })));
  if (staged.error) throw new Error(staged.error.message);
  const firstApprover = templateSteps[0]?.approver_user_id ?? null;
  const submitted = await db().from("hr_roster_plans").update({
    status: "pending_approval",
    submitted_at: now,
    submitted_by: actorUserId,
    decided_at: null,
    decision_note: null,
    approver_user_id: firstApprover,
    notes: resubmitNote || null,
    updated_by: actorUserId,
    updated_at: now
  }).eq("company_id", account.companyId).eq("id", planId).eq("status", "returned");
  if (submitted.error) throw new Error(submitted.error.message);
  return "Returned roster sent for approval.";
}
