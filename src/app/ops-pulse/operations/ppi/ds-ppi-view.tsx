"use client";

import { useMemo, useState } from "react";
import { Download, Loader2, RefreshCw } from "lucide-react";
import { formatOpsDate } from "@/lib/ops-pulse/date-format";
import type { DsLiveNetwork, DsLiveStoreDetail } from "@/lib/ops-pulse/ds-live-performance";
import s from "./ds-ops.module.css";
import ps from "./ppi.module.css";

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

      {/* ── Summary stats banner (matches Amazon style) ── */}
      <div className={ps.statsBanner}>
        {[
          { label: "Site Code", value: summary.siteCode },
          { label: "Total Orders", value: count(summary.orders) },
          { label: "Total Quantity", value: count(summary.units) },
          { label: "Average PPT", value: fmtPpt(summary.ppt) },
          { label: "Unique Users", value: count(summary.users) }
        ].map(({ label, value }) => (
          <div key={label} className={ps.stat}>
            <span className={ps.statLabel}>{label}</span>
            <strong className={ps.statValue}>{value}</strong>
          </div>
        ))}
      </div>

      {/* ── Associate PPI table (green header, like reference) ── */}
      <section className={ps.section}>
        <div className={ps.sectionHead}>
          <h3>Associate PPI Breakdown</h3>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className={ps.dlBtn} onClick={downloadCsv} disabled={!detail?.pickers.length}>
              <Download size={15} aria-hidden /> Download PPI CSV
            </button>
          </div>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table className={ps.table}>
            <thead>
              <tr className={ps.theadGreen}>
                <th>Username</th>
                <th>COUNTA of order id</th>
                <th>SUM of PPT (seconds)</th>
                <th>Sum of Quantity</th>
                <th>PPT (seconds)</th>
              </tr>
            </thead>
            <tbody>
              {detail?.pickers.length ? (
                <>
                  {detail.pickers.map((p, i) => (
                    <tr key={p.username} className={i % 2 === 0 ? ps.rowWhite : ps.rowGray}>
                      <td className={ps.tdLeft}>{p.username}</td>
                      <td className={ps.tdMono}>{count(p.orderCount)}</td>
                      <td className={ps.tdMono}>{fmtSeconds(p.totalPptSeconds)}</td>
                      <td className={ps.tdMono}>{count(p.unitCount)}</td>
                      <td className={`${ps.tdMono} ${ps.pptCell}`} data-slow={(p.avgPptSeconds ?? 0) >= 90 ? "true" : undefined}>
                        {fmtSeconds(p.avgPptSeconds)}
                      </td>
                    </tr>
                  ))}
                  <tr className={ps.totalRowGreen}>
                    <td className={ps.tdLeft}>TOTAL</td>
                    <td className={ps.tdMono}>{count(summary.orders)}</td>
                    <td className={ps.tdMono}>
                      {fmtSeconds(detail.pickers.reduce((acc, p) => acc + (p.totalPptSeconds ?? 0), 0))}
                    </td>
                    <td className={ps.tdMono}>{count(summary.units)}</td>
                    <td className={ps.tdMono}>{fmtPpt(summary.ppt)}</td>
                  </tr>
                </>
              ) : (
                <tr><td colSpan={5} className={ps.emptyCell}>{pending ? "Loading…" : "No PPI associate rows for this store today."}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Hourly breakdown (amber header, like reference) ── */}
      <section className={ps.sectionAmber}>
        <div className={ps.sectionHead}>
          <h3>Hourly Breakdown</h3>
          <span style={{ fontSize: 12, color: "var(--muted)" }}>{detail?.hourly.length ?? 0} hours</span>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table className={ps.table}>
            <thead>
              <tr className={ps.theadAmber}>
                <th>Hour</th>
                <th>Orders</th>
                <th>SUM of PPT (seconds)</th>
                <th>Sum of Quantity</th>
                <th>PPT (seconds)</th>
              </tr>
            </thead>
            <tbody>
              {detail?.hourly.length ? (
                <>
                  {detail.hourly.map((h, i) => (
                    <tr key={h.hour} className={i % 2 === 0 ? ps.rowWhite : ps.rowAmber}>
                      <td className={`${ps.tdLeft} ${ps.tdMono}`}>{String(h.hour).padStart(2, "0")}:00</td>
                      <td className={ps.tdMono}>{count(h.orderCount)}</td>
                      <td className={ps.tdMono}>{fmtSeconds(h.totalPptSeconds)}</td>
                      <td className={ps.tdMono}>{count(h.unitCount)}</td>
                      <td className={`${ps.tdMono} ${ps.pptAmber}`}>{fmtSeconds(h.avgPptSeconds)}</td>
                    </tr>
                  ))}
                  <tr className={ps.totalRowAmber}>
                    <td className={ps.tdLeft}>TOTAL</td>
                    <td className={ps.tdMono}>{count(summary.orders)}</td>
                    <td className={ps.tdMono}>
                      {fmtSeconds(detail.hourly.reduce((acc, h) => acc + (h.totalPptSeconds ?? 0), 0))}
                    </td>
                    <td className={ps.tdMono}>{count(summary.units)}</td>
                    <td className={ps.tdMono}>{fmtPpt(summary.ppt)}</td>
                  </tr>
                </>
              ) : (
                <tr><td colSpan={5} className={ps.emptyCell}>No hourly PPI yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
