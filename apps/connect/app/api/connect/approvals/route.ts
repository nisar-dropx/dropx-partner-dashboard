import { NextResponse } from "next/server";
import { requireConnectAccount, type ConnectAccount } from "../../../../src/lib/connect-auth";
import { expenseIdentity } from "../../../../src/lib/connect-expense-data";
import { supabaseAdmin } from "../../../../src/lib/supabase-admin";

function db() { if (!supabaseAdmin) throw new Error("Database configuration is unavailable."); return supabaseAdmin; }
function clean(value: unknown) { return String(value ?? "").trim(); }
function relation<T>(value: T | T[] | null | undefined): T | null { return Array.isArray(value) ? value[0] ?? null : value ?? null; }

async function selectedAccount(request: Request, body?: Record<string, unknown>) {
  const url = new URL(request.url);
  const accountId = clean(body?.accountId ?? url.searchParams.get("accountId"));
  const profileType = clean(body?.profileType ?? url.searchParams.get("profileType"));
  if (!accountId || !profileType) throw new Error("Account is required.");
  if (profileType !== "employee" && profileType !== "contractor") throw new Error("Approvals are available for workforce accounts.");
  return requireConnectAccount(profileType as ConnectAccount["profileType"], accountId);
}

async function listLeaveApprovals(account: ConnectAccount) {
  const identity = await expenseIdentity(account);
  if (!identity.userId) return [];
  const stepResult = await db().from("hr_leave_approval_steps")
    .select("id,request_id,step_order,step_name,status")
    .eq("company_id", account.companyId)
    .eq("approver_user_id", identity.userId)
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
      profileType: request.contractor_id ? "contractor" : "employee"
    }];
  });
}

export async function GET(request: Request) {
  try {
    const account = await selectedAccount(request);
    const leaveApprovals = await listLeaveApprovals(account);
    return NextResponse.json({ leaveApprovals }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load approvals." }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const account = await selectedAccount(request, body);
    const identity = await expenseIdentity(account);
    if (!identity.userId) throw new Error("A linked People login is required to approve time off.");
    const requestId = clean(body.requestId);
    const decision = clean(body.decision);
    const note = clean(body.note);
    if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw new Error("Leave request is invalid.");
    if (decision !== "approved" && decision !== "rejected") throw new Error("Choose Approve or Reject.");
    const result = await db().rpc("hr_decide_leave_step", {
      p_company_id: account.companyId,
      p_request_id: requestId,
      p_actor_user_id: identity.userId,
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
