"use client";

import { Activity, ArrowDownUp, Download, Gauge, MapPin, RefreshCw, Route, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { DailyFleetReportView } from "@/components/fleet-daily-report";
import { RouteMap } from "@/components/fleet-dashboard";

type GpsRow = {
  vehicle_no: string;
  speed: number;
  ignition: boolean;
  gps_time?: string;
  latitude: number;
  longitude: number;
};

type FleetMetric = {
  vehicle_no: string;
  station_code: string;
  model: string;
  fuel_type: string;
};

type Summary = {
  error?: string;
  generatedAt?: string;
  gpsLive?: GpsRow[];
  vehicleMetrics?: FleetMetric[];
};

type RouteHistory = {
  error?: string;
  points?: Array<{ lat: number; lng: number }>;
  summary?: {
    km: number;
    maxSpeed: number;
    movingMinutes: number;
    pointCount: number;
    lateNight: boolean;
    distanceReliable?: boolean;
    quality?: string;
    qualityReason?: string;
  };
};

const number = (value: number, digits = 1) => value.toLocaleString("en-IN", { maximumFractionDigits: digits });
const isoToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

function downloadCsv(rows: GpsRow[], stationByVehicle: Map<string, string>) {
  const cell = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const data = [
    ["Vehicle", "Current placement", "Speed km/h", "Ignition", "GPS time", "Latitude", "Longitude"],
    ...rows.map((row) => [row.vehicle_no, stationByVehicle.get(row.vehicle_no) ?? "Unmapped", row.speed, row.ignition ? "ON" : "OFF", row.gps_time ?? "", row.latitude, row.longitude])
  ];
  const url = URL.createObjectURL(new Blob(["\uFEFF" + data.map((row) => row.map(cell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url; link.download = `fleet-live-gps-${isoToday()}.csv`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function FleetTrackingWorkspace() {
  const [view, setView] = useState<"live" | "efficiency">("live");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedVehicle, setSelectedVehicle] = useState("");
  const [search, setSearch] = useState("");
  const [placement, setPlacement] = useState("");
  const [ignition, setIgnition] = useState("");
  const [sort, setSort] = useState<{ key: "vehicle" | "speed" | "time"; direction: "asc" | "desc" }>({ key: "vehicle", direction: "asc" });
  const [movementDate, setMovementDate] = useState(isoToday());
  const [route, setRoute] = useState<RouteHistory | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);

  async function loadLive(manual = false) {
    if (manual) setRefreshing(true); else setLoading(true);
    try {
      const response = await fetch(`/api/fleet/summary?ts=${Date.now()}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to load live GPS.");
      setSummary(payload);
      const rows = (payload.gpsLive ?? []) as GpsRow[];
      setSelectedVehicle((current) => current && rows.some((row) => row.vehicle_no === current) ? current : rows[0]?.vehicle_no ?? "");
    } catch (error) {
      setSummary({ error: error instanceof Error ? error.message : "Unable to load live GPS." });
    } finally {
      setLoading(false); setRefreshing(false);
    }
  }

  useEffect(() => { loadLive(); }, []);
  useEffect(() => {
    if (view !== "live") return;
    const timer = window.setInterval(() => loadLive(true), 30_000);
    return () => window.clearInterval(timer);
  }, [view]);

  const metrics = summary?.vehicleMetrics ?? [];
  const stationByVehicle = useMemo(() => new Map(metrics.map((row) => [row.vehicle_no, row.station_code])), [metrics]);
  const modelByVehicle = useMemo(() => new Map(metrics.map((row) => [row.vehicle_no, `${row.model} · ${row.fuel_type}`])), [metrics]);
  const placements = [...new Set(metrics.map((row) => row.station_code).filter(Boolean))].sort();
  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const filtered = (summary?.gpsLive ?? []).filter((row) => {
      const station = stationByVehicle.get(row.vehicle_no) ?? "";
      return (!needle || `${row.vehicle_no} ${station} ${modelByVehicle.get(row.vehicle_no) ?? ""}`.toLowerCase().includes(needle))
        && (!placement || station === placement)
        && (!ignition || (ignition === "on" ? row.ignition : !row.ignition));
    });
    return filtered.sort((a, b) => {
      const order = sort.key === "speed" ? a.speed - b.speed : sort.key === "time" ? String(a.gps_time ?? "").localeCompare(String(b.gps_time ?? "")) : a.vehicle_no.localeCompare(b.vehicle_no);
      return order * (sort.direction === "asc" ? 1 : -1);
    });
  }, [summary, stationByVehicle, modelByVehicle, search, placement, ignition, sort]);
  const selected = (summary?.gpsLive ?? []).find((row) => row.vehicle_no === selectedVehicle) ?? rows[0] ?? null;
  const moving = rows.filter((row) => row.speed > 0).length;

  function changeSort(key: "vehicle" | "speed" | "time") {
    setSort((current) => ({ key, direction: current.key === key && current.direction === "asc" ? "desc" : "asc" }));
  }

  async function loadMovement() {
    if (!selected?.vehicle_no) return;
    setRouteLoading(true); setRoute(null);
    try {
      const response = await fetch(`/api/wheelseye/history?vehicle=${encodeURIComponent(selected.vehicle_no)}&date=${encodeURIComponent(movementDate)}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to load movement.");
      setRoute(payload);
    } catch (error) {
      setRoute({ error: error instanceof Error ? error.message : "Unable to load movement." });
    } finally { setRouteLoading(false); }
  }

  return <div className="fc-tracking-workspace">
    <nav className="fc-view-switch" aria-label="Vehicle tracking views">
      <button className={view === "live" ? "active" : ""} onClick={() => setView("live")} type="button"><MapPin size={16} /> Live tracking</button>
      <button className={view === "efficiency" ? "active" : ""} onClick={() => setView("efficiency")} type="button"><Gauge size={16} /> Distance, fuel &amp; mileage</button>
    </nav>

    {view === "efficiency" ? <DailyFleetReportView /> : <>
      <div className="fc-section-head fc-tracking-heading"><div><span className="fc-eyebrow">WheelsEye live feed</span><h1>Vehicle tracking</h1><p>Current GPS position and historical movement for vehicles that have tracking configured.</p></div><button className="fc-button secondary" disabled={refreshing} onClick={() => loadLive(true)} type="button"><RefreshCw className={refreshing ? "spin" : ""} size={16} /> Refresh live</button></div>
      {summary?.error ? <div className="fc-flash error"><span>{summary.error}</span></div> : null}
      <section className="fc-tracking-kpis">
        <article><MapPin size={18} /><span>GPS vehicles</span><strong>{rows.length}</strong><small>matching current filters</small></article>
        <article><Activity size={18} /><span>Moving now</span><strong>{moving}</strong><small>speed above 0 km/h</small></article>
        <article><Gauge size={18} /><span>Ignition on</span><strong>{rows.filter((row) => row.ignition).length}</strong><small>live device state</small></article>
        <article><Route size={18} /><span>Last refresh</span><strong>{summary?.generatedAt ? new Date(summary.generatedAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "—"}</strong><small>auto-refresh every 30 seconds</small></article>
      </section>
      <section className="fc-tracking-layout">
        <aside className="fc-panel fc-gps-list">
          <div className="fc-gps-filters">
            <label><span>Find vehicle</span><div><Search size={15} /><input onChange={(event) => setSearch(event.target.value)} placeholder="Vehicle or model" value={search} /></div></label>
            <label><span>Current placement</span><select onChange={(event) => setPlacement(event.target.value)} value={placement}><option value="">All placements</option>{placements.map((value) => <option key={value}>{value}</option>)}</select></label>
            <label><span>Ignition</span><select onChange={(event) => setIgnition(event.target.value)} value={ignition}><option value="">All states</option><option value="on">On</option><option value="off">Off</option></select></label>
          </div>
          <div className="fc-gps-list-head"><button onClick={() => changeSort("vehicle")} type="button">Vehicle <ArrowDownUp size={12} /></button><button onClick={() => changeSort("speed")} type="button">Speed <ArrowDownUp size={12} /></button><button onClick={() => downloadCsv(rows, stationByVehicle)} type="button"><Download size={13} /> CSV</button></div>
          <div className="fc-gps-rows">{loading ? <div className="fc-empty compact">Loading tracked vehicles…</div> : rows.map((row) => <button className={selected?.vehicle_no === row.vehicle_no ? "active" : ""} key={row.vehicle_no} onClick={() => { setSelectedVehicle(row.vehicle_no); setRoute(null); }} type="button"><span className={row.ignition ? "online" : "offline"}><i /></span><div><strong>{row.vehicle_no}</strong><small>{stationByVehicle.get(row.vehicle_no) ?? "Unmapped"} · {modelByVehicle.get(row.vehicle_no) ?? "Vehicle"}</small></div><b>{number(row.speed)} km/h</b></button>)}{!loading && !rows.length ? <div className="fc-empty compact">No GPS vehicle matches the filters.</div> : null}</div>
        </aside>
        <article className="fc-panel fc-gps-map-panel">
          <div className="fc-gps-detail-head"><div><small>Selected vehicle</small><h2>{selected?.vehicle_no ?? "No tracked vehicle"}</h2><p>{selected ? `${stationByVehicle.get(selected.vehicle_no) ?? "Unmapped"} · ${modelByVehicle.get(selected.vehicle_no) ?? "Vehicle"}` : "Connect WheelsEye to see live positions."}</p></div>{selected ? <div><span className={`fc-live-pill ${selected.ignition ? "on" : "off"}`}><i /> Ignition {selected.ignition ? "on" : "off"}</span><strong>{number(selected.speed)} km/h</strong></div> : null}</div>
          <div className="fc-map-wrap"><RouteMap currentPoint={selected ? { lat: selected.latitude, lng: selected.longitude } : null} points={route?.points ?? []} /></div>
          <div className="fc-movement-controls"><label><span>Movement date</span><input max={isoToday()} onChange={(event) => setMovementDate(event.target.value)} type="date" value={movementDate} /></label><button className="fc-button primary" disabled={!selected || routeLoading} onClick={loadMovement} type="button"><Route size={15} /> {routeLoading ? "Loading movement…" : "Load movement"}</button>{selected ? <a href={`https://maps.google.com/?q=${selected.latitude},${selected.longitude}`} rel="noreferrer" target="_blank">Open current point</a> : null}</div>
          {route?.summary ? <div className="fc-route-summary"><div><small>Route distance</small><strong>{route.summary.distanceReliable === false ? "Needs review" : `${number(route.summary.km)} km`}</strong></div><div><small>Max speed</small><strong>{number(route.summary.maxSpeed)} km/h</strong></div><div><small>Moving time</small><strong>{number(route.summary.movingMinutes, 0)} min</strong></div><div><small>GPS points</small><strong>{number(route.summary.pointCount, 0)}</strong></div></div> : null}
          {route?.summary?.qualityReason ? <p className="fc-route-note">{route.summary.qualityReason}</p> : route?.error ? <p className="fc-route-note error">{route.error}</p> : null}
        </article>
      </section>
    </>}
  </div>;
}
