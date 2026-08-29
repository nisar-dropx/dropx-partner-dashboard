import "server-only";

import type { ConnectAccount } from "./connect-auth";
import { connectApproverIdentity } from "./connect-expense-data";
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

function one<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

async function approverUserId(account: ConnectAccount) {
  if (account.profileType === "user") return account.id;
  return (await connectApproverIdentity(account))?.userId ?? null;
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

export async function listConnectAttendanceApprovals(account: ConnectAccount) {
  const actorUserId = await approverUserId(account);
  if (!actorUserId) return [];
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
  const requestById = new Map((requestsResult.data ?? []).map((request) => [request.id, request]));
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

export async function listConnectAttendanceHrApprovals(account: ConnectAccount) {
  const actorUserId = await approverUserId(account);
  if (!actorUserId) return [];
  if (!(await canConnectFinalizeAttendance(account.companyId, actorUserId))) return [];
  const requestsResult = await db().from("attendance_regularization_requests")
    .select("id,profile_type,profile_id,dropx_id,full_name,attendance_date,current_in_time,current_out_time,requested_in_time,requested_out_time,reason_code,remarks,attachment_path,status,created_at")
    .eq("company_id", account.companyId).is("request_kind", null)
    .in("status", ["pending_hr", "pending"])
    .order("created_at");
  if (requestsResult.error) throw new Error(requestsResult.error.message);
  const rows = (requestsResult.data ?? []) as Array<{
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
  }>;
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
  if (result.data === "approved") return "Attendance regularization approved.";
  if (result.data === "pending_manager") return "Attendance step approved and routed to the next manager.";
  if (result.data === "pending_hr") return "Manager approvals complete. People will perform final attendance validation.";
  return "Attendance regularization rejected.";
}

async function canApproveUnassignedRosterHr(account: ConnectAccount) {
  if (/owner/i.test(account.role ?? "")) return true;
  const identity = await connectApproverIdentity(account);
  const designationId = identity?.assignment?.designation_id;
  if (!designationId) return false;
  const result = await db().from("hr_roster_designation_rules").select("can_approve_hr")
    .eq("company_id", account.companyId).eq("designation_id", designationId).maybeSingle();
  if (result.error) throw new Error(result.error.message);
  return Boolean(result.data?.can_approve_hr);
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
