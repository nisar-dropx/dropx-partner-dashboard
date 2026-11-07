import type {Dimension, Entry, OverheadPool, Report} from './model';

export interface StationPnlSummary {
  station: string;
  dimension: Dimension;
  entries: Entry[];
  revenue: number;
  recovery: number;
  directExpense: number;
  operatingExpense: number;
  chargebacks: number;
  lossBreakdown: {package: number; cod: number; other: number};
  regionalHo: number;
  regionalHoPending: boolean;
  corporateHo: number | null;
  corporateEntries: Entry[];
  recordedProfit: number;
  net: number;
  profit: number;
  complete: boolean;
  issues: string[];
}

const regionalEntry = (entry: Entry) => entry.id.startsWith('ho-allocation:');
const sum = (entries: Entry[]) => entries.reduce((total, entry) => total + entry.paise, 0);
const dimension = (report: Report, code: string): Dimension => report.dimensions?.find(item => item.code === code) ?? {
  code, name: code, region: 'Unassigned', state: 'Unassigned', model: 'Unassigned',
  cluster: 'Unassigned', managers: ['Unassigned'], isHo: false
};

/** Only explicit loss descriptions are classified; the Ops loss register is not
 * another expense. Every classified debit remains inside directExpense once. */
export function stationLossCategory(entry: Pick<Entry, 'side' | 'head' | 'description'>): 'package' | 'cod' | 'other' | null {
  if (entry.side !== 'expense') return null;
  const text = `${entry.head} ${entry.description}`;
  if (!/loss|chargeback|(?:cash|cod)\s*(?:debit|recovery|shortage|shortfall)/i.test(text)) return null;
  if (/\bcod\b|cash\s+on\s+delivery|cash\s+(?:loss|shortage|shortfall)/i.test(text)) return 'cod';
  if (/package|parcel|shipment|\bnnl\b|\bnl\b/i.test(text)) return 'package';
  return 'other';
}

function poolApplies(pool: OverheadPool, row: StationPnlSummary) {
  if (pool.mode === 'corporate') {
    const models = pool.rule?.recipient_models;
    return !models?.length || models.includes(row.dimension.model);
  }
  const recipients = pool.rule?.recipient_codes;
  // A pool without configured recipients has unknown scope, never a proven zero.
  return !recipients?.length || recipients.includes(row.station)
    || pool.allocations.some(entry => entry.station === row.station);
}

/** Build the full-company cohort first; the caller filters returned rows only.
 * Corporate cost keeps the saved vertical split, then follows recorded revenue
 * within each vertical. No weights, totals or source entries are mutated. */
export function buildStationSummary(report: Report) {
  const active = report.entries.filter(entry => !entry.deleted);
  const rows: StationPnlSummary[] = [...new Set(report.stations)].sort()
    .filter(code => !dimension(report, code).isHo && !/^HO(?:_|$)/i.test(code))
    .map(station => {
      const entries = active.filter(entry => entry.station === station);
      const revenues = entries.filter(entry => entry.side === 'income' && !entry.recovery);
      const recoveries = entries.filter(entry => entry.side === 'income' && entry.recovery);
      const direct = entries.filter(entry => entry.side === 'expense' && !regionalEntry(entry));
      const regional = entries.filter(entry => entry.side === 'expense' && regionalEntry(entry));
      const lossBreakdown = {package: 0, cod: 0, other: 0};
      for (const entry of direct) {
        const category = stationLossCategory(entry);
        if (category) lossBreakdown[category] += entry.paise;
      }
      const issues: string[] = [];
      if (!revenues.length) issues.push('Revenue is not recorded for this station.');
      if (!direct.length) issues.push('Direct expenses are not recorded for this station.');
      const revenue = sum(revenues), recovery = sum(recoveries), directExpense = sum(direct);
      const chargebacks = lossBreakdown.package + lossBreakdown.cod + lossBreakdown.other;
      const regionalHo = sum(regional), recordedProfit = revenue + recovery - directExpense - regionalHo;
      return {
        station, dimension: dimension(report, station), entries, revenue, recovery,
        directExpense, operatingExpense: directExpense - chargebacks, chargebacks, lossBreakdown,
        regionalHo, regionalHoPending: false, corporateHo: 0, corporateEntries: [],
        recordedProfit, net: recordedProfit, profit: recordedProfit, complete: false, issues
      };
    });
  const issues: string[] = [];
  let unallocatedCorporate = 0;
  const blockCorporate = (affected: StationPnlSummary[], message: string) => {
    for (const row of affected) { row.corporateHo = null; row.issues.push(message); }
    issues.push(message);
  };
  for (const pool of report.overheadPools ?? []) {
    const affected = rows.filter(row => poolApplies(pool, row));
    if (pool.mode === 'regional') {
      if (pool.unallocated !== 0 || pool.income !== 0) {
        const missingSources = pool.rule?.allocation === 'volume'
          ? (report.volumes ?? []).filter(volume => affected.some(row => row.station === volume.station) && volume.missingSources.length)
            .map(volume => `${volume.station} → ${volume.missingSources.join(', ')}`) : [];
        const message = `${pool.code}: ${pool.income ? 'regional HO income has not been allocated to stations.' : pool.issue || 'regional HO allocation is pending.'}${missingSources.length ? ` Missing shipment sources: ${missingSources.join('; ')}. Review the shipment feed and Billing Period Master reporting date.` : ''}`;
        for (const row of affected) { row.regionalHoPending = true; row.issues.push(message); }
        issues.push(message);
      }
      continue;
    }
    if (pool.unallocated !== 0) {
      unallocatedCorporate += pool.unallocated;
      blockCorporate(affected, `${pool.code}: ${pool.issue || 'corporate HO allocation is pending.'}`);
    }
    for (const share of pool.corporateShares) {
      if (!share.paise) continue;
      const recipients = rows.filter(row => row.dimension.model === share.model);
      const missing = recipients.filter(row => !row.entries.some(entry => entry.side === 'income' && !entry.recovery));
      const denominator = recipients.reduce((total, row) => total + Math.max(0, row.revenue), 0);
      if (!recipients.length || missing.length || denominator <= 0) {
        unallocatedCorporate += share.paise;
        blockCorporate(recipients, `${pool.code}: ${share.model} station split awaits ${missing.length ? `revenue for ${missing.map(row => row.station).join(', ')}` : 'positive station revenue'}.`);
        continue;
      }
      let cumulative = 0, previous = 0;
      for (const row of recipients) {
        const weight = Math.max(0, row.revenue);
        cumulative += weight;
        const next = Math.round(share.paise * cumulative / denominator);
        const paise = next - previous;
        previous = next;
        if (row.corporateHo !== null) row.corporateHo += paise;
        if (!paise) continue;
        row.corporateEntries.push({
          id: `corporate-ho-allocation:${pool.code}:${share.model}:${row.station}`,
          month: report.month, station: row.station, sourceStation: pool.code,
          side: 'expense', head: 'Corporate HO allocation',
          description: `${pool.code} Corporate · ${share.model} share allocated by station revenue`,
          paise, source: 'Corporate HO allocation', reference: pool.code,
          date: `${report.month}-01`,
          details: [{date: `${report.month}-01`, paise, reference: pool.code,
            label: `${(100 * weight / denominator).toFixed(2)}% of ${share.model} corporate share · station revenue ₹${(weight / 100).toFixed(2)} / ₹${(denominator / 100).toFixed(2)}`}]
        });
      }
    }
  }
  for (const row of rows) {
    row.issues = [...new Set(row.issues)];
    row.complete = !row.issues.length && row.corporateHo !== null && !row.regionalHoPending;
    row.recordedProfit -= sum(row.corporateEntries);
    // Coverage is an alert, not a reason to hide the current recorded result.
    row.net = row.recordedProfit;
    row.profit = row.net;
  }
  const stationCodes = new Set(rows.map(row => row.station));
  const unassignedEntries = active.filter(entry => !stationCodes.has(entry.station));
  if (unassignedEntries.length) issues.push(`${unassignedEntries.length} entries have no active station assignment and remain outside station totals.`);
  return {rows, unassignedEntries, unallocatedCorporate, issues: [...new Set(issues)]};
}
