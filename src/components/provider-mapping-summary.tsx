"use client";

import {useEffect, useMemo, useRef, useState} from "react";
import {
  buildProviderMappingSummary,
  providerMappingSummaryTotals,
  type ProviderMappingSummaryMappingInput,
  type ProviderMappingSummaryMethodInput,
  type ProviderMappingSummarySourceInput,
  type ProviderMappingSummaryStationInput,
  type ProviderMappingSummaryStatus,
  type ProviderMappingSummaryWorkerInput
} from "@/lib/provider-mapping-summary";

const statusLabel: Record<ProviderMappingSummaryStatus, string> = {
  ready: "Ready",
  unmapped: "Mapping missing",
  identity_missing: "DropX data missing",
  payment_missing: "Pay data missing",
  partial_coverage: "Partial coverage",
  source_missing: "Source data missing"
};

type FilterOption = {value: string; label: string; meta?: string};

type ProviderMappingSummaryProps = {
  stations: ProviderMappingSummaryStationInput[];
  sourceMembers: ProviderMappingSummarySourceInput[];
  mappings: ProviderMappingSummaryMappingInput[];
  workers: ProviderMappingSummaryWorkerInput[];
  methods: ProviderMappingSummaryMethodInput[];
  availableMonths: string[];
  initialMonth: string;
};

function monthLabel(value: string) {
  const [year, month] = value.split("-").map(Number);
  if (!year || !month) return value;
  return new Intl.DateTimeFormat("en-IN", {month: "short", year: "numeric", timeZone: "UTC"})
    .format(new Date(Date.UTC(year, month - 1, 1)));
}

function CompactMultiSelect({label, allLabel, options, selected, onChange}: {
  label: string;
  allLabel: string;
  options: FilterOption[];
  selected: string[];
  onChange: (value: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return !term ? options : options.filter(option => `${option.label} ${option.meta ?? ""}`.toLowerCase().includes(term));
  }, [options, search]);
  const summary = !selected.length ? allLabel : selected.length === 1
    ? options.find(option => option.value === selected[0])?.label ?? selected[0]
    : `${selected.length} ${label.toLowerCase()} selected`;

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  const toggle = (value: string) => onChange(selectedSet.has(value)
    ? selected.filter(item => item !== value)
    : [...selected, value]);

  return <div className="mapping-summary-multi" ref={root}>
    <button aria-expanded={open} className={`mapping-summary-multi-trigger ${open ? "open" : ""}`} onClick={() => setOpen(value => !value)} type="button">
      <span><small>{label}</small><strong>{summary}</strong></span><b aria-hidden="true">⌄</b>
    </button>
    {open ? <div className="mapping-summary-multi-menu" role="dialog" aria-label={`${label} filter`}>
      <input aria-label={`Search ${label}`} className="field" placeholder={`Search ${label.toLowerCase()}`} type="search" value={search} onChange={event => setSearch(event.target.value)} />
      <button className={`mapping-summary-multi-all ${!selected.length ? "selected" : ""}`} type="button" onClick={() => onChange([])}>
        <span>{allLabel}</span><small>{options.length} available</small>
      </button>
      <div className="mapping-summary-multi-options">
        {visible.map(option => <label className={selectedSet.has(option.value) ? "selected" : ""} key={option.value}>
          <input checked={selectedSet.has(option.value)} type="checkbox" onChange={() => toggle(option.value)} />
          <span><strong>{option.label}</strong>{option.meta ? <small>{option.meta}</small> : null}</span>
        </label>)}
        {!visible.length ? <p>No matching options.</p> : null}
      </div>
      <button className="button secondary compact" type="button" onClick={() => setOpen(false)}>Done</button>
    </div> : null}
  </div>;
}

export function ProviderMappingSummary({stations, sourceMembers, mappings, workers, methods, availableMonths, initialMonth}: ProviderMappingSummaryProps) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [selectedId, setSelectedId] = useState("");
  const [selectedStations, setSelectedStations] = useState<string[]>([]);
  const [selectedClusters, setSelectedClusters] = useState<string[]>([]);
  const [selectedRegions, setSelectedRegions] = useState<string[]>([]);
  const [selectedMonths, setSelectedMonths] = useState<string[]>([initialMonth]);

  const monthOptions = useMemo(() => availableMonths.map(value => ({value, label: monthLabel(value)})), [availableMonths]);
  const monthly = useMemo(() => buildProviderMappingSummary({stations, sourceMembers, mappings, workers, methods, selectedMonths}),
    [mappings, methods, selectedMonths, sourceMembers, stations, workers]);
  const stationOptions = useMemo(() => monthly.map(station => ({
    value: station.stationId, label: station.stationCode, meta: station.stationName || "Name unavailable"
  })).sort((left, right) => left.label.localeCompare(right.label)), [monthly]);
  const clusterOptions = useMemo(() => [...new Set(stations.map(station => String(station.cluster || "Unassigned").trim() || "Unassigned"))]
    .sort().map(value => ({value, label: value})), [stations]);
  const regionOptions = useMemo(() => [...new Set(stations.map(station => String(station.region || "Unassigned").trim() || "Unassigned"))]
    .sort().map(value => ({value, label: value})), [stations]);
  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    const stationSet = new Set(selectedStations);
    const clusterSet = new Set(selectedClusters);
    const regionSet = new Set(selectedRegions);
    return monthly.filter(station => {
      const issueCount = station.unmapped + station.dataIssues;
      const statusMatch = status === "all" || (status === "attention" ? issueCount > 0 : issueCount === 0);
      const queryMatch = !term || `${station.stationCode} ${station.stationName} ${station.cluster} ${station.region}`.toLowerCase().includes(term);
      return statusMatch && queryMatch
        && (!stationSet.size || stationSet.has(station.stationId))
        && (!clusterSet.size || clusterSet.has(station.cluster))
        && (!regionSet.size || regionSet.has(station.region));
    });
  }, [monthly, query, selectedClusters, selectedRegions, selectedStations, status]);
  const totals = useMemo(() => providerMappingSummaryTotals(filtered), [filtered]);
  const selected = monthly.find(station => station.stationId === selectedId);
  const activeMonthLabel = !selectedMonths.length ? "all available months" : selectedMonths.map(monthLabel).join(", ");

  return <section className="mapping-summary-workspace">
    <div className="mapping-summary-filterbar" aria-label="Mapping summary filters">
      <CompactMultiSelect allLabel="All stations" label="Station" options={stationOptions} selected={selectedStations} onChange={setSelectedStations} />
      <CompactMultiSelect allLabel="All clusters" label="Cluster" options={clusterOptions} selected={selectedClusters} onChange={setSelectedClusters} />
      <CompactMultiSelect allLabel="All regions" label="Region" options={regionOptions} selected={selectedRegions} onChange={setSelectedRegions} />
      <CompactMultiSelect allLabel="All available months" label="Month" options={monthOptions} selected={selectedMonths} onChange={setSelectedMonths} />
      <button className="button secondary compact mapping-summary-clear" type="button" onClick={() => {
        setSelectedStations([]); setSelectedClusters([]); setSelectedRegions([]); setSelectedMonths([initialMonth]); setStatus("all"); setQuery("");
      }}>Reset</button>
    </div>

    <div className="mapping-summary-cards" aria-label="Mapping totals">
      <article><span>Stations in scope</span><strong>{totals.stations}</strong><small>{totals.total} provider IDs · {activeMonthLabel}</small></article>
      <article className="is-positive"><span>Ready</span><strong>{totals.ready}</strong><small>{totals.completionPercent}% of activity covered</small></article>
      <article><span>Mapped</span><strong>{totals.mapped}</strong><small>DropX ID linked</small></article>
      <article className={totals.unmapped ? "is-negative" : "is-positive"}><span>Mapping missing</span><strong>{totals.unmapped}</strong><small>Needs ID mapping</small></article>
      <article className={totals.dataIssues ? "is-warning" : "is-positive"}><span>Data issues</span><strong>{totals.dataIssues}</strong><small>Coverage, identity, pay or source</small></article>
    </div>

    <div className="panel mapping-summary-panel">
      <div className="panel-head mapping-summary-toolbar">
        <div><h2>Station mapping summary</h2><p className="subtle">Mapping periods are checked against actual provider activity in {activeMonthLabel}.</p></div>
        <div className="mapping-summary-filters">
          <input aria-label="Find station" className="field" placeholder="Station, cluster or region" type="search" value={query} onChange={event => setQuery(event.target.value)} />
          <select aria-label="Summary status" className="field" value={status} onChange={event => setStatus(event.target.value)}>
            <option value="attention">Needs attention</option><option value="complete">Complete</option><option value="all">All stations</option>
          </select>
        </div>
      </div>
      <div className="table-wrap mapping-summary-table-wrap">
        <table className="mapping-summary-table">
          <thead><tr><th>Station</th><th>Cluster / region</th><th>Total IDs</th><th>Mapped</th><th>Ready</th><th>Mapping missing</th><th>Data issues</th><th>Completion</th><th>Details</th></tr></thead>
          <tbody>{filtered.map(station => {
            const needsAttention = station.unmapped + station.dataIssues > 0;
            return <tr key={station.stationId} className={needsAttention ? "needs-attention" : "is-complete"}>
              <td><strong>{station.stationCode}</strong>{station.stationName ? <small>{station.stationName}</small> : null}</td>
              <td><strong>{station.cluster}</strong><small>{station.region}</small></td>
              <td>{station.total}</td><td>{station.mapped}</td><td><span className="mapping-count positive">{station.ready}</span></td>
              <td><span className={`mapping-count ${station.unmapped ? "negative" : "muted"}`}>{station.unmapped}</span></td>
              <td><span className={`mapping-count ${station.dataIssues ? "warning" : "muted"}`}>{station.dataIssues}</span></td>
              <td><div className="mapping-completion"><span><i style={{width:`${station.completionPercent}%`}} /></span><strong>{station.completionPercent}%</strong></div></td>
              <td><button className="button secondary compact" type="button" onClick={() => setSelectedId(station.stationId)}>{station.total ? "View IDs" : "View"}</button></td>
            </tr>;
          })}{!filtered.length ? <tr><td className="mapping-summary-empty" colSpan={9}>No stations match the selected filters.</td></tr> : null}</tbody>
        </table>
      </div>
      <div className="mapping-summary-footer"><span>{filtered.length} of {monthly.length} stations</span><span>One-day mappings count only on their exact effective date.</span></div>
    </div>

    {selected ? <div className="mapping-summary-overlay" role="presentation" onMouseDown={event => {if (event.target === event.currentTarget) setSelectedId("");}}>
      <section aria-labelledby="mapping-summary-detail-title" aria-modal="true" className="mapping-summary-drawer" role="dialog">
        <header><div><p>STATION DETAIL · {activeMonthLabel.toUpperCase()}</p><h2 id="mapping-summary-detail-title">{selected.stationCode}{selected.stationName ? ` · ${selected.stationName}` : ""}</h2><span>{selected.total} IDs · {selected.ready} ready · {selected.unmapped + selected.dataIssues} need attention</span></div><button aria-label="Close station details" type="button" onClick={() => setSelectedId("")}>×</button></header>
        <div className="table-wrap mapping-summary-detail-table"><table><thead><tr><th>Provider ID / name</th><th>DropX ID / name</th><th>Payment method</th><th>Activity coverage</th><th>Last activity</th><th>Status</th></tr></thead>
          <tbody>{selected.details.map(detail => <tr key={detail.key}>
            <td><strong>{detail.providerMemberId}</strong><small>{detail.providerMemberName || "Name unavailable"}</small></td>
            <td><strong>{detail.dropxId || "—"}</strong><small>{detail.dropxName || "Not mapped"}</small></td>
            <td>{detail.paymentMethod || "—"}</td><td><strong>{detail.coverageLabel}</strong><small>{detail.coveragePercent}% covered</small></td><td>{detail.lastSeen || "—"}</td>
            <td><span className={`mapping-status ${detail.status}`}>{statusLabel[detail.status]}</span>{detail.issues.length ? <small className="mapping-issues">{detail.issues.join(" · ")}</small> : null}</td>
          </tr>)}{!selected.details.length ? <tr><td colSpan={6}>No provider IDs are available for this station and month.</td></tr> : null}</tbody>
        </table></div>
      </section>
    </div> : null}
  </section>;
}
