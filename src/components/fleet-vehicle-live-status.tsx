"use client";

import { Activity, AlertTriangle, Clock3, MapPin, RefreshCw, Truck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { FleetExportButtons } from "@/components/fleet-export-buttons";
import type { FleetControlVehicle } from "@/lib/fleet-control";

type GpsRow = { vehicle_no: string; speed: number; ignition: boolean; gps_time?: string; latitude: number; longitude: number };
type Metric = { vehicle_no: string; todayKm?: number; todayMaxSpeed?: number; todayMovingMinutes?: number; firstMovingAt?: string | null; lastMovingAt?: string | null; firstMovingLatitude?: number | null; firstMovingLongitude?: number | null };
type Location = { code: string; name: string; latitude: number | null; longitude: number | null; geofenceRadiusM: number | null };
type Snapshot = { error?: string; generatedAt?: string; gpsLive?: GpsRow[]; vehicleMetrics?: Metric[]; locations?: Location[] };

const number = (value: number | null | undefined, digits = 1) => Number(value ?? 0).toLocaleString("en-IN", { maximumFractionDigits: digits });
const time = (value: string | null | undefined) => value ? new Date(value).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "—";
const plate = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, "");
function metres(aLat: number, aLng: number, bLat: number, bLng: number) {
  const radians = Math.PI / 180;
  const value = Math.sin((bLat - aLat) * radians / 2) ** 2 + Math.cos(aLat * radians) * Math.cos(bLat * radians) * Math.sin((bLng - aLng) * radians / 2) ** 2;
  return 12_742_000 * Math.asin(Math.sqrt(Math.min(1, value)));
}

export function FleetVehicleLiveStatus({ vehicles, onManage }: { vehicles: FleetControlVehicle[]; onManage: (vehicle: FleetControlVehicle) => void }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  async function load(manual = false) {
    manual ? setRefreshing(true) : setLoading(true);
    try {
      const response = await fetch(`/api/fleet/summary?ts=${Date.now()}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to load live vehicle status.");
      setSnapshot(payload);
    } catch (error) {
      setSnapshot({ error: error instanceof Error ? error.message : "Unable to load live vehicle status." });
    } finally { setLoading(false); setRefreshing(false); }
  }

  useEffect(() => { load(); const timer = window.setInterval(() => load(true), 30_000); return () => window.clearInterval(timer); }, []);
  const gps = useMemo(() => new Map((snapshot?.gpsLive ?? []).map((row) => [plate(row.vehicle_no), row])), [snapshot]);
  const metrics = useMemo(() => new Map((snapshot?.vehicleMetrics ?? []).map((row) => [plate(row.vehicle_no), row])), [snapshot]);
  const locations = useMemo(() => new Map((snapshot?.locations ?? []).map((row) => [row.code.toUpperCase(), row])), [snapshot]);
  const groups = useMemo(() => {
    const values = new Map<string, FleetControlVehicle[]>();
    vehicles.forEach((vehicle) => { const list = values.get(vehicle.stationCode) ?? []; list.push(vehicle); values.set(vehicle.stationCode, list); });
    return [...values].sort(([a], [b]) => a.localeCompare(b)).map(([station, list]) => ({ station, vehicles: list.sort((a, b) => a.vehicleNo.localeCompare(b.vehicleNo)) }));
  }, [vehicles]);
  const live = vehicles.filter((vehicle) => gps.has(plate(vehicle.vehicleNo))).length;
  const moving = vehicles.filter((vehicle) => (gps.get(plate(vehicle.vehicleNo))?.speed ?? 0) > 0).length;
  const unavailable = vehicles.filter((vehicle) => vehicle.status !== "active" || vehicle.deploymentStatus === "not_deployed").length;
  const offStation = vehicles.filter((vehicle) => {
    const movement = metrics.get(plate(vehicle.vehicleNo)); const station = locations.get(vehicle.stationCode);
    if (movement?.firstMovingLatitude == null || movement.firstMovingLongitude == null || station?.latitude == null || station.longitude == null) return false;
    return metres(movement.firstMovingLatitude, movement.firstMovingLongitude, station.latitude, station.longitude) > (station.geofenceRadiusM || 50);
  }).length;
  const report = { title: "Live vehicle status", subtitle: `Station-wise snapshot · refreshed ${snapshot?.generatedAt ? time(snapshot.generatedAt) : "—"} · 30-second interval`, fileName: `fleet-live-status-${new Date().toISOString().slice(0, 10)}`, headers: ["Assigned station", "Vehicle", "Deployment", "Current physical location", "Status", "Ignition", "Current speed km/h", "Today km", "Today max speed", "First movement", "Operating minutes", "GPS updated", "Start location check"], rows: vehicles.map((vehicle) => { const row = gps.get(plate(vehicle.vehicleNo)); const movement = metrics.get(plate(vehicle.vehicleNo)); const station = locations.get(vehicle.stationCode); const distance = movement?.firstMovingLatitude != null && movement.firstMovingLongitude != null && station?.latitude != null && station.longitude != null ? Math.round(metres(movement.firstMovingLatitude, movement.firstMovingLongitude, station.latitude, station.longitude)) : null; return [vehicle.stationCode, vehicle.vehicleNo, vehicle.deploymentStatus === "not_deployed" ? "Not deployed" : "Deployed", vehicle.currentLocationLabel, vehicle.statusLabel, row?.ignition ? "On" : "Off", row?.speed ?? "", movement?.todayKm ?? 0, movement?.todayMaxSpeed ?? 0, movement?.firstMovingAt ?? "", movement?.todayMovingMinutes ?? 0, row?.gps_time ?? "", distance == null ? "Geofence not verified" : `${distance} m from station`]; }) };

  return <section className="fc-live-status">
    <div className="fc-live-status-head"><div><span className="fc-eyebrow">30-second operational snapshot</span><h2>Live vehicle status</h2><p>Vehicles are grouped by assigned station. Distance and start time use the latest saved WheelsEye history for today.</p></div><div><FleetExportButtons compact report={report} /><button className="fc-button secondary" disabled={refreshing} onClick={() => load(true)} type="button"><RefreshCw className={refreshing ? "spin" : ""} size={15} /> Refresh</button></div></div>
    {snapshot?.error ? <div className="fc-flash error"><span>{snapshot.error}</span></div> : null}
    <div className="fc-live-status-kpis"><article><Truck size={17} /><span>Vehicles in view</span><strong>{vehicles.length}</strong><small>{live} reporting GPS</small></article><article><Activity size={17} /><span>Moving now</span><strong>{moving}</strong><small>live speed above 0 km/h</small></article><article className={unavailable ? "bad" : ""}><AlertTriangle size={17} /><span>Not operational</span><strong>{unavailable}</strong><small>breakdown, service or inactive</small></article><article className={offStation ? "warn" : ""}><MapPin size={17} /><span>Start exceptions</span><strong>{offStation}</strong><small>outside configured station radius</small></article></div>
    {loading ? <div className="fc-empty compact">Loading the station-wise live view…</div> : <div className="fc-live-stations">{groups.map((group) => <article className="fc-live-station" key={group.station}><header><div><span><MapPin size={16} /></span><div><h3>{group.station}</h3><p>{locations.get(group.station)?.name || "Assigned station"}</p></div></div><div><b>{group.vehicles.length} vehicles</b><small>{group.vehicles.filter((vehicle) => vehicle.status === "active" && vehicle.deploymentStatus === "deployed").length} operational · {group.vehicles.filter((vehicle) => (gps.get(plate(vehicle.vehicleNo))?.speed ?? 0) > 0).length} moving</small></div></header><div className="fc-live-table-wrap"><table><thead><tr><th>Vehicle</th><th>Deployment</th><th>Current location</th><th>Availability</th><th>Started</th><th>Speed</th><th>Today</th><th>Max speed</th><th>Operating</th><th>Start location</th><th>Updated</th></tr></thead><tbody>{group.vehicles.map((vehicle) => { const current = gps.get(plate(vehicle.vehicleNo)); const movement = metrics.get(plate(vehicle.vehicleNo)); const station = locations.get(group.station); const hasStart = movement?.firstMovingLatitude != null && movement.firstMovingLongitude != null; const hasStation = station?.latitude != null && station.longitude != null; const distance = hasStart && hasStation ? Math.round(metres(movement!.firstMovingLatitude!, movement!.firstMovingLongitude!, station!.latitude!, station!.longitude!)) : null; const radius = station?.geofenceRadiusM || 50; const outside = distance != null && distance > radius; const unavailableVehicle = vehicle.status !== "active" || vehicle.deploymentStatus === "not_deployed"; return <tr className={unavailableVehicle ? "unavailable" : current?.speed ? "moving" : ""} key={vehicle.vehicleNo}><td><button onClick={() => onManage(vehicle)} type="button"><strong>{vehicle.vehicleNo}</strong><small>{vehicle.model}</small></button></td><td><span className={`fc-deployment ${vehicle.deploymentStatus}`}>{vehicle.deploymentStatus === "not_deployed" ? "Not deployed" : "Deployed"}</span></td><td><b>{vehicle.currentLocationLabel}</b><small>{vehicle.currentLocationType.replaceAll("_", " ")}</small></td><td><span className={`fc-status ${vehicle.status === "active" ? "good" : vehicle.status === "breakdown" ? "bad" : "warn"}`}><i />{vehicle.statusLabel}</span>{unavailableVehicle && current?.speed ? <em className="fc-live-alert">Moving while unavailable</em> : null}</td><td>{time(movement?.firstMovingAt)}</td><td><b>{current ? `${number(current.speed)} km/h` : "No live GPS"}</b><small>{current?.ignition ? "Ignition on" : "Ignition off"}</small></td><td><b>{number(movement?.todayKm)} km</b></td><td>{number(movement?.todayMaxSpeed)} km/h</td><td>{number(movement?.todayMovingMinutes, 0)} min</td><td>{distance == null ? <span className="fc-live-geo unknown">Geofence not verified</span> : <a className={`fc-live-geo ${outside ? "outside" : "inside"}`} href={`https://maps.google.com/?q=${movement?.firstMovingLatitude},${movement?.firstMovingLongitude}`} rel="noreferrer" target="_blank">{outside ? <AlertTriangle size={13} /> : <MapPin size={13} />}{distance} m · {outside ? "outside" : "inside"} {radius} m</a>}</td><td>{time(current?.gps_time)}<small>{snapshot?.generatedAt ? `Checked ${time(snapshot.generatedAt)}` : ""}</small></td></tr>; })}</tbody></table></div></article>)}</div>}
    <p className="fc-live-status-note"><Clock3 size={14} /> Live speed and ignition refresh every 30 seconds. Today’s kilometres, first movement and maximum speed update when the WheelsEye day history is refreshed. Start-location alerts require a valid station coordinate and first moving GPS fix.</p>
  </section>;
}
