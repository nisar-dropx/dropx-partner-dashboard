"use client";

import { useEffect, useState } from "react";
import { Loader2, Search, X } from "lucide-react";
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

export function TrackingIdSearch() {
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<TrackingLookupResult | { status: "error"; message: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  async function runSearch() {
    const trackingId = value.trim();
    if (!trackingId) return;
    setLoading(true);
    setOpen(true);
    try {
      const response = await fetch(`/api/ops-pulse/tracking-lookup?trackingId=${encodeURIComponent(trackingId)}`, {
        headers: { Accept: "application/json" },
        cache: "no-store"
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setResult({ status: "error", message: String(payload.error ?? "Unable to look up this tracking ID.") });
      } else {
        setResult(payload as TrackingLookupResult);
      }
    } catch {
      setResult({ status: "error", message: "Unable to reach Amazon SCC for this lookup." });
    } finally {
      setLoading(false);
    }
  }

  function clearSearch() {
    setValue("");
    setResult(null);
  }

  const searchedId = value.trim();

  return (
    <>
      <div className="tracking-search">
        <Search size={15} className="tracking-search-icon" aria-hidden="true" />
        <input
          type="search"
          className="tracking-search-input"
          placeholder="Search tracking ID…"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void runSearch();
            }
          }}
        />
        {loading ? <Loader2 size={14} className="tracking-search-spin" aria-hidden="true" /> : null}
        {value && !loading ? (
          <button type="button" className="tracking-search-clear" aria-label="Clear tracking ID search" onClick={clearSearch}>
            <X size={13} />
          </button>
        ) : null}
      </div>

      {open ? (
        <div className="tracking-search-overlay" role="presentation" onClick={() => setOpen(false)}>
          <div
            className="tracking-search-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Tracking ID lookup result"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="tracking-search-modal-head">
              <h2>{searchedId || "Tracking ID lookup"}</h2>
              <button type="button" className="tracking-search-modal-close" aria-label="Close" onClick={() => setOpen(false)}>
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
                No record for <strong>{searchedId}</strong> at any station you have access to.
              </p>
            ) : result.status === "not_configured" ? (
              <p className="tracking-search-message warn">EDD worker is not configured — tracking lookup is unavailable.</p>
            ) : (
              <p className="tracking-search-message warn">{result.message}</p>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
