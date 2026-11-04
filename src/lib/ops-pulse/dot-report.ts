import type { StationBoardStation } from './station-board.ts';
import { dsrHeatColor, dsrPctTextColor } from './station-board.ts';
import type { BoardShareCell, BoardShareTable } from './station-board-share';
import { sumDot, type DotTotals } from './dot-metrics.ts';
export function dotStationTable(stations: StationBoardStation[], lane: 'premium' | 'standard'): BoardShareTable {
  const totals = stations.map(s => s.board.dotVersion === 1 ? (lane === 'premium' ? s.board.dotPremium : s.board.dotStandard) : undefined);
  const keys = ['total', 'dispatched', 'atStation', 'oor', 'delivered', 'failed', 'rejected', 'other'] as const;
  const cells = (name: string, t?: DotTotals): BoardShareCell[] => [
    {text: name, bold: true, align: 'left'},
    ...keys.map(key => ({text: t ? String(t[key]) : '—', align: 'right' as const})),
    {text: t?.total ? `${t.dotPct.toFixed(1)}%` : '—', align: 'right', ...(t?.total ? {bg: dsrHeatColor(t.dotPct), color: dsrPctTextColor(t.dotPct)} : {})},
  ];
  return {title: lane === 'premium' ? 'Premium DOT' : 'AFN Standard DOT', subtitle: '', headers: ['Station','Eligible','Dispatched','At station','On road','Delivered','Failed','Rejected','Other / pending','DOT%'],
    rows: [...stations.map((s,i) => cells(s.stationCode,totals[i])), cells('Grand Total', totals.every(Boolean) ? sumDot(totals as DotTotals[]) : undefined)]};
}
