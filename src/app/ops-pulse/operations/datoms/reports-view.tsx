"use client";

import { useMemo, useState, useTransition } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import type { DatomsReportRow } from "@/lib/ops-pulse/datoms-alerts";
import s from "./datoms.module.css";

function asRows(payload: Record<string, unknown>) {
  const candidates = [
    payload?.data,
    payload?.rows,
    payload?.result,
    (payload?.data as { rows?: unknown })?.rows,
    (payload?.data as { data?: unknown })?.data
  ];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length) return c as Record<string, unknown>[];
  }
  return [];
}

function asSeriesPoints(payload: Record<string, unknown>) {
  const series = (payload?.series as unknown) ?? payload;
  const buckets: { label: string; value: number }[] = [];
  const walk = (node: unknown) => {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj.data)) {
      for (const pt of obj.data) {
        if (!pt || typeof pt !== "object") continue;
        const p = pt as Record<string, unknown>;
        const time = Number(p.time ?? p.x ?? p.key ?? 0);
        const rawVal =
          p.value
          ?? p.y
          ?? (p.parameter_values as Record<string, { sum?: number }> | undefined)?.mt_energy?.sum
          ?? 0;
        const value = Number(rawVal);
        if (!Number.isFinite(value)) continue;
        const label = Number.isFinite(time) && time > 0
          ? new Date(time > 1e12 ? time : time * 1000).toLocaleString("en-IN", {
              timeZone: "Asia/Kolkata",
              day: "2-digit",
              month: "short",
              hour: "2-digit",
              minute: "2-digit"
            })
          : String(p.label ?? "—");
        buckets.push({ label, value });
      }
    }
    for (const v of Object.values(obj)) {
      if (v && typeof v === "object") walk(v);
    }
  };
  walk(series);
  return buckets.slice(0, 48);
}

export function DatomsReportsView({
  initialReports,
  workerConfigured
}: {
  initialReports: DatomsReportRow[];
  workerConfigured: boolean;
}) {
  const [reports, setReports] = useState(initialReports);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const blocks = useMemo(() => {
    return reports.map((row) => {
      const payload = (row.payload_json || {}) as Record<string, unknown>;
      const tableRows = row.kind === "table" ? asRows(payload) : [];
      const points = row.kind === "graph" ? asSeriesPoints(payload) : [];
      const max = Math.max(1, ...points.map((p) => p.value));
      return { row, tableRows, points, max };
    });
  }, [reports]);

  function refresh() {
    startTransition(async () => {
      try {
        const res = await fetch("/api/ops-pulse/operations/datoms", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "poll-reports" })
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
        const next = await fetch("/api/ops-pulse/operations/datoms?view=reports", { cache: "no-store" });
        const payload = await next.json();
        if (next.ok && Array.isArray(payload.reports)) setReports(payload.reports);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Report refresh failed");
      }
    });
  }

  return (
    <div className={s.page}>
      <div className={s.toolbar}>
        <div className={s.title}>
          <h2>Reports</h2>
          <p>Cached Datoms sessions + hourly energy · refreshed every 30 minutes</p>
        </div>
        <div className={s.actions}>
          {workerConfigured ? (
            <button type="button" className={`${s.btn} ${s.btnPrimary}`} disabled={pending} onClick={refresh}>
              <RefreshCw size={14} aria-hidden />
              {pending ? "Refreshing…" : "Refresh cache"}
            </button>
          ) : null}
        </div>
      </div>

      {error ? (
        <div className={s.error} role="alert">
          <AlertTriangle size={14} aria-hidden />
          {error}
        </div>
      ) : null}

      <section className={s.panel}>
        <div className={s.panelHead}>
          <h3>Cached reports</h3>
          <span>{reports.length} blocks</span>
        </div>
        {!reports.length ? (
          <div className={s.empty}>
            <strong>No report cache yet.</strong>
            <span>Refresh cache or wait for the reports cron to store Datoms gravity payloads.</span>
          </div>
        ) : (
          blocks.map(({ row, tableRows, points, max }) => (
            <div key={row.id} className={s.reportBlock}>
              <strong>{row.title || row.report_key}</strong>
              <div className={s.thingMeta}>
                <span>{row.kind}</span>
                <span>
                  {new Date(row.observed_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
                </span>
              </div>

              {row.kind === "graph" && points.length ? (
                <div className={s.barChart}>
                  {points.map((pt, idx) => (
                    <div key={`${pt.label}-${idx}`} className={s.barCol} title={`${pt.label}: ${pt.value}`}>
                      <div className={s.barFill} style={{ height: `${Math.max(4, (pt.value / max) * 100)}%` }} />
                      <span>{pt.label}</span>
                    </div>
                  ))}
                </div>
              ) : null}

              {row.kind === "table" && tableRows.length ? (
                <div className={s.tableWrap}>
                  <table className={s.table}>
                    <thead>
                      <tr>
                        {Object.keys(tableRows[0])
                          .slice(0, 6)
                          .map((key) => (
                            <th key={key}>{key}</th>
                          ))}
                      </tr>
                    </thead>
                    <tbody>
                      {tableRows.slice(0, 25).map((r, idx) => (
                        <tr key={idx}>
                          {Object.keys(tableRows[0])
                            .slice(0, 6)
                            .map((key) => (
                              <td key={key}>{String(r[key] ?? "—")}</td>
                            ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}

              {!points.length && !tableRows.length ? (
                <pre>{JSON.stringify(row.payload_json, null, 2)}</pre>
              ) : null}
            </div>
          ))
        )}
      </section>
    </div>
  );
}
