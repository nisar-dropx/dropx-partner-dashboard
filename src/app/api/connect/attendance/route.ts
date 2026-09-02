import { createHash } from "crypto";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { connectSessionCookieName, normalizeConnectMobile } from "@/lib/connect-auth";
import { formatTime, loadAttendanceReportRows } from "@/lib/biometric/attendance";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { createAppNotification } from "@/lib/app-notifications";
import { resolveAttendanceRegularizationApprovers } from "@/lib/attendance-regularization-workflow";
import { notifyAttendanceApprovalRequired } from "@/lib/connect-attendance-notifications";
import { releaseOrphanedHeldPunches } from "@/lib/biometric/attendance-integrity-resolution";
import { resolveStationAttendanceSettings } from "@/lib/biometric/station-attendance-settings";
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

function enrolmentVariants(value: unknown) {
  const raw = String(value ?? "").trim();
  const cleaned = cleanEnrolmentId(value);
  const primary = cleaned || raw;
  return Array.from(new Set([
    raw,
    cleaned,
    primary.padStart(6, "0"),
    primary.padStart(8, "0")
  ].filter(Boolean)));
}

type ConnectAttendanceResponseRow = {
  date: string;
  status: string;
  inTime: string;
  outTime: string;
  punches: string[];
  workHours: string;
  punchCount: number;
  remark: string;
  regularization: Record<string, unknown> | null;
  pendingReview?: boolean;
  statusLabel?: string;
};

function isMissingRegularizationTable(message: unknown) {
  const text = String(message ?? "").toLowerCase();
  return text.includes("attendance_regularization_requests") &&
    (text.includes("does not exist") || text.includes("schema cache"));
}

function validTime(value: string) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

const regularizationProofTypes = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"]
]);

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
      .select(`id, company_id, mobile, mobile_country_code, biometric_id, full_name, location_id, ${idColumn}`)
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
    const primaryEnrolmentId = cleanEnrolmentId(row.biometric_id) || String(row.id).replace(/-/g, "").slice(0, 16);
    const allVariants = Array.from(new Set([
      ...enrolmentVariants(row.biometric_id),
      ...enrolmentVariants(primaryEnrolmentId)
    ]));
    return {
      companyId: row.company_id as string,
      profileId: row.id as string,
      profileType: resolvedProfileType,
      dropxId: String(row[idColumn as keyof typeof row] ?? ""),
      biometricId: String(row.biometric_id ?? "").trim() || primaryEnrolmentId,
      fullName: String(row.full_name ?? ""),
      locationId: (row.location_id as string | null) ?? null,
      enrolmentVariants: allVariants,
      filter: (item: Awaited<ReturnType<typeof loadAttendanceReportRows>>[number]) => {
        const itemId = cleanEnrolmentId(item.enrolmentId);
        return allVariants.some((variant) => cleanEnrolmentId(variant) === itemId);
      }
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
    await releaseOrphanedHeldPunches({
      companyId: worker.companyId,
      enrolmentIds: worker.enrolmentVariants,
      locationId: worker.locationId
    });
    const stationSettings = await resolveStationAttendanceSettings(worker.locationId);
    const rows = (await loadAttendanceReportRows({
      companyId: worker.companyId,
      enrolmentIds: worker.enrolmentVariants,
      fromDate: range.fromDate,
      toDate: range.toDate,
      reportType: "performance"
    })).filter(worker.filter);
    const present = rows.filter((row) => row.status === "P").length;
    const absent = rows.filter((row) => row.status === "A").length;
    const heldPunchResult = stationSettings.integrityFlagsEnabled
      ? await supabaseAdmin
        .from("attendance_punches")
        .select("punch_date, punch_time")
        .eq("company_id", worker.companyId)
        .in("enrolment_id", worker.enrolmentVariants)
        .gte("punch_date", range.fromDate)
        .lte("punch_date", range.toDate)
        .eq("calculated", false)
        .eq("is_flagged", true)
        .order("punch_time", { ascending: true })
      : { data: [], error: null };
    if (heldPunchResult.error) throw new Error(heldPunchResult.error.message);
    const heldPunchesByDate = new Map<string, string[]>();
    for (const punch of heldPunchResult.data ?? []) {
      const date = String(punch.punch_date ?? "");
      const time = formatTime(punch.punch_time);
      if (!date || time === "--:--") continue;
      const times = heldPunchesByDate.get(date) ?? [];
      times.push(time);
      heldPunchesByDate.set(date, times);
    }
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

    const responseRows: ConnectAttendanceResponseRow[] = rows.map((row) => ({
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
    for (const [date, heldTimes] of heldPunchesByDate) {
      const existing = responseRows.find((row) => row.date === date);
      const combinedPunches = Array.from(new Set([...(existing?.punches ?? []), ...heldTimes])).sort();
      if (existing) {
        existing.punches = combinedPunches;
        existing.punchCount = combinedPunches.length;
        existing.inTime = combinedPunches[0] ?? existing.inTime;
        existing.outTime = combinedPunches.length > 1 ? combinedPunches[combinedPunches.length - 1] : existing.outTime;
        existing.pendingReview = true;
        existing.statusLabel = "Verification pending";
        existing.remark = "Biometric punch captured · attendance integrity review pending";
      } else {
        responseRows.push({
          date,
          status: "",
          inTime: combinedPunches[0] ?? "",
          outTime: combinedPunches.length > 1 ? combinedPunches[combinedPunches.length - 1] : "",
          punches: combinedPunches,
          workHours: "00:00",
          punchCount: combinedPunches.length,
          remark: "Biometric punch captured · attendance integrity review pending",
          regularization: requestByDate.get(date) ?? null,
          pendingReview: true,
          statusLabel: "Verification pending"
        });
      }
    }
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

    const misPunchDates = new Set([
      ...rows
        .filter((row) => row.remark.toLowerCase().includes("single") || row.remark.toLowerCase().includes("missing"))
        .map((row) => row.punchDate),
      ...heldPunchesByDate.keys()
    ]);

    return NextResponse.json({
      month: range.label,
      summary: {
        totalRows: rows.length,
        present,
        absent,
        misPunch: misPunchDates.size
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
    if (!["missed_in", "missed_out", "missed_both", "incorrect_in", "incorrect_out", "other"].includes(reasonCode)) {
      throw new Error("Select a regularization reason.");
    }
    const requestsInTime = ["missed_in", "incorrect_in", "missed_both", "other"].includes(reasonCode);
    const requestsOutTime = ["missed_out", "incorrect_out", "missed_both", "other"].includes(reasonCode);
    const normalizedRequestedInTime = requestsInTime ? requestedInTime : currentInTime;
    const normalizedRequestedOutTime = requestsOutTime ? requestedOutTime : currentOutTime;
    if (requestsInTime && !validTime(requestedInTime)) throw new Error("Requested IN time is required for this reason.");
    if (requestsOutTime && !validTime(requestedOutTime)) throw new Error("Requested OUT time is required for this reason.");
    if (!requestsInTime && !validTime(currentInTime)) throw new Error("The existing IN punch is missing. Select Missed both punches.");
    if (!requestsOutTime && !validTime(currentOutTime)) throw new Error("The existing OUT punch is missing. Select Missed both punches.");
    if (normalizedRequestedOutTime <= normalizedRequestedInTime) throw new Error("Requested OUT time must be after IN time.");
    if (remarks.length < 5) throw new Error("Enter a short explanation.");
    const worker = await resolveWorker({ accountId, profileType });
    const existingResult = await supabaseAdmin
      .from("attendance_regularization_requests")
      .select("id, status, attachment_path")
      .eq("company_id", worker.companyId)
      .eq("profile_type", worker.profileType)
      .eq("profile_id", worker.profileId)
      .eq("attendance_date", attendanceDate)
      .is("request_kind", null)
      .in("status", ["pending", "pending_manager", "pending_hr", "returned"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existingResult.error) {
      if (isMissingRegularizationTable(existingResult.error.message)) {
        throw new Error("Attendance regularization setup is pending. Run attendance_regularization_requests_v1.sql.");
      }
      throw new Error(existingResult.error.message);
    }
    if (existingResult.data && existingResult.data.status !== "returned") {
      throw new Error("A regularization request is already pending for this date.");
    }

    let attachmentPath = existingResult.data?.attachment_path ?? null;
    let attachmentPathOut: string | null = null;
    let uploadedPath: string | null = null;
    let uploadedPathOut: string | null = null;
    const attachment = formData.get("attachment");
    const attachmentOut = formData.get("attachmentOut");
    if (attachment instanceof File && attachment.size > 0) {
      const extension = regularizationProofTypes.get(attachment.type);
      if (!extension) throw new Error("CCTV proof must be a JPG, PNG or WebP image.");
      if (attachment.size > 5 * 1024 * 1024) throw new Error("CCTV proof must be 5 MB or smaller.");
      attachmentPath = `${worker.companyId}/${worker.profileId}/attendance-regularization-${attendanceDate}-${Date.now()}${extension}`;
      uploadedPath = attachmentPath;
      const uploadResult = await supabaseAdmin.storage
        .from("employee-profile-documents")
        .upload(attachmentPath, Buffer.from(await attachment.arrayBuffer()), {
          contentType: attachment.type || "application/octet-stream",
          upsert: false
        });
      if (uploadResult.error) throw new Error(uploadResult.error.message);
    }
    if (attachmentOut instanceof File && attachmentOut.size > 0) {
      const extension = regularizationProofTypes.get(attachmentOut.type);
      if (!extension) throw new Error("OUT-time CCTV proof must be a JPG, PNG or WebP image.");
      if (attachmentOut.size > 5 * 1024 * 1024) throw new Error("OUT-time CCTV proof must be 5 MB or smaller.");
      attachmentPathOut = `${worker.companyId}/${worker.profileId}/attendance-regularization-out-${attendanceDate}-${Date.now()}${extension}`;
      uploadedPathOut = attachmentPathOut;
      const uploadResult = await supabaseAdmin.storage
        .from("employee-profile-documents")
        .upload(attachmentPathOut, Buffer.from(await attachmentOut.arrayBuffer()), {
          contentType: attachmentOut.type || "application/octet-stream",
          upsert: false
        });
      if (uploadResult.error) throw new Error(uploadResult.error.message);
    }
    if (!attachmentPath) {
      throw new Error("Upload workplace CCTV proof with a visible timestamp matching the requested IN or OUT time.");
    }
    if (reasonCode === "missed_both" && !attachmentPathOut && !existingResult.data?.attachment_path) {
      throw new Error("Upload separate CCTV proof for both IN and OUT times.");
    }
    if (worker.profileType !== "employee" && worker.profileType !== "contractor") {
      throw new Error("Attendance regularization is available only for employees and independent contractors.");
    }
    const workerType = worker.profileType as "employee" | "contractor";
    const approval = await resolveAttendanceRegularizationApprovers(
      worker.companyId,
      workerType,
      worker.profileId
    );
    const createResult = await supabaseAdmin.rpc("hr_create_attendance_regularization_with_steps", {
      p_company_id: worker.companyId,
      p_profile_type: worker.profileType,
      p_profile_id: worker.profileId,
      p_dropx_id: worker.dropxId || null,
      p_biometric_id: worker.biometricId || null,
      p_full_name: worker.fullName || null,
      p_attendance_date: attendanceDate,
      p_current_in_time: currentInTime || null,
      p_current_out_time: currentOutTime || null,
      p_requested_in_time: normalizedRequestedInTime,
      p_requested_out_time: normalizedRequestedOutTime,
      p_reason_code: reasonCode,
      p_remarks: remarks,
      p_attachment_path: attachmentPath,
      p_steps: approval.steps.map((step) => ({
        step_name: step.step_name,
        approver_user_id: step.approver_user_id,
        approver_person_id: step.approver_person_id,
        route_id: step.route_id ?? null,
        resolved_via: step.resolved_via ?? null,
        original_approver_person_id: step.original_approver_person_id ?? null,
        fallback_reason: step.fallback_reason ?? null
      })),
      p_attachment_path_out: attachmentPathOut
    });
    if (createResult.error) {
      if (uploadedPath) await supabaseAdmin.storage.from("employee-profile-documents").remove([uploadedPath]);
      if (uploadedPathOut) await supabaseAdmin.storage.from("employee-profile-documents").remove([uploadedPathOut]);
      throw new Error(createResult.error.message);
    }
    const requestId = String(createResult.data ?? "");
    if (!requestId) throw new Error("Unable to create attendance regularization request.");
    const initialStatus = approval.steps.length ? "pending_manager" : "pending_hr";
    await createAppNotification({
      accountId: worker.profileId,
      companyId: worker.companyId,
      data: {
        attendanceDate,
        regularizationRequestId: requestId,
        status: initialStatus
      },
      eventCode: "attendance_regularization_submitted",
      profileType: worker.profileType,
      sourceKey: `${requestId}:${new Date().toISOString()}`,
      variables: { date: attendanceDate.split("-").reverse().join("/") }
    });
    const firstApprover = approval.steps[0];
    if (firstApprover) {
      await notifyAttendanceApprovalRequired({
        companyId: worker.companyId,
        requestId,
        recipientUserId: firstApprover.approver_user_id,
        workerName: worker.fullName || "Team member",
        attendanceDate
      });
    }
    return NextResponse.json({ ok: true, request: { id: requestId, status: initialStatus } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to submit regularization request.";
    const status = message.includes("Login") ? 401 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
