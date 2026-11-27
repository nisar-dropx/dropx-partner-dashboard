"use client";

import { useMemo, useState, useTransition } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import type { DatomsThingRow } from "@/lib/ops-pulse/datoms-alerts";
import { formatMetricValue, panelMetrics, statusChips } from "./metric-utils";
import s from "./datoms.module.css";

export function DatomsListView({
  initialThings,
  workerConfigured
}: {
  initialThings: DatomsThingRow[];
  workerConfigured: boolean;
}) {
  const [things, setThings] = useState(initialThings);
  const [error, setError] = useState<string | null>(null);
  const [stationFilter, setStationFilter] = useState<string[]>([]);
  const [categoryFilter, setCategoryFilter] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();

  const facts = useMemo(
    () =>
      things.map((t) => ({
        row: t,
        station: t.station_code || "",
        category: t.category || "Uncategorized"
      })),
    [things]
  );

  const filtered = useMemo(() => {
    return facts
      .filter((f) => {
        if (stationFilter.length && !stationFilter.includes(f.station)) return false;
        if (categoryFilter.length && !categoryFilter.includes(f.category)) return false;
        return true;
      })
      .map((f) => f.row);
  }, [facts, stationFilter, categoryFilter]);

  const stationOptions = useMemo(() => {
    const base = facts.filter((f) => !categoryFilter.length || categoryFilter.includes(f.category));
    const set = new Set(base.map((f) => f.station).filter(Boolean));
    for (const code of stationFilter) set.add(code);
    return [...set].sort();
  }, [facts, categoryFilter, stationFilter]);

  const categoryOptions = useMemo(() => {
    const base = facts.filter((f) => !stationFilter.length || stationFilter.includes(f.station));
    const set = new Set(base.map((f) => f.category));
    for (const c of categoryFilter) set.add(c);
    return [...set].sort();
  }, [facts, stationFilter, categoryFilter]);

  const totals = useMemo(() => {
    const online = filtered.filter((t) => t.online === true).length;
    const offline = filtered.filter((t) => t.online === false).length;
    return { total: filtered.length, online, offline };
  }, [filtered]);

  function toggle(list: string[], value: string, set: (next: string[]) => void) {
    set(list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);
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
          <h2>List view</h2>
          <p>Datoms-style asset cards with live metrics · station and category filters</p>
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

      <div className={s.kpiBar}>
        <div className={s.kpi}>
          <span className={s.kpiLabel}>Total assets</span>
          <strong className={s.kpiValue}>{totals.total}</strong>
        </div>
        <div className={s.kpi}>
          <span className={s.kpiLabel}>Online</span>
          <strong className={s.kpiValue}>{totals.online}</strong>
        </div>
        <div className={s.kpi}>
          <span className={s.kpiLabel}>Offline</span>
          <strong className={s.kpiValue}>{totals.offline}</strong>
        </div>
        <div className={s.kpi}>
          <span className={s.kpiLabel}>Stations</span>
          <strong className={s.kpiValue}>{stationOptions.length}</strong>
        </div>
      </div>

      <div className={s.toolbar}>
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
        <div className={s.actions}>
          {categoryOptions.map((cat) => (
            <button
              key={cat}
              type="button"
              className={`${s.btn}${categoryFilter.includes(cat) ? ` ${s.btnPrimary}` : ""}`}
              onClick={() => toggle(categoryFilter, cat, setCategoryFilter)}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      <section className={s.panel}>
        <div className={s.panelHead}>
          <h3>Assets</h3>
          <span>{filtered.length} cards</span>
        </div>
        {!filtered.length ? (
          <div className={s.empty}>
            <strong>No assets in this filter.</strong>
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
                  <div className={s.thingMeta}>
                    <span>{thing.station_code || "—"}</span>
                    {thing.category ? <span>{thing.category}</span> : null}
                    <span>{thing.online == null ? "—" : thing.online ? "Online" : "Offline"}</span>
                  </div>
                  <div className={s.statusRow}>
                    {chips.map((chip) => (
                      <span key={chip.label} className={s.statusChip}>
                        {chip.label}: <strong>{chip.value}</strong>
                      </span>
                    ))}
                  </div>
                  {metrics.map((m) => (
                    <div key={m.key} className={s.metricRow}>
                      <span>{m.label}</span>
                      <strong>
                        {formatMetricValue(m)}
                        {m.unit ? ` ${m.unit}` : ""}
                      </strong>
                    </div>
                  ))}
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
