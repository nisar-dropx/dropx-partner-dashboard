"use client";
import { useState } from "react";
import { disputeDays, disputeItems } from "../lib/payout-dispute-guide";
import { attendanceDateChoices, attendanceLabel } from "../lib/dispute-presentation";
import s from "./guided-dispute.module.css";

const money=(n:number)=>new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR"}).format(n);
const time=(v:string)=>v?new Date(v).toLocaleString("en-IN",{timeZone:"Asia/Kolkata",day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"}):"Not recorded";
function Comparison({before,current}:{before:string;current:string}) {
  return <><b>{current}</b><small>{before===current?"Same in payout":`In payout: ${before}`}</small></>;
}

export function DisputeDayEvidence({data,draft}:{data:any;draft:any}) {
  const [all,setAll]=useState(false);
  const days=disputeDays(data.snapshot),current=disputeDays(data.currentSnapshot??{});
  const selected=new Set<string>(draft.dates??[]);
  const item=disputeItems(data.snapshot).find(i=>i.key===draft.component);
  const imports=(data.deliveries??[]).filter((r:any)=>r.mappingStatus==="mapped");
  const deliveryDates=new Set(imports.filter((r:any)=>Number(r.total_delivery)>0).map((r:any)=>r.work_date));
  const focus=selected.size?days.filter(d=>selected.has(d.date)):draft.issue==="attendance"&&draft.concern?attendanceDateChoices(days,draft.issue,draft.concern):days.filter(d=>!d.attendanceKnown||Number(d.units)<1||attendanceLabel(d)!==attendanceLabel(current.find(n=>n.date===d.date)));
  const rows=all?days:focus;
  const showItem=!!item&&["production","salary","fuel"].includes(draft.issue);
  const showRoute=draft.issue==="fuel"||!draft.issue;
  const showActivity=draft.issue!=="salary";
  function itemValue(day:any) {
    const lines=(day?.lines??[]).filter((l:any)=>l.code===item?.code);
    if(!lines.length)return "Not available";
    if(/rate/i.test(draft.concern)){const rates=[...new Set(lines.map((l:any)=>l.rate))];return rates.length===1&&rates[0]!=null?`${money(Number(rates[0]))} rate`:"Multiple / missing rates";}
    if(draft.issue==="salary")return money(lines.reduce((n:number,l:any)=>n+Number(l.amount??0),0));
    return `${lines.reduce((n:number,l:any)=>n+Number(l.count??0),0)} ${draft.issue==="fuel"?"km":"units"}`;
  }
  return <>
    <div className={s.evidenceBar}><span><b>{selected.size?`${selected.size} disputed date${selected.size===1?"":"s"}`:"Days to check"}</b> · {data.snapshot.item?.work_days??"—"} published work days · {deliveryDates.size} days with imported deliveries</span><button type="button" onClick={()=>setAll(!all)}>{all?"Disputed / flagged dates":"View full month"}</button></div>
    {!rows.length?<p className={s.muted}>Choose the affected dates, or open the full month to check another day.</p>:<div className={s.scroll}><table className={s.table}><thead><tr><th>Date</th><th>Attendance now</th>{showItem?<th>{item.label} · now</th>:null}{showActivity?<th>Imported activity</th>:null}{showRoute?<th>Route distance</th>:null}<th>Evidence</th></tr></thead><tbody>{rows.map(d=>{
      const now=current.find(n=>n.date===d.date);
      const source=imports.filter((r:any)=>r.work_date===d.date);
      const count=(key:string)=>source.reduce((n:number,r:any)=>n+Number(r[key]??0),0);
      const fuel=data.currentSnapshot?.worksheet?.daily_breakdown?.find((r:any)=>r.date===d.date)?.routeFuel;
      const punches=(data.punches??[]).filter((p:any)=>p.punch_date===d.date);
      const mappings=(data.mappings??[]).filter((m:any)=>m.effectiveFrom<=d.date&&(!m.effectiveTo||m.effectiveTo>=d.date));
      return <tr key={d.date}><td><b>{new Date(`${d.date}T00:00:00Z`).toLocaleDateString("en-IN",{day:"numeric",month:"short",timeZone:"UTC"})}</b></td>
        <td><Comparison before={attendanceLabel(d)} current={attendanceLabel(now)}/>{d.attendanceKnown&&Number(d.units)===0&&count("total_delivery")>0?<small className={s.warn}>Deliveries found · not counted in payout</small>:null}</td>
        {showItem?<td><Comparison before={itemValue(d)} current={itemValue(now)}/></td>:null}
        {showActivity?<td>{source.length?<><b>{count("total_delivery")} deliveries</b><small>{count("c_return")} returns · {count("mfn")} pickups</small></>:"No verified import"}{(data.deliveries??[]).some((r:any)=>r.work_date===d.date&&r.mappingStatus!=="mapped")?<small className={s.warn}>Check ID mapping</small>:null}</td>:null}
        {showRoute?<td>{fuel?<><b>{fuel.km==null?"Distance pending":`${fuel.km} km`}</b><small>{fuel.status} · {fuel.reason||fuel.source}</small></>:"No distance record"}</td>:null}
        <td><details><summary>View records</summary><p><b>Mapped ID</b> {mappings.map((m:any)=>m.providerMemberId).join(", ")||"No dated mapping"}</p>{source.map((r:any)=><p key={r.id}>{r.client} · {r.provider_employee_id}<br/>Imported {time(r.updated_at)} IST</p>)}{punches.length?punches.map((p:any)=><p key={p.id}>{p.station_code} · {p.status}<br/>In: {time(p.in_time)} · Out: {time(p.out_time)}<br/>{p.linked?"Same / linked station":"Other station · check assignment"}</p>):<p>No punch record. Check source completeness before deciding.</p>}{fuel?<small>Distance updated {time(fuel.updatedAt)} IST</small>:null}</details></td>
      </tr>;
    })}</tbody></table></div>}
  </>;
}
