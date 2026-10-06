export type ProductionFallbackPolicy = {
  field_code: string; mode: 'disabled' | 'associate_average' | 'associate_then_station';
  lookback_months: number; minimum_history_days: number; effective_from: string;
};
export type ProductionHistory = {
  id: string; workforce_id: string; station_id: string; payment_field_id: string;
  field_code_snapshot: string; units: number; period_from: string; period_to: string; work_days: number;
};
export type ProductionEstimate = {
  units: number; basis: 'associate average' | 'station average';
  history_from: string; history_to: string; history_units: number; history_work_days: number;
};
/** Finance estimate only. Never writes an attendance or payroll input. */
export function historicalProductionEstimate(input: {
  policies: ProductionFallbackPolicy[]; history: ProductionHistory[];
  workforceId: string; stationId: string; fieldCode: string; date: string; worked: boolean;
}): ProductionEstimate | undefined {
  if (!input.worked) return;
  const code = input.fieldCode.trim().toUpperCase();
  const policy = input.policies.filter(p => p.field_code.trim().toUpperCase() === code && p.effective_from <= input.date)
    .sort((a,b) => b.effective_from.localeCompare(a.effective_from))[0];
  if (!policy || policy.mode === 'disabled') return;
  const month = `${input.date.slice(0,7)}-01`;
  const since = new Date(`${month}T00:00:00Z`);
  since.setUTCMonth(since.getUTCMonth() - policy.lookback_months);
  const from = since.toISOString().slice(0,10);
  const sameField = input.history.filter(h => h.station_id === input.stationId && h.field_code_snapshot?.trim().toUpperCase() === code);
  // An authoritative imported period covers its entire interval, even when the
  // actual total was posted on month-end. Do not add an estimate alongside it.
  if (sameField.some(h => h.workforce_id === input.workforceId && h.period_from <= input.date && h.period_to >= input.date)) return;
  const history = sameField.filter(h => h.period_from >= from && h.period_to < month
    && Number.isFinite(Number(h.units)) && Number(h.units) >= 0 && Number(h.work_days) > 0
    && Number(h.work_days) <= Math.round((Date.parse(h.period_to)-Date.parse(h.period_from))/86400000)+1);
  function average(rows: ProductionHistory[], basis: ProductionEstimate['basis']) {
    // Fail closed on overlapping historical totals for the same person/field.
    if (rows.some((a,i) => rows.some((b,j) => i!==j && a.workforce_id===b.workforce_id
      && a.period_from<=b.period_to && b.period_from<=a.period_to))) return;
    const units = rows.reduce((n,h)=>n+Number(h.units),0), days = rows.reduce((n,h)=>n+Number(h.work_days),0);
    if (days < policy!.minimum_history_days || !rows.length) return;
    return { units: units/days, basis, history_from: rows.map(h=>h.period_from).sort()[0],
      history_to: rows.map(h=>h.period_to).sort().at(-1)!, history_units:units, history_work_days:days };
  }
  return average(history.filter(h=>h.workforce_id===input.workforceId),'associate average')
    ?? (policy.mode==='associate_then_station' ? average(history,'station average') : undefined);
}
