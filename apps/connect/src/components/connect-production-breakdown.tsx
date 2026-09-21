import {ownProductionBreakdown,type OwnProductionDay} from '@/lib/own-production-breakdown';
import styles from './connect-production-breakdown.module.css';
const money=(n:number)=>`₹${n.toLocaleString('en-IN',{maximumFractionDigits:2})}`;
export function ConnectProductionBreakdown({days}:{days:OwnProductionDay[]}){
 const value=ownProductionBreakdown(days);
 return <div className={styles.breakdown}>
  {value.groups.map(g=><div className={styles.row} key={g.key}><span><strong>{g.label}</strong><small>{g.days} work day{g.days===1?'':'s'} · effective calculation</small></span><b>{money(g.amount)}</b></div>)}
  {value.incentiveAmount>0?<div className={styles.row}><span>Production incentives</span><b>{money(value.incentiveAmount)}</b></div>:null}
  {days.length?<><div className={styles.total}><span>Production + incentives</span><strong>{money(value.amount)}</strong></div><p>Daily pay is allocated across your own provider IDs, not paid once per ID. Monthly adjustments are shown separately. This is an estimate, not a paid balance.</p></>:<p>No mapped production sources for this period.</p>}
 </div>;
}
