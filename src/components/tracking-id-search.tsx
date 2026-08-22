"use client";

import { useEffect, useRef, useState } from "react";
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
  const [showHistory, setShowHistory] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  async function runSearch() {
    const trackingId = value.trim();
    if (!trackingId) return;
    setLoading(true);
    setOpen(true);
    setShowHistory(false);
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
    setOpen(false);
    setShowHistory(false);
  }

  return (
    <div className="tracking-search" ref={containerRef}>
      <Search size={15} className="tracking-search-icon" aria-hidden="true" />
      <input
        type="search"
        className="tracking-search-input"
        placeholder="Search tracking ID…"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onFocus={() => {
          if (result) setOpen(true);
        }}
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

      {open && result ? (
        <div className="tracking-search-panel" role="dialog" aria-label="Tracking ID lookup result">
          {loading ? (
            <p className="tracking-search-message">Checking Amazon SCC…</p>
          ) : result.status === "found" ? (
            <>
              <div className="tracking-search-panel-head">
                <strong>{result.trackingId}</strong>
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
              </dl>
              {result.customerAddress ? (
                <p className="tracking-search-address">{result.customerAddress}</p>
              ) : null}
              {result.history.length ? (
                <>
                  <button type="button" className="tracking-search-toggle" onClick={() => setShowHistory((current) => !current)}>
                    {showHistory ? "Hide" : "Show"} activity history ({result.history.length})
                  </button>
                  {showHistory ? (
                    <ol className="tracking-search-history">
                      {result.history.map((event, index) => (
                        <li key={`${event.state}-${event.time}-${index}`}>
                          <span className="tracking-search-history-state">{event.state}{event.reasonCode ? ` · ${event.reasonCode}` : ""}</span>
                          <span className="tracking-search-history-time">{formatDateTime(event.time)}</span>
                          {event.scanBy ? <span className="tracking-search-history-by">{event.scanBy}</span> : null}
                        </li>
                      ))}
                    </ol>
                  ) : null}
                </>
              ) : null}
            </>
          ) : result.status === "not_found" ? (
            <p className="tracking-search-message">
              No record for <strong>{value.trim()}</strong> at any station you have access to.
            </p>
          ) : result.status === "not_configured" ? (
            <p className="tracking-search-message warn">EDD worker is not configured — tracking lookup is unavailable.</p>
          ) : (
            <p className="tracking-search-message warn">{result.message}</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
