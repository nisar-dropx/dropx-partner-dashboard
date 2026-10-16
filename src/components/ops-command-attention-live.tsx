'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ArrowUpRight, ClipboardCheck, Users, Truck, Wallet, CalendarDays, FileCheck, Boxes, Banknote } from 'lucide-react';
import { attentionOrder, type AttentionItem } from '@/lib/ops-pulse/command-attention';
import styles from './ops-command-attention.module.css';

const AttentionContext = createContext<(id:number,items:AttentionItem[])=>void>(()=>{});
export function LiveCommandAttention({today,total,children}:{today:string;total:number;children:ReactNode}) {
  const [groups,setGroups]=useState<Record<number,AttentionItem[]>>({});
  const publish=useCallback((id:number,items:AttentionItem[])=>setGroups(previous=>previous[id]===items?previous:{...previous,[id]:items}),[]);
  const items=useMemo(()=>attentionOrder(Object.values(groups).flat()),[groups]);
  return <AttentionContext.Provider value={publish}>
    <CommandAttentionView items={items} today={today} pending={Math.max(0,total-Object.keys(groups).length)}/>
    {children}
  </AttentionContext.Provider>;
}
export function CommandAttentionResult({id,items}:{id:number;items:AttentionItem[]}) {
  const publish=useContext(AttentionContext);
  useEffect(()=>{publish(id,items);},[id,items,publish]);
  return null;
}

const icons={audits:ClipboardCheck,people:Users,vehicles:Truck,cod:Wallet,capacity:Boxes,documents:FileCheck,payments:Banknote,rosters:CalendarDays};
export function CommandAttentionView({items,today,pending=0}:{items:AttentionItem[];today:string;pending?:number}) {
  if(!items.length&&!pending)return null;
  const active=items.filter(i=>i.tone!=='clear'),clear=items.filter(i=>i.tone==='clear');
  const actions=items.filter(i=>i.tone==='urgent'||i.tone==='action').length;
  const card=(i:AttentionItem)=>{const Icon=icons[i.key as keyof typeof icons]||ClipboardCheck;return <Link className={styles.card} data-tone={i.tone} key={i.key} href={i.href} prefetch={false}><span className={styles.label}><Icon size={15}/>{i.title}<ArrowUpRight size={14}/></span><strong>{i.value}</strong><small>{i.detail}</small><span className={styles.action}>{i.action} →</span></Link>;};
  return <section className={styles.watch} aria-label="Operational attention"><header><div><p>OPERATIONS · {new Date(today+'T12:00:00+05:30').toLocaleDateString('en-IN',{day:'numeric',month:'short',timeZone:'Asia/Kolkata'})} IST</p><h2>{actions?`${actions} areas need attention`:'Operational checks'}</h2></div><span>Urgent first · current work, separate from the cost period</span></header>
    {active.length>0&&<div className={styles.grid}>{active.map(card)}</div>}
    {clear.length>0&&<details className={styles.checked}><summary>{clear.length} other checks · no current action or not applicable</summary><div className={styles.grid}>{clear.map(card)}</div></details>}
    {pending>0&&<p role="status" className={styles.note}>Checking remaining sources… Ready items are available now.</p>}
    <p className={styles.note}>Priority updates from current records: overdue first, then due date and affected count. Location checks use your selection; approvals are your assigned inbox. Details stay in their own sections.</p>
  </section>;
}
