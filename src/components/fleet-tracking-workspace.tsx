"use client";

import { Activity, AlertTriangle, ArrowDownUp, Clock3, Gauge, MapPin, RefreshCw, Route, Search, ShieldAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { FleetGpsExceptions, type ExceptionTarget } from '@/components/fleet-gps-exceptions';
import type { GpsExceptionReview } from '@/lib/fleet/gps-exceptions';
import { dayDuration, dayHours } from "@/lib/fleet/day-tracking";
import { FleetDayTracking } from "@/components/fleet-day-tracking";
import { DailyFleetReportView } from "@/components/fleet-daily-report";
import { FleetExportButtons } from "@/components/fleet-export-buttons";
import { RouteMap } from "@/components/fleet-dashboard";
import { FleetMultiSelect } from "@/components/fleet-multi-select";
import type { FleetControlData } from "@/lib/fleet-control";

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
    firstMovingAt?: string | null;
    lastMovingAt?: string | null;
    distanceReliable?: boolean;
    quality?: string;
    qualityReason?: string;
  };
};

const number = (value: number, digits = 1) => value.toLocaleString("en-IN", { maximumFractionDigits: digits });
const isoToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const shiftDate = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);


export function FleetTrackingWorkspace({ data, exceptionEntry, onReviewed }: { data: FleetControlData; exceptionEntry?: {target?:ExceptionTarget; key:number}|null; onReviewed?:(review:GpsExceptionReview)=>void }) {
  const stationOptions = data.stationOptions;
  const [view, setView] = useState<"live" | "day" | "mileage" | "exceptions">(exceptionEntry ? "exceptions" : "live");
  useEffect(() => { if(exceptionEntry) setView("exceptions"); }, [exceptionEntry]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedVehicle, setSelectedVehicle] = useState("");
  const [search, setSearch] = useState("");
  const [placements, setPlacements] = useState<string[]>([]);
  const [clusters, setClusters] = useState<string[]>([]);
  const [regions, setRegions] = useState<string[]>([]);
  const [ignition, setIgnition] = useState<string[]>([]);
  const [sort, setSort] = useState<{ key: "vehicle" | "speed" | "time"; direction: "asc" | "desc" }>({ key: "vehicle", direction: "asc" });
  const [movementDate, setMovementDate] = useState(shiftDate(isoToday(), -1));
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
  const stationByCode = useMemo(() => new Map(stationOptions.map((station) => [station.code, station])), [stationOptions]);
  const option = (values: string[]) => [...new Set(values.filter(Boolean))].sort().map((value) => ({ value, label: value }));
  const visiblePlacements = [...new Set(metrics.map((row) => row.station_code).filter(Boolean))].sort().filter((code) => {
    const station = stationByCode.get(code);
    return (!clusters.length || clusters.includes(station?.cluster ?? "Unassigned cluster")) && (!regions.length || regions.includes(station?.region ?? "Unassigned region"));
  });
  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const filtered = (summary?.gpsLive ?? []).filter((row) => {
      const station = stationByVehicle.get(row.vehicle_no) ?? "";
      return (!needle || `${row.vehicle_no} ${station} ${modelByVehicle.get(row.vehicle_no) ?? ""}`.toLowerCase().includes(needle))
        && (!placements.length || placements.includes(station))
        && (!clusters.length || clusters.includes(stationByCode.get(station)?.cluster ?? "Unassigned cluster"))
        && (!regions.length || regions.includes(stationByCode.get(station)?.region ?? "Unassigned region"))
        && (!ignition.length || ignition.includes(row.ignition ? "on" : "off"));
    });
    return filtered.sort((a, b) => {
      const order = sort.key === "speed" ? a.speed - b.speed : sort.key === "time" ? String(a.gps_time ?? "").localeCompare(String(b.gps_time ?? "")) : a.vehicle_no.localeCompare(b.vehicle_no);
      return order * (sort.direction === "asc" ? 1 : -1);
    });
  }, [summary, stationByVehicle, modelByVehicle, stationByCode, search, placements, clusters, regions, ignition, sort]);
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
      <button className={view === "day" ? "active" : ""} onClick={() => setView("day")} type="button"><Clock3 size={16} /> Day tracking</button>
      <button className={view === "mileage" ? "active" : ""} onClick={() => setView("mileage")} type="button"><Gauge size={16} /> Mileage</button>
      <button className={view === "exceptions" ? "active" : ""} onClick={() => setView("exceptions")} type="button"><ShieldAlert size={16} /> Exceptions</button>
    </nav>

    {view === "day" ? <FleetDayTracking data={data} gpsVehicles={(summary?.gpsLive??[]).map(row=>row.vehicle_no)} /> : view === "exceptions" ? <FleetGpsExceptions data={data} initialException={exceptionEntry?.target} onReviewed={onReviewed} /> : view !== "live" ? <DailyFleetReportView focus={view} stationOptions={stationOptions} /> : <>
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
            <FleetMultiSelect allLabel="All regions" label="Region" onChange={setRegions} options={option(stationOptions.map((station) => station.region))} values={regions} />
            <FleetMultiSelect allLabel="All clusters" label="Cluster" onChange={setClusters} options={option(stationOptions.map((station) => station.cluster))} values={clusters} />
            <FleetMultiSelect allLabel="All placements" label="Current placement" onChange={setPlacements} options={visiblePlacements.map((value) => ({ value, label: value, helper: stationByCode.get(value)?.name }))} values={placements} />
            <FleetMultiSelect allLabel="All states" label="Ignition" onChange={setIgnition} options={[{ value: "on", label: "On" }, { value: "off", label: "Off" }]} searchable={false} values={ignition} />
          </div>
          <div className="fc-gps-list-head"><button onClick={() => changeSort("vehicle")} type="button">Vehicle <ArrowDownUp size={12} /></button><button onClick={() => changeSort("speed")} type="button">Speed <ArrowDownUp size={12} /></button><FleetExportButtons compact report={{ title: "Fleet live GPS report", subtitle: `Generated ${isoToday()} · active filters applied`, fileName: `fleet-live-gps-${isoToday()}`, headers: ["Vehicle", "Model", "Current placement", "Speed km/h", "Ignition", "GPS time", "Latitude", "Longitude"], rows: rows.map((row) => [row.vehicle_no, modelByVehicle.get(row.vehicle_no) || "Model not recorded", stationByVehicle.get(row.vehicle_no) ?? "Unmapped", row.speed, row.ignition ? "ON" : "OFF", row.gps_time ?? "", row.latitude, row.longitude]) }} /></div>
          <div className="fc-gps-rows">{loading ? <div className="fc-empty compact">Loading tracked vehicles…</div> : rows.map((row) => <button className={selected?.vehicle_no === row.vehicle_no ? "active" : ""} key={row.vehicle_no} onClick={() => { setSelectedVehicle(row.vehicle_no); setRoute(null); }} type="button"><span className={row.ignition ? "online" : "offline"}><i /></span><div><strong>{row.vehicle_no}</strong><small>{stationByVehicle.get(row.vehicle_no) ?? "Unmapped"} · {modelByVehicle.get(row.vehicle_no) ?? "Vehicle"}</small></div><b>{number(row.speed)} km/h</b></button>)}{!loading && !rows.length ? <div className="fc-empty compact">No GPS vehicle matches the filters.</div> : null}</div>
        </aside>
        <article className="fc-panel fc-gps-map-panel">
          <div className="fc-gps-detail-head"><div><small>Selected vehicle</small><h2>{selected?.vehicle_no ?? "No tracked vehicle"}</h2><p>{selected ? `${stationByVehicle.get(selected.vehicle_no) ?? "Unmapped"} · ${modelByVehicle.get(selected.vehicle_no) ?? "Vehicle"}` : "Connect WheelsEye to see live positions."}</p></div>{selected ? <div><span className={`fc-live-pill ${selected.ignition ? "on" : "off"}`}><i /> Ignition {selected.ignition ? "on" : "off"}</span><strong>{number(selected.speed)} km/h</strong></div> : null}</div>
          <div className="fc-map-wrap"><RouteMap currentPoint={selected ? { lat: selected.latitude, lng: selected.longitude } : null} points={route?.points ?? []} /></div>
          <div className="fc-movement-controls"><label><span>Journey date</span><input max={isoToday()} onChange={(event) => setMovementDate(event.target.value)} type="date" value={movementDate} /></label><button onClick={() => setMovementDate(shiftDate(isoToday(), -1))} type="button">Previous day</button><button onClick={() => setMovementDate(isoToday())} type="button">Today</button><button className="fc-button primary" disabled={!selected || routeLoading} onClick={loadMovement} type="button"><Route size={15} /> {routeLoading ? "Loading journey…" : "Load route & km"}</button>{selected ? <a href={`https://maps.google.com/?q=${selected.latitude},${selected.longitude}`} rel="noreferrer" target="_blank">Open current point</a> : null}</div>
          {route?.summary ? <><div className="fc-route-summary"><div><small>Route distance</small><strong>{route.summary.distanceReliable === false ? "Needs review" : `${number(route.summary.km)} km`}</strong></div><div><small>Max speed</small><strong>{number(route.summary.maxSpeed)} km/h</strong></div><div><small>Moving time</small><strong>{dayDuration(route.summary.movingMinutes)}</strong></div><div><small>GPS points</small><strong>{number(route.summary.pointCount, 0)}</strong></div></div><div className="fc-route-export"><span className={route.summary.lateNight ? "alert" : "clear"}>{route.summary.lateNight ? <><AlertTriangle size={14} /> Movement recorded after 10 p.m.</> : <><Clock3 size={14} /> No after-hours movement</>}</span><FleetExportButtons compact report={{ title: `GPS journey · ${selected?.vehicle_no}`, subtitle: `${movementDate} · ${stationByVehicle.get(selected?.vehicle_no ?? "") ?? "Unmapped"}`, fileName: `gps-journey-${selected?.vehicle_no}-${movementDate}`, headers: ["Date", "Vehicle", "Model", "Station", "Distance km", "Moving hours", "Max speed km/h", "First movement", "Last movement", "After 10 p.m.", "GPS points", "Quality"], rows: [[movementDate, selected?.vehicle_no, modelByVehicle.get(selected?.vehicle_no ?? "") || "Model not recorded", stationByVehicle.get(selected?.vehicle_no ?? ""), route.summary.km, dayHours(route.summary.movingMinutes), route.summary.maxSpeed, route.summary.firstMovingAt, route.summary.lastMovingAt, route.summary.lateNight ? "Alert" : "No", route.summary.pointCount, route.summary.quality]] }} /></div></> : null}
          {route?.summary?.qualityReason ? <p className="fc-route-note">{route.summary.qualityReason}</p> : route?.error ? <p className="fc-route-note error">{route.error}</p> : null}
        </article>
      </section>
    </>}
  </div>;
}
