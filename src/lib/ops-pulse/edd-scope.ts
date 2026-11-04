import { regionForStation } from './station-board-regions.ts';

export type EddScope = { regions: string[]; clusters: string[]; stations: string[] };
export type EddCluster = { value: string; label: string; stations: string[] };
export const emptyEddScope = (): EddScope => ({ regions: [], clusters: [], stations: [] });

export function scopedStationCodes(codes: string[], clusters: EddCluster[], scope: EddScope): string[] {
  const clusterCodes = new Set(clusters.filter(c => scope.clusters.includes(c.value)).flatMap(c => c.stations));
  return [...new Set(codes)].filter(code => (!scope.regions.length || scope.regions.includes(regionForStation(code)))
    && (!scope.clusters.length || clusterCodes.has(code)) && (!scope.stations.length || scope.stations.includes(code)));
}

/** Ignore a filter's own value when listing its choices, so multi-select can grow. */
export function eddScopeOptions(codes: string[], clusters: EddCluster[], scope: EddScope) {
  const eligibleForClusters = new Set(scopedStationCodes(codes, clusters, { ...scope, clusters: [] }));
  return {
    // Region is the parent: it stays switchable even with child selections.
    regions: [...new Set(codes.map(regionForStation))].sort(),
    clusters: clusters.filter(c => c.stations.some(code => eligibleForClusters.has(code))),
    stations: scopedStationCodes(codes, clusters, { ...scope, stations: [] }).sort(),
  };
}

/** A parent change clears incompatible children instead of leaving hidden, empty filters. */
export function changeEddScope(codes: string[], clusters: EddCluster[], scope: EddScope, key: keyof EddScope, values: string[]): EddScope {
  const next = { ...scope, [key]: [...new Set(values)] };
  const regionCodes = new Set(scopedStationCodes(codes, clusters, { ...next, clusters: [], stations: [] }));
  next.clusters = next.clusters.filter(id => clusters.some(c => c.value === id && c.stations.some(code => regionCodes.has(code))));
  const allowed = new Set(scopedStationCodes(codes, clusters, { ...next, stations: [] }));
  next.stations = next.stations.filter(code => allowed.has(code));
  if (key === 'stations' && next.stations.length) {
    next.clusters = next.clusters.filter(id => clusters.some(c => c.value === id && c.stations.some(code => next.stations.includes(code))));
  }
  return next;
}
