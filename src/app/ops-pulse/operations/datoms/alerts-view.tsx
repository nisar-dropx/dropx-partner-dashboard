"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { AlertTriangle, MessageSquare, RefreshCw, Thermometer, Wifi } from "lucide-react";
import type { DatomsAlertRow } from "@/lib/ops-pulse/datoms-alerts";
import s from "./datoms.module.css";

const PAGE_SIZE = 20;

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

export function DatomsAlertsView({
  initialAlerts,
  workerConfigured
}: {
  initialAlerts: DatomsAlertRow[];
  workerConfigured: boolean;
}) {
  const [alerts, setAlerts] = useState(initialAlerts);
  const [error, setError] = useState<string | null>(null);
  const [levelFilter, setLevelFilter] = useState<string[]>([]);
  const [stationFilter, setStationFilter] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/ops-pulse/operations/datoms?view=alerts", { cache: "no-store" });
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
        const res = await fetch("/api/ops-pulse/operations/datoms", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "poll-alerts" })
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
        const refresh = await fetch("/api/ops-pulse/operations/datoms?view=alerts", { cache: "no-store" });
        const next = await refresh.json();
        if (refresh.ok && Array.isArray(next.alerts)) setAlerts(next.alerts);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Poll failed");
      }
    });
  }

  const facts = useMemo(
    () => alerts.map((a) => ({ row: a, level: a.level, station: a.station_code })),
    [alerts]
  );

  const filtered = useMemo(() => {
    return facts
      .filter((f) => {
        if (levelFilter.length && !levelFilter.includes(f.level)) return false;
        if (stationFilter.length && !stationFilter.includes(f.station)) return false;
        return true;
      })
      .map((f) => f.row);
  }, [facts, levelFilter, stationFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE;
    return filtered.slice(start, start + PAGE_SIZE);
  }, [filtered, safePage]);
  const rangeStart = filtered.length ? (safePage - 1) * PAGE_SIZE + 1 : 0;
  const rangeEnd = Math.min(safePage * PAGE_SIZE, filtered.length);

  useEffect(() => {
    setPage(1);
  }, [levelFilter, stationFilter]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const levelOptions = useMemo(() => {
    const base = facts.filter((f) => !stationFilter.length || stationFilter.includes(f.station));
    return ["L3", "L2", "L1"].filter((lvl) => base.some((f) => f.level === lvl) || levelFilter.includes(lvl));
  }, [facts, stationFilter, levelFilter]);

  const stationOptions = useMemo(() => {
    const base = facts.filter((f) => !levelFilter.length || levelFilter.includes(f.level));
    const set = new Set(base.map((f) => f.station));
    for (const code of stationFilter) set.add(code);
    return [...set].sort();
  }, [facts, levelFilter, stationFilter]);

  function toggle(list: string[], value: string, set: (next: string[]) => void) {
    set(list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);
  }

  const l3Count = filtered.filter((a) => a.level === "L3").length;
  const l2Count = filtered.filter((a) => a.level === "L2").length;
  const l1Count = filtered.filter((a) => a.level === "L1").length;
  const notifiedCount = filtered.filter((a) => a.notified_at).length;

  return (
    <div className={s.page}>
      <div className={s.toolbar}>
        <div className={s.title}>
          <h2>Alerts</h2>
          <p>
            <Thermometer size={13} style={{ opacity: 0.6 }} aria-hidden />
            L1–L3 violations · WhatsApp for L2/L3 · auto-poll every 10 min
          </p>
        </div>
        <div className={s.actions}>
          {workerConfigured ? (
            <button type="button" className={`${s.btn} ${s.btnPrimary}`} disabled={pending} onClick={runNow}>
              <RefreshCw size={14} aria-hidden />
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
          <span className={s.kpiLabel}>L1 Info</span>
          <span className={s.kpiValue}>{l1Count}</span>
        </div>
        <div className={s.kpi}>
          <span className={s.kpiLabel}>WhatsApp sent</span>
          <span className={s.kpiValue} style={{ color: notifiedCount > 0 ? "#087443" : undefined }}>{notifiedCount}</span>
        </div>
      </div>

      <div className={s.toolbar}>
        <div className={s.actions}>
          {levelOptions.map((lvl) => (
            <button
              key={lvl}
              type="button"
              className={`${s.btn}${levelFilter.includes(lvl) ? ` ${s.btnPrimary}` : ""}`}
              onClick={() => toggle(levelFilter, lvl, setLevelFilter)}
            >
              {lvl}
            </button>
          ))}
        </div>
        <div className={s.actions}>
          {stationOptions.map((code) => (
            <button
              key={code}
              type="button"
              className={`${s.btn}${stationFilter.includes(code) ? ` ${s.btnPrimary}` : ""}`}
              onClick={() => toggle(stationFilter, code, setStationFilter)}
            >
              {code}
            </button>
          ))}
        </div>
      </div>

      <section className={s.panel}>
        <div className={s.panelHead}>
          <h3>
            <Thermometer size={15} aria-hidden />
            Recent violations
          </h3>
          <span>
            {filtered.length
              ? `Showing ${rangeStart}–${rangeEnd} of ${filtered.length}`
              : "0 alerts in view"}
          </span>
        </div>

        {!filtered.length ? (
          <div className={s.empty}>
            <Thermometer size={32} style={{ opacity: 0.25 }} aria-hidden />
            <strong>No alerts stored yet for your store scope.</strong>
            <span>Temperature violations appear when the cron worker polls Datoms.</span>
          </div>
        ) : (
          <>
            <div className={s.alertList}>
              {pageRows.map((row) => {
                const isL3 = row.level === "L3";
                const isL2 = row.level === "L2";
                return (
                  <div key={row.id} className={s.alertRow}>
                    <div className={`${s.alertIcon} ${isL3 ? s.alertIconL3 : isL2 ? s.alertIconL2 : s.alertIconL1}`} aria-hidden>
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
                        <span style={{ marginLeft: "auto" }}>{timeAgo(row.generated_at)}</span>
                      </div>
                    </div>
                    <div className={s.alertRight}>
                      <span className={`${s.level} ${isL3 ? s.levelL3 : isL2 ? s.levelL2 : s.levelL1}`}>{row.level}</span>
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
            {totalPages > 1 ? (
              <div className={s.pager}>
                <span>
                  Page {safePage} of {totalPages}
                </span>
                <button type="button" disabled={safePage <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                  Previous
                </button>
                <button
                  type="button"
                  disabled={safePage >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                >
                  Next
                </button>
              </div>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
