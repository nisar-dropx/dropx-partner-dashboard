'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Search, X, Route } from 'lucide-react';
import { PaymentDetailValue, isLongPaymentDetail } from '@/components/payment-detail-value';
import { PaymentRequestFacts } from '@/components/payment-request-facts';
import { paymentTrackingEventTone, type PaymentTrackingProgress } from '@/lib/payment-tracking-progress';
import type { PaymentRequestFact } from '@/lib/payment-request-facts';

type Tracking = {
  requestNo: string; location: string; head: string; amount: number | null;
  progress: PaymentTrackingProgress; status: string; owner: string; reference: string | null; facts: PaymentRequestFact[];
  answers: { id: string; label: string; stage: string; value: string | null; attachments: { name: string; url: string }[] }[];
  events: { id: string; action: string; actor: string; role: string; at: string; note: string | null }[];
};
const dateTime = (value: string) => new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(value));

export function PaymentTracker() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<Tracking | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const node = dialog.current;
    node?.showModal();
    input.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      controller.current?.abort();
      node?.close();
      document.body.style.overflow = overflow;
    };
  }, [open]);
  const close = () => { controller.current?.abort(); setBusy(false); setOpen(false); };
  async function search(event: React.FormEvent) {
    event.preventDefault();
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setBusy(true); setError(''); setResult(null);
    try {
      const response = await fetch(`/api/payments/track?q=${encodeURIComponent(query.trim())}`, { cache: 'no-store', signal: request.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to load payment history.');
      if (!request.signal.aborted) setResult(data);
    } catch (err) {
      if (!request.signal.aborted) setError(err instanceof Error ? err.message : 'Unable to load payment history.');
    } finally { if (!request.signal.aborted) setBusy(false); }
  }
  return <>
    <button type="button" className="payment-track-launch" onClick={() => setOpen(true)}><Route size={16} aria-hidden="true" /> Track payment</button>
    <dialog ref={dialog} className="payment-track-drawer" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
      <div className="payment-track-content">
        <header><div><h2 id={titleId}>Track payment</h2><small>Request history · times in IST</small></div><button type="button" className="payment-track-close" aria-label="Close payment tracker" onClick={close}><X size={18} /></button></header>
        <form onSubmit={search} className="payment-track-search">
          <label htmlFor={`${titleId}-search`} className="sr-only">Payment or request ID</label>
          <input ref={input} id={`${titleId}-search`} value={query} onChange={event => setQuery(event.target.value)} placeholder="Payment / request ID" maxLength={120} required autoComplete="off" />
          <button type="submit" disabled={!query.trim() || busy}><Search size={16} aria-hidden="true" /> {busy ? 'Tracking…' : 'Track'}</button>
        </form>
        {error ? <p role="alert" className="payment-track-error">{error}</p> : null}
        <div aria-live="polite" aria-busy={busy}>
          {!result && !busy && !error ? <p className="payment-track-hint">Enter an ID to see its status, submitted details and approval history.</p> : null}
          {result ? <>
            <section className="payment-track-summary">
              <div><strong>{result.requestNo}</strong><strong>{result.amount == null ? '—' : new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(result.amount)}</strong></div>
              <p>{result.location} · {result.head}</p>
              <b className={`payment-track-status payment-track-tone-${['Final Approved', 'Paid'].includes(result.status) ? 'done' : result.progress.tone}`}>{result.status}</b>
              {result.owner && !['Paid', 'Rejected', 'Cancelled'].includes(result.status) ? <p>With: <strong>{result.owner}</strong></p> : null}
              {result.reference ? <p>Bank reference: {result.reference}</p> : null}
            </section>
            <section className="payment-track-progress" aria-label="Payment progress">
              <p className={`payment-track-next payment-track-tone-${result.progress.tone}`}><strong>{result.progress.tone === 'done' ? 'Complete' : result.progress.tone === 'issue' ? 'Action / status' : 'Next'}</strong> · {result.progress.next}</p>
              <ol>{result.progress.milestones.map(step => <li key={step.label} data-state={step.state} aria-current={step.state === 'current' ? 'step' : undefined}><span aria-hidden="true">{step.state === 'done' ? '✓' : step.state === 'issue' ? '!' : step.state === 'current' ? '●' : '○'}</span><span>{step.label}</span><small>{({done: 'Done', current: 'Pending', upcoming: 'Upcoming', issue: 'Action needed', stopped: 'Not proceeding'})[step.state]}</small></li>)}</ol>
            </section>
            <PaymentRequestFacts facts={result.facts} />
            {result.answers.length ? <details className="payment-track-fields"><summary>Submitted fields & attachments ({result.answers.length})</summary><dl>{result.answers.map(answer => <div key={answer.id} className={isLongPaymentDetail(answer.value || "") ? "payment-detail-wide" : undefined}><dt>{answer.label}<small>{answer.stage}</small></dt><dd><PaymentDetailValue value={answer.value || '—'} label={answer.label} />{answer.attachments.map(file => <a key={file.url} href={file.url} target="_blank" rel="noreferrer">{file.name} ↗</a>)}</dd></div>)}</dl></details> : null}
            <h3 className="payment-track-history-title">Request history</h3>
            <ol className="payment-track-timeline">{result.events.map(event => <li key={event.id} data-tone={paymentTrackingEventTone(event.action)}><div><strong>{event.action}</strong><time dateTime={event.at}>{dateTime(event.at)}</time></div><p>{event.actor}{event.role ? ` · ${event.role}` : ''}</p>{event.note ? <p className="payment-track-note">{event.note}</p> : null}</li>)}</ol>
          </> : null}
        </div>
      </div>
    </dialog>
  </>;
}
