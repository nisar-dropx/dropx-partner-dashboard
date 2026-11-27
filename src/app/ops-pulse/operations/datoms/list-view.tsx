"use client";

import { useMemo, useState, useTransition } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import type { DatomsThingRow } from "@/lib/ops-pulse/datoms-alerts";
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
          <p>Dense asset table · cross-filtered by station and category</p>
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
          <span>{filtered.length} rows</span>
        </div>
        {!filtered.length ? (
          <div className={s.empty}>
            <strong>No assets in this filter.</strong>
          </div>
        ) : (
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>Station</th>
                  <th>Name</th>
                  <th>Category</th>
                  <th>Online</th>
                  <th>Observed</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => (
                  <tr key={row.thing_id}>
                    <td>{row.station_code || "—"}</td>
                    <td>{row.name}</td>
                    <td>{row.category || "—"}</td>
                    <td>{row.online == null ? "—" : row.online ? "Yes" : "No"}</td>
                    <td>
                      {new Date(row.observed_at).toLocaleString("en-IN", {
                        timeZone: "Asia/Kolkata",
                        day: "2-digit",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit"
                      })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
