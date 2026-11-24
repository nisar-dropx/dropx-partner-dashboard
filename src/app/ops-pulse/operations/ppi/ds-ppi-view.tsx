"use client";

import { useMemo, useState } from "react";
import { Download, Loader2, RefreshCw } from "lucide-react";
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

      <section className={s.summary} aria-label="PPI summary" style={{ gridTemplateColumns: "repeat(5, minmax(0, 1fr))" }}>
        <div className={s.metric}><header>Site Code</header><strong>{summary.siteCode}</strong><small>Selected store</small></div>
        <div className={s.metric}><header>Orders</header><strong>{count(summary.orders)}</strong><small>Completed today</small></div>
        <div className={s.metric}><header>Total Quantity</header><strong>{count(summary.units)}</strong><small>Units picked</small></div>
        <div className={s.hero}>
          <header className={s.label}>PPT</header>
          <div className={s.heroFigure}>
            <strong>{fmtPpt(summary.ppt)}</strong>
            <span>order-weighted average</span>
          </div>
        </div>
        <div className={s.metric}><header>Unique Users</header><strong>{count(summary.users)}</strong><small>Pickers with orders</small></div>
      </section>

      <section className={s.panel}>
        <div className={s.panelHead}>
          <h3>PPI Output</h3>
          <span>{detail?.pickers.length ?? 0} associates</span>
        </div>
        {detail?.pickers.length ? (
          <div style={{ overflowX: "auto" }}>
            <table className={s.board}>
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Orders</th>
                  <th>SUM of PPT (seconds)</th>
                  <th>Sum of Quantity</th>
                  <th>PPT (seconds)</th>
                </tr>
              </thead>
              <tbody>
                {detail.pickers.map((p) => (
                  <tr key={p.username}>
                    <td><strong>{p.username}</strong></td>
                    <td>{count(p.orderCount)}</td>
                    <td>{fmtSeconds(p.totalPptSeconds)}</td>
                    <td>{count(p.unitCount)}</td>
                    <td>
                      <span className={`${s.badge} ${(p.avgPptSeconds ?? 0) >= 90 ? s.badgeWarn : s.badgeGood}`}>
                        {fmtSeconds(p.avgPptSeconds)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className={s.empty}>{pending ? "Loading…" : "No PPI associate rows for this store today."}</p>
        )}
      </section>

      <section className={s.panel}>
        <div className={s.panelHead}>
          <h3>Hourly</h3>
          <span>{detail?.hourly.length ?? 0} hours</span>
        </div>
        {detail?.hourly.length ? (
          <div style={{ overflowX: "auto" }}>
            <table className={s.board}>
              <thead>
                <tr>
                  <th>Hour</th>
                  <th>Orders</th>
                  <th>SUM of PPT (seconds)</th>
                  <th>Sum of Quantity</th>
                  <th>PPT (seconds)</th>
                </tr>
              </thead>
              <tbody>
                {detail.hourly.map((h) => (
                  <tr key={h.hour}>
                    <td>{String(h.hour).padStart(2, "0")}:00</td>
                    <td>{count(h.orderCount)}</td>
                    <td>{fmtSeconds(h.totalPptSeconds)}</td>
                    <td>{count(h.unitCount)}</td>
                    <td>{fmtSeconds(h.avgPptSeconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className={s.empty}>No hourly PPI yet.</p>
        )}
      </section>
    </div>
  );
}
