"use client";

import { useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { formatCiaDisplayDate } from "@/lib/ops-pulse/cia-types";
import type { EddPerformanceNetworkStation, EddPerformancePayload } from "@/lib/ops-pulse/edd-worker";
import { deliverySeverity, deliverySeverityLabel } from "../edd-performance-severity";

type FetchOutcome = { status: "ok"; payload: EddPerformancePayload } | { status: "no_snapshot" };

async function fetchPerformance(stationCode: string): Promise<FetchOutcome> {
  const url = new URL("/api/ops-pulse/edd/performance", window.location.origin);
  url.searchParams.set("stationCode", stationCode);
  const response = await fetch(url.toString(), { headers: { Accept: "application/json" }, cache: "no-store" });
  const raw = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(raw.error ?? `Unable to load the performance report (${response.status}).`));
  if (raw.status === "no_snapshot") return { status: "no_snapshot" };
  return { status: "ok", payload: raw as EddPerformancePayload };
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

function formatFetchedAt(value: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/**
 * Today's assigned/delivered/returned/held for one station — a cached
 * snapshot kept current by the worker's 15-minute sweep, plus a manual
 * "Refresh" button. Led by a Delivery Performance hero card (severity-
 * colored, compared against the network average) so the headline number
 * a manager actually wants doesn't get lost among four equal-weight tiles.
 */
export function EddPerformanceView({ stationCode }: { stationCode: string }) {
  const [payload, setPayload] = useState<EddPerformancePayload | null>(null);
  const [noSnapshot, setNoSnapshot] = useState(false);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [networkAvg, setNetworkAvg] = useState<number | null>(null);

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
          <span className="subtle" style={{ marginLeft: "auto" }}>
            {refreshing
              ? "Pulling today's assigned/delivered/returned/held live from Amazon…"
              : payload
                ? `Today (${formatCiaDisplayDate(payload.window.from)}) · fetched ${formatFetchedAt(payload.fetchedAt)} · refreshed automatically every 15 minutes`
                : " "}
          </span>
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
              {diffVsNetwork != null ? (
                <div className="edd-insight-row">
                  <span className={`edd-insight-chip ${diffVsNetwork >= 0 ? "positive" : "negative"}`}>
                    <strong>{diffVsNetwork >= 0 ? "+" : ""}{diffVsNetwork} pts</strong> vs. network average ({networkAvg}%)
                  </span>
                </div>
              ) : null}
            </section>
          ) : null}

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{formatCiaDisplayDate(payload.window.from)}</h3>
                <p className="subtle">{assigned.toLocaleString("en-IN")} packages assigned to {stationCode} today.</p>
              </div>
            </div>
            <div className="panel-body">
              <div className="edd-performance-grid">
                <div className="edd-bucket-card static">
                  <span>Assigned</span>
                  <strong>{assigned.toLocaleString("en-IN")}</strong>
                  <small>Total packages today</small>
                </div>
                <div className="edd-bucket-card static future">
                  <span>Delivered</span>
                  <strong>{payload.delivered.toLocaleString("en-IN")}</strong>
                  <small>{payload.deliveredPct}% · reached the customer</small>
                </div>
                <div className="edd-bucket-card static dueToday">
                  <span>Held</span>
                  <strong>{payload.held.toLocaleString("en-IN")}</strong>
                  <small>{payload.heldPct}% · still moving through the station</small>
                </div>
                <div className="edd-bucket-card static overdue">
                  <span>Returned</span>
                  <strong>{payload.returned.toLocaleString("en-IN")}</strong>
                  <small>{payload.returnedPct}% · failed, rejected, or undeliverable</small>
                </div>
              </div>

              {assigned ? (
                <>
                  <div className="edd-performance-bar" role="img" aria-label="Delivered, held, and returned share of assigned packages">
                    <div className="edd-performance-bar-segment delivered" style={{ width: `${payload.deliveredPct}%` }} />
                    <div className="edd-performance-bar-segment held" style={{ width: `${payload.heldPct}%` }} />
                    <div className="edd-performance-bar-segment returned" style={{ width: `${payload.returnedPct}%` }} />
                  </div>
                  <div className="edd-performance-legend">
                    <span><i className="edd-legend-dot delivered" aria-hidden="true" /> Delivered {payload.deliveredPct}%</span>
                    <span><i className="edd-legend-dot held" aria-hidden="true" /> Held {payload.heldPct}%</span>
                    <span><i className="edd-legend-dot returned" aria-hidden="true" /> Returned {payload.returnedPct}%</span>
                  </div>
                </>
              ) : (
                <p className="subtle" style={{ marginTop: 10 }}>No packages were assigned to {stationCode} today.</p>
              )}
            </div>
          </section>
        </>
      ) : null}
    </>
  );
}
