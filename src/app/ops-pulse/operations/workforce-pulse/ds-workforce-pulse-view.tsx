"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, Download, RefreshCw } from "lucide-react";
import type { DsWorkforcePulsePayload, DsWorkforcePulseStore } from "@/lib/ops-pulse/ds-workforce-pulse";
import s from "../site-summary/ds-ops.module.css";

function count(n: number) {
  return n.toLocaleString("en-IN");
}

function csvEscape(value: string | number | null | undefined) {
  const raw = value == null ? "" : String(value);
  if (/[",\n]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
  return raw;
}

function exportHcCsv(stores: DsWorkforcePulseStore[], businessDate: string) {
  const lines = ["station,hour,order_count,required_hc,rostered_hc,variance"];
  for (const store of stores) {
    for (const row of store.hourlyPlan) {
      lines.push([
        csvEscape(store.stationCode),
        row.hour,
        row.orderCount,
        row.requiredHc,
        row.rosteredHc ?? "",
        row.variance ?? ""
      ].join(","));
    }
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ds-hc-plan-${businessDate}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function DsWorkforcePulseView({ initial }: { initial: DsWorkforcePulsePayload }) {
  const router = useRouter();
  const [payload] = useState(initial);
  const [selected, setSelected] = useState(payload.stores[0]?.stationCode ?? "");
  const selectedStore = useMemo(
    () => payload.stores.find((s) => s.stationCode === selected) ?? payload.stores[0] ?? null,
    [payload.stores, selected]
  );

  return (
    <div className={s.report}>
      <div className={s.toolbar}>
        <div className={s.title}>
          <h2>Workforce Pulse</h2>
          <p>
            {payload.businessDate}
            <span aria-hidden>·</span>
            {payload.spikeCount} spike{payload.spikeCount === 1 ? "" : "s"}
            <span aria-hidden>·</span>
            {payload.understaffedCount} understaffed
          </p>
        </div>
        <div className={s.actions}>
          <label className={s.label} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            Date
            <input
              type="date"
              defaultValue={payload.businessDate}
              onChange={(e) => {
                const date = e.target.value;
                router.push(`/operations/workforce-pulse?date=${encodeURIComponent(date)}`);
              }}
              style={{ height: 36, borderRadius: 10, border: "1px solid var(--line)", padding: "0 10px", font: "inherit" }}
            />
          </label>
          <button type="button" className={s.primary} onClick={() => router.refresh()}>
            <RefreshCw size={14} aria-hidden /> Refresh
          </button>
          <button
            type="button"
            className={s.primary}
            onClick={() => exportHcCsv(payload.stores, payload.businessDate)}
            disabled={!payload.stores.length}
          >
            <Download size={14} aria-hidden /> Export HC plan
          </button>
        </div>
      </div>

      <section className={s.summary} aria-label="Network" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
        <div className={s.metric}><header>Stores</header><strong>{count(payload.stores.length)}</strong></div>
        <div className={s.metric}><header>Spiking</header><strong>{count(payload.spikeCount)}</strong></div>
        <div className={s.metric}><header>Understaffed</header><strong>{count(payload.understaffedCount)}</strong></div>
        <div className={s.hero}>
          <header className={s.label}>Peak required HC (network)</header>
          <div className={s.heroFigure}>
            <strong>{count(payload.stores.reduce((m, r) => Math.max(m, r.planSummary.peakRequired), 0))}</strong>
          </div>
        </div>
      </section>

      <section className={s.panel}>
        <div className={s.panelHead}>
          <h3>Store board</h3>
          <span>Roster · live productive · demand · spike</span>
        </div>
        {payload.stores.length ? (
          <div style={{ overflowX: "auto" }}>
            <table className={s.board}>
              <thead>
                <tr>
                  <th>Store</th>
                  <th>Rostered</th>
                  <th>Due / reported</th>
                  <th>Productive</th>
                  <th>Waiting / break</th>
                  <th>Active orders</th>
                  <th>Orders / productive</th>
                  <th>Spike</th>
                  <th>Staffing</th>
                </tr>
              </thead>
              <tbody>
                {payload.stores.map((row) => (
                  <tr
                    key={row.stationCode}
                    onClick={() => setSelected(row.stationCode)}
                    style={{ cursor: "pointer", background: selected === row.stationCode ? "rgba(37,99,235,.06)" : undefined }}
                  >
                    <td>
                      <strong>{row.stationCode}</strong>
                      <div className="subtle">{row.stationName}</div>
                    </td>
                    <td>{count(row.rosteredHc)}</td>
                    <td>{count(row.reportedHc)} / {count(row.dueHc)}</td>
                    <td>{count(row.productiveHc)}</td>
                    <td>{count(row.waitingHc)} / {count(row.onBreakHc)}</td>
                    <td>
                      {count(row.activeOrders)}
                      {row.pendingAcceptance > 0 ? (
                        <span className={`${s.badge} ${s.badgeBad}`} style={{ marginLeft: 6 }}>
                          {row.pendingAcceptance} pending
                        </span>
                      ) : null}
                    </td>
                    <td>{row.ordersPerProductive == null ? "—" : row.ordersPerProductive}</td>
                    <td>
                      {row.spike?.spiked ? (
                        <span className={`${s.badge} ${s.badgeBad}`} title={row.spike.reason}>Spike</span>
                      ) : (
                        <span className={s.badge} title={row.spike?.reason}>{row.spike?.liftPct == null ? "—" : `${row.spike.liftPct}%`}</span>
                      )}
                    </td>
                    <td>
                      {row.understaffed ? (
                        <span className={`${s.badge} ${s.badgeBad}`}>
                          <AlertTriangle size={12} aria-hidden /> Under
                        </span>
                      ) : (
                        <span className={`${s.badge} ${s.badgeGood}`}>OK</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className={s.empty}>No NOW stores in scope.</p>
        )}
      </section>

      {selectedStore ? (
        <section className={s.panel}>
          <div className={s.panelHead}>
            <h3>{selectedStore.stationCode} · hourly HC plan</h3>
            <span>
              Target {selectedStore.targetOrdersPerAssociateHour} orders / associate-hour
              <span aria-hidden> · </span>
              <Link className={s.link} href={`/rostering?station=${encodeURIComponent(selectedStore.stationCode)}`}>
                Open rostering
              </Link>
            </span>
          </div>
          {selectedStore.hourlyPlan.length ? (
            <div style={{ overflowX: "auto" }}>
              <table className={s.board}>
                <thead>
                  <tr>
                    <th>Hour IST</th>
                    <th>Orders</th>
                    <th>Required HC</th>
                    <th>Rostered HC</th>
                    <th>Variance</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedStore.hourlyPlan.map((row) => (
                    <tr key={row.hour}>
                      <td>{String(row.hour).padStart(2, "0")}:00</td>
                      <td>{count(row.orderCount)}</td>
                      <td>{count(row.requiredHc)}</td>
                      <td>{row.rosteredHc == null ? "—" : count(row.rosteredHc)}</td>
                      <td>
                        {row.variance == null ? "—" : (
                          <span className={`${s.badge} ${row.variance < 0 ? s.badgeBad : s.badgeGood}`}>
                            {row.variance > 0 ? `+${row.variance}` : row.variance}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className={s.empty}>No PPI hourly demand for this date yet.</p>
          )}
        </section>
      ) : null}
    </div>
  );
}
