import type { CpsDaDetail } from './cps-details';

export type FixedPayLocation = { code: string; name: string; cluster: string; region: string };
export type FixedPayRow = CpsDaDetail & FixedPayLocation & { payType: string; stationName: string };
export const fixedPayDimensions = ['region', 'cluster', 'code', 'payType'] as const;
export type FixedPayDimension = typeof fixedPayDimensions[number];
export type FixedPayFilters = Record<FixedPayDimension, string[]>;
export function fixedPayRows(details: CpsDaDetail[], locations: FixedPayLocation[]): FixedPayRow[] {
  const scope = new Map(locations.map(l => [l.code, l]));
  return details.filter(d => d.cohort === 'guarantee' && scope.has(d.station_code)).map(d => {
    const location = scope.get(d.station_code)!;
    return { ...d, code: location.code, stationName: location.name, cluster: location.cluster, region: location.region,
      payType: d.pay_type?.replaceAll('_', ' ') || 'Fixed / MG' };
  });
}
export function filterFixedPay(rows: FixedPayRow[], filters: FixedPayFilters, search: string, except?: FixedPayDimension) {
  const query = search.trim().toLowerCase();
  return rows.filter(r => (!query || `${r.name} ${r.dropx_id} ${r.provider_ids.join(' ')} ${r.code} ${r.stationName} ${r.cluster} ${r.region} ${r.payType}`.toLowerCase().includes(query))
    && fixedPayDimensions.every(d => d === except || !filters[d].length || filters[d].includes(r[d])));
}
export function fixedPayChoices(rows: FixedPayRow[], filters: FixedPayFilters, search: string, dimension: FixedPayDimension) {
  return [...new Set([...filters[dimension], ...filterFixedPay(rows, filters, search, dimension).map(r => r[dimension])])].sort();
}
export function fixedPayTotals(rows: FixedPayRow[]) {
  const salary = rows.reduce((n, r) => n + r.salary, 0);
  const variable = rows.reduce((n, r) => n + r.variable, 0);
  const fuel = rows.reduce((n, r) => n + r.fuel, 0);
  const deliveries = rows.reduce((n, r) => n + r.deliveries, 0);
  const returns = rows.reduce((n, r) => n + r.customer_returns, 0);
  const pending = new Set(rows.filter(r => r.pending_fixed_dates?.length).map(r => r.worker_id)).size;
  const workDays = new Set(rows.flatMap(r => r.work_dates.map(d => `${r.worker_id}|${d}`))).size;
  const shipments = deliveries + returns, cost = salary + variable + fuel;
  const workers = new Map<string, { cost: number; shipments: number }>();
  for (const row of rows) {
    const w = workers.get(row.worker_id) ?? { cost: 0, shipments: 0 };
    w.cost += row.salary + row.variable + row.fuel;
    w.shipments += row.deliveries + row.customer_returns;
    workers.set(row.worker_id, w);
  }
  return { salary, variable, fuel, cost, deliveries, returns, shipments, pending, workDays,
    associates: new Set(rows.map(r => r.worker_id)).size,
    cps: !pending && shipments > 0 ? cost / shipments : null,
    noVolume: [...workers.values()].filter(w => w.cost > 0 && w.shipments === 0).length };
}
