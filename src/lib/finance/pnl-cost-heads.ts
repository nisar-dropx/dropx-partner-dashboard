import type { CfoDay, CfoLine } from './cfo';

export const COST_HEADS = [
  { id: 'DA', label: 'Associate payout', color: '#3578cb' },
  { id: 'UTR', label: 'Station team & manager share', color: '#8b66c4' },
  { id: 'VanRent', label: 'Van rent', color: '#168777' },
  { id: 'AdhocVan', label: 'Ad hoc van', color: '#4e9b85' },
  { id: 'VanMaintenance', label: 'Van maintenance', color: '#b38345' },
  { id: 'VanFuel', label: 'Van fuel', color: '#458eaa' },
  { id: 'VanOther', label: 'Other vehicle costs', color: '#6a8a85' },
  { id: 'Rent', label: 'Station rent & maintenance', color: '#c78635' },
  { id: 'Other', label: 'Other operating costs', color: '#718391' },
] as const;
export type CostHead = typeof COST_HEADS[number]['id'];
export const paise = (amount: number) => Math.round(amount * 100);

/** Classify the included cost once; payment and approval records remain unchanged. */
export function costHead(line: Pick<CfoLine, 'head' | 'source' | 'costHead'>): CostHead {
  const label = line.head.toLowerCase().replace(/[_/-]+/g, ' ');
  if (line.costHead === 'DA') return 'DA'; // Bike/DA fuel allowances stay with associates.
  if (line.costHead === 'UTR') return 'UTR';
  if (line.costHead === 'Rent') return 'Rent';
  if (line.costHead !== 'Van') return 'Other';
  if (/fuel|diesel|petrol/.test(label) || line.source === 'Fuel import') return 'VanFuel';
  if (/maint[ae]n|service|repair|tyre|tire/.test(label)) return 'VanMaintenance';
  if (/driver/.test(label)) return 'DA';
  if (/ad\s*hoc.*van|adhoc.*vehicle/.test(label)) return 'AdhocVan';
  if (/rent|vehicle pay from rate card/.test(label)) return 'VanRent';
  return 'VanOther';
}

/** Source station is required so an XPT is included only with its selected parent. */
export function scopedCostLines(days: CfoDay[], lines: CfoLine[]) {
  const keys = new Set(days.map(d => `${d.sourceStation || d.station}/${d.date}`));
  return lines.filter(l => keys.has(`${l.sourceStation || l.station}/${l.date}`));
}

export function expenseSections(days: CfoDay[], allLines: CfoLine[]) {
  const lines = scopedCostLines(days, allLines).filter(l => l.source !== 'Finance contract');
  const defaults: Record<string, CostHead> = { DA: 'DA', UTR: 'UTR', Van: 'VanOther', Rent: 'Rent', Other: 'Other', Overhead: 'Other' };
  const residual: Record<CostHead, number> = { DA: 0, UTR: 0, VanRent: 0, AdhocVan: 0, VanMaintenance: 0, VanFuel: 0, VanOther: 0, Rent: 0, Other: 0 };
  for (const d of days) {
    residual.DA += paise(d.da); residual.UTR += paise(d.utr);
    residual.VanOther += paise(d.van); residual.Rent += paise(d.rent); residual.Other += paise(d.other);
  }
  const grouped = new Map<CostHead, CfoLine[]>();
  for (const line of lines) {
    const original = defaults[line.costHead || ''];
    if (!original) continue;
    residual[original] -= paise(line.amount);
    const id = costHead(line);
    const entries = grouped.get(id) || []; entries.push(line); grouped.set(id, entries);
  }
  return COST_HEADS.map(h => {
    const entries = grouped.get(h.id) || [];
    return { ...h, lines: entries, residual: residual[h.id] / 100,
      amount: (entries.reduce((sum, l) => sum + paise(l.amount), 0) + residual[h.id]) / 100 };
  }).filter(h => h.amount !== 0 || h.lines.length > 0 || ['DA', 'UTR', 'VanRent', 'VanMaintenance', 'VanFuel', 'Rent'].includes(h.id));
}

/** Same item/source/station becomes one row, with dates available on expansion. */
export function groupCostLines(lines: CfoLine[]) {
  const groups = new Map<string, CfoLine[]>();
  for (const line of lines) {
    const key = JSON.stringify([line.sourceStation || line.station, line.head, line.source]);
    const entries = groups.get(key) || []; entries.push(line); groups.set(key, entries);
  }
  return [...groups].map(([key, entries]) => ({ key, label: entries[0].head,
    station: entries[0].sourceStation || entries[0].station, source: entries[0].source,
    amount: entries.reduce((sum, l) => sum + paise(l.amount), 0) / 100,
    entries: [...entries].sort((a, b) => a.date.localeCompare(b.date)),
  })).sort((a, b) => a.label.localeCompare(b.label) || a.station.localeCompare(b.station));
}
