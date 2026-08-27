"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import type { EddPerformancePackage } from "@/lib/ops-pulse/edd-worker";
import { deliverySeverity } from "../edd-performance-severity";

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;

type DriverSummary = {
  driverKey: string;
  driverName: string;
  isAccessPoint: boolean;
  packages: EddPerformancePackage[];
  assigned: number;
  delivered: number;
  returned: number;
  held: number;
  deliveredPct: number;
};

const BUCKET_LABEL: Record<EddPerformancePackage["bucket"], string> = {
  delivered: "Delivered",
  returned: "Returned",
  held: "Held"
};

/**
 * Driver-wise ("By associate") breakdown for today — built entirely
 * client-side from the snapshot's own packages array (only ever populated
 * for today, see the worker's EddPerformanceDailyStore), no extra fetch.
 * Mirrors CIA's CiaDriverView expand/collapse pattern.
 *
 * Packages with no driverId AND no driverName (locker/self-service
 * deliveries, or a package Amazon never attributed to a driver) are pulled
 * out into their own summary line rather than sorted into the driver list
 * as an "Unassigned" row — they aren't a driver, so ranking them alongside
 * real associates by delivery performance is misleading.
 */
export function EddPerformanceByAssociate({ packages }: { packages: EddPerformancePackage[] }) {
  const [query, setQuery] = useState("");
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZE_OPTIONS[1]);

  const { drivers, unassigned } = useMemo(() => {
    const byDriver = new Map<string, { driverKey: string; driverName: string; isAccessPoint: boolean; packages: EddPerformancePackage[] }>();
    const unassignedPackages: EddPerformancePackage[] = [];
    for (const pkg of packages) {
      const key = pkg.driverId || pkg.driverName || "";
      if (!key) {
        unassignedPackages.push(pkg);
        continue;
      }
      // A name means it resolved (against the station's live driver directory,
      // then the workforce roster) — a driverId with no name is a driver
      // neither source recognized (usually since offboarded), so label it as
      // an ID rather than presenting the raw ID as if it were a name. Store /
      // locker deliveries (isAccessPoint) always resolve — the worker parses
      // the store name straight off Amazon's own accessPointId field.
      const name = pkg.driverName || (pkg.driverId ? `Driver ${pkg.driverId} (name unavailable)` : "Unknown");
      const entry = byDriver.get(key) ?? { driverKey: key, driverName: name, isAccessPoint: pkg.isAccessPoint, packages: [] };
      entry.packages.push(pkg);
      byDriver.set(key, entry);
    }
    const summarize = (entry: { driverKey: string; driverName: string; isAccessPoint: boolean; packages: EddPerformancePackage[] }): DriverSummary => {
      const assigned = entry.packages.length;
      const delivered = entry.packages.filter((p) => p.bucket === "delivered").length;
      const returned = entry.packages.filter((p) => p.bucket === "returned").length;
      const held = Math.max(0, assigned - delivered - returned);
      const deliveredPct = assigned > 0 ? Math.round((delivered / assigned) * 1000) / 10 : 0;
      return { ...entry, assigned, delivered, returned, held, deliveredPct };
    };
    return {
      drivers: [...byDriver.values()].map(summarize),
      unassigned: unassignedPackages.length ? summarize({ driverKey: "__unassigned__", driverName: "No driver on record", isAccessPoint: false, packages: unassignedPackages }) : null
    };
  }, [packages]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = q ? drivers.filter((d) => d.driverName.toLowerCase().includes(q)) : drivers;
    return [...rows].sort((a, b) => b.assigned - a.assigned);
  }, [drivers, query]);

  const storeCount = filtered.filter((d) => d.isAccessPoint).length;
  const associateCount = filtered.length - storeCount;
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageRows = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  function renderDriverCard(driver: DriverSummary, options?: { muted?: boolean }) {
    const open = openKey === driver.driverKey;
    const severity = driver.assigned > 0 ? deliverySeverity(driver.deliveredPct) : null;
    return (
      <article key={driver.driverKey} className={`edd-driver-card${open ? " open" : ""}${options?.muted ? " muted" : ""}`}>
        <button type="button" className="edd-driver-toggle" onClick={() => setOpenKey(open ? null : driver.driverKey)} aria-expanded={open}>
          <span className="edd-driver-main">
            {open ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
            <span>
              <strong>{driver.driverName}</strong>{driver.isAccessPoint ? <span className="edd-pill dueTomorrow" style={{ marginLeft: 8 }}>Store</span> : null}
              <small>{driver.assigned} package{driver.assigned === 1 ? "" : "s"} assigned today</small>
            </span>
          </span>
          <span className="edd-driver-meta">
            {options?.muted ? <span className="subtle">—</span> : severity ? <span className={`edd-severity ${severity}`}>{driver.deliveredPct}%</span> : <span className="subtle">—</span>}
            <small>{driver.delivered} delivered · {driver.held} held · {driver.returned} returned</small>
          </span>
        </button>

        {open ? (
          <div className="edd-driver-body">
            <div className="edd-table-wrap">
              <table className="edd-table compact">
                <thead>
                  <tr>
                    <th>Tracking ID</th>
                    <th>State</th>
                    <th>Payment</th>
                    <th>City</th>
                    <th>Order ID</th>
                  </tr>
                </thead>
                <tbody>
                  {driver.packages.map((pkg) => (
                    <tr key={pkg.trackingId}>
                      <td>{pkg.trackingId}</td>
                      <td><span className={`edd-pill ${pkg.bucket === "delivered" ? "future" : pkg.bucket === "returned" ? "overdue" : "dueToday"}`}>{BUCKET_LABEL[pkg.bucket]}{pkg.state ? ` · ${pkg.state}` : ""}</span></td>
                      <td>{pkg.paymentMethod || "—"}</td>
                      <td>{pkg.city || "—"}</td>
                      <td>{pkg.orderingOrderId || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </article>
    );
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h3>By associate</h3>
          <p className="subtle">Every driver (and locker/store access point) assigned packages today, worst delivery performance first. Open one for its tracking IDs.</p>
        </div>
        <span className="count-badge">{associateCount} associates{storeCount ? ` · ${storeCount} stores` : ""}</span>
      </div>
      <div className="panel-body">
        <div className="edd-toolbar">
          <div style={{ position: "relative" }}>
            <Search size={15} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--muted)" }} />
            <input
              type="search"
              placeholder="Search by driver name…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
              }}
              style={{ paddingLeft: 30, minWidth: 240 }}
            />
          </div>
          <label className="subtle" style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6 }}>
            Show
            <select
              className="field"
              value={pageSize}
              onChange={(event) => {
                setPageSize(Number(event.target.value));
                setPage(1);
              }}
              style={{ width: "auto" }}
            >
              {PAGE_SIZE_OPTIONS.map((size) => (
                <option key={size} value={size}>{size}</option>
              ))}
            </select>
            per page
          </label>
        </div>

        {unassigned ? (
          <p className="subtle" style={{ marginBottom: 12 }}>
            <strong>{unassigned.assigned.toLocaleString("en-IN")}</strong> package{unassigned.assigned === 1 ? "" : "s"} today have neither a driver nor a store/locker on record yet (often still inducted, not yet handed off) — not counted as an associate below.
          </p>
        ) : null}

        <div className="edd-driver-list">
          {pageRows.length === 0 ? (
            <p className="subtle">No associates have packages assigned today.</p>
          ) : pageRows.map((driver) => renderDriverCard(driver))}
        </div>

        {unassigned ? renderDriverCard(unassigned, { muted: true }) : null}

        {totalPages > 1 ? (
          <div className="edd-pagination">
            <span className="subtle">{filtered.length.toLocaleString("en-IN")} associates</span>
            <div className="edd-pagination-pages">
              <button type="button" className="button secondary" disabled={safePage <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Previous</button>
              <span className="subtle">Page {safePage} of {totalPages}</span>
              <button type="button" className="button secondary" disabled={safePage >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>Next</button>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
