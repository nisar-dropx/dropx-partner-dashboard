"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { ChevronDown, ChevronRight, Loader2, RefreshCw, Search } from "lucide-react";
import { formatAmount } from "@/lib/ops-pulse/cod";
import {
  ciaSeverity,
  ciaSeverityLabel,
  mapCiaRefreshProgress,
  type CiaRefreshProgress,
  type CiaStationRow
} from "@/lib/ops-pulse/cia-types";
import { postCiaJson } from "./cia-fetch";

const PAGE_SIZE = 12;
/** Gap between stations while this page is open. Cron still uses 3 minutes. */
const CIA_UI_ADVANCE_MS = 15_000;

type SortKey = "pendingLiability" | "cashAtStationTotal" | "depositedTotal" | "cashDifference" | "stationCode";

function moneyClass(value: number) {
  if (value > 1) return "cia-money positive";
  if (value < -1) return "cia-money negative";
  return "cia-money";
}

type RefreshNotice = {
  kind: "ok" | "error" | "info";
  title: string;
  detail: string;
};

function formatRunStatus(status: string | null | undefined) {
  const raw = String(status ?? "").trim();
  if (!raw) return "";
  const labels: Record<string, string> = {
    running: "In progress",
    completed: "Completed",
    completed_with_errors: "Completed with errors",
    failed: "Failed",
    queued: "Queued"
  };
  return labels[raw] ?? raw.replace(/_/g, " ");
}

function parseRefreshProgress(raw: unknown): CiaRefreshProgress | null {
  const mapped = mapCiaRefreshProgress(raw);
  if (!mapped || (!mapped.stationsTotal && !mapped.id)) return null;
  return mapped;
}

function refreshProgressDetail(progress: CiaRefreshProgress) {
  const bits: string[] = [];
  if ((progress.stationsSucceeded ?? 0) > 0) bits.push(`${progress.stationsSucceeded} ok`);
  if ((progress.stationsFailed ?? 0) > 0) bits.push(`${progress.stationsFailed} failed`);
  if ((progress.stationsRetryQueued ?? 0) > 0) bits.push(`${progress.stationsRetryQueued} queued to retry`);
  if ((progress.stationsProcessing ?? 0) > 0) bits.push(`${progress.stationsProcessing} in flight`);
  return bits.length ? ` (${bits.join(", ")})` : "";
}

function postCiaRefresh(stationCode?: string) {
  return postCiaJson(
    "/api/ops-pulse/cod/cash-recon/cash-in-associate/refresh",
    stationCode ? { stationCode } : {}
  );
}

function postCiaContinue() {
  return postCiaJson("/api/ops-pulse/cod/cash-recon/cash-in-associate/continue");
}

export function CiaNetworkClient({
  stations,
  asOfDate,
  windowFrom,
  windowTo,
  runStatus,
  initialRefreshProgress = null
}: {
  stations: CiaStationRow[];
  asOfDate: string;
  windowFrom: string;
  windowTo: string;
  runStatus?: string | null;
  initialRefreshProgress?: CiaRefreshProgress | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [query, setQuery] = useState("");
  const [severity, setSeverity] = useState<"all" | "critical" | "watch" | "clear" | "error">("all");
  const [sortKey, setSortKey] = useState<SortKey>("pendingLiability");
  const [page, setPage] = useState(1);
  const [refreshingStation, setRefreshingStation] = useState<string | null>(null);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [notice, setNotice] = useState<RefreshNotice | null>(null);
  const [liveProgress, setLiveProgress] = useState<CiaRefreshProgress | null>(initialRefreshProgress);
  const [autoAdvance, setAutoAdvance] = useState(false);
  const advancingRef = useRef(false);

  useEffect(() => {
    setLiveProgress(initialRefreshProgress);
  }, [initialRefreshProgress]);

  const busy = refreshingAll || refreshingStation !== null || pending;
  const progress = liveProgress;
  const refreshActive = Boolean(progress && progress.status === "running")
    || String(runStatus ?? "").trim() === "running";
  const effectiveRunStatus = refreshActive ? "running" : (runStatus ?? null);

  const advanceNextStation = useCallback(async (source: "auto" | "manual") => {
    if (advancingRef.current) return;
    advancingRef.current = true;
    if (source === "manual") setNotice(null);
    setRefreshingAll(true);
    try {
      const result = await postCiaContinue();
      const nextProgress = parseRefreshProgress(result.refreshProgress);
      if (nextProgress) setLiveProgress(nextProgress);
      const station = result.processedStation ? String(result.processedStation) : null;
      const done = Boolean(result.done);
      if (done) setAutoAdvance(false);
      setNotice({
        kind: station || done ? "ok" : "info",
        title: done
          ? "Network refresh finished"
          : station
            ? `Updated ${station}`
            : "No station advanced",
        detail: done
          ? "All stations in this run are finished. Reloading numbers…"
          : station
            ? `${station} was fetched just now.${source === "auto" ? " Next station in about 15 seconds…" : ""}`
            : "Refresh is still running, but no station was advanced this time. Retrying shortly…"
      });
      startTransition(() => router.refresh());
    } catch (error) {
      setNotice({
        kind: "error",
        title: "Could not advance refresh",
        detail: error instanceof Error ? error.message : "Unknown continue error"
      });
    } finally {
      advancingRef.current = false;
      setRefreshingAll(false);
    }
  }, [router]);

  const ranked = useMemo(
    () => stations.map((row) => ({ ...row, severity: ciaSeverity(row) })),
    [stations]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let rows = ranked;

    if (q) {
      rows = rows.filter((row) =>
        row.stationCode.toLowerCase().includes(q)
        || (row.accountKey ?? "").toLowerCase().includes(q)
      );
    }
    if (severity !== "all") {
      rows = rows.filter((row) => row.severity === severity);
    }

    rows = [...rows].sort((a, b) => {
      if (sortKey === "stationCode") return a.stationCode.localeCompare(b.stationCode);
      const diff = Number(b[sortKey] ?? 0) - Number(a[sortKey] ?? 0);
      if (diff !== 0) return diff;
      return a.stationCode.localeCompare(b.stationCode);
    });

    return rows;
  }, [ranked, query, severity, sortKey]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const { criticalCount, watchCount } = useMemo(() => {
    let critical = 0;
    let watch = 0;
    for (const row of ranked) {
      if (row.severity === "critical") critical += 1;
      else if (row.severity === "watch") watch += 1;
    }
    return { criticalCount: critical, watchCount: watch };
  }, [ranked]);

  async function handleStationRefresh(stationCode: string) {
    if (busy) return;
    setAutoAdvance(false);
    setNotice(null);
    setRefreshingStation(stationCode);
    try {
      const result = await postCiaRefresh(stationCode);
      if (String(result.snapshotStatus ?? "") !== "ok") {
        throw new Error(String(result.error ?? "Station refresh failed"));
      }
      setNotice({
        kind: "ok",
        title: `${stationCode} updated`,
        detail: "Latest cash and deposit figures saved. Updating this page…"
      });
      startTransition(() => router.refresh());
    } catch (error) {
      setNotice({
        kind: "error",
        title: `Could not refresh ${stationCode}`,
        detail: error instanceof Error ? error.message : "Unknown refresh error"
      });
    } finally {
      setRefreshingStation(null);
    }
  }

  useEffect(() => {
    if (!autoAdvance || !refreshActive) {
      if (autoAdvance && !refreshActive) setAutoAdvance(false);
      return;
    }
    if (busy) return;
    const timer = window.setTimeout(() => {
      void advanceNextStation("auto");
    }, CIA_UI_ADVANCE_MS);
    return () => window.clearTimeout(timer);
  }, [autoAdvance, refreshActive, busy, advanceNextStation, liveProgress?.stationsOk, liveProgress?.status]);

  async function handleUpdateNumbers() {
    if (busy) return;
    if (!refreshActive) {
      startTransition(() => router.refresh());
      return;
    }
    await advanceNextStation("manual");
  }

  async function handleFullRefresh() {
    if (busy) return;
    const confirmed = window.confirm(
      "Refresh Cash In Associate for all stations?\n\n"
      + "This starts a fresh network run and fetches the first station now. "
      + "While this page is open, the next station is fetched about every 15 seconds. "
      + "Overnight, cron continues on its own (one week of one station every 3 minutes)."
    );
    if (!confirmed) return;

    setNotice(null);
    setAutoAdvance(true);
    setRefreshingAll(true);
    try {
      const result = await postCiaRefresh();
      const nextProgress = parseRefreshProgress(result.refreshProgress);
      if (nextProgress) setLiveProgress(nextProgress);
      const run = result.run && typeof result.run === "object" ? (result.run as Record<string, unknown>) : null;
      const attempted = nextProgress?.stationsOk ?? Number(run?.stationsOk ?? 0);
      const total = nextProgress?.stationsTotal ?? Number(run?.stationsTotal ?? stations.length) ?? stations.length;
      const firstStation = result.processedStation ? String(result.processedStation) : null;
      const succeeded = nextProgress?.stationsSucceeded ?? 0;
      setNotice({
        kind: "info",
        title: "Fresh network refresh started",
        detail: firstStation
          ? `Processed ${firstStation}. Progress is now ${attempted}/${total}`
            + (succeeded > 0 ? ` (${succeeded} ok)` : "")
            + ". Next station in about 15 seconds, or click Update numbers now."
          : `New run started at ${attempted}/${total}. Next station in about 15 seconds.`
      });
      startTransition(() => router.refresh());
    } catch (error) {
      setAutoAdvance(false);
      setNotice({
        kind: "error",
        title: "Could not start network refresh",
        detail: error instanceof Error ? error.message : "Unknown refresh error"
      });
    } finally {
      setRefreshingAll(false);
    }
  }

  const statusLabel = formatRunStatus(effectiveRunStatus);

  return (
    <div className="cia-network">
      {refreshActive && progress ? (
        <section className="panel message-panel info">
          <div className="panel-body">
            <strong>
              Full refresh in progress · {progress.stationsOk}/{progress.stationsTotal}
            </strong>
            <p className="subtle" style={{ marginTop: 6 }}>
              {progress.stationsOk} of {progress.stationsTotal} stations attempted so far
              {refreshProgressDetail(progress)}.
              {autoAdvance
                ? "Next station in about 15 seconds while this page is open, or click Update numbers now. Row Refresh still updates only that station."
                : "Click Refresh all stations for the whole network, Update numbers for the next station, or Refresh on one row for that station only. Overnight cron runs on its own."}
            </p>
          </div>
        </section>
      ) : null}

      <section className="panel cia-refresh-bar">
        <div className="panel-body cia-refresh-bar-inner">
          <div>
            <h2>Refresh data</h2>
            <p className="subtle">
              Pull the latest Cash In Associate figures from Amazon for one station, or refresh the whole network.
              {statusLabel ? ` Last network run: ${statusLabel}.` : ""}
            </p>
          </div>
          <div className="cia-refresh-actions">
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => void handleUpdateNumbers()}
            >
              {pending && !refreshingAll && !refreshingStation ? <Loader2 size={16} className="cia-spin" /> : <RefreshCw size={16} />}
              Update numbers
            </button>
            <button
              type="button"
              className="button cia-refresh-all"
              disabled={busy}
              onClick={() => void handleFullRefresh()}
            >
              {refreshingAll ? <Loader2 size={16} className="cia-spin" /> : <RefreshCw size={16} />}
              {refreshingAll
                ? (refreshActive ? "Refreshing…" : "Starting…")
                : "Refresh all stations"}
            </button>
          </div>
        </div>
      </section>

      {notice ? (
        <section className={`panel message-panel ${notice.kind === "error" ? "error" : notice.kind === "ok" ? "success" : "info"}`}>
          <div className="panel-body">
            <strong>{notice.title}</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{notice.detail}</p>
          </div>
        </section>
      ) : null}

      <section className="panel cia-insight-panel">
        <div className="panel-body cia-insight-grid">
          <article>
            <span>Analysis window</span>
            <strong>{windowFrom || "—"} → {windowTo || asOfDate || "—"}</strong>
            <small>Ageing cash vs bank deposits (CREATED + SUBMITTED)</small>
          </article>
          <article>
            <span>Critical stations</span>
            <strong>{criticalCount}</strong>
            <small>High Cash In Associate still with drivers</small>
          </article>
          <article>
            <span>Watch stations</span>
            <strong>{watchCount}</strong>
            <small>Any open associate liability</small>
          </article>
          <article>
            <span>Showing</span>
            <strong>{filtered.length}</strong>
            <small>of {stations.length} stations after filters</small>
          </article>
        </div>
      </section>

      <section className="panel">
        <div className="panel-body">
          <div className="cia-toolbar">
            <label className="cia-search">
              <Search size={16} aria-hidden />
              <input
                className="field"
                placeholder="Search station or account…"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPage(1);
                }}
              />
            </label>
            <label>
              Severity
              <select
                className="field"
                value={severity}
                onChange={(e) => {
                  setSeverity(e.target.value as typeof severity);
                  setPage(1);
                }}
              >
                <option value="all">All</option>
                <option value="critical">Critical only</option>
                <option value="watch">Watch</option>
                <option value="clear">Clear</option>
                <option value="error">Errors</option>
              </select>
            </label>
            <label>
              Sort by
              <select
                className="field"
                value={sortKey}
                onChange={(e) => {
                  setSortKey(e.target.value as SortKey);
                  setPage(1);
                }}
              >
                <option value="pendingLiability">Cash with associate (high → low)</option>
                <option value="cashAtStationTotal">Cash at station</option>
                <option value="depositedTotal">Deposited</option>
                <option value="cashDifference">Cash difference</option>
                <option value="stationCode">Station code</option>
              </select>
            </label>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Station cash position</h2>
            <p className="subtle">Refresh a row for that station only, or open it for driver-level detail.</p>
          </div>
        </div>
        <div className="panel-body table-wrap">
          <table className="cia-table">
            <thead>
              <tr>
                <th>Station</th>
                <th>Severity</th>
                <th className="num">Cash with associate</th>
                <th className="num">Cash at station</th>
                <th className="num">Ageing total</th>
                <th className="num">Deposited</th>
                <th className="num">Difference</th>
                <th className="num">Pending drivers</th>
                <th className="cia-actions-col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="subtle">No stations match the current filters.</td>
                </tr>
              ) : pageRows.map((row) => {
                const isRowRefreshing = refreshingStation === row.stationCode;
                return (
                  <tr key={row.stationCode} className={`cia-row severity-${row.severity}${isRowRefreshing ? " is-refreshing" : ""}`}>
                    <td>
                      <Link className="cia-station-link" href={`/cod/cash-in-associate/${encodeURIComponent(row.stationCode)}`} prefetch={false}>
                        <strong>{row.stationCode}</strong>
                        <small>{row.accountKey && row.accountKey !== "default" ? row.accountKey : "default account"}</small>
                      </Link>
                    </td>
                    <td>
                      <span className={`cia-severity ${row.severity}`}>{ciaSeverityLabel(row.severity)}</span>
                    </td>
                    <td className={`num ${moneyClass(row.pendingLiability)}`}>{formatAmount(row.pendingLiability)}</td>
                    <td className="num">{formatAmount(row.cashAtStationTotal)}</td>
                    <td className="num">{formatAmount(row.ageingTotal)}</td>
                    <td className="num">{formatAmount(row.depositedTotal)}</td>
                    <td className={`num ${moneyClass(row.cashDifference)}`}>{formatAmount(row.cashDifference)}</td>
                    <td className="num">{row.pendingDriverCount}</td>
                    <td>
                      <div className="cia-row-actions">
                        <button
                          type="button"
                          className="button secondary cia-icon-btn"
                          title={`Refresh ${row.stationCode}`}
                          disabled={busy}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            void handleStationRefresh(row.stationCode);
                          }}
                        >
                          {isRowRefreshing ? <Loader2 size={15} className="cia-spin" /> : <RefreshCw size={15} />}
                          <span>{isRowRefreshing ? "Refreshing…" : "Refresh"}</span>
                        </button>
                        <Link className="button secondary cia-open-btn" href={`/cod/cash-in-associate/${encodeURIComponent(row.stationCode)}`} prefetch={false}>
                          Open
                        </Link>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {totalPages > 1 ? (
          <div className="panel-body cia-pagination">
            <button
              type="button"
              className="pager-button"
              disabled={safePage <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </button>
            <span className="subtle">Page {safePage} of {totalPages}</span>
            <button
              type="button"
              className="pager-button"
              disabled={safePage >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              Next
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}

export function CiaStationRefreshButton({
  stationCode,
  compact = false
}: {
  stationCode: string;
  compact?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<RefreshNotice | null>(null);

  async function handleRefresh() {
    if (busy || pending) return;
    setNotice(null);
    setBusy(true);
    try {
      const result = await postCiaRefresh(stationCode);
      if (String(result.snapshotStatus ?? "") !== "ok") {
        throw new Error(String(result.error ?? "Station refresh failed"));
      }
      setNotice({
        kind: "ok",
        title: `${stationCode} updated`,
        detail: "Latest cash and deposit figures saved. Updating this page…"
      });
      startTransition(() => router.refresh());
    } catch (error) {
      setNotice({
        kind: "error",
        title: `Could not refresh ${stationCode}`,
        detail: error instanceof Error ? error.message : "Unknown refresh error"
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`cia-station-refresh${compact ? " compact" : ""}`}>
      <div className="cia-station-refresh-actions">
        <Link className="button secondary" href="/cod/cash-in-associate" prefetch={false}>
          ← All stations
        </Link>
        <button
          type="button"
          className="button cia-refresh-all"
          disabled={busy || pending}
          onClick={() => void handleRefresh()}
        >
          {busy ? <Loader2 size={16} className="cia-spin" /> : <RefreshCw size={16} />}
          {busy ? "Updating…" : "Refresh station"}
        </button>
      </div>
      {notice ? (
        <div className={`cia-inline-notice ${notice.kind}`}>
          <strong>{notice.title}</strong>
          <span>{notice.detail}</span>
        </div>
      ) : null}
    </div>
  );
}

export function CiaDriverPanel({
  drivers,
  stationCode
}: {
  stationCode?: string;
  drivers: Array<{
    driverName: string;
    tasId: string | null;
    employeeId: string | null;
    operationalStatus: string | null;
    mappedFromWorkforce: boolean;
    amount: number;
    shipmentCount: number;
    dates: string[];
    shipments: Array<{
      trackingId: string;
      shipmentNo: string;
      pendingAmount: number;
      keptOnDate: string | null;
      status: string;
    }>;
  }>;
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let rows = [...drivers];
    if (q) {
      rows = rows.filter((d) =>
        d.driverName.toLowerCase().includes(q)
        || (d.tasId ?? "").toLowerCase().includes(q)
        || (d.employeeId ?? "").toLowerCase().includes(q)
      );
    }
    if (status !== "all") {
      rows = rows.filter((d) => (d.operationalStatus ?? "").toUpperCase() === status);
    }
    return rows.sort((a, b) => b.amount - a.amount);
  }, [drivers, query, status]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const statuses = Array.from(
    new Set(drivers.map((d) => (d.operationalStatus ?? "").toUpperCase()).filter(Boolean))
  ).sort();

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>{stationCode ? `${stationCode} · Pending drivers` : "Pending drivers (Cash In Associate)"}</h2>
          <p className="subtle">Sorted high → low. Expand a driver to see pending shipments by date.</p>
        </div>
        <span className="count-badge">{filtered.length} drivers</span>
      </div>
      <div className="panel-body">
        <div className="cia-toolbar">
          <label className="cia-search">
            <Search size={16} aria-hidden />
            <input
              className="field"
              placeholder="Search driver, TAS ID…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
            />
          </label>
          <label>
            Workforce status
            <select
              className="field"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
            >
              <option value="all">All</option>
              {statuses.map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="cia-driver-list">
          {pageRows.length === 0 ? (
            <p className="subtle">No pending drivers for this station.</p>
          ) : pageRows.map((driver) => {
            const key = driver.tasId || driver.driverName;
            const open = openKey === key;
            const byDate = new Map<string, number>();
            for (const shipment of driver.shipments) {
              const day = shipment.keptOnDate || "unknown";
              byDate.set(day, (byDate.get(day) ?? 0) + shipment.pendingAmount);
            }
            const dateRows = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]));

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
                        {driver.tasId ? `TAS ${driver.tasId}` : "No TAS ID"}
                        {driver.operationalStatus ? ` · ${driver.operationalStatus}` : ""}
                        {driver.mappedFromWorkforce ? " · workforce" : ""}
                      </small>
                    </span>
                  </span>
                  <span className="cia-driver-meta">
                    <span className="cia-money positive">{formatAmount(driver.amount)}</span>
                    <small>{driver.shipmentCount} shipments · {driver.dates.length} days</small>
                  </span>
                </button>

                {open ? (
                  <div className="cia-driver-body">
                    <div className="cia-date-strip">
                      {dateRows.map(([date, amount]) => (
                        <div key={date}>
                          <span>{date}</span>
                          <strong>{formatAmount(amount)}</strong>
                        </div>
                      ))}
                    </div>
                    <div className="table-wrap">
                      <table className="cia-table compact">
                        <thead>
                          <tr>
                            <th>Date</th>
                            <th>Tracking</th>
                            <th>Shipment</th>
                            <th>Status</th>
                            <th className="num">Pending</th>
                          </tr>
                        </thead>
                        <tbody>
                          {[...driver.shipments]
                            .sort((a, b) => (a.keptOnDate ?? "").localeCompare(b.keptOnDate ?? "") || b.pendingAmount - a.pendingAmount)
                            .map((shipment) => (
                              <tr key={`${shipment.trackingId}-${shipment.keptOnDate}-${shipment.pendingAmount}`}>
                                <td>{shipment.keptOnDate || "—"}</td>
                                <td><code>{shipment.trackingId}</code></td>
                                <td>{shipment.shipmentNo || "—"}</td>
                                <td>{shipment.status}</td>
                                <td className="num cia-money positive">{formatAmount(shipment.pendingAmount)}</td>
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
