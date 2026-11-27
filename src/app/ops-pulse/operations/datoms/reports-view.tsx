"use client";

import { useState, useTransition } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import type { DatomsReportRow } from "@/lib/ops-pulse/datoms-alerts";
import s from "./datoms.module.css";

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
          <p>Cached gravity table/graph summaries · refreshed every 30 minutes</p>
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
            <span>The reports cron stores Datoms gravity payloads for store-scoped viewing.</span>
          </div>
        ) : (
          reports.map((row) => (
            <div key={row.id} className={s.reportBlock}>
              <strong>{row.title || row.report_key}</strong>
              <div className={s.thingMeta}>
                <span>{row.kind}</span>
                <span>
                  {new Date(row.observed_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
                </span>
              </div>
              <pre>{JSON.stringify(row.payload_json, null, 2)}</pre>
            </div>
          ))
        )}
      </section>
    </div>
  );
}
