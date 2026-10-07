"use client";
import { FleetAttachmentPreview } from "./fleet-attachment-preview";
import { vehicleSourceTitle } from "@/lib/fleet/vehicle-sources";

import { Activity, CalendarDays, CircleDollarSign, Fuel, Gauge, History, Route, Truck, Wrench, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { FleetAuditReport } from "@/components/fleet-audit-report";
import { FleetExportButtons } from "@/components/fleet-export-buttons";
import type { FleetControlData, FleetControlVehicle } from "@/lib/fleet-control";
import type { FleetReportTable } from "@/lib/fleet/report-export";

type Period = { id: string; status_key: string; status_label: string; status_reason_label: string | null; comment: string | null; expected_operational_date: string | null; started_at: string; ended_at: string | null };
type Km = { movement_date: string; km: number | string | null; source: string; confidence_percent: number | null; review_status: string | null; max_speed: number | null; moving_minutes: number | null; late_night: boolean; first_moving_at: string | null; last_moving_at: string | null };
type FuelRow = { transaction_date: string; fuel_quantity: number | string | null; fuel_amount: number | string | null; provider: string; product: string | null; station_name: string | null };
type Service = { id: string; service_date: string; service_type: string; vendor_name: string | null; amount: number | string | null; status: string; description: string | null; invoice_url: string | null; downtime_hours: number | string | null };
type Audit = { id: string; scheduled_for: string; status: string; score: number | null; summary: string | null; completed_at: string | null; scheduled_reason: string | null };
type Payload = { from: string; to: string; createdAt: string | null; statusPeriods: Period[]; dailyKm: Km[]; fuel: FuelRow[]; services: Service[]; audits: Audit[] };
type Day = { date: string; status: string; statusLabel: string; reason: string; comment: string; km: number; movingMinutes: number; maxSpeed: number; lateNight: boolean; firstMovingAt: string; lastMovingAt: string; litres: number; fuelAmount: number; serviceAmount: number; serviceLabel: string };

const DAY = 86_400_000;
const date = (value: string | null | undefined) => value ? new Date(value.length === 10 ? `${value}T00:00:00` : value).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—";
const money = (value: number) => `₹${Math.round(value).toLocaleString("en-IN")}`;
const number = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
const shift = (value: string, days: number) => new Date(Date.parse(`${value}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const dates = (from: string, to: string) => { const rows: string[] = []; for (let day = from; day <= to; day = shift(day, 1)) rows.push(day); return rows; };
const title = (value: string) => value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());

export function FleetVehicleLifecycle({ data, vehicle, onClose }: { data: FleetControlData; vehicle: FleetControlVehicle; onClose: () => void }) {
  const [reportAudit,setReportAudit]=useState<string|null>(null);
  const [from, setFrom] = useState(`${data.today.slice(0, 7)}-01`);
  const [to, setTo] = useState(data.today);
  const [calendarMonth, setCalendarMonth] = useState(data.today.slice(0, 7));
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError("");
    fetch(`/api/fleet/vehicle-lifecycle?vehicle_no=${encodeURIComponent(vehicle.vehicleNo)}&from=${from}&to=${to}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => { const result = await response.json(); if (!response.ok) throw new Error(result.error || "Unable to load lifecycle."); setPayload(result); })
      .catch((reason) => { if (reason?.name !== "AbortError") setError(reason instanceof Error ? reason.message : "Unable to load lifecycle."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [vehicle.vehicleNo, from, to]);

  const days = useMemo<Day[]>(() => {
    if (!payload) return [];
    const km = new Map<string, Km>(); payload.dailyKm.filter((row) => row.review_status !== "needs_review").forEach((row) => { if (!km.has(row.movement_date) || number(row.km) > number(km.get(row.movement_date)?.km)) km.set(row.movement_date, row); });
    const fuel = new Map<string, { litres: number; amount: number }>(); payload.fuel.forEach((row) => { const current = fuel.get(row.transaction_date) ?? { litres: 0, amount: 0 }; current.litres += number(row.fuel_quantity); current.amount += number(row.fuel_amount); fuel.set(row.transaction_date, current); });
    const service = new Map<string, { amount: number; labels: string[] }>(); payload.services.forEach((row) => { const current = service.get(row.service_date) ?? { amount: 0, labels: [] }; current.amount += number(row.amount); current.labels.push(title(row.service_type)); service.set(row.service_date, current); });
    return dates(from, to).map((day) => {
      const noon = Date.parse(`${day}T12:00:00Z`);
      const period = [...payload.statusPeriods].reverse().find((item) => Date.parse(item.started_at) <= noon && (!item.ended_at || Date.parse(item.ended_at) > noon));
      const fallback = data.vehicleStatuses.find((status) => status.key === vehicle.status);
      const status = period?.status_key ?? vehicle.status; const statusLabel = period?.status_label ?? vehicle.statusLabel;
      const movement = km.get(day); return { date: day, status, statusLabel, reason: period?.status_reason_label ?? vehicle.statusReasonLabel, comment: period?.comment ?? "", km: number(movement?.km), movingMinutes: number(movement?.moving_minutes), maxSpeed: number(movement?.max_speed), lateNight: Boolean(movement?.late_night), firstMovingAt: movement?.first_moving_at ?? "", lastMovingAt: movement?.last_moving_at ?? "", litres: fuel.get(day)?.litres ?? 0, fuelAmount: fuel.get(day)?.amount ?? 0, serviceAmount: service.get(day)?.amount ?? 0, serviceLabel: service.get(day)?.labels.join(", ") ?? "", operational: fallback?.isOperational } as Day & { operational?: boolean };
    });
  }, [payload, from, to, data.vehicleStatuses, vehicle]);

  const statusByKey = useMemo(() => new Map(data.vehicleStatuses.map((item) => [item.key, item])), [data.vehicleStatuses]);
  const operational = days.filter((day) => statusByKey.get(day.status)?.isOperational ?? day.status === "active").length;
  const breakdown = days.filter((day) => day.status === "breakdown").length;
  const nonOperational = days.length - operational;
  const totalKm = days.reduce((sum, day) => sum + day.km, 0); const litres = days.reduce((sum, day) => sum + day.litres, 0); const fuelAmount = days.reduce((sum, day) => sum + day.fuelAmount, 0);
  const serviceAmount = days.reduce((sum, day) => sum + day.serviceAmount, 0); const tyreAmount = (payload?.services ?? []).filter((row) => /tyre|tire/i.test(`${row.service_type} ${row.description ?? ""}`)).reduce((sum, row) => sum + number(row.amount), 0);
  const monthTotals = useMemo(() => { const values = new Map<string, number>(); days.forEach((day) => values.set(day.date.slice(0, 7), (values.get(day.date.slice(0, 7)) ?? 0) + day.km)); return [...values].map(([key, value]) => ({ key, value })); }, [days]);
  const trend = days.length > 62 ? monthTotals : days.map((day) => ({ key: day.date.slice(5), value: day.km })); const maxTrend = Math.max(1, ...trend.map((item) => item.value));
  const firstMonthDay = `${calendarMonth}-01`; const calendarStart = shift(firstMonthDay, -new Date(`${firstMonthDay}T00:00:00`).getDay()); const calendarDays = dates(calendarStart, shift(calendarStart, 41)); const dayByDate = new Map(days.map((day) => [day.date, day]));
  const timeline = useMemo(() => payload ? [
    ...payload.statusPeriods.map((row) => ({ date: row.started_at.slice(0, 10), kind: "Availability", title: row.status_label, detail: [row.status_reason_label, row.comment].filter(Boolean).join(" · "), amount: 0 })),
    ...payload.services.map((row) => ({ date: row.service_date, kind: "Service", title: title(row.service_type), detail: [row.vendor_name, row.description].filter(Boolean).join(" · "), amount: number(row.amount) })),
    ...payload.audits.map((row) => ({ date: row.scheduled_for, kind: "Audit", title: `${row.status==='failed'?'Completed · Needs attention':row.status==='passed'?'Completed · Passed':title(row.status)} audit`, auditId:row.id, score:row.score, detail: row.summary ?? row.scheduled_reason ?? "Vehicle audit", amount: 0 }))
  ].sort((a, b) => b.date.localeCompare(a.date)) : [], [payload]);
  const report: FleetReportTable = { title: `Vehicle lifecycle · ${vehicle.vehicleNo}`, subtitle: `${date(from)} to ${date(to)} · ${vehicle.stationCode} · ${vehicle.model}`, fileName: `vehicle-lifecycle-${vehicle.vehicleNo}-${from}-${to}`, headers: ["Date", "Vehicle", "Station", "Status", "Reason", "Comment", "Kilometres", "Operating minutes", "Max speed", "First movement", "Last movement", "After 10 p.m.", "Fuel litres", "Fuel amount", "Service / maintenance", "Service amount"], rows: days.map((day) => [day.date, vehicle.vehicleNo, vehicle.stationCode, day.statusLabel, day.reason, day.comment, day.km, day.movingMinutes, day.maxSpeed, day.firstMovingAt, day.lastMovingAt, day.lateNight ? "Alert" : "No", day.litres, day.fuelAmount, day.serviceLabel, day.serviceAmount]) };
  const setPreset = (preset: "30d" | "mtd" | "ytd" | "all") => { const nextFrom = preset === "30d" ? shift(data.today, -29) : preset === "mtd" ? `${data.today.slice(0, 7)}-01` : preset === "ytd" ? `${data.today.slice(0, 4)}-01-01` : (vehicle.createdAt?.slice(0, 10) ?? `${data.today.slice(0, 4)}-01-01`); setFrom(nextFrom); setTo(data.today); setCalendarMonth(data.today.slice(0, 7)); };

  return <div className="fc-lifecycle-backdrop"><section aria-label={`${vehicle.vehicleNo} lifecycle`} className="fc-lifecycle-shell">
    <header className="fc-lifecycle-header"><span><Truck size={23} /></span><div><small>{vehicle.stationCode} · {vehicle.fuelType} · {vehicleSourceTitle(vehicle)}</small><h2>{vehicle.vehicleNo} lifecycle</h2><p>{vehicle.model} · availability, distance, fuel, service, costs and inspections</p></div><FleetExportButtons compact report={report} /><button aria-label="Close vehicle lifecycle" onClick={onClose} type="button"><X size={19} /></button></header>
    <div className="fc-lifecycle-controls"><div className="fc-lifecycle-presets"><button onClick={() => setPreset("30d")} type="button">30 days</button><button onClick={() => setPreset("mtd")} type="button">MTD</button><button onClick={() => setPreset("ytd")} type="button">YTD</button><button onClick={() => setPreset("all")} type="button">All history</button></div><label><span>From</span><input max={to} onChange={(event) => setFrom(event.target.value)} type="date" value={from} /></label><label><span>To</span><input max={data.today} min={from} onChange={(event) => setTo(event.target.value)} type="date" value={to} /></label></div>
    {error ? <div className="fc-lifecycle-error">{error}</div> : null}{loading ? <div className="fc-lifecycle-loading"><Activity className="spin" size={24} /> Loading the complete vehicle lifecycle…</div> : null}
    {!loading && payload ? <div className="fc-lifecycle-body">
      <div className="fc-lifecycle-kpis"><article><Route size={17} /><small>Total distance</small><strong>{totalKm.toLocaleString("en-IN", { maximumFractionDigits: 1 })} km</strong></article><article className="good"><Activity size={17} /><small>Operational days</small><strong>{operational} / {days.length}</strong></article><article className="bad"><History size={17} /><small>Breakdown days</small><strong>{breakdown}</strong></article><article className="warn"><CalendarDays size={17} /><small>Non-operational days</small><strong>{nonOperational}</strong></article><article><Wrench size={17} /><small>Service & maintenance</small><strong>{money(serviceAmount)}</strong><em>Tyres {money(tyreAmount)}</em></article><article><Fuel size={17} /><small>Fuel and efficiency</small><strong>{litres.toLocaleString("en-IN", { maximumFractionDigits: 1 })} L · {money(fuelAmount)}</strong><em>{litres ? `${(totalKm / litres).toFixed(1)} km/L` : /ev/i.test(vehicle.fuelType) ? "Electric vehicle" : "Fuel not recorded"}</em></article></div>
      <div className="fc-lifecycle-grid"><section className="fc-lifecycle-panel"><header><div><small>GPS distance</small><h3>{days.length > 62 ? "Month-level kilometre trend" : "Day-level kilometre trend"}</h3></div><Gauge size={18} /></header><div className="fc-km-chart">{trend.map((item) => <div key={item.key} title={`${item.key}: ${item.value.toFixed(1)} km`}><i style={{ height: `${Math.max(3, item.value / maxTrend * 100)}%` }} /><span>{item.key}</span></div>)}</div></section>
        <section className="fc-lifecycle-panel"><header><div><small>Availability calendar</small><h3>Status and distance by day</h3></div><input max={data.today.slice(0, 7)} min={from.slice(0, 7)} onChange={(event) => setCalendarMonth(event.target.value)} type="month" value={calendarMonth} /></header><div className="fc-lifecycle-week"><b>Sun</b><b>Mon</b><b>Tue</b><b>Wed</b><b>Thu</b><b>Fri</b><b>Sat</b>{calendarDays.map((day) => { const item = dayByDate.get(day); const tone = item ? statusByKey.get(item.status)?.tone ?? "neutral" : "neutral"; return <div className={`${day.startsWith(calendarMonth) ? "" : "outside"} ${tone}`} key={day}><span>{Number(day.slice(-2))}</span>{item ? <><strong>{item.statusLabel}</strong><small>{item.km ? `${item.km.toFixed(0)} km` : "—"}</small></> : null}</div>; })}</div></section>
      </div>
      <div className="fc-lifecycle-grid lower"><section className="fc-lifecycle-panel"><header><div><small>Lifecycle events</small><h3>Status, service and audit timeline</h3></div><History size={18} /></header><div className="fc-lifecycle-timeline">{timeline.map((item, index) => <article key={`${item.kind}-${item.date}-${index}`}><i /><div><header><b>{item.kind} · {item.title}</b><time>{date(item.date)}</time></header><p>{item.detail || "No additional detail"}</p>{item.amount ? <strong>{money(item.amount)}</strong> : null}{"auditId" in item && typeof item.auditId === "string" ? <button type="button" className="fc-button secondary" onClick={()=>setReportAudit(String(item.auditId))}>{"score" in item && item.score!=null?`${item.score}% · `:""}View audit & PDF</button>:null}</div></article>)}{!timeline.length ? <p>No lifecycle events in this period.</p> : null}</div></section>
        <section className="fc-lifecycle-panel"><header><div><small>Expense ledger</small><h3>Maintenance, repairs and tyre changes</h3></div><CircleDollarSign size={18} /></header><div className="fc-lifecycle-expenses">{payload.services.map((item) => <article key={item.id}><span><b>{title(item.service_type)}</b><small>{date(item.service_date)} · {item.vendor_name || "Vendor not recorded"}</small><em>{item.description || title(item.status)}</em></span><strong>{money(number(item.amount))}</strong>{item.invoice_url ? <FleetAttachmentPreview href={item.invoice_url}>Bill</FleetAttachmentPreview> : null}</article>)}{!payload.services.length ? <p>No maintenance expense recorded in this period.</p> : null}</div></section></div>
    </div> : null}
  </section>{reportAudit?<FleetAuditReport auditId={reportAudit} onClose={()=>setReportAudit(null)}/>:null}</div>;
}
