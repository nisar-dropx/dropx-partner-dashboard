"use client";

import {useMemo, useState} from 'react';
import type {OwnAdjustmentLedger} from '@/lib/workforce-own-adjustments';
import styles from './connect-pay-adjustments.module.css';

const money=(value:number)=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:2}).format(value);
const day=(value:string)=>new Intl.DateTimeFormat('en-IN',{day:'numeric',month:'short',year:'numeric',timeZone:'Asia/Kolkata'}).format(new Date(`${value}T00:00:00+05:30`));
const time=(value:string)=>new Intl.DateTimeFormat('en-IN',{day:'numeric',month:'short',hour:'numeric',minute:'2-digit',timeZone:'Asia/Kolkata'}).format(new Date(value));
const labels:Record<string,string>={pending:'Awaiting review',approved:'Approved',rejected:'Not approved',posted:'In payroll',cancelled:'Cancelled'};
const categories:Record<string,string>={mileage:'Travel reimbursement',id_exception:'ID adjustment',delivery_correction:'Delivery correction',joining_bonus:'Joining bonus',referral_bonus:'Referral reward',reimbursement:'Reimbursement',asset_recovery:'Asset recovery',cash_recovery:'Cash recovery',other:'Other adjustment'};

export function ConnectPayAdjustments({ledger}:{ledger:OwnAdjustmentLedger}) {
 const [filter,setFilter]=useState('all'),[page,setPage]=useState(0);
 const rows=useMemo(()=>ledger.entries.filter(row=>filter==='all'||row.status===filter),[ledger.entries,filter]);
 const currentPage=Math.min(page,Math.max(0,Math.ceil(rows.length/25)-1));
 if(!ledger.available)return <section className={styles.panel}><h2>Adjustments unavailable</h2><p>Ask Workforce to link this profile.</p></section>;
 return <section className={styles.panel} aria-label="My payment adjustments">
  <header><h2>Adjustments</h2>
   <label>Status<select value={filter} onChange={event=>{setFilter(event.target.value);setPage(0);}}><option value="all">All statuses</option>{Object.entries(labels).map(([value,text])=><option key={value} value={value}>{text}</option>)}</select></label>
  </header>
  <dl className={styles.totals}><div><dt>Additions</dt><dd>{money(ledger.summary.additions)}</dd></div><div><dt>Deductions</dt><dd>{money(ledger.summary.deductions)}</dd></div><div><dt>Pending</dt><dd>{ledger.summary.pendingCount}</dd></div></dl>
  {rows.length ? <ul className={styles.list}>{rows.slice(currentPage*25,(currentPage+1)*25).map(row=><li key={row.id}>
   <div className={styles.row}><strong>{categories[row.category]??'Payment adjustment'}</strong><b>{row.kind==='deduction'?'−':'+'}{money(row.amount)}</b></div>
   <div className={styles.row}><span>Posting date · {day(row.postingDate)}</span><span className={styles.status} data-status={row.status}>{labels[row.status]}</span></div>
   {row.mileage ? <p>Work date · {day(row.mileage.workDate)} · {row.mileage.kilometres.toLocaleString('en-IN')} km × {money(row.mileage.ratePerKm)}/km</p> : null}
   <small>Submitted {time(row.requestedAt)} IST{row.reviewedAt?` · Reviewed ${time(row.reviewedAt)} IST`:''}</small>
  </li>)}</ul> : <p className={styles.empty}>{filter==='all'?'No adjustments this month.':'No matching adjustments.'}</p>}
  {rows.length>25 ? <nav className={styles.pager} aria-label="Adjustment pages"><button type="button" disabled={!currentPage} onClick={()=>setPage(currentPage-1)}>Previous</button><span>{currentPage+1} / {Math.ceil(rows.length/25)}</span><button type="button" disabled={(currentPage+1)*25>=rows.length} onClick={()=>setPage(currentPage+1)}>Next</button></nav> : null}
 </section>;
}
