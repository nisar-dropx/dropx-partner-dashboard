"use client";
import { useState } from "react";
import { DisputeDayEvidence } from "./dispute-day-evidence";
import { attendanceLabel } from "../lib/dispute-presentation";
import { DisputeQuestionnaire } from "./dispute-questionnaire";
import { buildGuidedPlan, disputeDays, disputeItems, guidedFields, normalizeGuidedClaim } from "../lib/payout-dispute-guide";
import s from "./guided-dispute.module.css";
const money=(n:any)=>new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR"}).format(Number(n));
const time=(v:string)=>v?new Date(v).toLocaleString("en-IN",{timeZone:"Asia/Kolkata",day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"}):"—";
export function GuidedDisputeReview({ id, version, details, editable, action, onEvidence }: { id:string; version:number; details:any; editable:boolean; action:(form:FormData)=>Promise<void>; onEvidence?:(data:any)=>void }) {
  const [data,setData]=useState<any>(null),[loading,setLoading]=useState(false),[error,setError]=useState("");
  const [draft,setDraft]=useState<any>(details?.schema===3?details:{}),[values,setValues]=useState<Record<string,string>>({}),[checked,setChecked]=useState<Record<string,boolean>>({});
  async function load(){setLoading(true);setError("");setChecked({});onEvidence?.(null);try{const r=await fetch(`/api/payments/payout-disputes/${id}/evidence`,{cache:"no-store"});const b=await r.json();if(!r.ok)throw new Error(b.error);setData(b);onEvidence?.(b);}catch(e){setError(e instanceof Error?e.message:"Evidence unavailable.");}finally{setLoading(false);}}
  let claim:any=null,fields:any[]=[],plan:any=null,problem="";
  if(data&&editable){try{claim=normalizeGuidedClaim(data.snapshot,draft);fields=guidedFields(data.snapshot,claim);const form=new FormData();for(const f of fields){form.set(f.key,values[f.key]??String(f.current));if(checked[f.key])form.set(`checked_${f.key}`,"on");}plan=buildGuidedPlan(data.snapshot,claim,form,data.pricing);}catch(e){problem=e instanceof Error?e.message:"Check the selected item.";}}
  const days=data?disputeDays(data.snapshot):[];
  const selectedItem=data?disputeItems(data.snapshot).find(i=>i.key===draft.component):null;
  const sourceDetails=data?.sourceDetails?{
    losses:data.sourceDetails.losses.filter((l:any)=>selectedItem?.recoveryKey?.startsWith(`${l.month}|${l.case_key}|`)),
    manual:data.sourceDetails.manual.filter((l:any)=>l.head_code_snapshot===selectedItem?.code),
    advances:selectedItem?.code&&/ADVANCE/i.test(selectedItem.code)?data.sourceDetails.advances:[],
    additions:data.sourceDetails.additions.filter((l:any)=>l.field_code_snapshot===selectedItem?.code)
  }:null;
  return <section className={s.panel} aria-label="Dispute evidence and guided validation">
    <div className={s.toolbar}><div><b>{editable?"Validate this request":"Supporting evidence"}</b><div className={s.muted}>Published payout compared with current system records</div></div><button type="button" onClick={()=>void load()} disabled={loading}>{loading?"Checking records…":data?"Refresh evidence":"Open evidence"}</button></div>
    {error?<p role="alert" className={s.error}>{error}</p>:null}
    {data?<>
      <input type="hidden" name="evidence_digest" form={`final-${id}`} value={data.digest}/>
      <input type="hidden" name="evidence_digest" form={`reject-${id}`} value={data.digest}/>
      <small className={s.muted}>Checked {time(data.pricing.checkedAt)} IST</small>
      {data.sourceError?<p role="alert" className={s.error}>{data.sourceError}</p>:null}
      {data.attachmentUrl?<a href={data.attachmentUrl} target="_blank" rel="noreferrer">View optional attachment ↗</a>:null}
      {details?.question?<p className={s.error}><b>Clarification:</b> {details.question}{details.reply?<><br/><b>Associate:</b> {details.reply}</>:null}</p>:null}
      {editable&&details?.schema!==3?<DisputeQuestionnaire items={disputeItems(data.snapshot)} days={days} value={draft} onChange={v=>{setDraft(v);setValues({});setChecked({});}}/>:null}
      {draft.issue?<p className={s.guidance}>{({attendance:"Check the mapped ID, punches and deliveries for each selected day.",deduction:/not my|wrongly deducted/i.test(draft.concern)?"Check who owns this deduction and the allocation record. Enter a correction only after validating the claim.":"Match the selected deduction to its source and previous recovery.",fuel:"Check the dated route, verified kilometres and mapped fuel rate.",production:"Compare imported activity with the paid count and rate for that date.",salary:"Check the effective payment mapping and attendance-based entitlement.",allowance:"Check the selected allowance or incentive and its eligibility."} as Record<string,string>)[draft.issue]}</p>:null}
      {draft.concern?<p><b>{draft.concern}</b>{draft.expected?` · Associate expects ${draft.expected}`:""}</p>:null}
      {!["deduction","allowance"].includes(draft.issue)?<DisputeDayEvidence data={data} draft={draft}/>:<div className={s.scroll}><table className={s.table}><thead><tr><th>Payout item</th><th>Published</th><th>Current</th><th>Source</th></tr></thead><tbody>{disputeItems(data.snapshot).filter(i=>i.kind===draft.issue&&(!draft.component||i.key===draft.component)).map(i=>{const latest=data.currentSnapshot?disputeItems(data.currentSnapshot).filter(c=>c.kind===draft.issue&&c.code===i.code&&c.recoveryKey===i.recoveryKey):[];return <tr key={i.key}><td>{i.label}</td><td>{money(i.amount)}</td><td>{latest.length?money(latest.reduce((n,l)=>n+l.amount,0)):data.currentSnapshot?"Not listed in current payout":"Current payout unavailable"}</td><td>{i.recoveryKey?<>{i.recoveryKey.split("|")[1]}<small>Loss month {i.recoveryKey.split("|")[0]}</small></>:i.code}{i.code==="TDS"?<small>Calculated deduction; check the gross amount and applicable rate.</small>:null}</td></tr>;})}</tbody></table></div>}
      {(data.pricing.policies.length||data.pricing.percentageDeductions.length)?<details><summary>Payment policy and calculation basis</summary><p>{data.pricing.policies.map((p:any)=>`${p.effective_from}: ${p.calculation_method.replaceAll("_"," ")}; ${p.paid_off_days} paid offs; one per ${p.work_units_per_paid_off} worked days${p.cap_at_monthly_amount?"; monthly cap":""}`).join(" · ")}</p><p>{data.pricing.percentageDeductions.map((d:any)=>`${d.code}: ${d.rate}%`).join(" · ")}</p></details>:null}
      {data.sourceDetails&&["deduction","allowance"].includes(draft.issue)?<details open><summary>Source records · allocation and recovery</summary><div className={s.scroll}><table className={s.table}><thead><tr><th>Source</th><th>Amount</th><th>Already recovered / outstanding</th><th>Recorded</th></tr></thead><tbody>
        {sourceDetails!.losses.map((l:any)=><tr key={`${l.month}:${l.case_key}`}><td>{l.report} · {l.case_key}<small>{l.month} · {l.outcome_label}</small></td><td>{money(l.total)}</td><td>{money(l.deducted)} recovered<small>{money(l.in_payroll)} in payroll · {money(l.outstanding)} outstanding</small></td><td>{l.updated_by_name}<small>{time(l.assigned_at)} · {l.status}</small>{l.waiver_reason?<small>{l.waiver_reason}</small>:null}</td></tr>)}
        {sourceDetails!.manual.map((l:any)=><tr key={l.id}><td>{l.head_name_snapshot}<small>{l.source_type} · {l.id.slice(0,8)}</small></td><td>{money(l.amount)}</td><td>Manual deduction entry</td><td>{time(l.updated_at||l.created_at)}</td></tr>)}
        {sourceDetails!.advances.map((l:any)=><tr key={l.id}><td>Advance {l.advance_number}<small>{l.advance_date} · {l.remark}</small></td><td>{money(l.amount)}</td><td>{money(l.opening_deducted_amount||0)} opening recovery<small>Current payout deduction shown above</small></td><td>{time(l.created_at)}</td></tr>)}
        {sourceDetails!.additions.map((l:any)=><tr key={l.id}><td>{l.field_name_snapshot}<small>{l.source_type}</small></td><td>{money(l.final_amount)}</td><td>{l.input_value} × {l.rate_value}</td><td>{time(l.updated_at||l.created_at)}</td></tr>)}
      </tbody></table></div></details>:null}
      {editable&&!details?.awaiting_reply?<form action={action}>
        <input name="dispute_id" type="hidden" value={id}/><input name="expected_version" type="hidden" value={version}/><input name="guided_claim" type="hidden" value={JSON.stringify(draft)}/><input name="evidence_digest" type="hidden" value={data.digest}/>
        {fields.length?<div className={s.scroll}><table className={s.table}><thead><tr><th>Validate item</th><th>Published</th>{claim?.counts?.length?<th>Associate claims</th>:null}<th>Validated value</th><th>Rate / pay impact</th><th>Evidence checked</th></tr></thead><tbody>{fields.map(f=>{const impact=plan?.items?.find((item:any)=>item.area===f.key);return <tr key={f.key}><td>{f.label}<small>{f.date}</small></td><td>{f.unit==="days"?attendanceLabel({attendanceKnown:true,units:f.current}):`${f.current} ${f.unit}`}</td>{claim?.counts?.length?<td className={s.claimValue}>{f.claimed??"—"}</td>:null}<td>{f.unit==="days"?<select name={f.key} aria-label={`Correct attendance ${f.date}`} value={values[f.key]??String(f.current)} onChange={e=>setValues({...values,[f.key]:e.target.value})}><option value="0">Not counted</option><option value="0.5">Half day</option><option value="1">Present</option></select>:<input name={f.key} aria-label={`Correct ${f.label} ${f.date}`} type="number" min="0" step={f.unit==="count"?"1":"0.01"} max={f.unit==="days"?"1":undefined} value={values[f.key]??String(f.current)} onChange={e=>setValues({...values,[f.key]:e.target.value})} required/>}</td><td>{impact?<>{f.rate!=null?<small>{money(f.rate)} per {f.unit}</small>:null}<b>{money(impact.expected_delta_paise/100)}</b></>:"—"}</td><td><label><input type="checkbox" name={`checked_${f.key}`} checked={!!checked[f.key]} onChange={e=>setChecked({...checked,[f.key]:e.target.checked})} required/> Validated</label></td></tr>;})}</tbody></table></div>:null}
        {plan?<div className={s.totals}>{[["Gross",plan.totals.gross_before,plan.totals.gross_after],["Deductions",plan.totals.deductions_before,plan.totals.deductions_after],["Net payable",plan.totals.net_before,plan.totals.net_after]].map(([label,before,after])=><div key={label}><span>{label}</span><small>Before {money(before)}</small><b>After {money(after)}</b></div>)}</div>:problem?<p className={s.muted}>{problem}</p>:null}
        <textarea name="note" rows={2} minLength={10} maxLength={1000} required aria-label="Validation findings" placeholder="What the records confirm and what must be corrected"/>
        <div className={s.actions}><button name="transition" value="propose_correction" type="submit" disabled={!plan||!!data.sourceError}>Send validated correction</button>{plan?<b>Net change {money(plan.expected_delta_paise/100)}</b>:null}</div>
      </form>:null}
    </>:null}
  </section>;
}
