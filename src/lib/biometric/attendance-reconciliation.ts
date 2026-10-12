import { createHash, randomUUID } from "node:crypto";
import { backfillHistoricalPunches, historicalPunchTimeWindow } from "@/lib/biometric/attendance";
import {
  ATTENDANCE_RECONCILIATION_DEFAULT_BATCH_SIZE,
  buildHistoricalBiometricOwnershipWindows,
  filterHistoricalBiometricOwnershipWindowsForRawPunchActivity,
  rotatingAttendanceReconciliationOffset,
  type HistoricalBiometricMapping,
  type HistoricalBiometricOwnershipWindow,
  type HistoricalBiometricRawPunchDay
} from "@/lib/biometric/attendance-reconciliation-policy";
import { biometricCandidateCategory } from "@/lib/biometric/enrolment-resolution";
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
  const category = biometricCandidateCategory(row);
  if (category === "employee") return row.employee_id || row.account_id;
  if (category === "field_executive") return row.field_executive_id || row.account_id;
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

async function loadHistoricalRawPunchDays({
  companyId,
  fromDate,
  toDate
}: {
  companyId?: string;
  fromDate: string;
  toDate: string;
}): Promise<HistoricalBiometricRawPunchDay[] | null> {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const window = historicalPunchTimeWindow({ effectiveFrom: fromDate, effectiveTo: toDate });
  if (!window.startAt || !window.endBefore) return null;

  const rows: HistoricalBiometricRawPunchDay[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const result = await supabaseAdmin
      .rpc("attendance_reconciliation_raw_punch_days", {
        p_company_id: companyId ?? null,
        p_end_before: window.endBefore,
        p_start_at: window.startAt
      })
      .order("company_id", { ascending: true })
      .order("enrolment_id", { ascending: true })
      .order("punch_date", { ascending: true })
      .range(from, from + pageSize - 1);
    // A schema rollout must not turn an optimization into an attendance gap.
    // Until the candidate RPC is available on every replica, fall back to the
    // complete ownership snapshot and let the established health proof run.
    if (result.error) {
      console.warn(JSON.stringify({
        event: "attendance_reconciliation_raw_activity_filter_unavailable",
        message: result.error.message
      }));
      return null;
    }
    const page = (result.data ?? []) as HistoricalBiometricRawPunchDay[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

function ownershipSnapshotToken(ownershipWindows: HistoricalBiometricOwnershipWindow[]) {
  return createHash("sha256")
    .update(JSON.stringify(ownershipWindows.map((window) => ({
      companyId: window.companyId,
      enrolmentId: window.enrolmentId,
      fromDate: window.fromDate,
      kind: window.kind,
      // Hash only fields that change reconciliation ownership/output. Mapping
      // status is descriptive; row IDs, padded spelling, and redundant raw ID
      // columns must not restart a catch-up when resolved ownership is stable.
      owner: window.owner ? {
        locationId: window.owner.location_id,
        personId: personId(window.owner),
        profileType: biometricCandidateCategory(window.owner),
        workerType: window.owner.worker_type
      } : null,
      toDate: window.toDate
    }))))
    .digest("hex");
}

function rawActivitySnapshotToken({
  ownershipToken,
  ownershipWindows
}: {
  ownershipToken: string;
  ownershipWindows: HistoricalBiometricOwnershipWindow[];
}) {
  return createHash("sha256")
    .update(JSON.stringify({
      mode: "raw-activity",
      ownershipToken,
      // These windows are already in deterministic company/enrolment/date
      // order. Repair writes cannot remove raw TimeLog activity, so this set
      // does not compact while cursors advance. Hash selected membership plus
      // current semantic ownership defensively. A first raw event for a newly
      // active enrolment changes membership and safely forces a fresh pass.
      windows: ownershipWindows.map((window) => ({
        companyId: window.companyId,
        enrolmentId: window.enrolmentId,
        fromDate: window.fromDate,
        toDate: window.toDate
      }))
    }))
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
  rawActivityOnly = false,
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
  rawActivityOnly?: boolean;
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
  const completeOwnershipWindows = buildHistoricalBiometricOwnershipWindows({
    fromDate,
    mappings,
    toDate
  });
  const ownershipToken = ownershipSnapshotToken(completeOwnershipWindows);
  let ownershipWindows = completeOwnershipWindows;
  if (rawActivityOnly) {
    const rawPunchDays = await loadHistoricalRawPunchDays({ companyId, fromDate, toDate });
    if (rawPunchDays) {
      ownershipWindows = filterHistoricalBiometricOwnershipWindowsForRawPunchActivity({
        rawPunchDays,
        windows: completeOwnershipWindows
      });
    }
  }
  const snapshotToken = rawActivityOnly
    ? rawActivitySnapshotToken({ ownershipToken, ownershipWindows })
    : ownershipToken;
  if (expectedSnapshotToken && expectedSnapshotToken !== snapshotToken) {
    throw new Error(rawActivityOnly
      ? "Attendance reconciliation candidate set or mappings changed during repair. Run the repair again."
      : "Attendance mappings changed during repair. Run the repair again.");
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
      const currentOwnershipWindows = buildHistoricalBiometricOwnershipWindows({
        fromDate,
        mappings: currentMappings,
        toDate
      });
      if (ownershipSnapshotToken(currentOwnershipWindows) !== ownershipToken) {
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
    const profileType = biometricCandidateCategory(row);
    if (!accountId || !row.company_id || !ownership.enrolmentId || !row.location_id || !profileType || !row.worker_type) {
      result.skipped += 1;
      continue;
    }

    let leaseToken: string | null = null;
    let repairOwner = row;
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
          ownershipSnapshotToken([currentOwnership]) !== ownershipSnapshotToken([ownership])
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
        // Status is deliberately excluded from the ownership token, but it is
        // still descriptive punch output. Use the row reloaded under the lease
        // so a concurrent lifecycle change is captured without restarting the
        // catch-up or writing the stale status from the global snapshot.
        repairOwner = currentOwnership.owner;
      }

      const repairAccountId = personId(repairOwner);
      const repairProfileType = biometricCandidateCategory(repairOwner);
      if (!repairAccountId || !repairOwner.location_id || !repairProfileType || !repairOwner.worker_type) {
        throw new Error("Attendance mapping became incomplete while this repair was running.");
      }
      result.punchesReconciled += await backfillHistoricalPunches({
        accountId: repairAccountId,
        companyId: repairOwner.company_id,
        effectiveFrom: ownership.fromDate,
        effectiveTo: ownership.toDate,
        employeeId: repairProfileType === "employee" ? repairAccountId : null,
        enrolmentId: ownership.enrolmentId,
        fieldExecutiveId: repairProfileType === "field_executive" ? repairAccountId : null,
        // Lifecycle status is intentionally not an eligibility condition.
        isActive: repairOwner.status === "Active",
        locationId: repairOwner.location_id,
        profileType: repairProfileType,
        workerStatus: repairOwner.status || "Unknown",
        workerType: repairOwner.worker_type,
        // The worker resolved this window from the complete normalized mapping
        // snapshot. Scheduled runs revalidate the exact owner while holding
        // the company lease above; browser runs hold that same lease around
        // the entire worker call. Re-resolving inside backfill would repeat a
        // full mapping scan for every already-proven window.
        ownershipVerified: true
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
