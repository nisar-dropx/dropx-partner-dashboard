import Link from 'next/link';
import { ArrowUpRight, ClipboardCheck, Users, Truck, Wallet, CalendarDays, FileCheck, Boxes, Banknote } from 'lucide-react';
import type { AuthorizationContext } from '@/lib/authorization';
import type { CodLocationRow } from '@/lib/ops-pulse/cod';
import { loadCommandAttention } from '@/lib/ops-pulse/command-attention-data';
import type { AttentionItem } from '@/lib/ops-pulse/command-attention';
import styles from './ops-command-attention.module.css';
const icons={audits:ClipboardCheck,people:Users,vehicles:Truck,cod:Wallet,capacity:Boxes,documents:FileCheck,payments:Banknote,rosters:CalendarDays};
export function CommandAttentionView({items,today}:{items:AttentionItem[];today:string}) {
  if(!items.length)return null;
  const active=items.filter(i=>i.tone!=='clear'),clear=items.filter(i=>i.tone==='clear');
  const actions=items.filter(i=>i.tone==='urgent'||i.tone==='action').length;
  const card=(i:AttentionItem)=>{const Icon=icons[i.key as keyof typeof icons]||ClipboardCheck;return <Link className={styles.card} data-tone={i.tone} key={i.key} href={i.href}><span className={styles.label}><Icon size={15}/>{i.title}<ArrowUpRight size={14}/></span><strong>{i.value}</strong><small>{i.detail}</small><span className={styles.action}>{i.action} →</span></Link>;};
  return <section className={styles.watch} aria-label="Operational attention"><header><div><p>OPERATIONS · {new Date(today+'T12:00:00+05:30').toLocaleDateString('en-IN',{day:'numeric',month:'short',timeZone:'Asia/Kolkata'})} IST</p><h2>{actions?`${actions} areas need attention`:'Operational checks'}</h2></div><span>Urgent first · current work, separate from the cost period</span></header>
    {active.length>0&&<div className={styles.grid}>{active.map(card)}</div>}
    {clear.length>0&&<details className={styles.checked}><summary>{clear.length} other checks · no current action or not applicable</summary><div className={styles.grid}>{clear.map(card)}</div></details>}
    <p className={styles.note}>Location checks use your selection. Audit cards show your assigned queue or station responses. Approval inboxes cover all your authorized assignments. Open each workspace for its full scope and history.</p>
  </section>;
}
export async function OpsCommandAttention({authorization,locations,today,mode}:{authorization:AuthorizationContext;locations:CodLocationRow[];today:string;mode:string}) {
  return <CommandAttentionView items={await loadCommandAttention(authorization,locations,today,mode)} today={today}/>;
}
