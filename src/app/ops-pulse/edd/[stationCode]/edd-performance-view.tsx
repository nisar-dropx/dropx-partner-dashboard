"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, BookOpen, CalendarDays, Loader2, RefreshCw, Users } from "lucide-react";
import { PendingLink } from "@/components/pending-link";
import { formatCiaDisplayDate } from "@/lib/ops-pulse/cia-types";
import type { EddPerformanceDailyRow, EddPerformanceNetworkStation, EddPerformancePayload } from "@/lib/ops-pulse/edd-worker";
import { deliverySeverity, deliverySeverityLabel } from "../edd-performance-severity";
import { EddPerformanceByAssociate } from "./edd-performance-by-associate";
import { EddPerformanceByDate } from "./edd-performance-by-date";
import { EddPerformanceLedger } from "./edd-performance-ledger";

type FetchOutcome = { status: "ok"; payload: EddPerformancePayload } | { status: "no_snapshot" };
type PerformanceView = "associate" | "date" | "ledger";

async function fetchPerformance(stationCode: string): Promise<FetchOutcome> {
  const url = new URL("/api/ops-pulse/edd/performance", window.location.origin);
  url.searchParams.set("stationCode", stationCode);
  const response = await fetch(url.toString(), { headers: { Accept: "application/json" }, cache: "no-store" });
  const raw = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(raw.error ?? `Unable to load the performance report (${response.status}).`));
  if (raw.status === "no_snapshot") return { status: "no_snapshot" };
  // The GET route returns { status: "ok", payload: EddPerformancePayload } —
  // unwrap it here (unlike refreshPerformance below, whose POST route
  // returns the station payload directly).
  return { status: "ok", payload: raw.payload as EddPerformancePayload };
}

async function refreshPerformance(stationCode: string): Promise<EddPerformancePayload> {
  const url = new URL("/api/ops-pulse/edd/performance/refresh", window.location.origin);
  url.searchParams.set("stationCode", stationCode);
  const response = await fetch(url.toString(), { method: "POST", headers: { Accept: "application/json" }, cache: "no-store" });
  const raw = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(raw.error ?? `Unable to refresh the performance report (${response.status}).`));
  return raw as EddPerformancePayload;
}

/** Best-effort — used only for the "vs. network average" insight chip, so a failure here just hides that chip rather than the page. */
async function fetchNetworkAverage(): Promise<number | null> {
  try {
    const response = await fetch(new URL("/api/ops-pulse/edd/performance/network", window.location.origin).toString(), {
      headers: { Accept: "application/json" },
      cache: "no-store"
    });
    if (!response.ok) return null;
    const raw = await response.json().catch(() => ({}));
    const stations = (Array.isArray(raw.stations) ? raw.stations : []) as EddPerformanceNetworkStation[];
    const withData = stations.filter((row) => row.hasSnapshot && row.assigned > 0);
    if (!withData.length) return null;
    const totalAssigned = withData.reduce((sum, row) => sum + row.assigned, 0);
    const totalDelivered = withData.reduce((sum, row) => sum + row.delivered, 0);
    return totalAssigned > 0 ? Math.round((totalDelivered / totalAssigned) * 1000) / 10 : null;
  } catch {
    return null;
  }
}

/** Best-effort — an empty/failed archive just means "By date"/"Day-wise ledger" show today only, not a page-breaking error. */
async function fetchDaily(stationCode: string): Promise<EddPerformanceDailyRow[]> {
  try {
    const url = new URL("/api/ops-pulse/edd/performance/daily", window.location.origin);
    url.searchParams.set("stationCode", stationCode);
    // 90 days (the route's own cap) — covers Day-wise ledger's 30-day view and
    // By date's multi-day picker with headroom, in one fetch.
    url.searchParams.set("days", "90");
    const response = await fetch(url.toString(), { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!response.ok) return [];
    const raw = await response.json().catch(() => ({}));
    return Array.isArray(raw.days) ? (raw.days as EddPerformanceDailyRow[]) : [];
  } catch {
    return [];
  }
}

function formatFetchedAt(value: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/**
 * Today's assigned/delivered/returned/held for one station — a cached
 * snapshot kept current by the worker's 15-minute sweep, plus a manual
 * "Refresh" button. A Delivery Performance hero card (severity-colored,
 * compared against the network average) is the one persistent headline;
 * everything else lives behind three tabs mirroring CIA's station page
 * (By associate / By date / Day-wise ledger) so the detail a manager
 * actually digs into isn't all flattened onto one screen at once.
 */
export function EddPerformanceView({ stationCode }: { stationCode: string }) {
  const [payload, setPayload] = useState<EddPerformancePayload | null>(null);
  const [noSnapshot, setNoSnapshot] = useState(false);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [networkAvg, setNetworkAvg] = useState<number | null>(null);
  const [dailyRows, setDailyRows] = useState<EddPerformanceDailyRow[]>([]);
  const [view, setView] = useState<PerformanceView>("associate");

  useEffect(() => {
    if (!stationCode) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchPerformance(stationCode)
      .then((outcome) => {
        if (cancelled) return;
        if (outcome.status === "no_snapshot") {
          setPayload(null);
          setNoSnapshot(true);
        } else {
          setPayload(outcome.payload);
          setNoSnapshot(false);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setPayload(null);
        setError(err instanceof Error ? err.message : "Unable to load the performance report.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    void fetchNetworkAverage().then((avg) => {
      if (!cancelled) setNetworkAvg(avg);
    });
    void fetchDaily(stationCode).then((rows) => {
      if (!cancelled) setDailyRows(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [stationCode]);

  function runRefresh() {
    setRefreshing(true);
    setError(null);
    refreshPerformance(stationCode)
      .then((fresh) => {
        setPayload(fresh);
        setNoSnapshot(false);
        void fetchDaily(stationCode).then(setDailyRows);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Unable to refresh the performance report.");
      })
      .finally(() => setRefreshing(false));
  }

  const assigned = payload?.assigned ?? 0;
  const severity = payload && assigned > 0 ? deliverySeverity(payload.deliveredPct) : null;
  const diffVsNetwork = payload && assigned > 0 && networkAvg != null ? Math.round((payload.deliveredPct - networkAvg) * 10) / 10 : null;

  return (
    <>
      <section className="panel">
        <div className="panel-body edd-toolbar">
          <PendingLink className="edd-back-link" href="/edd/performance">
            <ArrowLeft size={14} /> All stations
          </PendingLink>

          <span className="subtle" style={{ flex: "1 1 auto" }}>
            {refreshing
              ? "Pulling today's assigned/delivered/returned/held live from Amazon…"
              : payload
                ? `Today (${formatCiaDisplayDate(payload.window.from)}) · fetched ${formatFetchedAt(payload.fetchedAt)} · refreshed automatically every 15 minutes`
                : " "}
          </span>

          <button
            type="button"
            className="button secondary"
            onClick={runRefresh}
            disabled={refreshing || loading}
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            {refreshing ? <Loader2 size={16} className="edd-spin" /> : <RefreshCw size={16} />}
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </section>

      {error ? (
        <section className="panel message-panel error">
          <div className="panel-body">
            <strong>Unable to load performance for {stationCode}</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{error}</p>
          </div>
        </section>
      ) : null}

      {loading ? (
        <section className="panel">
          <div className="panel-body" style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Loader2 size={18} className="edd-spin" />
            <span className="subtle">Loading the saved performance snapshot for {stationCode}…</span>
          </div>
        </section>
      ) : null}

      {!loading && noSnapshot && !payload ? (
        <section className="panel message-panel info">
          <div className="panel-body">
            <strong>No performance snapshot yet for {stationCode}</strong>
            <p className="subtle" style={{ marginTop: 6 }}>
              The 15-minute sweep hasn&apos;t reached this station yet. Click &ldquo;Refresh&rdquo; above to pull it now.
            </p>
          </div>
        </section>
      ) : null}

      {payload ? (
        <>
          {severity ? (
            <section className={`edd-hero-card ${severity}`}>
              <div className="edd-hero-card-top">
                <span>{stationCode} delivery performance</span>
                <span className={`edd-severity ${severity}`}>{deliverySeverityLabel(severity)}</span>
              </div>
              <strong>{payload.deliveredPct}%</strong>
              <small>{payload.delivered.toLocaleString("en-IN")} of {assigned.toLocaleString("en-IN")} assigned packages delivered today</small>
              {diffVsNetwork != null || payload.yetToDispatch > 0 ? (
                <div className="edd-insight-row">
                  {diffVsNetwork != null ? (
                    <span className={`edd-insight-chip ${diffVsNetwork >= 0 ? "positive" : "negative"}`}>
                      <strong>{diffVsNetwork >= 0 ? "+" : ""}{diffVsNetwork} pts</strong> vs. network average ({networkAvg}%)
                    </span>
                  ) : null}
                  {payload.yetToDispatch > 0 ? (
                    <span className="edd-insight-chip" title="Still at the station, no driver or store attached yet — not counted in Assigned above">
                      <strong>{payload.yetToDispatch.toLocaleString("en-IN")}</strong> yet to dispatch (not in Assigned)
                    </span>
                  ) : null}
                </div>
              ) : null}
            </section>
          ) : (
            <section className="panel message-panel info">
              <div className="panel-body">
                <strong>No packages were assigned to {stationCode} today.</strong>
              </div>
            </section>
          )}

          <section className="panel">
            <div className="panel-body" style={{ display: "flex", justifyContent: "flex-start" }}>
              <div className="edd-view-toggle" role="tablist" aria-label="How to view this station's performance">
                <button type="button" role="tab" aria-selected={view === "associate"} className={`edd-view-tab${view === "associate" ? " active" : ""}`} onClick={() => setView("associate")}>
                  <Users size={16} aria-hidden /> By associate
                </button>
                <button type="button" role="tab" aria-selected={view === "date"} className={`edd-view-tab${view === "date" ? " active" : ""}`} onClick={() => setView("date")}>
                  <CalendarDays size={16} aria-hidden /> By date
                </button>
                <button type="button" role="tab" aria-selected={view === "ledger"} className={`edd-view-tab${view === "ledger" ? " active" : ""}`} onClick={() => setView("ledger")}>
                  <BookOpen size={16} aria-hidden /> Day-wise ledger
                </button>
              </div>
            </div>
          </section>

          {view === "associate" ? (
            <EddPerformanceByAssociate packages={payload.packages} />
          ) : view === "date" ? (
            <EddPerformanceByDate
              stationCode={stationCode}
              rows={dailyRows}
              todayAssigned={payload.assigned}
              todayDelivered={payload.delivered}
              todayReturned={payload.returned}
              todayHeld={payload.held}
              todayYetToDispatch={payload.yetToDispatch}
              todayDeliveredPct={payload.deliveredPct}
            />
          ) : (
            <EddPerformanceLedger rows={dailyRows} />
          )}
        </>
      ) : null}
    </>
  );
}
