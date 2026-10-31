"use client";

import { useMemo, useState } from "react";
import { ExternalLink, MapPinned, PackageSearch, Route as RouteIcon } from "lucide-react";
import type {
  CortexBoard,
  CortexRouteDetail,
  CortexRouteRow,
  CortexStationOption,
} from "@/lib/ops-pulse/cortex-data";
import styles from "./cortex-workspace.module.css";

function statusBadge(row: CortexRouteRow) {
  if (row.driverSessionEnded || row.executionStatus === "COMPLETE") {
    return { label: "Closed", className: styles.badgeReady };
  }
  if (row.remaining > 0) return { label: "On road", className: styles.badgeOpen };
  return { label: row.executionStatus || "Open", className: styles.badgeIdle };
}

function pct(done: number, total: number) {
  if (!total) return 0;
  return Math.min(100, Math.round((done / total) * 100));
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CortexRouteDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");

  const filtered = useMemo(() => {
    const rows = board?.routes || [];
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      [r.amazonName, r.workforceName, r.dropxId, r.transporterId, r.routeCode, r.itineraryId]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q)),
    );
  }, [board?.routes, query]);

  async function openRoute(row: CortexRouteRow) {
    if (!board) return;
    setSelectedId(row.itineraryId);
    setDetail(null);
    setDetailError("");
    setDetailLoading(true);
    try {
      const params = new URLSearchParams({
        stationId: board.station.id,
        date: board.date,
        itineraryId: row.itineraryId,
      });
      const res = await fetch(`/api/ops-pulse/performance/cortex?${params}`, {
        cache: "no-store",
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Could not load route detail.");
      setDetail({
        ...body,
        name: row.workforceName || row.amazonName,
        phone: row.phone,
      });
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : "Could not load route detail.");
    } finally {
      setDetailLoading(false);
    }
  }

  const selected = filtered.find((r) => r.itineraryId === selectedId) || null;
  const m = board?.metrics;

  return (
    <div className={styles.workspace}>
      <form className={styles.filters} method="get" aria-label="Cortex filters">
        <label>
          Station
          <select name="station" defaultValue={board?.station.id || stations[0]?.id || ""} required>
            {stations.map((s) => (
              <option key={s.id} value={s.id}>
                {s.code} · {s.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Day
          <input
            type="date"
            name="date"
            defaultValue={board?.date}
            max={new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date())}
            required
          />
        </label>
        <label className={styles.search}>
          Search DA / ID / route
          <input
            type="search"
            name="q"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Name, DropX ID, Amazon ID, route code"
          />
        </label>
        <div className={styles.actions}>
          {board?.amazonUrl ? (
            <a
              className={styles.amazonLink}
              href={board.amazonUrl}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink size={14} />
              Open in Amazon
            </a>
          ) : null}
          <button className="button compact" type="submit">
            Apply
          </button>
        </div>
      </form>

      {board && !board.sessionOk ? (
        <div className={styles.alert} role="alert">
          <strong>Cortex session unavailable</strong>
          {board.sessionError}
        </div>
      ) : null}

      {m ? (
        <div className={styles.metrics}>
          <article>
            <span>Routes today</span>
            <strong>{m.routes}</strong>
            <small>
              {m.drivers} driver{m.drivers === 1 ? "" : "s"} on this station
            </small>
          </article>
          <article>
            <span>Delivered</span>
            <strong>{m.delivered}</strong>
            <small>Packages completed</small>
          </article>
          <article>
            <span>Remaining</span>
            <strong>{m.remaining}</strong>
            <small>Still on route</small>
          </article>
          <article>
            <span>Attempted</span>
            <strong>{m.attempted}</strong>
            <small>Tried, not delivered</small>
          </article>
          <article>
            <span>Linked to DropX</span>
            <strong>{m.linked}</strong>
            <small>Mapped workforce IDs</small>
          </article>
          <article>
            <span>Unlinked</span>
            <strong>{m.unlinked}</strong>
            <small>Amazon ID only</small>
          </article>
        </div>
      ) : null}

      <div className={styles.layout}>
        <section className={styles.panel} aria-label="Driver routes">
          <header className={styles.panelHead}>
            <div>
              <h2>Drivers & routes</h2>
              <p>
                {board
                  ? `${filtered.length} of ${board.routes.length} routes · ${board.station.code} · ${board.date}`
                  : "Select a station and day"}
              </p>
            </div>
            <RouteIcon size={18} aria-hidden color="#94a3b8" />
          </header>
          <div className={styles.list}>
            {filtered.map((row) => {
              const badge = statusBadge(row);
              const active = row.itineraryId === selectedId;
              return (
                <button
                  key={row.itineraryId}
                  type="button"
                  className={`${styles.routeCard} ${active ? styles.routeCardActive : ""}`}
                  onClick={() => openRoute(row)}
                >
                  <div className={styles.routeTop}>
                    <div>
                      <strong>{row.workforceName || row.amazonName}</strong>
                      <small>
                        {row.routeCode ? `Route ${row.routeCode}` : "Route pending"}
                        {row.phone ? ` · ${row.phone}` : ""}
                      </small>
                    </div>
                    <span className={`${styles.badge} ${badge.className}`}>{badge.label}</span>
                  </div>
                  <div className={styles.pkgRow}>
                    <span>
                      Delivered <b>{row.delivered}</b>
                    </span>
                    <span>
                      Remaining <b>{row.remaining}</b>
                    </span>
                    <span>
                      Attempted <b>{row.attempted}</b>
                    </span>
                    <span>
                      Total <b>{row.total}</b>
                    </span>
                  </div>
                  <div className={styles.ids}>
                    {row.dropxId ? <code>{row.dropxId}</code> : <code>Not linked</code>}
                    <code title="Amazon transporter">{row.transporterId.slice(0, 12)}…</code>
                  </div>
                </button>
              );
            })}
            {!filtered.length ? (
              <div className={styles.listEmpty}>
                <PackageSearch size={28} aria-hidden style={{ margin: "0 auto 10px", opacity: 0.45 }} />
                <strong>No routes match</strong>
                <span>
                  {board?.sessionOk
                    ? "Try another search, day, or station in your approved locations."
                    : "Cortex could not load routes for this selection."}
                </span>
              </div>
            ) : null}
          </div>
        </section>

        <section className={styles.panel} aria-label="Route detail">
          <header className={styles.panelHead}>
            <div>
              <h2>Route detail</h2>
              <p>
                {selected
                  ? `${selected.workforceName || selected.amazonName} · stops & packages`
                  : "Select a driver to inspect deliveries"}
              </p>
            </div>
            <MapPinned size={18} aria-hidden color="#94a3b8" />
          </header>

          {!selectedId ? (
            <div className={styles.detailEmpty}>
              <strong>Pick a route</strong>
              <span>
                Open any driver on the left to see stop sequence, package states, and scan times
                for that itinerary.
              </span>
            </div>
          ) : null}

          {detailLoading ? <p className={styles.loading}>Loading route from Cortex…</p> : null}
          {detailError ? (
            <div className={styles.alert} role="alert" style={{ margin: 16 }}>
              <strong>Detail unavailable</strong>
              {detailError}
            </div>
          ) : null}

          {detail && !detailLoading ? (
            <div className={styles.detailBody}>
              <div className={styles.detailMeta}>
                <div>
                  <span>Associate</span>
                  <strong>{detail.name}</strong>
                </div>
                <div>
                  <span>Route code</span>
                  <strong>{detail.routeCode || "—"}</strong>
                </div>
                <div>
                  <span>Status</span>
                  <strong>
                    {detail.driverSessionEnded ? "Session closed" : detail.executionStatus || "Open"}
                  </strong>
                </div>
                <div>
                  <span>Stops</span>
                  <strong>{detail.stops.length}</strong>
                </div>
              </div>

              <div className={styles.progress}>
                <div className={styles.progressTrack}>
                  <div
                    className={styles.progressFill}
                    style={{ width: `${pct(detail.delivered, detail.total)}%` }}
                  />
                </div>
                <div className={styles.progressLegend}>
                  <span>
                    Delivered <b>{detail.delivered}</b>
                  </span>
                  <span>
                    Remaining <b>{detail.remaining}</b>
                  </span>
                  <span>
                    Attempted <b>{detail.attempted}</b>
                  </span>
                  <span>
                    {pct(detail.delivered, detail.total)}% complete
                  </span>
                </div>
              </div>

              <div className={styles.stops}>
                {detail.stops.map((stop) => (
                  <article key={`${stop.sequence}-${stop.address}`} className={styles.stop}>
                    <div className={styles.stopHead}>
                      <strong>
                        Stop {stop.sequence}
                        {stop.type ? ` · ${stop.type}` : ""}
                      </strong>
                      <span>
                        {stop.tasks.length} task{stop.tasks.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    <div className={styles.stopAddress}>
                      {stop.address}
                      {stop.city ? `, ${stop.city}` : ""}
                    </div>
                    {stop.tasks.length ? (
                      <ul className={styles.stopTasks}>
                        {stop.tasks.map((task) => (
                          <li key={task.taskId || `${task.scannableId}-${task.actualExecutionTime}`}>
                            <span>
                              {task.taskType || "Task"}
                              {task.taskState ? ` · ${task.taskState}` : ""}
                              {task.scannableId ? ` · ${task.scannableId}` : ""}
                            </span>
                            <span>{formatTime(task.actualExecutionTime)}</span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </article>
                ))}
                {!detail.stops.length ? (
                  <div className={styles.detailEmpty}>
                    <strong>No stop detail yet</strong>
                    <span>Amazon returned the itinerary without stop rows for this day.</span>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
