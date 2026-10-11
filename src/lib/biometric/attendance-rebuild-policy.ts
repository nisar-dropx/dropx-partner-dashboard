export const RECONCILIATION_PROMOTABLE_PUNCH_FILTER =
  "is_flagged.is.null,is_flagged.eq.false";

export function isPendingAttendanceReviewPunch({
  calculated,
  isFlagged
}: {
  calculated: boolean | null | undefined;
  isFlagged: boolean | null | undefined;
}) {
  return calculated === false && isFlagged === true;
}

export function shouldClearStalePresentDaily({
  hasHeldOwnerPunch,
  inSource,
  outSource,
  status,
  workMode
}: {
  hasHeldOwnerPunch: boolean;
  inSource?: string | null;
  outSource?: string | null;
  status: string | null | undefined;
  workMode: string | null | undefined;
}) {
  const normalizedWorkMode = String(workMode ?? "onsite").trim().toLowerCase();
  const hasExplicitGpsEvidence = [inSource, outSource]
    .some((source) => String(source ?? "").trim().toLowerCase() === "app_gps");
  return hasHeldOwnerPunch
    && !hasExplicitGpsEvidence
    && status === "P"
    && normalizedWorkMode !== "wfh"
    && normalizedWorkMode !== "business_trip";
}

export type AttendancePunchMergeCandidate = {
  calculated?: boolean | null;
  device_serial?: string | null;
  enrolment_id?: string | null;
  id: string;
  is_flagged?: boolean | null;
  owner_key?: string;
  preferred_owner?: boolean;
  punch_time?: string | null;
  raw_event_id?: string | null;
  source?: string | null;
};

export type AttendancePunchMergeGroup<T extends AttendancePunchMergeCandidate> = {
  canonicalize: boolean;
  keeper: T;
  ownerKey: string;
  physicalKey: string;
  punchTime: string;
  shadowed: T[];
};

function comparePunchMergeCandidates(
  left: AttendancePunchMergeCandidate,
  right: AttendancePunchMergeCandidate,
  canonicalEnrolmentId: string
) {
  const priorities = (row: AttendancePunchMergeCandidate) => [
    // A held row must win so canonicalization cannot silently bypass a
    // manager/integrity review by retaining a calculated twin.
    isPendingAttendanceReviewPunch({ calculated: row.calculated, isFlagged: row.is_flagged }) ? 0 : 1,
    // App GPS punches carry selfie/location evidence that a biometric twin
    // cannot replace.
    row.source === "app_gps" ? 0 : 1,
    String(row.enrolment_id ?? "") === canonicalEnrolmentId ? 0 : 1,
    row.preferred_owner ? 0 : 1,
    row.calculated ? 0 : 1,
    row.raw_event_id ? 0 : 1
  ];
  const leftPriority = priorities(left);
  const rightPriority = priorities(right);
  for (let index = 0; index < leftPriority.length; index += 1) {
    if (leftPriority[index] !== rightPriority[index]) {
      return leftPriority[index] - rightPriority[index];
    }
  }
  return left.id.localeCompare(right.id);
}

/**
 * Plans a non-destructive logical merge before padded punch rows are
 * canonicalized. Every physical row remains stored; `shadowed` candidates are
 * excluded only from the daily summary. Equal timestamps from different
 * devices and evidence assigned to different owners remain separate.
 */
export function buildAttendancePunchMergePlan<T extends AttendancePunchMergeCandidate>(
  rows: T[],
  canonicalEnrolmentId: string
) {
  const byOwnerAndUniqueKey = new Map<string, { candidates: T[]; ownerKey: string; physicalKey: string }>();
  for (const row of rows) {
    const punchTime = String(row.punch_time ?? "");
    // punch_time is non-null in the database. Keep malformed snapshots apart
    // defensively so cleanup never deletes unrelated evidence.
    const physicalKey = punchTime
      ? `${String(row.device_serial ?? "")}\u0000${punchTime}`
      : `missing:${row.id}`;
    // Never destructively merge evidence assigned to different people. The
    // same biometric number can legitimately exist across profile categories.
    const ownerKey = String(row.owner_key ?? `punch:${row.id}`);
    const key = `${ownerKey}\u0000${physicalKey}`;
    const group = byOwnerAndUniqueKey.get(key) ?? { candidates: [], ownerKey, physicalKey };
    group.candidates.push(row);
    byOwnerAndUniqueKey.set(key, group);
  }

  const groups = Array.from(byOwnerAndUniqueKey.values())
    .map(({ candidates, ownerKey, physicalKey }): AttendancePunchMergeGroup<T> => {
      const ordered = candidates.slice().sort((left, right) =>
        comparePunchMergeCandidates(left, right, canonicalEnrolmentId)
      );
      return {
        canonicalize: false,
        keeper: ordered[0],
        ownerKey,
        physicalKey,
        punchTime: String(ordered[0].punch_time ?? ""),
        shadowed: ordered.slice(1)
      };
    });

  const groupsByPhysicalKey = new Map<string, AttendancePunchMergeGroup<T>[]>();
  for (const group of groups) {
    const siblings = groupsByPhysicalKey.get(group.physicalKey) ?? [];
    siblings.push(group);
    groupsByPhysicalKey.set(group.physicalKey, siblings);
  }
  for (const siblings of groupsByPhysicalKey.values()) {
    // A canonical row remains physical evidence even when a held/GPS sibling
    // shadows it for the daily summary. Its unique key therefore blocks every
    // padded keeper from being renamed.
    const canonicalOccupants = siblings.flatMap((group) => [group.keeper, ...group.shadowed])
      .filter((row) => String(row.enrolment_id ?? "") === canonicalEnrolmentId);
    if (canonicalOccupants.length) {
      for (const sibling of siblings) {
        sibling.canonicalize = String(sibling.keeper.enrolment_id ?? "") === canonicalEnrolmentId;
      }
      continue;
    }
    if (siblings.length === 1) {
      siblings[0].canonicalize = true;
      continue;
    }
    const preferred = siblings.filter((group) => group.keeper.preferred_owner);
    if (preferred.length === 1) preferred[0].canonicalize = true;
  }

  return groups.sort((left, right) => left.punchTime.localeCompare(right.punchTime)
      || left.keeper.id.localeCompare(right.keeper.id));
}

/** Preserve every physical punch row while choosing one logical event per
 * timestamp for the daily first-in/last-out summary. */
export function selectAttendancePunchSummaryRows<T extends AttendancePunchMergeCandidate>(
  rows: T[],
  canonicalEnrolmentId: string
) {
  const byPunchTime = new Map<string, T[]>();
  for (const row of rows) {
    const punchTime = String(row.punch_time ?? "");
    const key = punchTime || `missing:${row.id}`;
    const candidates = byPunchTime.get(key) ?? [];
    candidates.push(row);
    byPunchTime.set(key, candidates);
  }
  return Array.from(byPunchTime.values())
    .map((candidates) => candidates.slice().sort((left, right) => {
      // Across independent devices/channels, a valid calculated event wins.
      // Held/GPS precedence applies only inside a true physical duplicate
      // group and must not suppress separate calculated biometric evidence.
      const calculated = Number(right.calculated === true) - Number(left.calculated === true);
      if (calculated) return calculated;
      const canonical = Number(String(right.enrolment_id ?? "") === canonicalEnrolmentId)
        - Number(String(left.enrolment_id ?? "") === canonicalEnrolmentId);
      if (canonical) return canonical;
      const appGps = Number(right.source === "app_gps") - Number(left.source === "app_gps");
      return appGps || left.id.localeCompare(right.id);
    })[0])
    .sort((left, right) => String(left.punch_time ?? "").localeCompare(String(right.punch_time ?? ""))
      || left.id.localeCompare(right.id));
}

export type HistoricalBackfillRawEvent = {
  deviceSerial: string;
  id: string;
  punchTime: string;
};

export type HistoricalBackfillPunch = AttendancePunchMergeCandidate & {
  account_id?: string | null;
  employee_id?: string | null;
  field_executive_id?: string | null;
  location_id?: string | null;
  owner_key: string;
  profile_type?: string | null;
  punch_date?: string | null;
  punch_label?: string | null;
  punch_order?: number | null;
  worker_type?: string | null;
};

export type HistoricalBackfillDaily = {
  employee_id?: string | null;
  employee_code?: string | null;
  enrolment_id: string;
  field_executive_id?: string | null;
  in_source?: string | null;
  in_time?: string | null;
  location_id?: string | null;
  manual_in_request_id?: string | null;
  manual_out_request_id?: string | null;
  out_source?: string | null;
  out_time?: string | null;
  punch_count?: number | null;
  punch_date: string;
  remark?: string | null;
  status?: string | null;
  station_code?: string | null;
  work_minutes?: number | null;
  work_mode?: string | null;
  worker_name?: string | null;
  worker_type?: string | null;
};

export type HistoricalBackfillWorkerSnapshot = {
  stationCode: string | null;
  workerCode: string | null;
  workerName: string | null;
};

export type HistoricalBackfillWorkerSnapshotInput = {
  accountId: string | null;
  employeeId: string | null;
  fieldExecutiveId: string | null;
  locationId: string | null;
  profileType: string | null;
};

export type HistoricalBackfillHealth = {
  affectedDates: string[];
  healthy: boolean;
  reason:
    | "healthy"
    | "held-daily"
    | "missing-punch"
    | "invalid-work-date"
    | "stale-punch"
    | "missing-daily"
    | "worker-snapshot-input"
    | "mismatched-daily";
};

function manualDailyIsAuthoritative(row: HistoricalBackfillDaily) {
  return row.in_source === "manual_regularization"
    || row.out_source === "manual_regularization"
    || Boolean(row.manual_in_request_id || row.manual_out_request_id)
    || /attendance regularized/i.test(String(row.remark ?? ""));
}

function sameTimestamp(left: string | null | undefined, right: string | null | undefined) {
  if (!left || !right) return !left && !right;
  const leftTime = new Date(left).getTime();
  const rightTime = new Date(right).getTime();
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime === rightTime;
  return left === right;
}

function expectedPunchLabel(position: number) {
  const pair = Math.ceil(position / 2);
  return position % 2 === 1 ? `In${pair}` : `Out${pair}`;
}

/**
 * Proves that replaying a resolved historical ownership window would be a
 * no-op. The check is intentionally fail-closed: the caller falls back to the
 * full insert/promote/rebuild path whenever any evidence is incomplete.
 *
 * Stored punch_date values are authoritative here. Re-resolving every raw
 * timestamp is both the expensive part of catch-up and risks moving a valid
 * overnight punch after a later roster edit.
 */
export function historicalBackfillHealth({
  canonicalEnrolmentId,
  dailyRows,
  expectedLocationId,
  expectedOwnerKey,
  expectedWorkerSnapshot,
  expectedWorkerSnapshotInput,
  punches,
  rawEvents,
  windowFromDate,
  windowToDate
}: {
  canonicalEnrolmentId: string;
  dailyRows: HistoricalBackfillDaily[];
  expectedLocationId: string | null;
  expectedOwnerKey: string;
  expectedWorkerSnapshot: HistoricalBackfillWorkerSnapshot;
  expectedWorkerSnapshotInput: HistoricalBackfillWorkerSnapshotInput;
  punches: HistoricalBackfillPunch[];
  rawEvents: HistoricalBackfillRawEvent[];
  windowFromDate: string;
  windowToDate: string;
}): HistoricalBackfillHealth {
  const affectedDates = new Set<string>();
  for (const rawEvent of rawEvents) {
    const represented = punches.filter((punch) =>
      punch.raw_event_id === rawEvent.id
      && punch.owner_key === expectedOwnerKey
      && (punch.location_id ?? null) === expectedLocationId
      && punch.device_serial === rawEvent.deviceSerial
      && sameTimestamp(punch.punch_time, rawEvent.punchTime)
      && (punch.calculated === true || isPendingAttendanceReviewPunch({
        calculated: punch.calculated,
        isFlagged: punch.is_flagged
      }))
    );
    if (!represented.length) {
      return { affectedDates: [], healthy: false, reason: "missing-punch" };
    }
    const workDates = new Set(represented.map((punch) => String(punch.punch_date ?? "")).filter(Boolean));
    if (workDates.size !== 1) {
      return { affectedDates: [], healthy: false, reason: "invalid-work-date" };
    }
    const [workDate] = workDates;
    // A prior-day punch at the lower window boundary may belong to the owner
    // of the preceding mapping segment. Let the existing ownership-aware path
    // re-evaluate that rare boundary instead of guessing.
    if (workDate < windowFromDate || workDate > windowToDate) {
      return { affectedDates: [], healthy: false, reason: "invalid-work-date" };
    }
    affectedDates.add(workDate);
  }

  const orderedDates = Array.from(affectedDates).sort();
  for (const punchDate of orderedDates) {
    const dailyForDate = dailyRows.filter((row) => row.punch_date === punchDate);
    // rebuildAttendanceDay returns before canonicalization or summary writes
    // when a reviewed manual regularization exists.
    if (dailyForDate.some(manualDailyIsAuthoritative)) continue;

    const mergeGroups = buildAttendancePunchMergePlan(
      punches
        .filter((punch) => punch.punch_date === punchDate)
        .map((punch) => ({
          ...punch,
          preferred_owner: punch.owner_key === expectedOwnerKey
        })),
      canonicalEnrolmentId
    );
    const ownerPunches = mergeGroups
      .map((group) => group.keeper)
      .filter((punch) => punch.owner_key === expectedOwnerKey);
    const summaryPunches = selectAttendancePunchSummaryRows(ownerPunches, canonicalEnrolmentId);
    const calculatedPunches = summaryPunches.filter((punch) => punch.calculated === true);
    const heldPunches = summaryPunches.filter((punch) => isPendingAttendanceReviewPunch({
      calculated: punch.calculated,
      isFlagged: punch.is_flagged
    }));
    const calculatedOrder = new Map(calculatedPunches.map((punch, index) => [punch.id, index + 1]));

    for (const group of mergeGroups) {
      const order = calculatedOrder.get(group.keeper.id);
      if (group.canonicalize && group.keeper.enrolment_id !== canonicalEnrolmentId) {
        return { affectedDates: orderedDates, healthy: false, reason: "stale-punch" };
      }
      if (order && (
        Number(group.keeper.punch_order ?? 0) !== order
        || group.keeper.punch_label !== expectedPunchLabel(order)
      )) {
        return { affectedDates: orderedDates, healthy: false, reason: "stale-punch" };
      }
    }

    if (!calculatedPunches.length) {
      if (!heldPunches.length) {
        return { affectedDates: orderedDates, healthy: false, reason: "missing-punch" };
      }
      const hasStalePresent = dailyForDate.some((row) => shouldClearStalePresentDaily({
        hasHeldOwnerPunch: true,
        inSource: row.in_source,
        outSource: row.out_source,
        status: row.status,
        workMode: row.work_mode
      }));
      if (hasStalePresent) {
        return { affectedDates: orderedDates, healthy: false, reason: "held-daily" };
      }
      continue;
    }

    const daily = dailyForDate.find((row) => row.enrolment_id === canonicalEnrolmentId);
    if (!daily) {
      return { affectedDates: orderedDates, healthy: false, reason: "missing-daily" };
    }
    const first = calculatedPunches[0];
    const latest = calculatedPunches[calculatedPunches.length - 1];
    if (
      (latest.profile_type ?? null) !== expectedWorkerSnapshotInput.profileType
      || (latest.account_id ?? null) !== expectedWorkerSnapshotInput.accountId
      || (latest.employee_id ?? null) !== expectedWorkerSnapshotInput.employeeId
      || (latest.field_executive_id ?? null) !== expectedWorkerSnapshotInput.fieldExecutiveId
      || (latest.location_id ?? null) !== expectedWorkerSnapshotInput.locationId
    ) {
      return { affectedDates: orderedDates, healthy: false, reason: "worker-snapshot-input" };
    }
    const expectedOut = calculatedPunches.length > 1 ? latest.punch_time ?? null : null;
    const firstTime = new Date(String(first.punch_time ?? "")).getTime();
    const lastTime = new Date(String(latest.punch_time ?? "")).getTime();
    if (!Number.isFinite(firstTime) || !Number.isFinite(lastTime) || lastTime < firstTime) {
      return { affectedDates: orderedDates, healthy: false, reason: "mismatched-daily" };
    }
    const expectedMinutes = calculatedPunches.length > 1
      ? Math.round((lastTime - firstTime) / 60_000)
      : 0;
    const expectedRemark = calculatedPunches.length === 1 ? "Single punch" : null;
    if (
      !sameTimestamp(daily.in_time, first.punch_time)
      || !sameTimestamp(daily.out_time, expectedOut)
      || Number(daily.punch_count ?? 0) !== calculatedPunches.length
      || Number(daily.work_minutes ?? 0) !== expectedMinutes
      || daily.status !== "P"
      || (daily.remark ?? null) !== expectedRemark
      || (daily.worker_type ?? null) !== (latest.worker_type ?? null)
      || (daily.employee_id ?? null) !== (latest.employee_id ?? null)
      || (daily.field_executive_id ?? null) !== (latest.field_executive_id ?? null)
      || (daily.location_id ?? null) !== (latest.location_id ?? null)
      || (daily.employee_code ?? null) !== expectedWorkerSnapshot.workerCode
      || (daily.worker_name ?? null) !== expectedWorkerSnapshot.workerName
      || (daily.station_code ?? null) !== expectedWorkerSnapshot.stationCode
    ) {
      return { affectedDates: orderedDates, healthy: false, reason: "mismatched-daily" };
    }
  }

  return { affectedDates: orderedDates, healthy: true, reason: "healthy" };
}
