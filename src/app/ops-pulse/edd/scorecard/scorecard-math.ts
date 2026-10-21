export type ScorecardStation = {
  station: string; days: number; das: number; delivered: number; assigned: number; returns: number; da_days: number;
  prev_delivered: number; prev_assigned: number; prev_da_days: number;
  delivery_success_pct?: number | null;
  trend: Array<[string, number, number]> | null;
};

/** Delivery success % only when assigned > 0 (trustworthy denominator). */
export function deliverySuccessPct(delivered: number, assigned: number) {
  const a = Number(assigned) || 0;
  if (!(a > 0)) return null;
  return ((Number(delivered) || 0) / a) * 100;
}

/** Per-station scores: productivity, return rate, change against the previous period, and a flag to look at. */
export function stationScore(s: ScorecardStation) {
  const delivered = Number(s.delivered) || 0, prev = Number(s.prev_delivered) || 0, daDays = Number(s.da_days) || 0, returns = Number(s.returns) || 0;
  const assigned = Number(s.assigned) || 0;
  const perDa = daDays ? delivered / daDays : 0;
  const prevPerDa = Number(s.prev_da_days) ? prev / Number(s.prev_da_days) : 0;
  const change = prev > 0 ? ((delivered - prev) / prev) * 100 : null;
  const returnRate = delivered + returns ? (returns / (delivered + returns)) * 100 : 0;
  const successPct = s.delivery_success_pct == null
    ? deliverySuccessPct(delivered, assigned)
    : (assigned > 0 ? Number(s.delivery_success_pct) : null);
  const flag = change != null && change <= -20 ? "deliveries down sharply"
    : prevPerDa > 0 && perDa < prevPerDa * 0.8 ? "productivity down"
    : returnRate >= 10 ? "high returns" : "";
  return { delivered, assigned, perDa, change, returnRate, successPct, flag };
}
