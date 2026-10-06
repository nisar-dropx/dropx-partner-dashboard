"use client";
import {useEffect,useState} from 'react';
import {eligibleAdhocVehicles,adhocVehicleLabel,requiredAdhocStatuses,adhocStatusLabel,type AdhocContext} from '@/lib/adhoc-vehicle-policy';
export function AdhocReasonSelector({name,location,date,onChange}:{name:string;location:string;date:string;onChange:(value:string)=>void}){
 const [data,setData]=useState<AdhocContext|null>(null),[error,setError]=useState(''),[reason,setReason]=useState(''),[retry,setRetry]=useState(0);
 useEffect(()=>{const controller=new AbortController();setData(null);setReason('');onChange('');setError('');
 if(location&&date)fetch(`/api/payments/adhoc-context?${new URLSearchParams({location,date})}`,{signal:controller.signal,cache:'no-store'}).then(async r=>{const b=await r.json();if(!r.ok)throw new Error(b.error);setData(b);}).catch(e=>{if(!controller.signal.aborted)setError(e.message)});
 return()=>controller.abort();
 // onChange only reports resets; changing its identity must not reload the selector.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[location,date,retry]);
 const rule=data?.rules.find(r=>r.label===reason),vehicles=rule&&data?eligibleAdhocVehicles(rule,data.vehicles,date):[];
 return <span style={{display:'grid',gap:8}}>
 <select className="field" name={name} required value={reason} onChange={e=>{setReason(e.target.value);onChange(e.target.value)}}><option value="">{!location||!date?'Select station and date first':error?'Vehicle checks unavailable':!data?'Loading vehicle checks…':'Select reason'}</option>{data?.rules.map(r=><option key={r.reason_key} value={r.label}>{r.label}</option>)}</select>
 {error?<span role="alert">{error} <button type="button" onClick={()=>setRetry(retry+1)}>Retry</button></span>:null}
 {rule?.source_code?<><span>Vehicle being replaced *</span><select className="field" key={`${reason}:${location}:${date}`} name="adhoc_vehicle_id" required defaultValue=""><option value="">Select vehicle / partner</option>{vehicles.map(v=><option key={v.id} value={v.id}>{adhocVehicleLabel(v)}</option>)}</select>
 {!vehicles.length?<small role="alert">{requiredAdhocStatuses(rule).length?`No eligible vehicles recorded as ${requiredAdhocStatuses(rule).map(adhocStatusLabel).join(' or ')}. Request blocked.`:'No eligible vehicle available for this date.'} Contact Fleet Manager{data?.contact?' · '+data.contact:''}.</small>:rule.effect_status?<small>Records {rule.effect_status==='on_leave'?'On Leave':'Breakdown'} for {date}{rule.block_rent?' · vehicle rent excluded for this day':''}.</small>:null}</>:null}
 </span>;
}
