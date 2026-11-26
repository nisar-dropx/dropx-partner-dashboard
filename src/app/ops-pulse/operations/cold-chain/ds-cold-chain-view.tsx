"use client";

import { useEffect, useState, useTransition } from "react";
import { AlertTriangle, MessageSquare, RefreshCw, Thermometer, Wifi } from "lucide-react";
import type { DatomsAlertRow } from "@/lib/ops-pulse/datoms-alerts";
import s from "./cold-chain.module.css";

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

function timeAgo(iso: string) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
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

  const l3Count = alerts.filter((a) => a.level === "L3").length;
  const l2Count = alerts.filter((a) => a.level === "L2").length;
  const notifiedCount = alerts.filter((a) => a.notified_at).length;
  const sites = new Set(alerts.map((a) => a.station_code)).size;

  return (
    <div className={s.page}>
      {/* ── Toolbar ── */}
      <div className={s.toolbar}>
        <div className={s.title}>
          <h2>Cold Chain Alerts</h2>
          <p>
            <Thermometer size={13} style={{ opacity: 0.6 }} aria-hidden />
            L2 / L3 temperature violations · auto-poll every 10 min · list refreshes every 10s
          </p>
        </div>
        <div className={s.actions}>
          {workerConfigured ? (
            <button type="button" className={`${s.btn} ${s.btnPrimary}`} disabled={pending} onClick={runNow} title="Uses the stored Datoms session only — never logs in">
              <RefreshCw size={14} aria-hidden style={{ animation: pending ? "spin 1s linear infinite" : undefined }} />
              {pending ? "Polling…" : "Refresh from Datoms"}
            </button>
          ) : (
            <span style={{ fontSize: 12, color: "var(--muted)" }}>Set DATOMS_EMAIL + DATOMS_PASSWORD to enable poll.</span>
          )}
        </div>
      </div>

      {error ? (
        <div className={s.error} role="alert">
          <AlertTriangle size={14} aria-hidden />
          {error}
        </div>
      ) : null}

      {/* ── KPI bar ── */}
      <div className={s.kpiBar}>
        <div className={s.kpi}>
          <span className={s.kpiLabel}>L3 Critical</span>
          <span className={s.kpiValue} style={{ color: l3Count > 0 ? "#c0392b" : undefined }}>{l3Count}</span>
        </div>
        <div className={s.kpi}>
          <span className={s.kpiLabel}>L2 Warnings</span>
          <span className={s.kpiValue} style={{ color: l2Count > 0 ? "#d97706" : undefined }}>{l2Count}</span>
        </div>
        <div className={s.kpi}>
          <span className={s.kpiLabel}>WhatsApp sent</span>
          <span className={s.kpiValue} style={{ color: notifiedCount > 0 ? "#087443" : undefined }}>{notifiedCount}</span>
        </div>
        <div className={s.kpi}>
          <span className={s.kpiLabel}>Sites affected</span>
          <span className={s.kpiValue}>{sites}</span>
        </div>
      </div>

      {/* ── Alert list ── */}
      <section className={s.panel}>
        <div className={s.panelHead}>
          <h3>
            <Thermometer size={15} aria-hidden />
            Recent violations
          </h3>
          <span>{alerts.length} alert{alerts.length === 1 ? "" : "s"} in view</span>
        </div>

        {!alerts.length ? (
          <div className={s.empty}>
            <Thermometer size={32} style={{ opacity: 0.25 }} aria-hidden />
            <strong>No L2/L3 alerts stored yet for DropX stores.</strong>
            <span>Temperature violations will appear here when the cron worker polls Datoms.</span>
          </div>
        ) : (
          <div className={s.alertList}>
            {alerts.map((row) => {
              const isL3 = row.level === "L3";
              return (
                <div key={row.id} className={s.alertRow}>
                  <div className={`${s.alertIcon} ${isL3 ? s.alertIconL3 : s.alertIconL2}`} aria-hidden>
                    <Thermometer size={16} />
                  </div>
                  <div className={s.alertBody}>
                    <p className={s.alertTitle}>{row.title || row.rule_name || "Temperature alert"}</p>
                    {row.alert_text ? <p className={s.alertText}>{row.alert_text}</p> : null}
                    <div className={s.alertMeta}>
                      <span>
                        <Wifi size={11} aria-hidden />
                        {row.asset_name || row.site_name || "—"}
                      </span>
                      {row.station_code ? <span>{row.station_code}</span> : null}
                      <span style={{ marginLeft: "auto", color: isL3 ? "#c0392b" : "#d97706" }}>
                        {timeAgo(row.generated_at)}
                      </span>
                    </div>
                  </div>
                  <div className={s.alertRight}>
                    <span className={`${s.level} ${isL3 ? s.levelL3 : s.levelL2}`}>{row.level}</span>
                    <span className={s.alertTime}>{formatWhen(row.generated_at)}</span>
                    {row.notified_at ? (
                      <span className={s.waNotified}>
                        <MessageSquare size={11} aria-hidden />
                        WA sent
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
