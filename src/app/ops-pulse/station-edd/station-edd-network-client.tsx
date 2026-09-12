"use client";
import { useMemo, useRef, useState } from "react";
import { ArrowRight, RefreshCw, ShieldCheck, MapPin } from "lucide-react";
import type { EddStationOption } from "@/lib/ops-pulse/edd-stations";
import { STATION_EDD_RULE, stationEddFreshness, summarizeStationEdd, type StationEddSummary } from "@/lib/ops-pulse/station-edd";
import { NETWORK_FOCUS, NETWORK_SORTS, readNetworkControls, selectEddStations, type EddQuery } from "@/lib/ops-pulse/edd-table-controls";
import { Field, ResetFilters, SortHeader, TableSearch, useEddQuery } from "./edd-table-ui";
import { StationEddDownload } from "./station-edd-download";
import { useEddAutoRefresh } from "./use-edd-auto-refresh";
import s from "./station-edd.module.css";

const cols = [["todayAtStation", "Pending", "atStation"], ["todayOnRoad", "On road", "onRoad"], ["todayDelivered", "Delivered", "delivered"], ["todayHfr", "HFR", "hfr"], ["todayHcr", "HCR", "hcr"], ["todayObservedAtStation", "Observed at station", "all"], ["todayUnverified", "Needs checks", "unverified"], ["overdueAtStation", "Overdue pending", "atStation"]] as const;
const href = (code: string, position = "atStation", day = "today") => "/edd/" + encodeURIComponent(code) + "/edds?" + new URLSearchParams({ view: "tids", position, day });
const n = (value: number) => value.toLocaleString("en-IN");
export function StationEddNetworkClient({ stations, initialNetwork, initialError, initialQuery = {} }: { stations: EddStationOption[]; initialNetwork: StationEddSummary[]; initialError: string | null; initialQuery?: EddQuery }) {
  const [rows, setRows] = useState(initialNetwork.length ? initialNetwork : stations.map(v => summarizeStationEdd(v.code, null, null)));
  const [query, update] = useEddQuery(initialQuery);
  const controls = useMemo(() => readNetworkControls(new URLSearchParams(query)), [query]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState(initialError);
  const [message, setMessage] = useState("");
  const [period, setPeriod] = useState("today");
  const requestVersion = useRef(0);
  const names = useMemo(() => new Map(stations.map(v => [v.code, v.name])), [stations]);
  const filtered = useMemo(() => selectEddStations(rows, names, controls), [rows, names, controls]);
  const sum = (key: typeof cols[number][0] | "todayTotal" | "missingDate") => filtered.reduce((value, row) => value + row[key], 0);
  const reportQuery = new URLSearchParams(query);
  const networkReport = "/api/ops-pulse/station-edd/network/report?" + reportQuery;
  const pendingReport = "/api/ops-pulse/station-edd/network/report?" + new URLSearchParams({ ...query, report: "pending", day: period });
  function sort(column: string) { update({ sort: column, direction: controls.sort === column && controls.direction === "desc" ? "asc" : "desc" }); }
  async function reload(verify = false, quiet = false) {
    const version = ++requestVersion.current;
    if (!quiet) { setBusy(verify ? "verify" : "reload"); setError(null); setMessage(""); }
    try {
      if (verify) {
        const response = await fetch("/api/ops-pulse/station-edd/verify", { method: "POST" });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Verification failed.");
        setMessage(body.busy ? "Automatic verification is running, or no histories are due." : body.verified + " histories checked; " + body.failed + " could not be verified.");
      }
      const response = await fetch("/api/ops-pulse/station-edd/network", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Counts could not be loaded.");
      if (version === requestVersion.current) { setRows(body.stations); setError(null); }
    } catch (cause) { if (version === requestVersion.current) setError(quiet ? "Automatic refresh failed. Displayed observations may be older; retry Reload data." : cause instanceof Error ? cause.message : "Unable to refresh."); }
    finally { if (!quiet) setBusy(""); }
  }
  useEddAutoRefresh(() => reload(false, true), !busy);
  return <div className={s.workspace}>
    <div className={s.contextBar}><span><MapPin size={15}/> {filtered.length} of {stations.length} stations selected · summary follows filters</span><span>EDD {rows[0]?.today} · IST</span></div>
    <p className={s.tableHelp}>Auto-refresh every minute. Pending counts require history checked within 15 minutes. “Needs checks” is unresolved coverage, not cleared stock.</p>
    <section className={s.metrics} aria-label="Today's EDD position">
      {([["Known EDDs today", sum("todayTotal"), "Selected stations · all positions", "neutral"], ["Pending first dispatch", sum("todayAtStation"), "Never dispatched or attempted", "orange"], ["On the road", sum("todayOnRoad"), "Dispatched · not completed", "blue"], ["Delivered", sum("todayDelivered"), "Recorded delivery outcome", "green"], ["HFR", sum("todayHfr"), "Attempted before today", "purple"]] as const).map(([label, count, hint, tone]) => <div key={label} className={[s.metric, s[tone]].join(" ")}><span>{label}</span><strong>{n(count)}</strong><small>{hint}</small></div>)}
    </section>
    <section className={s.panel}>
      <div className={s.panelHead}><div><span className={s.eyebrow}>STATION OVERVIEW</span><h2>Find a station. Open its EDDs.</h2><p>Filter the locations below, sort any column, then select a count for matching TIDs.</p></div><div className={s.actions}><button className={s.button} disabled={!!busy} onClick={() => void reload()}><RefreshCw size={15} className={busy === "reload" ? s.spin : ""}/> Reload data</button><details className={s.advanced}><summary>Source tools</summary><div><p>Automatic checks run in the background. Use this if you need another history batch now.</p><button className={s.button} disabled={!!busy} onClick={() => void reload(true)}>Check next history batch</button></div></details></div></div>
      <div className={s.filterPanel}>
        <div className={s.filterGrid}>
          <TableSearch label="Search stations" placeholder="Station code or location name" value={controls.query} onChange={value => update({ query: value })}/>
          <Field label="Station workload"><select className={s.select} value={controls.focus} onChange={e => update({ focus: e.target.value })}>{NETWORK_FOCUS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field>
          <Field label="Data freshness"><select className={s.select} value={controls.freshness} onChange={e => update({ freshness: e.target.value })}><option value="all">Any freshness</option><option value="recent">Recent observations</option><option value="older">Older observations</option><option value="missing">No observed records</option></select></Field>
          <Field label="Sort by"><select className={s.select} value={controls.sort} onChange={e => update({ sort: e.target.value })}>{NETWORK_SORTS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field>
          <Field label="Sort direction"><select className={s.select} value={controls.direction} onChange={e => update({ direction: e.target.value })}><option value="desc">Descending ↓</option><option value="asc">Ascending ↑</option></select></Field>
        </div>
        <div className={s.resultBar}><div role="status"><strong>{filtered.length} matching stations</strong><span>{NETWORK_FOCUS.find(([key]) => key === controls.focus)?.[1]} · Today’s EDDs; overdue pending shown separately</span></div><div className={s.actions}><ResetFilters onClick={() => update({}, true)}/><StationEddDownload href={networkReport} label="Export station table" disabled={!filtered.length}/></div></div>
      </div>
      {error ? <p className={s.error} role="alert">{error}</p> : null}{message ? <p className={s.notice} role="status">{message}</p> : null}
      <div className={s.tableWrap}><table className={s.table} aria-label="Station EDD results"><thead><tr><SortHeader label="Station" column="stationCode" sort={controls.sort} direction={controls.direction} onSort={sort}/>{cols.map(([key, label]) => <SortHeader key={key} label={label} column={key} sort={controls.sort} direction={controls.direction} onSort={sort} numeric/>)}<SortHeader label="Latest observation" column="fetchedAt" sort={controls.sort} direction={controls.direction} onSort={sort}/><th scope="col"><span className={s.srOnly}>Open station</span></th></tr></thead><tbody>
        {filtered.map(row => <tr key={row.stationCode}><td><a className={s.stationLink} href={href(row.stationCode)}><span className={s.stationIcon}><MapPin size={17}/></span><span><strong>{row.stationCode}</strong><small>{names.get(row.stationCode)}</small></span></a></td>{cols.map(([key, label, position]) => <td className={s.numeric} key={key}>{row.hasSnapshot ? <a className={key === "todayAtStation" ? s.pendingNumber : s.numberLink} href={href(row.stationCode, position, key === "overdueAtStation" ? "overdue" : "today")} aria-label={row.stationCode + " " + label + ": " + row[key] + " TIDs"}>{key === "todayAtStation" && !row[key] && row.todayUnverified ? "Checking" : n(row[key])}</a> : <span className={s.muted}>—</span>}</td>)}<td><span className={s.timestamp}>{row.fetchedAt ? new Date(row.fetchedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "No records"}</span><small className={stationEddFreshness(row.fetchedAt) === "Recent snapshot" ? s.fresh : s.stale}>{!row.hasSnapshot ? "Not yet observed" : stationEddFreshness(row.fetchedAt) === "Recent snapshot" ? "Recent observations" : "Older observations"}</small></td><td><a className={s.iconButton} aria-label={"Open " + row.stationCode + " details"} href={href(row.stationCode)}><ArrowRight size={18}/></a></td></tr>)}
      </tbody></table></div>
      {!filtered.length ? <div className={s.empty}><strong>No stations match these filters.</strong><p>Reset the filters to return to all authorized locations.</p><ResetFilters onClick={() => update({}, true)}/></div> : null}
      <div className={s.downloadBar}><div><strong>Download pending tracking IDs</strong><p>Uses the {filtered.length} stations matching the filters above—not hidden or excluded stations.</p></div><div className={s.actions}><Field label="Pending export period"><select className={s.select} value={period} onChange={e => setPeriod(e.target.value)}><option value="today">EDD today</option><option value="overdue">Overdue EDD</option><option value="pending">Today + overdue</option></select></Field><StationEddDownload href={pendingReport} label="Export pending TIDs" disabled={!filtered.length}/></div></div>
      <div className={s.footer}>All {filtered.length} matching stations shown. Exports use the same station filters and sort order. Timestamps are IST.</div>
    </section>
    <div className={s.coverageCompact}><ShieldCheck size={18}/><div><strong>{n(sum("todayUnverified"))} TIDs need history checks · {n(sum("missingDate"))} records have unconfirmed EDD dates</strong><span>For the selected stations. Neither group is assumed to be confirmed pending.</span><details><summary>Counting rules and data coverage</summary><p>{STATION_EDD_RULE}</p><p>Only records seen within seven days are retained. Totals describe the known observed EDD cohort. A recent station observation does not mean every parcel has been refreshed.</p></details></div></div>
  </div>;
}
