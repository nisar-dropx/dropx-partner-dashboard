import { NextResponse } from "next/server";
import { requireConnectAccount, type ConnectAccount } from "../../../../src/lib/connect-auth";
import { connectApproverIdentity } from "../../../../src/lib/connect-expense-data";
import { listConnectAttendanceApprovals, listConnectAttendanceHrApprovals, decideConnectAttendanceApproval, decideConnectAttendanceHrApproval, listConnectRosterApprovals, decideConnectRosterApproval, listConnectRosterSwapApprovals, decideConnectRosterSwapApproval, listConnectReturnedRosters, resubmitConnectReturnedRoster } from "../../../../src/lib/connect-manager-approvals";
import { listConnectLocationSupportPackages, reviewConnectLocationSupportPackage } from "../../../../src/lib/connect-location-integrity";
import { connectReporteeMatches, loadConnectReporteeAccess, normalizeConnectReporteeScope, type ConnectReporteeAccess } from "../../../../src/lib/connect-reportee-scope";
import { supabaseAdmin } from "../../../../src/lib/supabase-admin";

function db() { if (!supabaseAdmin) throw new Error("Database configuration is unavailable."); return supabaseAdmin; }
function clean(value: unknown) { return String(value ?? "").trim(); }
function relation<T>(value: T | T[] | null | undefined): T | null { return Array.isArray(value) ? value[0] ?? null : value ?? null; }

async function selectedAccount(request: Request, body?: Record<string, unknown>) {
  const url = new URL(request.url);
  const accountId = clean(body?.accountId ?? url.searchParams.get("accountId"));
  const profileType = clean(body?.profileType ?? url.searchParams.get("profileType"));
  if (!accountId || !profileType) throw new Error("Account is required.");
  if (profileType !== "user" && profileType !== "employee" && profileType !== "contractor") throw new Error("Approvals are not available for this account.");
  return requireConnectAccount(profileType as ConnectAccount["profileType"], accountId);
}

async function listLeaveApprovals(account: ConnectAccount, reportees: ConnectReporteeAccess) {
  const identity = account.profileType === "user" ? null : await connectApproverIdentity(account);
  const approverUserId = account.profileType === "user" ? account.id : identity?.userId;
  if (!approverUserId) return [];
  const stepResult = await db().from("hr_leave_approval_steps")
    .select("id,request_id,step_order,step_name,status")
    .eq("company_id", account.companyId)
    .eq("approver_user_id", approverUserId)
    .eq("status", "pending")
    .order("created_at");
  if (stepResult.error) throw new Error(stepResult.error.message);
  const steps = stepResult.data ?? [];
  if (!steps.length) return [];
  const requestResult = await db().from("hr_leave_requests")
    .select("id,employee_id,contractor_id,start_date,end_date,days,reason,status,hr_leave_types(name,code),employees(full_name,employee_code),contractors(full_name,dropx_id)")
    .eq("company_id", account.companyId)
    .eq("status", "pending")
    .in("id", steps.map((step) => step.request_id));
  if (requestResult.error) throw new Error(requestResult.error.message);
  const stepByRequest = new Map(steps.map((step) => [step.request_id, step]));
  return (requestResult.data ?? []).flatMap((request) => {
    const profileType = request.contractor_id ? "contractor" : "employee";
    const profileId = request.contractor_id ?? request.employee_id;
    if (!connectReporteeMatches(reportees, profileType, profileId)) return [];
    const step = stepByRequest.get(request.id);
    if (!step) return [];
    const employee = relation(request.employees);
    const contractor = relation(request.contractors);
    const leaveType = relation(request.hr_leave_types);
    return [{
      id: step.id,
      requestId: request.id,
      stepName: step.step_name,
      stepOrder: step.step_order,
      leaveType: leaveType?.name ?? "Time off",
      startDate: request.start_date,
      endDate: request.end_date,
      days: request.days,
      reason: request.reason,
      requesterName: employee?.full_name ?? contractor?.full_name ?? "Team member",
      requesterCode: employee?.employee_code ?? contractor?.dropx_id ?? "",
      profileType
    }];
  });
}

export async function GET(request: Request) {
  try {
    const account = await selectedAccount(request);
    const scope = normalizeConnectReporteeScope(new URL(request.url).searchParams.get("reporteeScope"));
    const reportees = await loadConnectReporteeAccess(account, scope);
    const [leaveApprovals, locationSupportPackages, attendanceApprovals, attendanceHrApprovals, rosterApprovals, rosterSwapApprovals, returnedRosters] = await Promise.all([
      listLeaveApprovals(account, reportees),
      listConnectLocationSupportPackages(account, reportees),
      listConnectAttendanceApprovals(account, reportees),
      listConnectAttendanceHrApprovals(account, reportees),
      listConnectRosterApprovals(account),
      listConnectRosterSwapApprovals(account),
      listConnectReturnedRosters(account)
    ]);
    return NextResponse.json({ scope, leaveApprovals, locationSupportPackages, attendanceApprovals, attendanceHrApprovals, rosterApprovals, rosterSwapApprovals, returnedRosters }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load approvals." }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const account = await selectedAccount(request, body);
    const reviewId = clean(body.reviewId);
    if (reviewId) {
      const decision = clean(body.decision);
      const note = clean(body.note);
      const scope = normalizeConnectReporteeScope(body.reporteeScope);
      const notice = await reviewConnectLocationSupportPackage(account, reviewId, decision, note, scope);
      return NextResponse.json({ ok: true, notice });
    }
    const attendanceRequestId = clean(body.attendanceRequestId);
    if (attendanceRequestId) {
      const decision = clean(body.decision);
      const note = clean(body.note);
      const queue = clean(body.attendanceQueue);
      const notice = queue === "hr"
        ? await decideConnectAttendanceHrApproval(account, attendanceRequestId, decision, note)
        : await decideConnectAttendanceApproval(account, attendanceRequestId, decision, note);
      return NextResponse.json({ ok: true, notice });
    }
    const resubmitRosterPlanId = clean(body.resubmitRosterPlanId);
    if (resubmitRosterPlanId) {
      const notice = await resubmitConnectReturnedRoster(account, resubmitRosterPlanId, body.note);
      return NextResponse.json({ ok: true, notice });
    }
    const rosterPlanId = clean(body.rosterPlanId);
    if (rosterPlanId) {
      const decision = clean(body.decision);
      const note = clean(body.note);
      const notice = await decideConnectRosterApproval(account, rosterPlanId, body.rosterStepId ?? null, decision, note);
      return NextResponse.json({ ok: true, notice });
    }
    const rosterSwapRequestId = clean(body.rosterSwapRequestId);
    if (rosterSwapRequestId) {
      const decision = clean(body.decision);
      const note = clean(body.note);
      const notice = await decideConnectRosterSwapApproval(account, rosterSwapRequestId, decision, note);
      return NextResponse.json({ ok: true, notice });
    }
    const identity = account.profileType === "user" ? null : await connectApproverIdentity(account);
    const approverUserId = account.profileType === "user" ? account.id : identity?.userId;
    if (!approverUserId) throw new Error("A linked People login is required to approve time off.");
    const requestId = clean(body.requestId);
    const decision = clean(body.decision);
    const note = clean(body.note);
    if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw new Error("Leave request is invalid.");
    if (decision !== "approved" && decision !== "rejected") throw new Error("Choose Approve or Reject.");
    const result = await db().rpc("hr_decide_leave_step", {
      p_company_id: account.companyId,
      p_request_id: requestId,
      p_actor_user_id: approverUserId,
      p_decision: decision,
      p_note: note
    });
    if (result.error) throw new Error(result.error.message);
    return NextResponse.json({
      ok: true,
      notice: result.data === "approved"
        ? "Time-off request approved."
        : result.data === "rejected"
          ? "Time-off request rejected."
          : "Approved and routed to the next approver."
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to update time-off approval." }, { status: 400 });
  }
}
