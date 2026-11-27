"use client";

import { useMemo, useState, useTransition } from "react";
import { AlertTriangle, RefreshCw, X } from "lucide-react";
import type { DatomsThingRow } from "@/lib/ops-pulse/datoms-alerts";
import {
  allMetrics,
  analogMetrics,
  formatMetricValue,
  gaugePct,
  panelMetrics,
  statusChips
} from "./metric-utils";
import s from "./datoms.module.css";

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
  const [paramKey, setParamKey] = useState<string | null>(null);
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
  const selectedAll = selected ? allMetrics((selected.metrics_json || {}) as Record<string, unknown>) : [];
  const activeParam =
    selectedAll.find((m) => m.key === paramKey) || selectedAll[0] || null;

  function toggleStation(code: string) {
    setStationFilter((prev) =>
      prev.includes(code) ? prev.filter((x) => x !== code) : [...prev, code]
    );
  }

  function openThing(thingId: string, nextMode: "detailed" | "analog") {
    setSelectedId(thingId);
    setMode(nextMode);
    setParamKey(null);
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
          <p>Live asset cards from Datoms · store scope · Detailed / Analog drill-in</p>
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
              const metrics = panelMetrics((thing.metrics_json || {}) as Record<string, unknown>, 5);
              const chips = statusChips(status);
              return (
                <article key={thing.thing_id} className={s.thingCard}>
                  <h4>{thing.name}</h4>
                  <div className={s.statusRow}>
                    {chips.length ? (
                      chips.map((chip) => (
                        <span key={chip.label} className={s.statusChip}>
                          {chip.label}: <strong>{chip.value}</strong>
                        </span>
                      ))
                    ) : (
                      <span className={s.statusChip}>
                        Status:{" "}
                        <strong>{thing.online == null ? "—" : thing.online ? "Online" : "Offline"}</strong>
                      </span>
                    )}
                  </div>
                  {metrics.length ? (
                    metrics.map((m) => (
                      <div key={m.key} className={s.metricRow}>
                        <span>{m.label}</span>
                        <strong>
                          {formatMetricValue(m)}
                          {m.unit ? ` ${m.unit}` : ""}
                        </strong>
                      </div>
                    ))
                  ) : (
                    <div className={s.metricRow}>
                      <span>No live metrics</span>
                      <strong>—</strong>
                    </div>
                  )}
                  <div className={s.thingActions}>
                    <button type="button" className={s.btn} onClick={() => openThing(thing.thing_id, "detailed")}>
                      Detailed view
                    </button>
                    <button type="button" className={s.btn} onClick={() => openThing(thing.thing_id, "analog")}>
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
            <div className={s.drawerHead}>
              <div>
                <h4>
                  {selected.name}
                </h4>
                <div className={s.thingMeta}>
                  <span>{selected.station_code}</span>
                  <span>
                    Observed{" "}
                    {new Date(selected.observed_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
                  </span>
                </div>
              </div>
              <div className={s.actions}>
                <button
                  type="button"
                  className={`${s.btn}${mode === "detailed" ? ` ${s.btnPrimary}` : ""}`}
                  onClick={() => setMode("detailed")}
                >
                  Detailed view
                </button>
                <button
                  type="button"
                  className={`${s.btn}${mode === "analog" ? ` ${s.btnPrimary}` : ""}`}
                  onClick={() => setMode("analog")}
                >
                  Analog view
                </button>
                <button type="button" className={s.btn} onClick={() => setSelectedId(null)} aria-label="Close">
                  <X size={14} aria-hidden />
                  Close
                </button>
              </div>
            </div>

            {mode === "detailed" ? (
              <div className={s.detailLayout}>
                <aside className={s.paramList}>
                  <div className={s.paramSearch}>Parameters</div>
                  {selectedAll.length ? (
                    selectedAll.map((m) => (
                      <button
                        key={m.key}
                        type="button"
                        className={`${s.paramItem}${activeParam?.key === m.key ? ` ${s.paramItemActive}` : ""}`}
                        onClick={() => setParamKey(m.key)}
                      >
                        <span>{m.label}</span>
                        <strong>
                          {formatMetricValue(m)}
                          {m.unit ? ` ${m.unit}` : ""}
                        </strong>
                      </button>
                    ))
                  ) : (
                    <div className={s.empty}>
                      <strong>No parameters cached.</strong>
                      <span>Refresh the snapshot to pull Datoms readings.</span>
                    </div>
                  )}
                </aside>
                <div className={s.detailMain}>
                  {activeParam ? (
                    <>
                      <div className={s.summaryCards}>
                        <article>
                          <span>{activeParam.label}</span>
                          <strong>
                            {formatMetricValue(activeParam)}
                            {activeParam.unit ? ` ${activeParam.unit}` : ""}
                          </strong>
                          <small>Latest cached reading</small>
                        </article>
                        <article>
                          <span>Station</span>
                          <strong>{selected.station_code || "—"}</strong>
                          <small>{selected.site_name || selected.name}</small>
                        </article>
                        <article>
                          <span>Online</span>
                          <strong>{selected.online == null ? "—" : selected.online ? "Yes" : "No"}</strong>
                          <small>
                            {statusChips((selected.status_json || {}) as Record<string, unknown>)
                              .map((c) => `${c.label} ${c.value}`)
                              .join(" · ") || "Machine status from Datoms"}
                          </small>
                        </article>
                      </div>
                      <div className={s.detailNote}>
                        Cached from Datoms things/list · refresh for latest values. Full hourly charts
                        stay on the Datoms detailed view when live session graph is required.
                      </div>
                    </>
                  ) : (
                    <div className={s.empty}>
                      <strong>Nothing to show yet.</strong>
                      <span>Refresh snapshot so Detailed view can load Datoms parameters.</span>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className={s.analogGrid}>
                {analogMetrics((selected.metrics_json || {}) as Record<string, unknown>).length ? (
                  analogMetrics((selected.metrics_json || {}) as Record<string, unknown>).map((m) => {
                    const pct = gaugePct(m);
                    return (
                      <div key={m.key} className={s.analogCard}>
                        <div className={s.analogLabel}>{m.label}</div>
                        <div className={s.analogValue}>
                          {formatMetricValue(m)}
                          {m.unit ? <span> {m.unit}</span> : null}
                        </div>
                        <div className={s.gaugeTrack}>
                          <div className={s.gaugeFill} style={{ width: `${pct}%` }} />
                        </div>
                        {["mt_power", "mvol", "mcurr", "mvolt_p", "mt_pf", "mpf"].includes(m.key) ? (
                          <div className={s.phaseRow}>
                            {(["r", "y", "b"] as const).map((phase) => {
                              const keyMap: Record<string, string[]> = {
                                mt_power: ["mpow_r", "mpow_y", "mpow_b"],
                                mvol: ["mvol_r", "mvol_y", "mvol_b"],
                                mcurr: ["mcur_ir", "mcur_iy", "mcur_ib"],
                                mvolt_p: ["mvol_ry", "mvol_yb", "mvol_br"],
                                mt_pf: ["mpf_r", "mpf_y", "mpf_b"],
                                mpf: ["mpf_r", "mpf_y", "mpf_b"]
                              };
                              const keys = keyMap[m.key] || [];
                              const phaseKey = keys[["r", "y", "b"].indexOf(phase)];
                              const phaseMetric = selectedAll.find((x) => x.key === phaseKey);
                              return (
                                <span key={phase}>
                                  ({phase.toUpperCase()}){" "}
                                  {phaseMetric ? formatMetricValue(phaseMetric) : "—"}
                                </span>
                              );
                            })}
                          </div>
                        ) : null}
                      </div>
                    );
                  })
                ) : (
                  <div className={s.empty}>
                    <strong>No analog readings.</strong>
                    <span>Refresh snapshot to pull Datoms gauges.</span>
                  </div>
                )}
              </div>
            )}
          </div>
        ) : null}
      </section>
    </div>
  );
}
