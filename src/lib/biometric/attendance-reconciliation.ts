import { createHash, randomUUID } from "node:crypto";
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

const SCHEDULED_RECONCILIATION_OWNER_ID = "00000000-0000-4000-8000-000000000000";

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
  snapshotToken: string;
  startCursor: number;
  toDate: string;
  totalMappings: number;
};

function personId(row: HistoricalBiometricMapping) {
  if (row.profile_type === "employee") return row.employee_id || row.account_id;
  if (row.profile_type === "field_executive") return row.field_executive_id || row.account_id;
  return row.account_id || row.employee_id || row.field_executive_id;
}

async function loadMappings({
  companyId,
  fromDate,
  toDate
}: {
  companyId?: string;
  fromDate: string;
  toDate: string;
}) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const mappings: ReconciliationEnrolment[] = [];
  const mappingPageSize = 1000;
  for (let from = 0; ; from += mappingPageSize) {
    let pageQuery = supabaseAdmin
      .from("biometric_enrolments")
      .select("id,company_id,enrolment_id,worker_type,profile_type,account_id,employee_id,field_executive_id,location_id,status,effective_from,effective_to")
      .lte("effective_from", toDate)
      .or(`effective_to.is.null,effective_to.gte.${fromDate}`);
    if (companyId !== undefined) pageQuery = pageQuery.eq("company_id", companyId);
    const pageResult = await pageQuery
      .order("id", { ascending: true })
      .range(from, from + mappingPageSize - 1);
    if (pageResult.error) throw new Error(pageResult.error.message);
    const page = (pageResult.data ?? []) as ReconciliationEnrolment[];
    mappings.push(...page);
    if (page.length < mappingPageSize) break;
  }
  return mappings;
}

function mappingSnapshotToken(mappings: Array<ReconciliationEnrolment | HistoricalBiometricMapping>) {
  return createHash("sha256")
    .update(JSON.stringify(mappings.map((mapping) => ({
      accountId: mapping.account_id,
      companyId: mapping.company_id,
      effectiveFrom: mapping.effective_from,
      effectiveTo: mapping.effective_to,
      employeeId: mapping.employee_id,
      enrolmentId: mapping.enrolment_id,
      fieldExecutiveId: mapping.field_executive_id,
      id: mapping.id,
      locationId: mapping.location_id,
      profileType: mapping.profile_type,
      status: mapping.status,
      workerType: mapping.worker_type
    }))))
    .digest("hex");
}

export async function reconcileBiometricAttendance({
  batchSize = ATTENDANCE_RECONCILIATION_DEFAULT_BATCH_SIZE,
  companyId,
  cursor,
  deadlineAtMs,
  expectedSnapshotToken,
  fromDate,
  leaseContention = "skip",
  leaseOwnerId = SCHEDULED_RECONCILIATION_OWNER_ID,
  now = new Date(),
  serializeByCompany = false,
  toDate
}: {
  batchSize?: number;
  companyId?: string;
  cursor?: number | null;
  deadlineAtMs: number;
  expectedSnapshotToken?: string | null;
  fromDate: string;
  leaseContention?: "fail" | "skip";
  leaseOwnerId?: string;
  now?: Date;
  serializeByCompany?: boolean;
  toDate: string;
}): Promise<AttendanceReconciliationResult> {
  const admin = supabaseAdmin;
  if (!admin) throw new Error("Supabase service role key is not configured.");

  // Ownership cannot be resolved from an arbitrary page of mapping rows: a
  // padded spelling or competing owner may fall on the next page. Load the
  // bounded mapping set, normalize it, then paginate the resulting disjoint
  // ownership windows.
  // Scheduled reconciliation intentionally remains global. Authenticated
  // browser runs always pass a company scope and must never load another
  // tenant's enrolments, including when the scope is unexpectedly blank.
  const mappings = await loadMappings({ companyId, fromDate, toDate });
  const ownershipWindows = buildHistoricalBiometricOwnershipWindows({
    fromDate,
    mappings,
    toDate
  });
  const snapshotToken = mappingSnapshotToken(mappings);
  if (expectedSnapshotToken && expectedSnapshotToken !== snapshotToken) {
    throw new Error("Attendance mappings changed during repair. Run the repair again.");
  }
  const validateCompanySnapshot = async () => {
    if (!serializeByCompany || !companyId) return;
    // Establish a serialization point for the whole batch. Mapping writes
    // that started first finish before this claim; writes that start after it
    // wait in the database trigger. Re-reading under the lease means a
    // browser repair cannot report a healthy page from a stale frozen
    // snapshot, including an empty/final page or an unrelated new mapping.
    const validationToken = randomUUID();
    let validationLeaseHeld = false;
    try {
      const claimed = await admin.rpc("attendance_try_acquire_reconciliation_run", {
        p_company_id: companyId,
        p_lease_seconds: 360,
        p_owner_user_id: leaseOwnerId,
        p_token: validationToken
      });
      if (claimed.error) throw new Error(`Unable to validate attendance repair snapshot: ${claimed.error.message}`);
      validationLeaseHeld = claimed.data === true;
      if (!validationLeaseHeld) {
        throw new Error("Attendance repair is busy for this company. Run the repair again.");
      }
      const currentMappings = await loadMappings({ companyId, fromDate, toDate });
      if (mappingSnapshotToken(currentMappings) !== snapshotToken) {
        throw new Error("Attendance mappings changed during repair. Run the repair again.");
      }
    } finally {
      if (validationLeaseHeld) {
        try {
          const released = await admin.rpc("attendance_release_reconciliation_run", {
            p_company_id: companyId,
            p_owner_user_id: leaseOwnerId,
            p_token: validationToken
          });
          if (released.error) throw new Error(released.error.message);
        } catch (error) {
          console.warn(JSON.stringify({
            companyId,
            event: "attendance_reconciliation_validation_lease_release_failed",
            message: error instanceof Error ? error.message : "Unable to release attendance validation lease."
          }));
        }
      }
    }
  };
  const totalMappings = ownershipWindows.length;
  const requestedCursor = cursor === null || cursor === undefined
    ? rotatingAttendanceReconciliationOffset({ batchSize, now, total: totalMappings })
    : cursor;
  const startCursor = Math.min(requestedCursor, totalMappings);

  if (!totalMappings || startCursor >= totalMappings) {
    await validateCompanySnapshot();
    return {
      attempted: 0,
      completed: 0,
      failures: [],
      fromDate,
      nextCursor: null,
      punchesReconciled: 0,
      skipped: 0,
      snapshotToken,
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
    snapshotToken,
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

    let leaseToken: string | null = null;
    try {
      if (serializeByCompany) {
        leaseToken = randomUUID();
        const claimed = await admin.rpc("attendance_try_acquire_reconciliation_run", {
          p_company_id: row.company_id,
          p_lease_seconds: 360,
          p_owner_user_id: leaseOwnerId,
          p_token: leaseToken
        });
        if (claimed.error) throw new Error(`Unable to reserve attendance reconciliation: ${claimed.error.message}`);
        if (claimed.data !== true) {
          console.warn(JSON.stringify({
            companyId: row.company_id,
            event: "attendance_reconciliation_company_lease_contended",
            mappingId: row.id
          }));
          leaseToken = null;
          if (leaseContention === "fail") {
            result.failures.push({
              cursor: startCursor + index,
              enrolmentId: ownership.enrolmentId,
              mappingId: row.id,
              message: "Attendance repair is busy for this company. This mapping will be retried."
            });
          } else {
            result.skipped += 1;
          }
          continue;
        }

        // The scheduled scan loaded its global page before taking this
        // company's lease. Re-read ownership while the database guard blocks
        // mapping mutations, and never write from a stale owner snapshot.
        const currentMappings = await loadMappings({ companyId: row.company_id, fromDate, toDate });
        const currentOwnership = buildHistoricalBiometricOwnershipWindows({
          fromDate,
          mappings: currentMappings,
          toDate
        }).find((window) =>
          window.companyId === ownership.companyId &&
          window.enrolmentId === ownership.enrolmentId &&
          window.fromDate === ownership.fromDate &&
          window.toDate === ownership.toDate
        );
        if (
          !currentOwnership ||
          currentOwnership.kind !== "resolved" ||
          !currentOwnership.owner ||
          mappingSnapshotToken([currentOwnership.owner]) !== mappingSnapshotToken([row])
        ) {
          console.warn(JSON.stringify({
            companyId: row.company_id,
            event: "attendance_reconciliation_stale_mapping_skipped",
            mappingId: row.id
          }));
          if (leaseContention === "fail") {
            result.failures.push({
              cursor: startCursor + index,
              enrolmentId: ownership.enrolmentId,
              mappingId: row.id,
              message: "Attendance mapping changed while this repair was running. This mapping will be retried."
            });
          } else {
            result.skipped += 1;
          }
          continue;
        }
      }

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
    } finally {
      if (leaseToken) {
        try {
          const released = await admin.rpc("attendance_release_reconciliation_run", {
            p_company_id: row.company_id,
            p_owner_user_id: leaseOwnerId,
            p_token: leaseToken
          });
          if (released.error) throw new Error(released.error.message);
        } catch (error) {
          console.warn(JSON.stringify({
            companyId: row.company_id,
            event: "attendance_reconciliation_lease_release_failed",
            message: error instanceof Error ? error.message : "Unable to release attendance reconciliation lease."
          }));
        }
      }
    }
  }

  if (result.nextCursor === null && startCursor + windows.length < totalMappings) {
    result.nextCursor = startCursor + windows.length;
  }
  await validateCompanySnapshot();
  // Failure cursors are returned separately for targeted retry or the next
  // scheduled pass. Keep nextCursor moving forward so one locked or malformed
  // mapping cannot rewind an explicit catch-up forever and starve later rows.
  return result;
}
