import {
  normalizeBiometricEnrolmentId,
  resolveBiometricCandidate,
  type BiometricEnrolmentCandidate
} from "./enrolment-resolution.ts";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const ATTENDANCE_RECONCILIATION_INTERVAL_MINUTES = 15;
// Revisit the complete current/prior-month operating window on every scheduled
// pass. Attendance rebuilds are intentionally blocked while a payout is in
// Payment Processing; an eight-day window allowed those blocked days to age out
// before the payout lock was released.
export const ATTENDANCE_RECONCILIATION_DEFAULT_LOOKBACK_DAYS = 62;
export const ATTENDANCE_RECONCILIATION_MAX_CATCHUP_DAYS = 62;
export const ATTENDANCE_RECONCILIATION_DEFAULT_BATCH_SIZE = 16;
export const ATTENDANCE_RECONCILIATION_MAX_BATCH_SIZE = 50;

export function isoDateInKolkata(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Kolkata",
    year: "numeric"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function addIsoDateDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function assertIsoDate(value: string, label: string) {
  if (!ISO_DATE.test(value) || Number.isNaN(new Date(`${value}T00:00:00Z`).getTime())) {
    throw new Error(`${label} must use YYYY-MM-DD.`);
  }
}

function inclusiveDays(fromDate: string, toDate: string) {
  return Math.floor(
    (new Date(`${toDate}T00:00:00Z`).getTime() - new Date(`${fromDate}T00:00:00Z`).getTime()) / 86_400_000
  ) + 1;
}

export function resolveAttendanceReconciliationWindow({
  catchup,
  fromDate,
  now = new Date(),
  toDate
}: {
  catchup: boolean;
  fromDate: string | null;
  now?: Date;
  toDate: string | null;
}) {
  const today = isoDateInKolkata(now);
  const resolvedTo = toDate || today;
  assertIsoDate(resolvedTo, "Attendance reconciliation end date");
  if (resolvedTo > today) throw new Error("Attendance reconciliation cannot include a future date.");

  if (!catchup && (fromDate || toDate)) {
    throw new Error("Use mode=catchup for a custom attendance reconciliation date range.");
  }
  const resolvedFrom = fromDate || addIsoDateDays(resolvedTo, -(ATTENDANCE_RECONCILIATION_DEFAULT_LOOKBACK_DAYS - 1));
  assertIsoDate(resolvedFrom, "Attendance reconciliation start date");
  if (resolvedFrom > resolvedTo) throw new Error("Attendance reconciliation start date must be on or before its end date.");

  const days = inclusiveDays(resolvedFrom, resolvedTo);
  if (days > ATTENDANCE_RECONCILIATION_MAX_CATCHUP_DAYS) {
    throw new Error(`Attendance reconciliation is limited to ${ATTENDANCE_RECONCILIATION_MAX_CATCHUP_DAYS} days per run.`);
  }
  return { fromDate: resolvedFrom, toDate: resolvedTo, days };
}

export function parsePositiveInteger(
  value: string | null,
  { fallback, maximum, minimum = 1 }: { fallback: number; maximum: number; minimum?: number }
) {
  if (value === null || value.trim() === "") return fallback;
  if (!/^\d+$/.test(value)) throw new Error("Pagination values must be whole numbers.");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Pagination value must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

export function rotatingAttendanceReconciliationOffset({
  batchSize,
  now = new Date(),
  total
}: {
  batchSize: number;
  now?: Date;
  total: number;
}) {
  if (total <= 0) return 0;
  const intervalMs = ATTENDANCE_RECONCILIATION_INTERVAL_MINUTES * 60_000;
  const slot = Math.floor(now.getTime() / intervalMs);
  return (slot * batchSize) % total;
}

export function intersectAttendanceReconciliationWindow({
  effectiveFrom,
  effectiveTo,
  fromDate,
  toDate
}: {
  effectiveFrom: string | null;
  effectiveTo: string | null;
  fromDate: string;
  toDate: string;
}) {
  const start = effectiveFrom && effectiveFrom > fromDate ? effectiveFrom : fromDate;
  const end = effectiveTo && effectiveTo < toDate ? effectiveTo : toDate;
  return start <= end ? { fromDate: start, toDate: end } : null;
}

export type HistoricalBiometricMapping = BiometricEnrolmentCandidate & {
  company_id: string;
  effective_from: string | null;
  effective_to: string | null;
  enrolment_id: string;
  id: string;
  location_id: string | null;
};

export type HistoricalBiometricOwnershipWindow = {
  candidates: HistoricalBiometricMapping[];
  companyId: string;
  enrolmentId: string;
  fromDate: string;
  kind: "ambiguous" | "resolved";
  owner: HistoricalBiometricMapping | null;
  toDate: string;
};

function historicalMappingSortKey(row: HistoricalBiometricMapping) {
  return `${row.company_id}\u0000${normalizeBiometricEnrolmentId(row.enrolment_id)}\u0000${row.id}`;
}

/**
 * Turns possibly overlapping and zero-padded mapping rows into non-overlapping
 * ownership windows. Reconciliation paginates these windows, not raw mapping
 * rows, so one device punch can never be replayed once per competing owner.
 */
export function buildHistoricalBiometricOwnershipWindows({
  fromDate,
  mappings,
  toDate
}: {
  fromDate: string;
  mappings: HistoricalBiometricMapping[];
  toDate: string;
}) {
  const grouped = new Map<string, HistoricalBiometricMapping[]>();
  for (const mapping of mappings.slice().sort((left, right) =>
    historicalMappingSortKey(left).localeCompare(historicalMappingSortKey(right))
  )) {
    const enrolmentId = normalizeBiometricEnrolmentId(mapping.enrolment_id);
    if (!mapping.company_id || !enrolmentId) continue;
    const overlap = intersectAttendanceReconciliationWindow({
      effectiveFrom: mapping.effective_from,
      effectiveTo: mapping.effective_to,
      fromDate,
      toDate
    });
    if (!overlap) continue;
    const key = `${mapping.company_id}\u0000${enrolmentId}`;
    const rows = grouped.get(key) ?? [];
    rows.push(mapping);
    grouped.set(key, rows);
  }

  const windows: HistoricalBiometricOwnershipWindow[] = [];
  for (const [key, rows] of Array.from(grouped.entries()).sort(([left], [right]) => left.localeCompare(right))) {
    const [companyId, enrolmentId] = key.split("\u0000");
    const clipped = rows.map((mapping) => ({
      mapping,
      window: intersectAttendanceReconciliationWindow({
        effectiveFrom: mapping.effective_from,
        effectiveTo: mapping.effective_to,
        fromDate,
        toDate
      })!
    }));
    const boundaries = new Set<string>([fromDate, addIsoDateDays(toDate, 1)]);
    for (const item of clipped) {
      boundaries.add(item.window.fromDate);
      boundaries.add(addIsoDateDays(item.window.toDate, 1));
    }
    const orderedBoundaries = Array.from(boundaries).sort();

    for (let index = 0; index < orderedBoundaries.length - 1; index += 1) {
      const segmentFrom = orderedBoundaries[index];
      const segmentTo = addIsoDateDays(orderedBoundaries[index + 1], -1);
      if (segmentFrom > segmentTo || segmentFrom < fromDate || segmentTo > toDate) continue;
      const candidates = clipped
        .filter(({ window }) => window.fromDate <= segmentFrom && window.toDate >= segmentTo)
        .map(({ mapping }) => mapping);
      if (!candidates.length) continue;
      const resolution = resolveBiometricCandidate(candidates);
      windows.push({
        candidates,
        companyId,
        enrolmentId,
        fromDate: segmentFrom,
        kind: resolution.kind === "resolved" ? "resolved" : "ambiguous",
        owner: resolution.kind === "resolved" ? resolution.owner : null,
        toDate: segmentTo
      });
    }
  }
  return windows;
}
