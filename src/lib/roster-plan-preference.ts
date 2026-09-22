export type RosterPlanPreference = {
  id?: string | null;
  status?: string | null;
  roster_kind?: string | null;
  effective_from?: string | null;
  superseded_at?: string | null;
  revision_no?: number | null;
  updated_at?: string | null;
};

/** Normalize shift clocks to HH:MM (preserves minutes; pads single-digit hours). */
export function formatShiftClock(value: string | null | undefined) {
  const match = String(value ?? "").trim().match(/^(\d{1,2}):(\d{2})/);
  if (!match) return "--:--";
  return `${String(Number(match[1])).padStart(2, "0")}:${match[2]}`;
}

export function shiftClockMinutes(value: string | null | undefined) {
  const match = String(value ?? "").trim().match(/^(\d{1,2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/**
 * A "dated" plan's relevance for a date is scoped by which hr_roster_entries
 * rows exist for it (already filtered by the caller's own roster_date query) -
 * unlike a "recurring_weekly" baseline, which applies indefinitely from
 * effective_from until superseded_at and genuinely needs that cutoff to know
 * which of possibly several revisions currently governs a given date. Applying
 * the superseded_at window to a dated plan too meant a stale value left over
 * from an earlier edit-and-republish cycle (e.g. a plan reopened, realigned to
 * a brand new period, and republished, but never had its old superseded_at
 * cleared) could silently exclude that plan's own current, correct entries -
 * even though nothing else was ever actually superseding it for that date.
 */
export function isRosterPlanActiveOn(plan: RosterPlanPreference | null | undefined, asOf: string) {
  if (!plan || plan.status !== "approved") return false;
  if (plan.effective_from && plan.effective_from > asOf) return false;
  if (plan.roster_kind === "dated") return true;
  if (plan.superseded_at && !(asOf < plan.superseded_at)) return false;
  return true;
}

/**
 * Ties on roster_kind/revision_no/effective_from happen for real: two
 * approved, non-superseded dated plans can legitimately cover the exact
 * same station/week (e.g. a stale "reopen the current plan" lookup that
 * missed it and minted a fresh one instead). Without a further tiebreak,
 * callers using these comparators fell back to whatever arbitrary order
 * Supabase happened to return rows in, which could surface a stale
 * duplicate instead of the one actually last published. updated_at
 * (touched on every publish/decide), then id, make the choice
 * deterministic and prefer the most recent one.
 */
export function compareRosterPlanPreference(
  left: RosterPlanPreference | null | undefined,
  right: RosterPlanPreference | null | undefined
) {
  const datedOrder = Number(right?.roster_kind === "dated") - Number(left?.roster_kind === "dated");
  if (datedOrder) return datedOrder;
  const revisionOrder = Number(right?.revision_no ?? 0) - Number(left?.revision_no ?? 0);
  if (revisionOrder) return revisionOrder;
  const effectiveFromOrder = String(right?.effective_from ?? "").localeCompare(String(left?.effective_from ?? ""));
  if (effectiveFromOrder) return effectiveFromOrder;
  const updatedAtOrder = String(right?.updated_at ?? "").localeCompare(String(left?.updated_at ?? ""));
  if (updatedAtOrder) return updatedAtOrder;
  return String(right?.id ?? "").localeCompare(String(left?.id ?? ""));
}

/** Prefer dated over recurring, then highest revision / latest effective_from, skipping superseded plans. */
export function preferActiveRosterRow<T>(
  rows: T[],
  asOf: string,
  getPlan: (row: T) => RosterPlanPreference | null | undefined
): T | null {
  return rows
    .filter((row) => isRosterPlanActiveOn(getPlan(row), asOf))
    .sort((left, right) => compareRosterPlanPreference(getPlan(left), getPlan(right)))[0] ?? null;
}

export function preferActiveRosterRowsByKey<T>(
  rows: T[],
  getAsOf: (row: T) => string,
  getKey: (row: T) => string,
  getPlan: (row: T) => RosterPlanPreference | null | undefined
) {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = getKey(row);
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }
  const preferred = new Map<string, T>();
  for (const [key, group] of groups) {
    const winner = preferActiveRosterRow(group, getAsOf(group[0]), getPlan);
    if (winner) preferred.set(key, winner);
  }
  return preferred;
}
