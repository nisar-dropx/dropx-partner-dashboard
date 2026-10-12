/** Station policy is persisted in COD Pickup Master; pickup hours never infer the policy. */
export const pickupRules = ['Same Day-Complete', 'Same Day-Partial', 'Next Day'] as const;
export type PickupRule = typeof pickupRules[number];
export type PickupPolicy = { rule: PickupRule; start: string; end: string };
export const pickupDescriptions: Record<PickupRule, string> = {
  'Same Day-Complete': 'Full cash for the collection day is expected in the same-day pickup.',
  'Same Day-Partial': 'Cash available at pickup is deposited; later collections carry forward to the next pickup.',
  'Next Day': 'Cash for the collection day is expected in the following day’s pickup.'
};
const validTime = (s: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
export function parsePickupFields(form: FormData) {
  const text = (key: string) => String(form.get(key) ?? '').trim();
  const rule = text('pickup_rule');
  if (!pickupRules.includes(rule as PickupRule)) throw new Error('Select a deposit rule.');
  const start = text('pickup_window_start'), end = text('pickup_window_end');
  if (!validTime(start) || !validTime(end) || end <= start) throw new Error('Enter a valid pickup window with the end after the start (IST).');
  const agency = text('cms_agency');
  if (!agency || agency.length > 120) throw new Error('Enter a CMS agency (up to 120 characters).');
  const name = text('agent_name'), mobile = text('agent_mobile').replace(/[\s()-]/g, '');
  if (name.length > 160 || (mobile && !/^\+?[0-9]{10,15}$/.test(mobile))) throw new Error('Enter a valid agent name and mobile number, or leave the contact fields blank.');
  return { cms_agency: agency, agent_name: name, agent_mobile: mobile, pickup_rule: rule as PickupRule,
    cod_deposit_day: rule === 'Next Day' ? 'Next Day' : 'Same Day', pickup_time: `${start}–${end}`,
    pickup_window_start: start, pickup_window_end: end, pickup_configured: true };
}
export function pickupPolicy(row?: { pickup_configured?: boolean; pickup_rule?: string | null; pickup_window_start?: string | null; pickup_window_end?: string | null } | null): PickupPolicy | null {
  if (!row?.pickup_configured || !pickupRules.includes(row.pickup_rule as PickupRule)) return null;
  const start = row.pickup_window_start?.slice(0, 5) || '', end = row.pickup_window_end?.slice(0, 5) || '';
  return validTime(start) && validTime(end) && end > start ? { rule: row.pickup_rule as PickupRule, start, end } : null;
}
/** A schedule expectation, not proof of a shortage or bank settlement. Partial
 * pickup requires a cash-at-cutoff snapshot before an amount can be validated. */
export function pickupExpectation(policy: PickupPolicy | null, collectionDate: string, now = new Date()) {
  if (!policy) return { state: 'unconfigured' as const, dueAt: null, depositDate: null, fullDayCashExpected: false, message: 'Pickup rule not configured. Deposit timing cannot be validated.' };
  const date = new Date(`${collectionDate}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(collectionDate) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== collectionDate) throw new Error('Enter a valid collection date.');
  if (policy.rule === 'Next Day') date.setUTCDate(date.getUTCDate() + 1);
  const depositDate = date.toISOString().slice(0, 10), dueAt = `${depositDate}T${policy.end}:00+05:30`;
  return { state: now.getTime() > Date.parse(dueAt) ? 'window-ended' as const : 'upcoming' as const,
    dueAt, depositDate, fullDayCashExpected: policy.rule !== 'Same Day-Partial', message: pickupDescriptions[policy.rule] };
}
export function assertPickupScope(auth: { hasAllLocationAccess: boolean; locationScopeIds: string[] }, locationId: string) {
  if (!auth.hasAllLocationAccess && !auth.locationScopeIds.includes(locationId)) throw new Error('You do not have access to this station.');
}
