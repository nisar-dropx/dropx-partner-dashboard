"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CalendarDays, ChevronDown, ChevronRight, Loader2, Search, Users, BookOpen } from "lucide-react";
import { formatAmount } from "@/lib/ops-pulse/cod";
import {
  addDaysYmd,
  buildCiaDateRows,
  formatCiaDisplayDate,
  todayIstYmd,
  type CiaDateRow,
  type CiaPendingDriver,
  type CiaStationLedgerDay
} from "@/lib/ops-pulse/cia-types";

const PAGE_SIZE = 12;
const MAX_LOOKBACK_DAYS = 90;
type DetailView = "driver" | "date" | "ledger";

function moneyClass(value: number) {
  if (value > 1) return "cia-money positive";
  if (value < -1) return "cia-money negative";
  return "cia-money";
}

function validYmd(value: string | null | undefined) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ""));
}

function clampYmd(value: string, min: string, max: string) {
  if (!validYmd(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function buildStationHref(
  pathname: string,
  params: {
    view?: DetailView;
    focusDay?: string;
    fromDate?: string;
    toDate?: string;
  }
) {
  const next = new URLSearchParams();
  if (params.view && params.view !== "driver") next.set("view", params.view);
  if (params.focusDay) next.set("focusDay", params.focusDay);
  if (params.fromDate) next.set("from", params.fromDate);
  if (params.toDate) next.set("to", params.toDate);
  const query = next.toString();
  return query ? `${pathname}?${query}` : pathname;
}

function parseDetailView(value: string | null): DetailView {
  if (value === "date" || value === "ledger") return value;
  return "driver";
}

export function CiaStationDetail({
  stationCode,
  drivers,
  ledger,
  windowFrom,
  windowTo,
  reportSavedAt
}: {
  stationCode: string;
  drivers: CiaPendingDriver[];
  ledger: CiaStationLedgerDay[];
  windowFrom: string;
  windowTo: string;
  reportDate: string;
  reportSavedAt: string | null;
  availableReportDates: string[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  const yesterday = addDaysYmd(todayIstYmd(), -1);
  const earliestAllowed = addDaysYmd(yesterday, -(MAX_LOOKBACK_DAYS - 1));

  const view = parseDetailView(searchParams.get("view"));
  const focusDay = searchParams.get("focusDay")?.trim() ?? "";
  const hasExplicitRange = validYmd(searchParams.get("from")) && validYmd(searchParams.get("to"));
  const appliedFrom = hasExplicitRange
    ? clampYmd(String(searchParams.get("from")), earliestAllowed, yesterday)
    : clampYmd(windowFrom || earliestAllowed, earliestAllowed, yesterday);
  const appliedTo = hasExplicitRange
    ? clampYmd(String(searchParams.get("to")), earliestAllowed, yesterday)
    : clampYmd(windowTo || yesterday, earliestAllowed, yesterday);

  // Draft values stay local until the user clicks Apply — avoids month-nav
  // in the native date picker accidentally navigating / collapsing the range.
  const [draftFrom, setDraftFrom] = useState(appliedFrom);
  const [draftTo, setDraftTo] = useState(appliedTo);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    setDraftFrom(appliedFrom);
    setDraftTo(appliedTo);
    setFormError(null);
  }, [appliedFrom, appliedTo]);

  const dirty = draftFrom !== appliedFrom || draftTo !== appliedTo;

  const dateRows = useMemo(() => buildCiaDateRows(drivers), [drivers]);
  const filteredDateRows = useMemo(() => {
    if (!focusDay) return dateRows;
    return dateRows.filter((row) => row.date === focusDay);
  }, [dateRows, focusDay]);

  function navigate(params: {
    view?: DetailView;
    focusDay?: string | null;
    fromDate?: string;
    toDate?: string;
    keepRange?: boolean;
  }) {
    const includeRange = params.fromDate !== undefined || params.toDate !== undefined || (params.keepRange !== false && hasExplicitRange);
    const href = buildStationHref(pathname, {
      view: params.view ?? view,
      fromDate: includeRange ? (params.fromDate ?? appliedFrom) : undefined,
      toDate: includeRange ? (params.toDate ?? appliedTo) : undefined,
      focusDay:
        params.focusDay === null || params.focusDay === ""
          ? undefined
          : params.focusDay ?? (view === "date" ? focusDay || undefined : undefined)
    });
    startTransition(() => router.push(href));
  }

  function setView(nextView: DetailView) {
    navigate({
      view: nextView,
      focusDay: nextView === "date" ? focusDay || undefined : null
    });
  }

  function setFocusDay(day: string) {
    navigate({ view: "date", focusDay: day || null });
  }

  function applyPreset(days: number) {
    const to = yesterday;
    const from = clampYmd(addDaysYmd(to, -(days - 1)), earliestAllowed, yesterday);
    setDraftFrom(from);
    setDraftTo(to);
    setFormError(null);
  }

  function applyRange() {
    const from = clampYmd(draftFrom, earliestAllowed, yesterday);
    const to = clampYmd(draftTo, earliestAllowed, yesterday);
    if (from > to) {
      setFormError("From date must be on or before To date.");
      setDraftFrom(from);
      setDraftTo(to);
      return;
    }
    setFormError(null);
    setDraftFrom(from);
    setDraftTo(to);
    navigate({ fromDate: from, toDate: to, focusDay: null });
  }

  return (
    <div className="cia-station-detail">
      <section className="panel cia-period-panel">
        <div className="panel-body">
          <div className="cia-period-header">
            <div>
              <h2>Check cash for a date range</h2>
              <p className="subtle">
                Pick any period up to the last {MAX_LOOKBACK_DAYS} days, then click Show results.
                Currently showing {formatCiaDisplayDate(appliedFrom)} to {formatCiaDisplayDate(appliedTo)}
                {reportSavedAt ? ` · updated ${reportSavedAt}` : ""}.
              </p>
            </div>
            <div className="cia-preset-row">
              <button type="button" className="button secondary cia-chip" disabled={pending} onClick={() => applyPreset(7)}>
                Last 7 days
              </button>
              <button type="button" className="button secondary cia-chip" disabled={pending} onClick={() => applyPreset(30)}>
                Last 30 days
              </button>
              <button type="button" className="button secondary cia-chip" disabled={pending} onClick={() => applyPreset(90)}>
                Last 90 days
              </button>
            </div>
          </div>

          <div className="cia-range-form">
            <label className="cia-range-field">
              <span>From date</span>
              <input
                type="date"
                className="field"
                min={earliestAllowed}
                max={yesterday}
                value={draftFrom}
                disabled={pending}
                onChange={(event) => {
                  const next = event.target.value;
                  if (!validYmd(next)) return;
                  setDraftFrom(clampYmd(next, earliestAllowed, yesterday));
                  setFormError(null);
                }}
              />
            </label>
            <label className="cia-range-field">
              <span>To date</span>
              <input
                type="date"
                className="field"
                min={earliestAllowed}
                max={yesterday}
                value={draftTo}
                disabled={pending}
                onChange={(event) => {
                  const next = event.target.value;
                  if (!validYmd(next)) return;
                  setDraftTo(clampYmd(next, earliestAllowed, yesterday));
                  setFormError(null);
                }}
              />
            </label>
            <div className="cia-range-actions">
              <button
                type="button"
                className="button"
                disabled={pending || (!dirty && !formError)}
                onClick={() => applyRange()}
              >
                {pending ? <Loader2 size={16} className="cia-spin" /> : null}
                {pending ? "Loading…" : "Show results"}
              </button>
              {dirty ? (
                <button
                  type="button"
                  className="button secondary"
                  disabled={pending}
                  onClick={() => {
                    setDraftFrom(appliedFrom);
                    setDraftTo(appliedTo);
                    setFormError(null);
                  }}
                >
                  Reset
                </button>
              ) : null}
            </div>
          </div>

          {formError ? <p className="cia-range-error">{formError}</p> : null}
          {dirty && !formError ? (
            <p className="cia-range-hint subtle">Dates changed — click Show results to load this period.</p>
          ) : null}
        </div>
      </section>

      <section className="panel">
        <div className="panel-body cia-view-toolbar">
          <div className="cia-view-toggle" role="tablist" aria-label="How to browse pending cash">
            <button
              type="button"
              role="tab"
              aria-selected={view === "driver"}
              className={`cia-view-tab${view === "driver" ? " active" : ""}`}
              onClick={() => setView("driver")}
            >
              <Users size={16} aria-hidden />
              By driver
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "date"}
              className={`cia-view-tab${view === "date" ? " active" : ""}`}
              onClick={() => setView("date")}
            >
              <CalendarDays size={16} aria-hidden />
              By date
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "ledger"}
              className={`cia-view-tab${view === "ledger" ? " active" : ""}`}
              onClick={() => setView("ledger")}
            >
              <BookOpen size={16} aria-hidden />
              Day-wise ledger
            </button>
          </div>
          {view === "date" ? (
            <label className="cia-focus-day">
              <span>Filter to one day</span>
              <select
                className="field"
                value={focusDay}
                disabled={pending}
                onChange={(event) => setFocusDay(event.target.value)}
              >
                <option value="">All days in this period</option>
                {dateRows.map((row) => (
                  <option key={row.date} value={row.date === "unknown" ? "" : row.date}>
                    {row.displayDate} · ₹{formatAmount(row.amount)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      </section>

      {view === "driver" ? (
        <CiaDriverView stationCode={stationCode} drivers={drivers} />
      ) : view === "date" ? (
        <CiaDateView
          stationCode={stationCode}
          rows={filteredDateRows}
          focusDay={focusDay}
          onClearFocus={() => setFocusDay("")}
        />
      ) : (
        <CiaStationLedgerView stationCode={stationCode} rows={ledger} />
      )}
    </div>
  );
}

function CiaDriverView({
  stationCode,
  drivers
}: {
  stationCode: string;
  drivers: CiaPendingDriver[];
}) {
  const [query, setQuery] = useState("");
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let rows = [...drivers];
    if (q) {
      rows = rows.filter((d) => d.driverName.toLowerCase().includes(q));
    }
    return rows.sort((a, b) => b.amount - a.amount);
  }, [drivers, query]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>{stationCode} · Cash with drivers</h2>
          <p className="subtle">Who is still holding cash, highest amount first. Open a driver to see shipments by day.</p>
        </div>
        <span className="count-badge">{filtered.length} drivers</span>
      </div>
      <div className="panel-body">
        <div className="cia-toolbar">
          <label className="cia-search">
            <Search size={16} aria-hidden />
            <input
              className="field"
              placeholder="Search by driver name…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
              }}
            />
          </label>
        </div>

        <div className="cia-driver-list">
          {pageRows.length === 0 ? (
            <p className="subtle">No pending cash with drivers in this period.</p>
          ) : pageRows.map((driver) => {
            const key = driver.driverName;
            const open = openKey === key;
            const byDate = new Map<string, number>();
            for (const shipment of driver.shipments) {
              const day = shipment.keptOnDate || "unknown";
              byDate.set(day, (byDate.get(day) ?? 0) + shipment.pendingAmount);
            }
            const dateRows = [...byDate.entries()].sort((a, b) => b[0].localeCompare(a[0]));

            return (
              <article key={key} className={`cia-driver-card ${open ? "open" : ""}`}>
                <button
                  type="button"
                  className="cia-driver-toggle"
                  onClick={() => setOpenKey(open ? null : key)}
                  aria-expanded={open}
                >
                  <span className="cia-driver-main">
                    {open ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                    <span>
                      <strong>{driver.driverName}</strong>
                      <small>
                        {driver.shipmentCount} shipment{driver.shipmentCount === 1 ? "" : "s"}
                        {" · "}{driver.dates.length} day{driver.dates.length === 1 ? "" : "s"}
                      </small>
                    </span>
                  </span>
                  <span className="cia-driver-meta">
                    <span className="cia-money positive">₹{formatAmount(driver.amount)}</span>
                    <small>Still with driver</small>
                  </span>
                </button>

                {open ? (
                  <div className="cia-driver-body">
                    <div className="cia-date-strip">
                      {dateRows.map(([date, amount]) => (
                        <div key={date}>
                          <span>{formatCiaDisplayDate(date)}</span>
                          <strong>₹{formatAmount(amount)}</strong>
                        </div>
                      ))}
                    </div>
                    <div className="table-wrap">
                      <table className="cia-table compact">
                        <thead>
                          <tr>
                            <th>Day cash was held</th>
                            <th>Tracking number</th>
                            <th>Shipment</th>
                            <th className="num">Amount</th>
                          </tr>
                        </thead>
                        <tbody>
                          {[...driver.shipments]
                            .sort((a, b) => (b.keptOnDate ?? "").localeCompare(a.keptOnDate ?? "") || b.pendingAmount - a.pendingAmount)
                            .map((shipment) => (
                              <tr key={`${shipment.trackingId}-${shipment.keptOnDate}-${shipment.pendingAmount}`}>
                                <td>{formatCiaDisplayDate(shipment.keptOnDate)}</td>
                                <td>{shipment.trackingId}</td>
                                <td>{shipment.shipmentNo || "—"}</td>
                                <td className={`num ${moneyClass(shipment.pendingAmount)}`}>₹{formatAmount(shipment.pendingAmount)}</td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>

        {totalPages > 1 ? (
          <div className="cia-pagination">
            <button type="button" className="pager-button" disabled={safePage <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Previous</button>
            <span className="subtle">Page {safePage} of {totalPages}</span>
            <button type="button" className="pager-button" disabled={safePage >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>Next</button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function CiaDateView({
  stationCode,
  rows,
  focusDay,
  onClearFocus
}: {
  stationCode: string;
  rows: CiaDateRow[];
  focusDay: string;
  onClearFocus: () => void;
}) {
  const [query, setQuery] = useState("");
  const [openDate, setOpenDate] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) =>
      row.displayDate.toLowerCase().includes(q)
      || row.drivers.some((driver) => driver.driverName.toLowerCase().includes(q))
    );
  }, [rows, query]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const totalAmount = filtered.reduce((sum, row) => sum + row.amount, 0);

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>{stationCode} · Cash by day</h2>
          <p className="subtle">
            Pending cash grouped by the day it was held with a driver. Newest days first.
          </p>
        </div>
        <span className="count-badge">₹{formatAmount(totalAmount)}</span>
      </div>
      <div className="panel-body">
        {focusDay ? (
          <div className="cia-focus-banner">
            <span>Showing only {formatCiaDisplayDate(focusDay)}</span>
            <button type="button" className="button secondary" onClick={onClearFocus}>Show all days</button>
          </div>
        ) : null}

        <div className="cia-toolbar">
          <label className="cia-search">
            <Search size={16} aria-hidden />
            <input
              className="field"
              placeholder="Search by date or driver name…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
              }}
            />
          </label>
        </div>

        <div className="cia-date-list">
          {pageRows.length === 0 ? (
            <p className="subtle">No pending cash for the selected day in this period.</p>
          ) : pageRows.map((row) => {
            const open = openDate === row.date;
            return (
              <article key={row.date} className={`cia-date-card ${open ? "open" : ""}`}>
                <button
                  type="button"
                  className="cia-date-toggle"
                  onClick={() => setOpenDate(open ? null : row.date)}
                  aria-expanded={open}
                >
                  <span className="cia-date-main">
                    {open ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                    <span>
                      <strong>{row.displayDate}</strong>
                      <small>
                        {row.driverCount} driver{row.driverCount === 1 ? "" : "s"}
                        {" · "}{row.shipmentCount} shipment{row.shipmentCount === 1 ? "" : "s"}
                      </small>
                    </span>
                  </span>
                  <span className="cia-date-meta">
                    <span className="cia-money positive">₹{formatAmount(row.amount)}</span>
                    <small>Pending that day</small>
                  </span>
                </button>

                {open ? (
                  <div className="cia-date-body">
                    {row.drivers.map((driver) => (
                      <div key={driver.driverName} className="cia-date-driver-block">
                        <div className="cia-date-driver-head">
                          <strong>{driver.driverName}</strong>
                          <span className="cia-money positive">₹{formatAmount(driver.amount)}</span>
                        </div>
                        <div className="table-wrap">
                          <table className="cia-table compact">
                            <thead>
                              <tr>
                                <th>Tracking number</th>
                                <th>Shipment</th>
                                <th className="num">Amount</th>
                              </tr>
                            </thead>
                            <tbody>
                              {driver.shipments.map((shipment) => (
                                <tr key={`${shipment.trackingId}-${shipment.pendingAmount}`}>
                                  <td>{shipment.trackingId}</td>
                                  <td>{shipment.shipmentNo || "—"}</td>
                                  <td className={`num ${moneyClass(shipment.pendingAmount)}`}>₹{formatAmount(shipment.pendingAmount)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>

        {totalPages > 1 ? (
          <div className="cia-pagination">
            <button type="button" className="pager-button" disabled={safePage <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Previous</button>
            <span className="subtle">Page {safePage} of {totalPages}</span>
            <button type="button" className="pager-button" disabled={safePage >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>Next</button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function CiaStationLedgerView({
  stationCode,
  rows
}: {
  stationCode: string;
  rows: CiaStationLedgerDay[];
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) => formatCiaDisplayDate(row.date).toLowerCase().includes(q) || row.date.includes(q));
  }, [rows, query]);

  const totals = useMemo(
    () => ({
      cash: filtered.reduce((sum, row) => sum + row.carryForwardIn + row.expectedCashTotal, 0),
      deposited: filtered.reduce((sum, row) => sum + row.remittanceTotalCash, 0),
      pending: filtered.reduce((sum, row) => sum + row.stillPendingAmount, 0),
      forwarded: filtered.reduce((sum, row) => sum + row.forwardedAmount, 0)
    }),
    [filtered]
  );

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>{stationCode} · Day-wise ledger</h2>
          <p className="subtle">
            Total cash position vs bank deposits for each day at this station. Newest days first.
          </p>
        </div>
        <span className="count-badge">₹{formatAmount(totals.pending)} pending</span>
      </div>
      <div className="panel-body">
        <section className="summary-grid cia-summary-grid" style={{ marginBottom: 16 }}>
          <div className="metric-card accent-warn">
            <span>Cash (ageing)</span>
            <strong>₹{formatAmount(totals.cash)}</strong>
              <small>Carry-forward cash + that day's cash</small>
          </div>
          <div className="metric-card">
            <span>Bank deposits</span>
            <strong>₹{formatAmount(totals.deposited)}</strong>
            <small>Created / submitted that day</small>
          </div>
          <div className="metric-card">
            <span>Still pending</span>
            <strong>₹{formatAmount(totals.pending)}</strong>
            <small>Not matched to a deposit yet</small>
          </div>
          <div className="metric-card">
            <span>Cleared later</span>
            <strong>₹{formatAmount(totals.forwarded)}</strong>
            <small>Held that day, deposited later</small>
          </div>
        </section>

        <div className="cia-toolbar">
          <label className="cia-search">
            <Search size={16} aria-hidden />
            <input
              className="field"
              placeholder="Search by date…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
              }}
            />
          </label>
        </div>

        <div className="table-wrap">
          <table className="cia-table">
            <thead>
              <tr>
                <th>Day</th>
                <th className="num">Cash</th>
                <th className="num">Deposited</th>
                <th className="num">Still pending</th>
                <th className="num">Cleared later</th>
                <th className="num">Same-day clear</th>
                <th className="num">Drivers</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="subtle">No day-wise ledger rows for this period.</td>
                </tr>
              ) : (
                pageRows.map((row) => (
                  <tr key={row.date}>
                    <td>
                      <strong>{formatCiaDisplayDate(row.date)}</strong>
                      <small style={{ display: "block" }}>{row.date}</small>
                    </td>
                    <td className="num">
                      <strong>{formatAmount(row.carryForwardIn + row.expectedCashTotal)}</strong>
                      <small style={{ display: "block" }}>
                        {row.carryForwardIn > 0
                          ? `Carry ₹${formatAmount(row.carryForwardIn)} + day ₹${formatAmount(row.expectedCashTotal)}`
                          : `Day ₹${formatAmount(row.expectedCashTotal)}`}
                      </small>
                    </td>
                    <td className="num">{formatAmount(row.remittanceTotalCash)}</td>
                    <td className={`num ${moneyClass(row.stillPendingAmount)}`}>
                      {formatAmount(row.stillPendingAmount)}
                    </td>
                    <td className="num">{formatAmount(row.forwardedAmount)}</td>
                    <td className="num">{formatAmount(row.clearedSameDayAmount)}</td>
                    <td className="num">{row.driverCount}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {totalPages > 1 ? (
          <div className="cia-pagination">
            <button type="button" className="pager-button" disabled={safePage <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Previous</button>
            <span className="subtle">Page {safePage} of {totalPages}</span>
            <button type="button" className="pager-button" disabled={safePage >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>Next</button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
