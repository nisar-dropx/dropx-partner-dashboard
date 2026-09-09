"use client";
import { useMemo, useState } from "react";
import type { EddStationPayload } from "@/lib/ops-pulse/edd-worker";
import type { EddStationOption } from "@/lib/ops-pulse/edd-stations";
import { STATION_EDD_RULE, stationEddFreshness, summarizeStationEdd, type StationEddSummary } from "@/lib/ops-pulse/station-edd";
import { StationEddDownload } from "./station-edd-download";
import styles from "./station-edd.module.css";

const columns = [
  ["stationCode", "Station"],
  ["todayAtStation", "At station · today"],
  ["overdueAtStation", "Overdue at station"],
  ["pending", "Total pending"],
  ["todayOnRoad", "On road · today"],
  ["todayOther", "Other · today"]
] as const;
type Sort = typeof columns[number][0];
const value = (row: StationEddSummary, key: Sort) => key === "pending" ? row.todayAtStation + row.overdueAtStation : row[key];
const formatted = (date: string | null) => date ? new Date(date).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) + " IST" : "No snapshot";
const detailHref = (code: string, key: Sort = "todayAtStation") => {
  const day = key === "overdueAtStation" ? "overdue" : key === "pending" ? "pending" : "today";
  const position = key === "todayOnRoad" ? "onRoad" : key === "todayOther" ? "other" : "atStation";
  return `/edd/${encodeURIComponent(code)}/edds?day=${day}&position=${position}`;
};

async function json<T>(url: string, method = "GET"): Promise<T> {
  const response = await fetch(url, { method, cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Unable to load EDD.");
  return body;
}

export function StationEddNetworkClient({ stations, initialNetwork, initialError }: {
  stations: EddStationOption[]; initialNetwork: StationEddSummary[]; initialError: string | null;
}) {
  const [rows, setRows] = useState(() => initialNetwork.length ? initialNetwork : stations.map(s => summarizeStationEdd(s.code, null, null)));
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<Sort>("pending");
  const [ascending, setAscending] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState(initialError);
  const [selection, setSelection] = useState("all");
  const [downloadDay, setDownloadDay] = useState("pending");
  const names = useMemo(() => new Map(stations.map(s => [s.code, s.name])), [stations]);
  const filtered = useMemo(() => rows.filter(r =>
    (r.stationCode + " " + names.get(r.stationCode)).toLowerCase().includes(search.toLowerCase().trim()) &&
    (selection !== "pending" || r.todayAtStation + r.overdueAtStation > 0) &&
    (selection !== "stale" || stationEddFreshness(r.fetchedAt) !== "Recent snapshot"))
    .sort((a, b) => (typeof value(a, sort) === "number" ? Number(value(a, sort)) - Number(value(b, sort)) : String(value(a, sort)).localeCompare(String(value(b, sort)))) * (ascending ? 1 : -1)), [rows, names, search, sort, ascending, selection]);
  const totals = rows.reduce((acc, row) => ({ today: acc.today + row.todayAtStation, overdue: acc.overdue + row.overdueAtStation, road: acc.road + row.todayOnRoad }), { today: 0, overdue: 0, road: 0 });
  const stale = rows.filter(r => stationEddFreshness(r.fetchedAt) !== "Recent snapshot").length;
  const available = rows.filter(r => r.hasSnapshot).length;

  async function refresh(code?: string) {
    setBusy(code ?? "network"); setError(null);
    try {
      if (code) {
        const fresh = await json<EddStationPayload>(`/api/ops-pulse/station-edd/refresh?stationCode=${encodeURIComponent(code)}`, "POST");
        setRows(previous => previous.map(row => row.stationCode === code ? summarizeStationEdd(code, fresh.packages, fresh.fetchedAt) : row));
      } else {
        const next = await json<{ stations: StationEddSummary[] }>("/api/ops-pulse/station-edd/network");
        setRows(next.stations);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to refresh EDD."); }
    finally { setBusy(null); }
  }

  return <div className={styles.workspace}>
    <section className={`edd-bucket-grid ${styles.metrics}`}>
      <div className="edd-bucket-card static"><span>All locations</span><strong>{stations.length}</strong><small>{available} with snapshots · within your access</small></div>
      <div className="edd-bucket-card static overdue"><span>At station · EDD today</span><strong>{available ? totals.today.toLocaleString("en-IN") : "—"}</strong><small>INDUCTED + RECEIVED</small></div>
      <div className="edd-bucket-card static dueToday"><span>Overdue at station</span><strong>{available ? totals.overdue.toLocaleString("en-IN") : "—"}</strong><small>EDD before today</small></div>
      <div className="edd-bucket-card static"><span>Total pending at station</span><strong>{available ? (totals.today + totals.overdue).toLocaleString("en-IN") : "—"}</strong><small>Today + overdue · excludes on-road</small></div>
    </section>
    <section className="panel">
      <div className="panel-head"><div><h3>All locations · EDDs</h3><p className="subtle">Every available station in one table. Click a count for matching TIDs, or Open details for the station.</p></div>
        <div className="panel-head-actions"><StationEddDownload href="/api/ops-pulse/station-edd/network/report" label="Download station summary" /><button className="button secondary" type="button" disabled={!!busy} onClick={() => void refresh()}>{busy === "network" ? "Loading…" : "Reload counts"}</button></div>
      </div>
      <div className="panel-body">
        <div className={styles.toolbar}>
          <input type="search" aria-label="Search stations" placeholder="Search any station code or name…" value={search} onChange={e => setSearch(e.target.value)} />
          <label>Show <select value={selection} onChange={e => setSelection(e.target.value)}><option value="all">All locations</option><option value="pending">With pending EDDs</option><option value="stale">Old / missing snapshots</option></select></label>
          <span className="subtle">{filtered.length} of {stations.length} locations · EDD {rows[0]?.today || "today"} · IST</span>
          {(search || selection !== "all") ? <button className="button secondary" onClick={() => { setSearch(""); setSelection("all"); }}>Clear filters</button> : null}
        </div>
        <div className={styles.exportBar}>
          <div><strong>Download pending TIDs · all locations</strong><p className="subtle">Detailed Excel across all {stations.length} locations, independent of table filters.</p></div>
          <label>EDD period <select aria-label="Download EDD period" value={downloadDay} onChange={e => setDownloadDay(e.target.value)}><option value="pending">Today + overdue</option><option value="today">Today only</option><option value="overdue">Overdue only</option></select></label>
          <StationEddDownload href={`/api/ops-pulse/station-edd/network/report?report=pending&day=${downloadDay}`} label="Download pending TIDs" />
        </div>
        {stale ? <p role="status" className={styles.notice}>{stale} locations have old or missing snapshots. Counts and downloads include available snapshots—not a continuous live position. Use each station's Refresh live when needed.</p> : null}
        {busy && busy !== "network" ? <p role="status">Refreshing {busy} from Amazon. Large stations can take up to five minutes; the previous snapshot remains visible.</p> : null}
        {error ? <p role="alert" style={{ color: "var(--red)" }}>{error}</p> : null}
        <div className={`edd-table-wrap ${styles.tableWrap}`}><table className={`edd-table ${styles.networkTable}`}><thead><tr>
          {columns.map(([key, label]) => <th key={key} scope="col" aria-sort={sort === key ? ascending ? "ascending" : "descending" : "none"}><button className={styles.sortButton} type="button" onClick={() => { setAscending(sort === key ? !ascending : key === "stationCode"); setSort(key); }}>{label}{sort === key ? ascending ? " ↑" : " ↓" : ""}</button></th>)}
          <th scope="col">Snapshot · IST</th><th scope="col">Actions</th>
        </tr></thead><tbody>
          {filtered.map(row => <tr key={row.stationCode}>
            <td><a className={styles.stationLink} href={detailHref(row.stationCode)}><strong>{row.stationCode}</strong><small>{names.get(row.stationCode)}</small></a></td>
            {columns.slice(1).map(([key, label]) => <td key={key}>{row.hasSnapshot ? <a className={key === "pending" ? styles.pendingCount : styles.countLink} aria-label={`${row.stationCode}: ${label}, ${value(row, key)} TIDs`} href={detailHref(row.stationCode, key)}>{Number(value(row, key)).toLocaleString("en-IN")}</a> : "—"}</td>)}
            <td><span>{formatted(row.fetchedAt)}</span><small className={stationEddFreshness(row.fetchedAt) === "Recent snapshot" ? styles.fresh : styles.stale}>{stationEddFreshness(row.fetchedAt)}</small></td>
            <td><div className={styles.rowActions}><a className="button secondary" aria-label={`Open ${row.stationCode} details`} href={detailHref(row.stationCode)}>Open details →</a><button className={styles.refreshButton} type="button" aria-label={`Refresh ${row.stationCode} live`} disabled={!!busy} onClick={() => void refresh(row.stationCode)}>{busy === row.stationCode ? "Refreshing…" : "Refresh live"}</button></div></td>
          </tr>)}
        </tbody></table></div>
        {!filtered.length ? <p>{error ? "Counts are unavailable; retry loading." : "No locations match these filters."}</p> : null}
        <p className="subtle" style={{ marginTop: 12 }}>Showing all {filtered.length} matching locations · no hidden pages. Total pending = at-station EDD today + overdue at station.</p>
        <details className={styles.definitions}><summary>How counts and dates are defined</summary><p>{STATION_EDD_RULE}</p><p>Future and missing EDD dates are not included in pending. Delivered totals remain in <a href="/edd/performance">Performance</a>; the active-backlog feed excludes completed deliveries. On-road and other statuses remain separate.</p></details>
      </div>
    </section>
  </div>;
}
