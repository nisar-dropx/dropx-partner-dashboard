import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { commandCostHref, type CommandCenterModel, type CommandPeriod } from '@/lib/ops-pulse/command-center';
import type { LossRecoveryCommandSummary } from '@/lib/ops-pulse/loss-recovery-command';
import { formatOpsDate } from '@/lib/ops-pulse/date-format';
import styles from '@/app/ops-pulse/command-center.module.css';
const number = (n: number | null | undefined) => n == null ? '—' : n.toLocaleString('en-IN', {maximumFractionDigits:0});
const money = (n: number | null | undefined) => n == null ? '—' : `₹${n.toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const date = (v:string) => formatOpsDate(v);

// The dashboard is a launch point, not a second CPS / Performance report.
export function OpsCommandCenter({model:m,period,codes,canCost,canPerformance,canLosses,performanceDate,errors,lossRecovery,lossHrefs}: {
  model:CommandCenterModel; period:CommandPeriod; codes:string[]; canCost:boolean; canCostAttention?:boolean; canPerformance:boolean; canReview:boolean; canLosses?:boolean; performanceDate:string; errors:string[];
  lossRecovery?: LossRecoveryCommandSummary | null; lossHrefs?: Record<string, string>;
}) {
  const costHref=commandCostHref(period,codes);
  const perfHref=`/ops-pulse/performance?${new URLSearchParams({view:'daily',date:performanceDate,stations:codes.join(',')})}`;
  const loss=lossRecovery;
  return <section aria-label="Section snapshots">
    <p className={styles.eyebrow}>SECTION SNAPSHOTS · {date(period.from)}–{date(period.to)}</p>
    <div className={styles.snapshots}>
      {canCost&&<>
        <Link prefetch={false} href={costHref}><span>Shipment volume <ArrowUpRight size={15}/></span><strong>{m.observed?number(m.total?.deliveries):'—'}</strong><small>Delivered · open shipment actuals</small></Link>
        <Link prefetch={false} href={costHref}><span>{m.provisional?'Provisional CPS':'Cost per shipment'} <ArrowUpRight size={15}/></span><strong>{money(m.total?.cps)}</strong><small>Open cost breakdown & sources</small></Link>
      </>}
      {canPerformance&&<Link prefetch={false} href={perfHref}><span>Service performance <ArrowUpRight size={15}/></span><strong>{number(m.performanceRisk)}<em> groups flagged</em></strong><small>{date(performanceDate)} · open performance actuals</small></Link>}
      {canLosses&&loss&&<>
        <Link prefetch={false} href={lossHrefs?.all||'/team-ops/losses/nl'}><span>Recoverable losses <ArrowUpRight size={15}/></span><strong>{money(loss.total_recoverable)}</strong><small>Scoped stations · open Losses</small></Link>
        <Link prefetch={false} href={lossHrefs?.station||'/team-ops/losses/nl'}><span>Awaiting station <ArrowUpRight size={15}/></span><strong>{number(loss.awaiting_station)}</strong><small>Dispute / clarification</small></Link>
        <Link prefetch={false} href={lossHrefs?.cluster||'/team-ops/losses/nl'}><span>Awaiting cluster <ArrowUpRight size={15}/></span><strong>{number(loss.awaiting_cluster)}</strong><small>Validation / proposal</small></Link>
        <Link prefetch={false} href={lossHrefs?.slp||'/team-ops/losses/nl'}><span>Awaiting SLP <ArrowUpRight size={15}/></span><strong>{number(loss.awaiting_slp)}</strong><small>Final confirmation</small></Link>
        <Link prefetch={false} href={lossHrefs?.due||'/team-ops/losses/nl'}><span>Due this cycle <ArrowUpRight size={15}/></span><strong>{number(loss.due_this_cycle)}</strong><small>{loss.overdue?`${loss.overdue} overdue · `:''}{loss.salary_month||'payroll / payout'}</small></Link>
        <Link prefetch={false} href={lossHrefs?.review||'/team-ops/losses/nl'}><span>Blocked / review <ArrowUpRight size={15}/></span><strong>{number((loss.blocked_needs_review||0)+(loss.blocked_exit||0)+(loss.on_hold||0))}</strong><small>Needs review · exit · hold</small></Link>
      </>}
    </div>
    {errors.length>0&&<p className={styles.sourceNote} role="status">Unavailable: {errors.join(', ')}. No missing result is shown as zero.</p>}
    {canCost&&<details className={styles.sources}><summary>How these figures are calculated</summary><div><p>CPS uses the same live cost store as the CPS section: operating costs ÷ deliveries including SWA and customer returns. Missing source data keeps the figure provisional. Targets, costs and daily station detail remain in CPS.</p><p>Shipment coverage: {m.observed}/{m.expected} location-days. Links retain the selected dates and location scope.</p>{canLosses&&loss?<p>Loss cards use the same station scope as Losses and deep-link to existing filters. Amounts are recoverable case totals, not payroll-deducted figures.</p>:null}<Link prefetch={false} href={costHref}>Open sources and actuals →</Link></div></details>}
  </section>;
}
