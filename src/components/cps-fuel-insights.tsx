"use client";
import { useState } from "react";
import { cpsFuelTrend } from "@/lib/ops-pulse/cps-details";
import { ratio, type CpsSnapshot } from "@/lib/ops-pulse/cps";
const money=(n:number|null)=>n==null?"—":`₹${n.toLocaleString("en-IN",{maximumFractionDigits:2})}`;
export function CpsFuelInsights({snapshot}:{snapshot:CpsSnapshot}) {
  const days=cpsFuelTrend(snapshot),[selected,setSelected]=useState<string|null>(null);
  const amount=days.reduce((n,d)=>n+d.amount,0), deliveries=days.reduce((n,d)=>n+d.deliveries,0);
  const max=Math.max(...days.map(d=>Math.abs(d.amount)),1);
  const current=days.find(d=>d.date===selected)??days.reduce<(typeof days)[number]|undefined>((peak,d)=>!peak||d.amount>peak.amount?d:peak,undefined);
  const sources=new Map<string,number>();for(const d of days) for(const s of d.sources)sources.set(s.label,(sources.get(s.label)??0)+s.amount);
  return <section className="cps-fuel-insights" aria-label="Fuel spend trend">
    <div className="panel-head"><div><h3>Fuel spend & daily trend</h3><p>IOCL, BPCL, cashbook and DA fuel components in this selection. Select a day for its source breakdown.</p></div></div>
    <div className="cps-da-metrics"><span>Total fuel<strong>{money(amount)}</strong></span><span>Fuel per delivered shipment<strong>{money(ratio(amount,deliveries))}</strong></span><span>Average per calendar day<strong>{money(days.length?amount/days.length:null)}</strong></span></div>
    {!sources.size?<p className="cps-footnote">No fuel expense recorded in this period.</p>:<>
      <div className="cps-fuel-sources">{[...sources].map(([label,value])=><span key={label}>{label}<strong>{money(value)}</strong></span>)}</div>
      <div className="cps-fuel-chart" role="group" aria-label="Daily fuel expense; choose a date">{days.map(d=><button type="button" key={d.date} onClick={()=>setSelected(d.date)} aria-pressed={current?.date===d.date} aria-label={`${d.date}: ${money(d.amount)} fuel, ${d.deliveries} delivered`} title={`${d.date} · ${money(d.amount)}`}><span className="cps-fuel-bar-track"><i style={{height:`${Math.max(2,Math.abs(d.amount)/max*100)}%`}}/></span><small>{d.date.slice(8)}</small></button>)}</div>
      {current&&<div className="cps-fuel-day"><strong>{current.date} · {money(current.amount)}</strong><span>{current.deliveries.toLocaleString("en-IN")} delivered · {money(current.cps)} fuel CPS</span>{current.sources.map(s=><small key={s.label}>{s.label}: {money(s.amount)}</small>)}</div>}
    </>}
    <p className="cps-footnote">Trend reflects expense booking dates, not daily fuel consumption. Bulk refuels may create spikes. Fuel CPS uses delivered shipments; kilometres and mileage are not inferred.</p>
  </section>;
}
