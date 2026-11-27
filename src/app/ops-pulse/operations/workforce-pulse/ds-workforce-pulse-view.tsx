"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, Download, RefreshCw, Users, TrendingUp, Zap, Activity, ChevronRight, MapPin } from "lucide-react";
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

function StaffingBar({ rostered, required }: { rostered: number; required: number }) {
  if (required === 0) return <span className={ps.staffBarEmpty}>—</span>;
  const pct = Math.min(100, Math.round((rostered / required) * 100));
  const over = pct >= 100;
  const warn = pct < 70;
  return (
    <div className={ps.staffBarWrap} title={`${rostered} rostered / ${required} required (${pct}%)`}>
      <div
        className={`${ps.staffBarFill} ${warn ? ps.staffBarWarn : over ? ps.staffBarOver : ps.staffBarOk}`}
        style={{ width: `${pct}%` }}
      />
      <span className={ps.staffBarLabel}>{pct}%</span>
    </div>
  );
}

export function DsWorkforcePulseView({ initial }: { initial: DsWorkforcePulsePayload }) {
  const router = useRouter();
  const [payload] = useState(initial);
  const [selected, setSelected] = useState(payload.stores[0]?.stationCode ?? "");
  const selectedStore = useMemo(
    () => payload.stores.find((st) => st.stationCode === selected) ?? payload.stores[0] ?? null,
    [payload.stores, selected]
  );

  const networkPeakHc = payload.stores.reduce((m, r) => Math.max(m, r.planSummary.peakRequired), 0);
  const networkRostered = payload.stores.reduce((acc, r) => acc + r.rosteredHc, 0);
  const networkProductive = payload.stores.reduce((acc, r) => acc + r.productiveHc, 0);
  const networkRequired = payload.stores.reduce((acc, r) => acc + (r.planSummary.peakRequired ?? 0), 0);

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

      {/* ── KPI banner (Amazon-style flat cells) ── */}
      <div className={ps.kpiBanner}>
        <div className={ps.kpiCell}>
          <div className={ps.kpiIconWrap} style={{ background: "#eff6ff", color: "#2563eb" }}><Users size={16} aria-hidden /></div>
          <div className={ps.kpiBody}>
            <span className={ps.kpiLabel}>Total stores</span>
            <strong className={ps.kpiValue}>{count(payload.stores.length)}</strong>
          </div>
        </div>
        <div className={`${ps.kpiCell} ${payload.spikeCount > 0 ? ps.kpiCellWarn : ""}`}>
          <div className={ps.kpiIconWrap} style={{ background: payload.spikeCount > 0 ? "#fff9e6" : "#f0fdf4", color: payload.spikeCount > 0 ? "#d97706" : "#087443" }}>
            <TrendingUp size={16} aria-hidden />
          </div>
          <div className={ps.kpiBody}>
            <span className={ps.kpiLabel}>Spiking stores</span>
            <strong className={ps.kpiValue} style={{ color: payload.spikeCount > 0 ? "#d97706" : undefined }}>{count(payload.spikeCount)}</strong>
            <span className={ps.kpiSub}>above baseline</span>
          </div>
        </div>
        <div className={`${ps.kpiCell} ${payload.understaffedCount > 0 ? ps.kpiCellDanger : ""}`}>
          <div className={ps.kpiIconWrap} style={{ background: payload.understaffedCount > 0 ? "#fff1f0" : "#f0fdf4", color: payload.understaffedCount > 0 ? "#c0392b" : "#087443" }}>
            <AlertTriangle size={16} aria-hidden />
          </div>
          <div className={ps.kpiBody}>
            <span className={ps.kpiLabel}>Understaffed</span>
            <strong className={ps.kpiValue} style={{ color: payload.understaffedCount > 0 ? "#c0392b" : undefined }}>{count(payload.understaffedCount)}</strong>
            <span className={ps.kpiSub}>stores need attention</span>
          </div>
        </div>
        <div className={ps.kpiCell}>
          <div className={ps.kpiIconWrap} style={{ background: "#f0fdf4", color: "#087443" }}><Activity size={16} aria-hidden /></div>
          <div className={ps.kpiBody}>
            <span className={ps.kpiLabel}>Network rostered</span>
            <strong className={ps.kpiValue} style={{ color: "#087443" }}>{count(networkRostered)}</strong>
            <span className={ps.kpiSub}>{count(networkProductive)} productive now</span>
          </div>
        </div>
        <div className={`${ps.kpiCell} ${ps.kpiCellHero}`}>
          <div className={ps.kpiIconWrap} style={{ background: "#fff7f2", color: "#de5a16" }}><Zap size={16} aria-hidden /></div>
          <div className={ps.kpiBody}>
            <span className={ps.kpiLabel}>Peak required HC</span>
            <strong className={ps.kpiValue} style={{ color: "#de5a16", fontSize: 28 }}>{count(networkPeakHc)}</strong>
            <span className={ps.kpiSub}>across network today</span>
          </div>
        </div>
        <div className={ps.kpiCell}>
          <div className={ps.kpiIconWrap} style={{ background: "#f5f3ff", color: "#7c3aed" }}><Users size={16} aria-hidden /></div>
          <div className={ps.kpiBody}>
            <span className={ps.kpiLabel}>Network staffing</span>
            <strong className={ps.kpiValue} style={{ color: "#7c3aed" }}>
              {networkRequired > 0 ? `${Math.round((networkRostered / networkRequired) * 100)}%` : "—"}
            </strong>
            <span className={ps.kpiSub}>rostered vs required</span>
          </div>
        </div>
      </div>

      {/* ── Store board ── */}
      <section className={ps.tableCard}>
        <div className={ps.tableCardHead}>
          <div>
            <h3>Store board</h3>
            <p>Select a row to view the hourly HC plan for that store</p>
          </div>
        </div>
        {payload.stores.length ? (
          <div style={{ overflowX: "auto" }}>
            <table className={ps.storeTable}>
              <thead>
                <tr>
                  <th>Store</th>
                  <th>Rostered</th>
                  <th>Productive</th>
                  <th>Waiting / Break</th>
                  <th>Active orders</th>
                  <th>Staffing</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {payload.stores.map((row, i) => {
                  const peakReq = row.planSummary.peakRequired;
                  return (
                    <tr
                      key={row.stationCode}
                      onClick={() => setSelected(row.stationCode)}
                      aria-selected={selected === row.stationCode}
                      className={i % 2 === 1 ? ps.rowAlt : ""}
                    >
                      <td>
                        <div className={ps.storeCell}>
                          <strong className={ps.storeCode}>{row.stationCode}</strong>
                          <span className={ps.storeName}>{row.stationName}</span>
                        </div>
                      </td>
                      <td className={ps.tdNum}>{count(row.rosteredHc)}</td>
                      <td className={ps.tdNum}>
                        <span style={{ fontWeight: 700, color: row.productiveHc > 0 ? "#087443" : "var(--muted)" }}>
                          {count(row.productiveHc)}
                        </span>
                      </td>
                      <td className={ps.tdNum}>
                        {count(row.waitingHc)} / {count(row.onBreakHc)}
                      </td>
                      <td className={ps.tdNum}>
                        <span style={{ fontWeight: 650 }}>{count(row.activeOrders)}</span>
                        {row.pendingAcceptance > 0 ? (
                          <span className={ps.pillBad} style={{ marginLeft: 6 }}>{row.pendingAcceptance} pending</span>
                        ) : null}
                      </td>
                      <td style={{ minWidth: 130 }}>
                        <StaffingBar rostered={row.rosteredHc} required={peakReq} />
                      </td>
                      <td>
                        <div className={ps.statusPills}>
                          {row.understaffed ? (
                            <span className={ps.pillBad}><AlertTriangle size={10} aria-hidden /> Understaffed</span>
                          ) : (
                            <span className={ps.pillGood}>Staffed OK</span>
                          )}
                          {row.spike?.spiked ? (
                            <span className={ps.pillWarn} title={row.spike.reason}><TrendingUp size={10} aria-hidden /> Spike</span>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className={ps.emptyState}>
            <MapPin size={28} style={{ opacity: 0.25 }} aria-hidden />
            <span>No NOW stores in scope for this date.</span>
          </div>
        )}
      </section>

      {/* ── Hourly HC plan for selected store (table only, no chart) ── */}
      {selectedStore ? (
        <section className={ps.tableCard}>
          <div className={ps.tableCardHead}>
            <div>
              <h3>
                <MapPin size={14} style={{ verticalAlign: "middle", marginRight: 4, opacity: 0.55 }} aria-hidden />
                {selectedStore.stationCode} · Hourly HC Plan
              </h3>
              <p>Target {selectedStore.targetOrdersPerAssociateHour} orders / assoc-hr</p>
            </div>
            <Link className={ps.linkBtn} href={`/rostering?station=${encodeURIComponent(selectedStore.stationCode)}`}>
              Open rostering <ChevronRight size={12} aria-hidden />
            </Link>
          </div>

          {selectedStore.hourlyPlan.length ? (
            <div style={{ overflowX: "auto" }}>
              <table className={ps.hcTable}>
                <thead>
                  <tr>
                    <th>Hour IST</th>
                    <th>Orders</th>
                    <th>Required HC</th>
                    <th>Rostered HC</th>
                    <th>Variance</th>
                    <th>Coverage</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedStore.hourlyPlan.map((row, i) => {
                    const isUnder = row.variance != null && row.variance < 0;
                    const isOver = row.variance != null && row.variance > 0;
                    return (
                      <tr key={row.hour} className={i % 2 === 1 ? ps.rowAlt : ""}>
                        <td className={ps.tdHour}>{String(row.hour).padStart(2, "0")}:00</td>
                        <td className={ps.tdNum}>{count(row.orderCount)}</td>
                        <td className={ps.tdNum}><span style={{ fontWeight: 700 }}>{count(row.requiredHc)}</span></td>
                        <td className={ps.tdNum}>
                          {row.rosteredHc == null
                            ? <span style={{ color: "var(--muted)" }}>—</span>
                            : count(row.rosteredHc)
                          }
                        </td>
                        <td className={ps.tdNum}>
                          {row.variance == null
                            ? <span style={{ color: "var(--muted)" }}>—</span>
                            : (
                              <span className={isUnder ? ps.pillBad : isOver ? ps.pillGood : ps.pillNeutral}>
                                {row.variance > 0 ? `+${row.variance}` : row.variance}
                              </span>
                            )
                          }
                        </td>
                        <td style={{ minWidth: 110 }}>
                          <StaffingBar
                            rostered={row.rosteredHc ?? 0}
                            required={row.requiredHc}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className={ps.emptyState}>
              <Activity size={28} style={{ opacity: 0.25 }} aria-hidden />
              <span>No PPI hourly demand for this date yet.</span>
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}
