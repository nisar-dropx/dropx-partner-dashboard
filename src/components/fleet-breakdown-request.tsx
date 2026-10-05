'use client';
import {useEffect,useState,useRef,type FormEvent} from 'react';
import {Plus,X,Truck} from 'lucide-react';
import {useRouter} from 'next/navigation';
import {eligibleAdhocVehicles,adhocVehicleLabel,requiredAdhocStatuses,adhocStatusLabel,type AdhocContext} from '@/lib/adhoc-vehicle-policy';
import {paymentQuestionDateBounds} from '@/lib/payment-question-date-rules';
import {paymentFileAccept} from '@/lib/payment-file-types';
type Question={id:string;question_text:string;answer_type:string;dropdown_options:string|null;is_required:boolean;date_rule:string|null;date_days:number|null};
type Setup={headId:string;stations:{id:string;station_code:string}[];questions:Question[]};
export function FleetBreakdownRequest({today}:{today:string}){
 const router=useRouter(),dialog=useRef<HTMLDialogElement>(null);
 const [open,setOpen]=useState(false),[setup,setSetup]=useState<Setup|null>(null),[error,setError]=useState(''),[saving,setSaving]=useState(false),[retry,setRetry]=useState(0),[notice,setNotice]=useState('');
 const [location,setLocation]=useState(''),[date,setDate]=useState(today),[context,setContext]=useState<AdhocContext|null>(null),[contextError,setContextError]=useState('');
 const [amount,setAmount]=useState(''),[shipments,setShipments]=useState('');
 useEffect(()=>{if(!open)return;dialog.current?.showModal();const c=new AbortController();setSetup(null);setError('');
 fetch('/api/fleet-control/adhoc-request',{signal:c.signal,cache:'no-store'}).then(async r=>{const b=await r.json();if(!r.ok)throw new Error(b.error);setSetup(b)}).catch(e=>{if(!c.signal.aborted)setError(e.message)});return()=>c.abort();},[open,retry]);
 useEffect(()=>{const c=new AbortController();setContext(null);setContextError('');if(open&&location&&date)fetch(`/api/payments/adhoc-context?${new URLSearchParams({location,date})}`,{signal:c.signal,cache:'no-store'}).then(async r=>{const b=await r.json();if(!r.ok)throw new Error(b.error);setContext(b)}).catch(e=>{if(!c.signal.aborted)setContextError(e.message)});return()=>c.abort();},[open,location,date,retry]);
 const rule=context?.rules.find(r=>r.reason_key==='company_breakdown'),vehicles=context&&rule?eligibleAdhocVehicles(rule,context.vehicles,date):[];
 async function submit(event:FormEvent<HTMLFormElement>){event.preventDefault();setSaving(true);setError('');const form=new FormData(event.currentTarget);
 try{const bytes=[...form.values()].reduce((sum,v)=>sum+(v instanceof File?v.size:0),0);if(bytes>4*1024*1024)throw new Error('Keep uploaded files below 4 MB in total.');const response=await fetch('/api/fleet-control/adhoc-request',{method:'POST',body:form});const result=await response.json();if(!response.ok||result.error)throw new Error(result.error);setNotice(result.notice||'Request submitted.');setOpen(false);router.refresh();}catch(e){setError(e instanceof Error?e.message:'Unable to submit. Please retry.')}finally{setSaving(false)}}
 function input(q:Question){const name=`answers[${q.id}]`,common={name,required:q.is_required};
 if(/reason.*(?:adhoc|ad hoc).*deployment/i.test(q.question_text))return <><input type="hidden" name={name} value={rule?.label||''}/><strong>{rule?.label||'Company Vehicle Breakdown / Service'}</strong></>;
 if(q.answer_type==='date'){const bounds=paymentQuestionDateBounds(q);return <><input {...common} type="date" min={bounds.min} max={bounds.max} value={date} onChange={e=>setDate(e.target.value)}/>{bounds.helper?<small>{bounds.helper}</small>:null}</>}
 if(q.answer_type==='file')return <input {...common} type="file" accept={paymentFileAccept(q.dropdown_options)} name={`files[${q.id}]`}/>;
 if(q.answer_type==='dropdown'||q.answer_type==='yes_no')return <select {...common} defaultValue=""><option value="">Select</option>{(q.answer_type==='yes_no'?['Yes','No']:(q.dropdown_options||'').split(',').map(s=>s.trim()).filter(Boolean)).map(v=><option key={v}>{v}</option>)}</select>;
 if(q.answer_type==='textarea')return <textarea {...common} rows={2}/>;
 const isShipments=/estimated shipments/i.test(q.question_text);
 return <input {...common} type={q.answer_type==='number'?'number':'text'} min={q.answer_type==='number'?0:undefined} step={isShipments?1:q.answer_type==='number'?'0.01':undefined} {...(isShipments?{value:shipments,onChange:(e:React.ChangeEvent<HTMLInputElement>)=>setShipments(e.target.value)}:{})}/>;
 }
 return <div><button className="fc-button primary" onClick={()=>{setLocation('');setDate(today);setAmount('');setShipments('');setNotice('');setOpen(true)}} type="button"><Plus size={16}/> Request ad hoc van</button>{notice?<small role="status">{notice}</small>:null}
 {open?<dialog aria-label="Company Vehicle Breakdown / Service request" ref={dialog} className="fc-modal wide fc-breakdown-dialog" onCancel={e=>{e.preventDefault();if(!saving)setOpen(false)}} style={{border:0,maxHeight:'90dvh',overflowY:'auto',width:'min(860px,94vw)',padding:28}}>
 <button aria-label="Close request" className="fc-modal-close" disabled={saving} onClick={()=>setOpen(false)} type="button"><X size={19}/></button>
 <div className="fc-modal-title"><span className="fc-vehicle-big"><Truck size={24}/></span><div><small>Vehicle Payments · Request</small><h2>Company Vehicle Breakdown / Service</h2><p>Request a replacement for a company vehicle in breakdown or under service.</p></div></div>
 {error?<div role="alert" className="fc-alert">{error} {!setup?<button type="button" onClick={()=>setRetry(retry+1)}>Retry</button>:null}</div>:null}
 {!setup&&!error?<p>Loading request fields…</p>:null}
 {setup?<form className="fc-add-form" onSubmit={submit}>
 <input name="payment_head_id" value={setup.headId} type="hidden"/>
 <label><span>Station *</span><select autoFocus name="location_id" required value={location} onChange={e=>setLocation(e.target.value)}><option value="">Select station</option>{setup.stations.map(s=><option key={s.id} value={s.id}>{s.station_code}</option>)}</select>{!setup.stations.length?<small>No company-owned vehicles at your assigned stations.</small>:null}</label>
 <label><span>Estimated amount (₹) *</span><input name="amount" type="number" min="0.01" step="0.01" required value={amount} onChange={e=>setAmount(e.target.value)}/></label>
 {setup.questions.map(q=><label key={q.id} className={q.answer_type==='textarea'?'full':undefined}><span>{q.question_text}{q.is_required?' *':''}</span>{input(q)}</label>)}
 <label className="full"><span>Company vehicle being replaced *</span><select key={`${location}:${date}`} name="adhoc_vehicle_id" defaultValue="" required><option value="">{!location?'Select station first':!context?'Checking vehicles…':'Select company vehicle'}</option>{vehicles.map(v=><option key={v.id} value={v.id}>{adhocVehicleLabel(v)}</option>)}</select>
 {context&&!vehicles.length?<small role="alert">No eligible company vehicles recorded as {rule?requiredAdhocStatuses(rule).map(adhocStatusLabel).join(' or '):'Breakdown or Under service'}. Request blocked. Contact Fleet Manager{context.contact?' · '+context.contact:''}.</small>:null}
 {contextError?<small role="alert">{contextError} <button type="button" onClick={()=>setRetry(retry+1)}>Retry</button></small>:null}</label>
 <label className="full"><span>Remarks</span><textarea name="remarks" rows={2} maxLength={2000}/></label>
 {Number(shipments)>0&&Number(amount)>0?<small>Estimated CPS: ₹{(Number(amount)/Number(shipments)).toFixed(2)} per shipment</small>:null}
 <p className="full" style={{margin:0,fontSize:12,color:'#667085'}}>Sent to the Fleet Manager, then Business Head, using the configured fallback. Supporting station and vehicle details accompany the approval.</p>
 <div className="fc-form-actions"><button className="fc-button secondary" type="button" disabled={saving} onClick={()=>setOpen(false)}>Cancel</button><button className="fc-button primary" type="submit" disabled={saving||!vehicles.length}>{saving?'Submitting…':'Submit request'}</button></div>
 </form>:null}</dialog>:null}</div>;
}
