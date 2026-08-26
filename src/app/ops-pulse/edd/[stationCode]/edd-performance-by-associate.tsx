"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import type { EddPerformancePackage } from "@/lib/ops-pulse/edd-worker";
import { deliverySeverity } from "../edd-performance-severity";

const PAGE_SIZE = 12;

type DriverSummary = {
  driverKey: string;
  driverName: string;
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
 */
export function EddPerformanceByAssociate({ packages }: { packages: EddPerformancePackage[] }) {
  const [query, setQuery] = useState("");
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const drivers = useMemo<DriverSummary[]>(() => {
    const byDriver = new Map<string, { driverKey: string; driverName: string; packages: EddPerformancePackage[] }>();
    for (const pkg of packages) {
      const key = pkg.driverId || pkg.driverName || "unassigned";
      const name = pkg.driverName || pkg.driverId || "Unassigned";
      const entry = byDriver.get(key) ?? { driverKey: key, driverName: name, packages: [] };
      entry.packages.push(pkg);
      byDriver.set(key, entry);
    }
    return [...byDriver.values()].map((entry) => {
      const assigned = entry.packages.length;
      const delivered = entry.packages.filter((p) => p.bucket === "delivered").length;
      const returned = entry.packages.filter((p) => p.bucket === "returned").length;
      const held = Math.max(0, assigned - delivered - returned);
      const deliveredPct = assigned > 0 ? Math.round((delivered / assigned) * 1000) / 10 : 0;
      return { ...entry, assigned, delivered, returned, held, deliveredPct };
    });
  }, [packages]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = q ? drivers.filter((d) => d.driverName.toLowerCase().includes(q)) : drivers;
    return [...rows].sort((a, b) => b.assigned - a.assigned);
  }, [drivers, query]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h3>By associate</h3>
          <p className="subtle">Every driver assigned packages today, worst delivery performance first. Open a driver for their tracking IDs.</p>
        </div>
        <span className="count-badge">{filtered.length} associates</span>
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
        </div>

        <div className="edd-driver-list">
          {pageRows.length === 0 ? (
            <p className="subtle">No associates have packages assigned today.</p>
          ) : pageRows.map((driver) => {
            const open = openKey === driver.driverKey;
            const severity = driver.assigned > 0 ? deliverySeverity(driver.deliveredPct) : null;
            return (
              <article key={driver.driverKey} className={`edd-driver-card${open ? " open" : ""}`}>
                <button type="button" className="edd-driver-toggle" onClick={() => setOpenKey(open ? null : driver.driverKey)} aria-expanded={open}>
                  <span className="edd-driver-main">
                    {open ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                    <span>
                      <strong>{driver.driverName}</strong>
                      <small>{driver.assigned} package{driver.assigned === 1 ? "" : "s"} assigned today</small>
                    </span>
                  </span>
                  <span className="edd-driver-meta">
                    {severity ? <span className={`edd-severity ${severity}`}>{driver.deliveredPct}%</span> : <span className="subtle">—</span>}
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
          })}
        </div>

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
