import { NextRequest, NextResponse } from "next/server";
import { resolveConnectAttendanceWorker } from "@/lib/connect-attendance-worker";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { loadAttendanceReportRows } from "../../../../../../src/lib/biometric/attendance";
import { resolveAttendanceRegularizationApprovers } from "../../../../../../src/lib/attendance-regularization-workflow";
import { notifyAttendanceApprovalRequired } from "../../../../../../src/lib/connect-attendance-notifications";

export const dynamic = "force-dynamic";

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

function mapConfigError(message: string) {
  if (/invalid api key/i.test(message)) {
    return "DropX One database credentials are misconfigured for this project. Verify NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on the Connect (one.dropxlogistics.com) Vercel project — not the dashboard project.";
  }
  return message;
}

function errorResponse(error: unknown, fallback: string) {
  const raw = error instanceof Error ? error.message : fallback;
  const message = mapConfigError(raw);
  const status = /login|expired/i.test(message) ? 401 : 400;
  return NextResponse.json({ error: message }, { status });
}

const regularizationProofTypes = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"]
]);

export async function GET(request: NextRequest) {
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const accountId = request.nextUrl.searchParams.get("accountId") ?? "";
    const profileType = request.nextUrl.searchParams.get("profileType") ?? "";
    if (!accountId) throw new Error("Account is required.");

    const range = monthRange(request.nextUrl.searchParams.get("month"));
    const worker = await resolveConnectAttendanceWorker({ accountId, profileType });
    const enrolmentId = cleanEnrolmentId(worker.enrolmentId) || cleanEnrolmentId(worker.biometricId);
    const rows = (await loadAttendanceReportRows({
      companyId: worker.companyId,
      enrolmentIds: [worker.biometricId, worker.enrolmentId].filter(Boolean),
      fromDate: range.fromDate,
      toDate: range.toDate,
      reportType: "performance"
    })).filter((row) => Boolean(enrolmentId) && cleanEnrolmentId(row.enrolmentId) === enrolmentId);

    const present = rows.filter((row) => row.status === "P").length;
    const fullDay = rows.filter((row) => row.attendanceStatus === "Full Day").length;
    const halfDay = rows.filter((row) => row.attendanceStatus === "Half Day").length;
    const absent = rows.filter((row) => row.attendanceStatus === "Absent").length;
    const needsReview = rows.filter((row) => row.attendanceStatus === "Needs Review").length;
    const lateIn = rows.filter((row) => row.lateMinutes > 0).length;
    const earlyOut = rows.filter((row) => row.earlyOutMinutes > 0).length;
    const misPunch = rows.filter((row) =>
      row.punchCount < 2 ||
      !row.outTime ||
      row.remark.toLowerCase().includes("single") ||
      row.remark.toLowerCase().includes("missing")
    ).length;

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

    const leaveTypes = await supabaseAdmin
      .from("hr_leave_types")
      .select("attendance_code,attendance_label,is_paid")
      .eq("company_id", worker.companyId);
    if (leaveTypes.error) throw new Error(leaveTypes.error.message);
    const labels = new Map((leaveTypes.data ?? []).map((type) => [type.attendance_code, type]));

    const responseRows = rows.map((row) => {
      const configured = labels.get(String(row.status ?? ""));
      return {
        date: row.punchDate,
        status: row.status,
        statusLabel: configured?.attendance_label ?? null,
        statusKind: configured ? "leave" as const : "attendance" as const,
        isPaidLeave: configured?.is_paid ?? null,
        attendanceStatus: row.attendanceStatus,
        inTime: row.inTime,
        outTime: row.outTime,
        punches: row.punchTimes,
        workHours: row.workHours,
        punchCount: row.punchCount,
        lateMinutes: row.lateMinutes,
        earlyOutMinutes: row.earlyOutMinutes,
        scheduledStart: row.scheduledStart,
        scheduledEnd: row.scheduledEnd,
        scheduledMinutes: row.scheduledMinutes,
        shiftName: row.shiftName,
        shiftCode: row.shiftCode,
        shiftSource: row.shiftSource,
        remark: row.remark,
        regularization: requestByDate.get(row.punchDate) ?? null
      };
    });

    const attendanceDates = new Set(responseRows.map((row) => row.date));
    for (const [date, regularization] of requestByDate) {
      if (!attendanceDates.has(date)) {
        responseRows.push({
          date,
          status: "",
          statusLabel: null,
          statusKind: "attendance",
          isPaidLeave: null,
          attendanceStatus: "Needs Review",
          inTime: "",
          outTime: "",
          punches: [],
          workHours: "",
          punchCount: 0,
          lateMinutes: 0,
          earlyOutMinutes: 0,
          scheduledStart: "--:--",
          scheduledEnd: "--:--",
          scheduledMinutes: 0,
          shiftName: "Unassigned",
          shiftCode: "",
          shiftSource: "Unassigned",
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
        fullDay,
        halfDay,
        absent,
        needsReview,
        lateIn,
        earlyOut,
        misPunch
      },
      rows: responseRows
    });
  } catch (error) {
    return errorResponse(error, "Unable to load attendance.");
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

    const worker = await resolveConnectAttendanceWorker({ accountId, profileType });
    if (worker.profileType !== "employee" && worker.profileType !== "contractor") {
      throw new Error("Attendance regularization is available only for employees and independent contractors.");
    }

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
    const firstApprover = approval.steps[0];
    if (firstApprover) {
      await notifyAttendanceApprovalRequired({
        companyId: worker.companyId,
        requestId,
        recipientUserId: firstApprover.approver_user_id,
        workerName: worker.fullName || "Team member",
        attendanceDate
      }).catch(() => undefined);
    }
    return NextResponse.json({ ok: true, request: { id: requestId, status: initialStatus } });
  } catch (error) {
    return errorResponse(error, "Unable to submit regularization request.");
  }
}
