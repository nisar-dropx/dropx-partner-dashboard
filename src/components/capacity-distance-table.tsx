"use client";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownUp,
  ChevronLeft,
  ChevronRight,
  MapPinned,
  X,
} from "lucide-react";
import {
  distanceMethods,
  type DistanceEntry,
} from "@/lib/ops-pulse/distance-register";
import { summarizeDistanceAssociates } from "@/lib/ops-pulse/distance-associates";
import { routePendingLabel } from "@/lib/workforce-route-distance";
import styles from "./capacity-distance.module.css";
import type { RouteGeometry } from "./capacity-distance-map";
const RouteMap = dynamic(
  () => import("./capacity-distance-map").then((m) => m.CapacityDistanceMap),
  { ssr: false, loading: () => <p>Loading map controls…</p> },
);
const number = (v: number | null) =>
  v === null
    ? "—"
    : v.toLocaleString("en-IN", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
const date = (v: string) =>
  new Date(v + "T00:00:00Z").toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
function status(r: DistanceEntry) {
  return r.status === "ready"
    ? "Ready"
    : [
          "input_conflict",
          "route_needs_review",
          "identity_mismatch",
          "conflicting_scan",
          "amazon_identity_missing",
          "mapping_changed",
        ].includes(r.reason || "")
      ? "Needs attention"
      : "Pending";
}
function reason(r: DistanceEntry) {
  return r.reason === "input_conflict"
    ? "Conflicting kilometre inputs or overlapping mappings."
    : routePendingLabel(r.reason);
}
export function CapacityDistanceTable({
  rows,
  statuses,
  methods,
  query,
}: {
  rows: DistanceEntry[];
  statuses: string[];
  methods: string[];
  query: string;
}) {
  const [page, setPage] = useState(0),
    [associateId, setAssociateId] = useState<string | null>(null),
    [selected, setSelected] = useState<DistanceEntry | null>(null),
    [sort, setSort] = useState<"date" | "km">("date");
  const filtered = useMemo(
    () =>
      rows
        .filter(
          (r) =>
            (!statuses.length || statuses.includes(status(r))) &&
            (!methods.length ||
              methods.includes(distanceMethods[r.method] || r.method)) &&
            (!query ||
              [r.name, r.amazonId, r.dropxId, r.transporterId].some((s) =>
                s.toLowerCase().includes(query.toLowerCase()),
              )),
        )
        .sort((a, b) =>
          sort === "km"
            ? (b.km ?? -1) - (a.km ?? -1) || b.date.localeCompare(a.date)
            : b.date.localeCompare(a.date) ||
              a.station.localeCompare(b.station) ||
              a.name.localeCompare(b.name),
        ),
    [rows, statuses, methods, query, sort],
  );
  const associates = useMemo(() => summarizeDistanceAssociates(filtered).sort((a, b) =>
    sort === "km" ? (b.km ?? -1) - (a.km ?? -1) || a.name.localeCompare(b.name)
      : a.name.localeCompare(b.name) || a.id.localeCompare(b.id)), [filtered, sort]);
  const associate = associates.find(row => row.id === associateId);
  useEffect(() => { setPage(0); setAssociateId(null); setSelected(null); }, [rows, statuses, methods, query]);
  const visibleRows = associate ? filtered.filter(row => row.workforceId === associate.id) : filtered;
  const count = associate ? visibleRows.length : associates.length;
  const safePage = Math.min(page, Math.max(0, Math.ceil(count / 50) - 1));
  const shown = visibleRows.slice(safePage * 50, safePage * 50 + 50),
    ready = visibleRows.filter((r) => r.status === "ready"),
    total = ready.reduce((s, r) => s + (r.km || 0), 0),
    fuel = ready.reduce((s, r) => s + (r.fuel || 0), 0);
  return (
    <>
      <div className={styles.metrics}>
        <article>
          <span>Recorded distance</span>
          <strong>
            {number(total)} <small>km</small>
          </strong>
          <p>{ready.length} ready associate-days</p>
        </article>
        <article>
          <span>Fuel allowance</span>
          <strong>₹{number(fuel)}</strong>
          <p>Based on mapped daily rates</p>
        </article>
        <article>
          <span>Awaiting distance</span>
          <strong>{visibleRows.length - ready.length}</strong>
          <p>Pending or needs attention</p>
        </article>
        <article>
          <span>{associate ? "Recorded dates" : "Associates"}</span>
          <strong>{associate ? associate.dates : associates.length}</strong>
          <p>
            {new Set(visibleRows.map((r) => r.station)).size} stations in this
            selection
          </p>
        </article>
      </div>
      <section className={styles.panel}>
        <header className={styles.tableHead}>
          <div>
            {associate ? <button type="button" className={styles.sort} onClick={() => { setAssociateId(null); setPage(0); }}><ChevronLeft size={15} /> All associates</button> : null}
            <h2>{associate ? associate.name : "Associate distance summary"}</h2>
            <span>{associate ? `${associate.dates} dates · ${associate.stations.join(", ")} · Daily breakdown` : `${associates.length} associates · ${filtered.length} associate-days · Select an associate to view dates`}</span>
          </div>
          <button
            type="button"
            className={styles.sort}
            onClick={() => {
              setSort((s) => (s === "date" ? "km" : "date"));
              setPage(0);
            }}
          >
            <ArrowDownUp size={15} />
            {sort === "date" ? (associate ? "Latest first" : "Name A–Z") : "Highest km first"}
          </button>
        </header>
        {!associate ? <div className={styles.summaryList}>
          <div className={styles.summaryLabels}><span>Associate / station</span><span>Dates / data source</span><span>Distance / fuel</span><span>Coverage</span><span /></div>
          {associates.slice(safePage * 50, safePage * 50 + 50).map(a => <article key={a.id} className={styles.summaryRow}>
            <div><button type="button" className={styles.associateName} onClick={() => { setAssociateId(a.id); setPage(0); }}>{a.name}</button><small>{a.stations.join(" · ")}</small><small>Amazon: {a.amazonIds.join(" / ") || "Not linked"} · DropX: {a.dropxIds.join(" / ") || "Not mapped"}</small></div>
            <div><strong>{date(a.from)}{a.to !== a.from ? ` – ${date(a.to)}` : ""}</strong><small>{a.dates} dates · {a.sources.map(s => `${distanceMethods[s.method] || s.method} (${s.count})`).join(" · ")}</small></div>
            <div><strong>{a.km === null ? "Distance pending" : `${number(a.km)} km`}</strong><small>{a.fuel === null ? "Fuel pending" : `₹${number(a.fuel)} fuel`}{a.pending && a.ready ? " · partial total" : ""}</small></div>
            <div><span className={`${styles.badge} ${a.pending ? styles.pending : styles.ready}`}>{a.pending ? `${a.pending} pending` : "All ready"}</span><small>{a.ready} / {a.days.length} station-days ready</small></div>
            <button type="button" className={styles.open} aria-label={`View dates for ${a.name}`} onClick={() => { setAssociateId(a.id); setPage(0); }}>View dates <ChevronRight size={16} /></button>
          </article>)}
          {!associates.length ? <p className={styles.empty}>No associates match these filters. Try another date, station or status.</p> : null}
        </div> : <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Day / station</th>
                <th>Associate</th>
                <th>Amazon ID</th>
                <th>Mapped DropX ID</th>
                <th>Distance</th>
                <th>Fuel</th>
                <th>Status / source</th>
                <th>
                  <span className={styles.srOnly}>Route details</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.key}>
                  <td>
                    <strong>{date(r.date)}</strong>
                    <small>{r.station}</small>
                  </td>
                  <td>
                    <strong>{r.name}</strong>
                  </td>
                  <td className={styles.id}>
                    <strong>{r.amazonId || "Not linked"}</strong>
                    {r.transporterId ? (
                      <small>LSC: {r.transporterId}</small>
                    ) : (
                      <small>LSC link pending</small>
                    )}
                  </td>
                  <td className={styles.id}>
                    <strong>{r.dropxId || "Not mapped"}</strong>
                  </td>
                  <td className={styles.numeric}>
                    <strong>
                      {r.km === null ? "Pending" : `${number(r.km)} km`}
                    </strong>
                  </td>
                  <td className={styles.numeric}>
                    <strong>
                      {r.fuel === null ? "Pending" : `₹${number(r.fuel)}`}
                    </strong>
                    <small>₹{number(r.rate)} / km</small>
                  </td>
                  <td>
                    <span
                      className={`${styles.badge} ${r.status === "ready" ? styles.ready : styles.pending}`}
                    >
                      {status(r)}
                    </span>
                    <small>
                      {r.status === "ready"
                        ? distanceMethods[r.method] || r.method
                        : reason(r)}
                    </small>
                  </td>
                  <td>
                    <button
                      type="button"
                      className={styles.open}
                      onClick={() => setSelected(r)}
                      aria-label={`Open distance details for ${r.name}, ${date(r.date)}`}
                    >
                      <MapPinned size={17} />
                      Details
                    </button>
                  </td>
                </tr>
              ))}
              {!shown.length ? (
                <tr>
                  <td colSpan={8}>
                    <div className={styles.empty}>
                      <MapPinned size={28} />
                      <strong>No associate-days match these filters</strong>
                      <span>
                        Try another date, station or status. Only
                        kilometre-based fuel mappings are included.
                      </span>
                    </div>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>}
        <footer className={styles.pagination}>
          <span>
            {count
              ? `${safePage * 50 + 1}–${Math.min((safePage + 1) * 50, count)} of ${count} ${associate ? "station-days" : "associates"}`
              : "0 records"}
          </span>
          <div>
            <button
              type="button"
              aria-label="Previous page"
              disabled={safePage === 0}
              onClick={() => setPage(safePage - 1)}
            >
              <ChevronLeft size={18} />
            </button>
            <button
              type="button"
              aria-label="Next page"
              disabled={(safePage + 1) * 50 >= count}
              onClick={() => setPage(safePage + 1)}
            >
              <ChevronRight size={18} />
            </button>
          </div>
        </footer>
      </section>
      {selected ? (
        <DistanceDetail row={selected} close={() => setSelected(null)} />
      ) : null}
    </>
  );
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
              {row.km === null ? "Pending" : `${number(row.km)} km`}
            </strong>
          </div>
          <div>
            <span>Mapped rate</span>
            <strong>₹{number(row.rate)} / km</strong>
          </div>
          <div>
            <span>Fuel allowance</span>
            <strong>
              {row.fuel === null ? "Pending" : `₹${number(row.fuel)}`}
            </strong>
          </div>
        </div>
        {row.status === "pending" ? (
          <p className={styles.notice}>{reason(row)}</p>
        ) : (
          <p className={styles.detailMeta}>
            {distanceMethods[row.method] || row.method} · {row.scans} scans
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
