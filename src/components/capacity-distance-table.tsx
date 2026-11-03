"use client";
import { ReportTable } from "@/components/report-table";

import dynamic from "next/dynamic";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowDownUp, ChevronDown, ChevronLeft, ChevronRight, Download, Link2, Link2Off, MapPinned, RouteOff, X } from "lucide-react";
import { distanceMethods, distanceStatus, filterDistanceEntries, filterDistanceScope, groupDistanceAssociates, type DistanceEntry, type DistanceViewFilters } from "@/lib/ops-pulse/distance-register";
import { routePendingLabel } from "@/lib/workforce-route-distance";
import styles from "./capacity-distance.module.css";
import type { RouteGeometry } from "./capacity-distance-map";
const RouteMap = dynamic(() => import("./capacity-distance-map").then((m) => m.CapacityDistanceMap),
  { ssr: false, loading: () => <p>Loading map controls…</p> });
const number = (v: number | null) => v === null ? "—" : v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const date = (v: string) => new Date(v + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
function reason(r: DistanceEntry) {
  return r.reason === "input_conflict" ? "Conflicting kilometre inputs or overlapping mappings." : routePendingLabel(r.reason);
}
function mapAmazonHref(rows: DistanceEntry[], fallbackFrom: string, fallbackTo: string) {
  const identity = rows.filter((r) => r.reason === "amazon_identity_missing");
  const source = identity.length ? identity : rows;
  if (!source.length) return null;
  // Prefer the station with the most unlinked days for this associate.
  const byStation = new Map<string, DistanceEntry[]>();
  for (const row of source) {
    const list = byStation.get(row.stationId) || [];
    list.push(row);
    byStation.set(row.stationId, list);
  }
  const stationRows = [...byStation.values()].sort((a, b) => b.length - a.length)[0];
  const first = stationRows[0];
  const dates = stationRows.map((r) => r.date).sort();
  const qs = new URLSearchParams({
    workforce: first.workforceId,
    station: first.stationId,
    from: dates[0] || fallbackFrom,
    to: dates[dates.length - 1] || fallbackTo,
  });
  return `/ops-pulse/capacity/distance/map-amazon-id?${qs}`;
}
export function CapacityDistanceTable({
  rows,
  filters,
  mode = "register",
  identityHref,
  identityCount = 0,
  noRouteHref,
  noRouteCount = 0,
}: {
  rows: DistanceEntry[];
  filters: DistanceViewFilters;
  mode?: "register" | "identity" | "no-route";
  identityHref?: string;
  identityCount?: number;
  noRouteHref?: string;
  noRouteCount?: number;
}) {
  const [page, setPage] = useState(0), [expanded, setExpanded] = useState<string | null>(null),
    [selected, setSelected] = useState<DistanceEntry | null>(null), [sort, setSort] = useState<"name" | "km">("name"),
    [exporting, setExporting] = useState(false), [exportError, setExportError] = useState("");
  const identityMode = mode === "identity";
  const noRouteMode = mode === "no-route";
  const queueMode = identityMode || noRouteMode;
  const filtered = useMemo(() => filterDistanceEntries(rows, filters), [rows, filters]);
  const scoped = useMemo(() => filterDistanceScope(rows, filters), [rows, filters]);
  const associates = useMemo(() => {
    const result = groupDistanceAssociates(filtered);
    return sort === "km" ? result.sort((a, b) => (b.km ?? -1) - (a.km ?? -1) || a.name.localeCompare(b.name)) : result;
  }, [filtered, sort]);
  const shown = associates.slice(page * 50, page * 50 + 50), ready = filtered.filter((r) => r.status === "ready"),
    total = ready.reduce((s, r) => s + (r.km || 0), 0), fuel = ready.reduce((s, r) => s + (r.fuel || 0), 0);
  const stationCount = new Set(filtered.map((r) => r.station)).size;
  const period = `${date(filters.from)} – ${date(filters.to)}`;
  const readyOnlyView = !queueMode && (!filters.statuses.length || (filters.statuses.length === 1 && filters.statuses[0] === "Ready"));
  const canExport = scoped.length > 0;
  async function download() {
    setExporting(true); setExportError("");
    try {
      // Export the same authorized, filtered snapshot; no additional database query.
      const { distanceWorkbookBytes } = await import("@/lib/ops-pulse/distance-register-export");
      const bytes = distanceWorkbookBytes(rows, filters);
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
      const link = document.createElement("a");
      link.href = url; link.download = `distance-fuel-${filters.from}-to-${filters.to}.xlsx`;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { setExportError("Excel could not be downloaded. Please try again."); }
    finally { setExporting(false); }
  }
  return <>
    <div className={styles.metrics}>
      {identityMode ? <>
        <article className={styles.metricAccentIdentity}><span>Unlinked associate-days</span><strong>{filtered.length}</strong><p>amazon_identity_missing</p></article>
        <article><span>Associates</span><strong>{associates.length}</strong><p>Need SCC / Flex transporter link</p></article>
        <article><span>Stations</span><strong>{stationCount}</strong><p>{stationCount === 1 ? "station" : "stations"} in this selection</p></article>
        <article><span>Payable distance</span><strong>—</strong><p>Settles after Amazon ID is mapped</p></article>
      </> : noRouteMode ? <>
        <article className={styles.metricAccentNoRoute}><span>No-route associate-days</span><strong>{filtered.length}</strong><p>route_not_received</p></article>
        <article><span>Associates</span><strong>{associates.length}</strong><p>No Amazon itinerary on these days</p></article>
        <article><span>Stations</span><strong>{stationCount}</strong><p>{stationCount === 1 ? "station" : "stations"} in this selection</p></article>
        <article><span>System fuel</span><strong>—</strong><p>0 km until a route appears or exception</p></article>
      </> : <>
        <article><span>Recorded distance</span><strong>{number(total)} <small>km</small></strong><p>{ready.length} ready associate-{ready.length === 1 ? "day" : "days"}</p></article>
        <article><span>Fuel allowance</span><strong>₹{number(fuel)}</strong><p>Payable fuel in the selected period</p></article>
        <article><span>{readyOnlyView ? "Ready associate-days" : "Awaiting distance"}</span><strong>{readyOnlyView ? ready.length : filtered.length - ready.length}</strong><p>{readyOnlyView ? "Non-ready days hidden · see Excel No payouts" : "Associate-days pending or needing attention"}</p></article>
        <article><span>Associates</span><strong>{associates.length}</strong><p>{stationCount} {stationCount === 1 ? "station" : "stations"} in this selection</p></article>
      </>}
    </div>
    <section className={styles.panel}>
      <header className={styles.tableHead}>
        <div>
          <h2>{identityMode ? "Unlinked Amazon IDs" : noRouteMode ? "No Amazon route" : "Associate distance register"}</h2>
          <span>{associates.length} {associates.length === 1 ? "associate" : "associates"} · {period}</span>
          <p className={styles.note}>{identityMode
            ? "Associates missing an Amazon driver ID for these days. Use Map Amazon ID to set the Flex ID and dates, then sync."
            : noRouteMode
            ? "Days with no Amazon delivery itinerary. Confirm the Flex route or handle fuel by payroll exception — Present alone is not payable KM."
            : "Select an associate to see their daily breakdown for this period."}</p>
        </div>
        <div className={styles.tableActions}>
          {!queueMode && identityHref && identityCount > 0 ? (
            <Link href={identityHref} className={styles.identityLink}>
              <Link2Off size={15}/>Unlinked Amazon IDs ({identityCount})
            </Link>
          ) : null}
          {!queueMode && noRouteHref && noRouteCount > 0 ? (
            <Link href={noRouteHref} className={styles.noRouteLink}>
              <RouteOff size={15}/>No Amazon route ({noRouteCount})
            </Link>
          ) : null}
          <button type="button" className={styles.sort} onClick={() => { setSort((s) => s === "name" ? "km" : "name"); setPage(0); }}><ArrowDownUp size={15}/>{sort === "name" ? "Name A–Z" : "Highest km first"}</button>
          <button type="button" className={styles.download} onClick={download} disabled={exporting || !canExport}><Download size={16}/>{exporting ? "Preparing Excel…" : "Download Excel"}</button>
        </div>
      </header>
      {exportError ? <p role="alert" className={styles.notice}>{exportError}</p> : null}
      <div className={styles.tableWrap}>
        <ReportTable className={`${styles.table} ${styles.associateTable}`}>
          <thead><tr><th>Associate / station</th><th>Amazon ID</th><th>Mapped DropX ID</th><th>Days</th><th>Recorded distance</th><th>Fuel allowance</th><th>Coverage</th><th><span className={styles.srOnly}>Daily breakdown</span></th></tr></thead>
          <tbody>
            {shown.map((a) => <Fragment key={a.key}>
              <tr className={`${styles.associateRow} ${expanded === a.key ? styles.activeRow : ""}`} onClick={() => setExpanded((key) => key === a.key ? null : a.key)}>
                <td className={styles.associateIdentity}><button type="button" className={styles.associateName} aria-expanded={expanded === a.key} aria-controls={`days-${a.key}`} aria-label={`Show daily breakdown for ${a.name}`} onClick={(e) => { e.stopPropagation(); setExpanded((key) => key === a.key ? null : a.key); }}>{a.name}</button><small>{a.stations.join(" · ")}</small></td>
                <td data-label="Amazon ID" className={styles.id}>{a.amazonIds.length ? a.amazonIds.map((id) => <strong key={id}>{id}</strong>) : <strong>Not linked</strong>}{a.transporterIds.map((id) => <small key={id}>LSC: {id}</small>)}</td>
                <td data-label="Mapped DropX ID" className={styles.id}>{a.dropxIds.length ? a.dropxIds.map((id) => <strong key={id}>{id}</strong>) : <strong>Not mapped</strong>}</td>
                <td data-label="Days" className={styles.numeric}><strong>{a.days} {a.days === 1 ? "day" : "days"}</strong></td>
                <td data-label="Recorded distance" className={styles.numeric}><strong>{a.km === null ? "—" : `${number(a.km)} km`}</strong>{!readyOnlyView && a.pendingDays && a.km !== null ? <small>Recorded days only</small> : null}</td>
                <td data-label="Fuel allowance" className={styles.numeric}><strong>{a.fuel === null ? "—" : `₹${number(a.fuel)}`}</strong>{!readyOnlyView && a.pendingDays && a.fuel !== null ? <small>Partial total</small> : null}</td>
                <td data-label="Coverage"><span className={`${styles.badge} ${!readyOnlyView && a.pendingDays ? styles.pending : styles.ready}`}>{readyOnlyView || !a.pendingDays ? "Ready" : `${a.pendingDays} ${a.pendingDays === 1 ? "day" : "days"} pending`}</span></td>
                <td className={styles.expandIndicator}>
                  <div className={styles.mapAmazonRowActions} onClick={(e) => e.stopPropagation()}>
                    {identityMode || a.rows.some((r) => r.reason === "amazon_identity_missing") ? (
                      (() => {
                        const href = mapAmazonHref(a.rows, filters.from, filters.to);
                        return href ? (
                          <Link href={href} className={styles.mapAmazonLink}>
                            <Link2 size={14} aria-hidden="true" />Map Amazon ID
                          </Link>
                        ) : null;
                      })()
                    ) : null}
                    <ChevronDown size={17} aria-hidden="true" className={expanded === a.key ? styles.rotated : ""}/>
                  </div>
                </td>
              </tr>
              {expanded === a.key ? <tr className={styles.expandedRow}><td colSpan={8}>
                <section id={`days-${a.key}`} aria-label={`Daily breakdown for ${a.name}`} className={styles.dailyPanel}>
                  <header className={styles.dailyHead}><div><h3>{a.name} · Daily breakdown</h3><span>{period} · {a.days} {a.days === 1 ? "day" : "days"} matching the applied filters</span></div><button type="button" className={styles.close} aria-label={`Collapse daily breakdown for ${a.name}`} onClick={() => setExpanded(null)}><X size={17}/></button></header>
                  <ReportTable className={styles.dailyTable}><thead><tr><th>Day / station</th><th>Distance</th><th>Rate / km</th><th>Fuel</th><th>Status / source</th><th>Route</th></tr></thead>
                    <tbody>{a.rows.map((r) => <tr key={r.key}>
                      <td><strong>{date(r.date)}</strong><small>{r.station}</small>{a.amazonIds.length > 1 ? <small>Amazon: {r.amazonId}</small> : null}</td>
                      <td className={styles.numeric}><strong>{r.km === null ? "—" : `${number(r.km)} km`}</strong></td>
                      <td className={styles.numeric}>₹{number(r.rate)}</td>
                      <td className={styles.numeric}><strong>{r.fuel === null ? "—" : `₹${number(r.fuel)}`}</strong></td>
                      <td><span className={`${styles.badge} ${r.status === "ready" ? styles.ready : styles.pending}`}>{distanceStatus(r)}</span><small>{r.status === "ready" ? distanceMethods[r.method] || r.method : reason(r)}</small></td>
                      <td className={styles.mapAmazonRowActions}>
                        {r.reason === "amazon_identity_missing" ? (
                          <Link
                            href={`/ops-pulse/capacity/distance/map-amazon-id?${new URLSearchParams({
                              workforce: r.workforceId,
                              station: r.stationId,
                              from: r.date,
                              to: r.date,
                            }).toString()}`}
                            className={styles.mapAmazonLink}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Link2 size={14} aria-hidden="true" />Map Amazon ID
                          </Link>
                        ) : null}
                        <button type="button" className={styles.open} onClick={() => setSelected(r)} aria-label={`Open distance details for ${r.name}, ${date(r.date)}, ${r.station}`}><MapPinned size={16}/>Details</button>
                      </td>
                    </tr>)}</tbody>
                  </ReportTable>
                </section>
              </td></tr> : null}
            </Fragment>)}
            {!shown.length ? <tr><td colSpan={8}><div className={styles.empty}><MapPinned size={28}/><strong>{identityMode ? "No unlinked Amazon IDs in this selection" : noRouteMode ? "No route_not_received days in this selection" : "No associates match these filters"}</strong><span>{identityMode ? "Everyone in scope already has a transporter link, or widen the date / station filters." : noRouteMode ? "Every associate-day in scope already has an Amazon itinerary, or widen the filters." : "Try another date, station or status. Only kilometre-based fuel mappings are included."}</span></div></td></tr> : null}
          </tbody>
        </ReportTable>
      </div>
      <footer className={styles.pagination}><span>{associates.length ? `${page * 50 + 1}–${Math.min((page + 1) * 50, associates.length)} of ${associates.length} associates` : "0 associates"}</span><div>
        <button type="button" aria-label="Previous page" disabled={page === 0} onClick={() => setPage((p) => p - 1)}><ChevronLeft size={18}/></button>
        <button type="button" aria-label="Next page" disabled={(page + 1) * 50 >= associates.length} onClick={() => setPage((p) => p + 1)}><ChevronRight size={18}/></button>
      </div></footer>
    </section>
    {!queueMode && ((identityHref && identityCount > 0) || (noRouteHref && noRouteCount > 0)) ? (
      <section className={styles.queuePanel} aria-label="Payroll hold queues">
        <header>
          <h2>Payroll hold queues</h2>
          <p>Ready days above are payable. Open a queue to clear blockers before fuel for these days.</p>
        </header>
        <div className={styles.queueCards}>
          {identityHref && identityCount > 0 ? (
            <Link href={identityHref} className={`${styles.queueCard} ${styles.queueCardIdentity}`}>
              <span className={styles.queueIcon}><Link2Off size={20} aria-hidden="true" /></span>
              <div>
                <strong>Unlinked Amazon IDs</strong>
                <span>amazon_identity_missing</span>
                <p>Map Amazon driver ID by dates, then sync.</p>
              </div>
              <em>{identityCount}</em>
            </Link>
          ) : null}
          {noRouteHref && noRouteCount > 0 ? (
            <Link href={noRouteHref} className={`${styles.queueCard} ${styles.queueCardNoRoute}`}>
              <span className={styles.queueIcon}><RouteOff size={20} aria-hidden="true" /></span>
              <div>
                <strong>No Amazon route</strong>
                <span>route_not_received</span>
                <p>Confirm Flex itinerary or exception pay.</p>
              </div>
              <em>{noRouteCount}</em>
            </Link>
          ) : null}
        </div>
      </section>
    ) : null}
    {selected ? <DistanceDetail row={selected} close={() => setSelected(null)}/> : null}
  </>;
}
function DistanceDetail({
  row,
  close,
}: {
  row: DistanceEntry;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    [geometry, setGeometry] = useState<RouteGeometry | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(Boolean(row.routeId)),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    const focus = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
      focus?.focus();
    };
  }, []);
  useEffect(() => {
    if (!row.routeId) return;
    let active = true;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 15000);
    setLoading(true);
    setError("");
    fetch(
      `/api/ops-pulse/capacity/distance?routeId=${encodeURIComponent(row.routeId)}`,
      { signal: abort.signal, cache: "no-store" },
    )
      .then(async (r) => {
        const p = await r.json();
        if (!r.ok) throw Error(p.error || "Map is unavailable.");
        if (active) setGeometry(p.geometry);
      })
      .catch(() => {
        if (active)
          setError(
            "Map could not be loaded. The saved distance above is still available.",
          );
      })
      .finally(() => {
        clearTimeout(timer);
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      abort.abort();
      clearTimeout(timer);
    };
  }, [row.routeId, retry]);
  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby="distance-detail-title"
      onCancel={close}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className={styles.dialogBody}>
        <header className={styles.detailHead}>
          <div>
            <span>
              {row.station} · {date(row.date)}
            </span>
            <h2 id="distance-detail-title">{row.name}</h2>
          </div>
          <button
            type="button"
            className={styles.close}
            aria-label="Close distance details"
            onClick={close}
          >
            <X />
          </button>
        </header>
        <div className={styles.identities}>
          <div>
            <span>Amazon ID</span>
            <strong>{row.amazonId || "Not linked"}</strong>
          </div>
          <div>
            <span>Mapped DropX ID</span>
            <strong>{row.dropxId || "Not mapped"}</strong>
          </div>
          <div>
            <span>Amazon LSC Driver ID</span>
            <strong>{row.transporterId || "Awaiting Amazon link"}</strong>
          </div>
        </div>
        <div className={styles.breakup}>
          <div>
            <span>Distance</span>
            <strong>
              {row.km === null ? "—" : `${number(row.km)} km`}
            </strong>
          </div>
          <div>
            <span>Mapped rate</span>
            <strong>₹{number(row.rate)} / km</strong>
          </div>
          <div>
            <span>Fuel allowance</span>
            <strong>
              {row.fuel === null ? "—" : `₹${number(row.fuel)}`}
            </strong>
          </div>
        </div>
        {row.status === "pending" ? (
          <p className={styles.notice}>{reason(row)}</p>
        ) : (
          <p className={styles.detailMeta}>
            {distanceMethods[row.method] || row.method} · {row.scans} scans
            {row.method === "scan_roads" ? " (estimate: shortest roads, no complete GPS trail)" : ""}
            {row.skippedScans ? ` · ${row.skippedScans} without location left out` : ""}
            {row.updatedAt
              ? ` · Updated ${new Date(row.updatedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })} IST`
              : ""}
          </p>
        )}
        {row.departureKm !== null ? (
          <div className={styles.legs}>
            <span>
              Station → first stop <b>{number(row.departureKm)} km</b>
            </span>
            <span>
              Between stops <b>{number(row.deliveryKm)} km</b>
            </span>
            <span>
              Last stop → station <b>{number(row.returnKm)} km</b>
            </span>
          </div>
        ) : null}
        {loading ? (
          <p className={styles.notice} role="status">
            Loading saved route…
          </p>
        ) : geometry ? (
          <RouteMap geometry={geometry} />
        ) : error ? (
          <div className={styles.notice}>
            <p>{error}</p>
            <button type="button" onClick={() => setRetry((n) => n + 1)}>
              Retry map
            </button>
          </div>
        ) : (
          <p className={styles.notice}>
            A map will appear when route evidence is available for this day.
          </p>
        )}
        <p className={styles.note}>
          Numbered stops show scan times and counts. Customer addresses and
          package details are excluded.
        </p>
      </div>
    </dialog>
  );
}
