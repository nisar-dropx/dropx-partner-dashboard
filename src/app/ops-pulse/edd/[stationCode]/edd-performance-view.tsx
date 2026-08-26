"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { formatCiaDisplayDate, todayIstYmd } from "@/lib/ops-pulse/cia-types";
import type { EddPerformancePayload } from "@/lib/ops-pulse/edd-worker";
import { EddDateRangePicker } from "../edd-date-range-picker";

async function fetchPerformance(stationCode: string, from: string, to: string): Promise<EddPerformancePayload> {
  const url = new URL("/api/ops-pulse/edd/performance", window.location.origin);
  url.searchParams.set("stationCode", stationCode);
  url.searchParams.set("from", from);
  url.searchParams.set("to", to);
  const response = await fetch(url.toString(), { headers: { Accept: "application/json" }, cache: "no-store" });
  const raw = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(raw.error ?? `Unable to load the performance report (${response.status}).`));
  return raw as EddPerformancePayload;
}

/**
 * Assigned / delivered / returned / held for a station over a date range —
 * always a live Amazon fetch (see fetchEddPerformance), so this has its own
 * date-range picker rather than reusing the Ageing tab's cached-snapshot
 * "Filter to one day" control. Defaults to today.
 */
export function EddPerformanceView({ stationCode }: { stationCode: string }) {
  const today = todayIstYmd();
  const [appliedFrom, setAppliedFrom] = useState(today);
  const [appliedTo, setAppliedTo] = useState(today);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [payload, setPayload] = useState<EddPerformancePayload | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchPerformance(stationCode, appliedFrom, appliedTo)
      .then((data) => {
        if (!cancelled) setPayload(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Unable to load the performance report.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [stationCode, appliedFrom, appliedTo]);

  const assigned = payload?.assigned ?? 0;

  return (
    <>
      <section className="panel">
        <div className="panel-body">
          <h3 style={{ margin: 0 }}>Check performance for a date range</h3>
          <p className="subtle" style={{ marginTop: 4 }}>
            Assigned, delivered, returned, and held packages for {stationCode} — defaults to today. Always pulled live
            from Amazon, so a wide range can take a little longer.
          </p>
          <div style={{ marginTop: 12 }}>
            <EddDateRangePicker
              from={appliedFrom}
              to={appliedTo}
              loading={loading}
              onApply={(from, to) => {
                setAppliedFrom(from);
                setAppliedTo(to);
              }}
            />
          </div>
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

      {loading && !payload ? (
        <section className="panel">
          <div className="panel-body" style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Loader2 size={18} className="edd-spin" />
            <span className="subtle">Pulling assigned/delivered/returned/held live from Amazon…</span>
          </div>
        </section>
      ) : null}

      {payload ? (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>
                {formatCiaDisplayDate(payload.window.from)}
                {payload.window.from !== payload.window.to ? ` – ${formatCiaDisplayDate(payload.window.to)}` : ""}
              </h3>
              <p className="subtle">{assigned.toLocaleString("en-IN")} packages assigned to {stationCode} in this window.</p>
            </div>
          </div>
          <div className="panel-body">
            <div className="edd-performance-grid">
              <div className="edd-bucket-card static">
                <span>Assigned</span>
                <strong>{assigned.toLocaleString("en-IN")}</strong>
                <small>Total packages in this window</small>
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
              <p className="subtle" style={{ marginTop: 10 }}>No packages were assigned to {stationCode} in this window.</p>
            )}
          </div>
        </section>
      ) : null}
    </>
  );
}
