"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PaymentReleaseReviewPanel } from "./payment-release-review";
import { selectionExpected, type FinanceSubmission, type PayrollPreview } from "@/lib/people-payroll-finance";
import styles from "./payment-release.module.css";
type Batch = { id: string; bank_id: string; value_date: string; created_at: string; request_ids?: string[]; line_count?: number; amount_paise?: number };
type Detail = PayrollPreview & { batches: Batch[]; events: { action: string; reason: string; created_at: string }[] };
const money = (v: number) => '₹' + Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const time = (v: string) => new Date(v).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
async function request(url: string, init?: RequestInit) {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, cache: 'no-store' });
    if (!response.ok) throw Error((await response.json().catch(() => null))?.error || 'Unable to complete the request. Refresh to check its status.');
    return response;
  } catch (e) { if (controller.signal.aborted) throw Error('Taking longer than expected. Refresh and check Download history before retrying.'); throw e; }
  finally { clearTimeout(timeout); }
}
export function PeopleFinancePayroll() {
  const [rows, setRows] = useState<FinanceSubmission[]>([]), [banks, setBanks] = useState<{ id: string; display_name: string }[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]), [canEdit, setCanEdit] = useState(false);
  const [selectedId, setSelectedId] = useState(''), [chosenIds, setChosenIds] = useState<string[]>([]);
  const [search, setSearch] = useState(''), [month, setMonth] = useState(''), [showAll, setShowAll] = useState(false);
  const [reason, setReason] = useState(''), [overrideReason, setOverrideReason] = useState(''), [bank, setBank] = useState('');
  const [date, setDate] = useState(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()));
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [detailLoading, setDetailLoading] = useState(false), [detailError, setDetailError] = useState('');
  const [detail, setDetail] = useState<Detail | null>(null), [returnConfirm, setReturnConfirm] = useState(false);
  const pending = useRef(false), detailVersion = useRef(0), detailPanel = useRef<HTMLElement | null>(null), operation = useRef<{ key: string; id: string } | null>(null);
  const selected = rows.find(r => r.id === selectedId);
  const chosen = rows.filter(r => chosenIds.includes(r.id));
  const overrides = chosen.filter(r => r.requiresOverride);
  const load = useCallback(async () => {
    setLoading(true);
    try { const data = await (await request('/api/payments/people-payroll')).json(); setRows(data.requests); setBanks(data.banks); setBatches(data.batches ?? []); setCanEdit(data.canEdit); setBank(previous => data.banks.some((b: {id:string}) => b.id === previous) ? previous : data.banks.length === 1 ? data.banks[0].id : ''); }
    finally { setLoading(false); }
  }, []);
  const loadDetail = useCallback(async (id: string) => {
    const version = ++detailVersion.current; setDetail(null); setDetailLoading(true); setDetailError('');
    try { const data = await (await request('/api/payments/people-payroll?request=' + id)).json(); if (version === detailVersion.current) setDetail(data); }
    catch (e) { if (version === detailVersion.current) setDetailError(e instanceof Error ? e.message : 'Payroll detail could not be loaded.'); }
    finally { if (version === detailVersion.current) setDetailLoading(false); }
  }, []);
  useEffect(() => { load().catch(e => setError(e.message)); }, [load]);
  useEffect(() => { setDetail(null); setReason(''); setReturnConfirm(false); if (selectedId) { loadDetail(selectedId); detailPanel.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } return () => { detailVersion.current++; }; }, [selectedId, loadDetail]);
  const searched = useMemo(() => rows.filter(r => `${r.station} ${r.station_name} ${r.submitted_name}`.toLowerCase().includes(search.trim().toLowerCase())), [rows, search]);
  const months = useMemo(() => [...new Set([
    ...searched.filter(r => showAll || r.amountPaise > 0 || r.issues.length > 0).map(r => r.run.period_start.slice(0, 7)),
    ...(month ? [month] : [])
  ])].sort().reverse(), [searched, showAll, month]);
  const visible = searched.filter(r => (!month || r.run.period_start.startsWith(month)) && (showAll || r.amountPaise > 0 || r.issues.length > 0));
  const total = chosen.reduce((a, r) => a + r.amountPaise, 0) / 100;
  const actionLabel = overrides.length ? 'Override & download' : chosen.some(r => r.status === 'submitted') ? 'Approve & download' : 'Download bank file';
  async function act(action: string, batch?: Batch) {
    if (pending.current) return;
    const targets = action === 'approve_download' ? chosen : action === 'bank_file_combined' ? rows.filter(r => batch?.request_ids?.includes(r.id)) : selected ? [selected] : [];
    if (!targets.length) return;
    const bankId = batch?.bank_id ?? bank, valueDate = batch?.value_date ?? date;
    // Keep the operation stable on retries, but a changed preview starts a new operation.
    const key = JSON.stringify([targets.map(r => [r.id, r.version, r.hash, r.amountPaise]).sort(), bankId, valueDate]);
    if (!operation.current || operation.current.key !== key) operation.current = { key, id: crypto.randomUUID() };
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const response = await request('/api/payments/people-payroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        action, requestId: selected?.id, requestIds: batch?.request_ids ?? targets.map(r => r.id), version: selected?.version, reason, overrideReason,
        bankId, valueDate, operationId: batch?.id ?? operation.current.id, expected: selectionExpected(targets)
      }) });
      if (action.startsWith('bank_file') || action === 'approve_download') {
        const url = URL.createObjectURL(await response.blob()); const link = document.createElement('a');
        link.href = url; link.download = `People-payroll-${valueDate}-${batch?.id ?? operation.current.id}.xlsx`;
        document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        setNotice('Bank file downloaded. Upload it to the bank once. These payments are now processing; use Download history if you need the same file again.'); setChosenIds([]); setOverrideReason('');
      } else { setNotice(action === 'approve' ? 'Payroll approved for payment.' : 'Returned to People for correction. No bank file was created.'); setReturnConfirm(false); }
      await load(); if (selectedId) await loadDetail(selectedId);
    } catch (e) { setError(e instanceof Error ? e.message : 'Action failed.'); }
    finally { pending.current = false; setBusy(false); }
  }
  return <div className={`${styles.workspace} ${styles.payroll}`}>
    <div className={styles.toolbar}><div><h2>Select locations. Download one bank file.</h2><p>Finance approval is included. Paid, processing, blocked and held amounts stay out.</p></div><button className={styles.secondary} disabled={busy || loading} onClick={() => load().catch(e => setError(e.message))}>{loading ? 'Checking…' : 'Refresh'}</button></div>
    {error && <p role="alert">{error}</p>}{notice && <p role="status" className={styles.success}>{notice}</p>}
    <div className={styles.toolbar}>
      <input aria-label="Search payroll" placeholder="Search location or submitter" value={search} onChange={e => setSearch(e.target.value)} />
      <select aria-label="Salary month filter" value={month} onChange={e => setMonth(e.target.value)}><option value="">All salary months</option>{months.map(m => <option key={m}>{m}</option>)}</select>
      <label><input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} /> Show locations with no payment due</label>
      <button className={styles.secondary} disabled={busy || loading || !visible.some(r => r.canProcess && !r.requiresOverride)} onClick={() => setChosenIds(ids => [...new Set([...ids, ...visible.filter(r => r.canProcess && !r.requiresOverride).map(r => r.id)])])}>Select payable locations</button>
      {!!chosenIds.length && <button className={styles.secondary} disabled={busy} onClick={() => setChosenIds([])}>Clear</button>}
    </div>
    <section className={styles.downloadBar} aria-label="Bank download">
      <div><strong>{chosen.length} locations · {chosen.reduce((a, r) => a + r.readyCount, 0)} payments · {money(total)}</strong><small>{chosen.length ? chosen.map(r => r.station).join(', ') : 'Select locations below to prepare your file.'}</small></div>
      <label>Pay from<select value={bank} disabled={busy} onChange={e => setBank(e.target.value)}><option value="">Choose bank</option>{banks.map(b => <option key={b.id} value={b.id}>{b.display_name}</option>)}</select></label>
      <label>Payment date<input type="date" value={date} disabled={busy} onChange={e => setDate(e.target.value)} /></label>
      <button disabled={busy || loading || !canEdit || !bank || !date || !chosen.length || chosen.some(r => !r.canProcess) || (overrides.length > 0 && overrideReason.trim().length < 10)} onClick={() => act('approve_download')}>{busy ? 'Preparing…' : actionLabel}</button>
      {!!overrides.length && <div className={styles.overrideBox}>
        <strong>Managing Partner override · {overrides.map(r => r.station).join(', ')}</strong>
        <p>{overrides.some(r => r.status === 'returned') ? 'This approves the returned payroll without sending it back to People. ' : ''}{overrides.some(r => r.status === 'submitted') ? 'This approves your own submission. ' : ''}Your reason and the previous decision are saved in the history.</p>
        <label>Reason for override<input value={overrideReason} disabled={busy} minLength={10} maxLength={2000} onChange={e => setOverrideReason(e.target.value)} placeholder="Explain the exception or accidental return" /></label>
      </div>}
      {!!chosen.length && <small className={styles.fullWidth}>Downloading approves the selected payroll and marks included payments as processing. It does not transfer money.</small>}
    </section>
    <div className={styles.tableWrap}><table><thead><tr><th>Select</th><th>Location / month</th><th>Pay now</th><th>Status</th><th>Details</th></tr></thead><tbody>{visible.map(r => <tr key={r.id} className={r.id === selectedId ? styles.selectedRow : undefined}>
      <td><input aria-label={`Select ${r.station} ${r.run.label}`} type="checkbox" checked={chosenIds.includes(r.id)} disabled={busy || loading || !r.canProcess} onChange={e => setChosenIds(ids => e.target.checked ? [...new Set([...ids, r.id])] : ids.filter(id => id !== r.id))} /></td>
      <td><strong>{r.station}</strong><small>{r.run.label}</small></td>
      <td><strong>{money(r.amountPaise / 100)}</strong><small>{r.readyCount} payable · {r.excludedCount} excluded</small></td>
      <td><span className={r.canProcess && !r.requiresOverride ? styles.goodBadge : styles.badge}>{r.status === 'returned' ? 'Returned' : r.canProcess && !r.requiresOverride ? 'Ready' : 'Needs attention'}</span><small>{r.nextStep}</small>{r.status === 'returned' && r.review_note && <small>Return note: {r.review_note}</small>}</td>
      <td><button className={styles.secondary} disabled={busy} onClick={() => { setSelectedId(r.id); setError(''); }}>View</button>{(r.changed || r.status === 'returned') && !r.canOverride && <small><a href={`https://people.dropxlogistics.com/payroll/${r.run_id}`}>Open in People ↗</a></small>}</td>
    </tr>)}</tbody></table></div>
    {!loading && !visible.length && <p>No locations with a payment due match this view. Use Download history for files already prepared, or show all locations.</p>}
    {!!batches.length && <details><summary>Download history · {batches.length} files</summary>{batches.map(b => <div className={styles.toolbar} key={b.id}><span><strong>{b.value_date} · {b.request_ids?.length} locations · {money((b.amount_paise ?? 0) / 100)}</strong><small>{b.line_count} payments · {time(b.created_at)}</small></span><button disabled={busy || !canEdit} onClick={() => act('bank_file_combined', b)}>Download same file</button></div>)}</details>}
    {selected && <section ref={detailPanel} className={styles.detail} aria-label="Selected payroll review">
      <div className={styles.toolbar}><div><h2>{selected.station} · {selected.run.label}</h2><small>Submitted by {selected.submitted_name} · {time(selected.submitted_at)}</small><p>{selected.nextStep}</p></div><button className={styles.secondary} disabled={busy} onClick={() => setSelectedId('')}>Close</button></div>
      {detailLoading && <p role="status">Loading payroll detail…</p>}
      {detailError && <div role="alert">{detailError} <button disabled={busy || detailLoading} onClick={() => loadDetail(selected.id)}>Retry</button></div>}
      {detail && <div className={styles.tableWrap}><table><thead><tr><th>Person</th><th>Net</th><th>Hold / loss</th><th>Paid</th><th>Pay now</th><th>Bank / status</th></tr></thead><tbody>{detail.people.map(p => <tr key={p.worker}><td>{p.name}</td><td>{money(p.net)}</td><td>{money(p.items.filter(x => x.code === 'SALARY_HOLD').reduce((a, x) => a + Number(x.amount), 0))}<small>Loss {money(p.items.filter(x => x.code === 'OPS_LOSS_RECOVERY').reduce((a, x) => a + Number(x.amount), 0))}</small></td><td>{money(p.paid)}</td><td>{money(p.payable)}</td><td>{p.bankLast4 ? '•••• ' + p.bankLast4 : 'Missing'}<small>{p.exclusion ?? 'Ready'}</small></td></tr>)}</tbody></table></div>}
      <details key={selected.id} open={selected.clearanceRequired && !selected.clearance ? true : undefined}><summary>NL / SLP losses · {selected.lossPending} pending · {selected.clearance ? 'cleared' : !selected.clearanceRequired ? 'not blocking payment' : 'clearance needed'}</summary><PaymentReleaseReviewPanel initialStation={selected.station_id} initialMonth={selected.run.period_start.slice(0, 7)} initialScope={`people:${selected.run_id}`} embedded onChange={() => load().catch(e => setError(e.message))} /></details>
      {selected.status === 'submitted' && <details><summary>Other actions</summary>
        {selected.canApprove && <button disabled={busy || !detail || detail.changed || detail.hash !== selected.hash} onClick={() => act('approve')}>Approve without downloading</button>}
        <button className={styles.secondary} disabled={busy || !canEdit} onClick={() => setReturnConfirm(true)}>Return for correction…</button>
        {returnConfirm && <div className={styles.confirm}><strong>Return {selected.station} to People?</strong><p>This stops payment until People resubmits or a Managing Partner records an override. Use the bank download above to release payment.</p><label>What needs correcting?<textarea value={reason} maxLength={2000} onChange={e => setReason(e.target.value)} disabled={busy} /></label><button disabled={busy || reason.trim().length < 10} onClick={() => act('return')}>Confirm return — do not pay</button><button className={styles.secondary} disabled={busy} onClick={() => setReturnConfirm(false)}>Cancel</button></div>}
      </details>}
      {detail?.batches.length ? <details><summary>Earlier location bank files</summary>{detail.batches.map(b => <div className={styles.toolbar} key={b.id}><span>{b.value_date} · {time(b.created_at)}</span><button disabled={busy || !canEdit} onClick={() => act('bank_file', b)}>Download existing file</button></div>)}</details> : null}
      {detail?.events.length ? <details><summary>Decision history</summary>{detail.events.map((e, i) => <p key={i}>{e.action.replaceAll('_', ' ')} · {time(e.created_at)}<small>{e.reason}</small></p>)}</details> : null}
    </section>}
  </div>;
}
