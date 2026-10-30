/** Explicit master data, never inferred from the first imported shipment. */
export type BillingPeriod = {
  station_code: string;
  reporting_from: string;
  fixed_payout_from: string;
  prior_reporting_station: string | null;
  source: string;
};
export function validBillingDate(value: unknown): value is string {
  return typeof value === 'string' && /^20\d\d-\d\d-\d\d$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
}
export function validateBillingPeriod(value: unknown): BillingPeriod {
  const v=value as Partial<BillingPeriod>;
  if(!v || !/^[A-Za-z0-9_.:-]{1,40}$/.test(v.station_code??'') ||
    !validBillingDate(v.reporting_from) || !validBillingDate(v.fixed_payout_from) ||
    typeof v.source!=='string' || !v.source.trim() || v.source.length>500)
    throw Error('Enter a station, valid reporting and fixed-payout dates, and a confirmation source.');
  const prior=v.prior_reporting_station?.trim()||null;
  if(prior && (!/^[A-Za-z0-9_.:-]{1,40}$/.test(prior)||prior===v.station_code))
    throw Error('Choose a different parent station for earlier shipment reporting.');
  if(v.fixed_payout_from<v.reporting_from&&!prior)
    throw Error('Earlier fixed payout requires the parent that reported those shipments.');
  return {station_code:v.station_code!,reporting_from:v.reporting_from,fixed_payout_from:v.fixed_payout_from,prior_reporting_station:prior,source:v.source.trim()};
}
