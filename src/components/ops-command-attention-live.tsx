'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useTransition, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowUpRight, ClipboardCheck, Users, Truck, Wallet, CalendarDays, FileCheck, Boxes, Banknote } from 'lucide-react';
import { attentionOrder, type AttentionItem } from '@/lib/ops-pulse/command-attention';
import { formatOpsDate } from '@/lib/ops-pulse/date-format';
import styles from './ops-command-attention.module.css';

export type AttentionStation = { code: string; name: string };

const AttentionContext = createContext<(id:number,items:AttentionItem[])=>void>(()=>{});
export function LiveCommandAttention({today,total,stations=[],station='',range,children}:{today:string;total:number;stations?:AttentionStation[];station?:string;range?:{from:string;to:string};children:ReactNode}) {
  const [groups,setGroups]=useState<Record<number,AttentionItem[]>>({});
  const publish=useCallback((id:number,items:AttentionItem[])=>setGroups(previous=>previous[id]===items?previous:{...previous,[id]:items}),[]);
  const items=useMemo(()=>attentionOrder(Object.values(groups).flat()),[groups]);
  return <AttentionContext.Provider value={publish}>
    <CommandAttentionView items={items} today={today} pending={Math.max(0,total-Object.keys(groups).length)} stations={stations} station={station} range={range}/>
    {children}
  </AttentionContext.Provider>;
}
export function CommandAttentionResult({id,items}:{id:number;items:AttentionItem[]}) {
  const publish=useContext(AttentionContext);
  useEffect(()=>{publish(id,items);},[id,items,publish]);
  return null;
}

const icons={audits:ClipboardCheck,people:Users,vehicles:Truck,cod:Wallet,capacity:Boxes,documents:FileCheck,payments:Banknote,rosters:CalendarDays};
export function CommandAttentionView({items,today,pending=0,stations=[],station='',range}:{items:AttentionItem[];today:string;pending?:number;stations?:AttentionStation[];station?:string;range?:{from:string;to:string}}) {
  const router=useRouter();
  const [pendingNav,startTransition]=useTransition();
  const [showDetails,setShowDetails]=useState(false);
  const [showAll,setShowAll]=useState(false);
  if(!items.length&&!pending)return null;
  const active=items.filter(i=>i.tone!=='clear'),clear=items.filter(i=>i.tone==='clear');
  const actions=items.filter(i=>i.tone==='urgent'||i.tone==='action').length;
  const selected=stations.find(s=>s.code===station);
  const scopeLabel=selected?`${selected.code} · ${selected.name}`:stations.length?`All ${stations.length} stations`:'All stations';
  const card=(i:AttentionItem)=>{const Icon=icons[i.key as keyof typeof icons]||ClipboardCheck;return <Link className={styles.card} data-tone={i.tone} key={i.key} href={i.href} prefetch={false}><span className={styles.label}><Icon size={15}/>{i.title}<ArrowUpRight size={14}/></span><strong>{i.value}</strong><small>{i.detail}</small><span className={styles.action}>{i.action} →</span></Link>;};
  function changeStation(next:string){
    if(next===station||pendingNav)return;
    const params=new URLSearchParams();
    if(range?.from)params.set('from',range.from);
    if(range?.to)params.set('to',range.to);
    if(next)params.set('station',next);
    const query=params.toString();
    startTransition(()=>router.push(query?`/ops-pulse?${query}`:'/ops-pulse'));
  }
  return <section className={styles.watch} data-details={showDetails} data-all={showAll} aria-busy={pendingNav||undefined} aria-label="Operational attention">
    <header>
      <div>
        <p>OPERATIONS · {formatOpsDate(today)} IST{selected?` · ${selected.code}`:''}</p>
        <h2>{actions?`${actions} areas need attention`:'Operational checks'}</h2>
        {stations.length>1?<small className={styles.scope}>{pendingNav?'Updating priorities…':scopeLabel}</small>:null}
      </div>
      <div className={styles.controls}>
        {stations.length>1?<label className={styles.stationFilter}><span>Station</span><select aria-label="Filter priorities by station" disabled={pendingNav} value={station} onChange={event=>changeStation(event.target.value)}><option value="">All stations</option>{stations.map(s=><option key={s.code} value={s.code}>{s.code} · {s.name}</option>)}</select></label>:null}
        <button type="button" className={styles.detailToggle} aria-pressed={showDetails} onClick={()=>setShowDetails(value=>!value)}>{showDetails?'Hide details':'Show details'}</button>
      </div>
    </header>
    {active.length>0&&<div className={styles.grid}>{active.map(card)}</div>}
    {active.length>5&&<button type="button" className={styles.showAll} aria-expanded={showAll} onClick={()=>setShowAll(value=>!value)}>{showAll?'Show top 5':`View all ${active.length} areas`} <span aria-hidden="true">{showAll?'↑':'↓'}</span></button>}
    {clear.length>0&&<details className={styles.checked}><summary>{clear.length} other checks · no current action or not applicable</summary><div className={styles.grid}>{clear.map(card)}</div></details>}
    {pending>0&&<p role="status" className={styles.note}>Checking remaining sources… Ready items are available now.</p>}
    <details className={styles.about}><summary>How priorities work</summary><p className={styles.note}>Priority updates from current records: overdue first, then due date and affected count. Location checks use your selection; approvals are your assigned inbox. Details stay in their own sections.</p></details>
  </section>;
}
