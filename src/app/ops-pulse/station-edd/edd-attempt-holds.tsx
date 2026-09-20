"use client";

import { useMemo, useState } from "react";
import type { EddPackage } from "@/lib/ops-pulse/edd-worker";
import { stationEddDate } from "@/lib/ops-pulse/station-edd";
import { selectEddHolds } from "@/lib/ops-pulse/edd-table-controls";
import { Field, TablePager, TableSearch } from "./edd-table-ui";
import { StationEddDownload } from "./station-edd-download";
import s from "./station-edd.module.css";

const labels = { hfr: "HFR · one attempt", hcr: "HCR · two or more", rejected: "Rejected", returningToFc: "In transit to FC", unknown: "Attempt count unconfirmed" } as const;
type Category = keyof typeof labels;
const stamp = (value?: string | null) => value ? new Date(value).toLocaleString("en-IN", {timeZone:"Asia/Kolkata",day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"}) : "Not recorded";

export function EddAttemptHolds({ packages, stationCode, now, onOpen }: { packages: EddPackage[]; stationCode: string; now: number; onOpen: (id: string) => void }) {
  const [open,setOpen] = useState(false);
  const [filter,setFilter] = useState<Category | "all">("all");
  const [query,setQuery] = useState("");
  const [sort,setSort] = useState("attempt");
  const [direction,setDirection] = useState("asc");
  const [page,setPage] = useState(1);
  const [size,setSize] = useState(25);
  const rows = useMemo(() => selectEddHolds(packages),[packages]);
  const filtered = useMemo(() => selectEddHolds(packages,filter,query,sort,direction),[packages,filter,query,sort,direction]);
  const current = Math.min(page,Math.max(1,Math.ceil(filtered.length/size)));
  function choose(value: Category | "all") { setFilter(value);setPage(1);setOpen(true); }
  return <section className={s.panel} aria-label="Attempt history and return holds">
    <div className={s.panelHead}><div><h2>HFR, HCR & returns</h2><p>All observed EDD dates · separate from fresh first-dispatch pending</p></div><button className={s.button} aria-expanded={open} aria-controls="edd-attempt-holds" onClick={()=>setOpen(!open)}>{open ? "Close" : "View details"}</button></div>
    <div className={s.inlineStats}>{(Object.entries(labels) as [Category,string][]).map(([key,label])=><button key={key} className={s.button} aria-pressed={open && filter===key} onClick={()=>choose(key)}>{label} <strong>{rows.filter(row=>row.category===key).length.toLocaleString("en-IN")}</strong></button>)}</div>
    {open ? <div id="edd-attempt-holds">
      <p className={s.tableHelp}>Counts use distinct outbound/attempt cycles, not duplicate scan rows. Rejected and delivered parcels are not HFR/HCR. A return receipt is not a new EDD. Incomplete histories show only a lower bound.</p>
      <div className={s.filterPanel}><div className={s.filterGrid}>
        <TableSearch label="Search holds" placeholder="Tracking ID, associate or status" value={query} onChange={value=>{setQuery(value);setPage(1);}}/>
        <Field label="Attempt category"><select className={s.select} value={filter} onChange={e=>choose(e.target.value as Category | "all")}><option value="all">All categories</option>{Object.entries(labels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></Field>
        <Field label="Sort holds"><select className={s.select} value={sort} onChange={e=>{setSort(e.target.value);setPage(1);}}><option value="attempt">Attempt time</option><option value="tid">Tracking ID</option><option value="state">Current status</option></select></Field>
        <Field label="Hold sort direction"><select className={s.select} value={direction} onChange={e=>{setDirection(e.target.value);setPage(1);}}><option value="asc">Ascending</option><option value="desc">Descending</option></select></Field>
      </div><div className={s.resultBar}><strong>{filtered.length.toLocaleString("en-IN")} matching parcels</strong><div className={s.actions}><button className={s.button} onClick={()=>{choose("all");setQuery("");setSort("attempt");setDirection("asc");}}>Reset filters</button><StationEddDownload href={"/api/ops-pulse/station-edd/report?"+new URLSearchParams({stationCode,report:"holds",category:filter,query,sort,direction})} label="Export matching holds" disabled={!filtered.length}/></div></div></div>
      <div className={s.tableWrap} role="region" aria-label="Attempt and hold details, scroll horizontally" tabIndex={0}><table className={s.table}><thead><tr><th>Tracking ID / EDD</th><th>Attempt category</th><th>Current source status</th><th>Distinct attempts</th><th>Second attempt · IST</th><th>Received back · IST</th><th>48-hour return observation</th></tr></thead><tbody>{filtered.slice((current-1)*size,current*size).map(row=>{
        const elapsed = row.returnedAt ? Math.max(0,now-Date.parse(row.returnedAt)) : null;
        const mismatch = row.pkg.verification?.routeStationCode && row.pkg.verification.routeStationCode !== stationCode;
        return <tr key={row.pkg.trackingId}><td><button className={s.tidButton} onClick={()=>onOpen(row.pkg.trackingId)}>{row.pkg.trackingId}</button><small className={s.cellSub}>{stationEddDate(row.pkg) || "EDD unconfirmed"}</small></td><td>{labels[row.category as Category]}</td><td>{row.state}{mismatch ? <small className={s.cellSub}>Route {row.pkg.verification!.routeStationCode} · location needs reconciliation</small> : null}</td><td>{row.complete ? row.observedAttempts : row.observedAttempts ? `${row.observedAttempts}+ observed` : "Unconfirmed"}</td><td>{stamp(row.secondAttemptAt)}</td><td>{stamp(row.returnedAt)}</td><td>{row.category !== "hcr" ? "—" : !row.atStation || mismatch ? "Station receipt not current/confirmed" : elapsed == null ? "Return time not recorded" : elapsed >= 48*3600000 ? "48h since return elapsed" : `${Math.ceil((48*3600000-elapsed)/3600000)}h to 48h since return`}<small className={s.cellSub}>{row.category === "returningToFc" ? "FC transit observed" : "Ready for FC not source-confirmed"}</small></td></tr>;
      })}</tbody></table></div>
      {!filtered.length ? <div className={s.empty}>No matching observed parcels. Missing history is not proof of no HFR/HCR.</div> : null}
      <TablePager count={filtered.length} page={current} size={size} onPage={setPage} onSize={value=>{setSize(Number(value));setPage(1);}} noun="parcels"/>
      <p className={s.tableHelp}>The 48-hour figure is explicitly measured from the recorded return receipt. The operational hold-start rule still needs confirmation. Elapsed time never changes a shipment to Ready for FC; that requires the source readiness status.</p>
    </div> : null}
  </section>;
}
