import { createHash } from "crypto";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { connectSessionCookieName, normalizeConnectMobile } from "@/lib/connect-auth";
import { loadAttendanceReportRows } from "@/lib/biometric/attendance";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { createAppNotification } from "@/lib/app-notifications";
import { isWorkforceProfileType, type WorkforceProfileType, workforceTable } from "@/lib/workforce-profiles";

function monthRange(month: string | null) {
  const today = new Date();
  const match = month?.match(/^(\d{4})-(\d{2})$/);
  const year = match ? Number(match[1]) : today.getUTCFullYear();
  const monthIndex = match ? Number(match[2]) - 1 : today.getUTCMonth();
  if (!Number.isInteger(year) || !Number.isInteger(monthIndex) || monthIndex < 0 || monthIndex > 11) {
    throw new Error("Month must be in YYYY-MM format.");
  }
  const start = new Date(Date.UTC(year, monthIndex, 1));
  const end = new Date(Date.UTC(year, monthIndex + 1, 0));
  return {
    label: `${year}-${String(monthIndex + 1).padStart(2, "0")}`,
    fromDate: start.toISOString().slice(0, 10),
    toDate: end.toISOString().slice(0, 10)
  };
}

function cleanEnrolmentId(value: unknown) {
  const digits = String(value ?? "").trim().replace(/\D/g, "");
  if (!digits) return "";
  return digits.replace(/^0+/, "") || "0";
}

function isMissingRegularizationTable(message: unknown) {
  const text = String(message ?? "").toLowerCase();
  return text.includes("attendance_regularization_requests") &&
    (text.includes("does not exist") || text.includes("schema cache"));
}

function validTime(value: string) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function fileExtension(name: string) {
  const match = name.toLowerCase().match(/\.[a-z0-9]{1,8}$/);
  return match?.[0] ?? "";
}

async function activeSession() {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const token = cookies().get(connectSessionCookieName)?.value;
  if (!token) throw new Error("Login required.");
  const sessionHash = createHash("sha256").update(token).digest("hex");
  const sessionResult = await supabaseAdmin
    .from("connect_login_sessions")
    .select("id, country_code, mobile_number, expires_at, revoked_at")
    .eq("session_hash", sessionHash)
    .maybeSingle();
  if (sessionResult.error) throw new Error(sessionResult.error.message);
  const session = sessionResult.data;
  if (!session || session.revoked_at || new Date(session.expires_at).getTime() < Date.now()) {
    throw new Error("Login expired.");
  }
  return session;
}

async function resolveWorker({
  accountId,
  profileType
}: {
  accountId: string;
  profileType: string;
}) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const session = await activeSession();
  const { countryCode, mobile, localMobile } = normalizeConnectMobile(session.mobile_number, session.country_code);
  if (isWorkforceProfileType(profileType)) {
    const resolvedProfileType = profileType as WorkforceProfileType;
    const table = workforceTable(resolvedProfileType);
    const idColumn = resolvedProfileType === "employee" ? "employee_code" : "dropx_id";
    const result = await supabaseAdmin
      .from(table)
      .select(`id, company_id, mobile, mobile_country_code, biometric_id, full_name, ${idColumn}`)
      .eq("id", accountId)
      .maybeSingle();
    if (result.error) throw new Error(result.error.message);
    const row = result.data;
    if (!row) throw new Error("Workforce account not found.");
    const rowMobile = String(row.mobile ?? "").replace(/\D/g, "");
    const rowCountryCode = String(row.mobile_country_code ?? countryCode).replace(/\D/g, "") || countryCode;
    if (rowCountryCode !== countryCode || (rowMobile !== mobile && rowMobile !== localMobile)) {
      throw new Error("This attendance is not available for the signed-in account.");
    }
    const enrolmentId = cleanEnrolmentId(row.biometric_id);
    return {
      companyId: row.company_id as string,
      profileId: row.id as string,
      profileType: resolvedProfileType,
      dropxId: String(row[idColumn as keyof typeof row] ?? ""),
      biometricId: String(row.biometric_id ?? ""),
      fullName: String(row.full_name ?? ""),
      filter: (item: Awaited<ReturnType<typeof loadAttendanceReportRows>>[number]) => Boolean(enrolmentId) && cleanEnrolmentId(item.enrolmentId) === enrolmentId
    };
  }
  throw new Error("Attendance is available for workforce accounts only.");
}

export async function GET(request: NextRequest) {
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const accountId = request.nextUrl.searchParams.get("accountId") ?? "";
    const profileType = request.nextUrl.searchParams.get("profileType") ?? "";
    if (!accountId) throw new Error("Account is required.");
    const range = monthRange(request.nextUrl.searchParams.get("month"));
    const worker = await resolveWorker({ accountId, profileType });
    const rows = (await loadAttendanceReportRows({
      companyId: worker.companyId,
      enrolmentIds: [worker.biometricId],
      fromDate: range.fromDate,
      toDate: range.toDate,
      reportType: "performance"
    })).filter(worker.filter);
    const present = rows.filter((row) => row.status === "P").length;
    const absent = rows.filter((row) => row.status === "A").length;
    const misPunch = rows.filter((row) => row.remark.toLowerCase().includes("single") || row.remark.toLowerCase().includes("missing")).length;
    const requestsResult = await supabaseAdmin
      .from("attendance_regularization_requests")
      .select("id, attendance_date, requested_in_time, requested_out_time, reason_code, remarks, attachment_path, status, review_remarks, created_at")
      .eq("company_id", worker.companyId)
      .eq("profile_type", worker.profileType)
      .eq("profile_id", worker.profileId)
      .gte("attendance_date", range.fromDate)
      .lte("attendance_date", range.toDate)
      .order("created_at", { ascending: false });
    if (requestsResult.error && !isMissingRegularizationTable(requestsResult.error.message)) {
      throw new Error(requestsResult.error.message);
    }
    const requestByDate = new Map<string, Record<string, unknown>>();
    for (const item of requestsResult.data ?? []) {
      if (!requestByDate.has(String(item.attendance_date))) {
        requestByDate.set(String(item.attendance_date), {
          id: item.id,
          requestedInTime: String(item.requested_in_time ?? "").slice(0, 5),
          requestedOutTime: String(item.requested_out_time ?? "").slice(0, 5),
          reasonCode: item.reason_code,
          remarks: item.remarks,
          hasAttachment: Boolean(item.attachment_path),
          status: item.status,
          reviewRemarks: item.review_remarks,
          createdAt: item.created_at
        });
      }
    }

    const responseRows = rows.map((row) => ({
      date: row.punchDate,
      status: row.status,
      inTime: row.inTime,
      outTime: row.outTime,
      punches: row.punchTimes,
      workHours: row.workHours,
      punchCount: row.punchCount,
      remark: row.remark,
      regularization: requestByDate.get(row.punchDate) ?? null
    }));
    const attendanceDates = new Set(responseRows.map((row) => row.date));
    for (const [date, regularization] of requestByDate) {
      if (!attendanceDates.has(date)) {
        responseRows.push({
          date,
          status: "",
          inTime: "",
          outTime: "",
          punches: [],
          workHours: "",
          punchCount: 0,
          remark: "",
          regularization
        });
      }
    }
    responseRows.sort((left, right) => left.date.localeCompare(right.date));

    return NextResponse.json({
      month: range.label,
      summary: {
        totalRows: rows.length,
        present,
        absent,
        misPunch
      },
      rows: responseRows
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load attendance.";
    const status = message.includes("Login") ? 401 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function POST(request: NextRequest) {
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const formData = await request.formData();
    const accountId = String(formData.get("accountId") ?? "").trim();
    const profileType = String(formData.get("profileType") ?? "").trim();
    const attendanceDate = String(formData.get("attendanceDate") ?? "").trim();
    const requestedInTime = String(formData.get("requestedInTime") ?? "").trim();
    const requestedOutTime = String(formData.get("requestedOutTime") ?? "").trim();
    const reasonCode = String(formData.get("reasonCode") ?? "").trim();
    const remarks = String(formData.get("remarks") ?? "").trim();
    const currentInTime = String(formData.get("currentInTime") ?? "").trim();
    const currentOutTime = String(formData.get("currentOutTime") ?? "").trim();
    if (!accountId) throw new Error("Account is required.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(attendanceDate)) throw new Error("Attendance date is required.");
    if (attendanceDate > new Date().toISOString().slice(0, 10)) throw new Error("Future attendance cannot be regularized.");
    if (!validTime(requestedInTime) || !validTime(requestedOutTime)) {
      throw new Error("Requested IN and OUT times are required.");
    }
    if (requestedOutTime <= requestedInTime) throw new Error("Requested OUT time must be after IN time.");
    if (!["missed_in", "missed_out", "missed_both", "incorrect_in", "incorrect_out", "other"].includes(reasonCode)) {
      throw new Error("Select a regularization reason.");
    }
    if (remarks.length < 5) throw new Error("Enter a short explanation.");
    const worker = await resolveWorker({ accountId, profileType });
    const existingResult = await supabaseAdmin
      .from("attendance_regularization_requests")
      .select("id, status")
      .eq("company_id", worker.companyId)
      .eq("profile_type", worker.profileType)
      .eq("profile_id", worker.profileId)
      .eq("attendance_date", attendanceDate)
      .in("status", ["pending", "returned"])
      .maybeSingle();
    if (existingResult.error) {
      if (isMissingRegularizationTable(existingResult.error.message)) {
        throw new Error("Attendance regularization setup is pending. Run attendance_regularization_requests_v1.sql.");
      }
      throw new Error(existingResult.error.message);
    }
    if (existingResult.data?.status === "pending") {
      throw new Error("A regularization request is already pending for this date.");
    }

    let attachmentPath: string | null = null;
    const attachment = formData.get("attachment");
    if (attachment instanceof File && attachment.size > 0) {
      if (attachment.size > 8 * 1024 * 1024) throw new Error("Attachment must be 8 MB or smaller.");
      const safeName = attachment.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      attachmentPath = `${worker.companyId}/${worker.profileId}/attendance-regularization-${attendanceDate}-${Date.now()}${fileExtension(safeName)}`;
      const uploadResult = await supabaseAdmin.storage
        .from("employee-profile-documents")
        .upload(attachmentPath, Buffer.from(await attachment.arrayBuffer()), {
          contentType: attachment.type || "application/octet-stream",
          upsert: false
        });
      if (uploadResult.error) throw new Error(uploadResult.error.message);
    }

    const payload = {
      company_id: worker.companyId,
      profile_type: worker.profileType,
      profile_id: worker.profileId,
      dropx_id: worker.dropxId || null,
      biometric_id: worker.biometricId || null,
      full_name: worker.fullName || null,
      attendance_date: attendanceDate,
      current_in_time: currentInTime || null,
      current_out_time: currentOutTime || null,
      requested_in_time: requestedInTime,
      requested_out_time: requestedOutTime,
      reason_code: reasonCode,
      remarks,
      attachment_path: attachmentPath,
      status: "pending",
      updated_at: new Date().toISOString()
    };
    const saveResult = existingResult.data?.id
      ? await supabaseAdmin
          .from("attendance_regularization_requests")
          .update(payload)
          .eq("id", existingResult.data.id)
          .select("id, status")
          .single()
      : await supabaseAdmin
          .from("attendance_regularization_requests")
          .insert(payload)
          .select("id, status")
          .single();
    if (saveResult.error) throw new Error(saveResult.error.message);
    await createAppNotification({
      accountId: worker.profileId,
      companyId: worker.companyId,
      data: {
        attendanceDate,
        regularizationRequestId: saveResult.data.id,
        status: saveResult.data.status
      },
      eventCode: "attendance_regularization_submitted",
      profileType: worker.profileType,
      sourceKey: `${saveResult.data.id}:${payload.updated_at}`,
      variables: { date: attendanceDate.split("-").reverse().join("/") }
    });
    return NextResponse.json({ ok: true, request: saveResult.data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to submit regularization request.";
    const status = message.includes("Login") ? 401 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
