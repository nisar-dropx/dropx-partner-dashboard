import type {OwnIncentiveSummary} from '@/lib/workforce-own-incentives';
import styles from './connect-pay-incentives.module.css';
const money=(value:number)=>`₹${value.toLocaleString('en-IN',{maximumFractionDigits:2})}`;
const cycleText=(cycle:OwnIncentiveSummary['campaigns'][number]['cycles'][number])=>cycle.attendanceRequired!==undefined
 ? `${cycle.cycleLabel}: ${cycle.attendanceRequired?`${cycle.presentDays ?? 0}/${cycle.minimumPresentDays ?? 0} present`:''}${cycle.attendanceRequired&&cycle.reportingTimeRequired?' · ':''}${cycle.reportingTimeRequired?`${cycle.lateDays ?? 0}/${cycle.allowedLateDays ?? 0} cutoff misses · by ${cycle.reportingTime} IST`:''}${cycle.rewardType==='per_shipment'?` · ${cycle.shipmentCount ?? 0} shipments`:''} · ${cycle.status.replace('_',' ')}`
 : cycle.denominator!==null?`${cycle.cycleLabel}: ${cycle.numerator}/${cycle.denominator} (${cycle.metricValue.toFixed(2)}%) · ${cycle.status.replace('_',' ')}`:`${cycle.cycleLabel}: ${cycle.metricValue} · ${cycle.status.replace('_',' ')}`;
export function ConnectPayIncentives({incentives}:{incentives:OwnIncentiveSummary}){
 return <section className={`dx-dashboard-card ${styles.card}`} aria-label="Production incentive estimate">
  <div className={styles.summary}><h2>Incentives</h2><strong>{money(incentives.amount)}</strong></div>
  {incentives.campaigns.length?<details><summary>View calculation</summary><ul>{incentives.campaigns.map(campaign=><li key={campaign.id}><strong>{campaign.name}</strong><span>{campaign.cycles.map(cycleText).join(' · ')} · {money(campaign.amount)}</span></li>)}</ul></details>:<p>No eligible incentive plan for this period</p>}
 </section>;
}
