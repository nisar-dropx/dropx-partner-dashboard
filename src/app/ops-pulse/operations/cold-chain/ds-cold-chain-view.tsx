"use client";

import { useEffect, useState, useTransition } from "react";
import type { DatomsAlertRow } from "@/lib/ops-pulse/datoms-alerts";

function formatWhen(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true
  });
}

export function DsColdChainView({
  initialAlerts,
  workerConfigured
}: {
  initialAlerts: DatomsAlertRow[];
  workerConfigured: boolean;
}) {
  const [alerts, setAlerts] = useState(initialAlerts);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/ops-pulse/operations/cold-chain", { cache: "no-store" });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
        if (!cancelled) {
          setAlerts(Array.isArray(body.alerts) ? body.alerts : []);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Refresh failed");
      }
    };
    const id = window.setInterval(tick, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  function runNow() {
    startTransition(async () => {
      try {
        const res = await fetch("/api/ops-pulse/operations/cold-chain", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "run" })
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
        const refresh = await fetch("/api/ops-pulse/operations/cold-chain", { cache: "no-store" });
        const next = await refresh.json();
        if (refresh.ok && Array.isArray(next.alerts)) setAlerts(next.alerts);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Poll failed");
      }
    });
  }

  return (
    <section className="panel">
      <div className="panel-body" style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <strong>L2 / L3 violations</strong>
        <span className="subtle">{alerts.length} recent</span>
        <span className="subtle">Auto-poll every 10 min via OpsPulse cron (India, session reuse) · list refreshes every 10s</span>
        {workerConfigured ? (
          <button type="button" className="button" disabled={pending} onClick={runNow} title="Uses the stored Datoms session only — never logs in">
            {pending ? "Polling…" : "Refresh from Datoms (no login)"}
          </button>
        ) : (
          <span className="subtle">Set DATOMS_EMAIL + DATOMS_PASSWORD on OpsPulse to enable poll.</span>
        )}
        {error ? <span className="subtle" style={{ color: "#b42318" }}>{error}</span> : null}
      </div>
      <div className="panel-body" style={{ paddingTop: 0, overflowX: "auto" }}>
        {!alerts.length ? (
          <p className="subtle">No L2/L3 alerts stored yet for DropX stores.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Level</th>
                <th>Site</th>
                <th>Asset</th>
                <th>Alert</th>
                <th>WhatsApp</th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((row) => (
                <tr key={row.id}>
                  <td>{formatWhen(row.generated_at)}</td>
                  <td>
                    <span className={row.level === "L3" ? "status-pill warn" : "status-pill"}>{row.level}</span>
                  </td>
                  <td>{row.station_code}</td>
                  <td>{row.asset_name || row.site_name || "—"}</td>
                  <td>
                    <div>{row.title || row.rule_name || "—"}</div>
                    <div className="subtle">{row.alert_text}</div>
                  </td>
                  <td>{row.notified_at ? formatWhen(row.notified_at) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
