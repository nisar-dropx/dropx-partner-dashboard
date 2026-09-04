"use client";
import { useState } from "react";
import type { ReviewCodLine,ReviewCodSnapshot } from "@/lib/ops-pulse/review-cod";

const money=(value:number)=>`₹${value.toLocaleString("en-IN",{maximumFractionDigits:2})}`;
export function PerformanceCodPending({snapshot}:{snapshot:ReviewCodSnapshot}) {
  const [view,setView]=useState<"days"|"associates"|"tids">("days");
  const [lines,setLines]=useState<ReviewCodLine[]|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState<string|null>(null);
  const [page,setPage]=useState(1);
  const summary=snapshot.summary;
  const endpoint=`/api/ops-pulse/performance/cod?station=${encodeURIComponent(snapshot.stationCode)}&batch=${encodeURIComponent(snapshot.batchId||"")}`;
  async function loadDetails() {
    if(lines||loading||!summary)return;
    setLoading(true);setError(null);
    try {const response=await fetch(endpoint,{cache:"no-store"});const result=await response.json();if(!response.ok)throw new Error(result.error||"Unable to load COD details.");setLines(result.lines);}
    catch(e){setError(e instanceof Error?e.message:"Unable to load COD details.");}finally{setLoading(false);}
  }
  const associates=new Map<string,{name:string;id:string;amount:number;overdue:boolean}>();
  for(const line of lines||[]) {const key=`${line.associateId}|${line.associate}`;const row=associates.get(key)||{name:line.associate,id:line.associateId,amount:0,overdue:false};row.amount+=Math.round(line.amount*100);row.overdue ||= line.overdue;associates.set(key,row);}
  const rows=view==="tids"?(lines||[]).map(line=>({key:String(line.rowNumber),label:line.trackingId||"TID not supplied",detail:`${line.associate} · ${line.pendingDate||"Date not supplied"} · ${line.bucket}`,amount:line.amount,overdue:line.overdue}))
    :view==="associates"?[...associates.values()].sort((a,b)=>b.amount-a.amount).map(row=>({key:`${row.id}|${row.name}`,label:row.name,detail:row.id,amount:row.amount/100,overdue:row.overdue}))
    :(summary?.days||[]).map(row=>({key:row.label,label:row.label,detail:`${row.lines} source lines`,amount:row.amount,overdue:row.overdue}));
  return <section className={`review-cod-pending ${summary?.tone||"neutral"}`} aria-label="COD pending">
    <details onToggle={event=>{if(event.currentTarget.open)void loadDetails();}}>
      <summary><span><strong>COD pending</strong><small>{summary?summary.total?`${summary.tidCount} TIDs · ${summary.overdueAmount?`${money(summary.overdueAmount)} over 2 days`:"No balance over 2 days"}`:"No COD pending in this report":snapshot.error}</small></span><b>{summary?money(summary.total):"—"}</b><span className="review-cod-info" aria-label="Show COD ageing and details">i</span></summary>
      {summary?<div className="review-cod-body">
        <p className="review-cod-source">Latest imported position · {snapshot.importedAt?new Date(snapshot.importedAt).toLocaleString("en-IN",{timeZone:"Asia/Kolkata"}):"—"}. Not a historical review-day balance.</p>
        <div className="review-cod-buckets">{summary.buckets.map(bucket=><span key={bucket.label} className={bucket.overdue?"overdue":""}><small>{bucket.label}</small><strong>{money(bucket.amount)}</strong></span>)}</div>
        <div className="review-cod-toolbar"><div role="group" aria-label="COD detail view">{(["days","associates","tids"] as const).map(tab=><button type="button" key={tab} aria-pressed={view===tab} onClick={()=>{setView(tab);setPage(1);}}>{tab==="days"?"Day-wise":tab==="associates"?"DA-wise":"TIDs"}</button>)}</div><a className="button secondary" href={`${endpoint}&format=xlsx`}>Download Excel</a></div>
        {loading&&view!=="days"?<p role="status">Loading station details…</p>:null}
        {error?<p role="alert">{error} <button type="button" onClick={()=>void loadDetails()}>Retry</button></p>:null}
        <div className="review-cod-rows">{rows.slice((page-1)*30,page*30).map(row=><div className={row.overdue?"overdue":""} key={row.key}><span><strong>{row.label}</strong><small>{row.detail}</small></span><b>{money(row.amount)}</b></div>)}</div>
        {rows.length>30?<nav className="review-backlog-pages"><button type="button" disabled={page===1} onClick={()=>setPage(page-1)}>Previous</button><span>{page} / {Math.ceil(rows.length/30)}</span><button type="button" disabled={page*30>=rows.length} onClick={()=>setPage(page+1)}>Next</button></nav>:null}
        <small className="review-cod-source">Ageing follows Amazon’s report. A TID can have multiple order lines; all source amounts are retained. Download includes the selected station only.</small>
      </div>:null}
    </details>
  </section>;
}
