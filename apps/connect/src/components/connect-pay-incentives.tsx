import type {OwnIncentiveSummary} from '@/lib/workforce-own-incentives';
const money=(value:number)=>`₹${value.toLocaleString('en-IN',{maximumFractionDigits:2})}`;
export function ConnectPayIncentives({incentives}:{incentives:OwnIncentiveSummary}){
 return <section className="dx-dashboard-card" aria-label="Production incentive estimate">
  <h2>Production incentives</h2>
  <p>{incentives.campaigns.length?`${money(incentives.amount)} included in this month’s estimate.`:'No eligible production incentives calculated for this month.'}</p>
  {incentives.campaigns.length?<details><summary>Campaign breakdown</summary><ul>{incentives.campaigns.map(campaign=><li key={campaign.id}><strong>{campaign.name}</strong> · {campaign.workDays} qualifying {campaign.workDays===1?'day':'days'} · {money(campaign.amount)}</li>)}</ul></details>:null}
  <p className="dx-workforce-payment-note">Daily thresholds and caps combine your eligible provider IDs. This is an estimate, not payment confirmation. This calculation excludes referral rewards and pooled-MG supplements; separately approved additions appear under adjustments.</p>
 </section>;
}
