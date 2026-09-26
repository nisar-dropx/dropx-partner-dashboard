'use client';
import {useEffect,useState} from 'react';
import {useRouter} from 'next/navigation';
import {SearchableSelect} from '@/components/searchable-select';
import {SubmitButton} from '@/components/submit-button';
import {useCodFormState} from './use-cod-form-state';
import {recordCodException} from './exception-actions';
import type {CodException} from '@/lib/ops-pulse/cod-exceptions';
export function CodExceptionForm({stations,date,canAdd,canEdit,existing}:{stations:{value:string;label:string}[];date:string;canAdd:boolean;canEdit:boolean;existing?:CodException}){
 const [kind,setKind]=useState(existing?.kind||'Banker Not Reported');
 const [open,setOpen]=useState(false);const [state,action]=useCodFormState(recordCodException,{ok:false});const router=useRouter();
 useEffect(()=>{if(state?.ok)router.refresh();},[state,router]);
 const allowed=existing?canEdit:canAdd;
 return <div>
  {existing?<button className="button secondary" type="button" onClick={()=>setOpen(!open)} disabled={!allowed}>Amend update</button>:<div style={{display:'flex',gap:12,flexWrap:'wrap'}}>{(['Banker Not Reported','No Cash'] as const).map(value=><button key={value} className={`button ${open&&kind===value?'primary':'secondary'}`} type="button" disabled={!allowed} onClick={()=>{setKind(value);setOpen(true);}}>Update {value}</button>)}</div>}
  {open?<form action={action} className="form-grid two" encType="multipart/form-data" style={{marginTop:16}}>
   <input name="kind" type="hidden" value={kind}/>{existing?<><input type="hidden" name="id" value={existing.id}/><input type="hidden" name="version" value={existing.version}/><input type="hidden" name="location_id" value={existing.location_id}/><input type="hidden" name="report_date" value={existing.report_date}/><p className="span-2">Amending {existing.kind} · {existing.report_date}</p></>:<><label>Station<SearchableSelect name="location_id" options={stations} required placeholder="Select station"/></label><label>Report date<input className="field" type="date" name="report_date" defaultValue={date} required/></label></>}
   <label className="span-2">Reason / update<textarea name="reason" className="field" maxLength={2000} minLength={3} required defaultValue={existing?.reason} placeholder={kind==='No Cash'?'Confirm no cash is pending, as shown in ERP.':'Explain why the banker did not report and the follow-up taken.'}/></label>
   {kind==='No Cash'?<label className="span-2">ERP screenshot — No Cash<input name="erp_proof" type="file" className="field" accept="image/jpeg,image/png,image/webp" required={!existing?.proof}/><span className="subtle">JPG, PNG or WEBP · maximum 10 MB. {existing?.proof?'Current screenshot is retained unless replaced.':''}</span></label>:<>
    <label className="span-2">Exact subject of the email already sent<input className="field" name="email_subject" required maxLength={250} defaultValue={existing?.email_subject||''}/></label>
    <label>Sent from<input className="field" name="sender_email" type="email" required defaultValue={existing?.sender_email||''} placeholder="station@dropxlogistics.com"/></label>
    <label>Sent at (IST)<input className="field" name="email_sent_at" type="datetime-local" required defaultValue={existing?.email_sent_at?new Date(Date.parse(existing.email_sent_at)+19800000).toISOString().slice(0,16):undefined}/></label>
    <label>Stakeholder email addresses<input className="field" name="stakeholder_emails" required defaultValue={existing?.stakeholder_emails.join(', ')} placeholder="Comma-separated recipients"/></label>
    <label>Client COD POC email addresses<input className="field" name="client_poc_emails" required defaultValue={existing?.client_poc_emails.join(', ')} placeholder="Comma-separated client contacts"/></label>
    <label className="span-2">Mandatory CC<input className="field" readOnly value="cd@dropxlogistics.com"/></label>
    <label className="span-2" style={{display:'flex',gap:10,alignItems:'center'}}><input name="sent_confirmed" type="checkbox" value="yes" required/>The email has been sent to these stakeholders and client COD POCs, with cd@dropxlogistics.com in CC.</label>
   </>}
   {state?.error?<p className="span-2" role="alert" style={{color:'#b91c1c'}}>{state.error}</p>:null}{state?.ok?<p className="span-2" role="status">{state.notice}</p>:null}
   <div className="form-actions span-2"><SubmitButton className="button primary" disabled={!allowed}>Save {kind} update</SubmitButton><button type="button" className="button secondary" onClick={()=>setOpen(false)}>Close</button></div>
  </form>:null}
 </div>;
}
