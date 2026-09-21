import type {OwnIncentiveSummary} from '@/lib/workforce-own-incentives';
import styles from './connect-pay-incentives.module.css';
const money=(value:number)=>`₹${value.toLocaleString('en-IN',{maximumFractionDigits:2})}`;
export function ConnectPayIncentives({incentives}:{incentives:OwnIncentiveSummary}){
 return <section className={`dx-dashboard-card ${styles.card}`} aria-label="Production incentive estimate">
  <div className={styles.summary}><h2>Incentives</h2><strong>{money(incentives.amount)}</strong></div>
  {incentives.campaigns.length?<details><summary>View breakdown</summary><ul>{incentives.campaigns.map(campaign=><li key={campaign.id}><strong>{campaign.name}</strong><span>{campaign.workDays} qualifying {campaign.workDays===1?'day':'days'} · {money(campaign.amount)}</span></li>)}</ul></details>:<p>None this month</p>}
 </section>;
}
