"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight, Download, Loader2, RefreshCw, Search } from "lucide-react";
import { PendingLink } from "@/components/pending-link";
import { TrackingDetailModal } from "@/components/tracking-detail-modal";
import type { EddPerformancePackage, EddPerformancePayload } from "@/lib/ops-pulse/edd-worker";
import { STATION_EDD_BUCKET_LABEL, stationEddDeliveryProgress, stationEddPackageMatches, stationEddTotal, type StationEddFilter } from "@/lib/ops-pulse/station-edd";

type FetchOutcome = { status: "ok"; payload: EddPerformancePayload } | { status: "no_snapshot" };
const PAGE_SIZE = 50;

const FILTERS: Array<{ key: StationEddFilter; label: string }> = [
  { key: "atStation", label: "At station EDD" },
  { key: "delivered", label: "Delivered" },
  { key: "held", label: "On road / held" },
  { key: "returned", label: "Returned" },
  { key: "all", label: "All TIDs" }
];

async function requestJson<T>(path: string, method: "GET" | "POST" = "GET"): Promise<T> {
  const response = await fetch(new URL(path, window.location.origin).toString(), {
    method,
    headers: { Accept: "application/json" },
    cache: "no-store"
  });
  const raw = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(raw.error ?? `Request failed (${response.status}).`));
  return raw as T;
}

function formatDate(value: string) {
  if (!value) return "Today";
  const date = new Date(`${value}T00:00:00+05:30`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });
}

function formatFetchedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function filterCount(payload: EddPerformancePayload, filter: StationEddFilter) {
  if (filter === "atStation") return payload.yetToDispatch;
  if (filter === "delivered") return payload.delivered;
  if (filter === "held") return payload.held;
  if (filter === "returned") return payload.returned;
  return stationEddTotal(payload);
}

function bucketTone(pkg: EddPerformancePackage) {
  if (pkg.bucket === "delivered") return "future";
  if (pkg.bucket === "returned") return "overdue";
  if (pkg.bucket === "held") return "dueToday";
  return "unknown";
}

export function StationEddDetailClient({ stationCode }: { stationCode: string }) {
  const [payload, setPayload] = useState<EddPerformancePayload | null>(null);
  const [noSnapshot, setNoSnapshot] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StationEddFilter>("atStation");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [openTrackingId, setOpenTrackingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void requestJson<FetchOutcome>(`/api/ops-pulse/station-edd?stationCode=${encodeURIComponent(stationCode)}`)
      .then((result) => {
        if (cancelled) return;
        if (result.status === "no_snapshot") {
          setPayload(null);
          setNoSnapshot(true);
        } else {
          setPayload(result.payload);
          setNoSnapshot(false);
        }
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Unable to load station EDD.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [stationCode]);

  function refresh() {
    setRefreshing(true);
    setError(null);
    void requestJson<EddPerformancePayload>(`/api/ops-pulse/station-edd/refresh?stationCode=${encodeURIComponent(stationCode)}`, "POST")
      .then((fresh) => {
        setPayload(fresh);
        setNoSnapshot(false);
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Unable to refresh station EDD."))
      .finally(() => setRefreshing(false));
  }

  const filteredPackages = useMemo(() => {
    if (!payload) return [];
    const term = query.trim().toLowerCase();
    return payload.packages.filter((pkg) => {
      if (!stationEddPackageMatches(pkg, filter)) return false;
      if (!term) return true;
      return [pkg.trackingId, pkg.state, pkg.driverId, pkg.driverName, pkg.city, pkg.orderingOrderId, pkg.paymentMethod]
        .some((value) => String(value ?? "").toLowerCase().includes(term));
    });
  }, [filter, payload, query]);
  const totalPages = Math.max(1, Math.ceil(filteredPackages.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageRows = filteredPackages.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  return (
    <>
      <section className="panel">
        <div className="panel-body edd-toolbar">
          <PendingLink className="edd-back-link" href="/station-edd"><ArrowLeft size={14} /> All stations</PendingLink>
          <span className="subtle" style={{ flex: "1 1 auto" }}>
            {payload ? `${formatDate(payload.window.from)} · updated ${formatFetchedAt(payload.fetchedAt)}` : "Today's EDD snapshot"}
          </span>
          <a className={`button secondary${payload ? "" : " disabled"}`} href={payload ? `/api/ops-pulse/station-edd/report?stationCode=${encodeURIComponent(stationCode)}` : undefined} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Download size={16} /> Download detailed report
          </a>
          <button type="button" className="button secondary" onClick={refresh} disabled={loading || refreshing} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            {refreshing ? <Loader2 size={16} className="edd-spin" /> : <RefreshCw size={16} />}{refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </section>

      {error ? <section className="panel message-panel error"><div className="panel-body"><strong>Unable to load {stationCode} EDD</strong><p className="subtle" style={{ marginTop: 6 }}>{error}</p></div></section> : null}
      {loading ? <section className="panel"><div className="panel-body" style={{ display: "flex", alignItems: "center", gap: 8 }}><Loader2 size={18} className="edd-spin" /><span className="subtle">Loading station EDD…</span></div></section> : null}
      {!loading && noSnapshot ? <section className="panel message-panel info"><div className="panel-body"><strong>No EDD snapshot yet for {stationCode}</strong><p className="subtle" style={{ marginTop: 6 }}>Use Refresh to pull today's station data.</p></div></section> : null}

      {payload ? (
        <>
          <section className="edd-bucket-grid">
            <div className="edd-bucket-card static"><span>EDD today</span><strong>{stationEddTotal(payload).toLocaleString("en-IN")}</strong><small>all tracking IDs due today</small></div>
            <div className="edd-bucket-card static overdue"><span>Current at station</span><strong>{payload.yetToDispatch.toLocaleString("en-IN")}</strong><small>not assigned to driver/store</small></div>
            <div className="edd-bucket-card static"><span>Assigned / dispatched</span><strong>{payload.assigned.toLocaleString("en-IN")}</strong><small>entered the delivery cycle</small></div>
            <div className="edd-bucket-card static future"><span>Delivered</span><strong>{payload.delivered.toLocaleString("en-IN")}</strong><small>{stationEddDeliveryProgress(payload)}% of today's EDD</small></div>
            <div className="edd-bucket-card static dueToday"><span>On road / held</span><strong>{payload.held.toLocaleString("en-IN")}</strong><small>not yet completed</small></div>
            <div className="edd-bucket-card static unknown"><span>Returned</span><strong>{payload.returned.toLocaleString("en-IN")}</strong><small>failed, rejected, or undeliverable</small></div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div><h3>Tracking-ID details</h3><p className="subtle">Select any tracking ID for its full current status and activity history.</p></div>
              <span className="count-badge">{filteredPackages.length.toLocaleString("en-IN")} TIDs</span>
            </div>
            <div className="panel-body">
              <div className="edd-preset-row">
                {FILTERS.map((option) => (
                  <button key={option.key} type="button" className={`button secondary edd-chip${filter === option.key ? " active" : ""}`} onClick={() => { setFilter(option.key); setPage(1); }}>
                    {option.label} · {filterCount(payload, option.key).toLocaleString("en-IN")}
                  </button>
                ))}
              </div>
              <div className="edd-toolbar" style={{ marginTop: 14 }}>
                <div style={{ position: "relative" }}>
                  <Search size={15} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--muted)" }} />
                  <input type="search" placeholder="Search TID, state, driver, city, or order…" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} style={{ paddingLeft: 30, minWidth: 300 }} />
                </div>
              </div>

              <div className="edd-table-wrap">
                <table className="edd-table compact">
                  <thead><tr><th>Tracking ID</th><th>EDD position</th><th>Latest state</th><th>Driver / store</th><th>Payment</th><th>City</th><th>Order ID</th></tr></thead>
                  <tbody>
                    {pageRows.map((pkg) => (
                      <tr key={pkg.trackingId}>
                        <td><button type="button" className="edd-table-tid-btn" onClick={() => setOpenTrackingId(pkg.trackingId)}>{pkg.trackingId}</button></td>
                        <td><span className={`edd-pill ${bucketTone(pkg)}`}>{STATION_EDD_BUCKET_LABEL[pkg.bucket]}</span></td>
                        <td>{pkg.state || "—"}</td>
                        <td>{pkg.driverName || pkg.driverId || (pkg.bucket === "yetToDispatch" ? "Not assigned" : "—")}</td>
                        <td>{pkg.paymentMethod || "—"}</td>
                        <td>{pkg.city || "—"}</td>
                        <td>{pkg.orderingOrderId || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!pageRows.length ? <p className="subtle" style={{ marginTop: 12 }}>No tracking IDs match this selection.</p> : null}
              </div>

              {filteredPackages.length > PAGE_SIZE ? (
                <div className="edd-pagination">
                  <span className="subtle">{filteredPackages.length.toLocaleString("en-IN")} tracking IDs</span>
                  <div className="edd-pagination-pages">
                    <button type="button" className="button secondary" aria-label="Previous tracking-ID page" disabled={currentPage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}><ChevronLeft size={16} /></button>
                    <span className="subtle">Page {currentPage} of {totalPages}</span>
                    <button type="button" className="button secondary" aria-label="Next tracking-ID page" disabled={currentPage >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}><ChevronRight size={16} /></button>
                  </div>
                </div>
              ) : null}
            </div>
          </section>
        </>
      ) : null}

      <TrackingDetailModal trackingId={openTrackingId} stationHint={stationCode} onClose={() => setOpenTrackingId(null)} />
    </>
  );
}
