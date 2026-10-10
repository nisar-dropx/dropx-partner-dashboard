import { NextRequest, NextResponse } from "next/server";
import { resolveConnectAttendanceWorker } from "@/lib/connect-attendance-worker";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { resolveAttendancePayDayType } from "@/lib/attendance-pay-day";
import { summarizeAttendance } from "@/lib/attendance-summary";
import { approvedLeaveDays } from "@/lib/leave-calendar-days";
import { userFacingError } from "@/lib/user-facing-error";
import { regularizationTimeInput } from "@/lib/regularization-input";
import { canCancelRegularization, cancellableRegularizationStatuses, regularizationIdsWithApproval } from "@/lib/connect-regularization-cancel";
import { fillAttendanceCalendarGaps, loadAttendanceReportRows } from "../../../../../../src/lib/biometric/attendance";
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

function mapConfigError(message: string) {
  if (/invalid api key/i.test(message)) {
    return "DropX One database credentials are misconfigured for this project. Verify NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on the Connect (one.dropxlogistics.com) Vercel project — not the dashboard project.";
  }
  return message;
}

function errorResponse(error: unknown, fallback: string) {
  const raw = userFacingError(error, fallback);
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
    const todayIst = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
    const enrolmentId = cleanEnrolmentId(worker.enrolmentId) || cleanEnrolmentId(worker.biometricId);
    const rows = (await loadAttendanceReportRows({
      companyId: worker.companyId,
      enrolmentIds: [worker.biometricId, worker.enrolmentId].filter(Boolean),
      fromDate: range.fromDate,
      toDate: range.toDate,
      reportType: "performance"
    })).filter((row) => Boolean(enrolmentId) && cleanEnrolmentId(row.enrolmentId) === enrolmentId);

    const requestsResult = await supabaseAdmin
      .from("attendance_regularization_requests")
      .select("id, attendance_date, requested_in_time, requested_out_time, reason_code, remarks, attachment_path, attachment_path_out, status, review_remarks, created_at, request_kind")
      .eq("company_id", worker.companyId)
      .eq("profile_type", worker.profileType)
      .eq("profile_id", worker.profileId)
      .gte("attendance_date", range.fromDate)
      .lte("attendance_date", range.toDate)
      .order("created_at", { ascending: false });
    if (requestsResult.error && !isMissingRegularizationTable(requestsResult.error.message)) {
      throw new Error(requestsResult.error.message);
    }
    const openCorrectionIds = (requestsResult.data ?? [])
      .filter((item) => item.request_kind == null && cancellableRegularizationStatuses.includes(String(item.status)))
      .map((item) => String(item.id));
    const approvedCorrectionIds = await regularizationIdsWithApproval(worker.companyId, openCorrectionIds);

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
          hasAttachmentOut: Boolean(item.attachment_path_out),
          status: item.status,
          reviewRemarks: item.review_remarks,
          createdAt: item.created_at,
          canCancel: item.request_kind == null && canCancelRegularization(item.status, approvedCorrectionIds.has(String(item.id)))
        });
      }
    }

    const leaveColumn = worker.profileType === "employee" ? "employee_id" : worker.profileType === "contractor" ? "contractor_id" : null;
    const [leaveTypes, approvedLeaveRequests] = await Promise.all([
      supabaseAdmin
        .from("hr_leave_types")
        .select("id,name,attendance_code,attendance_label,is_paid,balance_mode")
        .eq("company_id", worker.companyId),
      leaveColumn
        ? supabaseAdmin
          .from("hr_leave_requests")
          .select("start_date,end_date,leave_type_id")
          .eq("company_id", worker.companyId)
          .eq(leaveColumn, worker.profileId)
          .eq("status", "approved")
          .lte("start_date", range.toDate)
          .gte("end_date", range.fromDate)
        : Promise.resolve({ data: [], error: null })
    ]);
    if (leaveTypes.error) throw new Error(leaveTypes.error.message);
    if (approvedLeaveRequests.error) throw new Error(approvedLeaveRequests.error.message);
    const labels = new Map((leaveTypes.data ?? []).map((type) => [type.attendance_code, type]));
    const leaveTypeById = new Map((leaveTypes.data ?? []).map((type) => [type.id, type]));
    const leaveDays = approvedLeaveDays((approvedLeaveRequests.data ?? []).flatMap((request) => {
      const type = leaveTypeById.get(request.leave_type_id);
      return type ? [{
        startDate: String(request.start_date),
        endDate: String(request.end_date),
        attendanceCode: String(type.attendance_code ?? ""),
        attendanceLabel: type.attendance_label ?? null,
        name: String(type.name ?? "")
      }] : [];
    }), range.fromDate, range.toDate);

    /** Leave-type colour/label for a day's status code (a configured leave code, or plain attendance). */
    const classifyStatus = (status: string, attendanceStatus: string, workMode: string) => {
      const configured = labels.get(status);
      const unpaidLeave = Boolean(configured) && (
        configured?.is_paid === false
        || String(configured?.balance_mode ?? "") === "unlimited_unpaid"
      );
      const paidLeave = Boolean(configured) && !unpaidLeave;
      const isPaidLeave = configured ? paidLeave : null;
      const statusLabel = unpaidLeave
        ? (configured?.attendance_label || "Unpaid leave")
        : (configured?.attendance_label ?? null);
      const statusKind = unpaidLeave
        ? "leave" as const
        : paidLeave
          ? "paid_leave" as const
          : "attendance" as const;
      const payDayType = resolveAttendancePayDayType({
        status,
        statusLabel: statusLabel ?? attendanceStatus,
        attendanceStatus,
        workMode,
        leaveType: configured
          ? {
            attendance_code: configured.attendance_code,
            attendance_label: configured.attendance_label,
            is_paid: unpaidLeave ? false : paidLeave ? true : null
          }
          : null,
        isPaidLeave
      });
      return { statusLabel, statusKind, isPaidLeave, payDayType };
    };

    const responseRows = rows.map((row) => {
      // An approved leave day shows as that leave even when the biometric
      // import produced a row for it (approval does not touch attendance_daily).
      const status = leaveDays.get(row.punchDate)?.attendanceCode ?? String(row.status ?? "");
      const { statusLabel, statusKind, isPaidLeave, payDayType } = classifyStatus(status, row.attendanceStatus, row.workMode ?? "onsite");
      return {
        date: row.punchDate,
        status,
        statusLabel,
        statusKind,
        isPaidLeave,
        payDayType,
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
        workMode: row.workMode ?? "onsite",
        regularization: requestByDate.get(row.punchDate) ?? null
      };
    });

    const attendanceDates = new Set(responseRows.map((row) => row.date));
    // Approved leave on a day with no attendance row at all (the usual case:
    // nobody punches on a leave day).
    for (const [date, leave] of leaveDays) {
      if (attendanceDates.has(date)) continue;
      attendanceDates.add(date);
      const { statusLabel, statusKind, isPaidLeave, payDayType } = classifyStatus(leave.attendanceCode, leave.attendanceLabel ?? leave.name, "onsite");
      responseRows.push({
        date,
        status: leave.attendanceCode,
        statusLabel,
        statusKind,
        isPaidLeave,
        payDayType,
        attendanceStatus: leave.attendanceLabel ?? leave.name,
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
        shiftName: leave.name,
        shiftCode: "",
        shiftSource: "Approved leave",
        remark: "",
        workMode: "onsite" as const,
        regularization: requestByDate.get(date) ?? null
      });
    }
    // attendance_daily has no row at all for a zero-punch day. Backfill every
    // completed active-service day so the calendar can distinguish absence,
    // rest days and genuine out-of-service dates — and so a missed-both-punch
    // day can enter the regularization workflow.
    if (worker.profileType === "employee" || worker.profileType === "contractor") {
      const activeFromDate = worker.dateOfJoin && worker.dateOfJoin > range.fromDate ? worker.dateOfJoin : range.fromDate;
      const yesterday = new Date(`${todayIst}T00:00:00Z`);
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      const lastCompletedDate = yesterday.toISOString().slice(0, 10);
      const visibleToDate = lastCompletedDate < range.toDate ? lastCompletedDate : range.toDate;
      const calendarGapRows = activeFromDate <= visibleToDate
        ? await fillAttendanceCalendarGaps({
          companyId: worker.companyId,
          existingDates: attendanceDates,
          fromDate: activeFromDate,
          includeNoPunchDays: true,
          profileId: worker.profileId,
          profileType: worker.profileType,
          toDate: visibleToDate
        })
        : [];
      const nextIsoDate = (date: string) => {
        const value = new Date(`${date}T00:00:00Z`);
        value.setUTCDate(value.getUTCDate() + 1);
        return value.toISOString().slice(0, 10);
      };
      const restFromDate = nextIsoDate(visibleToDate);
      const upcomingFromDate = activeFromDate > restFromDate ? activeFromDate : restFromDate;
      const upcomingRestRows = upcomingFromDate <= range.toDate
        ? await fillAttendanceCalendarGaps({
          companyId: worker.companyId,
          existingDates: new Set([...attendanceDates, ...calendarGapRows.map((row) => row.punchDate)]),
          fromDate: upcomingFromDate,
          includeNoPunchDays: false,
          profileId: worker.profileId,
          profileType: worker.profileType,
          toDate: range.toDate
        })
        : [];
      for (const row of [...calendarGapRows, ...upcomingRestRows]) {
        attendanceDates.add(row.punchDate);
        responseRows.push({
          date: row.punchDate,
          status: row.status,
          statusLabel: null,
          statusKind: "attendance" as const,
          isPaidLeave: null,
          // row.status carries the raw roster day type (e.g. "weekly_off",
          // "holiday"); row.attendanceStatus is the human label
          // attendanceDayStatus() derived from it (e.g. "Weekly Off"). Reuse
          // the same label-matching resolver the real rows use below,
          // instead of assuming every backfilled day is a week off.
          payDayType: resolveAttendancePayDayType({ status: "", statusLabel: row.attendanceStatus, attendanceStatus: row.attendanceStatus, workMode: "onsite" }),
          attendanceStatus: row.attendanceStatus,
          inTime: "",
          outTime: "",
          punches: [],
          workHours: "",
          punchCount: 0,
          lateMinutes: 0,
          earlyOutMinutes: 0,
          scheduledStart: row.scheduledStart,
          scheduledEnd: row.scheduledEnd,
          scheduledMinutes: row.scheduledMinutes,
          shiftName: row.shiftName,
          shiftCode: row.shiftCode,
          shiftSource: row.shiftSource,
          remark: "",
          workMode: "onsite" as const,
          regularization: requestByDate.get(row.punchDate) ?? null
        });
      }
    }

    // A request is workflow state, not an attendance outcome. Evaluate completed
    // no-punch days against roster/policy first; otherwise even a cancelled
    // request replaced a genuine Absent/Off day with a synthetic Needs Review.
    // Retain the request-only fallback for days not covered by that evaluation.
    for (const [date, regularization] of requestByDate) {
      if (!attendanceDates.has(date)) {
        responseRows.push({
          date, status: "", statusLabel: null, statusKind: "attendance" as const,
          isPaidLeave: null, payDayType: "needs_review" as const, attendanceStatus: "Needs Review",
          inTime: "", outTime: "", punches: [], workHours: "", punchCount: 0,
          lateMinutes: 0, earlyOutMinutes: 0, scheduledStart: "--:--", scheduledEnd: "--:--",
          scheduledMinutes: 0, shiftName: "Unassigned", shiftCode: "", shiftSource: "Unassigned",
          remark: "", workMode: "onsite" as const, regularization
        });
      }
    }

    const holidayCalendar = await supabaseAdmin
      .from("hr_payroll_calendar_days")
      .select("calendar_date,day_type,name,location_id")
      .eq("company_id", worker.companyId)
      .eq("is_active", true)
      .gte("calendar_date", range.fromDate)
      .lte("calendar_date", range.toDate);
    if (holidayCalendar.error) throw new Error(holidayCalendar.error.message);
    const holidayNameByDate = new Map<string, string>();
    for (const day of holidayCalendar.data ?? []) {
      if (day.day_type !== "paid_holiday") continue;
      if (day.location_id && day.location_id !== worker.locationId) continue;
      const date = String(day.calendar_date).slice(0, 10);
      if (!holidayNameByDate.has(date) || day.location_id) holidayNameByDate.set(date, day.name || "Holiday");
    }
    for (const row of responseRows) {
      if (row.statusKind !== "attendance") continue;
      const name = holidayNameByDate.get(row.date);
      if (!name) continue;
      if ((row.punchCount ?? 0) > 0) {
        row.payDayType = "paid_holiday";
        continue;
      }
      row.status = "holiday";
      row.attendanceStatus = name;
      row.payDayType = "paid_holiday";
      row.shiftName = name;
      row.shiftSource = "Holiday";
    }

    responseRows.sort((left, right) => left.date.localeCompare(right.date));

    // Regularization window (HRMS > Attendance policy): the rolling backdate
    // window plus the "month closes on day N of next month" rule. Same rule as
    // hr_regularization_window_open, which also guards the insert.
    // hr_regularization_rules returns this person's rule set over the company
    // default (HRMS > Regularization rule sets); before that function exists
    // everyone follows the company row.
    const personRules = await supabaseAdmin.rpc("hr_regularization_rules", {
      p_company_id: worker.companyId, p_profile_type: worker.profileType, p_profile_id: worker.profileId
    });
    const personRule = personRules.error ? null : (Array.isArray(personRules.data) ? personRules.data[0] : personRules.data) ?? null;
    const windowSettings = personRule
      ? { data: { regularization_max_backdate_days: personRule.backdate_days, regularization_close_day: personRule.close_day } }
      : await supabaseAdmin.from("hr_company_settings")
        .select("regularization_max_backdate_days,regularization_close_day").eq("company_id", worker.companyId).maybeSingle();
    const backdateDays = Number(windowSettings.data?.regularization_max_backdate_days ?? 30);
    const closeDay = windowSettings.data?.regularization_close_day == null ? null : Number(windowSettings.data.regularization_close_day);
    const earliest = new Date(`${todayIst}T00:00:00Z`);
    earliest.setUTCDate(earliest.getUTCDate() - backdateDays);
    const earliestDate = earliest.toISOString().slice(0, 10);
    const closesOn = (date: string) => {
      if (closeDay === null) return null;
      const [year, month] = date.split("-").map(Number);
      return new Date(Date.UTC(year, month, closeDay)).toISOString().slice(0, 10);
    };
    // Custom dates from the person's rule set: extra attendance days kept open
    // until their own closing date, on top of the window above.
    const customFrom = personRule?.custom_from ? String(personRule.custom_from).slice(0, 10) : null;
    const customTo = personRule?.custom_to ? String(personRule.custom_to).slice(0, 10) : null;
    const customClosesOn = personRule?.custom_closes_on ? String(personRule.custom_closes_on).slice(0, 10) : null;
    const withWindow = responseRows.map((row) => {
      const closeDate = closesOn(row.date);
      // With a close day set, the month rule alone decides; otherwise the backdate window.
      const baseOpen = closeDate ? todayIst <= closeDate : row.date >= earliestDate;
      const inCustom = Boolean(customFrom && customTo && customClosesOn && row.date >= customFrom && row.date <= customTo);
      const open = row.date <= todayIst && (baseOpen || (inCustom && todayIst <= customClosesOn!));
      // The later of the two deadlines is the one the person sees.
      const closesOnDate = inCustom && (!closeDate || customClosesOn! > closeDate) ? customClosesOn : closeDate;
      return { ...row, regularizationOpen: open, regularizationClosesOn: closesOnDate };
    });

    const { groups: _groups, ...summary } = summarizeAttendance(withWindow, { today: todayIst });
    return NextResponse.json({
      month: range.label,
      summary,
      rows: withWindow
    });
  } catch (error) {
    return errorResponse(error, "Unable to load attendance.");
  }
}

export async function POST(request: NextRequest) {
  const uploadedPaths: string[] = [];
  let requestSaved = false;
  let stage = "validate";
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
    if (![
      "missed_in",
      "missed_out",
      "missed_both",
      "incorrect_in",
      "incorrect_out",
      "late_in_permission",
      "early_out_permission"
    ].includes(reasonCode)) {
      throw new Error("Select a regularization reason.");
    }
    const { inTime: normalizedRequestedInTime, outTime: normalizedRequestedOutTime } = regularizationTimeInput({
      reason: reasonCode, currentIn: currentInTime, currentOut: currentOutTime,
      requestedIn: requestedInTime, requestedOut: requestedOutTime
    });
    if (remarks.length < 5) throw new Error("Enter a short explanation.");

    stage = "account";
    const worker = await resolveConnectAttendanceWorker({ accountId, profileType });
    if (worker.profileType !== "employee" && worker.profileType !== "contractor") {
      throw new Error("Attendance regularization is available only for employees and independent contractors.");
    }

    stage = "existing_request";
    const existingResult = await supabaseAdmin
      .from("attendance_regularization_requests")
      .select("id, status, attachment_path, attachment_path_out")
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
    let attachmentPathOut: string | null = existingResult.data?.attachment_path_out ?? null;
    const attachment = formData.get("attachment");
    const attachmentOut = formData.get("attachmentOut");
    stage = "upload";
    if (attachment instanceof File && attachment.size > 0) {
      const extension = regularizationProofTypes.get(attachment.type);
      if (!extension) throw new Error("CCTV proof must be a JPG, PNG or WebP image.");
      if (attachment.size > 5 * 1024 * 1024) throw new Error("CCTV proof must be 5 MB or smaller.");
      attachmentPath = `${worker.companyId}/${worker.profileId}/attendance-regularization-${attendanceDate}-${Date.now()}${extension}`;
      const uploadResult = await supabaseAdmin.storage
        .from("employee-profile-documents")
        .upload(attachmentPath, Buffer.from(await attachment.arrayBuffer()), {
          contentType: attachment.type || "application/octet-stream",
          upsert: false
        });
      if (uploadResult.error) throw new Error(uploadResult.error.message);
      uploadedPaths.push(attachmentPath);
    }
    if (attachmentOut instanceof File && attachmentOut.size > 0) {
      const extension = regularizationProofTypes.get(attachmentOut.type);
      if (!extension) throw new Error("OUT-time CCTV proof must be a JPG, PNG or WebP image.");
      if (attachmentOut.size > 5 * 1024 * 1024) throw new Error("OUT-time CCTV proof must be 5 MB or smaller.");
      attachmentPathOut = `${worker.companyId}/${worker.profileId}/attendance-regularization-out-${attendanceDate}-${Date.now()}${extension}`;
      const uploadResult = await supabaseAdmin.storage
        .from("employee-profile-documents")
        .upload(attachmentPathOut, Buffer.from(await attachmentOut.arrayBuffer()), {
          contentType: attachmentOut.type || "application/octet-stream",
          upsert: false
        });
      if (uploadResult.error) throw new Error(uploadResult.error.message);
      uploadedPaths.push(attachmentPathOut);
    }
    if (!attachmentPath) {
      throw new Error("Upload workplace CCTV proof with a visible timestamp matching the requested IN or OUT time.");
    }
    if (reasonCode === "missed_both" && !attachmentPathOut) {
      throw new Error("Upload separate CCTV proof for both IN and OUT times.");
    }

    const workerType = worker.profileType as "employee" | "contractor";
    stage = "approval_route";
    const approval = await resolveAttendanceRegularizationApprovers(
      worker.companyId,
      workerType,
      worker.profileId
    );
    stage = "create_request";
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
      throw new Error(createResult.error.message, { cause: { code: createResult.error.code } });
    }
    const requestId = String(createResult.data ?? "");
    if (!requestId) throw new Error("Unable to create attendance regularization request.");
    requestSaved = true;
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
    if (!requestSaved && uploadedPaths.length && supabaseAdmin) {
      await supabaseAdmin.storage.from("employee-profile-documents").remove(uploadedPaths).catch(() => undefined);
    }
    // Keep diagnostics searchable without logging names, remarks, proof paths or credentials.
    const code = error instanceof Error && error.cause && typeof error.cause === "object" && "code" in error.cause
      ? String(error.cause.code) : undefined;
    console.error("Attendance regularization submission failed", { stage, code });
    return errorResponse(error, "Unable to submit regularization request.");
  }
}
