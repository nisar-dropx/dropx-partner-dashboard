"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, Download, RefreshCw, Users, TrendingUp, Zap, BarChart3, ChevronRight, MapPin } from "lucide-react";
import type { DsWorkforcePulsePayload, DsWorkforcePulseStore } from "@/lib/ops-pulse/ds-workforce-pulse";
import s from "../site-summary/ds-ops.module.css";
import ps from "./pulse.module.css";

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

  const networkPeakHc = payload.stores.reduce((m, r) => Math.max(m, r.planSummary.peakRequired), 0);
  const networkRostered = payload.stores.reduce((acc, r) => acc + r.rosteredHc, 0);
  const networkProductive = payload.stores.reduce((acc, r) => acc + r.productiveHc, 0);

  return (
    <div className={s.report}>
      {/* ── Toolbar ── */}
      <div className={s.toolbar}>
        <div className={s.title}>
          <h2>Workforce Pulse</h2>
          <p>
            <i className={ps.liveDot} aria-hidden />
            {payload.businessDate}
            <span aria-hidden>·</span>
            {payload.stores.length} stores
          </p>
        </div>
        <div className={s.actions}>
          <label className={s.label} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            Date
            <input
              type="date"
              defaultValue={payload.businessDate}
              onChange={(e) => router.push(`/operations/workforce-pulse?date=${encodeURIComponent(e.target.value)}`)}
              style={{ height: 36, borderRadius: 10, border: "1px solid var(--line)", padding: "0 10px", font: "inherit" }}
            />
          </label>
          <button type="button" className={s.primary} onClick={() => router.refresh()}>
            <RefreshCw size={14} aria-hidden /> Refresh
          </button>
          <button type="button" className={s.primary} onClick={() => exportHcCsv(payload.stores, payload.businessDate)} disabled={!payload.stores.length}>
            <Download size={14} aria-hidden /> Export HC plan
          </button>
        </div>
      </div>

      {/* ── KPI stat cards ── */}
      <div className={ps.kpiGrid}>
        <div className={ps.kpiCard}>
          <div className={ps.kpiIcon} style={{ background: "#eff6ff", color: "#2563eb" }}><Users size={18} aria-hidden /></div>
          <div className={ps.kpiBody}>
            <span className={ps.kpiLabel}>Total stores</span>
            <strong className={ps.kpiValue}>{count(payload.stores.length)}</strong>
          </div>
        </div>
        <div className={`${ps.kpiCard} ${payload.spikeCount > 0 ? ps.kpiWarn : ""}`}>
          <div className={ps.kpiIcon} style={{ background: payload.spikeCount > 0 ? "#fff9e6" : "#f0fdf4", color: payload.spikeCount > 0 ? "#d97706" : "#087443" }}>
            <TrendingUp size={18} aria-hidden />
          </div>
          <div className={ps.kpiBody}>
            <span className={ps.kpiLabel}>Spiking</span>
            <strong className={ps.kpiValue} style={{ color: payload.spikeCount > 0 ? "#d97706" : undefined }}>{count(payload.spikeCount)}</strong>
            <span className={ps.kpiSub}>stores above baseline</span>
          </div>
        </div>
        <div className={`${ps.kpiCard} ${payload.understaffedCount > 0 ? ps.kpiDanger : ""}`}>
          <div className={ps.kpiIcon} style={{ background: payload.understaffedCount > 0 ? "#fff1f0" : "#f0fdf4", color: payload.understaffedCount > 0 ? "#c0392b" : "#087443" }}>
            <AlertTriangle size={18} aria-hidden />
          </div>
          <div className={ps.kpiBody}>
            <span className={ps.kpiLabel}>Understaffed</span>
            <strong className={ps.kpiValue} style={{ color: payload.understaffedCount > 0 ? "#c0392b" : undefined }}>{count(payload.understaffedCount)}</strong>
            <span className={ps.kpiSub}>stores need attention</span>
          </div>
        </div>
        <div className={ps.kpiCard}>
          <div className={ps.kpiIcon} style={{ background: "#fff7f2", color: "#de5a16" }}><BarChart3 size={18} aria-hidden /></div>
          <div className={ps.kpiBody}>
            <span className={ps.kpiLabel}>Network rostered</span>
            <strong className={ps.kpiValue} style={{ color: "#de5a16" }}>{count(networkRostered)}</strong>
            <span className={ps.kpiSub}>{count(networkProductive)} productive now</span>
          </div>
        </div>
        <div className={`${ps.kpiCard} ${ps.kpiHero}`}>
          <div className={ps.kpiIcon} style={{ background: "#fff7f2", color: "#de5a16" }}><Zap size={18} aria-hidden /></div>
          <div className={ps.kpiBody}>
            <span className={ps.kpiLabel}>Peak required HC</span>
            <strong className={ps.kpiValue} style={{ fontSize: 32, color: "#de5a16" }}>{count(networkPeakHc)}</strong>
            <span className={ps.kpiSub}>across network today</span>
          </div>
        </div>
      </div>

      {/* ── Store board ── */}
      <section className={s.panel}>
        <div className={s.panelHead}>
          <h3>Store board</h3>
          <span>Click a row to see the hourly HC plan · Roster · live productive · demand · spike</span>
        </div>
        {payload.stores.length ? (
          <div style={{ overflowX: "auto" }}>
            <table className={s.board}>
              <thead>
                <tr>
                  <th>Store</th>
                  <th>Rostered</th>
                  <th>Due / Reported</th>
                  <th>Productive</th>
                  <th>Waiting / Break</th>
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
                    aria-selected={selected === row.stationCode}
                    style={{ cursor: "pointer" }}
                  >
                    <td>
                      <div className={s.storeCell}>
                        <strong>{row.stationCode}</strong>
                        <small>{row.stationName}</small>
                      </div>
                    </td>
                    <td>{count(row.rosteredHc)}</td>
                    <td>{count(row.reportedHc)} / {count(row.dueHc)}</td>
                    <td>
                      <span style={{ fontWeight: 700, color: row.productiveHc > 0 ? "#087443" : undefined }}>{count(row.productiveHc)}</span>
                    </td>
                    <td>{count(row.waitingHc)} / {count(row.onBreakHc)}</td>
                    <td>
                      <span style={{ fontWeight: 650 }}>{count(row.activeOrders)}</span>
                      {row.pendingAcceptance > 0 ? (
                        <span className={`${s.badge} ${s.badgeBad}`} style={{ marginLeft: 6 }}>
                          {row.pendingAcceptance} pending
                        </span>
                      ) : null}
                    </td>
                    <td>{row.ordersPerProductive == null ? "—" : row.ordersPerProductive}</td>
                    <td>
                      {row.spike?.spiked ? (
                        <span className={`${s.badge} ${s.badgeBad}`} title={row.spike.reason}><TrendingUp size={11} aria-hidden /> Spike</span>
                      ) : (
                        <span className={s.badge} title={row.spike?.reason}>{row.spike?.liftPct == null ? "—" : `${row.spike.liftPct}%`}</span>
                      )}
                    </td>
                    <td>
                      {row.understaffed ? (
                        <span className={`${s.badge} ${s.badgeBad}`}><AlertTriangle size={11} aria-hidden /> Under</span>
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
          <p className={s.empty}><MapPin size={28} style={{ opacity: 0.3 }} /><span>No NOW stores in scope for this date.</span></p>
        )}
      </section>

      {/* ── Hourly HC plan for selected store ── */}
      {selectedStore ? (
        <section className={s.panel}>
          <div className={s.panelHead}>
            <h3>
              <MapPin size={14} style={{ verticalAlign: "middle", marginRight: 4, opacity: 0.6 }} aria-hidden />
              {selectedStore.stationCode} · Hourly HC plan
            </h3>
            <span style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                <span style={{ width: 10, height: 10, borderRadius: 2, background: "#de5a16", display: "inline-block" }} />
                <span style={{ fontSize: 11 }}>Required HC</span>
              </span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                <span style={{ width: 10, height: 10, borderRadius: 2, background: "rgba(37,99,235,0.2)", border: "1.5px solid rgba(37,99,235,0.3)", display: "inline-block" }} />
                <span style={{ fontSize: 11 }}>Rostered</span>
              </span>
              <span style={{ color: "var(--muted)" }}>Target {selectedStore.targetOrdersPerAssociateHour} orders / assoc-hr</span>
              <Link className={s.link} href={`/rostering?station=${encodeURIComponent(selectedStore.stationCode)}`} style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                Open rostering <ChevronRight size={12} aria-hidden />
              </Link>
            </span>
          </div>

          {/* Bar chart */}
          {selectedStore.hourlyPlan.length ? (
            <>
              <div className={ps.hcChart} aria-hidden>
                {(() => {
                  const maxVal = Math.max(...selectedStore.hourlyPlan.map(r => Math.max(r.requiredHc, r.rosteredHc ?? 0)), 1);
                  return selectedStore.hourlyPlan.map((row) => {
                    const reqPct = Math.round((row.requiredHc / maxVal) * 90);
                    const rosPct = row.rosteredHc != null ? Math.round((row.rosteredHc / maxVal) * 90) : null;
                    const understaffed = row.variance != null && row.variance < 0;
                    return (
                      <div key={row.hour} className={ps.hcBar} title={`${String(row.hour).padStart(2, "0")}:00 · Req: ${row.requiredHc} · Ros: ${row.rosteredHc ?? "—"}`}>
                        <div className={ps.hcBarInner}>
                          {rosPct != null && (
                            <span className={ps.hcRostered} style={{ height: `${rosPct}px` }} />
                          )}
                          <span
                            className={ps.hcRequired}
                            style={{ height: `${reqPct}px`, background: understaffed ? "#c0392b" : "#de5a16" }}
                          />
                        </div>
                        <small>{String(row.hour).padStart(2, "0")}</small>
                      </div>
                    );
                  });
                })()}
              </div>

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
                        <td style={{ fontWeight: 650 }}>{String(row.hour).padStart(2, "0")}:00</td>
                        <td>{count(row.orderCount)}</td>
                        <td><span style={{ fontWeight: 700 }}>{count(row.requiredHc)}</span></td>
                        <td>{row.rosteredHc == null ? <span style={{ color: "var(--muted)" }}>—</span> : count(row.rosteredHc)}</td>
                        <td>
                          {row.variance == null ? <span style={{ color: "var(--muted)" }}>—</span> : (
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
            </>
          ) : (
            <p className={s.empty}><BarChart3 size={28} style={{ opacity: 0.3 }} /><span>No PPI hourly demand for this date yet.</span></p>
          )}
        </section>
      ) : null}
    </div>
  );
}
