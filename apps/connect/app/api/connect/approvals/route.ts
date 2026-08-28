import { NextResponse } from "next/server";
import { requireConnectAccount, type ConnectAccount } from "../../../../src/lib/connect-auth";
import { connectApproverIdentity } from "../../../../src/lib/connect-expense-data";
import { firstPendingConnectLeaveStep, notifyConnectLeaveWorkflow } from "../../../../src/lib/connect-leave-notifications";
import { listConnectLocationSupportPackages, reviewConnectLocationSupportPackage } from "../../../../src/lib/connect-location-integrity";
import {
  decideConnectAttendanceApproval,
  decideConnectExitApproval,
  decideConnectRosterApproval,
  listConnectAttendanceApprovals,
  listConnectExitApprovals,
  listConnectRosterApprovals
} from "../../../../src/lib/connect-manager-approvals";
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

async function listLeaveApprovals(account: ConnectAccount) {
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
    .select("id,employee_id,contractor_id,start_date,end_date,days,reason,status,proof_path,hr_leave_types(name,code),employees(full_name,employee_code),contractors(full_name,dropx_id)")
    .eq("company_id", account.companyId)
    .eq("status", "pending")
    .in("id", steps.map((step) => step.request_id));
  if (requestResult.error) throw new Error(requestResult.error.message);
  const stepByRequest = new Map(steps.map((step) => [step.request_id, step]));
  return Promise.all((requestResult.data ?? []).flatMap((request) => {
    const step = stepByRequest.get(request.id);
    if (!step) return [];
    const employee = relation(request.employees);
    const contractor = relation(request.contractors);
    const leaveType = relation(request.hr_leave_types);
    return [{ request, step, employee, contractor, leaveType }];
  }).map(async ({ request, step, employee, contractor, leaveType }) => {
    const proofResult = request.proof_path
      ? await db().storage.from("employee-profile-documents").createSignedUrl(request.proof_path, 60 * 15)
      : null;
    return {
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
      profileType: request.contractor_id ? "contractor" : "employee",
      proofUrl: proofResult?.data?.signedUrl ?? null,
      proofRequired: String(leaveType?.code ?? "").toUpperCase() === "SICK" && Number(request.days) > 1
    };
  }));
}

export async function GET(request: Request) {
  try {
    const account = await selectedAccount(request);
    const [leaveApprovals, locationSupportPackages, attendanceApprovals, rosterApprovals, exitApprovals] = await Promise.all([
      listLeaveApprovals(account),
      listConnectLocationSupportPackages(account),
      listConnectAttendanceApprovals(account),
      listConnectRosterApprovals(account),
      listConnectExitApprovals(account)
    ]);
    return NextResponse.json({ leaveApprovals, locationSupportPackages, attendanceApprovals, rosterApprovals, exitApprovals }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load approvals." }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const account = await selectedAccount(request, body);
    const actionType = clean(body.actionType);
    if (actionType === "attendance") {
      const notice = await decideConnectAttendanceApproval(account, body.requestId, body.decision, body.note);
      return NextResponse.json({ ok: true, notice });
    }
    if (actionType === "rostering") {
      const notice = await decideConnectRosterApproval(account, body.planId, body.stepId, body.decision, body.note);
      return NextResponse.json({ ok: true, notice });
    }
    if (actionType === "exit") {
      const notice = await decideConnectExitApproval(account, body.approvalId, body.decision, body.note);
      return NextResponse.json({ ok: true, notice });
    }
    const reviewId = clean(body.reviewId);
    if (reviewId) {
      const decision = clean(body.decision);
      const note = clean(body.note);
      const notice = await reviewConnectLocationSupportPackage(account, reviewId, decision, note);
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
    const requestResult = await db().from("hr_leave_requests").select("days,proof_path,hr_leave_types(code)").eq("company_id", account.companyId).eq("id", requestId).maybeSingle();
    if (requestResult.error || !requestResult.data) throw new Error(requestResult.error?.message ?? "Leave request was not found.");
    const leaveType = relation(requestResult.data.hr_leave_types);
    if (decision === "approved" && String(leaveType?.code ?? "").toUpperCase() === "SICK" && Number(requestResult.data.days) > 1) {
      if (!requestResult.data.proof_path) throw new Error("Approval blocked. Medical proof is mandatory for sick leave longer than one day.");
      const proof = await db().storage.from("employee-profile-documents").createSignedUrl(requestResult.data.proof_path, 60);
      if (proof.error || !proof.data?.signedUrl) throw new Error("Approval blocked. Medical proof is unavailable.");
    }
    const currentStepId = await firstPendingConnectLeaveStep(account.companyId, requestId);
    const result = await db().rpc("hr_decide_leave_step", {
      p_company_id: account.companyId,
      p_request_id: requestId,
      p_actor_user_id: approverUserId,
      p_decision: decision,
      p_note: note
    });
    if (result.error) throw new Error(result.error.message);
    const notifications: Array<{ status: "sent" | "failed" | "skipped"; error?: string | null }> = [];
    try {
      if (result.data === "pending") {
        notifications.push(await notifyConnectLeaveWorkflow({ companyId: account.companyId, requestId, event: "STEP_APPROVED", approvalStepId: currentStepId }));
        const nextStepId = await firstPendingConnectLeaveStep(account.companyId, requestId);
        if (nextStepId) notifications.push(await notifyConnectLeaveWorkflow({ companyId: account.companyId, requestId, event: "APPROVAL_REQUIRED", approvalStepId: nextStepId }));
      } else {
        notifications.push(await notifyConnectLeaveWorkflow({ companyId: account.companyId, requestId, event: result.data === "approved" ? "REQUEST_APPROVED" : "REQUEST_REJECTED", approvalStepId: currentStepId }));
      }
    } catch (notificationError) {
      notifications.push({ status: "failed", error: notificationError instanceof Error ? notificationError.message : "Email delivery failed." });
    }
    const mailWarning = notifications.find((item) => item.status === "failed" || (item.status === "skipped" && item.error));
    return NextResponse.json({
      ok: true,
      notice: `${result.data === "approved"
        ? "Time-off request approved."
        : result.data === "rejected"
          ? "Time-off request rejected."
          : "Approved and routed to the next approver."}${mailWarning ? ` Email warning: ${mailWarning.error}` : " Email notification sent."}`
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to update time-off approval." }, { status: 400 });
  }
}
