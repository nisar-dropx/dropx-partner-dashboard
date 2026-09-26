"use client";

import { Activity, ArrowDownUp, CalendarDays, Download, RefreshCw, Search, Truck, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { Fragment, useEffect, useMemo, useState } from "react";
import type { FleetControlAdHocRow } from "@/lib/fleet-control";

const money = (value: number) => `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
const labelDate = (value: string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }).format(new Date(`${value}T12:00:00+05:30`));
const csvCell = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;

function download(name: string, rows: unknown[][]) {
  const content = "\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type StationSummary = {
  code: string;
  name: string;
  vanCount: number;
  vanAmount: number;
  driverCount: number;
  driverAmount: number;
  totalCount: number;
  totalAmount: number;
  rows: FleetControlAdHocRow[];
};

export function FleetAdHocCapacity({ rows, today }: { rows: FleetControlAdHocRow[]; today: string }) {
  const router = useRouter();
  const [view, setView] = useState<"summary" | "live">("summary");
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const [liveDate, setLiveDate] = useState(today);
  const [station, setStation] = useState("");
  const [requestType, setRequestType] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ key: keyof Pick<StationSummary, "code" | "vanCount" | "vanAmount" | "driverCount" | "driverAmount" | "totalCount" | "totalAmount">; direction: "asc" | "desc" }>({ key: "totalAmount", direction: "desc" });
  const [expanded, setExpanded] = useState("");

  useEffect(() => {
    if (view !== "live") return;
    const timer = window.setInterval(() => router.refresh(), 60_000);
    return () => window.clearInterval(timer);
  }, [router, view]);

  const stationOptions = [...new Set(rows.map((row) => row.stationCode))].sort();
  const rangeRows = useMemo(() => rows.filter((row) => row.date >= from && row.date <= to && (!station || row.stationCode === station) && (!requestType || row.requestType === requestType) && (!search.trim() || `${row.stationCode} ${row.stationName} ${row.reference} ${row.reason} ${row.remark}`.toLowerCase().includes(search.trim().toLowerCase()))), [rows, from, to, station, requestType, search]);
  const liveRows = useMemo(() => rows.filter((row) => row.date === liveDate && (!station || row.stationCode === station) && (!requestType || row.requestType === requestType) && (!search.trim() || `${row.stationCode} ${row.stationName} ${row.reference} ${row.reason} ${row.remark}`.toLowerCase().includes(search.trim().toLowerCase()))).sort((a, b) => a.stationCode.localeCompare(b.stationCode) || a.requestType.localeCompare(b.requestType)), [rows, liveDate, station, requestType, search]);
  const summary = useMemo(() => {
    const grouped = new Map<string, StationSummary>();
    for (const row of rangeRows) {
      const item = grouped.get(row.stationCode) ?? { code: row.stationCode, name: row.stationName, vanCount: 0, vanAmount: 0, driverCount: 0, driverAmount: 0, totalCount: 0, totalAmount: 0, rows: [] };
      if (row.requestType === "Van") { item.vanCount++; item.vanAmount += row.amount; }
      else { item.driverCount++; item.driverAmount += row.amount; }
      item.totalCount++; item.totalAmount += row.amount; item.rows.push(row); grouped.set(row.stationCode, item);
    }
    return [...grouped.values()].sort((a, b) => {
      const av = a[sort.key], bv = b[sort.key];
      const order = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
      return order * (sort.direction === "asc" ? 1 : -1) || a.code.localeCompare(b.code);
    });
  }, [rangeRows, sort]);

  const vanRows = rangeRows.filter((row) => row.requestType === "Van");
  const driverRows = rangeRows.filter((row) => row.requestType === "Driver");
  const sortBy = (key: typeof sort.key) => setSort((current) => ({ key, direction: current.key === key && current.direction === "desc" ? "asc" : "desc" }));

  return <div className="fc-adhoc-workspace">
    <div className="fc-section-head"><div><span className="fc-eyebrow">Operations demand · visibility only</span><h1>Ad-hoc capacity</h1><p>Van and driver requests show where extra capacity is being used. Approval remains with Operations.</p></div><div className="fc-view-switch compact"><button className={view === "summary" ? "active" : ""} onClick={() => setView("summary")} type="button">Station summary</button><button className={view === "live" ? "active" : ""} onClick={() => setView("live")} type="button"><i className="fc-live-dot" /> Live requests</button></div></div>
    <section className="fc-adhoc-filters">
      {view === "summary" ? <><label><span>From</span><input max={today} onChange={(event) => setFrom(event.target.value)} type="date" value={from} /></label><label><span>To</span><input max={today} onChange={(event) => setTo(event.target.value)} type="date" value={to} /></label><button onClick={() => { setFrom(`${today.slice(0, 7)}-01`); setTo(today); }} type="button">MTD</button><button onClick={() => { setFrom(today); setTo(today); }} type="button">Today</button></> : <label><span>Request date</span><input max={today} onChange={(event) => setLiveDate(event.target.value)} type="date" value={liveDate} /></label>}
      <label><span>Vehicle placement</span><select onChange={(event) => setStation(event.target.value)} value={station}><option value="">All placements</option>{stationOptions.map((value) => <option key={value}>{value}</option>)}</select></label>
      <label><span>Request type</span><select onChange={(event) => setRequestType(event.target.value)} value={requestType}><option value="">Van + Driver</option><option value="Van">Van request</option><option value="Driver">Driver request</option></select></label>
      <label className="fc-filter-search"><span>Search</span><div><Search size={14} /><input onChange={(event) => setSearch(event.target.value)} placeholder="Request or reason" value={search} /></div></label>
      {view === "live" ? <button className="fc-refresh-small" onClick={() => router.refresh()} type="button"><RefreshCw size={14} /> Refresh</button> : null}
    </section>

    {view === "summary" ? <>
      <section className="fc-adhoc-kpis">
        <article className="van"><Truck size={19} /><div><small>Van requests</small><strong>{vanRows.length}</strong><p>{money(vanRows.reduce((sum, row) => sum + row.amount, 0))}</p></div></article>
        <article className="driver"><Users size={19} /><div><small>Driver requests</small><strong>{driverRows.length}</strong><p>{money(driverRows.reduce((sum, row) => sum + row.amount, 0))}</p></div></article>
        <article><Activity size={19} /><div><small>Total jobs</small><strong>{rangeRows.length}</strong><p>{new Set(rangeRows.map((row) => row.stationCode)).size} placements</p></div></article>
        <article className="total"><CalendarDays size={19} /><div><small>Total recorded amount</small><strong>{money(rangeRows.reduce((sum, row) => sum + row.amount, 0))}</strong><p>{labelDate(from)}–{labelDate(to)}</p></div></article>
      </section>
      <div className="fc-table-panel"><div className="fc-table-toolbar"><span>Station summary</span><button onClick={() => download(`adhoc-capacity-${from}-${to}.csv`, [["Station", "Station name", "Van requests", "Van amount", "Driver requests", "Driver amount", "Total jobs", "Total amount"], ...summary.map((row) => [row.code, row.name, row.vanCount, row.vanAmount, row.driverCount, row.driverAmount, row.totalCount, row.totalAmount])])} type="button"><Download size={15} /> Download CSV</button></div><div className="fc-table-scroll"><table><thead><tr><th><button onClick={() => sortBy("code")} type="button">Station <ArrowDownUp size={11} /></button></th><th><button onClick={() => sortBy("vanCount")} type="button">Van requests <ArrowDownUp size={11} /></button></th><th><button onClick={() => sortBy("vanAmount")} type="button">Van amount <ArrowDownUp size={11} /></button></th><th><button onClick={() => sortBy("driverCount")} type="button">Driver requests <ArrowDownUp size={11} /></button></th><th><button onClick={() => sortBy("driverAmount")} type="button">Driver amount <ArrowDownUp size={11} /></button></th><th><button onClick={() => sortBy("totalCount")} type="button">Total jobs <ArrowDownUp size={11} /></button></th><th><button onClick={() => sortBy("totalAmount")} type="button">Total amount <ArrowDownUp size={11} /></button></th></tr></thead><tbody>{summary.map((row) => <Fragment key={row.code}><tr className="fc-clickable-row" onClick={() => setExpanded((value) => value === row.code ? "" : row.code)}><td><strong>{row.code}</strong><small className="fc-cell-note">{row.name}</small></td><td>{row.vanCount}</td><td>{money(row.vanAmount)}</td><td>{row.driverCount}</td><td>{money(row.driverAmount)}</td><td><strong>{row.totalCount}</strong></td><td><strong>{money(row.totalAmount)}</strong></td></tr>{expanded === row.code ? <tr className="fc-expanded-row"><td colSpan={7}><div><strong>Daily breakup</strong>{[...new Map(row.rows.map((item) => [item.date, row.rows.filter((candidate) => candidate.date === item.date)])).entries()].map(([day, items]) => <p key={day}><span>{labelDate(day)}</span><b>{items.filter((item) => item.requestType === "Van").length} vans · {items.filter((item) => item.requestType === "Driver").length} drivers</b><strong>{money(items.reduce((sum, item) => sum + item.amount, 0))}</strong></p>)}</div></td></tr> : null}</Fragment>)}</tbody></table></div>{!summary.length ? <div className="fc-empty"><Activity size={34} /><strong>No requests in this range</strong><p>Change dates or clear the filters.</p></div> : null}</div>
    </> : <div className="fc-table-panel"><div className="fc-table-toolbar"><span>{liveRows.length} requests on {labelDate(liveDate)}</span><button onClick={() => download(`adhoc-live-${liveDate}.csv`, [["Date", "Placement", "Type", "Reference", "Reason", "Remark", "Source", "Amount"], ...liveRows.map((row) => [row.date, row.stationCode, row.requestType, row.reference, row.reason, row.remark, row.source, row.amount])])} type="button"><Download size={15} /> Download CSV</button></div><div className="fc-table-scroll"><table><thead><tr><th>Date</th><th>Placement</th><th>Request type</th><th>Request</th><th>Reason</th><th>Operational remark</th><th>Source</th><th>Amount</th></tr></thead><tbody>{liveRows.map((row) => <tr key={`${row.id}-${row.date}`}><td>{labelDate(row.date)}</td><td><b className="fc-station-chip">{row.stationCode}</b><small className="fc-cell-note">{row.stationName}</small></td><td><span className={`fc-request-type ${row.requestType.toLowerCase()}`}>{row.requestType}</span></td><td><strong>{row.reference}</strong></td><td>{row.reason}</td><td className="fc-wide-cell">{row.remark}</td><td><span className="fc-source">{row.source}</span></td><td><strong>{money(row.amount)}</strong></td></tr>)}</tbody></table></div>{!liveRows.length ? <div className="fc-empty"><Activity size={34} /><strong>No van or driver requests</strong><p>No submitted request matches this date and filters.</p></div> : null}</div>}
  </div>;
}
