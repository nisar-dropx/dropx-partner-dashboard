"use client";

import { useMemo, useState, useTransition } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import type { DatomsThingRow } from "@/lib/ops-pulse/datoms-alerts";
import s from "./datoms.module.css";

function metricEntries(metrics: Record<string, unknown>) {
  return Object.entries(metrics || {}).slice(0, 6).map(([key, raw]) => {
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const obj = raw as { value?: unknown; unit?: string | null; label?: string };
      return {
        key,
        label: String(obj.label || key),
        value: obj.value == null ? "—" : String(obj.value),
        unit: obj.unit ? String(obj.unit) : ""
      };
    }
    return { key, label: key, value: raw == null ? "—" : String(raw), unit: "" };
  });
}

export function DatomsPanelView({
  initialThings,
  workerConfigured
}: {
  initialThings: DatomsThingRow[];
  workerConfigured: boolean;
}) {
  const [things, setThings] = useState(initialThings);
  const [error, setError] = useState<string | null>(null);
  const [stationFilter, setStationFilter] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<"detailed" | "analog">("detailed");
  const [pending, startTransition] = useTransition();

  const stations = useMemo(
    () => [...new Set(things.map((t) => t.station_code).filter(Boolean) as string[])].sort(),
    [things]
  );

  const filtered = useMemo(() => {
    if (!stationFilter.length) return things;
    return things.filter((t) => t.station_code && stationFilter.includes(t.station_code));
  }, [things, stationFilter]);

  const selected = filtered.find((t) => t.thing_id === selectedId) || null;

  function toggleStation(code: string) {
    setStationFilter((prev) =>
      prev.includes(code) ? prev.filter((x) => x !== code) : [...prev, code]
    );
  }

  function refresh() {
    startTransition(async () => {
      try {
        const res = await fetch("/api/ops-pulse/operations/datoms", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "poll-things" })
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
        const next = await fetch("/api/ops-pulse/operations/datoms?view=things", { cache: "no-store" });
        const payload = await next.json();
        if (next.ok && Array.isArray(payload.things)) setThings(payload.things);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Snapshot failed");
      }
    });
  }

  return (
    <div className={s.page}>
      <div className={s.toolbar}>
        <div className={s.title}>
          <h2>Panel view</h2>
          <p>Cached asset cards from Datoms things/data · store scope · Detailed / Analog drill-in</p>
        </div>
        <div className={s.actions}>
          {workerConfigured ? (
            <button type="button" className={`${s.btn} ${s.btnPrimary}`} disabled={pending} onClick={refresh}>
              <RefreshCw size={14} aria-hidden />
              {pending ? "Refreshing…" : "Refresh snapshot"}
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

      <div className={s.toolbar}>
        <div className={s.actions}>
          {stations.map((code) => (
            <button
              key={code}
              type="button"
              className={`${s.btn}${stationFilter.includes(code) ? ` ${s.btnPrimary}` : ""}`}
              onClick={() => toggleStation(code)}
            >
              {code}
            </button>
          ))}
        </div>
      </div>

      <section className={s.panel}>
        <div className={s.panelHead}>
          <h3>Assets</h3>
          <span>{filtered.length} in view</span>
        </div>
        {!filtered.length ? (
          <div className={s.empty}>
            <strong>No asset snapshot yet.</strong>
            <span>The things cron fills Panel cards every 5 minutes using the stored Datoms session.</span>
          </div>
        ) : (
          <div className={s.thingGrid}>
            {filtered.map((thing) => {
              const status = (thing.status_json || {}) as Record<string, unknown>;
              const metrics = metricEntries((thing.metrics_json || {}) as Record<string, unknown>);
              return (
                <article key={thing.thing_id} className={s.thingCard}>
                  <h4>{thing.name}</h4>
                  <div className={s.thingMeta}>
                    <span>{thing.station_code || "—"}</span>
                    {thing.category ? <span>{thing.category}</span> : null}
                    <span>{thing.online == null ? "—" : thing.online ? "Online" : "Offline"}</span>
                    {status.condensingUnit ? <span>CU {String(status.condensingUnit)}</span> : null}
                  </div>
                  {metrics.map((m) => (
                    <div key={m.key} className={s.metricRow}>
                      <span>{m.label}</span>
                      <strong>
                        {m.value}
                        {m.unit ? ` ${m.unit}` : ""}
                      </strong>
                    </div>
                  ))}
                  <div className={s.thingActions}>
                    <button
                      type="button"
                      className={s.btn}
                      onClick={() => {
                        setSelectedId(thing.thing_id);
                        setMode("detailed");
                      }}
                    >
                      Detailed view
                    </button>
                    <button
                      type="button"
                      className={s.btn}
                      onClick={() => {
                        setSelectedId(thing.thing_id);
                        setMode("analog");
                      }}
                    >
                      Analog view
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}

        {selected ? (
          <div className={s.drawer}>
            <h4>
              {mode === "analog" ? "Analog" : "Detailed"} · {selected.name}
            </h4>
            <div className={s.thingMeta}>
              <span>{selected.station_code}</span>
              <span>Observed {new Date(selected.observed_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</span>
            </div>
            {mode === "detailed" ? (
              <div className={s.thingGrid} style={{ padding: "10px 0 0" }}>
                {metricEntries((selected.metrics_json || {}) as Record<string, unknown>).map((m) => (
                  <div key={m.key} className={s.thingCard}>
                    <div className={s.metricRow}>
                      <span>{m.label}</span>
                      <strong>
                        {m.value}
                        {m.unit ? ` ${m.unit}` : ""}
                      </strong>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className={s.thingGrid} style={{ padding: "10px 0 0" }}>
                {metricEntries((selected.metrics_json || {}) as Record<string, unknown>).map((m) => {
                  const num = Number(m.value);
                  const pct = Number.isFinite(num) ? Math.max(0, Math.min(100, Math.abs(num) % 100)) : 0;
                  return (
                    <div key={m.key} className={s.thingCard}>
                      <div className={s.metricRow}>
                        <span>{m.label}</span>
                        <strong>
                          {m.value}
                          {m.unit ? ` ${m.unit}` : ""}
                        </strong>
                      </div>
                      <div
                        style={{
                          height: 8,
                          borderRadius: 999,
                          background: "#e5e7eb",
                          overflow: "hidden"
                        }}
                      >
                        <div style={{ width: `${pct}%`, height: "100%", background: "#2563eb" }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <div className={s.thingActions} style={{ marginTop: 10 }}>
              <button type="button" className={s.btn} onClick={() => setSelectedId(null)}>
                Close
              </button>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
