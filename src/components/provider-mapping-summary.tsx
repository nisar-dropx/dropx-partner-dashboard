"use client";
import "./provider-mapping-summary.css";

import {useEffect, useMemo, useRef, useState} from "react";
import {
  buildProviderMappingSummary, uniqueMappingProfiles, mappingProfileTotals,
  providerMappingSummaryTotals,
  type ProviderMappingSummaryMappingInput,
  type ProviderMappingSummaryMethodInput,
  type ProviderMappingSummarySourceInput,
  type ProviderMappingSummaryStationInput,
  type ProviderMappingSummaryStatus,
  type ProviderMappingSummaryWorkerInput
} from "@/lib/provider-mapping-summary";

import { mappingProfileLabels, mappingProfileWorkspaceLinks } from "@/lib/mapping-profile-status";

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
  canOpenMapping?: boolean; canOpenWorkforce?: boolean; workforcePath?: string;
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

export function ProviderMappingSummary({canOpenMapping=false,canOpenWorkforce=false,workforcePath="/work-force-register",stations, sourceMembers, mappings, workers, methods, availableMonths, initialMonth}: ProviderMappingSummaryProps) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [selection, setSelection] = useState<{stationId:string;metric:string}|null>(null);
  const [detailQuery,setDetailQuery] = useState("");
  const detailPanel=useRef<HTMLElement>(null);
  const openDetails=(metric:string,stationId="")=>{setDetailQuery("");setSelection({metric,stationId});};
  useEffect(()=>{if(selection){detailPanel.current?.scrollIntoView({block:"nearest",behavior:"smooth"});detailPanel.current?.focus({preventScroll:true});}},[selection]);
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
      const issueCount = station.unmapped + station.dataIssues + station.profilePending + station.profileReview + station.profileUnknown;
      const statusMatch = status === "all" || (status === "attention" ? issueCount > 0 : issueCount === 0);
      const queryMatch = !term || `${station.stationCode} ${station.stationName} ${station.cluster} ${station.region}`.toLowerCase().includes(term);
      return statusMatch && queryMatch
        && (!stationSet.size || stationSet.has(station.stationId))
        && (!clusterSet.size || clusterSet.has(station.cluster))
        && (!regionSet.size || regionSet.has(station.region));
    });
  }, [monthly, query, selectedClusters, selectedRegions, selectedStations, status]);
  const totals = useMemo(() => providerMappingSummaryTotals(filtered), [filtered]);
  const detailStations=filtered.filter(s=>!selection?.stationId || s.stationId===selection.stationId);
  const detailRows=detailStations.flatMap(station=>station.details.map(detail=>({...detail,stationId:station.stationId,stationCode:station.stationCode})));
  const metric=selection?.metric || "total";
  const metricLabels:Record<string,string>={total:"All provider IDs",mapped:"Mapped IDs",ready:"Ready mappings",unmapped:"Mapping missing",dataIssues:"Data issues",profile_pending:"Profile pending",profile_completed:"Profile completed",profile_review:"Awaiting review / activation",profile_unknown:"Profile status unavailable"};
  const visibleDetails=detailRows.filter(d=>metric==="total" || metric==="ready"&&d.status==="ready" || metric==="unmapped"&&d.status==="unmapped" || metric==="mapped"&&!["unmapped","identity_missing"].includes(d.status) || metric==="dataIssues"&&!["ready","unmapped"].includes(d.status)).filter(d=>[d.stationCode,d.providerMemberId,d.providerMemberName,d.dropxId,d.dropxName].join(" ").toLowerCase().includes(detailQuery.trim().toLowerCase()));
  const profiles=uniqueMappingProfiles(detailRows.flatMap(d=>d.profiles));
  const selectedProfiles=profiles.filter(p=>metric===`profile_${p.state}`);
  const visibleProfiles=selectedProfiles.filter(p=>[p.dropxId,p.fullName,p.status].join(" ").toLowerCase().includes(detailQuery.trim().toLowerCase()));
  const profileView=metric.startsWith("profile_");
  const profileCounts=mappingProfileTotals(profiles);
  const profileWorkspaces=workforcePath==="/work-force-register" ? mappingProfileWorkspaceLinks(selectedProfiles.map(p=>p.id),metric.slice(8)) : [];
  const countButton=(value:number,metric:string,stationId="",tone="")=><button type="button" className={`mapping-count mapping-count-button ${tone}`} aria-label={`${metricLabels[metric]}: ${value}${stationId ? " at "+stations.find(s=>s.id===stationId)?.code : ""}`} onClick={()=>openDetails(metric,stationId)}>{value}</button>;
  const activeMonthLabel = !selectedMonths.length ? "all available months" : selectedMonths.map(monthLabel).join(", ");

  return <section className="mapping-summary-workspace">
    <div className="mapping-summary-filterbar" aria-label="Mapping summary filters">
      <CompactMultiSelect allLabel="All stations" label="Station" options={stationOptions} selected={selectedStations} onChange={setSelectedStations} />
      <CompactMultiSelect allLabel="All clusters" label="Cluster" options={clusterOptions} selected={selectedClusters} onChange={setSelectedClusters} />
      <CompactMultiSelect allLabel="All regions" label="Region" options={regionOptions} selected={selectedRegions} onChange={setSelectedRegions} />
      <CompactMultiSelect allLabel="All available months" label="Month" options={monthOptions} selected={selectedMonths} onChange={setSelectedMonths} />
      <button className="button secondary compact mapping-summary-clear" type="button" onClick={() => {
        setSelectedStations([]); setSelectedClusters([]); setSelectedRegions([]); setSelectedMonths([initialMonth]); setStatus("all"); setQuery(""); setSelection(null);
      }}>Reset</button>
    </div>

    <div className="mapping-summary-cards" aria-label="Mapping totals">
      <article><span>Stations in scope</span><button className="mapping-card-number" onClick={()=>openDetails("total")} type="button">{totals.stations}</button><small>{countButton(totals.total,"total")} provider IDs · {activeMonthLabel}</small></article>
      <article className="is-positive"><span>Mapping ready</span><button className="mapping-card-number" onClick={()=>openDetails("ready")} type="button">{totals.ready}</button><small><button className="mapping-text-button" onClick={()=>openDetails("ready")} type="button">{totals.completionPercent}% of activity covered</button></small></article>
      <article><span>Mapped</span><button className="mapping-card-number" onClick={()=>openDetails("mapped")} type="button">{totals.mapped}</button><small>DropX ID linked</small></article>
      <article className={totals.unmapped ? "is-negative" : "is-positive"}><span>Mapping missing</span><button className="mapping-card-number" onClick={()=>openDetails("unmapped")} type="button">{totals.unmapped}</button><small>Needs ID mapping</small></article>
      <article className={totals.dataIssues ? "is-warning" : "is-positive"}><span>Data issues</span><button className="mapping-card-number" onClick={()=>openDetails("dataIssues")} type="button">{totals.dataIssues}</button><small>Coverage, identity, pay or source</small></article>
      <article className={totals.profilePending ? "is-warning" : "is-positive"}><span>Associate profiles</span><div className="mapping-profile-counts">Pending {countButton(totals.profilePending,"profile_pending","","warning")}<br/>Completed {countButton(totals.profileCompleted,"profile_completed","","positive")} · Review {countButton(totals.profileReview,"profile_review")}{totals.profileUnknown ? <> · Unknown {countButton(totals.profileUnknown,"profile_unknown")}</>:null}</div><small>Unique mapped associates · current status</small></article>
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
          <thead><tr><th>Station</th><th>Cluster / region</th><th>Total IDs</th><th>Mapped</th><th>Ready</th><th>Mapping missing</th><th>Data issues</th><th>Profiles · associates</th><th>Mapping coverage</th><th>Details</th></tr></thead>
          <tbody>{filtered.map(station => {
            const needsAttention = station.unmapped + station.dataIssues > 0;
            return <tr key={station.stationId} className={needsAttention ? "needs-attention" : "is-complete"}>
              <td><strong>{station.stationCode}</strong>{station.stationName ? <small>{station.stationName}</small> : null}</td>
              <td><strong>{station.cluster}</strong><small>{station.region}</small></td>
              <td>{countButton(station.total,"total",station.stationId)}</td><td>{countButton(station.mapped,"mapped",station.stationId)}</td><td>{countButton(station.ready,"ready",station.stationId,"positive")}</td>
              <td>{countButton(station.unmapped,"unmapped",station.stationId,station.unmapped?"negative":"muted")}</td>
              <td>{countButton(station.dataIssues,"dataIssues",station.stationId,station.dataIssues?"warning":"muted")}</td>
              <td className="mapping-profile-counts">Pending {countButton(station.profilePending,"profile_pending",station.stationId,"warning")} · Done {countButton(station.profileCompleted,"profile_completed",station.stationId,"positive")}<br/>Review {countButton(station.profileReview,"profile_review",station.stationId)}{station.profileUnknown ? <> · Unknown {countButton(station.profileUnknown,"profile_unknown",station.stationId)}</>:null}</td>
              <td><button type="button" className="mapping-text-button" onClick={()=>openDetails("ready",station.stationId)}><span className="mapping-completion"><span><i style={{width:`${station.completionPercent}%`}} /></span><strong>{station.completionPercent}%</strong></span></button></td>
              <td><button className="button secondary compact" type="button" onClick={() => openDetails("total",station.stationId)}>{station.total ? "View IDs" : "View"}</button></td>
            </tr>;
          })}{!filtered.length ? <tr><td className="mapping-summary-empty" colSpan={10}>No stations match the selected filters.</td></tr> : null}</tbody>
        </table>
      </div>
      <div className="mapping-summary-footer"><span>{filtered.length} of {monthly.length} stations</span><span>One-day mappings count only on their exact effective date.</span></div>
    </div>

    {selection ? <section className="panel mapping-summary-inline-detail" ref={detailPanel} tabIndex={-1} aria-label="Mapping count details">
      <header><div><h2>{metricLabels[metric]} · {selection.stationId ? detailStations[0]?.stationCode || "Station filtered out" : "Selected stations"}</h2><p>{profileView ? visibleProfiles.length : visibleDetails.length} matching {profileView?"associates":"provider IDs"} · {activeMonthLabel}</p></div><button className="button secondary compact" type="button" onClick={()=>setSelection(null)}>Close details</button></header>
      <div className="mapping-detail-toolbar"><input className="field" type="search" aria-label="Search mapping details" placeholder="Search ID or name" value={detailQuery} onChange={e=>setDetailQuery(e.target.value)}/><select className="field" aria-label="Detail category" value={metric} onChange={e=>{setDetailQuery("");setSelection({...selection,metric:e.target.value});}}>{Object.entries(metricLabels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select>
        {canOpenWorkforce ? profileWorkspaces.map(link=><a key={link.href} className="button secondary compact" href={link.href} target="_blank" rel="noopener noreferrer">{link.label}</a>):null}
      </div>
      <p className="mapping-summary-note">Profiles: {countButton(profileCounts.profilePending,"profile_pending",selection.stationId)} pending · {countButton(profileCounts.profileCompleted,"profile_completed",selection.stationId)} completed · {countButton(profileCounts.profileReview,"profile_review",selection.stationId)} awaiting review. Profile counts are unique associates; mapping counts are provider IDs.</p>
      <div className="table-wrap mapping-summary-detail-table"><table><thead>{profileView?<tr><th>DropX ID / associate</th><th>Station · provider IDs</th><th>Profile status</th><th>Workspace</th></tr>:<tr><th>Station · provider ID / name</th><th>DropX ID / name</th><th>Payment / coverage</th><th>Mapping status</th><th>Profiles</th><th>Details</th></tr>}</thead><tbody>
        {profileView ? visibleProfiles.map(p=><tr key={p.id}><td><strong>{p.dropxId || "ID unavailable"}</strong><small>{p.fullName}</small></td><td>{detailRows.filter(d=>d.profiles.some(person=>person.id===p.id)).map(d=><small key={d.key}>{d.stationCode} · {d.providerMemberId}</small>)}</td><td>{mappingProfileLabels[p.state]}<small>{p.status.replaceAll("_"," ") || "Not recorded"}</small></td><td>{canOpenWorkforce?<a href={workforcePath+"?view="+encodeURIComponent(p.id)} target="_blank" rel="noopener noreferrer">Open profile ↗</a>:"Workspace access required"}</td></tr>) : visibleDetails.map(d=><tr key={d.key}><td><strong>{d.stationCode} · {d.providerMemberId}</strong><small>{d.providerMemberName || "Name unavailable"}</small></td><td><strong>{d.dropxId || "—"}</strong><small>{d.dropxName || "Not mapped"}</small></td><td>{d.paymentMethod || "—"}<small>{d.coverageLabel} · {d.coveragePercent}%</small></td><td><span className={`mapping-status ${d.status}`}>{statusLabel[d.status]}</span><small>{d.issues.join(" · ")}</small></td><td>{d.profiles.length ? d.profiles.map(p=><small key={p.id}>{p.dropxId} · {mappingProfileLabels[p.state]}{canOpenWorkforce?<> <a href={workforcePath+"?view="+encodeURIComponent(p.id)} target="_blank" rel="noopener noreferrer">Profile ↗</a></>:null}</small>):"No linked profile"}</td><td>{canOpenMapping?<a href={"/provider-id-mapping?"+new URLSearchParams({station:d.stationId,q:d.providerMemberId,...(selectedMonths.length===1?{month:selectedMonths[0]}:{})})} target="_blank" rel="noopener noreferrer">Open mapping ↗</a>:"Mapping access required"}</td></tr>)}
        {!(profileView?visibleProfiles:visibleDetails).length?<tr><td colSpan={profileView?4:6}>No records match this count and the current filters.</td></tr>:null}
      </tbody></table></div>
    </section> : null}

  </section>;
}
