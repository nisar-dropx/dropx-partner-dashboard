"use client";
import { useMemo, useState } from "react";
import { codFilterParams, filterReviewCod, groupReviewCodAssociates, summarizeReviewCod } from "@/lib/ops-pulse/review-cod";
import type { ReviewCodFilters, ReviewCodLine, ReviewCodSnapshot } from "@/lib/ops-pulse/review-cod";

const money = (value:number) => `₹${value.toLocaleString("en-IN", {maximumFractionDigits:2})}`;
const pageSize = 30;
type DetailView = "days" | "associates" | "tids";

export function PerformanceCodPending({snapshot}:{snapshot:ReviewCodSnapshot}) {
  const [view, setView] = useState<DetailView>("days");
  const [lines, setLines] = useState<ReviewCodLine[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<ReviewCodFilters>({});
  const [page, setPage] = useState(1);
  const summary = snapshot.summary;
  const endpoint = `/api/ops-pulse/performance/cod?station=${encodeURIComponent(snapshot.stationCode)}&batch=${encodeURIComponent(snapshot.batchId || "")}`;
  const selected = useMemo(() => {
    if (!lines) return null;
    const filtered = filterReviewCod(lines, filters);
    return {lines:filtered, summary:summarizeReviewCod(filtered), associates:groupReviewCodAssociates(filtered)};
  }, [lines, filters]);
  const exportParams = codFilterParams(filters);
  exportParams.set("format", "xlsx");
  const rowCount = !selected ? 0 : view === "days" ? selected.summary.days.length : view === "associates" ? selected.associates.length : selected.lines.length;
  const start = (page-1)*pageSize;
  const selectedAssociate = selected?.associates.find(row => row.key === filters.associate);

  async function loadDetails() {
    if (lines || loading || !summary) return;
    setLoading(true); setError(null);
    try {
      const response = await fetch(endpoint, {cache:"no-store"});
      const result = await response.json();
      if (!response.ok || !Array.isArray(result.lines)) throw new Error(result.error || "Unable to load COD details.");
      setLines(result.lines);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load COD details.");
    } finally { setLoading(false); }
  }
  function chooseBucket(bucket?:string) {
    setFilters(bucket === undefined ? {} : {bucket});
    setPage(1); setView("days");
    void loadDetails();
  }
  function drillInto(key:"day" | "associate", value:string) {
    setFilters(current => ({...current, [key]:value}));
    setView("tids"); setPage(1);
  }
  function clearDrilldown() {
    setFilters(current => current.bucket === undefined ? {} : {bucket:current.bucket});
    setPage(1); setView("days");
  }

  return <section className={`review-cod-pending ${summary?.tone || "neutral"}`} aria-label="COD pending">
    <details onToggle={event => {if (event.currentTarget.open) void loadDetails();}}>
      <summary><span><strong>COD pending</strong><small>{summary ? summary.total ? `${summary.tidCount} TIDs · ${summary.overdueAmount ? `${money(summary.overdueAmount)} aged 2+ days` : "No balance aged 2+ days"}` : "No COD pending in this report" : snapshot.error}</small></span><b>{summary ? money(summary.total) : "—"}</b><span className="review-cod-info" aria-label="Show COD ageing and details">i</span></summary>
      {summary ? <div className="review-cod-body">
        <p className="review-cod-source">Latest imported position · {snapshot.importedAt ? new Date(snapshot.importedAt).toLocaleString("en-IN", {timeZone:"Asia/Kolkata"}) : "—"}. Not a historical review-day balance.</p>
        <div className="review-cod-buckets" role="group" aria-label="Filter COD by ageing">
          <button type="button" aria-pressed={filters.bucket === undefined} onClick={() => chooseBucket()}><small>All ageing</small><strong>{money(summary.total)}</strong></button>
          {summary.buckets.map(bucket => <button type="button" key={bucket.label} className={bucket.overdue ? "overdue" : ""} aria-pressed={filters.bucket === bucket.label} onClick={() => chooseBucket(bucket.label)}><small>{bucket.label}</small><strong>{money(bucket.amount)}</strong></button>)}
        </div>
        <div className="review-cod-selection" aria-live="polite">
          <span><strong>{filters.bucket || "All ageing"}</strong>{filters.day ? ` · ${filters.day}` : ""}{filters.associate ? ` · ${selectedAssociate?.name || "Selected DA"}` : ""}<small>{selected ? `${money(selected.summary.total)} · ${selected.summary.tidCount} TIDs · ${selected.summary.lineCount} source lines` : error ? "Details unavailable" : "Loading selected details…"}</small></span>
          {filters.day !== undefined || filters.associate !== undefined ? <button type="button" onClick={clearDrilldown}>Back to bucket</button> : null}
        </div>
        <div className="review-cod-toolbar">
          <div role="group" aria-label="COD detail view">{(["days", "associates", "tids"] as const).map(tab => <button type="button" key={tab} aria-pressed={view === tab} onClick={() => {setView(tab); setPage(1);}}>{tab === "days" ? "Day-wise" : tab === "associates" ? "DA-wise" : "TIDs"}</button>)}</div>
          <a className="button secondary" href={`${endpoint}&${exportParams.toString()}`}>Download Excel</a>
        </div>
        {loading ? <p role="status">Loading station details…</p> : null}
        {error ? <p role="alert">{error} <button type="button" onClick={() => void loadDetails()}>Retry</button></p> : null}
        {selected ? <>
          <small className="review-cod-source">{view === "tids" ? "Click a TID to see its order and cash status." : `Click a ${view === "days" ? "date" : "DA"} to see its TIDs.`}</small>
          <div className="review-cod-rows">
            {view === "days" ? selected.summary.days.slice(start, start+pageSize).map(row => <button type="button" className={`review-cod-row ${row.overdue ? "overdue" : ""}`} key={row.label} onClick={() => drillInto("day", row.label)}><span><strong>{row.label}</strong><small>{row.lines} source lines · View TIDs</small></span><b>{money(row.amount)} ›</b></button>) : null}
            {view === "associates" ? selected.associates.slice(start, start+pageSize).map(row => <button type="button" className={`review-cod-row ${row.overdueAmount ? "overdue" : ""}`} key={row.key} onClick={() => drillInto("associate", row.key)}><span><strong>{row.name}</strong><small>{row.id || "ID not supplied"} · {row.tidCount} TIDs · View details</small></span><b>{money(row.amount)} ›</b></button>) : null}
            {view === "tids" ? selected.lines.slice(start, start+pageSize).map(line => <details className={`review-cod-tid ${line.overdue ? "overdue" : ""}`} key={line.rowNumber}>
              <summary className="review-cod-row"><span><strong>{line.trackingId || "TID not supplied"}</strong><small>{line.associate} · {line.pendingDate || "Date not supplied"} · {line.bucket}</small></span><b>{money(line.amount)} ›</b></summary>
              <dl><div><dt>Order ID</dt><dd>{line.orderId || "Not supplied"}</dd></div><div><dt>DA ID</dt><dd>{line.associateId || "Not supplied"}</dd></div><div><dt>Cash status</dt><dd>{line.status}</dd></div><div><dt>Source line</dt><dd>{line.rowNumber}</dd></div></dl>
            </details>) : null}
            {!rowCount ? <p>No COD pending in this selection.</p> : null}
          </div>
          {rowCount > pageSize ? <nav className="review-backlog-pages"><button type="button" disabled={page === 1} onClick={() => setPage(page-1)}>Previous</button><span>{page} / {Math.ceil(rowCount/pageSize)}</span><button type="button" disabled={page*pageSize >= rowCount} onClick={() => setPage(page+1)}>Next</button></nav> : null}
        </> : null}
        <small className="review-cod-source">Amazon’s ageing buckets · all order lines retained. Excel includes this station and the selected ageing, date and DA filters only.</small>
      </div> : null}
    </details>
  </section>;
}
