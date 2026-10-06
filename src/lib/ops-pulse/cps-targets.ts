import type { CpsDay } from "./cps";

export type CpsTarget = {
  station_code: string;
  target_cps: number | string;
  effective_from: string;
  is_active: boolean;
};
type Station = {
  id: string; station_code: string; parent_station_id?: string | null;
  location_models?: { code: string } | { code: string }[] | null;
};

// Resolve policy per day, before aggregation, so later revisions never rewrite
// an earlier period. XPT deliveries share the parent's combined CPS target.
export function applyCpsTargets(rows: CpsDay[], revisions: CpsTarget[], stations: Station[]): CpsDay[] {
  const byId = new Map(stations.map(station => [station.id, station]));
  const parent = new Map<string, string>();
  for (const station of stations) {
    const model = Array.isArray(station.location_models) ? station.location_models[0] : station.location_models;
    const base = station.parent_station_id ? byId.get(station.parent_station_id) : null;
    if (model?.code?.toUpperCase() === "XPT" && base) parent.set(station.station_code, base.station_code);
  }
  const history = new Map<string, CpsTarget[]>();
  for (const revision of revisions) {
    if (!revision.is_active || !Number.isFinite(Number(revision.target_cps)) || Number(revision.target_cps) <= 0) continue;
    const entries = history.get(revision.station_code) ?? [];
    entries.push(revision);
    history.set(revision.station_code, entries);
  }
  for (const entries of history.values()) entries.sort((a, b) => b.effective_from.localeCompare(a.effective_from));
  return rows.map(row => {
    const code = parent.get(row.station_code) ?? row.station_code;
    const revision = history.get(code)?.find(entry => entry.effective_from <= row.work_date);
    return { ...row, target: revision ? Number(revision.target_cps) : null };
  });
}
