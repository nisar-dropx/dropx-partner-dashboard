"use client";

import { useMemo, useState } from "react";
import { BarChart3, Download, Loader2, RefreshCw, Timer, Trophy, Users2 } from "lucide-react";
import { formatOpsDate } from "@/lib/ops-pulse/date-format";
import type { DsLiveNetwork, DsLiveStoreDetail } from "@/lib/ops-pulse/ds-live-performance";
import s from "./ds-ops.module.css";

function count(n: number) {
  return n.toLocaleString("en-IN");
}

function fmtPpt(sec: number | null | undefined) {
  if (sec == null || sec < 0) return "—";
  const value = Math.round(sec);
  if (value < 60) return `${value}s`;
  return `${Math.floor(value / 60)}m ${value % 60}s`;
}

function fmtSeconds(sec: number | null | undefined) {
  if (sec == null || sec < 0) return "—";
  return (Math.round(sec * 100) / 100).toLocaleString("en-IN");
}

export function DsPpiView({
  network,
  initialDetail,
  initialStation
}: {
  network: DsLiveNetwork;
  initialDetail: DsLiveStoreDetail | null;
  initialStation: string;
}) {
  const [station, setStation] = useState(initialStation || network.stores[0]?.stationCode || "");
  const [detail, setDetail] = useState(initialDetail);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function loadStation(next: string) {
    setStation(next);
    setError(null);
    setPending(true);
    try {
      const res = await fetch(
        `/api/ops-pulse/ds-live?date=${encodeURIComponent(network.businessDate)}&station=${encodeURIComponent(next)}`,
        { cache: "no-store" }
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(String((body as { error?: string }).error ?? "PPI load failed"));
      setDetail((body as { detail: DsLiveStoreDetail }).detail);
    } catch (err) {
      setDetail(null);
      setError(err instanceof Error ? err.message : "PPI load failed");
    } finally {
      setPending(false);
    }
  }

  const summary = useMemo(() => {
    if (!detail) {
      return {
        siteCode: station || "—",
        orders: 0,
        units: 0,
        ppt: null as number | null,
        users: 0
      };
    }
    return {
      siteCode: detail.stationCode,
      orders: detail.orderCount,
      units: detail.unitCount,
      ppt: detail.avgPptSeconds,
      users: detail.pickerCount
    };
  }, [detail, station]);

  function downloadCsv() {
    if (!detail) return;
    const lines = [
      ["Username", "Orders", "SUM of PPT (seconds)", "Sum of Quantity", "PPT (seconds)"].join(","),
      ...detail.pickers.map((p) =>
        [
          JSON.stringify(p.username),
          p.orderCount,
          p.totalPptSeconds ?? "",
          p.unitCount,
          p.avgPptSeconds ?? ""
        ].join(",")
      )
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ppi-${detail.stationCode}-${network.businessDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className={s.report}>
      <div className={s.toolbar}>
        <div className={s.title}>
          <h2>PPI Dashboard · {formatOpsDate(network.businessDate)}</h2>
          <p>Same associate and hourly layout as the PPI Calculation report.</p>
        </div>
        <div className={s.actions}>
          <label className={s.label} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            Store
            <select
              value={station}
              onChange={(e) => void loadStation(e.target.value)}
              style={{ height: 36, borderRadius: 10, border: "1px solid var(--line)", padding: "0 10px", font: "inherit" }}
            >
              {network.stores.map((row) => (
                <option key={row.stationCode} value={row.stationCode}>
                  {row.stationCode} · {row.stationName}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => void loadStation(station)} disabled={pending || !station}>
            {pending ? <Loader2 size={14} className="spin" aria-hidden /> : <RefreshCw size={14} aria-hidden />}
            Refresh
          </button>
          <button type="button" className={s.primary} onClick={downloadCsv} disabled={!detail?.pickers.length}>
            <Download size={14} aria-hidden />
            Download PPI CSV
          </button>
        </div>
      </div>

      {error ? <p className={s.error} role="alert">{error}</p> : null}

      {/* ── KPI band ── */}
      <section className={s.summary} aria-label="PPI summary" style={{ gridTemplateColumns: "repeat(5, minmax(0, 1fr))" }}>
        <div className={s.metric}>
          <header><Users2 size={12} style={{ opacity: 0.7 }} aria-hidden /> Site</header>
          <strong>{summary.siteCode}</strong>
          <small>Selected store</small>
        </div>
        <div className={s.metric}>
          <header><BarChart3 size={12} style={{ opacity: 0.7 }} aria-hidden /> Orders</header>
          <strong>{count(summary.orders)}</strong>
          <small>Completed today</small>
        </div>
        <div className={s.metric}>
          <header>Units</header>
          <strong>{count(summary.units)}</strong>
          <small>Units picked</small>
        </div>
        <div className={s.hero}>
          <header className={s.label}><Timer size={12} style={{ opacity: 0.7, marginRight: 4 }} aria-hidden />Avg PPT</header>
          <div className={s.heroFigure}>
            <strong>{fmtPpt(summary.ppt)}</strong>
            <span>order-weighted</span>
          </div>
        </div>
        <div className={s.metric}>
          <header><Trophy size={12} style={{ opacity: 0.7 }} aria-hidden /> Pickers</header>
          <strong>{count(summary.users)}</strong>
          <small>Unique today</small>
        </div>
      </section>

      {/* ── Picker PPT performance ── */}
      <section className={s.panel}>
        <div className={s.panelHead}>
          <h3>Picker performance · PPT</h3>
          <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: "#087443", display: "inline-block" }} />
              <span style={{ fontSize: 11 }}>≤ 89s (good)</span>
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: "#d97706", display: "inline-block" }} />
              <span style={{ fontSize: 11 }}>≥ 90s (slow)</span>
            </span>
            <span>{detail?.pickers.length ?? 0} associates</span>
          </span>
        </div>
        {detail?.pickers.length ? (
          <>
            {/* Visual PPT bars */}
            <div style={{ padding: "10px 16px 4px", display: "grid", gap: 5 }}>
              {(() => {
                const maxPpt = Math.max(...detail.pickers.map(p => p.avgPptSeconds ?? 0), 1);
                return detail.pickers.map((p, i) => {
                  const pct = p.avgPptSeconds != null ? Math.round((p.avgPptSeconds / maxPpt) * 100) : 0;
                  const slow = (p.avgPptSeconds ?? 0) >= 90;
                  return (
                    <div key={p.username} style={{ display: "grid", gridTemplateColumns: "140px 1fr 60px", gap: 8, alignItems: "center", fontSize: 12 }}>
                      <span style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: i < 3 ? 700 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {i < 3 && <Trophy size={11} style={{ color: ["#f59e0b","#9ca3af","#b87333"][i], flexShrink: 0 }} aria-hidden />}
                        {p.username}
                      </span>
                      <div style={{ background: "#f3f4f6", borderRadius: 4, height: 8, overflow: "hidden" }}>
                        <div style={{ width: `${pct}%`, height: "100%", background: slow ? "#d97706" : "#087443", borderRadius: 4, transition: "width 0.4s" }} />
                      </div>
                      <span style={{ textAlign: "right", fontWeight: 650, color: slow ? "#d97706" : "#087443" }}>
                        {fmtPpt(p.avgPptSeconds)}
                      </span>
                    </div>
                  );
                });
              })()}
            </div>
            {/* Full table */}
            <div style={{ overflowX: "auto", marginTop: 8 }}>
              <table className={s.board}>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Username</th>
                    <th>Orders</th>
                    <th>Σ PPT (s)</th>
                    <th>Units</th>
                    <th>Avg PPT</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.pickers.map((p, i) => (
                    <tr key={p.username}>
                      <td style={{ color: "var(--muted)", fontWeight: 600 }}>{i + 1}</td>
                      <td><strong>{p.username}</strong></td>
                      <td>{count(p.orderCount)}</td>
                      <td>{fmtSeconds(p.totalPptSeconds)}</td>
                      <td>{count(p.unitCount)}</td>
                      <td>
                        <span className={`${s.badge} ${(p.avgPptSeconds ?? 0) >= 90 ? s.badgeWarn : s.badgeGood}`}>
                          {fmtSeconds(p.avgPptSeconds)}s
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <p className={s.empty}>
            <BarChart3 size={28} style={{ opacity: 0.25 }} aria-hidden />
            <span>{pending ? "Loading…" : "No PPI associate rows for this store today."}</span>
          </p>
        )}
      </section>

      {/* ── Hourly ── */}
      <section className={s.panel}>
        <div className={s.panelHead}>
          <h3>Hourly breakdown</h3>
          <span>{detail?.hourly.length ?? 0} hours</span>
        </div>
        {detail?.hourly.length ? (
          <>
            {/* Hourly bar chart */}
            <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 80, padding: "10px 16px 0", overflow: "hidden" }} aria-hidden>
              {(() => {
                const maxOrd = Math.max(...detail.hourly.map(h => h.orderCount), 1);
                return detail.hourly.map((h) => (
                  <div key={h.hour} style={{ flex: "1 1 0", display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
                    <div style={{ width: "100%", height: 60, display: "flex", alignItems: "flex-end" }}>
                      <span style={{ display: "block", width: "100%", height: `${Math.round((h.orderCount / maxOrd) * 60)}px`, background: "#de5a16", borderRadius: "3px 3px 0 0", opacity: 0.8 }} />
                    </div>
                    <span style={{ fontSize: 9, color: "var(--muted)" }}>{String(h.hour).padStart(2, "0")}</span>
                  </div>
                ));
              })()}
            </div>
            <div style={{ overflowX: "auto" }}>
              <table className={s.board}>
                <thead>
                  <tr>
                    <th>Hour</th>
                    <th>Orders</th>
                    <th>Σ PPT (s)</th>
                    <th>Units</th>
                    <th>Avg PPT (s)</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.hourly.map((h) => (
                    <tr key={h.hour}>
                      <td style={{ fontWeight: 650 }}>{String(h.hour).padStart(2, "0")}:00</td>
                      <td>{count(h.orderCount)}</td>
                      <td>{fmtSeconds(h.totalPptSeconds)}</td>
                      <td>{count(h.unitCount)}</td>
                      <td><span style={{ fontWeight: 650 }}>{fmtSeconds(h.avgPptSeconds)}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <p className={s.empty}>No hourly PPI yet.</p>
        )}
      </section>
    </div>
  );
}
