'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BarChart3, X } from 'lucide-react';
import { mappingLookupToday } from '@/lib/provider-mapping-lookup';
import type { ProviderMappingInsights } from '@/lib/provider-mapping-insights';
import styles from './provider-id-insights.module.css';

type Insights = ProviderMappingInsights & {name: string; station: string; provider: string};
const money = (value: number | null) => value == null ? '—' : `₹${value.toLocaleString('en-IN', {maximumFractionDigits: 2})}`;
const dateLabel = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-IN', {day: 'numeric', month: 'short', timeZone: 'UTC'});

export function ProviderIdInsights({memberId, stationId, providerId}: {memberId: string; stationId: string; providerId: string}) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => mappingLookupToday().slice(0, 7));
  const [data, setData] = useState<Insights | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const title = useId();
  useEffect(() => {
    if (!open) return;
    dialog.current?.showModal();
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; trigger.current?.focus(); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setData(null); setError('');
    const params = new URLSearchParams({memberId, stationId, providerId, month});
    void fetch(`/api/provider-mapping/insights?${params}`, {cache: 'no-store', signal: controller.signal})
      .then(async response => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Could not load insights.');
        if (!controller.signal.aborted) setData(body);
      }).catch(err => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Could not load insights.'); });
    return () => controller.abort();
  }, [open, month, memberId, stationId, providerId, retry]);
  return <>
    <button ref={trigger} type="button" className={styles.trigger} title="View month-to-date deliveries and cost" aria-label={`View deliveries and cost for provider ID ${memberId}`} onClick={() => setOpen(true)}>{memberId}<BarChart3 size={12} aria-hidden /></button>
    {open && createPortal(<dialog ref={dialog} className={styles.dialog} aria-labelledby={title} onCancel={() => setOpen(false)} onClick={event => { if (event.target === event.currentTarget) setOpen(false); }}>
      <div className={styles.content}>
        <header className={styles.header}>
          <div><h2 id={title}>Deliveries &amp; cost</h2><span className={styles.identity}>{memberId}{data ? ` · ${data.station}` : ''}</span></div>
          <button type="button" className={styles.close} aria-label="Close delivery insights" onClick={() => setOpen(false)} autoFocus><X size={18} /></button>
        </header>
        <div className={styles.toolbar}><div><strong>{data?.name || 'Provider / FHR ID'}</strong><span>{data?.methods.join(' · ') || 'Saved payment setup'}</span></div><label>Month<input aria-label="Delivery month" type="month" value={month} min="2020-01" max={mappingLookupToday().slice(0, 7)} onChange={event => { if (event.target.value) setMonth(event.target.value); }} /></label></div>
        {!data && !error ? <p className={styles.message} role="status">Loading deliveries and mapped pay…</p> : null}
        {error ? <p className={styles.message} role="alert">{error} <button type="button" onClick={() => setRetry(n => n + 1)}>Retry</button></p> : null}
        {data ? <>
          <div className={styles.summary}>
            <div><span>{month === mappingLookupToday().slice(0, 7) ? 'MTD deliveries' : 'Deliveries'}</span><strong>{data.latestReport ? data.deliveries.toLocaleString('en-IN') : '—'}</strong></div>
            <div><span>Est. mapped pay</span><strong>{money(data.cost)}</strong></div>
            <div><span>Average CPS</span><strong>{money(data.cps)}</strong></div>
          </div>
          <p className={styles.caption}>{data.latestReport ? `Through ${dateLabel(data.latestReport)} · Latest imported report` : 'No reports imported for this ID in this month.'}</p>
          {data.costIssue && data.latestReport ? <p className={styles.notice}>{data.costIssue}</p> : null}
          {data.cost != null && data.paymentBreakdown.filter(line => line.schedule === 'per_day').map((line, index) => <p className={styles.caption} key={index}>{line.label}: {money(line.rate)} × {line.count} delivery days = {money(line.amount)}</p>)}
          {data.latestReport ? <div className={styles.tableScroll}><table><thead><tr><th scope="col">Day</th><th scope="col">Delivered</th><th scope="col">Pay</th><th scope="col">CPS</th></tr></thead><tbody>{data.days.map(day => <tr key={day.date}><td>{dateLabel(day.date)}{day.note ? <small>{day.note}</small> : null}</td><td>{day.deliveries == null ? '—' : day.deliveries.toLocaleString('en-IN')}</td><td>{money(day.cost)}</td><td>{money(day.cps)}</td></tr>)}</tbody></table></div> : null}
          <details className={styles.basis}><summary>Calculation basis</summary><p>Daily fixed pay, MG and daily allowances use the saved rate × days with imported deliveries within the mapping’s effective dates. Each delivery day counts once. Monthly, hourly and production components retain their configured calculation rules. Average CPS = estimated mapped pay ÷ imported deliveries. This estimate does not change payroll attendance or payable amounts.</p><p>Excludes ad hoc payments, extra payments and deductions. A dash means missing data or no deliveries; it does not mean zero cost. Range-based attendance has no daily CPS.</p>{data.paymentBreakdown.map((line, index) => <p key={index}>{line.label}: {line.count} {line.schedule === 'per_day' ? 'delivery days' : line.schedule === 'per_hour' ? 'hours' : line.schedule === 'per_month' ? 'month units' : 'units'} × {money(line.rate)} = {money(line.amount)}</p>)}{data.people.length ? <p>Mapped associate: {data.people.join('; ')}</p> : null}</details>
        </> : null}
      </div>
    </dialog>, document.body)}
  </>;
}
