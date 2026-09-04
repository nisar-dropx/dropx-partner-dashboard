export type RosterPlanPreference = {
  status?: string | null;
  roster_kind?: string | null;
  effective_from?: string | null;
  superseded_at?: string | null;
  revision_no?: number | null;
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

export function isRosterPlanActiveOn(plan: RosterPlanPreference | null | undefined, asOf: string) {
  if (!plan || plan.status !== "approved") return false;
  if (plan.effective_from && plan.effective_from > asOf) return false;
  if (plan.superseded_at && !(asOf < plan.superseded_at)) return false;
  return true;
}

export function compareRosterPlanPreference(
  left: RosterPlanPreference | null | undefined,
  right: RosterPlanPreference | null | undefined
) {
  const datedOrder = Number(right?.roster_kind === "dated") - Number(left?.roster_kind === "dated");
  if (datedOrder) return datedOrder;
  const revisionOrder = Number(right?.revision_no ?? 0) - Number(left?.revision_no ?? 0);
  if (revisionOrder) return revisionOrder;
  return String(right?.effective_from ?? "").localeCompare(String(left?.effective_from ?? ""));
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
