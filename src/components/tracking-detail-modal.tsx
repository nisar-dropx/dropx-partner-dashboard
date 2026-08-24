"use client";

import { useEffect, useState } from "react";
import { Loader2, X } from "lucide-react";
import type { TrackingLookupResult } from "@/lib/ops-pulse/tracking-lookup";

function formatDateTime(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatAmount(value: number | null) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `₹${value.toLocaleString("en-IN")}`;
}

/**
 * Full-detail lookup modal for one tracking ID — shared by the header
 * search box (TrackingIdSearch) and any clickable Tracking ID cell (e.g. the
 * EDD station table). Fetches on mount whenever `trackingId` is non-null;
 * pass `stationHint` when the caller already knows which station this TID
 * belongs to, to skip straight to that station's Amazon session.
 */
export function TrackingDetailModal({
  trackingId,
  stationHint,
  onClose
}: {
  trackingId: string | null;
  stationHint?: string;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<TrackingLookupResult | { status: "error"; message: string } | null>(null);

  useEffect(() => {
    if (!trackingId) return;
    let cancelled = false;
    setLoading(true);
    setResult(null);
    const url = new URL("/api/ops-pulse/tracking-lookup", window.location.origin);
    url.searchParams.set("trackingId", trackingId);
    if (stationHint) url.searchParams.set("stationCode", stationHint);
    fetch(url.toString(), { headers: { Accept: "application/json" }, cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (cancelled) return;
        if (!response.ok) {
          setResult({ status: "error", message: String(payload.error ?? "Unable to look up this tracking ID.") });
        } else {
          setResult(payload as TrackingLookupResult);
        }
      })
      .catch(() => {
        if (!cancelled) setResult({ status: "error", message: "Unable to reach Amazon SCC for this lookup." });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [trackingId, stationHint]);

  useEffect(() => {
    if (!trackingId) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [trackingId, onClose]);

  if (!trackingId) return null;

  return (
    <div className="tracking-search-overlay" role="presentation" onClick={onClose}>
      <div
        className="tracking-search-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Tracking ID lookup result"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="tracking-search-modal-head">
          <h2>{trackingId}</h2>
          <button type="button" className="tracking-search-modal-close" aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {loading ? (
          <p className="tracking-search-message" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Loader2 size={16} className="tracking-search-spin" /> Checking Amazon SCC…
          </p>
        ) : !result ? null : result.status === "found" ? (
          <>
            <div style={{ marginBottom: 16 }}>
              <span className="tracking-search-state-pill">{result.packageStatus ?? "Unknown"}</span>
            </div>
            <dl className="tracking-search-detail">
              <div><dt>Station</dt><dd>{result.stationCode}{result.stationName ? ` — ${result.stationName}` : ""}</dd></div>
              <div><dt>Driver</dt><dd>{result.driverName || "—"}</dd></div>
              <div><dt>Customer</dt><dd>{result.customerName || "—"}</dd></div>
              <div><dt>Merchant</dt><dd>{result.merchantName || "—"}</dd></div>
              <div><dt>EAD</dt><dd>{formatDateTime(result.estimatedArrivalTime)}</dd></div>
              <div><dt>Promised by</dt><dd>{formatDateTime(result.promisedDeliveryTime)}</dd></div>
              <div><dt>Payment</dt><dd>{result.paymentMethod || "—"}{result.receivableAmount != null ? ` · ${formatAmount(result.receivableAmount)}` : ""}</dd></div>
              <div><dt>Order ID</dt><dd>{result.orderId || "—"}</dd></div>
              <div><dt>Ship option</dt><dd>{result.shipOption || "—"}</dd></div>
              <div><dt>Last updated</dt><dd>{formatDateTime(result.lastUpdatedTime)}</dd></div>
            </dl>
            {result.customerAddress ? (
              <p className="tracking-search-address">{result.customerAddress}</p>
            ) : null}
            {result.history.length ? (
              <>
                <p className="tracking-search-section-head">Activity history ({result.history.length})</p>
                <ol className="tracking-search-history">
                  {result.history.map((event, index) => (
                    <li key={`${event.state}-${event.time}-${index}`}>
                      <span className="tracking-search-history-state">{event.state}{event.reasonCode ? ` · ${event.reasonCode}` : ""}</span>
                      <span className="tracking-search-history-time">{formatDateTime(event.time)}</span>
                      {event.scanBy ? <span className="tracking-search-history-by">{event.scanBy}</span> : null}
                    </li>
                  ))}
                </ol>
              </>
            ) : null}
          </>
        ) : result.status === "not_found" ? (
          <p className="tracking-search-message">
            No record for <strong>{trackingId}</strong> at any station you have access to.
          </p>
        ) : result.status === "not_configured" ? (
          <p className="tracking-search-message warn">EDD worker is not configured — tracking lookup is unavailable.</p>
        ) : (
          <p className="tracking-search-message warn">{result.message}</p>
        )}
      </div>
    </div>
  );
}
