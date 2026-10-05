"use client";
import { useState } from "react";
import type { AdvertisingDetail } from "@/lib/ops-pulse/advertising";
const money=(n:number)=>`₹${n.toLocaleString("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
export function AdvertisingBreakdown({rows}:{rows:AdvertisingDetail[]}) {
 const [view,setView]=useState("ad"),[search,setSearch]=useState("");
 const groups=new Map<string,{label:string;station:string;amount:number;days:Set<string>}>();
 for(const row of rows){
  if(!`${row.ad_name} ${row.ad_id} ${row.station_code}`.toLowerCase().includes(search.toLowerCase()))continue;
  const label=view==="day"?row.spend_date:view==="month"?row.spend_date.slice(0,7):`${row.ad_name||"Meta ad"} · ${row.ad_id}`;
  const key=`${row.station_code}|${label}`,group=groups.get(key)??{label,station:row.station_code,amount:0,days:new Set<string>()};
  group.amount+=Number(row.spend);group.days.add(row.spend_date);groups.set(key,group);
 }
 return <div style={{padding:"1rem"}}><p>Actual Meta spend on each ad-account day (India time, INR). Monthly totals sum these daily costs. Budgets and lifetime spend are not used.</p><div style={{display:"flex",flexWrap:"wrap",gap:8,marginBlock:12}}><select aria-label="Advertising breakdown" value={view} onChange={e=>setView(e.target.value)}><option value="ad">By ad</option><option value="day">By day</option><option value="month">By month</option></select><input aria-label="Search advertising" placeholder="Search ad or station" value={search} onChange={e=>setSearch(e.target.value)}/></div><div style={{overflowX:"auto"}}><table style={{width:"100%"}}><thead><tr><th>{view==="ad"?"Ad / ID":"Period"}</th><th>Station</th><th>Spend days</th><th>Actual expense</th></tr></thead><tbody>{[...groups.values()].sort((a,b)=>a.label.localeCompare(b.label)).map(g=><tr key={`${g.station}|${g.label}`}><td>{g.label}</td><td>{g.station==="@corporate"?"Corporate / HO":g.station||"Mapping pending"}</td><td>{g.days.size}</td><td>{money(g.amount)}</td></tr>)}</tbody><tfoot><tr><th colSpan={3}>Meta advertising total</th><th>{money([...groups.values()].reduce((s,r)=>s+r.amount,0))}</th></tr></tfoot></table></div>{!rows.length&&<p>No synced Meta spend for these station dates. Check Advertising Master for source coverage.</p>}</div>;
}
