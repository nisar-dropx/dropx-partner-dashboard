import { estimatedCps, expenseVariance } from '@/lib/expense-variance';
const rupees = (n: number | null) => n == null ? '—' : '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
export function PaymentCostSummary({ estimate, shipments, actual }: { estimate: number | null; shipments: number | null; actual?: number | null }) {
 const cost = expenseVariance({ amount_requested: estimate, amount: actual });
 return <div style={{display:'flex', flexWrap:'wrap', alignItems:'center',gap:'10px 24px',padding:'10px 12px',border:'1px solid #dbe5eb',borderRadius:8,background:'#f8fbfc',fontSize:12,margin:'10px 0'}} aria-label="Request cost estimate">
  <span>Estimate <strong>{rupees(estimate)}</strong></span><span>Shipments <strong>{shipments ?? '—'}</strong></span><span>Est. CPS <strong style={{color:'#0f766e'}}>{rupees(estimatedCps(estimate,shipments))}</strong></span>
  {actual != null ? <><span>Actual submitted <strong>{rupees(actual)}</strong></span><span style={{color:cost.overrun?'#b4233e':'#526875'}}>{cost.delta == null ? 'Estimate unavailable' : `${cost.delta > 0 ? '+' : ''}${rupees(cost.delta)}${cost.percent == null ? '' : ` (${cost.percent.toFixed(1)}%)`}`}{cost.overrun?' · Needs attention':''}</span></> : null}
  <details style={{marginLeft:'auto'}}><summary style={{cursor:'pointer',color:'#526875'}}>ⓘ</summary><p style={{maxWidth:300}}>Estimated CPS uses this request’s entered shipments, not total station inbound. Actual means submitted cost, not settled payment. Missing values stay blank.</p></details>
 </div>;
}
