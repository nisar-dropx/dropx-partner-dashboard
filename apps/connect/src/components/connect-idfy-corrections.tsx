'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {ChevronDown,ShieldAlert,CheckCircle2,History,RefreshCw} from 'lucide-react';
import type {AppAccount} from './connect-profile-app';
import {idfyRequestedFields} from '../../../../src/lib/idfy-request-fields';
import styles from './connect-idfy-corrections.module.css';
type Field={name:string;label:string;type:string;value:string;required:boolean;disabled:boolean;readOnly:boolean;maxLength:number;options:{value:string;label:string}[]};
type Form={id:string;blockId:string;requirements:string;version:string;unsupported:boolean;fields:Field[]};
type Action={id:string;block_id:string;status:string;actor_name:string;actor_role:string;result_message:string;created_at:string;changes:{label?:string;before?:string;after?:string}[];events?:{status:string;message:string;created_at:string}[]};
type Data={pending:number;linked:boolean;checkedAt?:string;forms?:Form[];history:Action[];openActions?:Action[]};
const label=(s:string)=>({queued:'Waiting to send',sending:'Sending to IDfy',submitted:'Received by IDfy',unconfirmed:'Confirmation pending',failed:'Not submitted'}[s]||s);
export function ConnectIdfyCorrections({account,openRequest=0}:{account:AppAccount;openRequest?:number}){
 const [data,setData]=useState<Data|null>(null),[open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const generation=useRef(0),details=useRef(false),mounted=useRef(true);
 const url=`/api/connect/idfy-corrections?${new URLSearchParams({accountId:account.id,profileType:account.profileType})}`;
 const load=useCallback(async(full=false)=>{const n=++generation.current;setBusy(true);setError('');try{
  const r=await fetch(url+(full?'&details=1':''),{cache:'no-store',signal:AbortSignal.timeout(full?115000:15000)}),body=await r.json();
  if(!r.ok)throw new Error(body.error||'Could not load your request.');if(mounted.current&&n===generation.current){setData(body);details.current=full;}
 }catch(e){if(mounted.current&&n===generation.current)setError(e instanceof Error?e.message:'Please retry.');}finally{if(mounted.current&&n===generation.current)setBusy(false);}},[url]);
 useEffect(()=>{mounted.current=true;void load();const timer=setInterval(()=>{if(document.visibilityState==='visible'&&!details.current)void load();},60000);return()=>{mounted.current=false;generation.current++;clearInterval(timer);};},[load]);
 useEffect(()=>{if(openRequest){setOpen(true);void load(true);}},[openRequest,load]);
 if(!open&&!data?.pending&&!data?.history?.length)return null;
 const expand=()=>{setOpen(v=>!v);if(!open)void load(true);else details.current=false;};
 async function reconcile(id:string){setBusy(true);try{const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'reconcile',id})});const b=await r.json();if(!r.ok)throw new Error(b.error);await load(true);}catch(e){setError(e instanceof Error?e.message:'Please retry.');setBusy(false);}}
 return <section className={styles.card} aria-label="IDfy verification requests"><button className={styles.heading} onClick={expand} aria-expanded={open}>
  {data?.pending?<ShieldAlert size={22}/>:<CheckCircle2 size={22}/>}<span><strong>{data?.pending?'Your background check needs details':'Background check responses'}</strong><small>{data?.pending?`${data.pending} request${data.pending===1?'':'s'} · Fill the requested details`:'View submitted responses and status'}</small></span><ChevronDown size={18}/></button>
  {open?<div className={styles.body}><div className={styles.tools}><span>{data?.checkedAt?`Checked ${new Date(data.checkedAt).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})} IST`:''}</span><button disabled={busy} onClick={()=>void load(true)}><RefreshCw size={13}/> Refresh</button></div>
  {error?<p role="alert" className={styles.error}>{error}</p>:null}{busy?<p role="status">Checking your latest IDfy request…</p>:null}
  {!busy&&data?.forms?.length===0?<p className={styles.success}>No details pending from you. IDfy may still be verifying your response.</p>:null}
  {!busy&&!data?.linked?<p>No verified request is linked to this account. Your station can help check the Amazon ID.</p>:null}
  {data?.forms?.map(form=><ResponseForm key={`${form.id}:${form.version}`} form={form} url={url} disabled={busy||!!data.openActions?.some(a=>a.block_id===form.blockId)} onSaved={()=>void load(true)}/>)}
  {data?.openActions?.map(a=><div className={styles.status} key={a.id}><span>{a.result_message||label(a.status)}</span><button disabled={busy} onClick={()=>void reconcile(a.id)}>Check status</button></div>)}
  {data?.history?.length?<details className={styles.history}><summary><History size={14}/> Response history · {data.history.length}</summary>{data.history.map(a=><div className={styles.entry} key={a.id}><strong>{label(a.status)}</strong><small>{a.actor_name} · {a.actor_role} · {new Date(a.created_at).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})} IST</small><p>{a.result_message}</p>{a.changes?.length?<details><summary>Updated details</summary>{a.changes.map((c,i)=><p key={i}>{c.label||'Field'}: {c.before||'—'} → {c.after||'—'}</p>)}</details>:null}{a.events?.length?<details><summary>Timeline</summary>{a.events.map((e,i)=><p key={i}>{label(e.status)} · {new Date(e.created_at).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})} IST</p>)}</details>:null}</div>)}</details>:null}
  </div>:null}</section>;
}
function ResponseForm({form,url,disabled,onSaved}:{form:Form;url:string;disabled:boolean;onSaved:()=>void}){
 const [values,setValues]=useState<Record<string,string>>(Object.fromEntries(form.fields.map(f=>[f.name,f.value]))),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[locked,setLocked]=useState(false);
 const id=useRef<string|null>(null),focus=idfyRequestedFields(form.fields,form.requirements);
 const field=(f:Field)=><label key={f.name}>{f.label}{f.required?' *':''}{f.type==='select'?<select value={values[f.name]} required={f.required} onChange={e=>setValues(v=>({...v,[f.name]:e.target.value}))}>{f.options.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}</select>:f.type==='checkbox'?<input type="checkbox" checked={values[f.name]==='1'} onChange={e=>setValues(v=>({...v,[f.name]:e.target.checked?'1':'0'}))}/>:f.type==='textarea'?<textarea rows={3} value={values[f.name]} required={f.required} maxLength={f.maxLength||2000} onChange={e=>setValues(v=>({...v,[f.name]:e.target.value}))}/>:<input type={['email','tel','date','number'].includes(f.type)?f.type:'text'} value={values[f.name]} required={f.required} maxLength={f.maxLength||2000} onChange={e=>setValues(v=>({...v,[f.name]:e.target.value}))}/>}</label>;
 async function submit(){setBusy(true);setMessage('');id.current??=crypto.randomUUID();try{
  const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id.current,blockId:form.blockId,version:form.version,values}),signal:AbortSignal.timeout(115000)}),b=await r.json();
  if(!r.ok){id.current=null;throw new Error(b.error||'Please retry.');}setLocked(b.status!=='failed');if(b.status==='failed')id.current=null;setMessage(b.message||label(b.status));onSaved();
 }catch(e){setMessage(e instanceof Error?e.message:'Check status before trying again.');}finally{setBusy(false);}}
 return <div className={styles.request}><strong>Details requested by IDfy</strong><p>{form.requirements}</p>{form.unsupported?<p role="alert">This request needs a document upload that is not available here yet. Contact your station; the request remains pending.</p>:<form onSubmit={e=>{e.preventDefault();void submit();}}><fieldset disabled={disabled||busy||locked}><div className={styles.fields}>{focus.primary.map(field)}</div>{focus.other.length?<details><summary>Other details</summary><div className={styles.fields}>{focus.other.map(field)}</div></details>:null}<button className={styles.submit} type="submit">{busy?'Submitting…':'Submit details'}</button></fieldset></form>}{message?<p role="status">{message}</p>:null}</div>;
}
