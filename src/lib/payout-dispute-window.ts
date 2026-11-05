export const DEFAULT_PAYOUT_DISPUTE_HOURS = 48;
export const MAX_PAYOUT_DISPUTE_HOURS = 30 * 24;
export const PAYOUT_DISPUTE_HOUR_PRESETS = [12, 24, 48] as const;

/** Validate both the editable form value and untrusted publish requests. */
export function payoutDisputeHours(value: unknown): number {
  const hours = typeof value === "number" ? value
    : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_PAYOUT_DISPUTE_HOURS) {
    throw new Error(`Enter a whole number of hours between 1 and ${MAX_PAYOUT_DISPUTE_HOURS}.`);
  }
  return hours;
}

export function payoutDisputeDeadline(hours: number, now = Date.now()): string {
  return new Date(now + payoutDisputeHours(hours) * 60 * 60 * 1000).toISOString();
}
