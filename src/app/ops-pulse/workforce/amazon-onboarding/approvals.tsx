'use client';
import {useState} from 'react';
import type {AmazonDaCommand} from '@/lib/amazon-da-desk-types';
import {Audit} from './profile';
import styles from './view.module.css';
export function Approvals({commands,canApprove,onChanged,stations}:{commands:AmazonDaCommand[];canApprove:boolean;onChanged:()=>void;stations:Array<{id:string;code:string}>}){
 const [open,setOpen]=useState(''),[remarks,setRemarks]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function decide(c:AmazonDaCommand,decision:string){setBusy(true);setError('');try{
  const r=await fetch('/api/ops-pulse/amazon-da',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'review',id:c.id,stationId:c.station_id,decision,remarks})});const d=await r.json();if(!r.ok)throw Error(d.error);setOpen('');setRemarks('');onChanged();
 }catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 return <section className={styles.audit}><div className={styles.split}><strong>ID offboarding approvals</strong><small>{commands.length} awaiting approval</small></div>
 <p className={styles.meta}>One approval from Finance Manager, National Head or Managing Partner. Amazon status changes only after approval.</p>
 {error?<p role="alert" className={styles.error}>{error}</p>:null}
 {!commands.length?<p className={styles.empty}>No requests awaiting approval in this scope.</p>:commands.map(c=><article key={c.id} className={styles.auditRow}>
 <div className={styles.split}><div><strong>{c.associate_name}</strong><small>{stations.find(s=>s.id===c.station_id)?.code||''} · {c.action==='OFFBOARD'?'Offboard Amazon ID':'Set Amazon ID inactive'}</small></div><span className={`${styles.badge} ${styles.warning}`}>Awaiting approval</span></div>
 <small>Requested by {c.actor_name} · {c.actor_role} · {new Date(c.created_at).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})} IST</small><p>{c.remarks}</p>
 <button disabled={busy} onClick={()=>{setOpen(open===c.id?'':c.id);setRemarks('');setError('');}}>{open===c.id?'Close review':'Review request'}</button>
 {open===c.id?<div className={styles.actionForm}><small>Requested Amazon status: {c.expected_status} → {c.action==='OFFBOARD'?'OFFBOARDED':'INACTIVE'}</small><small>Reason: {c.reason_code.replaceAll('_',' ')}</small>
 <Audit commands={[c]} station={c.station_id} canEdit={false} onChecked={onChanged}/>
 {canApprove?<><label>Decision remark<textarea rows={2} maxLength={1000} value={remarks} onChange={e=>setRemarks(e.target.value)} placeholder="Why are you approving or rejecting this request?" disabled={busy}/></label><div className={styles.reviewButtons}><button disabled={busy||remarks.trim().length<3} className={styles.primary} onClick={()=>void decide(c,'approved')}>{busy?'Saving…':'Approve & send to Amazon'}</button><button disabled={busy||remarks.trim().length<3} onClick={()=>void decide(c,'rejected')}>Reject request</button></div></>:<small>Waiting for an authorized approver.</small>}
 </div>:null}</article>)}
 </section>;
}
