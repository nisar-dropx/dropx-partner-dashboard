import { NextResponse } from "next/server";
import { requireConnectAccount, type ConnectAccount } from "../../../../src/lib/connect-auth";
import { resolveWorkforceLeaveApproval, type LeaveWorkerType } from "../../../../src/lib/connect-leave-data";
import { supabaseAdmin } from "../../../../src/lib/supabase-admin";

function db() { if (!supabaseAdmin) throw new Error("Database configuration is unavailable."); return supabaseAdmin; }
function clean(value: unknown) { return String(value ?? "").trim(); }
function workerType(profileType: string): LeaveWorkerType | null { return profileType === "employee" || profileType === "contractor" ? profileType : null; }
function indiaToday() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
function daysBetween(fromDate: string, toDate: string) { return Math.floor((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000) + 1; }
function overlapDays(startDate: string, endDate: string, rangeStart: string, rangeEnd: string) {
  const start = startDate > rangeStart ? startDate : rangeStart;
  const end = endDate < rangeEnd ? endDate : rangeEnd;
  return start <= end ? daysBetween(start, end) : 0;
}
function relation<T>(value: T | T[] | null | undefined): T | null { return Array.isArray(value) ? value[0] ?? null : value ?? null; }

async function accountFromRequest(url: URL, body?: Record<string, unknown>) {
  const accountId = clean(body?.accountId ?? url.searchParams.get("accountId"));
  const profileType = clean(body?.profileType ?? url.searchParams.get("profileType"));
  if (!accountId || !profileType) throw new Error("Account is required.");
  const supportedType = workerType(profileType);
  if (!supportedType) throw new Error("Time off is currently available for employees and independent contractors.");
  const account = await requireConnectAccount(profileType as ConnectAccount["profileType"], accountId);
  return { account, workerType: supportedType };
}

async function leavePayload(account: ConnectAccount, type: LeaveWorkerType) {
  const workerColumn = type === "employee" ? "employee_id" : "contractor_id";
  const year = Number(indiaToday().slice(0, 4));
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const [typeResult, requestResult] = await Promise.all([
    db().from("hr_leave_types").select("id,name,code,annual_allowance,color")
      .eq("company_id", account.companyId).eq("is_active", true).order("name"),
    db().from("hr_leave_requests")
      .select("id,leave_type_id,start_date,end_date,days,reason,status,requested_at,reviewer_note,hr_leave_types(name,code,color)")
      .eq("company_id", account.companyId).eq(workerColumn, account.id)
      .order("requested_at", { ascending: false }).limit(50)
  ]);
  if (typeResult.error) throw new Error(typeResult.error.message);
  if (requestResult.error) throw new Error(requestResult.error.message);
  const requests = (requestResult.data ?? []).map((request) => {
    const leaveType = relation(request.hr_leave_types);
    return {
      id: request.id,
      leaveType: leaveType?.name ?? "Time off",
      leaveTypeCode: leaveType?.code ?? "",
      color: leaveType?.color ?? "#6b7280",
      fromDate: request.start_date,
      toDate: request.end_date,
      days: request.days,
      reason: request.reason,
      status: request.status,
      requestedAt: request.requested_at,
      reviewerNote: request.reviewer_note
    };
  });
  const types = (typeResult.data ?? []).map((leaveType) => {
    const approved = (requestResult.data ?? []).filter((request) => request.leave_type_id === leaveType.id && request.status === "approved")
      .reduce((total, request) => total + overlapDays(request.start_date, request.end_date, yearStart, yearEnd), 0);
    const pending = (requestResult.data ?? []).filter((request) => request.leave_type_id === leaveType.id && request.status === "pending")
      .reduce((total, request) => total + overlapDays(request.start_date, request.end_date, yearStart, yearEnd), 0);
    return { id: leaveType.id, name: leaveType.name, code: leaveType.code, allowance: leaveType.annual_allowance, color: leaveType.color, used: approved, pending, available: Math.max(0, leaveType.annual_allowance - approved) };
  });
  return { year, types, requests, summary: { available: types.reduce((total, leaveType) => total + leaveType.available, 0), pending: requests.filter((request) => request.status === "pending").length } };
}

export async function GET(request: Request) {
  try {
    const { account, workerType: type } = await accountFromRequest(new URL(request.url));
    return NextResponse.json(await leavePayload(account, type), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load time off." }, { status: 400 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const { account, workerType: type } = await accountFromRequest(new URL(request.url), body);
    const leaveTypeId = clean(body.leaveTypeId);
    const fromDate = clean(body.fromDate);
    const toDate = clean(body.toDate);
    const reason = clean(body.reason);
    const today = indiaToday();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) throw new Error("Select the leave dates.");
    if (fromDate < today) throw new Error("A time-off request cannot start in the past.");
    if (toDate < fromDate) throw new Error("The end date cannot be before the start date.");
    if (fromDate.slice(0, 4) !== toDate.slice(0, 4)) throw new Error("Submit separate requests for each leave year.");
    if (reason.length < 3 || reason.length > 1000) throw new Error("Enter a valid reason between 3 and 1,000 characters.");
    const days = daysBetween(fromDate, toDate);
    const leaveTypeResult = await db().from("hr_leave_types").select("id,name,annual_allowance")
      .eq("company_id", account.companyId).eq("id", leaveTypeId).eq("is_active", true).maybeSingle();
    if (leaveTypeResult.error) throw new Error(leaveTypeResult.error.message);
    if (!leaveTypeResult.data) throw new Error("Select an active leave type.");
    const workerColumn = type === "employee" ? "employee_id" : "contractor_id";
    const [overlapResult, balanceResult] = await Promise.all([
      db().from("hr_leave_requests").select("id").eq("company_id", account.companyId).eq(workerColumn, account.id)
        .in("status", ["pending", "approved"]).lte("start_date", toDate).gte("end_date", fromDate).limit(1),
      db().from("hr_leave_requests").select("start_date,end_date,status").eq("company_id", account.companyId).eq(workerColumn, account.id)
        .eq("leave_type_id", leaveTypeId).in("status", ["pending", "approved"])
        .lte("start_date", `${fromDate.slice(0, 4)}-12-31`).gte("end_date", `${fromDate.slice(0, 4)}-01-01`)
    ]);
    if (overlapResult.error || balanceResult.error) throw new Error(overlapResult.error?.message ?? balanceResult.error?.message ?? "Unable to validate leave.");
    if (overlapResult.data?.length) throw new Error("A pending or approved request already overlaps these dates.");
    const committedDays = (balanceResult.data ?? []).reduce((total, item) => total + overlapDays(item.start_date, item.end_date, `${fromDate.slice(0, 4)}-01-01`, `${fromDate.slice(0, 4)}-12-31`), 0);
    const availableDays = Math.max(0, leaveTypeResult.data.annual_allowance - committedDays);
    if (days > availableDays) throw new Error(`Only ${availableDays} ${leaveTypeResult.data.name} day(s) are available.`);

    const approval = await resolveWorkforceLeaveApproval({ companyId: account.companyId, workerId: account.id, workerType: type, days });
    let requestId = "";
    if (approval.direct) {
      if (!approval.requesterUserId) throw new Error("A linked People login is required to record top-level time off.");
      const directResult = await db().from("hr_leave_requests").insert({
        company_id: account.companyId,
        employee_id: type === "employee" ? account.id : null,
        contractor_id: type === "contractor" ? account.id : null,
        leave_type_id: leaveTypeId,
        start_date: fromDate,
        end_date: toDate,
        reason,
        status: "approved",
        requested_by: approval.requesterUserId,
        requested_profile_type: type,
        requested_profile_id: account.id,
        reviewed_by: approval.requesterUserId,
        reviewed_at: new Date().toISOString(),
        reviewer_note: "Recorded directly for a top-level assignment in DropX One."
      }).select("id").single();
      if (directResult.error) throw new Error(directResult.error.message);
      requestId = directResult.data.id;
    } else {
      const createResult = await db().rpc("hr_create_workforce_leave_request_with_steps", {
        p_company_id: account.companyId,
        p_worker_type: type,
        p_profile_id: account.id,
        p_leave_type_id: leaveTypeId,
        p_start_date: fromDate,
        p_end_date: toDate,
        p_reason: reason,
        p_steps: approval.steps
      });
      if (createResult.error) throw new Error(createResult.error.message);
      requestId = String(createResult.data ?? "");
    }
    return NextResponse.json({
      ok: true,
      requestId,
      notice: approval.direct ? "Time off recorded. No approval is required for this top-level assignment." : `Request submitted through ${approval.policyName}.`
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to submit time off." }, { status: 400 });
  }
}
