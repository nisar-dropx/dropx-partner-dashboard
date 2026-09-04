"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type StationOption = { code: string; name: string };

export function PerformanceStationFilter({
  stations, selectedCodes, view, date, week
}: {
  stations: StationOption[];
  selectedCodes: string[];
  view: "daily" | "sls";
  date: string;
  week: number;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState(selectedCodes);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  useEffect(() => setSelected(selectedCodes), [selectedCodes]);
  const visibleStations = useMemo(() => {
    const term = search.trim().toLowerCase();
    return term ? stations.filter((station) => `${station.code} ${station.name}`.toLowerCase().includes(term)) : stations;
  }, [search, stations]);

  function apply() {
    if (!selected.length) return;
    const params = new URLSearchParams({ view });
    if (view === "daily") {
      params.set("date", date);
    } else {
      params.set("week", String(week));
    }
    if (selected.length !== stations.length) params.set("stations", selected.join(","));
    router.push(`/performance?${params.toString()}`);
    setOpen(false);
  }

  return (
    <details className="performance-station-filter" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary><span>Stations</span><strong>{selected.length === stations.length ? "All permitted" : `${selected.length} selected`}</strong><i>⌄</i></summary>
      <div className="performance-station-popover">
        <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search station" aria-label="Search performance stations" />
        <div className="performance-station-actions">
          <button type="button" onClick={() => setSelected(stations.map((station) => station.code))}>Select all</button>
          <button type="button" onClick={() => setSelected([])}>Clear</button>
        </div>
        <div className="performance-station-options">
          {visibleStations.map((station) => (
            <label key={station.code}>
              <input type="checkbox" checked={selected.includes(station.code)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, station.code] : current.filter((code) => code !== station.code))} />
              <span><strong>{station.code}</strong>{station.name}</span>
              <button type="button" onClick={(event) => { event.preventDefault(); setSelected([station.code]); }}>Only</button>
            </label>
          ))}
        </div>
        <div className="performance-station-footer">
          <button type="button" onClick={() => { setSelected(selectedCodes); setOpen(false); }}>Cancel</button>
          <button className="performance-station-apply" type="button" disabled={!selected.length} onClick={apply}>Apply stations</button>
        </div>
      </div>
    </details>
  );
}
