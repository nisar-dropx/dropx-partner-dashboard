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
