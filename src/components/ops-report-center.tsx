"use client";

import { useMemo, useState } from "react";
import { reportsForWorkspace, type ReportWorkspace } from "@/lib/ops-pulse/report-catalog";
import styles from "./ops-report-center.module.css";

type Station = { code: string; name: string; city: string; cluster: string };
function today() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()); }

export function OpsReportCenter({ stations, workspace, canViewCpu }: { stations: Station[]; workspace: ReportWorkspace; canViewCpu: boolean }) {
  const toDefault = today();
  const isDs = workspace === "ds";
  const catalog = reportsForWorkspace(workspace, canViewCpu);
  const groups = [...new Set(catalog.map((report) => report.group))];
  const initialReport = catalog.find((report) => report.type === (isDs ? "attendance" : "shipment_station")) ?? catalog[0];
  const [type, setType] = useState<string>(initialReport.type);
  const report = catalog.find((item) => item.type === type) ?? initialReport;
  const reports = catalog.filter((item) => item.group === report.group);
  const [from, setFrom] = useState(`${toDefault.slice(0, 7)}-01`);
  const [to, setTo] = useState(toDefault);
  const [selected, setSelected] = useState(stations.map((row) => row.code));
  const [singleStation, setSingleStation] = useState(stations[0]?.code ?? "");
  const [area, setArea] = useState("");
  const [query, setQuery] = useState("");
  const areaOf = (station: Station) => isDs ? station.city : station.cluster;
  const areaOptions = useMemo(() => [...new Set(stations.map((row) => isDs ? row.city : row.cluster).filter(Boolean))].sort(), [stations, isDs]);
  const areaStations = stations.filter((station) => !area || areaOf(station) === area);
  const visibleStations = areaStations.filter((station) => `${station.code} ${station.name} ${station.city}`.toLowerCase().includes(query.trim().toLowerCase()));
  const needsSingleStation = "singleStation" in report && report.singleStation;
  const selectedCodes = selected.filter((code) => areaStations.some((station) => station.code === code));
  const days = (Date.parse(to) - Date.parse(from)) / 86400000;
  const validDates = Boolean(from && to && Number.isFinite(days) && days >= 0 && days <= 366);
  const canDownload = validDates && Boolean(needsSingleStation ? singleStation : selectedCodes.length);
  const params = new URLSearchParams({ type: report.type, from, to, workspace, stations: needsSingleStation ? singleStation : selectedCodes.join(",") });
  const locationWord = isDs ? "store" : "station";

  return <section className={styles.panel} aria-label={isDs ? "Dark Store report downloads" : "Report downloads"}>
    <div className={styles.choice}>
      <label>Report family<select value={report.group} onChange={(event) => setType(catalog.find((item) => item.group === event.target.value)!.type)}>{groups.map((item) => <option key={item}>{item}</option>)}</select></label>
      <label>Report<select value={report.type} onChange={(event) => setType(event.target.value)}>{reports.map((item) => <option key={item.type} value={item.type}>{item.title}</option>)}</select></label>
      <div className={styles.description}><strong>{report.title}</strong><span>{report.description}</span></div>
    </div>
    <div className={styles.dates}>
      <label>Quick month<input type="month" onChange={(event) => { const month = event.target.value; if (!/^\d{4}-\d{2}$/.test(month)) return; const end = new Date(`${month}-01T00:00:00Z`); end.setUTCMonth(end.getUTCMonth() + 1); end.setUTCDate(0); setFrom(`${month}-01`); setTo(end.toISOString().slice(0, 10)); }} /></label>
      <label>From<input type="date" value={from} onChange={(event) => setFrom(event.target.value)}/></label>
      <label>To<input type="date" value={to} onChange={(event) => setTo(event.target.value)}/></label>
      {!needsSingleStation && <label>{isDs ? "City" : "Cluster manager"}<select value={area} onChange={(event) => { const value = event.target.value; setArea(value); setSelected(stations.filter((station) => !value || areaOf(station) === value).map((station) => station.code)); }}><option value="">{isDs ? "All cities" : "All cluster managers"}</option>{areaOptions.map((item) => <option key={item}>{item}</option>)}</select></label>}
    </div>
    {needsSingleStation ? <label className={styles.single}>Station<select value={singleStation} onChange={(event) => setSingleStation(event.target.value)}>{stations.map((station) => <option key={station.code} value={station.code}>{station.code} · {station.name}</option>)}</select></label> :
      <details className={styles.scope} open={isDs ? true : undefined}>
        <summary><strong>{isDs ? "Stores" : "Stations"}</strong><span>{selectedCodes.length} of {areaStations.length} selected</span></summary>
        <div className={styles.tools}>
          <input aria-label={`Search ${locationWord}s`} placeholder={`Search ${locationWord} code, name or city`} value={query} onChange={(event) => setQuery(event.target.value)}/>
          <button type="button" onClick={() => setSelected([...new Set([...selected, ...visibleStations.map((row) => row.code)])])}>Select shown</button>
          <button type="button" onClick={() => setSelected([])}>Clear</button>
        </div>
        <div className={styles.stores}>
          {visibleStations.map((station) => <label key={station.code}><input type="checkbox" checked={selectedCodes.includes(station.code)} onChange={(event) => setSelected((current) => event.target.checked ? [...new Set([...current, station.code])] : current.filter((code) => code !== station.code))}/><span><b>{station.code}</b><span>{station.name}</span>{station.city && station.city !== station.name && <small>{station.city}</small>}</span></label>)}
          {!visibleStations.length && <p>No {locationWord}s match your search.</p>}
        </div>
      </details>}
    <footer className={styles.footer}>
      <span role="status">{!stations.length ? `No authorized ${locationWord}s available.` : !validDates ? "Choose a valid date range of up to 366 days." : !canDownload ? `Select at least one ${locationWord}.` : `${needsSingleStation ? 1 : selectedCodes.length} ${locationWord}${!needsSingleStation && selectedCodes.length !== 1 ? "s" : ""} · ${from} to ${to}`}</span>
      <a className={styles.download} aria-disabled={!canDownload} tabIndex={canDownload ? undefined : -1} href={canDownload ? `/api/ops-pulse/reports/download?${params}` : undefined}>Download {report.format}</a>
    </footer>
  </section>;
}
