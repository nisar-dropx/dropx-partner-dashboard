"use client";

import {useMemo, useState} from "react";
import type {ProviderMappingSummaryStation, ProviderMappingSummaryStatus} from "@/lib/provider-mapping-summary";
import {providerMappingSummaryTotals} from "@/lib/provider-mapping-summary";

const statusLabel: Record<ProviderMappingSummaryStatus, string> = {
  ready: "Ready",
  unmapped: "Mapping missing",
  identity_missing: "DropX data missing",
  payment_missing: "Pay data missing",
  source_missing: "Source data missing"
};

export function ProviderMappingSummary({stations}: {stations: ProviderMappingSummaryStation[]}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [selectedId, setSelectedId] = useState("");
  const totals = useMemo(() => providerMappingSummaryTotals(stations), [stations]);
  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    return stations.filter(station => {
      const issueCount = station.unmapped + station.dataIssues;
      const statusMatch = status === "all" || (status === "attention" ? issueCount > 0 : issueCount === 0);
      const queryMatch = !term || `${station.stationCode} ${station.stationName}`.toLowerCase().includes(term);
      return statusMatch && queryMatch;
    });
  }, [query, stations, status]);
  const selected = stations.find(station => station.stationId === selectedId);

  return <section className="mapping-summary-workspace">
    <div className="mapping-summary-cards" aria-label="Mapping totals">
      <article><span>Stations in scope</span><strong>{totals.stations}</strong><small>{totals.total} provider IDs</small></article>
      <article className="is-positive"><span>Ready</span><strong>{totals.ready}</strong><small>{totals.completionPercent}% complete</small></article>
      <article><span>Mapped</span><strong>{totals.mapped}</strong><small>DropX ID linked</small></article>
      <article className={totals.unmapped ? "is-negative" : "is-positive"}><span>Mapping missing</span><strong>{totals.unmapped}</strong><small>Needs ID mapping</small></article>
      <article className={totals.dataIssues ? "is-warning" : "is-positive"}><span>Data issues</span><strong>{totals.dataIssues}</strong><small>Identity, pay or source data</small></article>
    </div>

    <div className="panel mapping-summary-panel">
      <div className="panel-head mapping-summary-toolbar">
        <div><h2>Station mapping summary</h2><p className="subtle">Live mapping health for permitted stations. Open a station to see every affected ID.</p></div>
        <div className="mapping-summary-filters">
          <input aria-label="Find station" className="field" placeholder="Station code or name" type="search" value={query} onChange={event => setQuery(event.target.value)} />
          <select aria-label="Summary status" className="field" value={status} onChange={event => setStatus(event.target.value)}>
            <option value="attention">Needs attention</option>
            <option value="complete">Complete</option>
            <option value="all">All stations</option>
          </select>
        </div>
      </div>
      <div className="table-wrap mapping-summary-table-wrap">
        <table className="mapping-summary-table">
          <thead><tr><th>Station</th><th>Total IDs</th><th>Mapped</th><th>Ready</th><th>Mapping missing</th><th>Data issues</th><th>Completion</th><th>Details</th></tr></thead>
          <tbody>{filtered.map(station => {
            const needsAttention = station.unmapped + station.dataIssues > 0;
            return <tr key={station.stationId} className={needsAttention ? "needs-attention" : "is-complete"}>
              <td><strong>{station.stationCode}</strong>{station.stationName ? <small>{station.stationName}</small> : null}</td>
              <td>{station.total}</td><td>{station.mapped}</td><td><span className="mapping-count positive">{station.ready}</span></td>
              <td><span className={`mapping-count ${station.unmapped ? "negative" : "muted"}`}>{station.unmapped}</span></td>
              <td><span className={`mapping-count ${station.dataIssues ? "warning" : "muted"}`}>{station.dataIssues}</span></td>
              <td><div className="mapping-completion"><span><i style={{width:`${station.completionPercent}%`}} /></span><strong>{station.completionPercent}%</strong></div></td>
              <td><button className="button secondary compact" type="button" onClick={() => setSelectedId(station.stationId)}>{station.total ? "View IDs" : "View"}</button></td>
            </tr>;
          })}{!filtered.length ? <tr><td className="mapping-summary-empty" colSpan={8}>No stations match this view.</td></tr> : null}</tbody>
        </table>
      </div>
      <div className="mapping-summary-footer"><span>{filtered.length} of {stations.length} stations</span><span>Counts use the same live source as ID Mapping.</span></div>
    </div>

    {selected ? <div className="mapping-summary-overlay" role="presentation" onMouseDown={event => {if (event.target === event.currentTarget) setSelectedId("");}}>
      <section aria-labelledby="mapping-summary-detail-title" aria-modal="true" className="mapping-summary-drawer" role="dialog">
        <header><div><p>STATION DETAIL</p><h2 id="mapping-summary-detail-title">{selected.stationCode}{selected.stationName ? ` · ${selected.stationName}` : ""}</h2><span>{selected.total} IDs · {selected.ready} ready · {selected.unmapped + selected.dataIssues} need attention</span></div><button aria-label="Close station details" type="button" onClick={() => setSelectedId("")}>×</button></header>
        <div className="table-wrap mapping-summary-detail-table"><table><thead><tr><th>Provider ID / name</th><th>DropX ID / name</th><th>Payment method</th><th>Last source date</th><th>Status</th></tr></thead>
          <tbody>{selected.details.map(detail => <tr key={detail.key}>
            <td><strong>{detail.providerMemberId}</strong><small>{detail.providerMemberName || "Name unavailable"}</small></td>
            <td><strong>{detail.dropxId || "—"}</strong><small>{detail.dropxName || "Not mapped"}</small></td>
            <td>{detail.paymentMethod || "—"}</td><td>{detail.lastSeen || "—"}</td>
            <td><span className={`mapping-status ${detail.status}`}>{statusLabel[detail.status]}</span>{detail.issues.length ? <small className="mapping-issues">{detail.issues.join(" · ")}</small> : null}</td>
          </tr>)}{!selected.details.length ? <tr><td colSpan={5}>No provider IDs are currently available for this station.</td></tr> : null}</tbody>
        </table></div>
      </section>
    </div> : null}
  </section>;
}
