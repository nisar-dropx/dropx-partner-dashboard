import { cpsStationGroups, summarizeCps, type CpsPlace, type CpsSnapshot } from "../../../../src/lib/ops-pulse/cps";

export type ConnectCpsStation = {
  code: string;
  name: string;
  subtitle: string;
  members: string[];
  date: string;
  earliestDate: string;
  value: number | null;
  target: number | null;
  gap: number | null;
  onTarget: boolean | null;
  delivered: number;
  provisional: boolean;
  breakdown: { label: string; cps: number | null }[];
  issues: { label: string; count: number }[];
};

// Return CPS and volume only. Absolute costs, People names, CTC and payroll evidence
// must never enter the DropX One performance response.
export function connectCpsSummary(snapshot: CpsSnapshot, places: CpsPlace[], from: string, through: string) {
  const allowed = new Set(places.map(place => place.code));
  const cutoff = new Map<string, string>();
  for (const day of snapshot.daily) {
    if (!allowed.has(day.station_code) || !day.shipment_present || day.work_date < from || day.work_date > through) continue;
    if (day.work_date > (cutoff.get(day.station_code) ?? "")) cutoff.set(day.station_code, day.work_date);
  }
  const days = snapshot.daily.filter(day => allowed.has(day.station_code) && day.work_date >= from && day.work_date <= (cutoff.get(day.station_code) ?? ""));
  const stations: ConnectCpsStation[] = cpsStationGroups(places).flatMap(group => {
    const rows = days.filter(day => group.members.includes(day.station_code));
    if (!rows.length) return [];
    const total = summarizeCps(rows);
    const dates = group.members.map(member => cutoff.get(member)).filter((date): date is string => Boolean(date)).sort();
    const issues = new Map<string, number>();
    for (const gap of snapshot.gaps ?? []) {
      if (group.members.includes(gap.station_code) && gap.first_date <= (cutoff.get(gap.station_code) ?? "") && gap.last_date >= from) {
        issues.set(gap.kind, (issues.get(gap.kind) ?? 0) + 1);
      }
    }
    const missingStations = group.members.filter(member => !cutoff.has(member)).length;
    if (missingStations) issues.set("Shipment data unavailable", missingStations);
    const amounts = [
      ["DA", total.da], ["UTR", total.utr], ["Van", total.van],
      ["Rent", total.rent], ["Other", total.other + total.overhead],
    ] as const;
    return [{
      code: group.code, name: group.name, subtitle: group.subtitle, members: group.members,
      date: dates.at(-1)!, earliestDate: dates[0], value: total.cps, target: total.target,
      gap: total.gap, onTarget: total.gap == null ? null : total.gap <= 0,
      delivered: total.deliveries,
      provisional: total.provisional || issues.size > 0,
      breakdown: amounts.map(([label, amount]) => ({ label, cps: total.deliveries > 0 ? amount / total.deliveries : null })),
      issues: [...issues].map(([label, count]) => ({ label, count })),
    }];
  });
  const total = summarizeCps(days);
  return { stations, value: total.cps, latestDate: [...cutoff.values()].sort().at(-1) ?? null };
}
