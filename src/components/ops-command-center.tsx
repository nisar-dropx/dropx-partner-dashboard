import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { commandCostHref, type CommandCenterModel, type CommandPeriod } from '@/lib/ops-pulse/command-center';
import type { LossRecoveryCommandSummary } from '@/lib/ops-pulse/loss-recovery-command';
import { formatOpsDate } from '@/lib/ops-pulse/date-format';
import styles from '@/app/ops-pulse/command-center.module.css';

const number = (n: number | null | undefined) => n == null ? '—' : n.toLocaleString('en-IN', { maximumFractionDigits: 0 });
const money = (n: number | null | undefined) => n == null ? '—' : `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const date = (v: string) => formatOpsDate(v);

/** Launch-point KPIs — not a second CPS / Performance report. */
export function OpsCommandCenter({
  model: m, period, codes, canCost, canPerformance, canLosses, performanceDate, errors, lossRecovery, lossHrefs,
}: {
  model: CommandCenterModel; period: CommandPeriod; codes: string[]; canCost: boolean; canCostAttention?: boolean;
  canPerformance: boolean; canReview: boolean; canLosses?: boolean; performanceDate: string; errors: string[];
  lossRecovery?: LossRecoveryCommandSummary | null; lossHrefs?: Record<string, string>;
}) {
  const costHref = commandCostHref(period, codes);
  const perfHref = `/ops-pulse/performance?${new URLSearchParams({ view: 'daily', date: performanceDate, stations: codes.join(',') })}`;
  const loss = lossRecovery;
  const blocked = (loss?.blocked_needs_review || 0) + (loss?.blocked_exit || 0) + (loss?.on_hold || 0);
  const coverage = m.expected ? `${m.observed}/${m.expected} location-days` : null;
  const primaryCount = [canCost, canCost, canPerformance, canLosses && loss].filter(Boolean).length;

  return (
    <section className={styles.insight} aria-label="Period summary">
      <header className={styles.insightHead}>
        <div>
          <p className={styles.eyebrow}>Period summary</p>
          <h2>{date(period.from)} – {date(period.to)}</h2>
        </div>
        {coverage ? <span className={styles.coverageChip}>{coverage} covered</span> : null}
      </header>

      <div className={styles.kpiGrid} data-count={primaryCount || undefined}>
        {canCost ? (
          <Link prefetch={false} href={costHref} className={styles.kpi} data-emphasis="primary">
            <span>Shipment volume <ArrowUpRight size={14} /></span>
            <strong>{m.observed ? number(m.total?.deliveries) : '—'}</strong>
            <small>Delivered · open shipment actuals</small>
          </Link>
        ) : null}
        {canCost ? (
          <Link prefetch={false} href={costHref} className={styles.kpi} data-provisional={m.provisional || undefined}>
            <span>
              {m.provisional ? <em className={styles.provisional}>Provisional</em> : null}
              Cost per shipment
              <ArrowUpRight size={14} />
            </span>
            <strong>{money(m.total?.cps)}</strong>
            <small>Open cost breakdown &amp; sources</small>
          </Link>
        ) : null}
        {canPerformance ? (
          <Link prefetch={false} href={perfHref} className={styles.kpi} data-tone={(m.performanceRisk ?? 0) > 0 ? 'warn' : undefined}>
            <span>Service performance <ArrowUpRight size={14} /></span>
            <strong>{number(m.performanceRisk)}<em> groups flagged</em></strong>
            <small>{date(performanceDate)} · open performance actuals</small>
          </Link>
        ) : null}
        {canLosses && loss ? (
          <Link prefetch={false} href={lossHrefs?.all || '/team-ops/losses/nl'} className={styles.kpi}>
            <span>Recoverable losses <ArrowUpRight size={14} /></span>
            <strong>{money(loss.total_recoverable)}</strong>
            <small>Scoped stations · open Losses</small>
          </Link>
        ) : null}
      </div>

      {canLosses && loss ? (
        <div className={styles.queueBand} aria-label="Loss recovery queue">
          <p className={styles.queueLabel}>Loss recovery queue</p>
          <div className={styles.queueChips}>
            <Link prefetch={false} href={lossHrefs?.station || '/team-ops/losses/nl'} className={styles.queueChip}>
              <span>Awaiting station</span>
              <strong>{number(loss.awaiting_station)}</strong>
            </Link>
            <Link prefetch={false} href={lossHrefs?.cluster || '/team-ops/losses/nl'} className={styles.queueChip}>
              <span>Awaiting cluster</span>
              <strong>{number(loss.awaiting_cluster)}</strong>
            </Link>
            <Link prefetch={false} href={lossHrefs?.slp || '/team-ops/losses/nl'} className={styles.queueChip}>
              <span>Awaiting SLP</span>
              <strong>{number(loss.awaiting_slp)}</strong>
            </Link>
            <Link prefetch={false} href={lossHrefs?.due || '/team-ops/losses/nl'} className={styles.queueChip} data-tone={loss.overdue ? 'urgent' : undefined}>
              <span>Due this cycle</span>
              <strong>{number(loss.due_this_cycle)}</strong>
              <small>{loss.overdue ? `${loss.overdue} overdue` : (loss.salary_month || 'payroll')}</small>
            </Link>
            <Link prefetch={false} href={lossHrefs?.review || '/team-ops/losses/nl'} className={styles.queueChip} data-tone={blocked ? 'urgent' : undefined}>
              <span>Blocked / review</span>
              <strong>{number(blocked)}</strong>
              <small>Needs review · exit · hold</small>
            </Link>
          </div>
        </div>
      ) : null}

      {errors.length > 0 ? (
        <p className={styles.sourceNote} role="status">Unavailable: {errors.join(', ')}. No missing result is shown as zero.</p>
      ) : null}

      {canCost ? (
        <details className={styles.sources}>
          <summary>How these figures are calculated</summary>
          <div>
            <p>CPS uses the same live cost store as the CPS section: operating costs ÷ deliveries including SWA and customer returns. Missing source data keeps the figure provisional. Targets, costs and daily station detail remain in CPS.</p>
            <p>Shipment coverage: {m.observed}/{m.expected} location-days. Links retain the selected dates and location scope.</p>
            {canLosses && loss ? (
              <p>Loss cards use the same station scope as Losses and deep-link to existing filters. Amounts are recoverable case totals, not payroll-deducted figures.</p>
            ) : null}
            <Link prefetch={false} href={costHref}>Open sources and actuals →</Link>
          </div>
        </details>
      ) : null}
    </section>
  );
}
