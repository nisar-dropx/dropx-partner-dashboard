"use client";
import { useMemo, useState } from "react";
import type { EddStationPayload } from "@/lib/ops-pulse/edd-worker";
import type { EddStationOption } from "@/lib/ops-pulse/edd-stations";
import { STATION_EDD_RULE, stationEddFreshness, summarizeStationEdd, type StationEddSummary } from "@/lib/ops-pulse/station-edd";
import { StationEddDownload } from "./station-edd-download";

const columns = [
  ["stationCode", "Station"],
  ["todayAtStation", "At station · EDD today"],
  ["overdueAtStation", "Overdue at station"],
  ["todayOnRoad", "On road · EDD today"],
  ["todayOther", "Other status · EDD today"],
  ["todayTotal", "All active · EDD today"]
] as const;
type Sort = typeof columns[number][0];
const formatted = (value: string | null) => value ? new Date(value).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) + " IST" : "Never refreshed";

async function json<T>(url: string, method = "GET"): Promise<T> {
  const response = await fetch(url, { method, cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Unable to load EDD.");
  return body;
}

export function StationEddNetworkClient({ stations, initialNetwork, initialError }: {
  stations: EddStationOption[]; initialNetwork: StationEddSummary[]; initialError: string | null;
}) {
  const [rows, setRows] = useState(initialNetwork);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<Sort>("todayAtStation");
  const [ascending, setAscending] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState(initialError);
  const [page, setPage] = useState(1);
  const names = useMemo(() => new Map(stations.map(s => [s.code, s.name])), [stations]);
  const filtered = useMemo(() => rows.filter(r => (r.stationCode + " " + names.get(r.stationCode)).toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => (typeof a[sort] === "number" ? Number(a[sort]) - Number(b[sort]) : String(a[sort]).localeCompare(String(b[sort]))) * (ascending ? 1 : -1)), [rows, names, search, sort, ascending]);
  const pages = Math.max(1, Math.ceil(filtered.length / 15));
  const current = Math.min(page, pages);
  const totals = rows.reduce((acc, row) => ({ today: acc.today + row.todayAtStation, overdue: acc.overdue + row.overdueAtStation, road: acc.road + row.todayOnRoad }), { today: 0, overdue: 0, road: 0 });
  const stale = rows.filter(r => stationEddFreshness(r.fetchedAt) !== "Recent snapshot").length;

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

  return <>
    <section className="panel"><div className="panel-body">
      <p>{STATION_EDD_RULE}</p>
      <p className="subtle">EDD date: {rows[0]?.today || "today"} · IST. Counts are as of each station's refresh time. Completed deliveries are reported separately in the <a href="/edd/performance">Performance tab</a>; they are not included in this active-backlog feed.</p>
      {stale ? <p role="status" className="status-pill warn">{stale} stations have old or missing snapshots. Totals below include available old snapshots; refresh affected stations for the current position.</p> : null}
    </div></section>
    <section className="edd-bucket-grid">
      <div className="edd-bucket-card static overdue"><span>At station · EDD today</span><strong>{rows.length ? totals.today.toLocaleString("en-IN") : "—"}</strong><small>INDUCTED + RECEIVED in snapshots</small></div>
      <div className="edd-bucket-card static dueToday"><span>Overdue at station</span><strong>{rows.length ? totals.overdue.toLocaleString("en-IN") : "—"}</strong><small>EDD before today · separate backlog</small></div>
      <div className="edd-bucket-card static"><span>On road · EDD today</span><strong>{rows.length ? totals.road.toLocaleString("en-IN") : "—"}</strong><small>excluded from at-station count</small></div>
    </section>
    <section className="panel">
      <div className="panel-head"><div><h3>Station-level EDDs</h3><p className="subtle">Open a station for TIDs, exact statuses, dates, history and detailed downloads.</p></div>
        <div className="panel-head-actions"><StationEddDownload href="/api/ops-pulse/station-edd/network/report" /><button className="button secondary" type="button" disabled={!!busy} onClick={() => void refresh()}>{busy === "network" ? "Loading…" : "Reload counts"}</button></div>
      </div>
      <div className="panel-body">
        <input type="search" aria-label="Search stations" placeholder="Search station code or name…" value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} />
        {busy && busy !== "network" ? <p role="status">Refreshing {busy} from Amazon. Large stations can take up to five minutes; the previous snapshot remains visible.</p> : null}
        {error ? <p role="alert" style={{ color: "var(--red)" }}>{error}</p> : null}
        <div className="edd-table-wrap"><table className="edd-table"><thead><tr>
          {columns.map(([key, label]) => <th key={key}><button type="button" onClick={() => { setAscending(sort === key ? !ascending : key === "stationCode"); setSort(key); }}>{label}{sort === key ? ascending ? " ↑" : " ↓" : ""}</button></th>)}
          <th>Snapshot · IST</th><th>Actions</th>
        </tr></thead><tbody>
          {filtered.slice((current - 1) * 15, current * 15).map(row => <tr key={row.stationCode}>
            <td><a href={`/edd/${encodeURIComponent(row.stationCode)}/edds`}>{row.stationCode}<small style={{ display: "block" }}>{names.get(row.stationCode)}</small></a></td>
            {columns.slice(1).map(([key]) => <td key={key}>{row.hasSnapshot ? Number(row[key]).toLocaleString("en-IN") : "—"}</td>)}
            <td>{formatted(row.fetchedAt)}<small style={{ display: "block" }}>{stationEddFreshness(row.fetchedAt)}</small></td>
            <td><button className="button secondary" type="button" disabled={!!busy} onClick={() => void refresh(row.stationCode)}>{busy === row.stationCode ? "Refreshing…" : "Refresh live"}</button></td>
          </tr>)}
        </tbody></table></div>
        {!filtered.length ? <p>{error ? "Counts are unavailable; retry loading." : "No stations match this selection."}</p> : null}
        <div className="edd-pagination"><span>{filtered.length} stations</span><div><button className="button secondary" disabled={current <= 1} onClick={() => setPage(current - 1)}>Previous</button> Page {current} of {pages} <button className="button secondary" disabled={current >= pages} onClick={() => setPage(current + 1)}>Next</button></div></div>
      </div>
    </section>
  </>;
}
