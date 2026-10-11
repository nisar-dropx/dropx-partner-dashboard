import { backfillHistoricalPunches } from "@/lib/biometric/attendance";
import {
  ATTENDANCE_RECONCILIATION_DEFAULT_BATCH_SIZE,
  buildHistoricalBiometricOwnershipWindows,
  rotatingAttendanceReconciliationOffset,
  type HistoricalBiometricMapping
} from "@/lib/biometric/attendance-reconciliation-policy";
import { supabaseAdmin } from "@/lib/supabase-admin";

type ReconciliationEnrolment = {
  account_id: string | null;
  company_id: string;
  effective_from: string | null;
  effective_to: string | null;
  employee_id: string | null;
  enrolment_id: string;
  field_executive_id: string | null;
  id: string;
  location_id: string | null;
  profile_type: string | null;
  status: string | null;
  worker_type: string | null;
};

export type AttendanceReconciliationFailure = {
  cursor: number;
  enrolmentId: string;
  mappingId: string;
  message: string;
};

export type AttendanceReconciliationResult = {
  attempted: number;
  completed: number;
  failures: AttendanceReconciliationFailure[];
  fromDate: string;
  nextCursor: number | null;
  punchesReconciled: number;
  skipped: number;
  startCursor: number;
  toDate: string;
  totalMappings: number;
};

function personId(row: HistoricalBiometricMapping) {
  if (row.profile_type === "employee") return row.employee_id || row.account_id;
  if (row.profile_type === "field_executive") return row.field_executive_id || row.account_id;
  return row.account_id || row.employee_id || row.field_executive_id;
}

export async function reconcileBiometricAttendance({
  batchSize = ATTENDANCE_RECONCILIATION_DEFAULT_BATCH_SIZE,
  cursor,
  deadlineAtMs,
  fromDate,
  now = new Date(),
  toDate
}: {
  batchSize?: number;
  cursor?: number | null;
  deadlineAtMs: number;
  fromDate: string;
  now?: Date;
  toDate: string;
}): Promise<AttendanceReconciliationResult> {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");

  // Ownership cannot be resolved from an arbitrary page of mapping rows: a
  // padded spelling or competing owner may fall on the next page. Load the
  // bounded mapping set, normalize it, then paginate the resulting disjoint
  // ownership windows.
  const mappings: ReconciliationEnrolment[] = [];
  const mappingPageSize = 1000;
  for (let from = 0; ; from += mappingPageSize) {
    const pageResult = await supabaseAdmin
      .from("biometric_enrolments")
      .select("id,company_id,enrolment_id,worker_type,profile_type,account_id,employee_id,field_executive_id,location_id,status,effective_from,effective_to")
      .lte("effective_from", toDate)
      .or(`effective_to.is.null,effective_to.gte.${fromDate}`)
      .order("id", { ascending: true })
      .range(from, from + mappingPageSize - 1);
    if (pageResult.error) throw new Error(pageResult.error.message);
    const page = (pageResult.data ?? []) as ReconciliationEnrolment[];
    mappings.push(...page);
    if (page.length < mappingPageSize) break;
  }
  const ownershipWindows = buildHistoricalBiometricOwnershipWindows({
    fromDate,
    mappings,
    toDate
  });
  const totalMappings = ownershipWindows.length;
  const requestedCursor = cursor === null || cursor === undefined
    ? rotatingAttendanceReconciliationOffset({ batchSize, now, total: totalMappings })
    : cursor;
  const startCursor = Math.min(requestedCursor, totalMappings);

  if (!totalMappings || startCursor >= totalMappings) {
    return {
      attempted: 0,
      completed: 0,
      failures: [],
      fromDate,
      nextCursor: null,
      punchesReconciled: 0,
      skipped: 0,
      startCursor,
      toDate,
      totalMappings
    };
  }

  const windows = ownershipWindows.slice(startCursor, startCursor + batchSize);
  const result: AttendanceReconciliationResult = {
    attempted: 0,
    completed: 0,
    failures: [],
    fromDate,
    nextCursor: null,
    punchesReconciled: 0,
    skipped: 0,
    startCursor,
    toDate,
    totalMappings
  };

  for (let index = 0; index < windows.length; index += 1) {
    if (Date.now() >= deadlineAtMs) {
      result.nextCursor = startCursor + index;
      break;
    }

    const ownership = windows[index];
    const row = ownership.owner;
    result.attempted += 1;
    // Same-category conflicts deliberately remain unresolved. In particular,
    // do not run each candidate and let the last one silently claim the day.
    if (ownership.kind === "ambiguous" || !row) {
      result.skipped += 1;
      continue;
    }
    const accountId = personId(row);
    if (!accountId || !row.company_id || !ownership.enrolmentId || !row.location_id || !row.profile_type || !row.worker_type) {
      result.skipped += 1;
      continue;
    }

    try {
      result.punchesReconciled += await backfillHistoricalPunches({
        accountId,
        companyId: row.company_id,
        effectiveFrom: ownership.fromDate,
        effectiveTo: ownership.toDate,
        employeeId: row.profile_type === "employee" ? accountId : null,
        enrolmentId: ownership.enrolmentId,
        fieldExecutiveId: row.profile_type === "field_executive" ? accountId : null,
        // Lifecycle status is intentionally not an eligibility condition.
        isActive: row.status === "Active",
        locationId: row.location_id,
        ownershipVerified: true,
        profileType: row.profile_type,
        workerStatus: row.status || "Unknown",
        workerType: row.worker_type
      });
      result.completed += 1;
    } catch (error) {
      result.failures.push({
        cursor: startCursor + index,
        enrolmentId: ownership.enrolmentId,
        mappingId: row.id,
        message: error instanceof Error ? error.message : "Attendance reconciliation failed."
      });
    }
  }

  if (result.nextCursor === null && startCursor + windows.length < totalMappings) {
    result.nextCursor = startCursor + windows.length;
  }
  // Failure cursors are returned separately for targeted retry or the next
  // scheduled pass. Keep nextCursor moving forward so one locked or malformed
  // mapping cannot rewind an explicit catch-up forever and starve later rows.
  return result;
}
