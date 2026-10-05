"use client";
import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AdhocHistory } from '@/lib/payment-adhoc-history';
import { optionalPaymentEvidence } from '@/lib/optional-payment-evidence';
import styles from './payment-shipment-evidence.module.css';
const money=(value:number)=>'₹'+value.toLocaleString('en-IN',{maximumFractionDigits:2});
class HistoryBoundary extends Component<{children:ReactNode},{failed:boolean}> {
  state={failed:false}; static getDerivedStateFromError(){return {failed:true};}
  render(){return this.state.failed?<p>Recent ad hoc unavailable. Review actions remain available.</p>:this.props.children;}
}
export function PaymentApprovalAdhocHistory({requestId}:{requestId:string}) {
  return <HistoryBoundary><History requestId={requestId}/></HistoryBoundary>;
}
function History({requestId}:{requestId:string}) {
  const [data,setData]=useState<AdhocHistory|null>(null),[status,setStatus]=useState('idle'),[period,setPeriod]=useState('seven');
  const controller=useRef<AbortController|null>(null);
  useEffect(()=>()=>controller.current?.abort(),[]);
  const load=async()=>{
    if(controller.current||data) return;
    const abort=new AbortController();controller.current=abort;setStatus('loading');
    const result=await optionalPaymentEvidence(async()=>{
      const response=await fetch(`/api/payments/adhoc-history?request=${encodeURIComponent(requestId)}`,{signal:abort.signal,cache:'no-store'});
      if(!response.ok) throw new Error('Unavailable');
      const value=await response.json();
      if(!value||!Array.isArray(value.days)||!value.seven||!value.mtd) throw new Error('Unavailable');
      return value as AdhocHistory;
    });
    if(abort.signal.aborted) return;
    abort.abort();controller.current=null;setData(result.data);setStatus(result.data?'ready':'error');
  };
  const days=data?.days.filter(day=>day.date>=(period==='seven'?data.sevenFrom:data.monthFrom))??[];
  return <details className={styles.panel} onToggle={e=>{if(e.currentTarget.open&&status==='idle') void load();}}>
    <summary>Recent ad hoc vans <span>Previous 7 days · MTD</span></summary>
    <div className={styles.body}>
      {status==='loading'?<p role="status">Loading optional history… You can continue reviewing.</p>:null}
      {status==='error'?<p role="status">History unavailable. Review actions remain available. <button type="button" onClick={()=>void load()}>Retry</button></p>:null}
      {data?<><div className={styles.pins}><span><strong>7 days</strong>{data.seven.count} requests · {money(data.seven.amount)}</span><span><strong>MTD</strong>{data.mtd.count} requests · {money(data.mtd.amount)}</span></div>
        <label>Daily breakdown <select value={period} onChange={e=>setPeriod(e.currentTarget.value)}><option value="seven">Previous 7 days</option><option value="mtd">Month to date</option></select></label>
        <div className={styles.table} style={{maxHeight:240}}><table><thead><tr><th>Date</th><th>Requests</th><th>Amount</th><th>Pending</th></tr></thead><tbody>{days.map(day=><tr key={day.date}><td>{day.date}</td><td>{day.count}</td><td>{money(day.amount)}{day.missingAmounts?` · ${day.missingAmounts} unpriced`:''}</td><td>{day.pending}</td></tr>)}</tbody></table></div>
        {!days.length?<p>No previous ad hoc van requests in this period.</p>:null}
        <p>{data.station} · through {data.through}. Submitted requests only; rejected, returned and cancelled excluded. Amount: approved, otherwise recorded amount or estimate. Pending amounts are not settled spend.</p>
      </>:null}
    </div>
  </details>;
}
