"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowRight, Loader2, MapPin, RefreshCw, ShieldCheck } from "lucide-react";
import type { EddStationOption } from "@/lib/ops-pulse/edd-stations";
import type { StationEddNetworkSummary } from "@/lib/ops-pulse/station-edd-summary";
import { STATION_EDD_RULE, stationEddFreshness, summarizeStationEdd } from "@/lib/ops-pulse/station-edd";
import { NETWORK_FOCUS, readNetworkControls, selectEddStations, type EddQuery } from "@/lib/ops-pulse/edd-table-controls";
import { Field, ResetFilters, SortHeader, TableSearch, useEddQuery } from "./edd-table-ui";
import { StationEddDownload } from "./station-edd-download";
import { useEddAutoRefresh } from "./use-edd-auto-refresh";
import { EddMultiSelect } from "../edd/edd-multi-select";
import s from "./station-edd.module.css";

type Phase = "" | "reload" | "verify" | "continue";
type NetworkBody = Partial<StationEddNetworkSummary> & { error?: string };
type FocusKey = typeof NETWORK_FOCUS[number][0];

const cols = [["todayAtStation", "Pending", "atStation"], ["todayOnRoad", "On road", "onRoad"], ["todayDelivered", "Delivered", "delivered"], ["todayHfr", "HFR", "hfr"], ["todayHcr", "HCR", "hcr"], ["todayObservedAtStation", "At station", "observedAtStation"], ["todayUnverified", "Needs checks", "unverified"], ["overdueAtStation", "Overdue pending", "atStation"]] as const;
type CountKey = typeof cols[number][0];
// Cards double as one-click filters wherever a matching station filter exists.
const metrics: ReadonlyArray<{ key: CountKey | "todayTotal"; label: string; hint: string; tone: string; focus?: FocusKey }> = [
  { key: "todayTotal", label: "Known EDDs today", hint: "All positions · shown stations", tone: "neutral" },
  { key: "todayAtStation", label: "Pending", hint: "Never dispatched or attempted", tone: "orange", focus: "pending" },
  { key: "overdueAtStation", label: "Overdue pending", hint: "EDD passed · still at station", tone: "red", focus: "overdue" },
  { key: "todayOnRoad", label: "On the road", hint: "Dispatched · not completed", tone: "blue", focus: "onRoad" },
  { key: "todayDelivered", label: "Delivered", hint: "Recorded delivery outcome", tone: "green" },
  { key: "todayHfr", label: "HFR", hint: "Attempted before today", tone: "purple", focus: "hfr" }
];
const focusCountKeys: Record<Exclude<FocusKey, "all">, CountKey | "missingDate"> = { pending: "todayAtStation", onRoad: "todayOnRoad", hfr: "todayHfr", hcr: "todayHcr", unverified: "todayUnverified", overdue: "overdueAtStation", missingDate: "missingDate" };
const focusLabels: Record<FocusKey, string> = { all: "All stations", pending: "Pending", onRoad: "On road", hfr: "HFR", hcr: "HCR", unverified: "Needs checks", overdue: "Overdue pending", missingDate: "Unconfirmed EDD dates" };

const href = (code: string, position = "atStation", day = "today") => "/edd/" + encodeURIComponent(code) + "/edds?" + new URLSearchParams({ view: "tids", position, day });
const n = (value: number) => value.toLocaleString("en-IN");
const clock = (value: string) => new Date(value).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function StationEddNetworkClient({ stations, initialNetwork, initialError, initialQuery = {} }: { stations: EddStationOption[]; initialNetwork: StationEddNetworkSummary | null; initialError: string | null; initialQuery?: EddQuery }) {
  const [summaries, setSummaries] = useState(() => new Map((initialNetwork?.stations ?? []).map(row => [row.stationCode, row])));
  const [waiting, setWaiting] = useState(() => new Set(initialNetwork?.pending ?? []));
  const [failed, setFailed] = useState<string[]>(initialNetwork?.failed ?? []);
  const [computedAt, setComputedAt] = useState(initialNetwork?.computedAt ?? null);
  const [query, update] = useEddQuery(initialQuery);
  const controls = useMemo(() => readNetworkControls(new URLSearchParams(query)), [query]);
  const [phase, setPhase] = useState<Phase>("");
  const [error, setError] = useState(initialError);
  const [message, setMessage] = useState("");
  const [period, setPeriod] = useState("today");
  const [exportStations, setExportStations] = useState<Set<string>>(new Set());
  const [exportStatuses, setExportStatuses] = useState<Set<string>>(new Set(["INDUCTED", "RECEIVED"]));
  const [exportMode, setExportMode] = useState("pending");
  const requestVersion = useRef(0);

  const names = useMemo(() => new Map(stations.map(v => [v.code, v.name])), [stations]);
  // Every authorized station always has a row; ones without counts yet are placeholders.
  const rows = useMemo(() => stations.map(v => summaries.get(v.code) ?? summarizeStationEdd(v.code, null, null)), [stations, summaries]);
  const filtered = useMemo(() => selectEddStations(rows, names, controls), [rows, names, controls]);
  const statusOptions = useMemo(() => [...new Set(rows.flatMap(row => row.statuses.map(status => status.state)))].sort(), [rows]);
  const focusCounts = useMemo(() => Object.fromEntries(Object.entries(focusCountKeys).map(([focus, key]) => [focus, rows.filter(row => row[key] > 0).length])), [rows]);
  const sum = (key: CountKey | "todayTotal" | "missingDate") => filtered.reduce((value, row) => value + row[key], 0);

  const calculating = stations.filter(v => waiting.has(v.code)).length;
  const readyCount = stations.length - calculating;
  const firstLoad = !summaries.size && (calculating > 0 || phase === "continue");
  const busy = phase === "reload" || phase === "verify";
  const filtersActive = Boolean(controls.query) || controls.focus !== "all" || controls.freshness !== "all";

  const networkReport = "/api/ops-pulse/station-edd/network/report?" + new URLSearchParams(query);
  const pendingReport = "/api/ops-pulse/station-edd/network/report?" + new URLSearchParams({ ...query, report: exportMode, day: period, stations: [...exportStations].join(","), statuses: [...exportStatuses].join(",") });
  const exportCount = filtered.filter(row => !exportStations.size || exportStations.has(row.stationCode)).length;

  function sort(column: string) { update({ sort: column, direction: controls.sort === column && controls.direction === "desc" ? "asc" : "desc" }); }
  function focusOn(focus: FocusKey) {
    if (focus === "all" || controls.focus === focus) update({ focus: "" });
    else update({ focus, sort: focusCountKeys[focus] === "missingDate" ? controls.sort : focusCountKeys[focus], direction: "desc" });
  }

  /** Counts are stored by the 15-minute background capture. Stations it has
   * not reached yet are calculated a few per request, so keep asking until
   * nothing is left pending. */
  async function load(mode: Exclude<Phase, ""> | "quiet") {
    const version = ++requestVersion.current;
    const quiet = mode === "quiet";
    if (!quiet) { setPhase(mode); if (mode !== "continue") { setError(null); setMessage(""); } }
    try {
      if (mode === "verify") {
        const response = await fetch("/api/ops-pulse/station-edd/verify", { method: "POST" });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || "Verification failed.");
        if (version !== requestVersion.current) return;
        setMessage((body.busy ? "Automatic verification is running, or no histories are due." : body.verified + " histories checked; " + body.failed + " could not be verified.") + " Counts update at the next 15-minute recalculation.");
      }
      let stalled = 0, remaining = Infinity;
      for (;;) {
        const response = await fetch("/api/ops-pulse/station-edd/network", { cache: "no-store" });
        const body = await response.json().catch(() => ({})) as NetworkBody;
        if (!response.ok) throw new Error(body.error || "Counts could not be loaded.");
        if (version !== requestVersion.current) return;
        setSummaries(current => { const next = new Map(current); for (const row of body.stations ?? []) next.set(row.stationCode, row); return next; });
        setWaiting(new Set(body.pending ?? []));
        setFailed(body.failed ?? []);
        if (body.computedAt) setComputedAt(body.computedAt);
        const left = body.pending?.length ?? 0;
        if (!left) break;
        // Never spin forever: stop if repeated requests make no progress.
        stalled = left < remaining ? 0 : stalled + 1; remaining = left;
        if (stalled >= 3) throw new Error("Some stations are taking too long to calculate. Reload data in a minute.");
        await pause(1000);
        if (version !== requestVersion.current) return;
      }
      setError(null);
    } catch (cause) {
      if (version === requestVersion.current) setError(quiet ? "Automatic refresh failed. Displayed counts may be older; retry Reload data." : cause instanceof Error ? cause.message : "Unable to refresh.");
    } finally {
      if (!quiet && version === requestVersion.current) setPhase("");
    }
  }
  useEffect(() => {
    // Only the first paint decides whether a cold cache still needs filling.
    if (initialNetwork ? initialNetwork.pending.length > 0 : !initialError) void load("continue");
    const version = requestVersion;
    return () => { version.current++; }; // Leaving the tab stops any polling still in flight.
  }, []);
  useEddAutoRefresh(() => load("quiet"), phase === "");

  return <div className={s.workspace}>
    <div className={s.contextBar}>
      <span><MapPin size={15}/> {filtered.length === stations.length ? `All ${stations.length} stations` : `${filtered.length} of ${stations.length} stations`} · EDD day {rows[0]?.today ?? "—"} (IST)</span>
      <span role="status">{calculating
        ? <><Loader2 size={14} className={s.spin}/> Calculating counts · {readyCount} of {stations.length} stations ready</>
        : <><i className={s.liveDot}/> {computedAt ? `Counts as of ${clock(computedAt)} IST` : "Counts not calculated yet"} · refreshes automatically</>}</span>
    </div>
    {calculating ? <div className={s.calculating}><strong>Counting today’s EDDs station by station.</strong><span>Stations fill in as they finish — you can already filter, sort and open the ones that are ready.</span><div className={s.progress}><span style={{ width: `${stations.length ? Math.round(readyCount / stations.length * 100) : 0}%` }}/></div></div> : null}
    {error ? <div className={[s.error, s.errorBar].join(" ")} role="alert"><span><AlertTriangle size={15}/> {error}</span><button type="button" className={s.button} disabled={busy} onClick={() => void load("reload")}><RefreshCw size={14}/> Try again</button></div> : null}
    {failed.length ? <p className={s.warning} role="status"><AlertTriangle size={15}/> Counts for {failed.length === 1 ? failed[0] : `${failed.length} stations (${failed.slice(0, 6).join(", ")}${failed.length > 6 ? "…" : ""})`} could not be read just now. They are retried on the next refresh.</p> : null}
    {message ? <p className={s.notice} role="status" style={{ margin: 0 }}>{message}</p> : null}

    <section className={s.metrics} aria-label="Today's EDD position">
      {metrics.map(metric => {
        const body = <><span>{metric.label}</span>{firstLoad ? <strong className={s.skeleton} style={{ width: "40%", height: 32 }}/> : <strong>{n(sum(metric.key))}</strong>}<small>{metric.focus ? controls.focus === metric.focus ? "Showing these stations · click to clear" : metric.hint + " · click to filter" : metric.hint}</small></>;
        const tone = [s.metric, s[metric.tone]].join(" ");
        return metric.focus
          ? <button key={metric.key} type="button" className={[tone, controls.focus === metric.focus ? s.selectedMetric : ""].join(" ")} aria-pressed={controls.focus === metric.focus} onClick={() => focusOn(metric.focus!)}>{body}</button>
          : <div key={metric.key} className={tone}>{body}</div>;
      })}
    </section>

    <section className={s.panel}>
      <div className={s.panelHead}>
        <div><span className={s.eyebrow}>STATION OVERVIEW</span><h2>Find a station. Open its EDDs.</h2><p>Search or pick a filter, sort by any column, then select a count to open the matching tracking IDs.</p></div>
        <div className={s.actions}>
          <button type="button" className={s.button} disabled={busy} onClick={() => void load("reload")}><RefreshCw size={15} className={phase === "reload" ? s.spin : ""}/> Reload data</button>
          <details className={s.advanced}><summary>Source tools</summary><div><p>Automatic checks run in the background. Use this if you need another history batch now.</p><button type="button" className={s.button} disabled={busy} onClick={() => void load("verify")}>{phase === "verify" ? "Checking…" : "Check next history batch"}</button></div></details>
        </div>
      </div>
      <div className={s.filterPanel}>
        <div className={s.filterGrid}>
          <TableSearch label="Search stations" placeholder="Station code or location name" value={controls.query} onChange={value => update({ query: value })}/>
          <Field label="Data freshness"><select className={s.select} value={controls.freshness} onChange={e => update({ freshness: e.target.value })}><option value="all">Any freshness</option><option value="recent">Recent observations</option><option value="older">Older observations</option><option value="missing">No observed records</option></select></Field>
        </div>
        <div className={s.chipRow} role="group" aria-label="Show stations that have">
          {NETWORK_FOCUS.map(([key]) => <button key={key} type="button" className={[s.chip, controls.focus === key ? s.chipActive : ""].join(" ")} aria-pressed={controls.focus === key} onClick={() => focusOn(key)}>{focusLabels[key]}<b>{key === "all" ? stations.length : focusCounts[key]}</b></button>)}
        </div>
        <div className={s.resultBar}>
          <div role="status"><strong>{filtered.length} matching {filtered.length === 1 ? "station" : "stations"}</strong><span>Today’s EDDs · overdue pending shown separately{filtersActive ? " · totals above follow these filters" : ""}</span></div>
          <div className={s.actions}>{filtersActive ? <ResetFilters onClick={() => update({}, true)}/> : null}<StationEddDownload href={networkReport} label="Export station table" disabled={!filtered.length}/></div>
        </div>
      </div>
      <div className={s.tableWrap}><table className={[s.table, s.networkTable].join(" ")} aria-label="Station EDD results" aria-busy={calculating > 0}>
        <thead><tr><SortHeader label="Station" column="stationCode" sort={controls.sort} direction={controls.direction} onSort={sort}/>{cols.map(([key, label]) => <SortHeader key={key} label={label} column={key} sort={controls.sort} direction={controls.direction} onSort={sort} numeric/>)}<SortHeader label="Latest observation" column="fetchedAt" sort={controls.sort} direction={controls.direction} onSort={sort}/><th scope="col"><span className={s.srOnly}>Open station</span></th></tr></thead>
        <tbody>
          {filtered.map(row => {
            const loading = waiting.has(row.stationCode) && !summaries.has(row.stationCode);
            const freshness = stationEddFreshness(row.fetchedAt);
            return <tr key={row.stationCode}>
              <td><a className={s.stationLink} href={href(row.stationCode)}><span className={s.stationIcon}><MapPin size={17}/></span><span><strong>{row.stationCode}</strong><small>{names.get(row.stationCode)}</small></span></a></td>
              {cols.map(([key, label, position]) => <td className={s.numeric} key={key}>{
                loading ? <span className={[s.skeleton, s.cellSkeleton].join(" ")}/>
                  : !row.hasSnapshot ? <span className={s.muted}>—</span>
                  : !row[key] ? <span className={s.zero}>0</span>
                  : <a className={key === "todayAtStation" ? s.pendingNumber : key === "overdueAtStation" ? s.dangerNumber : s.numberLink} href={href(row.stationCode, position, key === "overdueAtStation" ? "overdue" : "today")} aria-label={row.stationCode + " " + label + ": " + row[key] + " TIDs"}>{n(row[key])}</a>
              }</td>)}
              <td>{loading ? <span className={s.timestamp}>Calculating…</span> : <><span className={s.timestamp}>{row.fetchedAt ? new Date(row.fetchedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "No records"}</span><small className={freshness === "Recent snapshot" ? s.fresh : s.stale}>{!row.hasSnapshot ? "Not yet observed" : freshness === "Recent snapshot" ? "Recent observations" : "Older observations"}</small></>}</td>
              <td><a className={s.iconButton} aria-label={"Open " + row.stationCode + " details"} href={href(row.stationCode)}><ArrowRight size={18}/></a></td>
            </tr>;
          })}
        </tbody>
        {filtered.length > 1 && !firstLoad ? <tfoot><tr><td>Total · {filtered.length} stations</td>{cols.map(([key]) => <td className={s.numeric} key={key}>{n(sum(key))}</td>)}<td colSpan={2}/></tr></tfoot> : null}
      </table></div>
      {!filtered.length ? <div className={s.empty}><strong>{stations.length ? "No stations match these filters." : "No stations are assigned to you yet."}</strong><p>{stations.length ? "Reset the filters to return to all authorized locations." : "Ask an administrator to add delivery stations to your location access."}</p>{stations.length ? <ResetFilters onClick={() => update({}, true)}/> : null}</div> : null}
      <div className={s.downloadBar}>
        <div><strong>Download tracking IDs · {exportCount} {exportCount === 1 ? "station" : "stations"}</strong><p>One Excel for the stations and statuses you choose. Pending excludes parcels with a known earlier dispatch or attempt; status exports include the selected parcels with their attempt classification.</p></div>
        <div className={s.actions}>
          <div className={s.field}><span>Stations</span><EddMultiSelect label="Export stations" options={stations.map(station => station.code)} selected={exportStations} onChange={setExportStations}/></div>
          <Field label="What to export"><select className={s.select} value={exportMode} onChange={e => setExportMode(e.target.value)}><option value="pending">Pending</option><option value="statuses">Choose source statuses</option></select></Field>
          {exportMode === "statuses" ? <div className={s.field}><span>Source statuses</span><EddMultiSelect label="Export source statuses" options={statusOptions} selected={exportStatuses} onChange={setExportStatuses}/></div> : null}
          <Field label="EDD period"><select className={s.select} value={period} onChange={e => setPeriod(e.target.value)}><option value="today">EDD today</option><option value="overdue">Overdue EDD</option><option value="pending">Today + overdue</option></select></Field>
          <StationEddDownload href={pendingReport} label={exportMode === "pending" ? "Export pending TIDs" : "Export selected statuses"} disabled={!exportCount}/>
        </div>
      </div>
      <div className={s.footer}>Counts are shared by everyone viewing this page and recalculated every 15 minutes. Exports use the same station filters and sort order. Timestamps are IST.</div>
    </section>
    <div className={s.coverageCompact}><ShieldCheck size={18}/><div><strong>{n(sum("todayUnverified"))} TIDs need history checks · {n(sum("missingDate"))} records have unconfirmed EDD dates</strong><span>For the stations shown. Neither group is assumed to be confirmed pending; while history checks remain, a pending total is incomplete and a zero does not mean cleared.</span><details><summary>Counting rules and data coverage</summary><p>{STATION_EDD_RULE}</p><p>At station includes INDUCTED / RECEIVED returns. Only records seen within seven days are retained. Totals describe the known observed EDD cohort. A recent station observation does not mean every parcel has been refreshed.</p></details></div></div>
  </div>;
}
