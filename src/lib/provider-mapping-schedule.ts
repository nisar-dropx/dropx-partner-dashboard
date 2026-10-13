export type MappingPaymentPeriod = { effectiveFrom: string; effectiveTo: string; paymentMethodId: string; paymentValues: Record<string,string>; productionThresholdMinimumUnits: string };
const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) === value;
export function nextMappingPeriodStart(end: string) {
  if (!validDate(end)) return '';
  const next = new Date(`${end}T00:00:00Z`); next.setUTCDate(next.getUTCDate()+1);
  return next.toISOString().slice(0,10);
}
export function mappingScheduleError(periods: MappingPaymentPeriod[]) {
  if (periods.length < 2 || periods.length > 12) return 'Plan between 2 and 12 payment periods.';
  for (let index=0; index<periods.length; index++) {
    const period = periods[index];
    if (!validDate(period.effectiveFrom) || (period.effectiveTo && !validDate(period.effectiveTo))) return `Period ${index+1}: Enter valid dates.`;
    if (!period.paymentMethodId) return `Period ${index+1}: Select a payment method.`;
    if (period.effectiveTo && period.effectiveTo < period.effectiveFrom) return `Period ${index+1}: End date cannot be before start date.`;
    if (index < periods.length-1 && !period.effectiveTo) return `Period ${index+1}: Add an end date before adding another period.`;
    if (index && period.effectiveFrom !== nextMappingPeriodStart(periods[index-1].effectiveTo)) return `Period ${index+1}: Start on the day after the preceding period ends. Periods cannot overlap or leave a gap.`;
    if (Object.values(period.paymentValues).some(value => !value.trim() || !Number.isFinite(Number(value)) || Number(value) < 0)) return `Period ${index+1}: Enter valid non-negative rates.`;
  }
  return null;
}
