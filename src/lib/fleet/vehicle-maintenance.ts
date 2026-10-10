/** A daily ad-hoc report must not erase Fleet's saved repair plan. */
export function effectiveVehicleAvailability<T extends {
  status: string | null; status_updated_at?: string | null;
  non_operational_since: string | null; expected_operational_date: string | null;
  status_comment: string | null;
}>(vehicle: T, day?: { status: string; work_date: string; created_at?: string | null } | null): T {
  if (!day || vehicle.status === 'archived') return vehicle;
  // A deliberate Fleet update after the request is authoritative (including return to service).
  if (day.created_at && vehicle.status_updated_at && Date.parse(vehicle.status_updated_at) >= Date.parse(day.created_at)) return vehicle;
  if (vehicle.status === day.status) return {
    ...vehicle,
    non_operational_since: vehicle.non_operational_since || day.work_date,
    status_comment: vehicle.status_comment || 'Recorded from ad hoc replacement request for this day',
  };
  return { ...vehicle, status: day.status, non_operational_since: day.work_date,
    expected_operational_date: null, status_comment: 'Recorded from ad hoc replacement request for this day' };
}

export function availabilityDateError(since: unknown, expected: unknown, today: string): string | null {
  const valid = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
    && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
  if (since && !valid(since)) return 'Enter a valid non-operational start date.';
  if (expected && !valid(expected)) return 'Enter a valid expected operational date.';
  if (since && String(since) > today) return 'Non-operational start date cannot be in the future.';
  if (since && expected && String(expected) < String(since)) return 'Expected operational date cannot be before the non-operational start date.';
  return null;
}

export function registrationNumber(value: unknown): string | null {
  const normalized = String(value ?? '').replace(/\s/g, '').toUpperCase();
  return /^[A-Z0-9]{6,20}$/.test(normalized) ? normalized : null;
}
