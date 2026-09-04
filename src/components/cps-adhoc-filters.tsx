"use client";

import { Check, ChevronDown, Search, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

export type AdHocFilterStation = {
  code: string;
  name: string;
  cluster: string;
  region: string;
};

function SelectionMenu({
  allLabel,
  label,
  options,
  selected,
  onChange
}: {
  allLabel: string;
  label: string;
  options: Array<{ value: string; label: string; helper?: string }>;
  selected: string[];
  onChange: (values: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const detailsRef = useRef<HTMLDetailsElement | null>(null);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    return options.filter((option) => !term || `${option.label} ${option.value} ${option.helper ?? ""}`.toLowerCase().includes(term));
  }, [options, query]);
  const summary = selected.length === options.length
    ? allLabel
    : selected.length === 0
      ? "None selected"
    : selected.length === 1
      ? options.find((option) => option.value === selected[0])?.label ?? "1 selected"
      : `${selected.length} selected`;

  function toggle(value: string) {
    onChange(selectedSet.has(value) ? selected.filter((item) => item !== value) : [...selected, value]);
  }

  return (
    <details className="cps-adhoc-filter-menu" ref={detailsRef}>
      <summary><span>{label}</span><strong>{summary}</strong><ChevronDown aria-hidden="true" size={15} /></summary>
      <div className="cps-adhoc-filter-popover">
        <label className="cps-adhoc-filter-search"><Search aria-hidden="true" size={14} /><input aria-label={`Search ${label.toLowerCase()}`} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${label.toLowerCase()}`} value={query} /></label>
        <div className="cps-adhoc-filter-actions">
          <button onClick={() => onChange(options.map((option) => option.value))} type="button">Select all</button>
          <button onClick={() => onChange([])} type="button">Clear</button>
        </div>
        <div className="cps-adhoc-filter-options">
          {visible.map((option) => <label className={selectedSet.has(option.value) ? "selected" : ""} key={option.value}>
            <input checked={selectedSet.has(option.value)} onChange={() => toggle(option.value)} type="checkbox" />
            <span><strong>{option.label}</strong>{option.helper ? <small>{option.helper}</small> : null}</span>
            {selectedSet.has(option.value) ? <Check aria-hidden="true" size={14} /> : null}
          </label>)}
          {!visible.length ? <p>No matching options</p> : null}
        </div>
        <button className="cps-adhoc-filter-done" onClick={() => { detailsRef.current?.removeAttribute("open"); setQuery(""); }} type="button">Done</button>
      </div>
    </details>
  );
}

export function CpsAdHocFilters({
  currentMonth,
  month,
  selectedClusters,
  selectedStations,
  stations
}: {
  currentMonth: string;
  month: string;
  selectedClusters: string[];
  selectedStations: string[];
  stations: AdHocFilterStation[];
}) {
  const pathname = usePathname();
  const router = useRouter();
  const clusters = useMemo(() => [...new Set(stations.map((station) => station.cluster))].sort((left, right) => left.localeCompare(right)), [stations]);
  const [draftMonth, setDraftMonth] = useState(month);
  const [draftClusters, setDraftClusters] = useState(selectedClusters);
  const [draftStations, setDraftStations] = useState(selectedStations);
  const clusterSet = useMemo(() => new Set(draftClusters), [draftClusters]);
  const availableStations = useMemo(() => stations.filter((station) => clusterSet.has(station.cluster)), [clusterSet, stations]);
  const stationByCode = useMemo(() => new Map(stations.map((station) => [station.code, station])), [stations]);

  function updateClusters(values: string[]) {
    const currentSet = new Set(draftClusters);
    const nextSet = new Set(values);
    const addedCodes = stations.filter((station) => nextSet.has(station.cluster) && !currentSet.has(station.cluster)).map((station) => station.code);
    setDraftClusters(values);
    setDraftStations((current) => [...new Set([...current, ...addedCodes])].filter((code) => {
      const station = stationByCode.get(code);
      return station && nextSet.has(station.cluster);
    }));
  }

  function apply() {
    const params = new URLSearchParams();
    if (draftMonth !== currentMonth) params.set("month", draftMonth);
    if (draftClusters.length !== clusters.length) params.set("clusters", draftClusters.length ? draftClusters.join(",") : "_none");
    const availableCodes = availableStations.map((station) => station.code);
    const selectedCodes = draftStations.filter((code) => availableCodes.includes(code));
    if (selectedCodes.length !== availableCodes.length) params.set("stations", selectedCodes.length ? selectedCodes.join(",") : "_none");
    router.push(`${pathname}${params.size ? `?${params.toString()}` : ""}`);
  }

  function reset() {
    setDraftMonth(currentMonth);
    setDraftClusters(clusters);
    setDraftStations(stations.map((station) => station.code));
    router.push(pathname);
  }

  return (
    <section className="cps-adhoc-filters" aria-label="Adhoc activity filters">
      <label className="cps-adhoc-month"><span>Month</span><input max={currentMonth} onChange={(event) => setDraftMonth(event.target.value)} type="month" value={draftMonth} /></label>
      <SelectionMenu
        allLabel="All clusters"
        label="Clusters"
        onChange={updateClusters}
        options={clusters.map((cluster) => ({ value: cluster, label: cluster }))}
        selected={draftClusters}
      />
      <SelectionMenu
        allLabel="All stations"
        label="Stations"
        onChange={setDraftStations}
        options={availableStations.map((station) => ({ value: station.code, label: station.code, helper: `${station.name} · ${station.region}` }))}
        selected={draftStations.filter((code) => availableStations.some((station) => station.code === code))}
      />
      <button className="button cps-adhoc-apply" onClick={apply} type="button">Apply</button>
      <button aria-label="Reset filters" className="button secondary cps-adhoc-reset" onClick={reset} type="button"><X aria-hidden="true" size={14} />Reset</button>
    </section>
  );
}
