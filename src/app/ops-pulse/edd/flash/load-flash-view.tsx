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

  const metrics: Array<{ kind: Exclude<LoadFlashReportKind, "full">; label: string; value: string; detail: string }> = [
    { kind: "load", label: "At stations now", value: count(liveLoad), detail: `${count(sum(reporting, "inducted"))} inducted · ${count(sum(reporting, "retained"))} retained` },
    { kind: "edd", label: "EDD today", value: count(sum(reporting, "eddToday")), detail: `${count(eddPast)} past EDD · ${count(sum(reporting, "eddFuture"))} future` },
    { kind: "road", label: "Out on road", value: count(onRoad), detail: "In transit to the customer" },
    { kind: "delivered", label: "Delivered", value: count(delivered), detail: `${count(sum(reporting, "deliveredLive"))} in a delivered status now` },
    { kind: "returns", label: "Customer returns", value: count(returns), detail: "Due back at the station today" },
    { kind: "pickups", label: "Pickups done", value: count(pickupsDone), detail: `of ${count(pickupsAssigned)} assigned · ${percent(pickupsDone, pickupsAssigned)}%` }
  ];

  return (
    <div className={s.report}>
      <section className={s.masthead}>
        <div>
          <span className={s.eyebrow}>{isLatest ? "Live report" : "Past report"}</span>
          <h2>{formatDay(payload.businessDate, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</h2>
          <p><Clock size={13} /> Data as of {formatWhen(payload.asOf)} IST · {reporting.length} of {payload.stations.length} stations reporting</p>
        </div>
        <div className={s.mastheadActions}>
          <form action="/edd/flash" className={s.dateForm}>
            <label htmlFor="ops-live-date">Report date</label>
            <input id="ops-live-date" className="field" name="date" type="date" defaultValue={payload.businessDate} key={payload.businessDate} />
            <button className="button secondary" type="submit">Show</button>
          </form>
          <button type="button" className="button secondary" onClick={() => saveReport("full")} disabled={downloading !== null}>
            {downloading === "full" ? <Loader2 size={15} className="edd-spin" /> : <Download size={15} />} Full Excel
          </button>
          <button type="button" className="button secondary" onClick={refreshAll} disabled={starting || refreshing}>
            {starting || refreshing ? <Loader2 size={15} className="edd-spin" /> : <RefreshCw size={15} />} {refreshing ? "Refreshing…" : "Refresh all"}
          </button>
        </div>
        {payload.dates.length > 1 ? (
          <nav className={s.dates} aria-label="Recent report dates">
            {payload.dates.slice(0, 8).map((date) => (
              <a key={date} href={`/edd/flash?date=${date}`} aria-current={date === payload.businessDate ? "page" : undefined}>{formatDay(date, { weekday: "short", day: "numeric", month: "short" })}</a>
            ))}
          </nav>
        ) : null}
        {run && (refreshing || run.stationsFailed > 0) ? (
          <div className={s.sweep} role="status">
            <div className={s.track}><span style={{ width: `${refreshing ? sweepPct : 100}%` }} /></div>
            <span>{refreshing ? `Refreshing stations · ${run.stationsDone} of ${run.stationsTotal} done` : `Last refresh: ${run.stationsOk} of ${run.stationsTotal} stations updated`}{run.stationsFailed ? ` · ${run.stationsFailed} failed` : ""}</span>
          </div>
        ) : null}
        {error ? <p className={s.error} role="alert"><AlertTriangle size={14} /> {error}</p> : null}
      </section>

      <div className={s.lead}>
        <section className={s.hero} aria-label="Delivery progress">
          <span className={s.eyebrow}>Delivery progress</span>
          <div className={s.heroFigure}><strong>{deliveredPct}%</strong><span>of the morning load delivered</span></div>
          <div className={s.track} role="img" aria-label={`${deliveredPct}% delivered`}><span style={{ width: `${Math.min(100, deliveredPct)}%` }} /></div>
          <p><b>{count(delivered)}</b> of <b>{count(loadBase)}</b> parcels{hourGain !== null && hourGain > 0 ? <> · <b>+{count(hourGain)}</b> in the last hour</> : null}</p>
          <dl className={s.heroFacts}>
            <div><dt>Out on road</dt><dd>{count(onRoad)}</dd></div>
            <div><dt>Still at stations</dt><dd>{count(liveLoad)}</dd></div>
            <div><dt>Past EDD</dt><dd>{count(eddPast)}</dd></div>
          </dl>
          <small>Delivered counts the morning tracking-ID list, including parcels whose history shows Delivered even if Amazon later moved them back to Received.</small>
        </section>

        <section className={s.insights} aria-label="What needs attention">
          <span className={s.eyebrow}>What needs attention</span>
          {insights.length ? (
            <ol>
              {insights.map((insight) => {
                const Icon = TONE_ICON[insight.tone];
                return (
                  <li key={insight.title} className={s[insight.tone]}>
                    <span className={s.tone}><Icon size={13} /> {TONE_LABEL[insight.tone]}</span>
                    <div>
                      <strong>{insight.title}</strong>
                      <p>{insight.detail}</p>
                    </div>
                    {insight.filter ? <button type="button" onClick={() => showFilter(insight.filter!)}>Show stations</button> : null}
                  </li>
                );
              })}
            </ol>
          ) : <p className={s.empty}>{reporting.length ? "Nothing stands out right now." : "No station has reported for this date yet."}</p>}
        </section>
      </div>

      <section className={s.metrics} aria-label="Network totals">
        {metrics.map((metric) => (
          <article className={s.metric} key={metric.kind}>
            <header>
              <span>{metric.label}</span>
              <button type="button" title={`Download ${metric.label} (Excel)`} aria-label={`Download ${metric.label}`} disabled={downloading !== null} onClick={() => saveReport(metric.kind)}>
                {downloading === metric.kind ? <Loader2 size={13} className="edd-spin" /> : <Download size={13} />}
              </button>
            </header>
            <strong>{metric.value}</strong>
            <small>{metric.detail}</small>
          </article>
        ))}
      </section>

      {hourly.length ? (
        <section className={s.panel}>
          <header className={s.panelHead}>
            <div><h3>Delivered through the day</h3><p>Morning-load parcels delivered by each hourly check. Hover a bar for that hour’s numbers.</p></div>
          </header>
          <div className={s.chart}>
            {hourly.map((point, index) => (
              <div key={point.hour} className={s.bar} tabIndex={0} aria-label={`${String(point.hour).padStart(2, "0")}:00 — ${count(point.delivered)} delivered of ${count(point.totalLoad)} load`}>
                {index === hourly.length - 1 ? <b>{count(point.delivered)}</b> : null}
                <span style={{ height: `${Math.max(2, (point.delivered / maxDelivered) * 100)}%` }} />
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
          <details className={s.chartTable}>
            <summary>View as a table</summary>
            <table>
              <thead><tr><th scope="col">Hour</th><th scope="col">Load</th><th scope="col">Delivered</th><th scope="col">Delivered %</th><th scope="col">Out on road</th></tr></thead>
              <tbody>{hourly.map((point) => <tr key={point.hour}><td>{String(point.hour).padStart(2, "0")}:00</td><td>{count(point.totalLoad)}</td><td>{count(point.delivered)}</td><td>{percent(point.delivered, point.totalLoad)}%</td><td>{count(point.outOnRoad)}</td></tr>)}</tbody>
            </table>
          </details>
        </section>
      ) : null}

      <section className={s.panel} id="ops-live-stations">
        <header className={s.panelHead}>
          <div><h3>Station by station</h3><p>Sorted by {sortKey === "base" ? "morning load" : "your chosen column"}. The marker on each delivery bar is the network average ({deliveredPct}%).</p></div>
          <label className={s.search}><Search size={15} /><span className={s.srOnly}>Search station</span><input type="search" placeholder="Search station code or name" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        </header>
        <div className={s.chips} role="group" aria-label="Show stations">
          {(Object.keys(FILTERS) as FilterKey[]).map((key) => (
            <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)}>{FILTERS[key].label}<b>{filterCounts[key]}</b></button>
          ))}
        </div>
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                {header("stationCode", "Station", false)}
                {header("base", "Morning load")}
                {header("deliveredPct", "Delivered", false)}
                {header("outOnRoad", "Out on road")}
                {header("totalLoad", "At station now")}
                {header("eddToday", "EDD today")}
                {header("eddPast", "Past EDD")}
                {header("returnsToday", "Returns due")}
                {header("pickupPct", "Pickups")}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const base = baseOf(row);
                const width = base > 0 ? Math.min(100, (row.cohortDelivered / base) * 100) : 0;
                const flags = [
                  !row.hasSnapshot ? "Waiting for first fetch" : isStale(row) ? "Data may be stale" : "",
                  FILTERS.notStarted.test(row, isStale) ? "No deliveries yet" : "",
                  FILTERS.idle.test(row, isStale) ? "Nothing on road" : ""
                ].filter(Boolean);
                return (
                  <tr key={row.stationCode}>
                    <th scope="row">
                      <strong>{row.stationCode}</strong>
                      {stationNames[row.stationCode] ? <span>{stationNames[row.stationCode]}</span> : null}
                      <small>{row.hasSnapshot ? `Updated ${formatWhen(row.fetchedAt)}` : "Not fetched yet"}</small>
                      {flags.length ? <div className={s.flags}>{flags.map((flag) => <i key={flag}>{flag}</i>)}</div> : null}
                    </th>
                    <td className={s.num}>{count(base)}</td>
                    <td className={s.delivery}>
                      <div><strong>{row.deliveredPct}%</strong><span>{count(row.cohortDelivered)} of {count(base)}</span></div>
                      <div className={s.track}><span style={{ width: `${width}%` }} /><em style={{ left: `${Math.min(100, deliveredPct)}%` }} /></div>
                    </td>
                    <td className={s.num}>{row.outOnRoad ? count(row.outOnRoad) : <span className={s.zero}>0</span>}</td>
                    <td className={s.num}>{count(row.totalLoad)}<small>{count(row.inducted)} + {count(row.retained)} retained</small></td>
                    <td className={s.num}>{row.eddToday ? count(row.eddToday) : <span className={s.zero}>0</span>}<small>{count(row.eddFuture)} future</small></td>
                    <td className={s.num}>{row.eddPast ? <span className={s.alert}>{count(row.eddPast)}</span> : <span className={s.zero}>0</span>}</td>
                    <td className={s.num}>{row.returnsToday ? count(row.returnsToday) : <span className={s.zero}>0</span>}</td>
                    <td className={s.num}>{row.pickupsAssigned ? <>{row.pickupPct}%<small>{count(row.pickupsSuccess)} of {count(row.pickupsAssigned)}</small></> : <span className={s.zero}>—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
            {rows.length > 1 ? (
              <tfoot>
                <tr>
                  <th scope="row">Total · {rows.length} stations</th>
                  <td className={s.num}>{count(rows.reduce((total, row) => total + baseOf(row), 0))}</td>
                  <td className={s.delivery}><div><strong>{percent(sum(rows, "cohortDelivered"), rows.reduce((total, row) => total + baseOf(row), 0))}%</strong><span>{count(sum(rows, "cohortDelivered"))} delivered</span></div></td>
                  <td className={s.num}>{count(sum(rows, "outOnRoad"))}</td>
                  <td className={s.num}>{count(sum(rows, "totalLoad"))}</td>
                  <td className={s.num}>{count(sum(rows, "eddToday"))}</td>
                  <td className={s.num}>{count(sum(rows, "eddPast"))}</td>
                  <td className={s.num}>{count(sum(rows, "returnsToday"))}</td>
                  <td className={s.num}>{percent(sum(rows, "pickupsSuccess"), sum(rows, "pickupsAssigned"))}%</td>
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
        {!rows.length ? <p className={s.empty}>No stations match. {filter !== "all" || query ? <button type="button" onClick={() => { setFilter("all"); setQuery(""); }}>Show all stations</button> : null}</p> : null}
        <footer className={s.notes}>
          <strong>How to read this report</strong>
          <span>Morning load is the parcel list taken at the first check of the day; Delivered is measured against it and locked once history shows Delivered. At station now is inducted plus retained. Past EDD is stock whose delivery date has already passed.</span>
        </footer>
      </section>
    </div>
  );
}
