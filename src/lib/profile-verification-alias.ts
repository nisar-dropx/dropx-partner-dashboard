type VerificationRow = {
  kind?: unknown;
  profile_type?: unknown;
  updated_at?: unknown;
  verified_at?: unknown;
  input_key?: unknown;
};

function text(value: unknown) {
  return String(value ?? "").trim();
}

function timestamp(value: unknown) {
  const parsed = Date.parse(text(value));
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

export function verificationProfileTypeAliases(profileType: unknown) {
  const normalized = text(profileType);
  return normalized === "workforce" || normalized === "field_executive"
    ? ["workforce", "field_executive"]
    : normalized
      ? [normalized]
      : [];
}

/**
 * Verification rows are unique only within a stored profile type. During the
 * field_executive -> workforce transition the same check can therefore exist
 * twice. Return one row per kind, using the newest write and the canonical
 * workforce row as the tie-breaker.
 */
export function preferredProfileVerificationRows<T extends VerificationRow>(rows: T[]) {
  const ordered = [...rows].sort((left, right) => {
    const updatedDifference = timestamp(right.updated_at) - timestamp(left.updated_at);
    if (updatedDifference) return updatedDifference;

    const canonicalDifference = Number(text(right.profile_type) === "workforce")
      - Number(text(left.profile_type) === "workforce");
    if (canonicalDifference) return canonicalDifference;

    const verifiedDifference = timestamp(right.verified_at) - timestamp(left.verified_at);
    if (verifiedDifference) return verifiedDifference;

    return [text(left.profile_type), text(left.input_key)].join("|")
      .localeCompare([text(right.profile_type), text(right.input_key)].join("|"));
  });
  const seenKinds = new Set<string>();
  return ordered.filter((row) => {
    const kind = text(row.kind);
    if (!kind || seenKinds.has(kind)) return false;
    seenKinds.add(kind);
    return true;
  });
}
