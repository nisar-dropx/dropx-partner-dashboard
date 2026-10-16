import { defaultRemittanceTolerance, maxRemittanceTolerance, validRemittanceTolerance } from './cod-remittance-variance.ts';
/** Station policy is persisted in COD Pickup Master; pickup hours never infer the policy. */
export const pickupRules = ['Same Day-Complete', 'Same Day-Partial', 'Next Day'] as const;
export type PickupRule = typeof pickupRules[number];
export type PickupPolicy = { rule: PickupRule; start: string; end: string; preparationFrom?: string | null };
/** Defaults agreed for new stations; saved station overrides always take precedence. */
export const pickupDefaults = { driver_recon_due_time: '21:00', next_day_preparation_from: '16:00', recon_age_flag_days: 1, cod_status_max_age_minutes: 15, remittance_variance_tolerance: defaultRemittanceTolerance } as const;
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
  if ((start || end) && (!validTime(start) || !validTime(end) || end <= start)) throw new Error('Enter both pickup times with the end after the start (IST), or leave both blank until confirmed.');
  const preparationFrom = text('next_day_preparation_from');
  if (rule === 'Next Day' && !validTime(preparationFrom)) throw new Error('Set a valid next-day preparation time (IST).');
  const reconDue = text('driver_recon_due_time');
  if (reconDue && !validTime(reconDue)) throw new Error('Enter a valid DA reconciliation closing time (IST).');
  const configurableInteger = (key:string, max:number) => {
    if (!form.has(key)) return {};
    const n=Number(text(key));
    if (!Number.isInteger(n) || n<1 || n>max) throw new Error(`Enter a valid ${key==='recon_age_flag_days'?'ageing flag threshold (1–365 days)':'status validity (1–60 minutes)'}.`);
    return {[key]:n};
  };
  const toleranceText=text('remittance_variance_tolerance'), tolerance=Number(toleranceText);
  if (form.has('remittance_variance_tolerance') && (!/^\d+(?:\.\d{1,2})?$/.test(toleranceText) || !validRemittanceTolerance(tolerance))) throw new Error(`Enter a remittance variance tolerance from ₹0 to ₹${maxRemittanceTolerance}, with up to two decimal places.`);
  const toleranceSettings=form.has('remittance_variance_tolerance') ? {remittance_variance_tolerance:tolerance} : {};
  const alertSettings={...configurableInteger('recon_age_flag_days',365),...configurableInteger('cod_status_max_age_minutes',60)};
  const agency = text('cms_agency');
  if (agency.length > 120) throw new Error('CMS agency must be up to 120 characters.');
  const name = text('agent_name'), mobile = text('agent_mobile').replace(/[\s()-]/g, '');
  if (name.length > 160 || (mobile && !/^\+?[0-9]{10,15}$/.test(mobile))) throw new Error('Enter a valid agent name and mobile number, or leave the contact fields blank.');
  return { ...alertSettings, ...toleranceSettings, cms_agency: agency, agent_name: name, agent_mobile: mobile, pickup_rule: rule as PickupRule,
    ...(form.has('driver_recon_due_time') ? {driver_recon_due_time: reconDue || null} : {}),
    cod_deposit_day: rule === 'Next Day' ? 'Next Day' : 'Same Day', pickup_time: start ? `${start}–${end}` : null,
    pickup_window_start: start || null, pickup_window_end: end || null, next_day_preparation_from: rule === 'Next Day' ? preparationFrom : null, pickup_configured: true };
}
/** Optional existing integration controls remain separate from pickup policy. */
export function parsePickupAdvanced(form: FormData) {
  if (form.get('advanced_settings') !== 'true') return {};
  const text = (key: string) => String(form.get(key) ?? '').trim();
  const portalCode = text('portal_station_code').toUpperCase();
  if (portalCode && !/^[A-Z0-9]{3,12}$/.test(portalCode)) throw new Error('Enter a valid portal station code.');
  const gap = Number(text('portal_check_interval_minutes'));
  if (!Number.isInteger(gap) || gap < 1 || gap > 1440) throw new Error('Portal check gap must be 1–1440 minutes.');
  const optionalTime = (key: string) => { const value = text(key); if (value && !validTime(value)) throw new Error('Enter valid due times.'); return value || null; };
  const emails = text('escalation_email');
  if (emails && emails.split(/[,;]+/).some(email=>! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))) throw new Error('Enter valid escalation emails separated by commas.');
  return { portal_station_code: portalCode || null, portal_check_interval_minutes: gap,
    portal_checks_enabled: form.get('portal_checks_enabled') === 'true',
    ...Object.fromEntries(['cod_submission_due_time','eod_submission_due_time','prepared_deposit_due_time'].filter(key=>form.has(key)).map(key=>[key,optionalTime(key)])),
    escalation_contact: text('escalation_contact') || null, escalation_email: emails || null };
}
export function pickupPolicy(row?: { pickup_configured?: boolean; pickup_rule?: string | null; pickup_window_start?: string | null; pickup_window_end?: string | null; next_day_preparation_from?: string | null } | null): PickupPolicy | null {
  if (!row?.pickup_configured || !pickupRules.includes(row.pickup_rule as PickupRule)) return null;
  const start = row.pickup_window_start?.slice(0, 5) || '', end = row.pickup_window_end?.slice(0, 5) || '';
  const from = row.next_day_preparation_from?.slice(0,5) || '';
  return validTime(start) && validTime(end) && end > start ? { rule: row.pickup_rule as PickupRule, start, end, preparationFrom: validTime(from) ? from : null } : null;
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
