"use client";
import {stationCapacity} from "@/lib/fleet/capacity";
import {documentApplies} from "@/lib/fleet/source-policy";
import { vehicleSourceTitle } from "@/lib/fleet/vehicle-sources";

import { Activity, CalendarDays, CircleDollarSign, ClipboardCheck, FileCheck2, Gauge, History, Search, Truck, Wrench } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { FleetExportButtons } from "@/components/fleet-export-buttons";
import { FleetMultiSelect } from "@/components/fleet-multi-select";
import type { FleetControlData } from "@/lib/fleet-control";
import type { FleetReportTable } from "@/lib/fleet/report-export";

import { reportDateRangeError } from "@/lib/fleet/operating-policy";

type ReportKey = "capacity" | "vehicles" | "lifecycle" | "documents" | "service" | "audits" | "payments" | "adhoc";
const definitions: Array<{ key: ReportKey; label: string; description: string; icon: typeof Truck }> = [
  {key:"capacity",label:"Capacity & cost",description:"Current readiness against station targets, plus ad hoc cost for the selected dates",icon:Gauge},
  { key: "vehicles", label: "Fleet availability", description: "Vehicle source, placement and current operational status", icon: Truck },
  { key: "lifecycle", label: "Vehicle lifecycle", description: "Daily availability, GPS kilometres and maintenance cost by vehicle", icon: History },
  { key: "documents", label: "Document compliance", description: "Stored files, validity dates and renewal attention", icon: FileCheck2 },
  { key: "service", label: "Service & maintenance", description: "Service dates, vendors, bills, downtime and next due", icon: Wrench },
  { key: "audits", label: "Vehicle audits", description: "Video and physical inspection programme and outcomes", icon: ClipboardCheck },
  { key: "payments", label: "Vehicle payments", description: "Vehicle expense requests, decisions and amounts", icon: CircleDollarSign },
  { key: "adhoc", label: "Ad Hoc usage", description: "Van and driver usage visible to Fleet", icon: Activity }
];
const money = (value: number) => `INR ${value.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
const label = (value: string) => value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());

export function FleetReportsWorkspace({ data: baseData }: { data: FleetControlData }) {
  const [reportKey, setReportKey] = useState<ReportKey>("vehicles");
  const [from, setFrom] = useState(`${baseData.today.slice(0, 7)}-01`);
  const [to, setTo] = useState(baseData.today);
  const [stations, setStations] = useState<string[]>([]);
  const [clusters, setClusters] = useState<string[]>([]);
  const [regions, setRegions] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [history, setHistory] = useState<{key:string;value:Partial<FleetControlData>} | null>(null);
  const [historyError, setHistoryError] = useState("");
  const [retry, setRetry] = useState(0);
  const [page,setPage] = useState(0);
  const snapshotReport = reportKey === "vehicles" || reportKey === "documents";
  const dateError = reportDateRangeError(from,to);
  const historyKey = `${reportKey}|${from}|${to}|${baseData.generatedAt}`;
  const historyReady = snapshotReport || history?.key === historyKey;
  const data = useMemo(()=>({...baseData,...(!snapshotReport && history?.key===historyKey ? history.value : {})}),[baseData,history,snapshotReport,historyKey]);
  useEffect(()=>{
    setHistoryError("");
    if(snapshotReport || dateError)return;
    const controller=new AbortController();
    const timer=setTimeout(async()=>{
      const timeout=setTimeout(()=>controller.abort(),60000);
      try{
        const response=await fetch(`/api/fleet/reports/history?${new URLSearchParams({report:reportKey,from,to})}`,{signal:controller.signal,cache:"no-store"});
        const value=await response.json();if(!response.ok)throw new Error(value.error||"Report unavailable.");
        if(!controller.signal.aborted)setHistory({key:historyKey,value});
      }catch(error){if(!controller.signal.aborted)setHistoryError(error instanceof Error?error.message:"Report unavailable.");else if(!cancelled)setHistoryError("Report timed out. Retry or narrow the dates.");}
      finally{clearTimeout(timeout);}
    },250);
    let cancelled=false;
    return ()=>{cancelled=true;clearTimeout(timer);controller.abort();};
  },[reportKey,from,to,historyKey,snapshotReport,dateError,retry]);
  useEffect(()=>setPage(0),[reportKey,from,to,stations,clusters,regions,search]);
  const stationByCode = useMemo(() => new Map(data.stationOptions.map((item) => [item.code, item])), [data.stationOptions]);
  const inScope = (station: string) => (!stations.length || stations.includes(station)) && (!clusters.length || clusters.includes(stationByCode.get(station)?.cluster ?? "Unassigned cluster")) && (!regions.length || regions.includes(stationByCode.get(station)?.region ?? "Unassigned region"));
  const needle = search.trim().toLowerCase();
  const includes = (value: string) => !needle || value.toLowerCase().includes(needle);
  const selected = definitions.find((item) => item.key === reportKey)!;

  const report = useMemo<FleetReportTable>(() => {
    const subtitle = `${snapshotReport ? `Current snapshot · ${data.today}` : `${from} to ${to}`} · ${stations.length ? stations.join(", ") : clusters.length ? clusters.join(", ") : regions.length ? regions.join(", ") : "All vehicle placements"}`;
    if (!historyReady) return {title:selected.label,subtitle:historyError||"Loading complete history…",fileName:"fleet-report",headers:[],rows:[]};
    if (dateError && !snapshotReport) return {title:selected.label,subtitle:dateError,fileName:"fleet-report",headers:[],rows:[]};
    if(reportKey === "capacity") return {title:"Station capacity & ad hoc cost",subtitle:`Current readiness as at ${data.today} · Ad hoc ${from} to ${to} · recorded amounts, not settled cost`,fileName:`fleet-capacity-${from}-${to}`,headers:["Station","Assigned","Owned","ODCD / Rented / Vendor","Operational & deployed","Target","Shortfall","Unavailable deployed","Service overdue","Van requests","Van amount","Driver requests","Driver amount"],rows:stationCapacity(data,from,to).filter(r=>inScope(r.code)&&includes(r.code)).map(r=>[r.code,r.assigned,r.owned,r.partners,r.ready,r.target,r.shortfall,r.unavailable,r.overdueService,r.vanRequests,r.vanAmount,r.driverRequests,r.driverAmount])};
    if (reportKey === "vehicles") return { title: "Fleet availability report", subtitle, fileName: `fleet-availability-${data.today}`, headers: ["Vehicle", "Station", "Source", "Model", "Fuel", "Status", "Reason", "Non-operational since", "Expected operational", "Latest comment"], rows: data.vehicles.filter((row) => inScope(row.stationCode) && includes(`${row.vehicleNo} ${row.model} ${row.stationCode} ${row.statusLabel} ${row.statusReasonLabel}`)).map((row) => [row.vehicleNo, row.stationCode, vehicleSourceTitle(row), row.model, row.fuelType, row.statusLabel, row.statusReasonLabel, row.nonOperationalSince, row.expectedOperationalDate, row.statusComment]) };
    if (reportKey === "lifecycle") {
      const range: string[] = []; for (let value = from; value <= to; value = new Date(Date.parse(`${value}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) range.push(value);
      const km = new Map(data.dailyKm.map((row) => [`${row.vehicleNo}|${row.date}`, row.km]));
      const services = new Map<string, { labels: string[]; amount: number }>(); data.serviceHistory.filter((row) => row.status === "completed" && row.serviceDate >= from && row.serviceDate <= to).forEach((row) => { const key = `${row.vehicleNo}|${row.serviceDate}`; const current = services.get(key) ?? { labels: [], amount: 0 }; current.labels.push(label(row.serviceType)); current.amount += row.amount; services.set(key, current); });
      const rows = data.vehicles.filter((vehicle) => inScope(vehicle.stationCode) && includes(`${vehicle.vehicleNo} ${vehicle.stationCode} ${vehicle.model}`)).flatMap((vehicle) => range.filter(day=>!vehicle.deploymentDate || day>=vehicle.deploymentDate).map((day) => { const noon = Date.parse(`${day}T12:00:00+05:30`); const period = [...data.statusHistory].sort((a,b)=>b.startedAt.localeCompare(a.startedAt)).find((item) => item.vehicleNo === vehicle.vehicleNo && Date.parse(item.startedAt) <= noon && (!item.endedAt || Date.parse(item.endedAt) > noon)); const service = services.get(`${vehicle.vehicleNo}|${day}`); return [day, vehicle.vehicleNo, vehicle.model, vehicle.stationCode, period?.statusLabel ?? (day === data.today ? vehicle.statusLabel : "Not recorded"), period?.statusReasonLabel ?? (day === data.today ? vehicle.statusReasonLabel : ""), period?.comment ?? (day === data.today ? vehicle.statusComment : ""), km.get(`${vehicle.vehicleNo}|${day}`) ?? null, service?.labels.join(", ") ?? "", service?.amount ?? 0]; }));
      return { title: "Vehicle lifecycle report", subtitle, fileName: `fleet-vehicle-lifecycle-${from}-${to}`, headers: ["Date", "Vehicle", "Model", "Station", "Status", "Reason", "Comment", "Kilometres", "Service / maintenance", "Service amount"], rows };
    }
    if (reportKey === "documents") return { title: "Vehicle document compliance report", subtitle, fileName: `fleet-documents-${data.today}`, headers: ["Vehicle", "Model", "Station", "Document", "State", "File", "Expiry", "Uploaded"], rows: data.vehicles.filter(v=>inScope(v.stationCode)).flatMap(vehicle=>data.documentTypes.filter(type=>documentApplies(type,vehicle)).flatMap(type=>{
      const docs=data.documents.filter(doc=>doc.vehicleNo===vehicle.vehicleNo && doc.documentType===type.value);
      if(!includes(`${vehicle.vehicleNo} ${vehicle.model} ${vehicle.stationCode} ${type.label} ${docs.map(d=>d.fileName).join(" ")}`))return [];
      if(!docs.length)return [[vehicle.vehicleNo,vehicle.model,vehicle.stationCode,type.label,"Missing file","",null,null]];
      return docs.map(doc=>[vehicle.vehicleNo,vehicle.model,vehicle.stationCode,type.label,doc.expiryDate && doc.expiryDate<data.today ? "Expired" : type.requiresExpiry && !doc.expiryDate ? "Expiry missing" : "File recorded",doc.fileName,doc.expiryDate,doc.uploadedAt]);
    })) };

    if (reportKey === "service") return { title: "Vehicle service and maintenance report", subtitle, fileName: `fleet-service-${from}-${to}`, headers: ["Date", "Vehicle", "Model", "Station", "Type", "Vendor", "Amount", "Status", "Downtime hours", "Next service", "Invoice"], rows: data.serviceHistory.filter((row) => (row.status !== "scheduled" || data.vehicles.some(v=>v.id===row.vehicleId && v.ownershipType === "own")) && row.serviceDate >= from && row.serviceDate <= to && inScope(row.stationCode) && includes(`${row.vehicleNo} ${row.serviceType} ${row.vendorName} ${row.description}`)).map((row) => [row.serviceDate, row.vehicleNo, data.vehicles.find(v=>v.vehicleNo===row.vehicleNo)?.model || "Model not recorded", row.stationCode, label(row.serviceType), row.vendorName, row.amount, label(row.status), row.downtimeHours, row.nextServiceDate, row.invoiceUrl]) };
    if (reportKey === "audits") return { title: "Vehicle audit report", subtitle, fileName: `fleet-audits-${from}-${to}`, headers: ["Scheduled", "Vehicle", "Model", "Station", "Mode", "Status", "Risk", "Score", "Evidence", "Completed", "Summary"], rows: data.audits.filter((row) => row.scheduledFor >= from && row.scheduledFor <= to && inScope(row.stationCode) && includes(`${row.vehicleNo} ${row.auditMode} ${row.status} ${row.summary}`)).map((row) => [row.scheduledFor, row.vehicleNo, data.vehicles.find(v=>v.vehicleNo===row.vehicleNo)?.model || "Model not recorded", row.stationCode, label(row.auditMode), label(row.status), row.riskScore, row.score, row.evidenceCount, row.completedAt, row.summary]) };
    if (reportKey === "payments") return { title: "Vehicle payment report", subtitle, fileName: `fleet-payments-${from}-${to}`, headers: ["Request", "Work date", "Station", "Payment head", "Requested by", "Amount", "Status", "Remarks"], rows: data.payments.filter((row) => (row.workDate ?? row.requestedAt.slice(0, 10)) >= from && (row.workDate ?? row.requestedAt.slice(0, 10)) <= to && inScope(row.stationCode) && includes(`${row.requestNo} ${row.head} ${row.requestedBy} ${row.remarks}`)).map((row) => [row.requestNo, row.workDate ?? row.requestedAt.slice(0, 10), row.stationCode, row.head, row.requestedBy, row.amount, row.statusLabel, row.remarks]) };
    return { title: "Ad Hoc van and driver usage report", subtitle, fileName: `fleet-adhoc-${from}-${to}`, headers: ["Date", "Region", "Cluster", "Station", "Usage", "Request", "Reason", "Amount", "Status", "Source"], rows: data.adHocRows.filter((row) => row.date >= from && row.date <= to && inScope(row.stationCode) && includes(`${row.reference} ${row.paymentHeadName} ${row.reason} ${row.remark}`)).map((row) => [row.date, row.region, row.cluster, row.stationCode, row.paymentHeadName, row.reference, row.reason, row.amount, row.approvalStatus, row.source]) };
  }, [reportKey, data, from, to, stations, clusters, regions, search, stationByCode, dateError, snapshotReport, selected.label, historyReady, historyError]);

  const amount = report.rows.reduce((sum,row)=>sum+row.reduce<number>((subtotal,value,index)=>subtotal+(/amount/i.test(report.headers[index]||"")&&typeof value==="number"?value:0),0),0);
  const option = (values: string[]) => [...new Set(values.filter(Boolean))].sort().map((value) => ({ value, label: value }));
  const filteredStations = data.stationOptions.filter((station) => (!regions.length || regions.includes(station.region)) && (!clusters.length || clusters.includes(station.cluster)));
  const Icon = selected.icon;

  return <div className="fc-reports-workspace">
    <div className="fc-section-head"><div><span className="fc-eyebrow">Fleet intelligence</span><h1>Reports</h1><p>Download a filtered Excel workbook, branded image or PDF for every core Fleet workflow.</p></div>{historyReady && (!dateError || snapshotReport) ? <FleetExportButtons report={report} /> : null}</div>
    <section className="fc-report-catalog">{definitions.map((item) => { const ItemIcon = item.icon; return <button className={reportKey === item.key ? "active" : ""} key={item.key} onClick={() => setReportKey(item.key)} type="button"><span><ItemIcon size={17} /></span><div><strong>{item.label}</strong><small>{item.description}</small></div></button>; })}<a href="/fleet-control?section=tracking"><span><Gauge size={17} /></span><div><strong>Distance, fuel & mileage</strong><small>Use Tracking & Efficiency for vehicle and station date-range reports</small></div></a></section>
    {dateError && !snapshotReport ? <p role="alert" className="fc-inline-message error">{dateError}</p> : null}<p className="fc-panel-foot">{snapshotReport ? "Current snapshot; the date range does not change this report." : "Complete date-range history, paginated at source. Station grouping uses current placement. Missing GPS/status remain unrecorded."}</p>{!snapshotReport && !dateError && !historyReady ? <p role="status" className="fc-inline-message">{historyError || "Loading complete report…"}{historyError ? <button type="button" className="fc-button secondary" onClick={()=>setRetry(v=>v+1)}>Retry</button>:null}</p>:null}<section className="fc-report-builder fc-panel"><header><span><Icon size={19} /></span><div><small>Selected report</small><h2>{selected.label}</h2><p>{selected.description}</p></div>{historyReady && (!dateError || snapshotReport) ? <FleetExportButtons compact report={report} /> : null}</header><div className="fc-report-filters"><label><span>From</span><input disabled={snapshotReport} max={to || data.today} onChange={(event) => setFrom(event.target.value)} type="date" value={from} /></label><label><span>To</span><input disabled={snapshotReport} min={from} max={data.today} onChange={(event) => setTo(event.target.value)} type="date" value={to} /></label><FleetMultiSelect allLabel="All regions" label="Region" onChange={setRegions} options={option(data.stationOptions.map((item) => item.region))} values={regions} /><FleetMultiSelect allLabel="All clusters" label="Cluster" onChange={setClusters} options={option(data.stationOptions.map((item) => item.cluster))} values={clusters} /><FleetMultiSelect allLabel="All placements" label="Station" onChange={setStations} options={filteredStations.map((item) => ({ value: item.code, label: item.code, helper: item.name }))} values={stations} /><label className="fc-filter-search"><span>Search</span><div><Search size={14} /><input onChange={(event) => setSearch(event.target.value)} placeholder="Search this report" value={search} /></div></label></div>
      <div className="fc-report-summary"><article><CalendarDays size={17} /><span><small>Period</small><strong>{snapshotReport ? `As at ${data.today}` : `${from} – ${to}`}</strong></span></article><article><Activity size={17} /><span><small>Matching rows</small><strong>{historyReady ? report.rows.length.toLocaleString("en-IN") : "—"}</strong></span></article>{amount ? <article><CircleDollarSign size={17} /><span><small>Total amount</small><strong>{money(amount)}</strong></span></article> : null}</div>
      <div className="fc-table-scroll"><table><thead><tr>{report.headers.map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{report.rows.slice(page*100, (page+1)*100).map((row, index) => <tr key={index}>{row.map((value, column) => <td data-label={report.headers[column]} key={column}>{String(value ?? "—")}</td>)}</tr>)}</tbody></table></div>{report.rows.length > 100 ? <p className="fc-report-preview-note"><button type="button" disabled={!page} onClick={()=>setPage(v=>v-1)}>Previous</button> Page {page+1} of {Math.ceil(report.rows.length/100)} · Excel/PDF include all {report.rows.length} rows; image is a compact preview. <button type="button" disabled={(page+1)*100>=report.rows.length} onClick={()=>setPage(v=>v+1)}>Next</button></p> : null}{historyReady && !report.rows.length ? <div className="fc-empty"><Activity size={32} /><strong>No matching report rows</strong><p>Change the date or placement filters.</p></div> : null}
    </section>
  </div>;
}
