import { cpsReviewItems, cpsStationGroups, summarizeCps, type CpsPlace, type CpsSnapshot } from './cps';
import { hawkeyeValueForTarget } from './hawkeye';
import { selectStationDailyRow } from './performance-source-policy';
import type { PerformanceTarget } from './performance-targets';

export type CommandPerformanceFact = {
  id: string; batch_id: string; source_type: string; report_date: string | null;
  station_code: string | null; created_at: string; values_json: unknown;
};
export type CommandReview = { id: string; station_code: string; source_date: string; status: string };
export type CommandPlace = CpsPlace & { owner?: string };
export type CommandPeriod = { from: string; to: string; days: number };

export function commandCostHref(period: CommandPeriod, codes: string[], station?: string, view = 'overview') {
  return `/cps?${new URLSearchParams({ period: 'custom', from: period.from, to: period.to,
    scope: codes.join(','), ...(station ? { station } : {}), view })}`;
}

// Same dated cost ledger and denominator as the CPS workspace. Never average
// station ratios, substitute imported CPS, or turn missing targets into zero.
export function buildCommandCenter(input: {
  snapshot: CpsSnapshot | null; places: CommandPlace[]; period: CommandPeriod;
  performance: CommandPerformanceFact[] | null; targets: PerformanceTarget[] | null;
  reviews: CommandReview[] | null; performanceDate: string;
}) {
  const { period, places, snapshot } = input;
  const codes = new Set(places.map(p => p.code));
  const daily = (snapshot?.daily ?? []).filter(d => codes.has(d.station_code) && d.work_date >= period.from && d.work_date <= period.to);
  const groups = cpsStationGroups(places);
  const issues=snapshot?cpsReviewItems(snapshot):{gaps:[],bills:[]};
  const rows = groups.map(group => {
    const members = new Set(group.members);
    const days = daily.filter(d => members.has(d.station_code));
    const summary = snapshot ? summarizeCps(days) : null;
    const gaps = issues.gaps.filter(g => members.has(g.station_code) && g.last_date >= period.from && g.first_date <= period.to);
    const issueCount=gaps.length+issues.bills.filter(b=>members.has(b.station_code)&&b.period_to>=period.from&&b.period_from<=period.to).length;
    const expectedDays = period.days * group.members.length;
    const observedDays = new Set(days.filter(d => d.shipment_present).map(d => `${d.station_code}|${d.work_date}`)).size;
    const missingDays = Math.max(0, expectedDays - observedDays);
    const latest = days.filter(d => d.shipment_present).map(d => d.work_date).sort().at(-1) ?? null;
    const performanceRows = input.performance === null ? null : group.members.map(code => selectStationDailyRow(input.performance!, input.performanceDate, code, v => (v || '').trim().toUpperCase())).filter(Boolean);
    let measured = 0, missed = 0;
    for (const row of performanceRows ?? []) for (const target of input.targets ?? []) {
      if (!target.isActive || target.target === null) continue;
      const value = hawkeyeValueForTarget(row!.values_json, target.metricKey);
      if (value === null) continue;
      measured++;
      if (target.direction === 'higher' ? value < target.target : value > target.target) missed++;
    }
    const openReviews = input.reviews === null ? null : input.reviews.filter(r => members.has(r.station_code)).length;
    const provisional = !summary || !days.length || summary.provisional || missingDays > 0 || issueCount > 0;
    const aboveTarget = summary?.gap != null && summary.gap > 0;
    const owner = [...new Set(places.filter(p => members.has(p.code)).map(p => p.owner).filter(Boolean))].join(', ');
    return { ...group, owner, summary, missingDays, expectedDays, observedDays, latest, gaps: issueCount,
      missed: input.performance === null || input.targets === null ? null : missed,
      measured, performanceRows: performanceRows?.length ?? null, openReviews, provisional, aboveTarget,
      priority: (missingDays ? 4 : 0) + (issueCount ? 3 : 0) + (aboveTarget ? 2 : 0) + (missed ? 2 : 0) + (openReviews ? 1 : 0) };
  }).sort((a,b) => b.priority - a.priority || (b.summary?.impact ?? 0) - (a.summary?.impact ?? 0) || a.code.localeCompare(b.code));
  const total = snapshot ? summarizeCps(daily) : null;
  const trend = [];
  for (let value = period.from; value <= period.to; value = new Date(Date.parse(value + 'T00:00:00Z') + 86400000).toISOString().slice(0,10)) {
    const days = daily.filter(d => d.work_date === value);
    const summary = summarizeCps(days);
    const observed = new Set(days.filter(d => d.shipment_present).map(d => d.station_code)).size;
    trend.push({ date: value, deliveries: observed ? summary.deliveries : null, returns: observed ? summary.returns : null,
      shipments: observed ? summary.shipments : null, cost: snapshot ? summary.total : null, observed, expected: codes.size });
  }
  const expected = period.days * codes.size;
  const observed = rows.reduce((n,r) => n + r.observedDays, 0);
  return { rows, total, trend, expected, observed, missingDays: expected - observed,
    aboveTarget: rows.filter(r => r.aboveTarget).length,
    missingTargets: rows.filter(r => r.summary?.target == null).length,
    dataGaps: rows.filter(r => r.provisional).length,
    performanceRisk: input.performance === null || input.targets === null || !rows.some(r => r.measured) ? null : rows.filter(r => (r.missed ?? 0) > 0).length,
    performanceMissing: rows.filter(r => r.performanceRows === null || r.performanceRows < r.members.length || !r.measured).length,
    reviewCount: input.reviews === null ? null : rows.reduce((n,r) => n + (r.openReviews ?? 0), 0),
    latest: daily.filter(d => d.shipment_present).map(d => d.work_date).sort().at(-1) ?? null,
    // Only a complete target scope supports a network target/impact claim.
    provisional: !snapshot || rows.some(r => r.provisional),
    sourceDates: snapshot?.source_dates ?? null,
    costs: total ? [{ label:'DA', amount:total.da }, { label:'Station team', amount:total.utr },
      { label:'Van', amount:total.van }, { label:'Facility rent', amount:total.rent },
      { label:'Overhead', amount:total.overhead }, { label:'Other', amount:total.other }].sort((a,b) => b.amount-a.amount) : [] };
}
export type CommandCenterModel = ReturnType<typeof buildCommandCenter>;

export function filterCommandRows(rows:CommandCenterModel['rows'],search:string,filter:string) {
  const query=search.trim().toLowerCase();
  return rows.filter(r=>`${r.code} ${r.name} ${r.search} ${r.owner}`.toLowerCase().includes(query) &&
    (filter==='all' || filter==='cost'&&r.aboveTarget || filter==='data'&&r.provisional ||
      filter==='performance'&&(r.missed??0)>0 || filter==='reviews'&&(r.openReviews??0)>0));
}
