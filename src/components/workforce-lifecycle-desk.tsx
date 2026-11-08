'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { lifecycleQueues, workforceLifecycleActions, type WorkforceLifecycleRow } from '@/lib/workforce-lifecycle-policy';
type Desk={rows:WorkforceLifecycleRow[];stations:{id:string;code:string}[];canManage:boolean;
 automation:{enabled:boolean;updatedAt:string|null};
 failures:{workforce_id:string;error:string;attempted_at:string;attempts:number}[];
 events:{id:string;workforce_id:string;action:string;reason:string;created_at:string}[]};
const labels:Record<string,string>={inactivate:'Make inactive',reactivate:'Reactivate',offboard:'Offboard',rejoin:'Rejoin'};
export function WorkforceLifecycleDesk({selectedId}:{selectedId?:string}) {
 const [data,setData]=useState<Desk|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [search,setSearch]=useState(''),[station,setStation]=useState(''),[queue,setQueue]=useState(selectedId?'all':'attention');
 const [selection,setSelection]=useState<{row:WorkforceLifecycleRow;action:string}|null>(null),[reason,setReason]=useState(''),[busy,setBusy]=useState(false);
 async function load(){setError('');try{const res=await fetch('/api/ops-pulse/workforce-lifecycle',{cache:'no-store'});const body=await res.json();if(!res.ok)throw new Error(body.error);setData(body);}catch(e){setError(e instanceof Error?e.message:'Could not load.');}}
 useEffect(()=>{void load();},[]);
 const rows=(data?.rows||[]).filter(r=>(!selectedId||r.id===selectedId)&&(!station||r.location_id===station)&&
  (queue==='all'||(queue==='attention'?!['current','inactive','offboarded'].includes(r.queue):r.queue===queue))&&
  [r.full_name,r.dropx_id,r.mobile,r.provider_ids||''].join(' ').toLowerCase().includes(search.toLowerCase()));
 async function submit(){if(!selection)return;setBusy(true);setError('');try{
  const response=await fetch('/api/ops-pulse/workforce-lifecycle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
   id:selection.row.id,action:selection.action,reason,confirmed:true,updatedAt:selection.row.updated_at,version:selection.row.version})});
  const body=await response.json();if(!response.ok)throw new Error(body.error);
  setNotice(`${selection.row.dropx_id}: ${labels[selection.action]} saved. ${body.result.provider_action_required?'Amazon status is separate; complete and confirm the partner action in Amazon onboarding.':''}`);
  setSelection(null);setReason('');await load();
 }catch(e){setError(e instanceof Error?e.message:'Unable to save.');}finally{setBusy(false);}}
 function download(){const cells=[['DropX ID','Associate','Station','Provider IDs','Registration','Lifecycle','Queue','Last delivery','Last punch','Feed through','Reason'],
 ...rows.map(r=>[r.dropx_id,r.full_name,r.station_code,r.provider_ids||'',r.onboarding_status,r.control_status,lifecycleQueues[r.queue],r.last_delivery||'',r.last_punch||'',r.feed_through||'',r.reason])];
 const csv=cells.map(row=>row.map(v=>`"${String(v).replace(/^[=+@-]/,"'$&").replaceAll('"','""')}"`).join(',')).join('\r\n');
 const url=URL.createObjectURL(new Blob(['\uFEFF',csv],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='workforce-lifecycle.csv';a.click();URL.revokeObjectURL(url);}
 return <div style={{display:'grid',gap:16}}>
  <section className="panel"><div className="panel-body" style={{display:'flex',flexWrap:'wrap',gap:12,alignItems:'center'}}>
   <strong>Registration: 15 days · No deliveries: 30 days</strong><span className="subtle">Provider delays and missing work evidence go to Exceptions. History is retained.</span>
   <button className="button secondary" onClick={()=>void load()}>Refresh</button>
  </div></section>
  {error?<div className="panel message-panel error" role="alert"><div className="panel-body">{error}</div></div>:null}
  {notice?<div className="panel message-panel" role="status"><div className="panel-body">{notice}</div></div>:null}
  {!data&&!error?<p role="status">Checking registration and delivery evidence…</p>:null}
  {data?<>
   <section className="panel"><div className="panel-body" role="status">
    <strong>{data.automation.enabled?'Automatic lifecycle checks enabled':'Review mode · automatic status changes paused'}</strong>
    <p style={{margin:'6px 0 0'}}>{data.automation.enabled?'Eligible records are checked hourly. Exceptions stay available for review.':'Review the export before enabling automatic exits or inactivation. No scheduled status changes will run.'}</p>
    <details style={{marginTop:8}}><summary>How the lifecycle works</summary><ol>
     <li>Onboarding: track the associate’s next action. Submitted cases awaiting Amazon or IDfy go to Exceptions.</li>
     <li>Active: use the normal associate workspace. Keep onboarding records and the mailbox available.</li>
     <li>15 days unfinished: recheck responses and work evidence before exit.</li>
     <li>30 days without deliveries: check all linked IDs, stations and attendance before inactivation.</li>
     <li>Closed station: review final exit only after checking work at other stations.</li>
     <li>Return: use the existing mobile and DropX ID for Reactivate or Rejoin.</li>
    </ol></details>
   </div></section>
   <div style={{display:'flex',flexWrap:'wrap',gap:8}}>{['registration_overdue','delivery_inactive','closed_station_exit','registration_exception','delivery_exception','inactive','offboarded'].map(key=><button key={key} className={`button ${queue===key?'':'secondary'}`} onClick={()=>setQueue(key)}>{lifecycleQueues[key]} · {data.rows.filter(r=>r.queue===key).length}</button>)}</div>
   <section className="panel"><div className="panel-body" style={{display:'flex',gap:8,flexWrap:'wrap'}}>
    <input className="field" style={{flex:'1 1 240px'}} value={search} onChange={e=>setSearch(e.target.value)} placeholder="Name, DropX ID, Amazon ID or mobile" aria-label="Find associate"/>
    <select className="select" aria-label="Station" value={station} onChange={e=>setStation(e.target.value)}><option value="">All permitted stations</option>{data.stations.map(s=><option key={s.id} value={s.id}>{s.code}</option>)}</select>
    <select className="select" aria-label="Lifecycle view" value={queue} onChange={e=>setQueue(e.target.value)}><option value="attention">Needs attention</option><option value="all">All associates</option>{Object.entries(lifecycleQueues).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select>
    <button className="button secondary" onClick={download}>Download filtered data</button>
    {selectedId?<Link className="button secondary" href="/work-force-register?section=lifecycle">All associates</Link>:null}
   </div><div style={{overflowX:'auto'}}><table className="table"><thead><tr><th>Associate / IDs</th><th>Station</th><th>Status</th><th>Last work</th><th>Evidence / action</th></tr></thead><tbody>
    {rows.map(row=><tr key={row.id}><td><strong>{row.full_name}</strong><div>{row.dropx_id}</div><small>Partner: {row.provider_ids||'Not linked'}</small></td><td>{row.station_code}</td>
     <td><strong>{lifecycleQueues[row.queue]}</strong><div className="subtle">Registration: {row.onboarding_status}</div></td>
     <td>Delivery: {row.last_delivery||'No mapped history'}<br/><small>Punch: {row.last_punch||'Not recorded'}</small></td>
     <td style={{maxWidth:420}}><p style={{margin:'0 0 8px'}}>{row.reason}</p><small className="subtle">Delivery feed: {row.feed_through||'Unavailable'} · {row.feed_days}/30 days</small>
      {data.failures.filter(f=>f.workforce_id===row.id).map(f=><details key={f.workforce_id}><summary>Automatic update needs review · {f.attempts} attempt(s)</summary><p>{f.error}</p><small>Last attempt: {new Date(f.attempted_at).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})}</small></details>)}
      <div style={{display:'flex',gap:6,flexWrap:'wrap',marginTop:8}}>{data.canManage?workforceLifecycleActions(row).map(action=><button key={action} className="button secondary" onClick={()=>{setSelection({row,action});setReason('');}}>{labels[action]}</button>):<small>Finance / Managing Partner / National Head to decide</small>}
      <Link href={`/work-force-register?view=${row.id}`}>Profile</Link>{row.provider_ids?<Link href="/workforce/amazon-onboarding">Amazon status</Link>:null}</div>
      <details style={{marginTop:8}}><summary>History</summary>{data.events.filter(e=>e.workforce_id===row.id).map(e=><p key={e.id}>{new Date(e.created_at).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})} · {labels[e.action]||e.action}<br/>{e.reason}</p>)}</details>
     </td></tr>)}
    {!rows.length?<tr><td colSpan={5}>No associates match these filters.</td></tr>:null}
   </tbody></table></div></section><small className="subtle">{rows.length} associates · As of {data.rows[0]?.as_of} IST. DropX status and Amazon confirmation are tracked separately.</small>
  </>:null}
  {selection?<div className="modal-backdrop"><div className="modal-panel" role="dialog" aria-modal="true" aria-labelledby="lifecycle-action-title" style={{padding:24,maxWidth:540}}>
   <h2 id="lifecycle-action-title">{labels[selection.action]} · {selection.row.dropx_id}</h2><p>{selection.row.full_name}</p>
   <p>{selection.action==='rejoin'?'Keep this DropX ID and history. Registration reopens for review; previous pay periods are not reopened.':selection.action==='reactivate'?'Restore this completed DropX profile. Confirm identity, station and partner readiness. Review a new effective pay period; closed periods stay closed.':selection.action==='offboard'?'End this DropX profile’s active tenure. Records and unpaid earnings remain available.':'Pause this DropX profile. It can be reactivated when the associate returns.'}</p>
   {selection.row.provider_ids?<p><strong>Amazon status is separate.</strong> Confirm the corresponding partner action in Amazon onboarding; this button does not claim Amazon has changed.</p>:null}
   <label>Reason<textarea className="field" autoFocus rows={3} value={reason} maxLength={1000} onChange={e=>setReason(e.target.value)}/></label>
   {error?<p role="alert">{error}</p>:null}<div style={{display:'flex',gap:8,marginTop:16}}><button className="button secondary" disabled={busy} onClick={()=>setSelection(null)}>Cancel</button><button className="button" disabled={busy||reason.trim().length<5} onClick={()=>void submit()}>{busy?'Saving…':`Confirm ${labels[selection.action].toLowerCase()}`}</button></div>
  </div></div>:null}
 </div>;
}
