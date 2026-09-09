"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { TrackingDetailModal } from "@/components/tracking-detail-modal";
import type { EddStationPayload, EddStationResult } from "@/lib/ops-pulse/edd-worker";
import { STATION_EDD_RULE, stationEddDate, stationEddFreshness, stationEddPackageMatches, stationEddPosition, stationEddToday, summarizeStationEdd, type StationEddDay, type StationEddFilter } from "@/lib/ops-pulse/station-edd";
import { StationEddDownload } from "../station-edd-download";

const filters: Array<[StationEddFilter, string]> = [["atStation", "At station"], ["onRoad", "On road"], ["other", "Other statuses"], ["all", "All statuses"]];
const days: Array<[StationEddDay, string]> = [["today", "EDD today"], ["overdue", "Overdue EDD"], ["all", "All EDD dates"]];

async function json<T>(url: string, method = "GET"): Promise<T> {
  const response = await fetch(url, { method, cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Unable to load station EDD.");
  return body;
}

export function StationEddDetailClient({ stationCode }: { stationCode: string }) {
  const [payload, setPayload] = useState<EddStationPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StationEddFilter>("atStation");
  const [day, setDay] = useState<StationEddDay>("today");
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
    if (!stationEddPackageMatches(pkg, filter, day, today) || (state && pkg.state !== state)) return false;
    const term = query.toLowerCase().trim();
    return !term || [pkg.trackingId, pkg.state, pkg.driverId, pkg.lastScanBy, pkg.city, pkg.orderingOrderId, pkg.lockerName].some(v => v?.toLowerCase().includes(term));
  }), [packages, filter, day, today, state, query]);
  const statuses = useMemo(() => [...new Set(packages.map(p => p.state).filter((s): s is string => !!s))].sort(), [packages]);
  const pages = Math.max(1, Math.ceil(filtered.length / 50));
  const current = Math.min(page, pages);
  return <>
    <section className="panel"><div className="panel-body">
      <div className="edd-toolbar"><Link href="/edd/edds">← All stations</Link><span className="subtle" style={{ flex: 1 }}>EDD today: {today} · IST</span>
        {payload ? <StationEddDownload href={`/api/ops-pulse/station-edd/report?stationCode=${encodeURIComponent(stationCode)}`} label="Download detailed report" /> : null}
        <button className="button secondary" type="button" onClick={() => void refresh()} disabled={loading || refreshing}>{refreshing ? "Refreshing…" : "Refresh live"}</button>
      </div>
      <p>{STATION_EDD_RULE}</p>
      {payload ? <p role="status"><strong>{stationEddFreshness(payload.fetchedAt)}</strong> · fetched {new Date(payload.fetchedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST. This snapshot is not a continuous live status; click a TID for its latest tracking history.</p> : null}
      <p className="subtle">Delivered totals remain in <Link href={`/edd/${encodeURIComponent(stationCode)}/performance`}>Performance</Link>. The active-backlog feed excludes completed deliveries.</p>
      {refreshing ? <p role="status">Pulling fresh backlog from Amazon — allow up to five minutes for large stations. Previous snapshot stays visible.</p> : null}
      {error ? <p role="alert" style={{ color: "var(--red)" }}>{error}</p> : null}
      {loading ? <p>Loading station EDD…</p> : !payload ? <p>No snapshot available. Use Refresh live to load the station; missing data is not a zero count.</p> : null}
    </div></section>
    {payload ? <>
      <section className="edd-bucket-grid">
        <div className="edd-bucket-card static overdue"><span>At station · EDD today</span><strong>{summary.todayAtStation}</strong><small>INDUCTED + RECEIVED</small></div>
        <div className="edd-bucket-card static dueToday"><span>Overdue at station</span><strong>{summary.overdueAtStation}</strong><small>EDD before today</small></div>
        <div className="edd-bucket-card static"><span>On road · EDD today</span><strong>{summary.todayOnRoad}</strong><small>not counted at station</small></div>
        <div className="edd-bucket-card static"><span>Other status · EDD today</span><strong>{summary.todayOther}</strong><small>failed, rejected, or other states</small></div>
        <div className="edd-bucket-card static"><span>All active · EDD today</span><strong>{summary.todayTotal}</strong><small>all forward-delivery states</small></div>
      </section>
      <section className="panel"><div className="panel-head"><h3>Source status breakdown</h3></div><div className="panel-body">
        <div className="edd-table-wrap"><table className="edd-table compact"><thead><tr><th>Raw status</th><th>EDD today</th><th>Overdue</th><th>All dates</th></tr></thead><tbody>
          {summary.statuses.map(s => <tr key={s.state}><td>{s.state}</td><td>{s.today}</td><td>{s.overdue}</td><td>{s.total}</td></tr>)}
        </tbody></table></div><p className="subtle">{summary.excludedReverse} reverse shipments excluded · {summary.missingDate} forward shipments with missing EDD (visible under All EDD dates).</p>
      </div></section>
      <section className="panel"><div className="panel-head"><div><h3>Tracking-ID details</h3><p className="subtle">Select a TID to see the latest source status and full history.</p></div><span>{filtered.length} TIDs</span></div>
        <div className="panel-body"><div className="edd-toolbar">
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
  </>;
}
