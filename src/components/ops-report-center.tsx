"use client";

import { useMemo, useState } from "react";
import { opsReportCatalog } from "@/lib/ops-pulse/report-catalog";

type Station = { code: string; name: string; cluster: string };
function today() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()); }

export function OpsReportCenter({ stations }: { stations: Station[] }) {
  const toDefault = today();
  const groups = [...new Set(opsReportCatalog.map((report) => report.group))];
  const [group, setGroup] = useState("Shipments");
  const reports = opsReportCatalog.filter((report) => report.group === group);
  const [type, setType] = useState<string>("shipment_station");
  const report = opsReportCatalog.find((item) => item.type === type) ?? reports[0];
  const [from, setFrom] = useState(`${toDefault.slice(0, 7)}-01`);
  const [to, setTo] = useState(toDefault);
  const [selected, setSelected] = useState(stations.map((row) => row.code));
  const [singleStation, setSingleStation] = useState(stations[0]?.code ?? "");
  const clusterOptions = useMemo(() => [...new Set(stations.map((row) => row.cluster).filter(Boolean))].sort(), [stations]);
  const needsSingleStation = "singleStation" in report && report.singleStation;
  const canDownload = Boolean(from && to && (needsSingleStation ? singleStation : selected.length));
  function changeGroup(next: string) {
    setGroup(next);
    setType(opsReportCatalog.find((item) => item.group === next)?.type ?? "");
  }
  function toggleCluster(cluster: string, checked: boolean) {
    const codes = stations.filter((row) => row.cluster === cluster).map((row) => row.code);
    setSelected((current) => checked ? [...new Set([...current, ...codes])] : current.filter((code) => !codes.includes(code)));
  }
  function href() {
    const params = new URLSearchParams({ type, from, to });
    params.set("stations", needsSingleStation ? singleStation : selected.join(","));
    return `/api/ops-pulse/reports/download?${params.toString()}`;
  }
  return <section className="ops-report-builder">
    <div className="ops-report-choice">
      <label>Report family<select value={group} onChange={(event) => changeGroup(event.target.value)}>{groups.map((item) => <option key={item}>{item}</option>)}</select></label>
      <label>Report<select value={type} onChange={(event) => setType(event.target.value)}>{reports.map((item) => <option key={item.type} value={item.type}>{item.title}</option>)}</select></label>
      <div className="ops-report-description"><strong>{report.title}</strong><span>{report.description}</span></div>
    </div>
    <div className="ops-report-parameters">
      <label>Quick month<input type="month" onChange={(event) => { const month = event.target.value; if (!/^\d{4}-\d{2}$/.test(month)) return; const end = new Date(`${month}-01T00:00:00Z`); end.setUTCMonth(end.getUTCMonth() + 1); end.setUTCDate(0); setFrom(`${month}-01`); setTo(end.toISOString().slice(0, 10)); }} /></label>
      <label>From<input type="date" value={from} onChange={(event) => setFrom(event.target.value)}/></label>
      <label>To<input type="date" value={to} onChange={(event) => setTo(event.target.value)}/></label>
      {needsSingleStation ? <label className="station-select">Station<select value={singleStation} onChange={(event) => setSingleStation(event.target.value)}>{stations.map((station) => <option key={station.code} value={station.code}>{station.code} · {station.name}</option>)}</select></label> :
      <details><summary><span>Stations</span><strong>{selected.length === stations.length ? "All permitted" : `${selected.length} selected`}</strong></summary><div className="ops-report-scope">
        <div><h4>Clusters</h4>{clusterOptions.map((cluster) => <label key={cluster}><input type="checkbox" onChange={(event) => toggleCluster(cluster, event.target.checked)}/>{cluster}</label>)}</div>
        <div><h4>Stations</h4>{stations.map((station) => <label key={station.code}><input type="checkbox" checked={selected.includes(station.code)} onChange={(event) => setSelected((current) => event.target.checked ? [...new Set([...current, station.code])] : current.filter((code) => code !== station.code))}/><span><b>{station.code}</b> {station.name}</span></label>)}</div>
        <footer><button type="button" onClick={() => setSelected(stations.map((row) => row.code))}>Select all</button><button type="button" onClick={() => setSelected([])}>Clear</button></footer>
      </div></details>}
      <a className={`button ops-report-download ${canDownload ? "" : "disabled"}`} href={canDownload ? href() : undefined}>Download {report.format}</a>
    </div>
  </section>;
}
