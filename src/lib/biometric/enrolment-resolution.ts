export type BiometricEnrolmentCandidate = {
  account_id?: string | null;
  accountId?: string | null;
  employee_id?: string | null;
  employeeId?: string | null;
  field_executive_id?: string | null;
  fieldExecutiveId?: string | null;
  id?: string | null;
  isActive?: boolean;
  location_id?: string | null;
  locationId?: string | null;
  enrolment_id?: string | null;
  enrolmentId?: string | null;
  profile_type?: string | null;
  profileType?: string | null;
  status?: string | null;
  worker_type?: string | null;
  workerType?: string | null;
};

export const BIOMETRIC_PROFILE_PRIORITY = [
  "employee",
  "contractor",
  "vendor",
  "worker",
  "field_executive"
] as const;

export function normalizeBiometricEnrolmentId(value: unknown) {
  const text = String(value ?? "").trim();
  if (!/^\d{1,20}$/.test(text)) return "";
  return text.replace(/^0+/, "") || "0";
}

export function biometricEnrolmentIdCandidates(value: unknown) {
  const digits = String(value ?? "").trim();
  const normalized = normalizeBiometricEnrolmentId(digits);
  if (!normalized) return [];
  return Array.from(new Set([
    normalized,
    digits,
    ...Array.from({ length: 20 }, (_, index) => normalized.padStart(index + 1, "0"))
  ].filter(Boolean)));
}

export function biometricCandidateCategory(row: BiometricEnrolmentCandidate) {
  const profileType = row.profile_type ?? row.profileType;
  // Canonical Workforce records historically used both labels for the same
  // person category. Treat the alias identically for priority, duplicate, and
  // owner-key decisions.
  if (profileType === "workforce") return "field_executive";
  if (profileType) return profileType;
  const workerType = row.worker_type ?? row.workerType;
  return workerType === "employee" ? "employee" : "contractor";
}

function biometricCandidateActive(row: BiometricEnrolmentCandidate) {
  return typeof row.isActive === "boolean" ? row.isActive : row.status === "Active";
}

export function biometricCandidateOwnerKey(row: BiometricEnrolmentCandidate) {
  const category = biometricCandidateCategory(row);
  const accountId = row.account_id ?? row.accountId;
  const employeeId = row.employee_id ?? row.employeeId;
  const fieldExecutiveId = row.field_executive_id ?? row.fieldExecutiveId;
  const personId = category === "employee"
    ? employeeId ?? accountId
    : category === "field_executive"
      ? fieldExecutiveId ?? accountId
      : accountId ?? employeeId ?? fieldExecutiveId;
  return `${category}:${personId ?? `mapping:${row.id ?? "unknown"}`}`;
}

export function biometricCandidatePriority(row: BiometricEnrolmentCandidate) {
  const categoryIndex = BIOMETRIC_PROFILE_PRIORITY.indexOf(
    biometricCandidateCategory(row) as (typeof BIOMETRIC_PROFILE_PRIORITY)[number]
  );
  return [
    categoryIndex < 0 ? BIOMETRIC_PROFILE_PRIORITY.length : categoryIndex,
    biometricCandidateActive(row) ? 0 : 1
  ] as const;
}

/**
 * Live punches deliberately stay unresolved when one category points the same
 * device ID at more than one distinct owner. Repeated legacy/canonical rows for
 * the same owner collapse safely. Cross-category collisions use the fixed
 * business priority above; an active flag is only a tie-breaker within a
 * category and never makes lifecycle status an attendance eligibility rule.
 */
export function hasSameCategoryBiometricDuplicate(rows: BiometricEnrolmentCandidate[]) {
  const ownersByCategory = new Map<string, Set<string>>();
  for (const row of rows) {
    // Duplicate detection must use the same semantic category as priority and
    // owner resolution. In particular, legacy individual-contract mappings
    // with no profile_type are contractors, not a separate category.
    const category = biometricCandidateCategory(row);
    const owners = ownersByCategory.get(category) ?? new Set<string>();
    owners.add(biometricCandidateOwnerKey(row));
    if (owners.size > 1) return true;
    ownersByCategory.set(category, owners);
  }
  return false;
}

export function pickPreferredBiometricCandidate<T extends BiometricEnrolmentCandidate>(rows: T[]) {
  return rows.slice().sort((left, right) => {
    const [leftCategory, leftActive] = biometricCandidatePriority(left);
    const [rightCategory, rightActive] = biometricCandidatePriority(right);
    return leftCategory - rightCategory
      || leftActive - rightActive
      || String(left.id ?? "").localeCompare(String(right.id ?? ""));
  })[0] ?? null;
}

export function resolveBiometricCandidate<T extends BiometricEnrolmentCandidate>(rows: T[]) {
  if (!rows.length) return { kind: "none" as const, owner: null, category: null };
  if (hasSameCategoryBiometricDuplicate(rows)) {
    return { kind: "ambiguous" as const, owner: null, category: null };
  }
  const owner = pickPreferredBiometricCandidate(rows);
  return {
    kind: owner ? "resolved" as const : "none" as const,
    owner,
    category: owner ? biometricCandidateCategory(owner) : null
  };
}

export function isSameBiometricOwner(
  left: BiometricEnrolmentCandidate,
  right: BiometricEnrolmentCandidate
) {
  return biometricCandidateOwnerKey(left) === biometricCandidateOwnerKey(right);
}

export function isSameBiometricAssignmentLocation(
  row: BiometricEnrolmentCandidate,
  locationId: string | null | undefined
) {
  return (row.location_id ?? row.locationId ?? null) === (locationId ?? null);
}

function candidateEnrolmentId(row: BiometricEnrolmentCandidate) {
  return String(row.enrolment_id ?? row.enrolmentId ?? "").trim();
}

/**
 * Chooses one current mapping to reuse while separating padded duplicates from
 * genuine ownership conflicts. The exact canonical spelling wins when it is
 * already present; otherwise the shortest deterministic variant is reused and
 * can be canonicalized by its caller.
 */
export function partitionCurrentBiometricEnrolmentVariants<
  T extends BiometricEnrolmentCandidate
>(rows: T[], desiredOwner: BiometricEnrolmentCandidate, canonicalEnrolmentId: string) {
  const sameOwner = rows.filter((row) => isSameBiometricOwner(row, desiredOwner));
  const conflicts = rows.filter((row) => !isSameBiometricOwner(row, desiredOwner));
  const ordered = sameOwner.slice().sort((left, right) => {
    const leftId = candidateEnrolmentId(left);
    const rightId = candidateEnrolmentId(right);
    return Number(rightId === canonicalEnrolmentId) - Number(leftId === canonicalEnrolmentId)
      || leftId.length - rightId.length
      || leftId.localeCompare(rightId)
      || String(left.id ?? "").localeCompare(String(right.id ?? ""));
  });
  const keeper = ordered[0] ?? null;
  return {
    conflicts,
    duplicates: keeper ? ordered.filter((row) => row !== keeper) : [],
    keeper
  };
}

function previousIsoDate(value: string) {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw new Error("Assignment date must be a valid ISO date.");
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/**
 * Keeps the original ownership window when an existing mapping is merely
 * edited, while preventing an old joining date from being reused when an ID
 * or owner is reassigned. Biometric ownership uses inclusive dates, so the
 * preceding mapping must end on the day before the new assignment begins.
 */
export function resolveBiometricAssignmentWindow({
  assignmentDate,
  existingEffectiveFrom,
  hasPriorIdHistory,
  hasPriorPersonMapping,
  requestedEffectiveFrom
}: {
  assignmentDate: string;
  existingEffectiveFrom?: string | null;
  hasPriorIdHistory: boolean;
  hasPriorPersonMapping: boolean;
  requestedEffectiveFrom: string;
}) {
  const isReassignment = !existingEffectiveFrom && (hasPriorIdHistory || hasPriorPersonMapping);
  return {
    effectiveFrom: existingEffectiveFrom || (isReassignment ? assignmentDate : requestedEffectiveFrom),
    isReassignment,
    priorEffectiveTo: previousIsoDate(assignmentDate)
  };
}
