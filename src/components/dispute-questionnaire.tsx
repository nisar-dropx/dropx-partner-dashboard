"use client";
import { DISPUTE_ISSUES, disputeConcerns, type GuideItem } from "../lib/payout-dispute-guide";
import s from "./guided-dispute.module.css";
export function DisputeQuestionnaire({ items, days, value, onChange }: { items: GuideItem[]; days: any[]; value: any; onChange: (v: any) => void }) {
  const issue=DISPUTE_ISSUES.find(i=>i.id===value.issue);
  const options=items.filter(i=>i.kind===value.issue);
  const concerns=disputeConcerns(value.issue,options.find(i=>i.key===value.component));
  const set=(v:any)=>onChange({...value,...v});
  return <div className={s.questions}>
    <label>1 · What needs checking?<select value={value.issue||""} onChange={e=>{const id=e.target.value; const opts=items.filter(i=>i.kind===id);set({issue:id,component:opts.length===1?opts[0].key:"",concern:"",dates:[],expected:""});}} required><option value="">Choose an issue</option>{DISPUTE_ISSUES.filter(i=>items.some(o=>o.kind===i.id)).map(i=><option key={i.id} value={i.id}>{i.label}</option>)}</select></label>
    {issue?<><label>2 · Which {value.issue==="deduction"?"deduction":"payment"}?<select value={value.component||""} onChange={e=>set({component:e.target.value,concern:""})} required><option value="">Choose the item</option>{options.map(i=><option key={i.key} value={i.key}>{i.label}{i.recoveryKey?` · ${i.recoveryKey.split("|")[0]} · ${i.recoveryKey.split("|")[2]||"Loss case"}`:""}{i.kind!=="attendance"?` · ₹${i.amount.toLocaleString("en-IN")}`:""}</option>)}</select></label>
    <label>What is wrong?<select value={value.concern||""} onChange={e=>set({concern:e.target.value})} required><option value="">Choose a reason</option>{concerns.map(r=><option key={r}>{r}</option>)}</select></label>
    {!["deduction","allowance"].includes(value.issue)?<fieldset className={s.dateField}><legend>3 · Select the affected dates</legend><div className={s.dates}>{days.map(d=><button key={d.date} type="button" aria-pressed={(value.dates||[]).includes(d.date)} title={`${d.date} · ${d.attendanceKnown?`${d.units} attendance units`:"Attendance unavailable"}${d.deliveryKnown?` · ${d.deliveries} deliveries`:""}`} onClick={()=>set({dates:(value.dates||[]).includes(d.date)?value.dates.filter((v:string)=>v!==d.date):[...(value.dates||[]),d.date].sort()})}><b>{Number(d.date.slice(-2))}</b><small>{d.attendanceKnown?(Number(d.units)>0?"Present":"Not counted"):"Check"}</small></button>)}</div><small>{value.dates?.length?value.dates.join(" · "):"Tap one or more dates. These are the days counted in your published payout."}</small></fieldset>:null}
    <label>What should it be? <small>(optional)</small><input inputMode="decimal" type="number" min="0" step="0.01" value={value.expected||""} onChange={e=>set({expected:e.target.value})} placeholder={value.issue==="attendance"?"Number of working days":value.issue==="fuel"?"Kilometres or rate, depending on your issue":"Correct count or amount, if known"}/></label>
    <label>Anything else? <small>(optional)</small><textarea value={value.note||""} onChange={e=>set({note:e.target.value})} maxLength={1000} rows={2} placeholder="A short note in your own words"/></label></>:null}
  </div>;
}
