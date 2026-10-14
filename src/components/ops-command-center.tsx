import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { commandCostHref, type CommandCenterModel, type CommandPeriod } from '@/lib/ops-pulse/command-center';
import styles from '@/app/ops-pulse/command-center.module.css';
const number = (n: number | null | undefined) => n == null ? '—' : n.toLocaleString('en-IN', {maximumFractionDigits:0});
const money = (n: number | null | undefined) => n == null ? '—' : `₹${n.toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const date = (v:string) => new Date(v+'T00:00:00Z').toLocaleDateString('en-IN',{day:'numeric',month:'short',timeZone:'Asia/Kolkata'});

// The dashboard is a launch point, not a second CPS / Performance report.
export function OpsCommandCenter({model:m,period,codes,canCost,canPerformance,performanceDate,errors}: {
  model:CommandCenterModel; period:CommandPeriod; codes:string[]; canCost:boolean; canCostAttention?:boolean; canPerformance:boolean; canReview:boolean; performanceDate:string; errors:string[];
}) {
  const costHref=commandCostHref(period,codes);
  const perfHref=`/ops-pulse/performance?${new URLSearchParams({view:'daily',date:performanceDate,stations:codes.join(',')})}`;
  return <section aria-label="Section snapshots">
    <p className={styles.eyebrow}>SECTION SNAPSHOTS · {date(period.from)}–{date(period.to)}</p>
    <div className={styles.snapshots}>
      {canCost&&<>
        <Link href={costHref}><span>Shipment volume <ArrowUpRight size={15}/></span><strong>{m.observed?number(m.total?.deliveries):'—'}</strong><small>Delivered · open shipment actuals</small></Link>
        <Link href={costHref}><span>{m.provisional?'Provisional CPS':'Cost per shipment'} <ArrowUpRight size={15}/></span><strong>{money(m.total?.cps)}</strong><small>Open cost breakdown & sources</small></Link>
      </>}
      {canPerformance&&<Link href={perfHref}><span>Service performance <ArrowUpRight size={15}/></span><strong>{number(m.performanceRisk)}<em> groups flagged</em></strong><small>{date(performanceDate)} · open performance actuals</small></Link>}
    </div>
    {errors.length>0&&<p className={styles.sourceNote} role="status">Unavailable: {errors.join(', ')}. No missing result is shown as zero.</p>}
    {canCost&&<details className={styles.sources}><summary>How these figures are calculated</summary><div><p>CPS uses the same live cost store as the CPS section: operating costs ÷ deliveries including SWA and customer returns. Missing source data keeps the figure provisional. Targets, costs and daily station detail remain in CPS.</p><p>Shipment coverage: {m.observed}/{m.expected} location-days. Links retain the selected dates and location scope.</p><Link href={costHref}>Open sources and actuals →</Link></div></details>}
  </section>;
}
