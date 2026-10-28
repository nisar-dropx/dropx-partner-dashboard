"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./capacity-distance.module.css";

type Station = { id: string; code: string };
type State = { kind: "idle" | "running" | "done" | "error"; text: string };

/** Distance syncs automatically at 05:00 IST; this re-reads one station-day from Amazon on demand. */
export function CapacityDistanceSync({ stations, defaultDate, minDate, maxDate }: { stations: Station[]; defaultDate: string; minDate: string; maxDate: string }) {
  const router = useRouter();
  const [stationId, setStationId] = useState(stations.length === 1 ? stations[0].id : "");
  const [date, setDate] = useState(defaultDate);
  const [state, setState] = useState<State>({ kind: "idle", text: "" });
  if (!stations.length) return null;
  async function sync(event: React.FormEvent) {
    event.preventDefault();
    if (!stationId || state.kind === "running") return;
    const code = stations.find((s) => s.id === stationId)?.code || "station";
    setState({ kind: "running", text: `Reading ${code} routes and GPS from Amazon… this can take a minute.` });
    try {
      const res = await fetch("/api/ops-pulse/capacity/distance/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stationId, date }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setState({ kind: "error", text: data.error || "Sync failed. Existing distances were kept; please retry." }); return; }
      const parts = [`${data.ready} ready`, `${data.pending} pending`];
      if (data.frozen) parts.push(`${data.frozen} in published payouts (unchanged)`);
      if (data.busy) parts.push(`${data.busy} retrying (payroll busy)`);
      setState({ kind: "done", text: data.targets ? `${code} · ${date}: ${parts.join(" · ")}.` : `${code} · ${date}: no kilometre-paid associates on this day.` });
      router.refresh();
    } catch {
      setState({ kind: "error", text: "Sync could not reach the server. Please retry." });
    }
  }
  return (
    <form className={styles.sync} onSubmit={sync} aria-label="Sync distance from Amazon">
      <div className={styles.syncText}>
        <strong>Sync from Amazon</strong>
        <span>Distances update automatically several times a day (from 5:00 IST). Sync a station-day now if routes changed.</span>
      </div>
      <label>
        Station
        <select value={stationId} onChange={(e) => setStationId(e.target.value)} required disabled={state.kind === "running"}>
          <option value="">Choose station</option>
          {stations.map((s) => <option key={s.id} value={s.id}>{s.code}</option>)}
        </select>
      </label>
      <label>
        Day
        <input type="date" value={date} min={minDate} max={maxDate} onChange={(e) => setDate(e.target.value)} required disabled={state.kind === "running"} />
      </label>
      <button className="button compact" type="submit" disabled={!stationId || state.kind === "running"} aria-busy={state.kind === "running"}>
        {state.kind === "running" ? "Syncing…" : "Sync now"}
      </button>
      {state.text ? <p className={state.kind === "error" ? styles.syncError : styles.syncStatus} role={state.kind === "error" ? "alert" : "status"}>{state.text}</p> : null}
    </form>
  );
}
