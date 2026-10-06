"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, ArrowUpDown, CheckCircle2, ChevronRight, Clock, Download, Info, Loader2, RefreshCw, Search, X } from "lucide-react";
import type { EddNetworkRunStatus, LoadFlashNetworkPayload, LoadFlashStation, LoadFlashTrackingRow } from "@/lib/ops-pulse/edd-worker";
import type { LoadFlashCluster } from "@/lib/ops-pulse/load-flash-access";
import type { LoadFlashReportKind } from "@/lib/ops-pulse/load-flash-report";
import { collapseFlashParcels, flashDriverLabel, flashPercent as percent, flashStationBase as baseOf, flashTotalsFromParcels, flashTotalsFromStations, sumFlashHourly, summarizeFlashDrivers } from "@/lib/ops-pulse/load-flash-scope";
import { FlashDrivers, FlashParcels } from "./flash-drilldown";
import s from "./flash.module.css";

const POLL_MS = 4000;
/** A station whose last fetch is this far behind the report is called out as stale. */
const STALE_MS = 90 * 60 * 1000;
/** Stations smaller than this are left out of "leading" so one parcel cannot top the list. */
const LEADER_MIN_LOAD = 50;
/** URL value for "parcels with no driver recorded" (a real driver ID is never empty). */
const NO_DRIVER = "none";

type SortKey = "stationCode" | "base" | "deliveredPct" | "outOnRoad" | "totalLoad" | "eddToday" | "eddPast" | "returnsToday" | "pickupPct";
type FilterKey = "all" | "notStarted" | "idle" | "pastEdd" | "returns" | "data";
type Tone = "critical" | "watch" | "good" | "info";
type Insight = { tone: Tone; title: string; detail: string; filter?: FilterKey };
export type LoadFlashScope = { cluster: string; station: string; driver: string | null };
type Tracking = { key: string; rows: LoadFlashTrackingRow[] };

function formatWhen(value: string | null) {
  if (!value) return "Not fetched yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function formatDay(date: string, options: Intl.DateTimeFormatOptions) {
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? date : parsed.toLocaleDateString("en-IN", { timeZone: "UTC", ...options });
}

function count(value: number) {
  return value.toLocaleString("en-IN");
}

function sum(rows: LoadFlashStation[], key: keyof LoadFlashStation) {
  return rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);
}

/** "KOZA 240 · KTUB 136 · KTUO 53" — the few stations that carry most of a number. */
function topList(rows: LoadFlashStation[], value: (row: LoadFlashStation) => number, limit = 3) {
  return [...rows].sort((a, b) => value(b) - value(a)).slice(0, limit).map((row) => `${row.stationCode} ${count(value(row))}`).join(" · ");
}

function nameList(rows: LoadFlashStation[], limit = 5) {
  const codes = [...rows].sort((a, b) => baseOf(b) - baseOf(a)).slice(0, limit).map((row) => row.stationCode).join(", ");
  return rows.length > limit ? `${codes} and ${rows.length - limit} more` : codes;
}

const FILTERS: Record<FilterKey, { label: string; test: (row: LoadFlashStation, stale: (row: LoadFlashStation) => boolean) => boolean }> = {
  all: { label: "All stations", test: () => true },
  notStarted: { label: "No deliveries yet", test: (row) => row.hasSnapshot && baseOf(row) > 0 && row.cohortDelivered === 0 },
  idle: { label: "Nothing on road", test: (row) => row.hasSnapshot && row.totalLoad > 0 && row.outOnRoad === 0 },
  pastEdd: { label: "Past EDD", test: (row) => row.eddPast > 0 },
  returns: { label: "Returns due", test: (row) => row.returnsToday > 0 },
  data: { label: "Data to check", test: (row, stale) => !row.hasSnapshot || stale(row) }
};

const SORT_VALUE: Record<SortKey, (row: LoadFlashStation) => string | number> = {
  stationCode: (row) => row.stationCode,
  base: baseOf,
  deliveredPct: (row) => row.deliveredPct,
  outOnRoad: (row) => row.outOnRoad,
  totalLoad: (row) => row.totalLoad,
  eddToday: (row) => row.eddToday,
  eddPast: (row) => row.eddPast,
  returnsToday: (row) => row.returnsToday,
  pickupPct: (row) => row.pickupPct
};

const TONE_ICON = { critical: AlertTriangle, watch: Clock, good: CheckCircle2, info: Info } as const;
const TONE_LABEL: Record<Tone, string> = { critical: "Act now", watch: "Watch", good: "Going well", info: "Note" };

async function downloadReport(date: string, kind: LoadFlashReportKind, scope: { stations: string[]; driver: string | null }) {
  const params = new URLSearchParams({ date, report: kind });
  if (scope.stations.length) params.set("stations", scope.stations.join(","));
  if (scope.driver !== null) params.set("driver", scope.driver || NO_DRIVER);
  const response = await fetch(`/api/ops-pulse/edd/flash/report?${params}`, { cache: "no-store" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(String((body as { error?: string }).error ?? "Unable to download the report."));
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const named = response.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1];
  anchor.href = url;
  anchor.download = named || `ops-live-${date}-${kind}.xlsx`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function LoadFlashView({ initial, stationNames = {}, clusters = [], initialScope }: {
  initial: LoadFlashNetworkPayload;
  stationNames?: Record<string, string>;
  clusters?: LoadFlashCluster[];
  initialScope?: LoadFlashScope;
}) {
  const [payload, setPayload] = useState(initial);
  const [run, setRun] = useState<EddNetworkRunStatus | null>(initial.run);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [sortKey, setSortKey] = useState<SortKey>("base");
  const [sortDesc, setSortDesc] = useState(true);
  const [downloading, setDownloading] = useState<LoadFlashReportKind | null>(null);
  const [showAllInsights, setShowAllInsights] = useState(false);
  // What the report is narrowed to: a manager's stations, then one station, then one driver.
  const [cluster, setCluster] = useState(() => clusters.some((option) => option.value === initialScope?.cluster) ? initialScope!.cluster : "");
  const [station, setStation] = useState(() => initial.stations.some((row) => row.stationCode === initialScope?.station) ? initialScope!.station : "");
  const [driver, setDriver] = useState<string | null>(() => !initialScope?.station || initialScope.driver == null ? null : initialScope.driver === NO_DRIVER ? "" : initialScope.driver);
  const [tracking, setTracking] = useState<Tracking | null>(null);
  const [trackingFailed, setTrackingFailed] = useState("");
  const scopeBar = useRef<HTMLElement>(null);

  useEffect(() => {
    setPayload(initial);
    setRun(initial.run);
  }, [initial]);

  useEffect(() => {
    if (run?.status !== "running") return;
    let cancelled = false;
    const date = payload.businessDate;

    async function pull() {
      const response = await fetch(`/api/ops-pulse/edd/flash/network?date=${encodeURIComponent(date)}`, { cache: "no-store" });
      // An error body has no stations; rendering it would blank the report.
      if (!response.ok) throw new Error("Unable to read the latest station data.");
      const next = await response.json() as LoadFlashNetworkPayload;
      if (cancelled) return null;
      setPayload(next);
      setRun(next.run);
      return next.run;
    }

    void (async () => {
      while (!cancelled) {
        const started = Date.now();
        try {
          const response = await fetch("/api/ops-pulse/edd/flash/network/continue", { method: "POST", cache: "no-store" });
          const body = await response.json() as { run?: EddNetworkRunStatus | null; error?: string };
          if (!response.ok) {
            if (!cancelled) setError(body.error ?? "Unable to keep refreshing stations.");
            break;
          }
          if (!cancelled && body.run) setRun(body.run);
          if (body.run && body.run.status !== "running") {
            await pull().catch(() => null);
            break;
          }
        } catch {
          /* The next pull still shows whatever the cron has saved. */
        }
        const latest = await pull().catch(() => null);
        if (cancelled || !latest || latest.status !== "running") break;
        const wait = Math.max(0, POLL_MS - (Date.now() - started));
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [run?.status, payload.businessDate]);

  const asOfMs = Date.parse(payload.asOf);
  const latestDate = payload.dates.length ? [...payload.dates].sort().at(-1)! : payload.businessDate;
  const isLatest = payload.businessDate >= latestDate;
  // Staleness only means something on the live day; an old report is frozen by design.
  const isStale = (row: LoadFlashStation) => {
    const fetchedMs = Date.parse(row.fetchedAt ?? "");
    return isLatest && row.hasSnapshot && Number.isFinite(asOfMs) && Number.isFinite(fetchedMs) && asOfMs - fetchedMs > STALE_MS;
  };

  // Scope: cluster narrows the station list; a selected station narrows every figure to it.
  const clusterOption = clusters.find((option) => option.value === cluster) ?? null;
  const scopeStations = useMemo(() => {
    if (!clusterOption) return payload.stations;
    const codes = new Set(clusterOption.stations);
    return payload.stations.filter((row) => codes.has(row.stationCode));
  }, [payload.stations, clusterOption]);
  const stationRow = station ? scopeStations.find((row) => row.stationCode === station) ?? null : null;
  const viewStations = useMemo(() => stationRow ? [stationRow] : scopeStations, [stationRow, scopeStations]);
  const reporting = viewStations.filter((row) => row.hasSnapshot);

  // A station left selected after its cluster no longer contains it would show an empty report.
  useEffect(() => {
    if (station && !stationRow) { setStation(""); setDriver(null); }
  }, [station, stationRow]);

  // Tracking IDs are only loaded for the one open station, and again when that station is refetched.
  const trackingKey = stationRow ? `${payload.businessDate}|${stationRow.stationCode}|${stationRow.fetchedAt ?? ""}` : "";
  useEffect(() => {
    if (!trackingKey) return;
    const [date, code] = trackingKey.split("|");
    let cancelled = false;
    setTrackingFailed("");
    void fetch(`/api/ops-pulse/edd/flash/packages?date=${encodeURIComponent(date)}&station=${encodeURIComponent(code)}`, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json().catch(() => ({})) as { rows?: LoadFlashTrackingRow[]; error?: string };
        if (!response.ok) throw new Error(body.error ?? "Unable to load tracking IDs.");
        if (!cancelled) setTracking({ key: trackingKey, rows: body.rows ?? [] });
      })
      .catch(() => { if (!cancelled) setTrackingFailed(trackingKey); });
    return () => { cancelled = true; };
  }, [trackingKey]);

  // Keep showing the previous fetch of the same station while a fresher one loads.
  const trackingRows = tracking && stationRow && tracking.key.startsWith(`${payload.businessDate}|${stationRow.stationCode}|`) ? tracking.rows : null;
  const trackingState = trackingRows ? "ready" as const : trackingFailed === trackingKey ? "error" as const : "loading" as const;
  const parcels = useMemo(() => collapseFlashParcels(trackingRows ?? []), [trackingRows]);
  const drivers = useMemo(() => summarizeFlashDrivers(parcels), [parcels]);
  const driverRow = driver !== null ? drivers.find((row) => row.driverId === driver) ?? null : null;
  const driverParcels = useMemo(() => driver !== null ? parcels.filter((parcel) => parcel.driverId === driver) : parcels, [parcels, driver]);
  const driverView = Boolean(stationRow) && driver !== null && trackingState === "ready";

  // The address always describes what is on screen, so a manager can share or reload a view.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const put = (key: string, value: string | null) => { if (value) params.set(key, value); else params.delete(key); };
    put("cluster", cluster);
    put("station", station);
    put("driver", station && driver !== null ? driver || NO_DRIVER : null);
    const next = params.toString();
    if (next !== window.location.search.replace(/^\?/, "")) window.history.replaceState(window.history.state, "", `${window.location.pathname}${next ? `?${next}` : ""}`);
  }, [cluster, station, driver]);

  const totals = useMemo(() => driverView ? flashTotalsFromParcels(driverParcels, payload.businessDate) : flashTotalsFromStations(viewStations), [driverView, driverParcels, viewStations, payload.businessDate]);
  const sweepPct = run && run.stationsTotal ? Math.round((run.stationsDone / run.stationsTotal) * 100) : 0;
  const refreshing = run?.status === "running";

  // The header shows when the data itself was last fetched (cron or Refresh),
  // not `asOf`, which is only the moment this page asked for it.
  const fetchedTimes = reporting.map((row) => Date.parse(row.fetchedAt ?? "")).filter(Number.isFinite);
  const lastRefreshed = fetchedTimes.length ? new Date(Math.max(...fetchedTimes)).toISOString() : null;
  const oldestFetch = fetchedTimes.length ? new Date(Math.min(...fetchedTimes)).toISOString() : null;
  const refreshSpread = fetchedTimes.length ? Math.max(...fetchedTimes) - Math.min(...fetchedTimes) : 0;

  const hourly = useMemo(() => sumFlashHourly(viewStations), [viewStations]);
  const lastHour = hourly.at(-1);
  const previousHour = hourly.at(-2);
  const hourGain = !driverView && lastHour && previousHour ? lastHour.delivered - previousHour.delivered : null;
  const maxDelivered = Math.max(1, ...hourly.map((point) => point.delivered));

  const networkPct = useMemo(() => flashTotalsFromStations(scopeStations).deliveredPct, [scopeStations]);
  const insights = useMemo<Insight[]>(() => {
    const list: Insight[] = [];
    const live = scopeStations.filter((row) => row.hasSnapshot);
    const stale = scopeStations.filter((row) => !row.hasSnapshot || isStale(row));
    const withPast = live.filter((row) => row.eddPast > 0);
    const notStarted = live.filter((row) => FILTERS.notStarted.test(row, isStale));
    const idle = live.filter((row) => FILTERS.idle.test(row, isStale));
    const withReturns = live.filter((row) => row.returnsToday > 0);
    const pickupIdle = live.filter((row) => row.pickupsAssigned > 0 && row.pickupsSuccess === 0);
    const leaders = live.filter((row) => baseOf(row) >= LEADER_MIN_LOAD && row.cohortDelivered > 0).sort((a, b) => b.deliveredPct - a.deliveredPct).slice(0, 3);
    const eddPast = sum(live, "eddPast"), returns = sum(live, "returnsToday"), assigned = sum(live, "pickupsAssigned"), done = sum(live, "pickupsSuccess");

    if (eddPast > 0) list.push({ tone: "critical", filter: "pastEdd", title: `${count(eddPast)} parcels at stations are past their EDD`, detail: `Across ${withPast.length} ${withPast.length === 1 ? "station" : "stations"}. Most are at ${topList(withPast, (row) => row.eddPast)}.` });
    if (idle.length) list.push({ tone: "critical", filter: "idle", title: `${idle.length} ${idle.length === 1 ? "station has" : "stations have"} load but nothing out on road`, detail: `${nameList(idle)}. Together they hold ${count(sum(idle, "totalLoad"))} parcels.` });
    if (notStarted.length) list.push({ tone: "watch", filter: "notStarted", title: `${notStarted.length} ${notStarted.length === 1 ? "station has" : "stations have"} no deliveries recorded yet`, detail: `${nameList(notStarted)}. Their morning load is ${count(notStarted.reduce((total, row) => total + baseOf(row), 0))} parcels.` });
    if (assigned > 0) list.push({ tone: pickupIdle.length ? "watch" : "info", title: `${count(done)} of ${count(assigned)} pickups done (${percent(done, assigned)}%)`, detail: pickupIdle.length ? `${pickupIdle.length} ${pickupIdle.length === 1 ? "station has" : "stations have"} pickups assigned and none completed. Largest: ${topList(pickupIdle, (row) => row.pickupsAssigned)}.` : "Every station with pickups assigned has completed at least one." });
    if (returns > 0) list.push({ tone: "info", filter: "returns", title: `${count(returns)} customer returns are due back at stations today`, detail: `Largest: ${topList(withReturns, (row) => row.returnsToday)}.` });
    if (stale.length) list.push({ tone: "watch", filter: "data", title: `${stale.length} ${stale.length === 1 ? "station's numbers" : "stations' numbers"} may be out of date`, detail: `${nameList(stale)}. Their last fetch is missing or more than 90 minutes behind this report. Use Refresh to update them.` });
    if (leaders.length) list.push({ tone: "good", title: `Leading on delivery: ${leaders.map((row) => `${row.stationCode} ${row.deliveredPct}%`).join(" · ")}`, detail: `${clusterOption ? "This group's" : "Network"} average is ${networkPct}% of the morning load.` });
    return list;
    // isStale depends only on the payload already behind scopeStations.
  }, [scopeStations, networkPct, clusterOption]);

  const rows = useMemo(() => {
    const needle = query.trim().toUpperCase();
    const value = SORT_VALUE[sortKey];
    return scopeStations
      .filter((row) => (!needle || row.stationCode.includes(needle) || (stationNames[row.stationCode] ?? "").toUpperCase().includes(needle)) && FILTERS[filter].test(row, isStale))
      .sort((a, b) => {
        const av = value(a), bv = value(b);
        const compared = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
        return (sortDesc ? -compared : compared) || a.stationCode.localeCompare(b.stationCode);
      });
    // isStale depends only on the payload already behind scopeStations.
  }, [scopeStations, query, filter, sortKey, sortDesc, stationNames]);

  const filterCounts = useMemo(() => Object.fromEntries((Object.keys(FILTERS) as FilterKey[]).map((key) => [key, scopeStations.filter((row) => FILTERS[key].test(row, isStale)).length])) as Record<FilterKey, number>,
    // isStale depends only on the payload already behind scopeStations.
    [scopeStations]);

  function sortBy(key: SortKey) {
    if (key === sortKey) setSortDesc((current) => !current);
    else { setSortKey(key); setSortDesc(key !== "stationCode"); }
  }

  function showFilter(key: FilterKey) {
    setFilter(key);
    document.getElementById("ops-live-stations")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function openStation(code: string) {
    setStation(code);
    setDriver(null);
    if (code) scopeBar.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function chooseCluster(value: string) {
    setCluster(value);
    setFilter("all");
  }

  function saveReport(kind: LoadFlashReportKind) {
    setDownloading(kind);
    setError(null);
    // The workbook follows the view: this cluster's stations, this station, or this driver.
    const narrowed = stationRow || clusterOption ? viewStations.map((row) => row.stationCode) : [];
    void downloadReport(payload.businessDate, kind, { stations: narrowed, driver: stationRow ? driver : null })
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to download the report."))
      .finally(() => setDownloading(null));
  }

  function refreshAll() {
    setStarting(true);
    setError(null);
    void fetch("/api/ops-pulse/edd/flash/network/refresh-all", { method: "POST" })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(String(body.error ?? "Unable to refresh."));
        setRun(body.run ?? null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to refresh."))
      .finally(() => setStarting(false));
  }

  const header = (key: SortKey, label: string, numeric = true) => (
    <th scope="col" className={numeric ? s.num : undefined} aria-sort={sortKey === key ? (sortDesc ? "descending" : "ascending") : "none"}>
      <button type="button" onClick={() => sortBy(key)}>
        {label}
        {sortKey === key ? (sortDesc ? <ArrowDown size={12} /> : <ArrowUp size={12} />) : <ArrowUpDown size={12} />}
      </button>
    </th>
  );

  const scopeNoun = stationRow ? "this station" : `${reporting.length} stations`;
  const metrics: Array<{ kind?: Exclude<LoadFlashReportKind, "full">; label: string; value: string; detail: string }> = [
    driverView
      ? { label: "Parcels", value: count(driverParcels.length), detail: "Tracking IDs with this driver" }
      : { label: "Total load", value: count(totals.loadBase), detail: `${totals.baseKind === "morning" ? "Morning load" : "Live load"} · ${scopeNoun}` },
    { kind: "load", label: "At stations", value: count(totals.atStation), detail: `${count(totals.inducted)} inducted · ${count(totals.retained)} retained` },
    { kind: "edd", label: "EDD today", value: count(totals.eddToday), detail: `${count(totals.eddPast)} past · ${count(totals.eddFuture)} future` },
    { kind: "road", label: "Out on road", value: count(totals.onRoad), detail: "In transit to customers" },
    { kind: "delivered", label: "Delivered", value: count(totals.delivered), detail: `${count(totals.deliveredLive)} in delivered status` },
    { kind: "returns", label: "Returns", value: count(totals.returns), detail: "Due back today" },
    { kind: "pickups", label: "Pickups done", value: count(totals.pickupsDone), detail: `of ${count(totals.pickupsAssigned)} assigned · ${percent(totals.pickupsDone, totals.pickupsAssigned)}%` }
  ];
  const shownInsights = showAllInsights ? insights : insights.slice(0, 4);
  const dateQuery = (date: string) => `/edd/flash?${new URLSearchParams({ date, ...(cluster ? { cluster } : {}), ...(station ? { station } : {}) })}`;

  return (
    <div className={s.report}>
      <section className={s.toolbar}>
        <div className={s.title}>
          <h2>{formatDay(payload.businessDate, { weekday: "long", day: "numeric", month: "long" })}</h2>
          <p><i className={isLatest ? s.live : undefined} />{isLatest ? "Live" : "Past report"} · {lastRefreshed ? <span title={`Stations were fetched between ${formatWhen(oldestFetch)} and ${formatWhen(lastRefreshed)} IST`}>data last refreshed {formatWhen(lastRefreshed)} IST{refreshSpread > STALE_MS ? ` (oldest station ${formatWhen(oldestFetch)})` : ""}</span> : "no data fetched yet"} · {reporting.length}/{viewStations.length} stations reporting</p>
        </div>
        <nav className={s.dates} aria-label="Report date">
          {payload.dates.slice(0, 5).map((date) => (
            <a key={date} href={dateQuery(date)} aria-current={date === payload.businessDate ? "page" : undefined}>{formatDay(date, { day: "numeric", month: "short" })}</a>
          ))}
          <form action="/edd/flash">
            {cluster ? <input type="hidden" name="cluster" value={cluster} /> : null}
            {station ? <input type="hidden" name="station" value={station} /> : null}
            <input aria-label="Pick another date" title="Pick another date" name="date" type="date" defaultValue={payload.businessDate} key={payload.businessDate} onChange={(event) => { if (event.currentTarget.value) event.currentTarget.form?.requestSubmit(); }} />
          </form>
        </nav>
        <div className={s.actions}>
          <button type="button" onClick={() => saveReport("full")} disabled={downloading !== null} title="Counts, drivers and every tracking ID for the view on screen">
            {downloading === "full" ? <Loader2 size={14} className="edd-spin" /> : <Download size={14} />} Excel
          </button>
          <button type="button" className={s.primary} onClick={refreshAll} disabled={starting || refreshing}>
            {starting || refreshing ? <Loader2 size={14} className="edd-spin" /> : <RefreshCw size={14} />} {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
        {run && (refreshing || run.stationsFailed > 0) ? (
          <div className={s.sweep} role="status">
            <div className={s.track}><span style={{ width: `${refreshing ? sweepPct : 100}%` }} /></div>
            <span>{refreshing ? `Refreshing stations · ${run.stationsDone} of ${run.stationsTotal}` : `Last refresh updated ${run.stationsOk} of ${run.stationsTotal} stations`}{run.stationsFailed ? ` · ${run.stationsFailed} failed` : ""}</span>
          </div>
        ) : null}
        {error ? <p className={s.error} role="alert"><AlertTriangle size={14} /> {error}</p> : null}
      </section>

      <section className={s.scope} ref={scopeBar} aria-label="What this report covers">
        {clusters.length ? (
          <label className={s.scopeField}>
            <span>Cluster / AOM</span>
            <select value={cluster} onChange={(event) => chooseCluster(event.target.value)}>
              <option value="">All clusters</option>
              {clusters.map((option) => <option key={option.value} value={option.value}>{option.label} · {option.stations.length}</option>)}
            </select>
          </label>
        ) : null}
        <label className={s.scopeField}>
          <span>Station</span>
          <select value={stationRow ? station : ""} onChange={(event) => openStation(event.target.value)}>
            <option value="">All {scopeStations.length} stations</option>
            {[...scopeStations].sort((a, b) => a.stationCode.localeCompare(b.stationCode)).map((row) => <option key={row.stationCode} value={row.stationCode}>{row.stationCode}{stationNames[row.stationCode] ? ` — ${stationNames[row.stationCode]}` : ""}</option>)}
          </select>
        </label>
        <ol className={s.crumbs} aria-label="Current view">
          <li><button type="button" disabled={!stationRow} onClick={() => openStation("")}>{clusterOption ? clusterOption.label : "All stations"}</button></li>
          {stationRow ? <li><ChevronRight size={13} /><button type="button" disabled={driver === null} onClick={() => setDriver(null)}>{stationRow.stationCode}{stationNames[stationRow.stationCode] ? ` · ${stationNames[stationRow.stationCode]}` : ""}</button></li> : null}
          {stationRow && driver !== null ? <li><ChevronRight size={13} /><span>{driverRow ? flashDriverLabel(driverRow) : driver || "No driver recorded"}</span></li> : null}
        </ol>
        {cluster || stationRow ? <button type="button" className={s.clear} onClick={() => { setCluster(""); openStation(""); }}><X size={13} /> Clear</button> : null}
      </section>

      <section className={s.summary} aria-label="Summary">
        <div className={s.hero}>
          <span className={s.label}>{totals.baseKind === "dispatched" ? "Delivered of dispatched" : totals.baseKind === "morning" ? "Delivered of morning load" : "Delivered of live load"}</span>
          <div className={s.heroFigure}>
            <strong>{totals.deliveredPct}%</strong>
            <span><b>{count(totals.delivered)}</b> of {count(totals.loadBase)}{hourGain !== null && hourGain > 0 ? <em>+{count(hourGain)} last hour</em> : null}</span>
          </div>
          <div className={s.track} role="img" aria-label={`${totals.deliveredPct}% delivered`}><span style={{ width: `${Math.min(100, totals.deliveredPct)}%` }} /></div>
        </div>
        {metrics.map((metric) => (
          <article className={s.metric} key={metric.label}>
            <header>
              <span className={s.label}>{metric.label}</span>
              {metric.kind ? (
                <button type="button" title={`Download ${metric.label} with tracking IDs (Excel)`} aria-label={`Download ${metric.label}`} disabled={downloading !== null} onClick={() => saveReport(metric.kind!)}>
                  {downloading === metric.kind ? <Loader2 size={12} className="edd-spin" /> : <Download size={12} />}
                </button>
              ) : null}
            </header>
            <strong>{metric.value}</strong>
            <small>{metric.detail}</small>
          </article>
        ))}
      </section>

      <div className={s.split}>
        {stationRow ? (
          <section className={s.panel} aria-label="Drivers">
            <header className={s.panelHead}><h3>Drivers <span className={s.countTag}>{count(drivers.filter((row) => row.driverId).length)}</span></h3><span>{driver !== null ? "Select the driver again to show everyone" : "Select a driver to see only their parcels"}</span></header>
            <FlashDrivers drivers={drivers} selected={driver} onSelect={setDriver} state={trackingState} />
          </section>
        ) : (
          <section className={s.panel} aria-label="What needs attention">
            <header className={s.panelHead}><h3>What needs attention</h3>{insights.length > 4 ? <button type="button" className={s.link} onClick={() => setShowAllInsights((current) => !current)}>{showAllInsights ? "Show fewer" : `Show all ${insights.length}`}</button> : null}</header>
            {insights.length ? (
              <ol className={s.insights}>
                {shownInsights.map((insight) => {
                  const Icon = TONE_ICON[insight.tone];
                  return (
                    <li key={insight.title} className={s[insight.tone]}>
                      <span className={s.tone} title={TONE_LABEL[insight.tone]}><Icon size={14} /><span className={s.srOnly}>{TONE_LABEL[insight.tone]}:</span></span>
                      <div><strong>{insight.title}</strong><p>{insight.detail}</p></div>
                      {insight.filter ? <button type="button" className={s.link} onClick={() => showFilter(insight.filter!)}>View</button> : null}
                    </li>
                  );
                })}
              </ol>
            ) : <p className={s.empty}>{reporting.length ? "Nothing stands out right now." : "No station has reported for this date yet."}</p>}
          </section>
        )}

        {hourly.length ? (
          <section className={s.panel}>
            <header className={s.panelHead}><h3>Delivered through the day{driverView && stationRow ? ` · ${stationRow.stationCode}` : ""}</h3><span>{driverView ? "Whole station — hourly figures are not kept per driver" : "Hover a bar for details"}</span></header>
            <div className={s.chart}>
              {hourly.map((point, index) => (
                <div key={point.hour} className={s.bar} tabIndex={0} aria-label={`${String(point.hour).padStart(2, "0")}:00 — ${count(point.delivered)} delivered of ${count(point.totalLoad)} load`}>
                  <div className={s.plot}>
                    {index === hourly.length - 1 ? <b style={{ bottom: `${Math.max(2, (point.delivered / maxDelivered) * 100)}%` }}>{count(point.delivered)}</b> : null}
                    <span style={{ height: `${Math.max(2, (point.delivered / maxDelivered) * 100)}%` }} />
                  </div>
                  <small>{String(point.hour).padStart(2, "0")}</small>
                  <div className={s.tip} role="tooltip">
                    <strong>{String(point.hour).padStart(2, "0")}:00 check</strong>
                    <span>Delivered <b>{count(point.delivered)}</b> · {percent(point.delivered, point.totalLoad)}%</span>
                    <span>Load <b>{count(point.totalLoad)}</b></span>
                    <span>Out on road <b>{count(point.outOnRoad)}</b></span>
                  </div>
                </div>
              ))}
            </div>
            <details className={s.more}>
              <summary>View as a table</summary>
              <div className={s.hourTable}><table>
                <thead><tr><th scope="col">Hour</th><th scope="col">Load</th><th scope="col">Delivered</th><th scope="col">Delivered %</th><th scope="col">On road</th></tr></thead>
                <tbody>{hourly.map((point) => <tr key={point.hour}><td>{String(point.hour).padStart(2, "0")}:00</td><td>{count(point.totalLoad)}</td><td>{count(point.delivered)}</td><td>{percent(point.delivered, point.totalLoad)}%</td><td>{count(point.outOnRoad)}</td></tr>)}</tbody>
              </table></div>
            </details>
          </section>
        ) : null}
      </div>

      {stationRow ? (
        <section className={s.panel} aria-label="Tracking IDs">
          {trackingState === "ready"
            ? <FlashParcels parcels={driverParcels} showDriver={driver === null} onSelectDriver={setDriver} />
            : <><header className={s.panelHead}><h3>Tracking IDs</h3></header>{trackingState === "loading" ? <div className={s.skeletonRows} role="status" aria-label="Loading tracking IDs">{Array.from({ length: 8 }, (_, index) => <span key={index} className={s.skeleton} />)}</div> : <p className={s.empty}>Tracking IDs could not be loaded for this station.</p>}</>}
        </section>
      ) : (
        <section className={s.panel} id="ops-live-stations">
          <header className={s.panelHead}>
            <h3>Stations</h3>
            <div className={s.chips} role="group" aria-label="Show stations">
              {(Object.keys(FILTERS) as FilterKey[]).map((key) => (
                <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)}>{FILTERS[key].label}<b>{filterCounts[key]}</b></button>
              ))}
            </div>
            <label className={s.search}><Search size={14} /><span className={s.srOnly}>Search station</span><input type="search" placeholder="Search station" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
          </header>
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr>
                  {header("stationCode", "Station", false)}
                  {header("base", "Morning load")}
                  {header("deliveredPct", "Delivered", false)}
                  {header("outOnRoad", "On road")}
                  {header("totalLoad", "At station")}
                  {header("eddToday", "EDD today")}
                  {header("eddPast", "Past EDD")}
                  {header("returnsToday", "Returns")}
                  {header("pickupPct", "Pickups")}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const base = baseOf(row);
                  const width = base > 0 ? Math.min(100, (row.cohortDelivered / base) * 100) : 0;
                  const flags = [
                    !row.hasSnapshot ? "No data yet" : isStale(row) ? "Stale" : "",
                    FILTERS.notStarted.test(row, isStale) ? "No deliveries" : "",
                    FILTERS.idle.test(row, isStale) ? "None on road" : ""
                  ].filter(Boolean);
                  return (
                    <tr key={row.stationCode} className={s.clickable} onClick={() => openStation(row.stationCode)}>
                      <th scope="row">
                        <button type="button" className={s.rowButton} onClick={(event) => { event.stopPropagation(); openStation(row.stationCode); }} title={`Open ${row.stationCode}: drivers and tracking IDs · ${row.hasSnapshot ? `updated ${formatWhen(row.fetchedAt)}` : "not fetched yet"}`}>
                          <span><strong>{row.stationCode}</strong>{stationNames[row.stationCode] ? <em>{stationNames[row.stationCode]}</em> : null}{flags.map((flag) => <i key={flag}>{flag}</i>)}</span>
                          <ChevronRight size={14} className={s.chevron} />
                        </button>
                      </th>
                      <td className={s.num}>{count(base)}</td>
                      <td title={`${count(row.cohortDelivered)} of ${count(base)} delivered`}><div className={s.delivery}>
                        <strong>{row.deliveredPct}%</strong>
                        <div className={s.track}><span style={{ width: `${width}%` }} /><em style={{ left: `${Math.min(100, networkPct)}%` }} /></div>
                        <span>{count(row.cohortDelivered)}</span>
                      </div></td>
                      <td className={s.num}>{row.outOnRoad ? count(row.outOnRoad) : <span className={s.zero}>0</span>}</td>
                      <td className={s.num} title={`${count(row.inducted)} inducted + ${count(row.retained)} retained`}>{count(row.totalLoad)}</td>
                      <td className={s.num} title={`${count(row.eddFuture)} with a future EDD`}>{row.eddToday ? count(row.eddToday) : <span className={s.zero}>0</span>}</td>
                      <td className={s.num}>{row.eddPast ? <span className={s.alert}>{count(row.eddPast)}</span> : <span className={s.zero}>0</span>}</td>
                      <td className={s.num}>{row.returnsToday ? count(row.returnsToday) : <span className={s.zero}>0</span>}</td>
                      <td className={s.num}>{row.pickupsAssigned ? <>{count(row.pickupsSuccess)}<span className={s.of}> / {count(row.pickupsAssigned)}</span></> : <span className={s.zero}>—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
              {rows.length > 1 ? (
                <tfoot>
                  <tr>
                    <th scope="row">Total · {rows.length} stations</th>
                    <td className={s.num}>{count(rows.reduce((total, row) => total + baseOf(row), 0))}</td>
                    <td><div className={s.delivery}><strong>{percent(sum(rows, "cohortDelivered"), rows.reduce((total, row) => total + baseOf(row), 0))}%</strong><span>{count(sum(rows, "cohortDelivered"))} delivered</span></div></td>
                    <td className={s.num}>{count(sum(rows, "outOnRoad"))}</td>
                    <td className={s.num}>{count(sum(rows, "totalLoad"))}</td>
                    <td className={s.num}>{count(sum(rows, "eddToday"))}</td>
                    <td className={s.num}>{count(sum(rows, "eddPast"))}</td>
                    <td className={s.num}>{count(sum(rows, "returnsToday"))}</td>
                    <td className={s.num}>{count(sum(rows, "pickupsSuccess"))}<span className={s.of}> / {count(sum(rows, "pickupsAssigned"))}</span></td>
                  </tr>
                </tfoot>
              ) : null}
            </table>
          </div>
          {!rows.length ? <p className={s.empty}>No stations match. {filter !== "all" || query ? <button type="button" className={s.link} onClick={() => { setFilter("all"); setQuery(""); }}>Show all stations</button> : null}</p> : null}
        </section>
      )}

      <details className={`${s.panel} ${s.more}`}>
        <summary>How to read this report</summary>
        <p>Morning load is the parcel list taken at the first check of the day. Delivered is measured against it, and includes parcels whose history shows Delivered even if Amazon later moved them back to Received. The line on each station’s delivery bar is the average for the stations shown ({networkPct}%). At station is inducted plus retained. Past EDD is stock whose delivery date has already passed.</p>
        <p>Open a station to see its drivers and tracking IDs; select a driver to narrow every figure to them. A driver’s percentage is delivered out of what they were dispatched with (delivered plus still on road). Driver names come from the station’s Amazon driver list, then the workforce roster. Every Excel download follows the view on screen and includes the tracking IDs.</p>
      </details>
    </div>
  );
}
