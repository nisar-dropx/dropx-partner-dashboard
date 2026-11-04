/** DOT counts share one retained, date-scoped eligible shipment cohort. */
export type DotTotals = { total: number; dispatched: number; atStation: number; delivered: number; oor: number; failed: number; rejected: number; other: number; dotPct: number };
export const emptyDot = (): DotTotals => ({ total: 0, dispatched: 0, atStation: 0, delivered: 0, oor: 0, failed: 0, rejected: 0, other: 0, dotPct: 0 });
export function parseDotTotals(value: unknown): DotTotals | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const result = emptyDot();
  for (const key of Object.keys(result) as (keyof DotTotals)[]) {
    if (key === 'dotPct') continue;
    const n = Number(raw[key]);
    if (!Number.isFinite(n) || n < 0) return undefined;
    result[key] = n;
  }
  result.dotPct = result.total ? result.delivered / result.total * 100 : 0;
  return result;
}
export function sumDot(rows: DotTotals[]): DotTotals {
  const sum = emptyDot();
  for (const row of rows) for (const key of Object.keys(sum) as (keyof DotTotals)[]) if (key !== 'dotPct') sum[key] += row[key];
  sum.dotPct = sum.total ? sum.delivered / sum.total * 100 : 0;
  return sum;
}
export const isDotView = (view: string) => view === 'dot' || view === 'premium' || view === 'standard';
export function matchesDotMetric(row: {status: string; dotDispatched?: boolean; dotAtStation?: boolean}, header: string): boolean {
  if (header === 'Dispatched') return row.dotDispatched === true;
  if (header === 'At station') return row.dotAtStation === true;
  const status: Record<string, string> = { Delivered: 'Delivered', 'On road': 'OOR', Failed: 'Failed', Rejected: 'Rejected', 'Other / pending': 'Other / pending' };
  return !status[header] || row.status === status[header];
}

export function stationDotTotals(board: {dotVersion?:number;dotPremium?:DotTotals;dotStandard?:DotTotals}, lane:string):DotTotals|undefined {
 if(board.dotVersion!==1) return undefined;
 if(lane==='premium') return board.dotPremium;
 if(lane==='standard') return board.dotStandard;
 return board.dotPremium && board.dotStandard ? sumDot([board.dotPremium,board.dotStandard]) : undefined;
}
