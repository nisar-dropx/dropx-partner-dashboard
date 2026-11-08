"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, Copy, Filter, MapPinned, PackageSearch, Search } from "lucide-react";
import type {
  CortexBoard,
  CortexGpsTrailResult,
  CortexRouteDetail,
  CortexRouteRow,
  CortexStationOption,
  CortexStopTask,
} from "@/lib/ops-pulse/cortex-data";
import { completionPct } from "@/lib/ops-pulse/cortex-geo";
import { CortexRouteMap } from "./cortex-route-map";
import styles from "./cortex-workspace.module.css";

type RouteFilter = "all" | "on-road" | "closed" | "review";
type TaskFilter = "all" | "remaining" | "failed" | "good" | "bad" | "unavailable";
type ListMode = "routes" | "drivers";

function statusBadge(row: CortexRouteRow) {
  if (row.driverSessionEnded || row.executionStatus === "COMPLETE") {
    return { label: "Closed", className: styles.badgeReady };
  }
  if (row.remaining > 0) return { label: "On road", className: styles.badgeOpen };
  return { label: row.executionStatus || "Open", className: styles.badgeIdle };
}

function formatTime(epoch: number | null) {
  if (!epoch || !Number.isFinite(epoch)) return "—";
  const ms = epoch > 1e12 ? epoch : epoch * 1000;
  return new Date(ms).toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  });
}

function taskMatches(task: CortexStopTask, filter: TaskFilter) {
  const state = String(task.taskState || "").toUpperCase();
  if (filter === "all") return true;
  if (filter === "good") return task.scanQuality === "good";
  if (filter === "bad") return task.scanQuality === "bad";
  if (filter === "unavailable") return task.scanQuality === "unavailable";
  if (filter === "failed") return /FAIL|ATTEMPT|UNDELIVER|REJECT/.test(state);
  return !/DELIVERED|COMPLETED|SUCCESS|PICKED_UP/.test(state);
}

function mergeDetail(body: CortexRouteDetail, row: CortexRouteRow): CortexRouteDetail {
  const delivered = Number(body.delivered) || row.delivered || 0;
  const attempted = Number(body.attempted) || row.attempted || 0;
  const remaining = Number(body.remaining) || row.remaining || 0;
  return {
    ...body,
    name: row.workforceName || row.amazonName,
    phone: row.phone,
    delivered,
    attempted,
    remaining,
    total: Number(body.total) || row.total || delivered + attempted + remaining,
    plannedPath: Array.isArray(body.plannedPath) ? body.plannedPath : [],
    actualPath: Array.isArray(body.actualPath) ? body.actualPath : [],
    gpsTrail: Array.isArray(body.gpsTrail) ? body.gpsTrail : [],
    gpsTrailError: body.gpsTrailError || null,
    movementStart: body.movementStart ?? null,
    movementEnd: body.movementEnd ?? null,
    stops: Array.isArray(body.stops) ? body.stops : [],
  };
}

export function CortexWorkspace({
  stations,
  board,
  initialQuery = "",
}: {
  stations: CortexStationOption[];
  board: CortexBoard | null;
  initialQuery?: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [stopQuery, setStopQuery] = useState("");
  const [listMode, setListMode] = useState<ListMode>("routes");
  const [routeFilter, setRouteFilter] = useState<RouteFilter>("all");
  const [taskFilter, setTaskFilter] = useState<TaskFilter>("all");
  const [hideCompleted, setHideCompleted] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CortexRouteDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [trailLoading, setTrailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const requestSeq = useRef(0);
  const detailCache = useRef(new Map<string, CortexRouteDetail>());
  const trailCache = useRef(new Map<string, CortexGpsTrailResult>());
  const autoOpenedBoard = useRef("");

  const filtered = useMemo(() => {
    const rows = board?.routes || [];
    const q = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (routeFilter === "on-road" && (row.driverSessionEnded || row.remaining <= 0)) return false;
      if (routeFilter === "closed" && !row.driverSessionEnded && row.executionStatus !== "COMPLETE") return false;
      if (routeFilter === "review" && row.workforceId && row.attempted <= 0) return false;
      if (!q) return true;
      return [row.amazonName, row.workforceName, row.dropxId, row.transporterId, row.routeCode, row.itineraryId]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q));
    });
  }, [board?.routes, query, routeFilter]);

  const selected = useMemo(
    () => board?.routes.find((row) => row.itineraryId === selectedId) || null,
    [board?.routes, selectedId],
  );

  useEffect(() => {
    setSelectedId(null);
    setDetail(null);
    setDetailError("");
    setDetailLoading(false);
    setTrailLoading(false);
    setRouteFilter("all");
    setTaskFilter("all");
    setStopQuery("");
    requestSeq.current += 1;
  }, [board?.station.id, board?.date]);

  useEffect(() => {
    if (!board?.routes.length || selectedId) return;
    const key = `${board.station.id}:${board.date}`;
    if (autoOpenedBoard.current === key) return;
    autoOpenedBoard.current = key;
    void openRoute(board.routes[0]);
    // Auto-open once per board selection; openRoute is deliberately not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board?.station.id, board?.date, board?.routes.length, selectedId]);

  async function fetchTrail(row: CortexRouteRow, seq: number, base: CortexRouteDetail) {
    if (!board) return;
    const key = `${board.station.id}:${board.date}:${row.itineraryId}:trail`;
    const cached = trailCache.current.get(key);
    if (cached) {
      setDetail({ ...base, ...cached });
      return;
    }
    setTrailLoading(true);
    try {
      const params = new URLSearchParams({
        stationId: board.station.id,
        date: board.date,
        itineraryId: row.itineraryId,
        transporterId: row.transporterId,
        view: "trail",
      });
      const response = await fetch(`/api/ops-pulse/performance/cortex?${params}`);
      const body = await response.json().catch(() => ({}));
      if (seq !== requestSeq.current) return;
      if (!response.ok) throw new Error(body.error || "Could not load Driver Trace.");
      const trail: CortexGpsTrailResult = {
        gpsTrail: Array.isArray(body.gpsTrail) ? body.gpsTrail : [],
        gpsTrailError: body.gpsTrailError || null,
        movementStart: body.movementStart ?? null,
        movementEnd: body.movementEnd ?? null,
      };
      trailCache.current.set(key, trail);
      setDetail((current) => (current?.itineraryId === base.itineraryId ? { ...current, ...trail } : current));
    } catch (error) {
      if (seq !== requestSeq.current) return;
      setDetail((current) =>
        current?.itineraryId === base.itineraryId
          ? { ...current, gpsTrailError: error instanceof Error ? error.message : "Could not load Driver Trace." }
          : current,
      );
    } finally {
      if (seq === requestSeq.current) setTrailLoading(false);
    }
  }

  async function openRoute(row: CortexRouteRow) {
    if (!board) return;
    const seq = ++requestSeq.current;
    const key = `${board.station.id}:${board.date}:${row.itineraryId}`;
    setSelectedId(row.itineraryId);
    setDetailError("");
    setTaskFilter("all");
    setStopQuery("");
    const cached = detailCache.current.get(key);
    if (cached) {
      setDetail(cached);
      setDetailLoading(false);
      void fetchTrail(row, seq, cached);
      return;
    }

    setDetail(null);
    setDetailLoading(true);
    try {
      const params = new URLSearchParams({
        stationId: board.station.id,
        date: board.date,
        itineraryId: row.itineraryId,
        view: "detail",
      });
      const response = await fetch(`/api/ops-pulse/performance/cortex?${params}`);
      const body = await response.json().catch(() => ({}));
      if (seq !== requestSeq.current) return;
      if (!response.ok) throw new Error(body.error || "Could not load route detail.");
      if (!body || typeof body !== "object" || !Array.isArray(body.stops)) throw new Error("Route detail response was incomplete.");
      const next = mergeDetail(body, row);
      detailCache.current.set(key, next);
      setDetail(next);
      setDetailLoading(false);
      void fetchTrail(row, seq, next);
    } catch (error) {
      if (seq !== requestSeq.current) return;
      setDetailError(error instanceof Error ? error.message : "Could not load route detail.");
      setDetailLoading(false);
    }
  }

  const visibleStops = useMemo(() => {
    if (!detail) return [];
    const q = stopQuery.trim().toLowerCase();
    return detail.stops
      .map((stop) => ({
        ...stop,
        tasks: stop.tasks.filter((task) => {
          if (!taskMatches(task, taskFilter)) return false;
          if (hideCompleted && /DELIVERED|COMPLETED|SUCCESS|PICKED_UP/.test(String(task.taskState || "").toUpperCase())) return false;
          if (!q) return true;
          return [stop.address, stop.city, task.scannableId, task.orderId, task.taskState]
            .filter(Boolean)
            .some((value) => String(value).toLowerCase().includes(q));
        }),
      }))
      .filter((stop) => stop.tasks.length || (!q && taskFilter === "all" && !hideCompleted));
  }, [detail, hideCompleted, stopQuery, taskFilter]);

  const scanSummary = useMemo(() => {
    const tasks = detail?.stops.flatMap((stop) => stop.tasks) || [];
    return {
      good: tasks.filter((task) => task.scanQuality === "good").length,
      bad: tasks.filter((task) => task.scanQuality === "bad").length,
      unavailable: tasks.filter((task) => task.scanQuality === "unavailable").length,
    };
  }, [detail]);

  const metrics = board?.metrics;
  const deliveredPct = metrics?.total ? Math.round((metrics.delivered / metrics.total) * 100) : 0;
  const attemptSuccess = metrics && metrics.delivered + metrics.attempted
    ? Math.round((metrics.delivered / (metrics.delivered + metrics.attempted)) * 100)
    : 0;

  return (
    <div className={styles.workspace}>
      <form className={styles.filters} method="get" aria-label="Cortex filters">
        <label>Station<select name="station" defaultValue={board?.station.id || stations[0]?.id || ""} required>{stations.map((station) => <option key={station.id} value={station.id}>{station.code} · {station.name}</option>)}</select></label>
        <label>Day<input type="date" name="date" defaultValue={board?.date} max={new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date())} required /></label>
        <label className={styles.search}>{selected ? "Search tracking ID, order or address" : "Search driver, ID or route"}<span className={styles.searchInput}><Search size={15} aria-hidden /><input type="search" name={selected ? undefined : "q"} value={selected ? stopQuery : query} onChange={(event) => selected ? setStopQuery(event.target.value) : setQuery(event.target.value)} placeholder={selected ? "Tracking ID, order ID or address" : "Name, DropX ID, Amazon ID or route"} /></span></label>
        <div className={styles.actions}><button className="button compact" type="submit">Apply</button></div>
      </form>

      {board && !board.sessionOk ? <div className={styles.alert} role="alert"><strong>Cortex session unavailable</strong>{board.sessionError}</div> : null}

      {metrics ? (
        <section className={styles.overview} aria-label="Cortex live summary">
          <article className={styles.summaryGroup}>
            <header>DA / route status</header>
            <div className={styles.summaryStats}>
              <button type="button" onClick={() => setRouteFilter("all")}><strong>{metrics.drivers}</strong><span>Total</span></button>
              <button type="button" onClick={() => setRouteFilter("on-road")}><strong>{metrics.onRoad}</strong><span>On road</span></button>
              <button type="button" onClick={() => setRouteFilter("closed")}><strong>{metrics.closed}</strong><span>Closed</span></button>
              <button type="button" onClick={() => setRouteFilter("review")}><strong>{metrics.unlinked}</strong><span>Needs review</span></button>
            </div>
          </article>
          <article className={styles.summaryGroup}>
            <header>Execution progress</header>
            <div className={styles.rings}>
              <div className={styles.ring} style={{ "--progress": `${deliveredPct * 3.6}deg` } as React.CSSProperties}><strong>{deliveredPct}%</strong><span>Delivered</span></div>
              <div className={styles.ring} style={{ "--progress": `${attemptSuccess * 3.6}deg` } as React.CSSProperties}><strong>{attemptSuccess}%</strong><span>Attempt success</span></div>
            </div>
          </article>
          <article className={`${styles.summaryGroup} ${styles.packageSummary}`}>
            <header>Package status</header>
            <div className={styles.summaryStats}>
              <span><strong>{metrics.total}</strong><small>Assigned</small></span>
              <span><strong>{metrics.delivered}</strong><small>Delivered</small></span>
              <span><strong>{metrics.remaining}</strong><small>Remaining</small></span>
              <span><strong>{metrics.attempted}</strong><small>Delivery failed</small></span>
              <span><strong>{metrics.rejected}</strong><small>Rejected</small></span>
            </div>
          </article>
        </section>
      ) : null}

      <div className={styles.routeTabs} role="tablist" aria-label="Cortex views"><button type="button" role="tab" aria-selected={listMode === "routes"} onClick={() => { setListMode("routes"); setSelectedId(null); setDetail(null); requestSeq.current += 1; }}>Routes</button><button type="button" role="tab" aria-selected={listMode === "drivers"} onClick={() => { setListMode("drivers"); setSelectedId(null); setDetail(null); requestSeq.current += 1; }}>DAs / DPs</button>{board ? <span>{board.station.code} · {board.date}</span> : null}</div>

      <div className={styles.layout}>
        <aside className={styles.rail} aria-label="Driver and stop inspector">
          {!selected ? (
            <>
              <div className={styles.railToolbar}><strong>{filtered.length} {listMode === "routes" ? "routes" : "drivers"}</strong><label><Filter size={14} aria-hidden /><select value={routeFilter} onChange={(event) => setRouteFilter(event.target.value as RouteFilter)}><option value="all">All routes</option><option value="on-road">On road</option><option value="closed">Closed</option><option value="review">Needs review</option></select></label></div>
              <div className={styles.list}>
                {filtered.map((row) => {
                  const badge = statusBadge(row);
                  const progress = completionPct(row.delivered, row.attempted, row.remaining, row.total);
                  return (
                    <button key={row.itineraryId} type="button" className={styles.routeCard} onClick={() => openRoute(row)}>
                      <div className={styles.routeTop}><div><strong>{listMode === "routes" ? row.routeCode || row.itineraryId : row.workforceName || row.amazonName}</strong><small>{listMode === "routes" ? `${row.workforceName || row.amazonName}${row.phone ? ` · ${row.phone}` : ""}` : `${row.routeCode ? `Route ${row.routeCode}` : "Route pending"}${row.phone ? ` · ${row.phone}` : ""}`}</small></div><span className={`${styles.badge} ${badge.className}`}>{badge.label}</span></div>
                      <div className={styles.routeProgress}><span style={{ width: `${progress}%` }} /></div>
                      <div className={styles.pkgRow}><span><b>{row.delivered}</b> delivered</span><span><b>{row.remaining}</b> remaining</span><span><b>{row.attempted}</b> failed</span><span><b>{row.total}</b> total</span></div>
                      <div className={styles.ids}>{row.dropxId ? <code>{row.dropxId}</code> : <code>Not linked</code>}<code title="Amazon transporter ID">{row.transporterId.slice(0, 15)}…</code></div>
                    </button>
                  );
                })}
                {!filtered.length ? <div className={styles.listEmpty}><PackageSearch size={28} aria-hidden /><strong>No routes match</strong><span>Try another filter, search, day or station.</span></div> : null}
              </div>
            </>
          ) : (
            <>
              <div className={styles.driverHeader}>
                <button type="button" onClick={() => { setSelectedId(null); setDetail(null); requestSeq.current += 1; }} aria-label="Back to all drivers"><ArrowLeft size={17} /></button>
                <div><strong>{selected.workforceName || selected.amazonName}</strong><span>{selected.routeCode ? `Route ${selected.routeCode}` : "Route"}{selected.phone ? ` · ${selected.phone}` : ""}</span></div>
                <span className={`${styles.badge} ${statusBadge(selected).className}`}>{statusBadge(selected).label}</span>
              </div>
              <div className={styles.driverStats}><span><strong>{selected.delivered}</strong>Delivered</span><span><strong>{selected.remaining}</strong>Remaining</span><span><strong>{selected.attempted}</strong>Failed</span><span><strong>{selected.total}</strong>Total</span></div>
              {detail ? (
                <div className={styles.scanSummary} aria-label="Scan quality filters">
                  <span className={styles.scanSummaryLabel}>Scan quality</span>
                  <button type="button" className={taskFilter === "all" ? styles.scanFilterActive : undefined} onClick={() => setTaskFilter("all")}><b>{scanSummary.good + scanSummary.bad + scanSummary.unavailable}</b> All</button>
                  <button type="button" className={`${styles.scanFilterGood} ${taskFilter === "good" ? styles.scanFilterActive : ""}`} onClick={() => setTaskFilter("good")} title="Good scan: marked within 50 metres of the planned stop"><b>{scanSummary.good}</b> Good ≤50 m</button>
                  <button type="button" className={`${styles.scanFilterBad} ${taskFilter === "bad" ? styles.scanFilterActive : ""}`} onClick={() => setTaskFilter("bad")} title="Bad scan: marked more than 50 metres from the planned stop"><b>{scanSummary.bad}</b> Bad &gt;50 m</button>
                  <button type="button" className={`${styles.scanFilterUnknown} ${taskFilter === "unavailable" ? styles.scanFilterActive : ""}`} onClick={() => setTaskFilter("unavailable")} title="Amazon did not provide a scan coordinate"><b>{scanSummary.unavailable}</b> No location</button>
                </div>
              ) : null}
              <div className={styles.stopToolbar}><select value={taskFilter} onChange={(event) => setTaskFilter(event.target.value as TaskFilter)} aria-label="Filter route tasks"><option value="all">All stops</option><option value="remaining">Remaining</option><option value="failed">Delivery failed</option><option value="good">Good scans · ≤50 m</option><option value="bad">Bad scans · &gt;50 m</option><option value="unavailable">No scan location</option></select><label><input type="checkbox" checked={hideCompleted} onChange={(event) => setHideCompleted(event.target.checked)} /> Hide completed</label></div>
              {detailLoading ? <div className={styles.railLoading}><span /><span /><span /></div> : null}
              {detailError ? <div className={styles.alert}><strong>Route unavailable</strong>{detailError}</div> : null}
              {detail ? (
                <div className={styles.stops}>
                  {visibleStops.map((stop) => (
                    <article key={`${stop.sequence}-${stop.address}`} className={styles.stop}>
                      <div className={styles.stopHead}><strong>Stop {stop.sequence}{stop.type ? ` · ${stop.type}` : ""}</strong><span>{stop.tasks.length} task{stop.tasks.length === 1 ? "" : "s"}</span></div>
                      <div className={styles.stopAddress}>{stop.address}{stop.city ? `, ${stop.city}` : ""}</div>
                      <ul className={styles.stopTasks}>
                        {stop.tasks.map((task) => (
                          <li key={task.taskId || `${task.scannableId}-${task.actualExecutionTime}`}>
                            <div><span className={styles.taskTitle}>{task.taskType || "Task"} · {task.taskState || "Pending"}</span><span className={styles.taskId}>{task.scannableId || task.orderId || "Tracking ID unavailable"}</span><span className={`${styles.scanBadge} ${task.scanQuality === "good" ? styles.scanGood : task.scanQuality === "bad" ? styles.scanReview : styles.scanUnknown}`}>{task.scanDistanceM == null ? "No scan location" : task.scanQuality === "good" ? `Good scan · ${task.scanDistanceM} m from planned stop` : `Bad scan · ${task.scanDistanceM} m from planned stop`}</span></div>
                            <div className={styles.taskActions}><time>{formatTime(task.actualExecutionTime)}</time>{task.scannableId ? <button type="button" onClick={() => navigator.clipboard.writeText(task.scannableId!)} title="Copy tracking ID"><Copy size={13} /></button> : null}</div>
                          </li>
                        ))}
                      </ul>
                    </article>
                  ))}
                  {!visibleStops.length ? <div className={styles.listEmpty}><Check size={26} /><strong>No matching stops</strong><span>Change the stop filter or search.</span></div> : null}
                </div>
              ) : null}
            </>
          )}
        </aside>

        <section className={styles.mapPanel} aria-label="Cortex route map">
          <header className={styles.mapPanelHead}><div><MapPinned size={17} aria-hidden /><span>{selected ? `${selected.workforceName || selected.amazonName} · live route` : "Select a driver"}</span></div><span>{trailLoading ? "Loading Driver Trace…" : detail?.gpsTrail.length ? `${detail.gpsTrail.length.toLocaleString("en-IN")} GPS points` : "Planned route"}</span></header>
          {detail ? (
            <CortexRouteMap plannedPath={detail.plannedPath} actualPath={detail.actualPath} gpsTrail={detail.gpsTrail || []} gpsTrailError={detail.gpsTrailError || null} gpsLoading={trailLoading} stops={detail.stops} movementStart={detail.movementStart} movementEnd={detail.movementEnd} scanFilter={taskFilter === "good" || taskFilter === "bad" || taskFilter === "unavailable" ? taskFilter : "all"} />
          ) : detailLoading ? (
            <div className={styles.mapSkeleton}><span /><span /><span /><p>Loading route map…</p></div>
          ) : (
            <div className={styles.mapEmptyState}><MapPinned size={34} /><strong>Map-first Cortex</strong><span>Choose a driver to inspect planned stops, scan locations and Driver Trace.</span></div>
          )}
        </section>
      </div>
    </div>
  );
}
