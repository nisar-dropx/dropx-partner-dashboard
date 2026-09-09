"use client";
import { useEffect, useMemo, useState } from "react";
import { TrackingDetailModal } from "@/components/tracking-detail-modal";
import type { EddStationPayload, EddStationResult } from "@/lib/ops-pulse/edd-worker";
import { STATION_EDD_RULE, stationEddDate, stationEddFreshness, stationEddPackageMatches, stationEddSearchMatches, stationEddPosition, stationEddToday, summarizeStationEdd, type StationEddDay, type StationEddFilter } from "@/lib/ops-pulse/station-edd";
import { StationEddDownload } from "../station-edd-download";
import styles from "../station-edd.module.css";

const filters: Array<[StationEddFilter, string]> = [["atStation", "At station"], ["onRoad", "On road"], ["other", "Other statuses"], ["all", "All statuses"]];
const days: Array<[StationEddDay, string]> = [["today", "EDD today"], ["overdue", "Overdue EDD"], ["pending", "Today + overdue"], ["all", "All EDD dates"]];

async function json<T>(url: string, method = "GET"): Promise<T> {
  const response = await fetch(url, { method, cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Unable to load station EDD.");
  return body;
}

export function StationEddDetailClient({ stationCode, initialDay = "today", initialPosition = "atStation" }: { stationCode: string; initialDay?: StationEddDay; initialPosition?: StationEddFilter }) {
  const [payload, setPayload] = useState<EddStationPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StationEddFilter>(initialPosition);
  const [day, setDay] = useState<StationEddDay>(initialDay);
  const [state, setState] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [openTrackingId, setOpenTrackingId] = useState<string | null>(null);
  const [today, setToday] = useState(stationEddToday());
  useEffect(() => {
    const timer = setInterval(() => setToday(stationEddToday()), 60000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setPayload(null); setError(null);
    void json<EddStationResult>(`/api/ops-pulse/station-edd?stationCode=${encodeURIComponent(stationCode)}`)
      .then(result => { if (!cancelled) setPayload(result.status === "ok" ? result.payload : null); })
      .catch(cause => { if (!cancelled) setError(String(cause.message)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [stationCode]);
  async function refresh() {
    setRefreshing(true); setError(null);
    try { setPayload(await json<EddStationPayload>(`/api/ops-pulse/station-edd/refresh?stationCode=${encodeURIComponent(stationCode)}`, "POST")); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to refresh station."); }
    finally { setRefreshing(false); }
  }
  const packages = useMemo(() => [...new Map((payload?.packages ?? []).filter(p => p.trackingId).map(p => [p.trackingId, p])).values()], [payload]);
  const summary = useMemo(() => summarizeStationEdd(stationCode, payload ? packages : null, payload?.fetchedAt ?? null, today), [stationCode, payload, packages, today]);
  const filtered = useMemo(() => packages.filter(pkg => {
    return stationEddPackageMatches(pkg, filter, day, today) && stationEddSearchMatches(pkg, state, query);
  }), [packages, filter, day, today, state, query]);
  const statuses = useMemo(() => [...new Set(packages.map(p => p.state).filter((s): s is string => !!s))].sort(), [packages]);
  const pages = Math.max(1, Math.ceil(filtered.length / 50));
  const current = Math.min(page, pages);
  const reportParams = new URLSearchParams({ stationCode, report: "filtered", day, position: filter, state, query });
  function selectMetric(nextDay: StationEddDay, nextPosition: StationEddFilter) {
    setDay(nextDay); setFilter(nextPosition); setState(""); setQuery(""); setPage(1);
    document.getElementById("edd-tid-details")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  return <div className={styles.workspace}>
    <section className="panel"><div className="panel-body">
      <nav className={styles.breadcrumb} aria-label="EDD location navigation"><a className="button secondary" href="/edd/edds">← All locations · EDD table</a><strong>Station details / {stationCode}</strong><span className="subtle">EDD today: {today} · IST</span></nav>
      <div className="edd-toolbar">
        {payload ? <><StationEddDownload href={`/api/ops-pulse/station-edd/report?stationCode=${encodeURIComponent(stationCode)}&report=filtered&day=pending&position=atStation`} label="Download pending EDDs" /><StationEddDownload href={`/api/ops-pulse/station-edd/report?stationCode=${encodeURIComponent(stationCode)}`} label="Download full audit report" /></> : null}
        <button className="button secondary" type="button" onClick={() => void refresh()} disabled={loading || refreshing}>{refreshing ? "Refreshing…" : "Refresh live"}</button>
      </div>
      {payload ? <p role="status" className="subtle"><strong>{stationEddFreshness(payload.fetchedAt)}</strong> · fetched {new Date(payload.fetchedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST. Click a TID for its latest tracking history.</p> : null}
      <details className={styles.definitions}><summary>Counting rules, snapshot freshness and delivered totals</summary><p>{STATION_EDD_RULE}</p><p>Pending EDDs = at station, EDD today or earlier. Snapshots are not a continuous live status. Delivered totals remain in <a href={`/edd/${encodeURIComponent(stationCode)}/performance`}>Performance</a>; the backlog feed excludes completed deliveries.</p></details>
      {refreshing ? <p role="status">Pulling fresh backlog from Amazon — allow up to five minutes for large stations. Previous snapshot stays visible.</p> : null}
      {error ? <p role="alert" style={{ color: "var(--red)" }}>{error}</p> : null}
      {loading ? <p>Loading station EDD…</p> : !payload ? <p>No snapshot available. Use Refresh live to load the station; missing data is not a zero count.</p> : null}
    </div></section>
    {payload ? <>
      <section className="edd-bucket-grid">
        <button type="button" className={`edd-bucket-card overdue ${day === "today" && filter === "atStation" ? "active" : ""}`} onClick={() => selectMetric("today", "atStation")}><span>At station · EDD today</span><strong>{summary.todayAtStation.toLocaleString("en-IN")}</strong><small>INDUCTED + RECEIVED · View TIDs</small></button>
        <button type="button" className={`edd-bucket-card dueToday ${day === "overdue" && filter === "atStation" ? "active" : ""}`} onClick={() => selectMetric("overdue", "atStation")}><span>Overdue at station</span><strong>{summary.overdueAtStation.toLocaleString("en-IN")}</strong><small>EDD before today · View TIDs</small></button>
        <button type="button" className={`edd-bucket-card ${day === "pending" && filter === "atStation" ? "active" : ""}`} onClick={() => selectMetric("pending", "atStation")}><span>Total pending at station</span><strong>{(summary.todayAtStation + summary.overdueAtStation).toLocaleString("en-IN")}</strong><small>Today + overdue · View TIDs</small></button>
        <button type="button" className={`edd-bucket-card ${day === "today" && filter === "onRoad" ? "active" : ""}`} onClick={() => selectMetric("today", "onRoad")}><span>On road · EDD today</span><strong>{summary.todayOnRoad.toLocaleString("en-IN")}</strong><small>Not counted at station · View TIDs</small></button>
        <button type="button" className={`edd-bucket-card ${day === "today" && filter === "other" ? "active" : ""}`} onClick={() => selectMetric("today", "other")}><span>Other status · EDD today</span><strong>{summary.todayOther.toLocaleString("en-IN")}</strong><small>Failed, rejected, other · View TIDs</small></button>
      </section>
      <details className="panel"><summary className={styles.detailsSummary}>Source status breakdown · {summary.statuses.length} statuses · {summary.todayTotal.toLocaleString("en-IN")} active EDDs today</summary><div className="panel-body">
        <div className="edd-table-wrap"><table className="edd-table compact"><thead><tr><th>Raw status</th><th>EDD today</th><th>Overdue</th><th>All dates</th></tr></thead><tbody>
          {summary.statuses.map(s => <tr key={s.state}><td>{s.state}</td><td>{s.today}</td><td>{s.overdue}</td><td>{s.total}</td></tr>)}
        </tbody></table></div><p className="subtle">{summary.excludedReverse} reverse shipments excluded · {summary.missingDate} forward shipments with missing EDD (visible under All EDD dates).</p>
      </div></details>
      <section className="panel" id="edd-tid-details"><div className="panel-head"><div><h3>Tracking-ID details · {stationCode}</h3><p className="subtle">{days.find(d => d[0] === day)?.[1]} · {filters.find(f => f[0] === filter)?.[1]} · {filtered.length.toLocaleString("en-IN")} TIDs. Select a TID for its full history.</p></div><StationEddDownload href={`/api/ops-pulse/station-edd/report?${reportParams}`} label="Download filtered TIDs" /></div>
        <div className="panel-body"><div className={styles.toolbar}>
          <label>EDD period <select value={day} onChange={e => { setDay(e.target.value as StationEddDay); setPage(1); }}>{days.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          <label>Position <select value={filter} onChange={e => { setFilter(e.target.value as StationEddFilter); setPage(1); }}>{filters.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          <label>Raw status <select value={state} onChange={e => { setState(e.target.value); setPage(1); }}><option value="">All raw statuses</option>{statuses.map(s => <option key={s}>{s}</option>)}</select></label>
          <input type="search" aria-label="Search tracking IDs" placeholder="Search TID, driver, city, order…" value={query} onChange={e => { setQuery(e.target.value); setPage(1); }} />
        </div><div className="edd-table-wrap"><table className="edd-table compact"><thead><tr><th>TID</th><th>EDD / EAD</th><th>Promised date</th><th>Raw status</th><th>Position</th><th>Driver ID (source)</th><th>Last scan by</th><th>City / PIN</th><th>Order ID</th></tr></thead><tbody>
          {filtered.slice((current - 1) * 50, current * 50).map(pkg => <tr key={pkg.trackingId}>
            <td><button type="button" className="edd-table-tid-btn" onClick={() => setOpenTrackingId(pkg.trackingId)}>{pkg.trackingId}</button></td>
            <td>{stationEddDate(pkg) || "Missing"}</td><td>{pkg.promisedDeliveryDate || "—"}</td><td>{pkg.state || "UNKNOWN"}</td><td>{filters.find(f => f[0] === stationEddPosition(pkg))?.[1]}</td>
            <td>{pkg.driverId || "Not present"}</td><td>{pkg.lastScanBy || "—"}</td><td>{pkg.city || "—"} {pkg.postalCode}</td><td>{pkg.orderingOrderId || "—"}</td>
          </tr>)}
        </tbody></table></div>{!filtered.length ? <p>No TIDs match these filters.</p> : null}
          <div className="edd-pagination"><span>{filtered.length} tracking IDs</span><div><button className="button secondary" disabled={current <= 1} onClick={() => setPage(current - 1)}>Previous</button> Page {current} of {pages} <button className="button secondary" disabled={current >= pages} onClick={() => setPage(current + 1)}>Next</button></div></div>
        </div>
      </section>
    </> : null}
    <TrackingDetailModal trackingId={openTrackingId} stationHint={stationCode} onClose={() => setOpenTrackingId(null)} />
  </div>;
}
