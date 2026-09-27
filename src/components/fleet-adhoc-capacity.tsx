"use client";

import { Activity, ArrowDownUp, CalendarDays, Download, RefreshCw, Search, Truck, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { FleetMultiSelect } from "@/components/fleet-multi-select";
import type { FleetControlAdHocRow, FleetControlData } from "@/lib/fleet-control";

const money = (value: number) => `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
const labelDate = (value: string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }).format(new Date(`${value}T12:00:00+05:30`));
const csvCell = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;

function download(name: string, rows: unknown[][]) {
  const content = "\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type SortKey = "date" | "station" | "type" | "head" | "amount";

function RequestTable({ emptyText, fileName, rows, sort, setSort, title }: {
  emptyText: string;
  fileName: string;
  rows: FleetControlAdHocRow[];
  sort: { key: SortKey; direction: "asc" | "desc" };
  setSort: (key: SortKey) => void;
  title: string;
}) {
  const sorted = useMemo(() => [...rows].sort((a, b) => {
    const left = sort.key === "station" ? a.stationCode : sort.key === "type" ? a.requestType : sort.key === "head" ? a.paymentHeadName : sort.key === "amount" ? a.amount : a.date;
    const right = sort.key === "station" ? b.stationCode : sort.key === "type" ? b.requestType : sort.key === "head" ? b.paymentHeadName : sort.key === "amount" ? b.amount : b.date;
    const order = typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right));
    return order * (sort.direction === "asc" ? 1 : -1) || a.stationCode.localeCompare(b.stationCode);
  }), [rows, sort]);
  const sortButton = (key: SortKey, label: string) => <button onClick={() => setSort(key)} type="button">{label}<ArrowDownUp size={11} /></button>;

  return <div className="fc-table-panel fc-adhoc-grid"><div className="fc-table-toolbar"><span>{title}<small> · {rows.length} requests · {money(rows.reduce((sum, row) => sum + row.amount, 0))}</small></span><button onClick={() => download(fileName, [["Date", "Region", "Cluster", "Placement", "Payment head", "Request type", "Request", "Reason", "Operational remark", "Source", "Amount"], ...sorted.map((row) => [row.date, row.region, row.cluster, row.stationCode, row.paymentHeadName, row.requestType, row.reference, row.reason, row.remark, row.source, row.amount])])} type="button"><Download size={15} /> Download CSV</button></div><div className="fc-table-scroll"><table><thead><tr><th>{sortButton("date", "Date")}</th><th>{sortButton("station", "Placement")}</th><th>{sortButton("head", "Payment head")}</th><th>{sortButton("type", "Request type")}</th><th>Request</th><th>Reason</th><th>Operational remark</th><th>Source</th><th>{sortButton("amount", "Amount")}</th></tr></thead><tbody>{sorted.map((row) => <tr key={`${row.id}-${row.date}-${row.source}`}><td>{labelDate(row.date)}</td><td><b className="fc-station-chip">{row.stationCode}</b><small className="fc-cell-note">{row.cluster} · {row.region}</small></td><td><strong>{row.paymentHeadName}</strong></td><td><span className={`fc-request-type ${row.requestType.toLowerCase()}`}>{row.requestType}</span></td><td><strong>{row.reference}</strong></td><td>{row.reason}</td><td className="fc-wide-cell">{row.remark}</td><td><span className="fc-source">{row.source}</span></td><td><strong>{money(row.amount)}</strong></td></tr>)}</tbody></table></div>{!rows.length ? <div className="fc-empty"><Activity size={34} /><strong>{emptyText}</strong><p>Change the dates or clear one of the filters.</p></div> : null}</div>;
}

export function FleetAdHocCapacity({ rows, stationOptions, today }: { rows: FleetControlAdHocRow[]; stationOptions: FleetControlData["stationOptions"]; today: string }) {
  const router = useRouter();
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const [liveDate, setLiveDate] = useState(today);
  const [stations, setStations] = useState<string[]>([]);
  const [clusters, setClusters] = useState<string[]>([]);
  const [regions, setRegions] = useState<string[]>([]);
  const [requestTypes, setRequestTypes] = useState<string[]>([]);
  const [paymentHeads, setPaymentHeads] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [liveSort, setLiveSort] = useState<{ key: SortKey; direction: "asc" | "desc" }>({ key: "station", direction: "asc" });
  const [allSort, setAllSort] = useState<{ key: SortKey; direction: "asc" | "desc" }>({ key: "date", direction: "desc" });

  useEffect(() => {
    const timer = window.setInterval(() => router.refresh(), 60_000);
    return () => window.clearInterval(timer);
  }, [router]);

  const stationByCode = useMemo(() => new Map(stationOptions.map((station) => [station.code, station])), [stationOptions]);
  const option = (values: string[]) => [...new Set(values.filter(Boolean))].sort().map((value) => ({ value, label: value }));
  const clusterOptions = option(stationOptions.map((station) => station.cluster));
  const regionOptions = option(stationOptions.map((station) => station.region));
  const filteredStationOptions = stationOptions.filter((station) => (!clusters.length || clusters.includes(station.cluster)) && (!regions.length || regions.includes(station.region))).map((station) => ({ value: station.code, label: station.code, helper: station.name }));
  const paymentHeadOptions = [...new Map(rows.map((row) => [row.paymentHeadCode || row.paymentHeadName, { value: row.paymentHeadCode || row.paymentHeadName, label: row.paymentHeadName }])).values()].sort((a, b) => a.label.localeCompare(b.label));
  const needle = search.trim().toLowerCase();
  const matches = (row: FleetControlAdHocRow) => {
    const station = stationByCode.get(row.stationCode);
    return (!stations.length || stations.includes(row.stationCode))
      && (!clusters.length || clusters.includes(row.cluster || station?.cluster || "Unassigned cluster"))
      && (!regions.length || regions.includes(row.region || station?.region || "Unassigned region"))
      && (!requestTypes.length || requestTypes.includes(row.requestType))
      && (!paymentHeads.length || paymentHeads.includes(row.paymentHeadCode || row.paymentHeadName))
      && (!needle || `${row.stationCode} ${row.stationName} ${row.cluster} ${row.region} ${row.paymentHeadName} ${row.reference} ${row.reason} ${row.remark}`.toLowerCase().includes(needle));
  };
  const liveRows = rows.filter((row) => row.date === liveDate && matches(row));
  const rangeRows = rows.filter((row) => row.date >= from && row.date <= to && matches(row));
  const vanRows = rangeRows.filter((row) => row.requestType === "Van");
  const driverRows = rangeRows.filter((row) => row.requestType === "Driver");
  const changeSort = (setter: typeof setLiveSort) => (key: SortKey) => setter((current) => ({ key, direction: current.key === key && current.direction === "desc" ? "asc" : "desc" }));
  const clear = () => { setStations([]); setClusters([]); setRegions([]); setRequestTypes([]); setPaymentHeads([]); setSearch(""); };

  return <div className="fc-adhoc-workspace">
    <div className="fc-section-head"><div><span className="fc-eyebrow">Operations demand · visibility only</span><h1>Ad-hoc capacity</h1><p>Live van and driver requests appear first. Fleet can monitor usage; approval remains with Operations.</p></div><button className="fc-button secondary" onClick={() => router.refresh()} type="button"><RefreshCw size={15} /> Refresh live</button></div>
    <section className="fc-adhoc-filters fc-filter-grid">
      <FleetMultiSelect allLabel="All regions" label="Region" onChange={setRegions} options={regionOptions} values={regions} />
      <FleetMultiSelect allLabel="All clusters" label="Cluster" onChange={setClusters} options={clusterOptions} values={clusters} />
      <FleetMultiSelect allLabel="All placements" label="Station" onChange={setStations} options={filteredStationOptions} values={stations} />
      <FleetMultiSelect allLabel="All payment heads" label="Payment head" onChange={setPaymentHeads} options={paymentHeadOptions} values={paymentHeads} />
      <FleetMultiSelect allLabel="Van + Driver" label="Request type" onChange={setRequestTypes} options={[{ value: "Van", label: "Ad-hoc van" }, { value: "Driver", label: "Ad-hoc driver" }]} searchable={false} values={requestTypes} />
      <label className="fc-filter-search"><span>Search</span><div><Search size={14} /><input onChange={(event) => setSearch(event.target.value)} placeholder="Request, reason or remark" value={search} /></div></label>
      <button onClick={clear} type="button">Clear filters</button>
    </section>
    <section className="fc-grid-datebar"><div><strong>Live requests</strong><span>Auto-refreshes every minute</span></div><label><span>Request date</span><input max={today} onChange={(event) => setLiveDate(event.target.value)} type="date" value={liveDate} /></label></section>
    <RequestTable emptyText="No live van or driver request" fileName={`adhoc-live-${liveDate}.csv`} rows={liveRows} setSort={changeSort(setLiveSort)} sort={liveSort} title={`Live requests · ${labelDate(liveDate)}`} />

    <section className="fc-grid-datebar fc-history-datebar"><div><strong>Entire request data</strong><span>Submitted usage across the selected date range</span></div><div className="fc-date-pair"><label><span>From</span><input max={today} onChange={(event) => setFrom(event.target.value)} type="date" value={from} /></label><label><span>To</span><input max={today} onChange={(event) => setTo(event.target.value)} type="date" value={to} /></label><button onClick={() => { setFrom(`${today.slice(0, 7)}-01`); setTo(today); }} type="button">MTD</button><button onClick={() => { setFrom(today); setTo(today); }} type="button">Today</button></div></section>
    <section className="fc-adhoc-kpis">
      <article className="van"><Truck size={19} /><div><small>Van requests</small><strong>{vanRows.length}</strong><p>{money(vanRows.reduce((sum, row) => sum + row.amount, 0))}</p></div></article>
      <article className="driver"><Users size={19} /><div><small>Driver requests</small><strong>{driverRows.length}</strong><p>{money(driverRows.reduce((sum, row) => sum + row.amount, 0))}</p></div></article>
      <article><Activity size={19} /><div><small>Total jobs</small><strong>{rangeRows.length}</strong><p>{new Set(rangeRows.map((row) => row.stationCode)).size} placements</p></div></article>
      <article className="total"><CalendarDays size={19} /><div><small>Total recorded amount</small><strong>{money(rangeRows.reduce((sum, row) => sum + row.amount, 0))}</strong><p>{labelDate(from)}–{labelDate(to)}</p></div></article>
    </section>
    <RequestTable emptyText="No request data in this range" fileName={`adhoc-capacity-${from}-${to}.csv`} rows={rangeRows} setSort={changeSort(setAllSort)} sort={allSort} title={`${labelDate(from)}–${labelDate(to)}`} />
  </div>;
}
