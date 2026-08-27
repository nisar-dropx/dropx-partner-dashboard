"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Download, Loader2, RefreshCw, Search } from "lucide-react";
import { PendingLink } from "@/components/pending-link";
import { addDaysYmd, formatCiaDisplayDate, todayIstYmd } from "@/lib/ops-pulse/cia-types";
import type { EddBucketKey, EddPackage, EddStationPayload } from "@/lib/ops-pulse/edd-worker";
import { TrackingDetailModal } from "@/components/tracking-detail-modal";
import { EddTrendChart } from "../edd-trend-chart";
import { EddMultiSelect } from "../edd-multi-select";

const BUCKET_META: Record<EddBucketKey, { label: string; hint: string }> = {
  overdue: { label: "Overdue", hint: "EAD already passed — highest priority" },
  dueToday: { label: "Due today", hint: "Must deliver today" },
  dueTomorrow: { label: "Due tomorrow", hint: "Stage for tomorrow's routes" },
  future: { label: "Future", hint: "EAD more than a day out" },
  unknown: { label: "No EAD found", hint: "Missing date fields from Amazon" }
};

const BUCKET_ORDER: EddBucketKey[] = ["overdue", "dueToday", "dueTomorrow", "future", "unknown"];
const BUCKET_PRIORITY: Record<EddBucketKey, number> = { overdue: 0, dueToday: 1, dueTomorrow: 2, future: 3, unknown: 4 };
const PAGE_SIZE_OPTIONS = [25, 50, 100, 200] as const;

type SortColumn = "trackingId" | "ead" | "bucket" | "state" | "driver" | "payment" | "city" | "age" | "orderId";
type SortDir = "asc" | "desc";

const COLUMNS: Array<{ key: SortColumn; label: string }> = [
  { key: "trackingId", label: "Tracking ID" },
  { key: "ead", label: "EAD" },
  { key: "bucket", label: "Bucket" },
  { key: "state", label: "State" },
  { key: "driver", label: "Driver" },
  { key: "payment", label: "Payment" },
  { key: "city", label: "City" },
  { key: "age", label: "Age in state" },
  { key: "orderId", label: "Order ID" }
];

function formatMinutes(minutes: number) {
  if (!Number.isFinite(minutes) || minutes <= 0) return "—";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${Math.round(minutes % 60)}m`;
  return `${Math.round(minutes)}m`;
}

function formatFetchedAt(value: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function sortValue(pkg: EddPackage, column: SortColumn): string | number {
  switch (column) {
    case "trackingId": return pkg.trackingId;
    case "ead": return pkg.ead ?? "";
    case "bucket": return BUCKET_PRIORITY[pkg.bucket];
    case "state": return pkg.state ?? "";
    case "driver": return pkg.lastScanBy || pkg.driverId || "";
    case "payment": return pkg.paymentMethod ?? "";
    case "city": return pkg.city ?? "";
    case "age": return pkg.minutesInState;
    case "orderId": return pkg.orderingOrderId ?? "";
    default: return "";
  }
}

function compareValues(a: string | number, b: string | number, dir: SortDir) {
  const factor = dir === "asc" ? 1 : -1;
  const aEmpty = a === "" || a == null;
  const bEmpty = b === "" || b == null;
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;
  if (typeof a === "number" && typeof b === "number") return (a - b) * factor;
  return String(a).localeCompare(String(b)) * factor;
}

type FetchOutcome = { status: "ok"; payload: EddStationPayload } | { status: "no_snapshot" };

async function fetchEddClient(stationCode: string): Promise<FetchOutcome> {
  const url = new URL("/api/ops-pulse/edd", window.location.origin);
  url.searchParams.set("stationCode", stationCode);
  const response = await fetch(url.toString(), { headers: { Accept: "application/json" }, cache: "no-store" });
  const text = await response.text();
  let raw: Record<string, unknown> = {};
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    raw = {};
  }
  if (!response.ok) {
    throw new Error(String(raw.error ?? `Unable to load EDD data (${response.status}).`));
  }
  if (raw.status === "no_snapshot") return { status: "no_snapshot" };
  // The GET route returns { status: "ok", payload: EddStationPayload } —
  // unwrap it here (unlike refreshEddClient below, whose POST route returns
  // the station payload directly).
  return { status: "ok", payload: raw.payload as unknown as EddStationPayload };
}

async function refreshEddClient(stationCode: string): Promise<EddStationPayload> {
  const url = new URL("/api/ops-pulse/edd/refresh", window.location.origin);
  url.searchParams.set("stationCode", stationCode);
  const response = await fetch(url.toString(), { method: "POST", headers: { Accept: "application/json" }, cache: "no-store" });
  const text = await response.text();
  let raw: Record<string, unknown> = {};
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    raw = {};
  }
  if (!response.ok) {
    throw new Error(String(raw.error ?? `Unable to refresh live data (${response.status}).`));
  }
  return raw as unknown as EddStationPayload;
}

export function EddClient({ stationCode }: { stationCode: string }) {
  const [payload, setPayload] = useState<EddStationPayload | null>(null);
  const [noSnapshot, setNoSnapshot] = useState(false);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeBucket, setActiveBucket] = useState<EddBucketKey | null>(null);
  const [selectedDates, setSelectedDates] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [stateFilters, setStateFilters] = useState<Set<string>>(new Set());
  const [paymentFilters, setPaymentFilters] = useState<Set<string>>(new Set());
  const [sortColumn, setSortColumn] = useState<SortColumn>("ead");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZE_OPTIONS[0]);
  const [page, setPage] = useState(1);
  const [openTrackingId, setOpenTrackingId] = useState<string | null>(null);

  useEffect(() => {
    if (!stationCode) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void fetchEddClient(stationCode)
      .then((outcome) => {
        if (cancelled) return;
        if (outcome.status === "no_snapshot") {
          setPayload(null);
          setNoSnapshot(true);
        } else {
          setPayload(outcome.payload);
          setNoSnapshot(false);
        }
        setActiveBucket(null);
        setSelectedDates(new Set());
        setStateFilters(new Set());
        setPaymentFilters(new Set());
        setSearch("");
        setPage(1);
      })
      .catch((err) => {
        if (cancelled) return;
        setPayload(null);
        setError(err instanceof Error ? err.message : "Unable to load the EDD dashboard.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [stationCode]);

  function runRefresh() {
    setRefreshing(true);
    setError(null);
    void refreshEddClient(stationCode)
      .then((fresh) => {
        setPayload(fresh);
        setNoSnapshot(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Unable to refresh live data.");
      })
      .finally(() => setRefreshing(false));
  }

  const today = todayIstYmd();
  const yesterday = addDaysYmd(today, -1);
  const tomorrow = addDaysYmd(today, 1);

  const stateOptions = useMemo(() => {
    const values = new Set((Array.isArray(payload?.packages) ? payload.packages : []).map((pkg) => pkg.state).filter((v): v is string => Boolean(v)));
    return [...values].sort();
  }, [payload]);

  const paymentOptions = useMemo(() => {
    const values = new Set((Array.isArray(payload?.packages) ? payload.packages : []).map((pkg) => pkg.paymentMethod).filter((v): v is string => Boolean(v)));
    return [...values].sort();
  }, [payload]);

  const dateOptions = Array.isArray(payload?.byDate) ? payload.byDate : [];

  // Everything except the bucket itself — this is what the bucket cards'
  // own counts are based on, so picking a date/state/payment filter updates
  // the cards too (a card only ever narrows further, on top of this).
  const filteredPackagesBeforeBucket = useMemo(() => {
    const rows = Array.isArray(payload?.packages) ? payload.packages : [];
    const term = search.trim().toLowerCase();
    return rows.filter((pkg) => {
      if (selectedDates.size && !selectedDates.has(pkg.ead ?? "")) return false;
      if (stateFilters.size && !stateFilters.has(pkg.state ?? "")) return false;
      if (paymentFilters.size && !paymentFilters.has(pkg.paymentMethod ?? "")) return false;
      if (!term) return true;
      return [pkg.trackingId, pkg.lastScanBy, pkg.city, pkg.orderingOrderId, pkg.state]
        .some((field) => String(field ?? "").toLowerCase().includes(term));
    });
  }, [payload, selectedDates, stateFilters, paymentFilters, search]);

  const cardBucketCounts = useMemo(() => {
    const counts: Record<EddBucketKey, number> = { overdue: 0, dueToday: 0, dueTomorrow: 0, future: 0, unknown: 0 };
    for (const pkg of filteredPackagesBeforeBucket) counts[pkg.bucket] = (counts[pkg.bucket] ?? 0) + 1;
    return counts;
  }, [filteredPackagesBeforeBucket]);

  const filteredPackages = useMemo(() => {
    return filteredPackagesBeforeBucket.filter((pkg) => {
      if (activeBucket && pkg.bucket !== activeBucket) return false;
      return true;
    });
  }, [filteredPackagesBeforeBucket, activeBucket]);

  const sortedPackages = useMemo(() => {
    return [...filteredPackages].sort((a, b) => compareValues(sortValue(a, sortColumn), sortValue(b, sortColumn), sortDir));
  }, [filteredPackages, sortColumn, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sortedPackages.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pagedPackages = useMemo(
    () => sortedPackages.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [sortedPackages, currentPage, pageSize]
  );

  function toggleSort(column: SortColumn) {
    setPage(1);
    if (sortColumn !== column) {
      setSortColumn(column);
      setSortDir("asc");
      return;
    }
    setSortDir((current) => (current === "asc" ? "desc" : "asc"));
  }

  function resetToPageOne<T>(setter: (value: T) => void) {
    return (value: T) => {
      setPage(1);
      setter(value);
    };
  }

  function toggleDate(date: string) {
    setPage(1);
    setSelectedDates((current) => {
      const next = new Set(current);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
  }

  const dateSummary = selectedDates.size === 0
    ? ""
    : selectedDates.size === 1
      ? formatCiaDisplayDate([...selectedDates][0])
      : `${selectedDates.size} days`;

  return (
    <>
      <section className="panel">
        <div className="panel-body edd-toolbar">
          <PendingLink className="edd-back-link" href="/edd">
            <ArrowLeft size={14} /> All stations
          </PendingLink>

          <span className="subtle" style={{ flex: "1 1 auto" }}>
            {refreshing
              ? "Pulling every tracking ID live from Amazon — this can take up to a minute…"
              : payload
                ? `${payload.totalCount.toLocaleString("en-IN")} live TIDs · ${formatCiaDisplayDate(payload.window.from)} - ${formatCiaDisplayDate(payload.window.to)} · fetched ${formatFetchedAt(payload.fetchedAt)}`
                : " "}
          </span>

          <a
            className={`button secondary${payload ? "" : " disabled"}`}
            href={payload ? `/api/ops-pulse/edd/report?stationCode=${encodeURIComponent(stationCode)}` : undefined}
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
            title="Download this station's live backlog as an Excel report"
          >
            <Download size={16} /> Download report
          </a>

          <button
            type="button"
            className="button secondary"
            onClick={runRefresh}
            disabled={refreshing || loading}
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            {refreshing ? <Loader2 size={16} className="edd-spin" /> : <RefreshCw size={16} />}
            {refreshing ? "Refreshing live…" : "Refresh live"}
          </button>
        </div>
      </section>

      {error ? (
        <section className="panel message-panel error">
          <div className="panel-body">
            <strong>Unable to load {stationCode || "this station"}</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{error}</p>
          </div>
        </section>
      ) : null}

      {loading ? (
        <section className="panel">
          <div className="panel-body" style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Loader2 size={18} className="edd-spin" />
            <span className="subtle">Loading the saved EDD snapshot for {stationCode}…</span>
          </div>
        </section>
      ) : null}

      {!loading && noSnapshot && !payload ? (
        <section className="panel message-panel info">
          <div className="panel-body">
            <strong>No live snapshot yet for {stationCode}</strong>
            <p className="subtle" style={{ marginTop: 6 }}>
              The nightly refresh (08:00 IST) hasn&apos;t run for this station yet. Click &ldquo;Refresh live&rdquo; above to
              pull it now — a full station backlog takes up to a minute.
            </p>
          </div>
        </section>
      ) : null}

      {payload ? (
        <>
          <section className="edd-bucket-grid">
            {BUCKET_ORDER.map((bucket) => {
              const meta = BUCKET_META[bucket];
              const count = cardBucketCounts[bucket] ?? 0;
              const isActive = activeBucket === bucket;
              return (
                <button
                  key={bucket}
                  type="button"
                  className={`edd-bucket-card ${bucket}${isActive ? " active" : ""}`}
                  onClick={() => {
                    setPage(1);
                    setActiveBucket(isActive ? null : bucket);
                  }}
                >
                  <span>{meta.label}</span>
                  <strong>{count.toLocaleString("en-IN")}</strong>
                  <small>{meta.hint}</small>
                </button>
              );
            })}
          </section>

          {Array.isArray(payload.byDate) && payload.byDate.length ? (
            <section className="panel">
              <div className="panel-head">
                <h3>Day-level EAD trend</h3>
                <p className="subtle">How many live tracking IDs fall on each EAD — colored by whether that day is already overdue, today, or upcoming.</p>
              </div>
              <div className="panel-body">
                <EddTrendChart
                  points={payload.byDate}
                  todayYmd={today}
                  selectedDates={selectedDates}
                  onSelectDate={toggleDate}
                />
              </div>
            </section>
          ) : null}

          <section className="panel">
            <div className="panel-head">
              <h3>
                Live tracking IDs
                {activeBucket ? ` · ${BUCKET_META[activeBucket].label}` : ""}
                {dateSummary ? ` · ${dateSummary}` : ""}
              </h3>
            </div>
            <div className="panel-body">
              <div className="edd-toolbar">
                <div style={{ position: "relative" }}>
                  <Search size={15} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--muted)" }} />
                  <input
                    type="search"
                    placeholder="Search tracking ID, driver, city, order ID…"
                    value={search}
                    onChange={(event) => resetToPageOne(setSearch)(event.target.value)}
                    style={{ paddingLeft: 30, minWidth: 240 }}
                  />
                </div>

                {dateOptions.length ? (
                  <>
                    <div className="edd-preset-row">
                      <button
                        type="button"
                        className={`button secondary edd-chip edd-chip-today${selectedDates.has(today) ? " active" : ""}`}
                        onClick={() => toggleDate(today)}
                      >
                        Today
                      </button>
                      <button
                        type="button"
                        className={`button secondary edd-chip${selectedDates.has(yesterday) ? " active" : ""}`}
                        onClick={() => toggleDate(yesterday)}
                      >
                        Yesterday
                      </button>
                      <button
                        type="button"
                        className={`button secondary edd-chip${selectedDates.has(tomorrow) ? " active" : ""}`}
                        onClick={() => toggleDate(tomorrow)}
                      >
                        Tomorrow
                      </button>
                    </div>
                    <EddMultiSelect
                      label="EAD days"
                      options={dateOptions.map((point) => point.date)}
                      selected={selectedDates}
                      onChange={resetToPageOne(setSelectedDates)}
                      renderOption={(date) => {
                        const point = dateOptions.find((p) => p.date === date);
                        return `${formatCiaDisplayDate(date)}${point ? ` · ${point.count.toLocaleString("en-IN")}` : ""}`;
                      }}
                    />
                  </>
                ) : null}

                <EddMultiSelect label="States" options={stateOptions} selected={stateFilters} onChange={resetToPageOne(setStateFilters)} />

                <EddMultiSelect label="payment methods" options={paymentOptions} selected={paymentFilters} onChange={resetToPageOne(setPaymentFilters)} />

                {activeBucket || selectedDates.size || stateFilters.size || paymentFilters.size || search ? (
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => {
                      setActiveBucket(null);
                      setSelectedDates(new Set());
                      setStateFilters(new Set());
                      setPaymentFilters(new Set());
                      setSearch("");
                      setPage(1);
                    }}
                  >
                    Clear filters
                  </button>
                ) : null}

                <span className="subtle" style={{ marginLeft: "auto" }}>
                  Showing {sortedPackages.length.toLocaleString("en-IN")} of {payload.totalCount.toLocaleString("en-IN")}
                </span>
              </div>

              <div className="edd-table-wrap">
                <table className="edd-table">
                  <thead>
                    <tr>
                      {COLUMNS.map((column) => {
                        const isActive = sortColumn === column.key;
                        return (
                          <th key={column.key}>
                            <button type="button" className="edd-sort-btn" onClick={() => toggleSort(column.key)}>
                              {column.label}
                              {isActive ? (
                                sortDir === "asc" ? <ArrowUp size={12} className="edd-sort-icon active" /> : <ArrowDown size={12} className="edd-sort-icon active" />
                              ) : (
                                <ArrowUpDown size={12} className="edd-sort-icon" />
                              )}
                            </button>
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {pagedPackages.map((pkg: EddPackage) => (
                      <tr key={pkg.trackingId}>
                        <td>
                          <button type="button" className="edd-table-tid-btn" onClick={() => setOpenTrackingId(pkg.trackingId)}>
                            {pkg.trackingId}
                          </button>
                        </td>
                        <td>
                          {pkg.ead
                            ? `${formatCiaDisplayDate(pkg.ead)}${pkg.ead === today ? " (today)" : pkg.ead === tomorrow ? " (tomorrow)" : ""}`
                            : "—"}
                        </td>
                        <td>
                          <span className={`edd-pill ${pkg.bucket}`}>{BUCKET_META[pkg.bucket].label}</span>
                        </td>
                        <td>{pkg.state || "—"}</td>
                        <td>{pkg.lastScanBy || pkg.driverId || "—"}</td>
                        <td>{pkg.paymentMethod || "—"}</td>
                        <td>{pkg.city || "—"}</td>
                        <td>{formatMinutes(pkg.minutesInState)}</td>
                        <td>{pkg.orderingOrderId || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!pagedPackages.length ? <p className="subtle" style={{ marginTop: 10 }}>No tracking IDs match this filter.</p> : null}
              </div>

              {sortedPackages.length ? (
                <div className="edd-pagination">
                  <label className="subtle" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    Rows per page
                    <select
                      className="edd-filter-select"
                      value={pageSize}
                      onChange={(event) => {
                        setPageSize(Number(event.target.value));
                        setPage(1);
                      }}
                    >
                      {PAGE_SIZE_OPTIONS.map((size) => (
                        <option key={size} value={size}>{size}</option>
                      ))}
                    </select>
                  </label>

                  <div className="edd-pagination-pages">
                    <button type="button" className="button secondary" disabled={currentPage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))} aria-label="Previous page">
                      <ChevronLeft size={16} />
                    </button>
                    <span className="subtle">Page {currentPage} of {totalPages}</span>
                    <button type="button" className="button secondary" disabled={currentPage >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))} aria-label="Next page">
                      <ChevronRight size={16} />
                    </button>
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
