import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { requireConnectAccount, type ConnectAccount } from "../../../../src/lib/connect-auth";
import { resolveWorkforceLeaveApproval, resolveWorkforceLeaveEntitlements, type LeaveWorkerType } from "../../../../src/lib/connect-leave-data";
import { notifyConnectLeaveSubmitted } from "../../../../src/lib/connect-leave-notifications";
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
const LEAVE_PROOF_BUCKET = "employee-profile-documents";
const LEAVE_PROOF_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);
const LEAVE_PROOF_MAX_BYTES = 10 * 1024 * 1024;

function safeFileName(value: string) { return value.replace(/[^a-zA-Z0-9._-]/g, "_") || "medical-proof"; }
function uploadedFile(value: FormDataEntryValue | undefined): value is File { return value instanceof File && value.size > 0; }

async function requestInput(request: Request) {
  if (request.headers.get("content-type")?.includes("multipart/form-data")) {
    const form = await request.formData();
    return {
      body: Object.fromEntries(Array.from(form.entries()).filter(([key]) => key !== "proof")) as Record<string, unknown>,
      proof: form.get("proof") ?? undefined
    };
  }
  return { body: await request.json() as Record<string, unknown>, proof: undefined };
}

function validateProof(file: FormDataEntryValue | undefined) {
  if (!uploadedFile(file)) return null;
  if (!LEAVE_PROOF_TYPES.has(file.type)) throw new Error("Medical proof must be a PDF, JPG, PNG, or WebP file.");
  if (file.size > LEAVE_PROOF_MAX_BYTES) throw new Error("Medical proof must be 10 MB or smaller.");
  return file;
}

async function uploadProof(account: ConnectAccount, type: LeaveWorkerType, file: File) {
  const path = `${account.companyId}/leave-proof/${type}/${account.id}/${Date.now()}-${randomUUID()}-${safeFileName(file.name)}`;
  const result = await db().storage.from(LEAVE_PROOF_BUCKET).upload(path, Buffer.from(await file.arrayBuffer()), {
    contentType: file.type,
    upsert: false
  });
  if (result.error) throw new Error(result.error.message);
  return { path, fileName: file.name.slice(0, 240), mimeType: file.type, fileSize: file.size };
}

async function removeProof(path: string | null | undefined) {
  if (!path) return;
  await db().storage.from(LEAVE_PROOF_BUCKET).remove([path]);
}

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
  const lopOnly = type === "contractor";
  const year = Number(indiaToday().slice(0, 4));
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const [entitlements, requestResult] = await Promise.all([
    resolveWorkforceLeaveEntitlements({ companyId: account.companyId, workerId: account.id, workerType: type }),
    db().from("hr_leave_requests")
      .select("id,leave_type_id,start_date,end_date,days,reason,status,requested_at,reviewer_note,proof_path,proof_file_name,proof_mime_type,hr_leave_types(name,code,color)")
      .eq("company_id", account.companyId).eq(workerColumn, account.id)
      .order("requested_at", { ascending: false }).limit(50)
  ]);
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
      reviewerNote: request.reviewer_note,
      hasProof: Boolean(request.proof_path),
      proofFileName: request.proof_file_name,
      proofMimeType: request.proof_mime_type,
      proofUrl: request.proof_path
        ? `/api/connect/leave/proof/${request.id}?${new URLSearchParams({ accountId: account.id, profileType: account.profileType })}`
        : null
    };
  });
  const types = entitlements
    .filter((leaveType) => !lopOnly || leaveType.code === "LOP")
    .map((leaveType) => {
    const approved = (requestResult.data ?? []).filter((request) => request.leave_type_id === leaveType.leave_type_id && request.status === "approved")
      .reduce((total, request) => total + overlapDays(request.start_date, request.end_date, yearStart, yearEnd), 0);
    const pending = (requestResult.data ?? []).filter((request) => request.leave_type_id === leaveType.leave_type_id && request.status === "pending")
      .reduce((total, request) => total + overlapDays(request.start_date, request.end_date, yearStart, yearEnd), 0);
    const tracksBalance = leaveType.balance_mode === "annual_balance";
    return {
      id: leaveType.leave_type_id,
      name: leaveType.name,
      code: leaveType.code,
      allowance: tracksBalance ? leaveType.annual_allowance : null,
      color: leaveType.color,
      used: approved,
      pending,
      available: tracksBalance ? Math.max(0, leaveType.annual_allowance - approved) : null,
      isPaid: leaveType.is_paid,
      balanceMode: leaveType.balance_mode
    };
  });
  return {
    year,
    types,
    requests,
    lopOnly,
    summary: {
      available: types.reduce((total, leaveType) => total + (leaveType.available ?? 0), 0),
      pending: requests.filter((request) => request.status === "pending").length
    }
  };
}

async function validateLeaveSubmission({
  account,
  type,
  leaveTypeId,
  fromDate,
  toDate,
  reason,
  excludeRequestId
}: {
  account: ConnectAccount;
  type: LeaveWorkerType;
  leaveTypeId: string;
  fromDate: string;
  toDate: string;
  reason: string;
  excludeRequestId?: string;
}) {
  const today = indiaToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) throw new Error("Select the leave dates.");
  if (fromDate < today) throw new Error("A time-off request cannot start in the past.");
  if (toDate < fromDate) throw new Error("The end date cannot be before the start date.");
  if (fromDate.slice(0, 4) !== toDate.slice(0, 4)) throw new Error("Submit separate requests for each leave year.");
  if (reason.length < 3 || reason.length > 1000) throw new Error("Enter a valid reason between 3 and 1,000 characters.");
  const days = daysBetween(fromDate, toDate);
  const entitlements = await resolveWorkforceLeaveEntitlements({ companyId: account.companyId, workerId: account.id, workerType: type });
  const scopedEntitlements = type === "contractor" ? entitlements.filter((item) => item.code === "LOP") : entitlements;
  const leaveType = scopedEntitlements.find((item) => item.leave_type_id === leaveTypeId);
  if (!leaveType) throw new Error(type === "contractor"
    ? "LOP is not available for your current location and designation."
    : "This leave type is not available for your current location and designation.");
  const workerColumn = type === "employee" ? "employee_id" : "contractor_id";
  let overlapQuery = db().from("hr_leave_requests").select("id").eq("company_id", account.companyId).eq(workerColumn, account.id)
    .in("status", ["pending", "approved"]).lte("start_date", toDate).gte("end_date", fromDate);
  if (excludeRequestId) overlapQuery = overlapQuery.neq("id", excludeRequestId);
  const [overlapResult, balanceResult] = await Promise.all([
    overlapQuery.limit(1),
    db().from("hr_leave_requests").select("id,start_date,end_date,status").eq("company_id", account.companyId).eq(workerColumn, account.id)
      .eq("leave_type_id", leaveTypeId).in("status", ["pending", "approved"])
      .lte("start_date", `${fromDate.slice(0, 4)}-12-31`).gte("end_date", `${fromDate.slice(0, 4)}-01-01`)
  ]);
  if (overlapResult.error || balanceResult.error) throw new Error(overlapResult.error?.message ?? balanceResult.error?.message ?? "Unable to validate leave.");
  if (overlapResult.data?.length) throw new Error("A pending or approved request already overlaps these dates.");
  const committedDays = (balanceResult.data ?? [])
    .filter((item) => item.id !== excludeRequestId)
    .reduce((total, item) => total + overlapDays(item.start_date, item.end_date, `${fromDate.slice(0, 4)}-01-01`, `${fromDate.slice(0, 4)}-12-31`), 0);
  if (leaveType.balance_mode === "annual_balance") {
    const availableDays = Math.max(0, leaveType.annual_allowance - committedDays);
    if (days > availableDays) throw new Error(`Only ${availableDays} ${leaveType.name} day(s) are available.`);
  }
  return { days, leaveType };
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
  let uploadedPath: string | null = null;
  try {
    const { body, proof: proofValue } = await requestInput(request);
    const { account, workerType: type } = await accountFromRequest(new URL(request.url), body);
    const leaveTypeId = clean(body.leaveTypeId);
    const fromDate = clean(body.fromDate);
    const toDate = clean(body.toDate);
    const reason = clean(body.reason);
    const { days, leaveType } = await validateLeaveSubmission({ account, type, leaveTypeId, fromDate, toDate, reason });
    const proofFile = validateProof(proofValue);
    if (proofFile && leaveType.code.toUpperCase() !== "SICK") throw new Error("Medical proof can be attached only to sick leave.");
    if (leaveType.code.toUpperCase() === "SICK" && days > 1 && !proofFile) {
      throw new Error("Medical proof is mandatory for sick leave longer than one day.");
    }
    const proof = proofFile ? await uploadProof(account, type, proofFile) : null;
    uploadedPath = proof?.path ?? null;

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
        reviewer_note: "Recorded directly for a top-level assignment in DropX One.",
        proof_path: proof?.path ?? null,
        proof_file_name: proof?.fileName ?? null,
        proof_mime_type: proof?.mimeType ?? null,
        proof_file_size: proof?.fileSize ?? null,
        proof_uploaded_at: proof ? new Date().toISOString() : null
      }).select("id").single();
      if (directResult.error) throw new Error(directResult.error.message);
      requestId = directResult.data.id;
    } else {
      const createResult = await db().rpc("hr_create_workforce_leave_request_with_proof", {
        p_company_id: account.companyId,
        p_worker_type: type,
        p_profile_id: account.id,
        p_leave_type_id: leaveTypeId,
        p_start_date: fromDate,
        p_end_date: toDate,
        p_reason: reason,
        p_proof_path: proof?.path ?? null,
        p_proof_file_name: proof?.fileName ?? null,
        p_proof_mime_type: proof?.mimeType ?? null,
        p_proof_file_size: proof?.fileSize ?? null,
        p_steps: approval.steps
      });
      if (createResult.error) throw new Error(createResult.error.message);
      requestId = String(createResult.data ?? "");
    }
    let notification: Awaited<ReturnType<typeof notifyConnectLeaveSubmitted>> | null = null;
    if (!approval.direct) {
      try { notification = await notifyConnectLeaveSubmitted({ companyId: account.companyId, requestId }); }
      catch (error) { notification = { status: "failed", error: error instanceof Error ? error.message : "Email delivery failed." }; }
    }
    return NextResponse.json({
      ok: true,
      requestId,
      notice: approval.direct
        ? "Time off recorded. No approval is required for this top-level assignment."
        : `${`Request submitted through ${approval.policyName}.`}${notification?.status === "sent" ? " Your manager was notified by email." : notification?.error ? ` Email warning: ${notification.error}` : ""}`
    });
  } catch (error) {
    await removeProof(uploadedPath);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to submit time off." }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  let uploadedPath: string | null = null;
  try {
    const { body, proof: proofValue } = await requestInput(request);
    const { account, workerType: type } = await accountFromRequest(new URL(request.url), body);
    const requestId = clean(body.requestId);
    const leaveTypeId = clean(body.leaveTypeId);
    const fromDate = clean(body.fromDate);
    const toDate = clean(body.toDate);
    const reason = clean(body.reason);
    if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw new Error("Leave request is invalid.");
    const workerColumn = type === "employee" ? "employee_id" : "contractor_id";
    const existing = await db().from("hr_leave_requests")
      .select("proof_path,proof_file_name,proof_mime_type,proof_file_size")
      .eq("company_id", account.companyId).eq("id", requestId).eq(workerColumn, account.id).eq("status", "pending").maybeSingle();
    if (existing.error || !existing.data) throw new Error(existing.error?.message ?? "Leave request was not found or can no longer be edited.");
    const { days, leaveType } = await validateLeaveSubmission({ account, type, leaveTypeId, fromDate, toDate, reason, excludeRequestId: requestId });
    const proofFile = validateProof(proofValue);
    if (proofFile && leaveType.code.toUpperCase() !== "SICK") throw new Error("Medical proof can be attached only to sick leave.");
    if (leaveType.code.toUpperCase() === "SICK" && days > 1 && !proofFile && !existing.data.proof_path) {
      throw new Error("Medical proof is mandatory for sick leave longer than one day.");
    }
    const proof = proofFile ? await uploadProof(account, type, proofFile) : null;
    uploadedPath = proof?.path ?? null;
    const result = await db().rpc("hr_update_workforce_leave_request_with_proof", {
      p_company_id: account.companyId,
      p_request_id: requestId,
      p_worker_type: type,
      p_profile_id: account.id,
      p_leave_type_id: leaveTypeId,
      p_start_date: fromDate,
      p_end_date: toDate,
      p_reason: reason,
      p_proof_path: proof?.path ?? existing.data.proof_path,
      p_proof_file_name: proof?.fileName ?? existing.data.proof_file_name,
      p_proof_mime_type: proof?.mimeType ?? existing.data.proof_mime_type,
      p_proof_file_size: proof?.fileSize ?? existing.data.proof_file_size
    });
    if (result.error) throw new Error(result.error.message);
    if (proof && existing.data.proof_path && existing.data.proof_path !== proof.path) await removeProof(existing.data.proof_path);
    if (leaveType.code.toUpperCase() !== "SICK" && existing.data.proof_path) await removeProof(existing.data.proof_path);
    return NextResponse.json({ ok: true, notice: "Time-off request updated." });
  } catch (error) {
    await removeProof(uploadedPath);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to update time off." }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const { account, workerType: type } = await accountFromRequest(new URL(request.url), body);
    const requestId = clean(body.requestId);
    if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw new Error("Leave request is invalid.");
    const result = await db().rpc("hr_cancel_workforce_leave_request", {
      p_company_id: account.companyId,
      p_request_id: requestId,
      p_worker_type: type,
      p_profile_id: account.id
    });
    if (result.error) throw new Error(result.error.message);
    return NextResponse.json({ ok: true, notice: "Time-off request withdrawn." });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to withdraw time off." }, { status: 400 });
  }
}
