"use client";
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PaymentReleaseReview } from '@/lib/payment-release-types';
import styles from './payment-release.module.css';
type Task = { id: string; station_id: string; station?: string; salary_month: string; scope_key: string; assigned_to: string; owner?: string; requested_by: string; status: string; due_date: string; note: string; fingerprint: string; version: number };
type Options = { stations: { id: string; station_code: string; station_name: string }[]; runs: { id: string; label: string; period_start: string }[]; canApprove: boolean; canEdit: boolean; actorId: string; queue: Task[] };
type Review = PaymentReleaseReview & { clearanceRequired: boolean; reviewers: { id: string; name: string }[]; handoff: Task | null; history: { id: string; action: string; reason: string; actor_name: string; created_at: string }[]; handoffEvents: { action: string; reason: string; created_at: string }[] };
const money = (v: number) => `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const dateTime = (v: string) => new Date(v).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
async function jsonRequest(url: string, init?: RequestInit) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 45000);
  try { const response = await fetch(url, { ...init, signal: controller.signal, cache: 'no-store' }); const data = await response.json(); if (!response.ok) throw Error(data.error); return data; }
  catch(e) { if(controller.signal.aborted) throw Error('Review is taking longer than expected. Refresh to check the saved status before retrying.'); throw e; }
  finally { clearTimeout(timer); }
}
export function PaymentReleaseReviewPanel({ initialStation = '', initialMonth = '', initialScope = 'workforce', embedded = false, onChange }: { initialStation?: string; initialMonth?: string; initialScope?: string; embedded?: boolean; onChange?: () => void }) {
  const [options, setOptions] = useState<Options | null>(null), [station, setStation] = useState(initialStation);
  const [month, setMonth] = useState(initialMonth || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()).slice(0, 7)), [scope, setScope] = useState(initialScope);
  const [review, setReview] = useState<Review | null>(null), [reason, setReason] = useState(''), [owner, setOwner] = useState(''), [followUp, setFollowUp] = useState('');
  const [confirmed, setConfirmed] = useState(false), [override, setOverride] = useState(false), [mode, setMode] = useState<'review' | 'handoff' | ''>('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const generation = useRef(0), pending = useRef(false);
  const loadOptions = useCallback(async () => setOptions(await jsonRequest('/api/payments/loss-clearance?options=1')), []);
  useEffect(() => { loadOptions().catch(e => setError(e.message)); }, [loadOptions]);
  const load = useCallback(async () => {
    if (!station) return;
    const version = ++generation.current; setBusy(true); setError(''); setReview(null); setConfirmed(false); setMode('');
    try { const data = await jsonRequest(`/api/payments/loss-clearance?${new URLSearchParams({ station, month, scope })}`); if (generation.current === version) { setReview(data); setReason(''); setOwner(''); setFollowUp(''); setOverride(Boolean(data.pendingCount || data.missingDeductionCount)); } }
    catch(e) { if(generation.current === version) setError(e instanceof Error ? e.message : 'Review failed.'); }
    finally { if(generation.current === version) setBusy(false); }
  }, [station, month, scope]);
  useEffect(() => { setReview(null); setNotice(''); if(station) load(); return () => { generation.current++; }; }, [load, station]);
  const exception = Boolean(review && (review.pendingCount || review.missingDeductionCount));
  const needsOverride = exception || override;
  const ownerName = review?.reviewers.find(r => r.id === owner)?.name ?? '';
  async function decide(action: string) {
    if (!review || pending.current) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const data = await jsonRequest('/api/payments/loss-clearance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ station, month, scope, action, fingerprint: review.fingerprint, reason: reason.trim() || (action === 'approve' ? 'Source completeness and payroll deductions reviewed and cleared.' : ''), owner: ownerName, assignee: owner, followUp, version: review.handoff?.version ?? 0 }) });
      setReview(data); setConfirmed(false); setMode('');
      setNotice(action === 'request' ? 'Assigned in the loss-clearance review queue.' : action === 'return' ? 'Returned with your correction note.' : action === 'exception' ? 'Override recorded. Salary release is cleared; the pending losses remain due for follow-up.' : action === 'revoke' ? 'Clearance withdrawn. New bank files need another review.' : 'Loss clearance approved. Finance can continue its payroll review.');
      onChange?.(); await loadOptions();
    } catch(e) { setError(e instanceof Error ? e.message : 'Action failed.'); }
    finally { pending.current = false; setBusy(false); }
  }
  return <section className={`${styles.workspace} ${embedded ? styles.compact : ''}`} aria-label="Loss clearance review">
    <div className={styles.toolbar}><div><h2>NL / SLP loss clearance</h2><p>Review losses, hand off corrections, or authorise a recorded exception.</p></div><button className={styles.secondary} disabled={busy} onClick={() => { loadOptions().catch(e => setError(e.message)); if (station) load(); }}>Refresh clearance</button></div>
    {!embedded && <>
      {!!options?.queue.length && <details open><summary>Review queue · {options.queue.length} handoffs</summary><div className={styles.tableWrap}><table><thead><tr><th>Location / month</th><th>Assigned to</th><th>Follow-up</th><th>Action</th></tr></thead><tbody>{options.queue.map(t => <tr key={t.id}><td>{t.station} · {t.salary_month}<small>{t.scope_key.startsWith('people:') ? 'People payroll' : t.scope_key} · {t.status.replaceAll('_', ' ')}</small></td><td>{t.owner}{t.assigned_to === options.actorId && ' · You'}<small>{t.note}</small></td><td>{t.due_date}</td><td><button disabled={busy} onClick={() => { if(station === t.station_id && month === t.salary_month && scope === t.scope_key) load(); else { setStation(t.station_id); setMonth(t.salary_month); setScope(t.scope_key); } }}>Open review</button></td></tr>)}</tbody></table></div></details>}
      <div className={styles.inlineFields}>
        <label>Salary month<input type="month" value={month} onChange={e => setMonth(e.target.value)} disabled={busy} /></label>
        <label>Station<select value={station} onChange={e => setStation(e.target.value)} disabled={busy}><option value="">Choose location</option>{options?.stations.map(s => <option key={s.id} value={s.id}>{s.station_code} · {s.station_name}</option>)}</select></label>
        <label>Payroll source<select value={scope} onChange={e => { setScope(e.target.value); const run = options?.runs.find(r => `people:${r.id}` === e.target.value); if (run) setMonth(run.period_start.slice(0, 7)); }} disabled={busy}><option value="workforce">Workforce payouts</option><option value="helpers">Helper payouts</option>{options?.runs.map(r => <option key={r.id} value={`people:${r.id}`}>People · {r.label}</option>)}</select></label>
      </div>
    </>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status" className={styles.success}>{notice}</p>}
    {busy && !review && <p role="status">Checking loss clearance…</p>}
    {review && <>
      <div className={styles.toolbar}><strong className={review.approval ? styles.goodBadge : styles.badge}>{review.approval ? review.approval.mode === 'exception' ? 'Released with override' : 'Cleared' : review.clearanceRequired ? 'Awaiting clearance' : 'Clearance gate disabled in Master'}</strong><span>{review.sourceCount} cases · {review.pendingCount} pending updates ({money(review.pendingAmount)}) · {review.missingDeductionCount} unapplied deductions ({money(review.missingDeductionAmount)})</span></div>
      {!review.sourceCount && <p>No loss cases recorded. Verify expected NL / SLP imports before clearing.</p>}
      {review.approval && <small>{review.approval.actor} · {dateTime(review.approval.at)} IST · {review.approval.reason}</small>}
      {review.handoff && <p><strong>{review.handoff.status === 'resolved' && !review.approval ? 'Review needed again after source changes' : review.handoff.status === 'follow_up' ? 'Recovery follow-up outstanding' : `Handoff ${review.handoff.status}`}</strong> · {review.reviewers.find(r => r.id === review.handoff?.assigned_to)?.name ?? 'Assigned reviewer'} · due {review.handoff.due_date}<small>{review.handoff.note}</small></p>}
      {exception && <details><summary>View pending items and deductions</summary><div className={styles.tableWrap}><table><thead><tr><th>Source / person</th><th>Shipment / recovery</th><th>Amount</th><th>Needs attention</th></tr></thead><tbody>{review.pending.map(p => <tr key={`${p.month}:${p.reference}`}><td>{p.report.toUpperCase()} · {p.month}</td><td>{p.reference}</td><td>{money(p.amount)}</td><td>{p.status}</td></tr>)}{review.missingDeductions.map(p => <tr key={p.reference}><td>{p.worker}</td><td>{p.reference}</td><td>{money(p.amount)}</td><td>Deduction awaiting application</td></tr>)}</tbody></table></div></details>}
      <div className={styles.toolbar}>
        {options?.canApprove && <button disabled={busy} onClick={() => { setMode('review'); setConfirmed(false); setOwner(review.handoff?.assigned_to ?? (review.reviewers.some(r => r.id === options.actorId) ? options.actorId : '')); setFollowUp(review.handoff?.due_date ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + 7 * 86400000))); }}>{review.approval ? 'Change clearance / override' : 'Review clearance / override'}</button>}
        {options?.canEdit && <button className={styles.secondary} disabled={busy} onClick={() => { setMode('handoff'); setConfirmed(false); }}>Hand off to reviewer</button>}
        <a href={`https://ops.dropxlogistics.com/team-ops/losses/nl?view=live&station=${encodeURIComponent(options?.stations.find(s => s.id === station)?.station_code ?? "")}`}>Open loss records ↗</a>
      </div>
      {mode && <div className={styles.decision}>
        <label>{mode === 'handoff' ? 'Handoff / correction note' : needsOverride ? 'Reason for override' : 'Note (optional)'}<textarea value={reason} onChange={e => setReason(e.target.value)} minLength={10} maxLength={2000} disabled={busy} placeholder="What was checked, what remains, and what should happen next?" /></label>
        {mode === 'review' && <label><input type="checkbox" checked={needsOverride} disabled={busy || exception} onChange={e => setOverride(e.target.checked)} /> Release with override — retain pending recovery and assign follow-up</label>}
        {(mode === 'handoff' || needsOverride) && <div className={styles.inlineFields}><label>{mode === 'handoff' ? 'Assigned reviewer' : 'Recovery follow-up owner'}<select value={owner} onChange={e => setOwner(e.target.value)} disabled={busy}><option value="">Choose active manager</option>{review.reviewers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label>Follow-up date<input type="date" value={followUp} onChange={e => setFollowUp(e.target.value)} disabled={busy} /></label></div>}
        {mode === 'review' && <>{needsOverride && <p>Pending losses stay due. The owner and follow-up below remain recorded.</p>}{needsOverride && <label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} disabled={busy} /> I authorise release with the listed pending items and accept responsibility for the recorded follow-up.</label>}</>}
        <div>{mode === 'handoff' ? <button disabled={busy || reason.trim().length < 10 || !owner || !followUp} onClick={() => decide('request')}>Send handoff</button> : <><button disabled={busy || (needsOverride && (!confirmed || reason.trim().length < 10 || !owner || !followUp)) || (!needsOverride && reason.trim().length > 0 && reason.trim().length < 10)} onClick={() => decide(needsOverride ? 'exception' : 'approve')}>{needsOverride ? 'Authorise release with override' : 'Confirm losses checked & clear'}</button>{review.approval && <button className={styles.secondary} disabled={busy || reason.trim().length < 10} onClick={() => decide('revoke')}>Withdraw clearance</button>}{['pending', 'follow_up'].includes(review.handoff?.status ?? '') && <button className={styles.secondary} disabled={busy || reason.trim().length < 10} onClick={() => decide('return')}>Return for correction</button>}</>}
        <button className={styles.secondary} disabled={busy} onClick={() => setMode('')}>Cancel</button></div>
      </div>}
      {(review.history.length > 0 || review.handoffEvents.length > 0) && <details><summary>Clearance and handoff history</summary>{review.history.map(h => <p key={h.id}>{h.action} · {h.actor_name} · {dateTime(h.created_at)}<small>{h.reason}</small></p>)}{review.handoffEvents.map((h,i) => <p key={i}>Handoff {h.action} · {dateTime(h.created_at)}<small>{h.reason}</small></p>)}</details>}
    </>}
  </section>;
}
