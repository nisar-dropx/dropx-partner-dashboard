"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, ArrowUpDown, CheckCircle2, Clock, Download, Info, Loader2, RefreshCw, Search } from "lucide-react";
import type { EddNetworkRunStatus, LoadFlashNetworkPayload, LoadFlashStation } from "@/lib/ops-pulse/edd-worker";
import type { LoadFlashReportKind } from "@/lib/ops-pulse/load-flash-report";
import s from "./flash.module.css";

const POLL_MS = 4000;
/** A station whose last fetch is this far behind the report is called out as stale. */
const STALE_MS = 90 * 60 * 1000;
/** Stations smaller than this are left out of "leading" so one parcel cannot top the list. */
const LEADER_MIN_LOAD = 50;

type SortKey = "stationCode" | "base" | "deliveredPct" | "outOnRoad" | "totalLoad" | "eddToday" | "eddPast" | "returnsToday" | "pickupPct";
type FilterKey = "all" | "notStarted" | "idle" | "pastEdd" | "returns" | "data";
type Tone = "critical" | "watch" | "good" | "info";
type Insight = { tone: Tone; title: string; detail: string; filter?: FilterKey };

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

function percent(part: number, whole: number) {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;
}

function sum(rows: LoadFlashStation[], key: keyof LoadFlashStation) {
  return rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);
}

function baseOf(row: LoadFlashStation) {
  return row.morningLoad ?? row.totalLoad;
}

/** "KOZA 240 · KTUB 136 · KTUO 53" — the few stations that carry most of a number. */
function topList(rows: LoadFlashStation[], value: (row: LoadFlashStation) => number, limit = 3, suffix = "") {
  return [...rows].sort((a, b) => value(b) - value(a)).slice(0, limit).map((row) => `${row.stationCode} ${count(value(row))}${suffix}`).join(" · ");
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

async function downloadReport(date: string, kind: LoadFlashReportKind) {
  const response = await fetch(`/api/ops-pulse/edd/flash/report?date=${encodeURIComponent(date)}&report=${kind}`, { cache: "no-store" });
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

export function LoadFlashView({ initial, stationNames = {} }: { initial: LoadFlashNetworkPayload; stationNames?: Record<string, string> }) {
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

  const reporting = payload.stations.filter((row) => row.hasSnapshot);
  const morning = sum(reporting, "morningLoad");
  const liveLoad = sum(reporting, "totalLoad");
  const delivered = sum(reporting, "cohortDelivered");
  const loadBase = morning || liveLoad;
  const deliveredPct = percent(delivered, loadBase);
  const onRoad = sum(reporting, "outOnRoad");
  const eddPast = sum(reporting, "eddPast");
  const returns = sum(reporting, "returnsToday");
  const pickupsAssigned = sum(reporting, "pickupsAssigned");
  const pickupsDone = sum(reporting, "pickupsSuccess");
  const sweepPct = run && run.stationsTotal ? Math.round((run.stationsDone / run.stationsTotal) * 100) : 0;
  const refreshing = run?.status === "running";

  const hourly = payload.hourly;
  const lastHour = hourly.at(-1);
  const previousHour = hourly.at(-2);
  const hourGain = lastHour && previousHour ? lastHour.delivered - previousHour.delivered : null;
  const maxDelivered = Math.max(1, ...hourly.map((point) => point.delivered));

  const insights = useMemo<Insight[]>(() => {
    const list: Insight[] = [];
    const live = payload.stations.filter((row) => row.hasSnapshot);
    const stale = payload.stations.filter((row) => !row.hasSnapshot || isStale(row));
    const withPast = live.filter((row) => row.eddPast > 0);
    const notStarted = live.filter((row) => FILTERS.notStarted.test(row, isStale));
    const idle = live.filter((row) => FILTERS.idle.test(row, isStale));
    const withReturns = live.filter((row) => row.returnsToday > 0);
    const pickupIdle = live.filter((row) => row.pickupsAssigned > 0 && row.pickupsSuccess === 0);
    const leaders = live.filter((row) => baseOf(row) >= LEADER_MIN_LOAD && row.cohortDelivered > 0).sort((a, b) => b.deliveredPct - a.deliveredPct).slice(0, 3);

    if (eddPast > 0) list.push({ tone: "critical", filter: "pastEdd", title: `${count(eddPast)} parcels at stations are past their EDD`, detail: `Across ${withPast.length} ${withPast.length === 1 ? "station" : "stations"}. Most are at ${topList(withPast, (row) => row.eddPast)}.` });
    if (idle.length) list.push({ tone: "critical", filter: "idle", title: `${idle.length} ${idle.length === 1 ? "station has" : "stations have"} load but nothing out on road`, detail: `${nameList(idle)}. Together they hold ${count(sum(idle, "totalLoad"))} parcels.` });
    if (notStarted.length) list.push({ tone: "watch", filter: "notStarted", title: `${notStarted.length} ${notStarted.length === 1 ? "station has" : "stations have"} no deliveries recorded yet`, detail: `${nameList(notStarted)}. Their morning load is ${count(notStarted.reduce((total, row) => total + baseOf(row), 0))} parcels.` });
    if (pickupsAssigned > 0) list.push({ tone: pickupIdle.length ? "watch" : "info", title: `${count(pickupsDone)} of ${count(pickupsAssigned)} pickups done (${percent(pickupsDone, pickupsAssigned)}%)`, detail: pickupIdle.length ? `${pickupIdle.length} ${pickupIdle.length === 1 ? "station has" : "stations have"} pickups assigned and none completed. Largest: ${topList(pickupIdle, (row) => row.pickupsAssigned)}.` : "Every station with pickups assigned has completed at least one." });
    if (returns > 0) list.push({ tone: "info", filter: "returns", title: `${count(returns)} customer returns are due back at stations today`, detail: `Largest: ${topList(withReturns, (row) => row.returnsToday)}.` });
    if (stale.length) list.push({ tone: "watch", filter: "data", title: `${stale.length} ${stale.length === 1 ? "station's numbers" : "stations' numbers"} may be out of date`, detail: `${nameList(stale)}. Their last fetch is missing or more than 90 minutes behind this report. Use Refresh all to update them.` });
    if (leaders.length) list.push({ tone: "good", title: `Leading on delivery: ${leaders.map((row) => `${row.stationCode} ${row.deliveredPct}%`).join(" · ")}`, detail: `Network average is ${deliveredPct}% of the morning load.` });
    return list;
    // isStale depends only on the payload already listed here.
  }, [payload, eddPast, returns, pickupsAssigned, pickupsDone, deliveredPct]);

  const rows = useMemo(() => {
    const needle = query.trim().toUpperCase();
    const value = SORT_VALUE[sortKey];
    return payload.stations
      .filter((row) => (!needle || row.stationCode.includes(needle) || (stationNames[row.stationCode] ?? "").toUpperCase().includes(needle)) && FILTERS[filter].test(row, isStale))
      .sort((a, b) => {
        const av = value(a), bv = value(b);
        const compared = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
        return (sortDesc ? -compared : compared) || a.stationCode.localeCompare(b.stationCode);
      });
    // isStale depends only on the payload already listed here.
  }, [payload, query, filter, sortKey, sortDesc, stationNames]);

  const filterCounts = useMemo(() => Object.fromEntries((Object.keys(FILTERS) as FilterKey[]).map((key) => [key, payload.stations.filter((row) => FILTERS[key].test(row, isStale)).length])) as Record<FilterKey, number>,
    // isStale depends only on the payload already listed here.
    [payload]);

  function sortBy(key: SortKey) {
    if (key === sortKey) setSortDesc((current) => !current);
    else { setSortKey(key); setSortDesc(key !== "stationCode"); }
  }

  function showFilter(key: FilterKey) {
    setFilter(key);
    document.getElementById("ops-live-stations")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function saveReport(kind: LoadFlashReportKind) {
    setDownloading(kind);
    setError(null);
    void downloadReport(payload.businessDate, kind)
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

  const metrics: Array<{ kind?: Exclude<LoadFlashReportKind, "full">; label: string; value: string; detail: string }> = [
    { label: "Total load", value: count(loadBase), detail: morning ? `Morning load · ${reporting.length} stations` : `Live load · ${reporting.length} stations` },
    { kind: "load", label: "At stations", value: count(liveLoad), detail: `${count(sum(reporting, "inducted"))} inducted · ${count(sum(reporting, "retained"))} retained` },
    { kind: "edd", label: "EDD today", value: count(sum(reporting, "eddToday")), detail: `${count(eddPast)} past · ${count(sum(reporting, "eddFuture"))} future` },
    { kind: "road", label: "Out on road", value: count(onRoad), detail: "In transit to customers" },
    { kind: "delivered", label: "Delivered", value: count(delivered), detail: `${count(sum(reporting, "deliveredLive"))} in delivered status` },
    { kind: "returns", label: "Returns", value: count(returns), detail: "Due back today" },
    { kind: "pickups", label: "Pickups done", value: count(pickupsDone), detail: `of ${count(pickupsAssigned)} assigned · ${percent(pickupsDone, pickupsAssigned)}%` }
  ];

  const shownInsights = showAllInsights ? insights : insights.slice(0, 4);

  return (
    <div className={s.report}>
      <section className={s.toolbar}>
        <div className={s.title}>
          <h2>{formatDay(payload.businessDate, { weekday: "long", day: "numeric", month: "long" })}</h2>
          <p><i className={isLatest ? s.live : undefined} />{isLatest ? "Live" : "Past report"} · as of {formatWhen(payload.asOf)} IST · {reporting.length}/{payload.stations.length} stations reporting</p>
        </div>
        <nav className={s.dates} aria-label="Report date">
          {payload.dates.slice(0, 5).map((date) => (
            <a key={date} href={`/edd/flash?date=${date}`} aria-current={date === payload.businessDate ? "page" : undefined}>{formatDay(date, { day: "numeric", month: "short" })}</a>
          ))}
          <form action="/edd/flash">
            <input aria-label="Pick another date" title="Pick another date" name="date" type="date" defaultValue={payload.businessDate} key={payload.businessDate} onChange={(event) => { if (event.currentTarget.value) event.currentTarget.form?.requestSubmit(); }} />
          </form>
        </nav>
        <div className={s.actions}>
          <button type="button" onClick={() => saveReport("full")} disabled={downloading !== null}>
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

      <section className={s.summary} aria-label="Network summary">
        <div className={s.hero}>
          <span className={s.label}>Delivered of morning load</span>
          <div className={s.heroFigure}>
            <strong>{deliveredPct}%</strong>
            <span><b>{count(delivered)}</b> of {count(loadBase)}{hourGain !== null && hourGain > 0 ? <em>+{count(hourGain)} last hour</em> : null}</span>
          </div>
          <div className={s.track} role="img" aria-label={`${deliveredPct}% delivered`}><span style={{ width: `${Math.min(100, deliveredPct)}%` }} /></div>
        </div>
        {metrics.map((metric) => (
          <article className={s.metric} key={metric.label}>
            <header>
              <span className={s.label}>{metric.label}</span>
              {metric.kind ? (
                <button type="button" title={`Download ${metric.label} (Excel)`} aria-label={`Download ${metric.label}`} disabled={downloading !== null} onClick={() => saveReport(metric.kind!)}>
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

        {hourly.length ? (
          <section className={s.panel}>
            <header className={s.panelHead}><h3>Delivered through the day</h3><span>Hover a bar for details</span></header>
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
                  <tr key={row.stationCode}>
                    <th scope="row" title={row.hasSnapshot ? `Updated ${formatWhen(row.fetchedAt)}` : "Not fetched yet"}>
                      <strong>{row.stationCode}</strong>
                      {stationNames[row.stationCode] ? <span>{stationNames[row.stationCode]}</span> : null}
                      {flags.map((flag) => <i key={flag}>{flag}</i>)}
                    </th>
                    <td className={s.num}>{count(base)}</td>
                    <td title={`${count(row.cohortDelivered)} of ${count(base)} delivered`}><div className={s.delivery}>
                      <strong>{row.deliveredPct}%</strong>
                      <div className={s.track}><span style={{ width: `${width}%` }} /><em style={{ left: `${Math.min(100, deliveredPct)}%` }} /></div>
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
        <details className={s.more}>
          <summary>How to read this report</summary>
          <p>Morning load is the parcel list taken at the first check of the day. Delivered is measured against it, and includes parcels whose history shows Delivered even if Amazon later moved them back to Received. The line on each delivery bar is the network average ({deliveredPct}%). At station is inducted plus retained. Past EDD is stock whose delivery date has already passed. Hover a station or a number for more detail.</p>
        </details>
      </section>
    </div>
  );
}
