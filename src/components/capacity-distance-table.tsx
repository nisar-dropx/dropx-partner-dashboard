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
  const shown = filtered.slice(page * 50, page * 50 + 50),
    ready = filtered.filter((r) => r.status === "ready"),
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
          <strong>{filtered.length - ready.length}</strong>
          <p>Pending or needs attention</p>
        </article>
        <article>
          <span>Associates</span>
          <strong>{new Set(filtered.map((r) => r.workforceId)).size}</strong>
          <p>
            {new Set(filtered.map((r) => r.station)).size} stations in this
            selection
          </p>
        </article>
      </div>
      <section className={styles.panel}>
        <header className={styles.tableHead}>
          <div>
            <h2>Daily distance register</h2>
            <span>{filtered.length} associate-days</span>
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
            {sort === "date" ? "Latest first" : "Highest km first"}
          </button>
        </header>
        <div className={styles.tableWrap}>
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
        </div>
        <footer className={styles.pagination}>
          <span>
            {filtered.length
              ? `${page * 50 + 1}–${Math.min((page + 1) * 50, filtered.length)} of ${filtered.length}`
              : "0 records"}
          </span>
          <div>
            <button
              type="button"
              aria-label="Previous page"
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
            >
              <ChevronLeft size={18} />
            </button>
            <button
              type="button"
              aria-label="Next page"
              disabled={(page + 1) * 50 >= filtered.length}
              onClick={() => setPage((p) => p + 1)}
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
