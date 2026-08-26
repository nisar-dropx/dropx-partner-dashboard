export const DEFAULT_OUTSIDE_STATION_ALLOWANCE_MINUTES = 30;

export function normalizeOutsideStationMinutes(
  value: unknown,
  fallback = DEFAULT_OUTSIDE_STATION_ALLOWANCE_MINUTES
) {
  const minutes = Math.round(Number(value));
  return Number.isFinite(minutes) && minutes >= 1 && minutes <= 240 ? minutes : fallback;
}

export function outsideStationThresholdMinutes(companyAllowanceMinutes: unknown, shiftBreakMinutes: unknown) {
  const allowance = normalizeOutsideStationMinutes(companyAllowanceMinutes);
  const breakMinutes = Math.max(0, Math.round(Number(shiftBreakMinutes ?? 0)) || 0);
  return Math.max(allowance, breakMinutes);
}
