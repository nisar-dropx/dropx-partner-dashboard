"use client";

import { switchOperatingContext } from "@/app/ops-pulse/actions";
import { useMemo, useState } from "react";
import type { CodLocationRow } from "@/lib/ops-pulse/cod";
import { locationLabel } from "@/lib/ops-pulse/cod";
import type { OperatingMode } from "@/lib/ops-pulse/operating-context";

function unique(values: Array<string | null | undefined>) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))].sort();
}

function toggle(values: string[], value: string) {
  return values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value];
}

function clusterManagerNames(location: CodLocationRow) {
  return location.cluster_manager_names?.length
    ? location.cluster_manager_names
    : [location.cluster_manager].filter(Boolean) as string[];
}

function reportingAuthorityOptions(location: CodLocationRow) {
  if (location.reporting_authorities?.length) {
    return location.reporting_authorities.map((person) => `${person.name} · ${person.role}`);
  }
  return (location.aom_names?.length ? location.aom_names : [location.aom].filter(Boolean) as string[])
    .map((name) => `${name} · Area Operations Manager`);
}

function MultiFilter({ label, options, values, onChange, emptyText }: {
  label: string;
  options: string[];
  values: string[];
  onChange: (values: string[]) => void;
  emptyText?: string;
}) {
  if (!options.length) return <div className="ops-scope-fixed"><small>{label}</small><strong>{emptyText ?? "Not configured"}</strong></div>;
  if (options.length === 1) return <div className="ops-scope-fixed"><small>{label}</small><strong>{options[0]}</strong></div>;
  return (
    <fieldset>
      <legend>{label}</legend>
      <div className="ops-scope-options">
        {options.map((option) => (
          <label key={option}>
            <input type="checkbox" checked={values.includes(option)} onChange={() => onChange(toggle(values, option))} />
            <span>{option}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function OpsContextSwitcher({
  availableModes,
  locationId,
  locationModes,
  locations,
  mode,
  selectedLocationIds
}: {
  availableModes: Array<{ code: OperatingMode; label: string }>;
  locationId: string;
  locationModes: Record<string, OperatingMode | null>;
  locations: CodLocationRow[];
  mode: OperatingMode;
  selectedLocationIds: string[];
}) {
  const selectedRows = locations.filter((location) => selectedLocationIds.includes(location.id));
  const [selectedMode, setSelectedMode] = useState(mode);
  const [regions, setRegions] = useState(unique(selectedRows.map((location) => location.region)));
  const [authorities, setAuthorities] = useState(unique(selectedRows.flatMap(reportingAuthorityOptions)));
  const [managers, setManagers] = useState(unique(selectedRows.flatMap(clusterManagerNames)));
  const [selectedIds, setSelectedIds] = useState(selectedLocationIds);
  const [autoSelectAll, setAutoSelectAll] = useState(false);
  const [locationQuery, setLocationQuery] = useState("");
  const modeLocations = useMemo(
    () => locations.filter((location) => locationModes[location.id] === selectedMode),
    [locationModes, locations, selectedMode]
  );
  const regionOptions = unique(modeLocations.map((location) => location.region));
  const regionLocations = regions.length ? modeLocations.filter((location) => regions.includes(String(location.region))) : modeLocations;
  const authorityOptions = unique(regionLocations.flatMap(reportingAuthorityOptions));
  const authorityLocations = authorities.length
    ? regionLocations.filter((location) => reportingAuthorityOptions(location).some((authority) => authorities.includes(authority)))
    : regionLocations;
  const managerOptions = unique(authorityLocations.flatMap(clusterManagerNames));
  const filteredLocations = managers.length
    ? authorityLocations.filter((location) => clusterManagerNames(location).some((manager) => managers.includes(manager)))
    : authorityLocations;
  const visibleLocations = locationQuery.trim()
    ? filteredLocations.filter((location) => locationLabel(location).toLowerCase().includes(locationQuery.trim().toLowerCase()))
    : filteredLocations;
  const selectedCount = selectedLocationIds.filter((id) => modeLocations.some((location) => location.id === id)).length || 1;

  function changeMode(next: OperatingMode) {
    setSelectedMode(next);
    setRegions([]);
    setAuthorities([]);
    setManagers([]);
    setSelectedIds([]);
    setAutoSelectAll(true);
  }

  function selectHierarchy(next: () => void) {
    next();
    setSelectedIds([]);
    setAutoSelectAll(true);
  }

  function toggleLocation(id: string) {
    const current = autoSelectAll ? filteredLocations.map((location) => location.id) : selectedIds;
    setSelectedIds(toggle(current, id));
    setAutoSelectAll(false);
  }

  if (locations.length === 1) {
    return <div className="ops-scope-single"><small>OPS SCOPE</small><strong>{locationLabel(locations[0])}</strong></div>;
  }

  return (
    <details className="ops-scope-menu">
      <summary><span>Scope</span><strong>{selectedCount} location{selectedCount === 1 ? "" : "s"}</strong><i>⌄</i></summary>
      <form action={switchOperatingContext} className="ops-scope-popover">
        <header><div><small>OPSPULSE FILTER</small><strong>Select operational scope</strong></div><span>{filteredLocations.length} available</span></header>
        <div className="ops-scope-grid">
          <fieldset>
            <legend>Model</legend>
            <div className="ops-scope-options">
              {availableModes.map((entry) => <label key={entry.code}><input type="radio" name="mode" value={entry.code} checked={selectedMode === entry.code} onChange={() => changeMode(entry.code)} /><span>{entry.label}</span></label>)}
            </div>
          </fieldset>
          <MultiFilter label="Region" options={regionOptions} values={regions} onChange={(value) => selectHierarchy(() => { setRegions(value); setAuthorities([]); setManagers([]); })} />
          <MultiFilter label="Reporting authority" options={authorityOptions} values={authorities} emptyText="Not assigned in People" onChange={(value) => selectHierarchy(() => { setAuthorities(value); setManagers([]); })} />
          <MultiFilter label="Cluster Manager" options={managerOptions} values={managers} emptyText="Not assigned in People" onChange={(value) => selectHierarchy(() => setManagers(value))} />
        </div>
        <fieldset className="ops-location-picker">
          <legend>Locations</legend>
          <div className="ops-location-tools">
            <input aria-label="Search locations" placeholder="Search code or location" value={locationQuery} onChange={(event) => setLocationQuery(event.target.value)} />
            <button type="button" onClick={() => { setSelectedIds(filteredLocations.map((location) => location.id)); setAutoSelectAll(false); }}>Select all</button>
            <button type="button" onClick={() => { setSelectedIds([]); setAutoSelectAll(false); }}>Clear</button>
          </div>
          <div className="ops-scope-options">
            {visibleLocations.map((location) => (
              <div className="ops-location-option" key={location.id}>
                <label>
                  <input name="locations" type="checkbox" value={location.id} checked={autoSelectAll || selectedIds.includes(location.id)} onChange={() => toggleLocation(location.id)} />
                  <span>{locationLabel(location)}</span>
                </label>
                <button type="button" onClick={() => { setSelectedIds([location.id]); setAutoSelectAll(false); }}>Only</button>
              </div>
            ))}
          </div>
        </fieldset>
        <footer><small>Only locations assigned to your user are shown.</small><button type="submit">Apply scope</button></footer>
      </form>
    </details>
  );
}
