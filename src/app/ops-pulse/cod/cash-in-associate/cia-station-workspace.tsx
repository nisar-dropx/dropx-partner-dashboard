"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { formatDateTime } from "@/lib/ops-pulse/cod";
import { formatCiaDisplayDate, type CiaPendingDriver, type CiaStationPayload } from "@/lib/ops-pulse/cia-types";
import { CiaStationDetail } from "./cia-station-detail";
import { CiaStationRefreshButton } from "./cia-client";
import { friendlyCiaWorkerError, readCiaJson } from "./cia-fetch";
import { CiaSummaryMetrics } from "./cia-summary-metrics";

type StationSummary = CiaStationPayload["summary"];

function validYmd(value: unknown) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ""));
}

async function fetchCiaStationLive(stationCode: string, fromDate: string, toDate: string) {
  const url = new URL("/api/ops-pulse/cod/cash-recon/cash-in-associate", window.location.origin);
  url.searchParams.set("stationCode", stationCode);
  url.searchParams.set("fromDate", fromDate);
  url.searchParams.set("toDate", toDate);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store"
  });
  const { payload, text } = await readCiaJson(response);
  if (!response.ok) {
    throw new Error(
      friendlyCiaWorkerError(String(payload.error ?? payload.message ?? text ?? ""), response.status)
    );
  }
  return payload as unknown as CiaStationPayload;
}

export function CiaStationWorkspace({
  stationCode,
  stationTitle,
  placeBits,
  initialPayload,
  initialError
}: {
  stationCode: string;
  stationTitle: string;
  placeBits: string;
  initialPayload: CiaStationPayload | null;
  initialError: string | null;
}) {
  const searchParams = useSearchParams();
  const fromDate = validYmd(searchParams.get("from")) ? String(searchParams.get("from")) : "";
  const toDate = validYmd(searchParams.get("to")) ? String(searchParams.get("to")) : "";
  const liveRange = Boolean(fromDate && toDate);

  const [livePayload, setLivePayload] = useState<CiaStationPayload | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [loadingLive, setLoadingLive] = useState(false);

  useEffect(() => {
    if (!liveRange || !stationCode) {
      setLivePayload(null);
      setLiveError(null);
      setLoadingLive(false);
      return;
    }

    let cancelled = false;
    setLoadingLive(true);
    setLiveError(null);

    void fetchCiaStationLive(stationCode, fromDate, toDate)
      .then((payload) => {
        if (cancelled) return;
        setLivePayload(payload);
      })
      .catch((error) => {
        if (cancelled) return;
        setLivePayload(null);
        setLiveError(error instanceof Error ? error.message : "Unable to load live date range.");
      })
      .finally(() => {
        if (!cancelled) setLoadingLive(false);
      });

    return () => {
      cancelled = true;
    };
  }, [liveRange, stationCode, fromDate, toDate]);

  const error = liveRange ? liveError : initialError;
  const showingLive = liveRange && livePayload != null && !loadingLive;
  const summary: StationSummary | null = (liveRange ? livePayload : initialPayload)?.summary ?? null;
  const drivers: CiaPendingDriver[] = (liveRange ? livePayload : initialPayload)?.pendingDrivers
    ?? initialPayload?.pendingDrivers
    ?? [];
  const ledger = (liveRange ? livePayload : initialPayload)?.ledger
    ?? initialPayload?.ledger
    ?? [];
  const displayCode = String(
    (livePayload ?? initialPayload)?.stationCode || stationCode || ""
  ).trim().toUpperCase();
  const windowFrom = showingLive
    ? livePayload!.window.from
    : (initialPayload?.window.from || fromDate);
  const windowTo = showingLive
    ? livePayload!.window.to
    : (initialPayload?.window.to || toDate);

  return (
    <>
      <section className="panel cia-station-identity">
        <div className="panel-body cia-station-identity-inner">
          <div className="cia-station-identity-main">
            <span className="cia-station-code-badge">{displayCode || "—"}</span>
            <div>
              <h2>{stationTitle}</h2>
              <p className="subtle">
                {placeBits || "Station detail"}
                {windowFrom && windowTo
                  ? ` · Showing ${formatCiaDisplayDate(windowFrom)} to ${formatCiaDisplayDate(windowTo)}`
                  : ""}
                {showingLive ? " · live range" : liveRange && loadingLive ? " · loading live range" : ""}
              </p>
            </div>
          </div>
          {displayCode ? <CiaStationRefreshButton stationCode={displayCode} compact /> : null}
        </div>
      </section>

      {loadingLive ? (
        <section className="panel">
          <div className="panel-body" style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Loader2 size={18} className="cia-spin" />
            <span className="subtle">
              Loading live cash for {formatCiaDisplayDate(fromDate)} – {formatCiaDisplayDate(toDate)} via Ops Pulse…
            </span>
          </div>
        </section>
      ) : null}

      {error ? (
        <section className="panel message-panel error">
          <div className="panel-body">
            <strong>Unable to load {displayCode || "this station"}{liveRange ? " live range" : ""}</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{error}</p>
          </div>
        </section>
      ) : null}

      {summary && !loadingLive && (showingLive || !liveRange) ? (
        <CiaSummaryMetrics totals={summary} />
      ) : null}

      {(initialPayload || livePayload) && !loadingLive ? (
        <Suspense
          fallback={
            <section className="panel">
              <div className="panel-body subtle">Loading cash breakdown…</div>
            </section>
          }
        >
          <CiaStationDetail
            stationCode={displayCode}
            drivers={drivers}
            ledger={ledger}
            windowFrom={windowFrom || fromDate}
            windowTo={windowTo || toDate}
            reportDate={(livePayload ?? initialPayload)?.asOfDate ?? ""}
            reportSavedAt={
              (livePayload ?? initialPayload)?.fetchedAt
                ? formatDateTime(String((livePayload ?? initialPayload)?.fetchedAt))
                : null
            }
            availableReportDates={(livePayload ?? initialPayload)?.availableReportDates ?? []}
          />
        </Suspense>
      ) : null}

      {!initialPayload && !livePayload && !error && !loadingLive ? (
        <section className="panel">
          <div className="panel-body subtle">No Cash In Associate snapshot for this station yet.</div>
        </section>
      ) : null}
    </>
  );
}
