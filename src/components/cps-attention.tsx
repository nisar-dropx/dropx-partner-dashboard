"use client";
import { useState } from "react";
import { cpsReviewItems, type CpsPlace, type CpsSnapshot } from "@/lib/ops-pulse/cps";
import { SearchableSelect } from "./searchable-select";

const category = (kind: string) => /attendance|low deliveries/i.test(kind) ? "Attendance & fixed pay" : /unmapped|mapping|identity|provider id/i.test(kind) ? "ID mapping" : /rate|payment setup|production|minimum/i.test(kind) ? "Rate cards & payment inputs" : /bill/i.test(kind) ? "Bills & service dates" : "Other cost setup";
export function CpsAttention({ snapshot, places, initialStation, canResolve, onOpen }: { snapshot:CpsSnapshot; places:CpsPlace[]; initialStation?:string; canResolve:boolean; onOpen:(station:string,head?:"Other")=>void }) {
  const [region,setRegion]=useState("");
  const [cluster,setCluster]=useState("");
  const [station,setStation]=useState(initialStation||"");
  const [section,setSection]=useState("All issues");
  const [search,setSearch]=useState("");
  const {gaps,bills}=cpsReviewItems(snapshot);
  const byCode=new Map(places.map(p=>[p.code,p]));
  const placeFor=(code:string)=>{const p=byCode.get(code);return (p?.parent?byCode.get(p.parent):p)||p;};
  const issues=[...gaps.map(g=>({key:g.key,station:g.station_code,kind:g.kind,id:g.dropx_id,provider:g.provider_id,name:g.name,from:g.first_date,to:g.last_date,owner:g.owner,href:g.href,bill:false})),...bills.map(b=>({key:`bill|${b.source}|${b.source_id}`,station:b.station_code,kind:"Billing period unconfirmed",id:b.reference,provider:"",name:b.label,from:b.period_from,to:b.period_to,owner:"Finance billing",href:"",bill:true}))];
  const scoped=issues.filter(i=>{const p=placeFor(i.station);return (!station||i.station===station||p?.code===station)&&(!region||(p?.region||"Unassigned")===region)&&(!cluster||(p?.cluster||"Unassigned")===cluster)&&`${i.station} ${i.id} ${i.provider} ${i.name} ${i.kind}`.toLowerCase().includes(search.toLowerCase());});
  const categories=["All issues",...new Set(issues.map(i=>category(i.kind)))];
  const visible=scoped.filter(i=>section==="All issues"||category(i.kind)===section);
  const options=(field:"region"|"cluster")=>[...new Set(places.map(p=>placeFor(p.code)?.[field]||"Unassigned"))].sort();
  return <section className="panel cps-attention" aria-label="CPS needs attention">
    <div className="panel-head"><div><h2>Needs attention</h2><p>Clear missing mappings, payment inputs and bills across your authorized stations.</p></div><strong>{visible.length} items</strong></div>
    <div className="cps-attention-filters">
      <label>Region<select value={region} onChange={e=>setRegion(e.target.value)}><option value="">All regions</option>{options("region").map(v=><option key={v}>{v}</option>)}</select></label>
      <label>Cluster<select value={cluster} onChange={e=>setCluster(e.target.value)}><option value="">All clusters</option>{options("cluster").map(v=><option key={v}>{v}</option>)}</select></label>
      <label>Station<SearchableSelect name="attention_station" value={station} onValueChange={setStation} options={[{value:"",label:"All stations"},...places.map(p=>({value:p.code,label:`${p.code} · ${p.name}`}))]} placeholder="Search station" maxOptions={150}/></label>
      <label>Find an issue<input value={search} onChange={e=>setSearch(e.target.value)} placeholder="ID, associate, bill or issue"/></label>
      <button type="button" className="button" onClick={()=>{setRegion("");setCluster("");setStation("");setSearch("");setSection("All issues");}}>Reset</button>
    </div>
    <div className="cps-issue-switch">{categories.map(c=><button type="button" className="button" aria-pressed={section===c} onClick={()=>setSection(c)} key={c}>{c} ({c==="All issues"?scoped.length:scoped.filter(i=>category(i.kind)===c).length})</button>)}</div>
    <div className="cps-table-wrap"><table><thead><tr><th>Station</th><th>Associate / reference</th><th>Needs attention</th><th>Affected dates</th><th>Action</th></tr></thead><tbody>{visible.map(i=><tr key={i.key}>
      <td><button className="cps-cell-link" onClick={()=>onOpen(i.station)}>{i.station}</button><small>{placeFor(i.station)?.cluster}</small></td>
      <td>{i.name||"Station cost"}<small>{[i.id,i.provider].filter(Boolean).join(" · ")}</small></td><td>{i.kind}<small>{i.owner}</small></td><td>{i.from} – {i.to}</td><td>{i.bill?<button className="button" onClick={()=>onOpen(i.station,"Other")}>Review bill</button>:canResolve?<a className="button" href={i.href}>{/attendance|low deliveries/i.test(i.kind)?"Review attendance":/mapping|unmapped|identity/i.test(i.kind)?"Complete mapping":"Review source"}</a>:<span>Contact {i.owner}</span>}</td>
    </tr>)}</tbody></table></div>
    {!visible.length&&<p className="panel-body">No pending items match these filters.</p>}
  </section>;
}
