"use client";
import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import s from "@/app/ops-pulse/report-bot/report-bot.module.css";

type Group = {
  id: string;
  name: string;
  size: number;
  enabled: boolean;
  stationIds: string[];
};
type Station = {
  id: string;
  station_code: string;
  station_name: string | null;
};
const endpoint = "/api/report-bot/last-mile/groups";

export function LastMileGroupDirectory({ stations }: { stations: Station[] }) {
  const router = useRouter();
  const [groups, setGroups] = useState<Group[]>([]);
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [groupId, setGroup] = useState("");
  const [station, setStation] = useState("");
  const refresh = useCallback(async () => {
    setBusy(true);
    setNotice("");
    setGroup("");
    setStation("");
    try {
      const r = await fetch(endpoint, { cache: "no-store" });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      setGroups(data.groups);
      setNotice(data.groups.length + " WhatsApp groups available to you.");
    } catch (e) {
      setGroups([]);
      setNotice(e instanceof Error ? e.message : "Group discovery failed.");
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const selected = groups.find((g) => g.id === groupId);
  async function add() {
    if (!selected || !station || busy) return;
    setBusy(true);
    try {
      const r = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ group: groupId, station }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      setGroups((rows) =>
        rows.map((g) => (g.id === groupId ? { ...g, enabled: true } : g)),
      );
      setGroup("");
      setStation("");
      setNotice(
        selected.name +
          " added. Choose Review for manual messages or Live for scheduled reports below.",
      );
      router.refresh();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Could not add group.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={s.card}>
      <div className={s.cardBody}>
        <h2>Find WhatsApp groups</h2>
        <div className={s.formActions}>
          <input
            className={s.input}
            type="search"
            aria-label="Search WhatsApp groups"
            placeholder="Search group name or station code"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setGroup("");
              setStation("");
            }}
          />
          <select
            className={s.select}
            aria-label="WhatsApp group"
            value={groupId}
            onChange={(e) => {
              const g = groups.find((g) => g.id === e.target.value);
              setGroup(e.target.value);
              setStation(g?.stationIds.length === 1 ? g.stationIds[0] : "");
            }}
          >
            <option value="">Choose WhatsApp group</option>
            {groups
              .filter((g) =>
                g.name.toLowerCase().includes(query.trim().toLowerCase()),
              )
              .map((g) => (
                <option key={g.id} value={g.id} disabled={g.enabled}>
                  {g.name}
                  {g.enabled ? " · already added" : ""}
                </option>
              ))}
          </select>
          <select
            className={s.select}
            aria-label="Map to station"
            value={station}
            onChange={(e) => setStation(e.target.value)}
          >
            <option value="">Choose station</option>
            {stations
              .filter((l) => selected?.stationIds.includes(l.id))
              .map((l) => (
                <option key={l.id} value={l.id}>
                  {l.station_code} · {l.station_name}
                </option>
              ))}
          </select>
          <button
            className={s.button}
            disabled={!station || !selected || busy}
            onClick={add}
          >
            Add group
          </button>
          <button className={s.button} disabled={busy} onClick={refresh}>
            Refresh groups
          </button>
        </div>
        <small role="status">{busy ? "Checking WhatsApp…" : notice}</small>
      </div>
    </section>
  );
}
