"use client";

import { useEffect, useMemo, useState } from "react";
import { Download, Loader2, RefreshCw } from "lucide-react";
import type { EddNetworkRunStatus, LoadFlashNetworkPayload, LoadFlashStation } from "@/lib/ops-pulse/edd-worker";
import type { LoadFlashReportKind } from "@/lib/ops-pulse/load-flash-report";

const POLL_MS = 4000;

function formatWhen(value: string | null) {
  if (!value) return "Not fetched yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function count(value: number) {
  return value.toLocaleString("en-IN");
}

function sum(rows: LoadFlashStation[], key: keyof LoadFlashStation) {
  return rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);
}

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

export function LoadFlashView({ initial }: { initial: LoadFlashNetworkPayload }) {
  const [payload, setPayload] = useState(initial);
  const [run, setRun] = useState<EddNetworkRunStatus | null>(initial.run);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
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
          const body = await response.json() as { run?: EddNetworkRunStatus | null };
          if (!cancelled && body.run) setRun(body.run);
          if (body.run && body.run.status !== "running") {
            await pull();
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

  const rows = useMemo(() => {
    const needle = query.trim().toUpperCase();
    return payload.stations
      .filter((row) => !needle || row.stationCode.includes(needle))
      .sort((a, b) => (b.morningLoad ?? b.totalLoad) - (a.morningLoad ?? a.totalLoad) || a.stationCode.localeCompare(b.stationCode));
  }, [payload.stations, query]);

  const reporting = payload.stations.filter((row) => row.hasSnapshot);
  const morning = sum(reporting, "morningLoad");
  const liveLoad = sum(reporting, "totalLoad");
  const delivered = sum(reporting, "cohortDelivered");
  const loadBase = morning || liveLoad;
  const deliveredPct = loadBase > 0 ? Math.round((delivered / loadBase) * 1000) / 10 : 0;
  const maxHour = Math.max(1, ...payload.hourly.map((point) => Math.max(point.totalLoad, point.delivered)));
  const sweepPct = run && run.stationsTotal ? Math.round((run.stationsDone / run.stationsTotal) * 100) : 0;

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
        const body = await response.json();
        if (!response.ok) throw new Error(String(body.error ?? "Unable to refresh."));
        setRun(body.run ?? null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to refresh."))
      .finally(() => setStarting(false));
  }

  return (
    <>
      <form action="/edd/flash" className="panel" style={{ marginBottom: 8 }}>
        <div className="panel-body" style={{ display: "flex", gap: 12, alignItems: "end", flexWrap: "wrap" }}>
          <label>Report date
            <input className="field" name="date" type="date" defaultValue={payload.businessDate} />
          </label>
          <button className="button secondary" type="submit">Show date</button>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {payload.dates.slice(0, 8).map((date) => (
              <a key={date} className={`status-pill ${date === payload.businessDate ? "good" : "neutral"}`} href={`/edd/flash?date=${date}`}>{date.slice(5)}</a>
            ))}
          </div>
          <span className="subtle" style={{ marginLeft: "auto" }}>As of {formatWhen(payload.asOf)} IST</span>
        </div>
      </form>

      <section className="edd-hero-card">
        <div className="edd-hero-card-top">
          <span>Network load vs delivered</span>
          <span className="edd-severity">{deliveredPct}%</span>
        </div>
        <strong>{count(delivered)} <span style={{ fontSize: 22, fontWeight: 600 }}>/ {count(loadBase)}</span></strong>
        <small>
          Morning census delivered, including packages whose history shows Delivered even if Amazon later moved them back to Received.
          {reporting.length < payload.stations.length ? ` ${reporting.length}/${payload.stations.length} stations reporting.` : ""}
        </small>
      </section>

      <section className="ops-live-metrics" aria-label="Ops Live totals">
        {([
          ["load", "load", "Total load", count(liveLoad), `${count(sum(reporting, "inducted"))} inducted · ${count(sum(reporting, "retained"))} retained`],
          ["edd", "edd", "EDD today", count(sum(reporting, "eddToday")), `${count(sum(reporting, "eddPast"))} past · ${count(sum(reporting, "eddFuture"))} future`],
          ["road", "road", "Out on road", count(sum(reporting, "outOnRoad")), "In transit to the customer"],
          ["delivered", "delivered", "Delivered", count(delivered), `${count(sum(reporting, "deliveredLive"))} in a delivered status`],
          ["returns", "returns", "Customer returns", count(sum(reporting, "returnsToday")), "Due back at the station today"],
          ["pickups", "pickups", "Pickup success", count(sum(reporting, "pickupsSuccess")), `of ${count(sum(reporting, "pickupsAssigned"))} assigned`]
        ] as const).map(([kind, tone, label, value, detail]) => (
          <article className={`ops-live-metric ${tone}`} key={kind}>
            <div className="ops-live-metric-top">
              <span>{label}</span>
              <button type="button" aria-label={`Download ${label}`} disabled={downloading !== null} onClick={() => saveReport(kind)}>
                {downloading === kind ? <Loader2 size={12} className="edd-spin" /> : <Download size={12} />}
              </button>
            </div>
            <strong>{value}</strong>
            <small>{detail}</small>
          </article>
        ))}
      </section>

      {payload.hourly.length ? (
        <section className="panel">
          <div className="panel-head"><div><h3>Hourly flash</h3><p className="subtle">Each bar is the network total at that hour. Dark is load, green is morning-census delivered.</p></div></div>
          <div className="panel-body" style={{ display: "flex", gap: 10, alignItems: "end", minHeight: 140, overflowX: "auto" }}>
            {payload.hourly.map((point) => (
              <div key={point.hour} style={{ width: 36, textAlign: "center" }} title={`${point.hour}:30 · load ${point.totalLoad} · delivered ${point.delivered}`}>
                <div style={{ height: 96, display: "flex", alignItems: "end", justifyContent: "center", gap: 3 }}>
                  <div style={{ width: 10, height: `${Math.max(4, (point.totalLoad / maxHour) * 96)}px`, background: "#94a3b8", borderRadius: 4 }} />
                  <div style={{ width: 10, height: `${Math.max(4, (point.delivered / maxHour) * 96)}px`, background: "#15803d", borderRadius: 4 }} />
                </div>
                <small className="subtle">{String(point.hour).padStart(2, "0")}</small>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Stations</h3>
            <p className="subtle">Load is inducted plus retained. Delivered is the morning tracking-ID list, locked once history shows Delivered.</p>
          </div>
          <div style={{ display: "inline-flex", gap: 8 }}>
          <button type="button" className="button secondary" onClick={() => saveReport("full")} disabled={downloading !== null} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            {downloading === "full" ? <Loader2 size={16} className="edd-spin" /> : <Download size={16} />}
            Full data
          </button>
          <button type="button" className="button secondary" onClick={refreshAll} disabled={starting || run?.status === "running"} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            {starting || run?.status === "running" ? <Loader2 size={16} className="edd-spin" /> : <RefreshCw size={16} />}
            {run?.status === "running" ? "Refreshing…" : "Refresh all"}
          </button>
          </div>
        </div>
        {run ? (
          <div className="panel-body edd-sweep-status">
            <div className="edd-sweep-bar"><div className="edd-sweep-bar-fill" style={{ width: `${run.status === "running" ? sweepPct : 100}%` }} /></div>
            <span className="subtle">{run.stationsDone}/{run.stationsTotal} stations · {run.stationsOk} ok{run.stationsFailed ? ` · ${run.stationsFailed} failed` : ""}</span>
          </div>
        ) : null}
        <div className="panel-body">
          <div className="edd-toolbar">
            <input type="search" placeholder="Search station" value={query} onChange={(event) => setQuery(event.target.value)} style={{ minWidth: 220 }} />
          </div>
          {error ? <p className="subtle" style={{ color: "var(--red)" }}>{error}</p> : null}
          <div className="edd-table-wrap">
            <table className="edd-table">
              <thead>
                <tr>
                  <th>Station</th>
                  <th className="num">Load</th>
                  <th className="num">EDD today</th>
                  <th className="num">Past / future</th>
                  <th className="num">Out on road</th>
                  <th>Delivered</th>
                  <th className="num">Returns</th>
                  <th className="num">Pickups</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const base = row.morningLoad ?? row.totalLoad;
                  const width = base > 0 ? Math.min(100, Math.round((row.cohortDelivered / base) * 100)) : 0;
                  return (
                    <tr key={row.stationCode}>
                      <td><strong>{row.stationCode}</strong><div className="subtle">{row.hasSnapshot ? formatWhen(row.fetchedAt) : "Waiting for the first fetch"}</div></td>
                      <td className="num">{count(row.totalLoad)}<div className="subtle">{count(row.inducted)} + {count(row.retained)}</div></td>
                      <td className="num">{count(row.eddToday)}</td>
                      <td className="num">{count(row.eddPast)} / {count(row.eddFuture)}</td>
                      <td className="num">{count(row.outOnRoad)}</td>
                      <td style={{ minWidth: 160 }}>
                        <strong>{count(row.cohortDelivered)}</strong> <span className="subtle">/ {count(base)} · {row.deliveredPct}%</span>
                        <div style={{ marginTop: 6, height: 8, background: "#e2e8f0", borderRadius: 99 }}>
                          <div style={{ width: `${width}%`, height: "100%", background: "#15803d", borderRadius: 99 }} />
                        </div>
                      </td>
                      <td className="num">{count(row.returnsToday)}</td>
                      <td className="num">{count(row.pickupsSuccess)}<div className="subtle">of {count(row.pickupsAssigned)} · {row.pickupPct}%</div></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </>
  );
}
