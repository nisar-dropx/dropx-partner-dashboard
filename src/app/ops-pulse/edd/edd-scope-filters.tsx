"use client";
import { EddMultiSelect } from './edd-multi-select';
import { changeEddScope, eddScopeOptions, type EddCluster, type EddScope } from '@/lib/ops-pulse/edd-scope';
import { regionLabel, type StationBoardRegionId } from '@/lib/ops-pulse/station-board-regions';

export function EddScopeFilters({ codes, clusters, value, onChange, stationNames = {} }: {
  codes: string[]; clusters: EddCluster[]; value: EddScope; onChange: (next: EddScope) => void; stationNames?: Record<string, string>;
}) {
  const options = eddScopeOptions(codes, clusters, value);
  const change = (key: keyof EddScope) => (next: Set<string>) => onChange(changeEddScope(codes, clusters, value, key, [...next]));
  return <>
    <EddMultiSelect label="Regions" options={options.regions} selected={new Set(value.regions)} onChange={change('regions')} renderOption={id => regionLabel(id as StationBoardRegionId)} />
    <EddMultiSelect label="Cluster / AOM" options={options.clusters.map(c => c.value)} selected={new Set(value.clusters)} onChange={change('clusters')} renderOption={id => clusters.find(c => c.value === id)?.label || id} />
    <EddMultiSelect label="Stations" options={options.stations} selected={new Set(value.stations)} onChange={change('stations')} renderOption={code => stationNames[code] ? `${code} · ${stationNames[code]}` : code} />
  </>;
}
