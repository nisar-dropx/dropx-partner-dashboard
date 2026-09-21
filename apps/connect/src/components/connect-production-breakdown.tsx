import {ownProductionBreakdown,type OwnProductionDay} from '@/lib/own-production-breakdown';
import styles from './connect-production-breakdown.module.css';
const money=(n:number)=>`₹${n.toLocaleString('en-IN',{maximumFractionDigits:2})}`;
export function ConnectProductionBreakdown({days}:{days:OwnProductionDay[]}){
 const value=ownProductionBreakdown(days);
 const showTotal=value.groups.length>1||value.incentiveAmount>0;
 return <div className={styles.breakdown}>
  {value.groups.map(g=><div className={styles.row} key={g.key}><span><strong>{g.label}</strong><small>{g.days} work day{g.days===1?'':'s'} · combined across IDs</small></span><b>{money(g.amount)}</b></div>)}
  {value.incentiveAmount>0?<div className={styles.row}><span>Production incentives</span><b>{money(value.incentiveAmount)}</b></div>:null}
  {days.length&&showTotal?<div className={styles.total}><span>Total</span><strong>{money(value.amount)}</strong></div>:null}
  {!days.length?<p>No production data.</p>:null}
 </div>;
}
