/**
 * Dark Store Operations scope filters.
 * Region = city (optionally city · state). Managers = City / Regional from People routes.
 * Reuses the same EddScope shape (regions / clusters / stations) so multi-select helpers stay shared.
 */

export type DsScope = { regions: string[]; clusters: string[]; stations: string[] };
export type DsManagerOption = { value: string; label: string; stations: string[] };
export type DsRegionMeta = { value: string; label: string; cities: string[] };
export type DsStoreMeta = { code: string; name: string; city: string | null; state: string | null; regionKey: string };

export const emptyDsScope = (): DsScope => ({ regions: [], clusters: [], stations: [] });

export function dsRegionKey(city: string | null | undefined, state: string | null | undefined): string {
  const c = String(city ?? "").trim();
  const s = String(state ?? "").trim();
  if (c && s) return `${c} · ${s}`;
  if (c) return c;
  if (s) return s;
  return "Unmapped";
}

export function buildDsStoreMeta(stores: { code: string; name?: string | null; city?: string | null; state?: string | null }[]): DsStoreMeta[] {
  return stores.map((store) => {
    const code = String(store.code ?? "").trim().toUpperCase();
    const city = store.city?.trim() || null;
    const state = store.state?.trim() || null;
    return {
      code,
      name: String(store.name ?? code).trim() || code,
      city,
      state,
      regionKey: dsRegionKey(city, state)
    };
  });
}

export function scopedDsStationCodes(stores: DsStoreMeta[], managers: DsManagerOption[], scope: DsScope): string[] {
  const managerCodes = new Set(managers.filter((m) => scope.clusters.includes(m.value)).flatMap((m) => m.stations));
  const byCode = new Map(stores.map((s) => [s.code, s]));
  return [...new Set(stores.map((s) => s.code))].filter((code) => {
    const meta = byCode.get(code);
    if (!meta) return false;
    if (scope.regions.length && !scope.regions.includes(meta.regionKey)) return false;
    if (scope.clusters.length && !managerCodes.has(code)) return false;
    if (scope.stations.length && !scope.stations.includes(code)) return false;
    return true;
  });
}

/** Ignore a filter's own value when listing its choices, so multi-select can grow. */
export function dsScopeOptions(stores: DsStoreMeta[], managers: DsManagerOption[], scope: DsScope) {
  const eligibleForManagers = new Set(scopedDsStationCodes(stores, managers, { ...scope, clusters: [] }));
  const regionKeys = [...new Set(stores.map((s) => s.regionKey))].sort((a, b) => a.localeCompare(b));
  return {
    regions: regionKeys,
    clusters: managers.filter((m) => m.stations.some((code) => eligibleForManagers.has(code))),
    stations: scopedDsStationCodes(stores, managers, { ...scope, stations: [] }).sort()
  };
}

/** A parent change clears incompatible children instead of leaving hidden, empty filters. */
export function changeDsScope(
  stores: DsStoreMeta[],
  managers: DsManagerOption[],
  scope: DsScope,
  key: keyof DsScope,
  values: string[]
): DsScope {
  const next: DsScope = { ...scope, [key]: [...new Set(values)] };
  const regionCodes = new Set(scopedDsStationCodes(stores, managers, { ...next, clusters: [], stations: [] }));
  next.clusters = next.clusters.filter((id) => managers.some((m) => m.value === id && m.stations.some((code) => regionCodes.has(code))));
  const allowed = new Set(scopedDsStationCodes(stores, managers, { ...next, stations: [] }));
  next.stations = next.stations.filter((code) => allowed.has(code));
  if (key === "stations" && next.stations.length) {
    next.clusters = next.clusters.filter((id) => managers.some((m) => m.value === id && m.stations.some((code) => next.stations.includes(code))));
  }
  return next;
}
