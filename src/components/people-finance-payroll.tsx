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
  } catch (e) { if (controller.signal.aborted) throw Error('The request is taking longer than expected. Refresh to check the result; use download history to retrieve a file already created.'); throw e; }
  finally { clearTimeout(timeout); }
}
export function PeopleFinancePayroll() {
  const [rows, setRows] = useState<FinanceSubmission[]>([]), [banks, setBanks] = useState<{ id: string; display_name: string }[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]), [canEdit, setCanEdit] = useState(false);
  const [selectedId, setSelectedId] = useState(''), [chosenIds, setChosenIds] = useState<string[]>([]);
  const [search, setSearch] = useState(''), [month, setMonth] = useState(''), [status, setStatus] = useState('');
  const [reason, setReason] = useState(''), [bank, setBank] = useState('');
  const [date, setDate] = useState(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()));
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [detailLoading, setDetailLoading] = useState(false), [detailError, setDetailError] = useState('');
  const [detail, setDetail] = useState<Detail | null>(null), [confirm, setConfirm] = useState<FinanceSubmission[] | null>(null);
  const pending = useRef(false), detailVersion = useRef(0), operation = useRef<{ key: string; id: string } | null>(null);
  const selected = rows.find(r => r.id === selectedId);
  const chosen = rows.filter(r => chosenIds.includes(r.id));
  const load = useCallback(async () => {
    setLoading(true); setConfirm(null);
    try { const data = await (await request('/api/payments/people-payroll')).json(); setRows(data.requests); setBanks(data.banks); setBatches(data.batches ?? []); setCanEdit(data.canEdit); }
    finally { setLoading(false); }
  }, []);
  const loadDetail = useCallback(async (id: string) => {
    const version = ++detailVersion.current; setDetail(null); setDetailLoading(true); setDetailError('');
    try {
      const data = await (await request('/api/payments/people-payroll?request=' + id)).json();
      if (version === detailVersion.current) setDetail(data);
    } catch (e) { if (version === detailVersion.current) setDetailError(e instanceof Error ? e.message : 'Payroll detail could not be loaded.'); }
    finally { if (version === detailVersion.current) setDetailLoading(false); }
  }, []);
  useEffect(() => { load().catch(e => setError(e.message)); }, [load]);
  useEffect(() => { setDetail(null); setReason(''); if (selectedId) loadDetail(selectedId).catch(e => setError(e.message)); return () => { detailVersion.current++; }; }, [selectedId, loadDetail]);
  const searched = useMemo(() => rows.filter(r => `${r.station} ${r.station_name} ${r.submitted_name}`.toLowerCase().includes(search.trim().toLowerCase())), [rows, search]);
  const months = [...new Set([...searched.filter(r => !status || r.status === status).map(r => r.run.period_start.slice(0, 7)), ...(month ? [month] : [])])].sort().reverse();
  const statuses = [...new Set([...searched.filter(r => !month || r.run.period_start.startsWith(month)).map(r => r.status), ...(status ? [status] : [])])];
  const visible = searched.filter(r => (!month || r.run.period_start.startsWith(month)) && (!status || r.status === status));
  async function act(action: string, batch?: Batch) {
    if (pending.current) return;
    const targets = action === 'bank_file_combined' ? (batch?.request_ids ? rows.filter(r => batch.request_ids!.includes(r.id)) : confirm ?? []) : selected ? [selected] : [];
    if (!targets.length) return;
    const bankId = batch?.bank_id ?? bank, valueDate = batch?.value_date ?? date;
    const key = targets.map(r => r.id).sort().join(',') + ':' + bankId + ':' + valueDate;
    if (!operation.current || operation.current.key !== key) operation.current = { key, id: crypto.randomUUID() };
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const response = await request('/api/payments/people-payroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        action, requestId: selected?.id, requestIds: batch?.request_ids ?? targets.map(r => r.id), version: selected?.version, reason,
        bankId, valueDate, operationId: batch?.id ?? operation.current.id, expected: selectionExpected(targets)
      }) });
      if (action.startsWith('bank_file')) {
        const url = URL.createObjectURL(await response.blob()); const link = document.createElement('a');
        link.href = url; link.download = `People-payroll-${valueDate}-${batch?.id ?? operation.current.id}.xlsx`;
        document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        setNotice('Bank file downloaded. Its payments are now processing. Upload this file once, then reconcile the bank result.'); setConfirm(null); setChosenIds([]);
      } else { setNotice(action === 'approve' ? 'Payroll approved. Select this location to include it in a bank file.' : 'Returned to People with your review note.'); }
      await load(); if (selectedId) await loadDetail(selectedId);
    } catch (e) { setError(e instanceof Error ? e.message : 'Action failed.'); }
    finally { pending.current = false; setBusy(false); }
  }
  return <div className={styles.workspace}>
    <div className={styles.toolbar}><div><h2>Review once. Download together.</h2><p>People submission → NL / SLP clearance → Finance approval → one bank file.</p></div><button disabled={busy || loading} onClick={() => load().catch(e => setError(e.message))}>{loading ? 'Checking…' : 'Refresh'}</button></div>
    {error && <p role="alert">{error}</p>}{notice && <p role="status" className={styles.success}>{notice}</p>}
    <div className={styles.metrics}><div><strong>{rows.filter(r => r.status === 'submitted').length}</strong><span>Awaiting Finance review</span></div><div><strong>{rows.filter(r => r.clearanceRequired && !r.clearance).length}</strong><span>Need loss clearance</span></div><div><strong>{rows.filter(r => r.canDownload).length}</strong><span>Ready for bank file</span></div></div>
    <div className={styles.toolbar}>
      <input aria-label="Search payroll" placeholder="Search location or submitter" value={search} onChange={e => setSearch(e.target.value)} />
      <select aria-label="Salary month filter" value={month} onChange={e => setMonth(e.target.value)}><option value="">All salary months</option>{months.map(m => <option key={m}>{m}</option>)}</select>
      <select aria-label="Finance status filter" value={status} onChange={e => setStatus(e.target.value)}><option value="">All Finance statuses</option>{statuses.map(s => <option key={s}>{s}</option>)}</select>
      <button disabled={busy || loading || !visible.some(r => r.canDownload)} onClick={() => { setConfirm(null); setChosenIds(ids => [...new Set([...ids, ...visible.filter(r => r.canDownload).map(r => r.id)])]); }}>Select ready locations</button>
      {!!chosenIds.length && <button className={styles.secondary} disabled={busy} onClick={() => { setChosenIds([]); setConfirm(null); }}>Clear selection</button>}
    </div>
    <div className={styles.tableWrap}><table><thead><tr><th>Select</th><th>Location / month</th><th>Pay now</th><th>Next step</th><th>Action</th></tr></thead><tbody>{visible.map(r => <tr key={r.id} className={r.id === selectedId ? styles.selectedRow : undefined}>
      <td><input aria-label={`Select ${r.station} ${r.run.label}`} type="checkbox" checked={chosenIds.includes(r.id)} disabled={busy || loading || !r.canDownload} onChange={e => { setConfirm(null); setChosenIds(ids => e.target.checked ? [...ids, r.id] : ids.filter(id => id !== r.id)); }} /></td>
      <td><strong>{r.station}</strong><small>{r.run.label}</small><small>Submitted by {r.submitted_name}</small></td>
      <td><strong>{money(r.amountPaise / 100)}</strong><small>{r.readyCount} payable · {r.excludedCount} excluded</small></td>
      <td><span className={r.canDownload ? styles.goodBadge : styles.badge}>{r.canDownload ? 'Ready' : r.status}</span><small>{r.nextStep}</small></td>
      <td><button disabled={busy} onClick={() => { setSelectedId(r.id); setError(''); }}>Review</button></td>
    </tr>)}</tbody></table></div>
    {!loading && !visible.length && <p>No payroll submissions match this view.</p>}
    <section className={styles.downloadBar} aria-label="Combined bank file">
      <div><strong>{chosen.length} locations selected · {chosen.reduce((a, r) => a + r.readyCount, 0)} payments · {money(chosen.reduce((a, r) => a + r.amountPaise, 0) / 100)}</strong><small>Includes all selected locations, including selections outside the current filters.</small></div>
      <label>Debit bank<select value={bank} disabled={busy} onChange={e => { setBank(e.target.value); setConfirm(null); }}><option value="">Choose bank</option>{banks.map(b => <option key={b.id} value={b.id}>{b.display_name}</option>)}</select></label>
      <label>Value date<input type="date" value={date} disabled={busy} onChange={e => { setDate(e.target.value); setConfirm(null); }} /></label>
      <button disabled={busy || loading || !canEdit || !bank || !date || !chosen.length || chosen.some(r => !r.canDownload)} onClick={() => setConfirm([...chosen])}>Review combined download</button>
    </section>
    {confirm && <section className={styles.confirm} aria-label="Confirm bank file">
      <h3>One bank file · {confirm.length} locations</h3><p>{confirm.map(r => r.station).join(', ')}</p>
      <strong>{confirm.reduce((a, r) => a + r.readyCount, 0)} payments · {money(confirm.reduce((a, r) => a + r.amountPaise, 0) / 100)} · {date}</strong>
      <p>Paid, processing, blocked and fully held people stay out. Creating the file reserves these payments as processing; it does not transfer money.</p>
      <button disabled={busy} onClick={() => act('bank_file_combined')}>{busy ? 'Preparing file…' : 'Create and download one bank file'}</button><button className={styles.secondary} disabled={busy} onClick={() => setConfirm(null)}>Cancel</button>
    </section>}
    {selected && <section className={styles.detail} aria-label="Selected payroll review">
      <div className={styles.toolbar}><div><h2>{selected.station} · {selected.run.label}</h2><p>{selected.nextStep}</p></div><button className={styles.secondary} disabled={busy} onClick={() => setSelectedId('')}>Close review</button></div>
      <div className={styles.steps}><span>1 · People {selected.changed ? 'revision needed' : 'submitted'}</span><span>2 · Loss {selected.clearance ? 'cleared' : !selected.clearanceRequired ? 'gate disabled in Master' : 'review needed'}</span><span>3 · Finance {selected.status}</span></div>
      {detailLoading && <p role="status">Loading payroll detail…</p>}
      {detailError && <div role="alert">{detailError} <button disabled={busy || detailLoading} onClick={() => loadDetail(selected.id)}>Retry payroll detail</button></div>}
      {detail && <details><summary>{detail.peopleCount} people · salary, holds and payment breakdown</summary><div className={styles.tableWrap}><table><thead><tr><th>Person</th><th>Net</th><th>Hold / loss</th><th>Paid</th><th>Pay now</th><th>Bank / status</th></tr></thead><tbody>{detail.people.map(p => <tr key={p.worker}><td>{p.name}</td><td>{money(p.net)}</td><td>{money(p.items.filter(x => x.code === 'SALARY_HOLD').reduce((a, x) => a + Number(x.amount), 0))}<small>Loss {money(p.items.filter(x => x.code === 'OPS_LOSS_RECOVERY').reduce((a, x) => a + Number(x.amount), 0))}</small></td><td>{money(p.paid)}</td><td>{money(p.payable)}</td><td>{p.bankLast4 ? '•••• ' + p.bankLast4 : 'Missing'}<small>{p.exclusion ?? 'Ready'}</small></td></tr>)}</tbody></table></div></details>}
      <PaymentReleaseReviewPanel key={selected.id} initialStation={selected.station_id} initialMonth={selected.run.period_start.slice(0, 7)} initialScope={`people:${selected.run_id}`} embedded onChange={() => load().catch(e => setError(e.message))} />
      {selected.review_note && <p>Finance note: {selected.review_note}</p>}
      {selected.status === 'submitted' && <div className={styles.decision}><label>Finance review note<textarea value={reason} maxLength={2000} onChange={e => setReason(e.target.value)} disabled={busy || !canEdit} placeholder="Record the payroll checks completed or the correction needed." /></label><div><button disabled={busy || !detail || detail.changed || detail.hash !== selected.hash || !selected.canApprove || reason.trim().length < 10} onClick={() => act('approve')}>Approve payroll</button><button className={styles.secondary} disabled={busy || !canEdit || reason.trim().length < 10} onClick={() => act('return')}>Return to People</button></div>{!selected.canApprove && <small>{selected.nextStep}. Finance approval must be made by someone other than the submitter.</small>}</div>}
      {detail?.batches.length ? <details><summary>Existing location bank files</summary><p>Re-download only while every instruction is still processing.</p>{detail.batches.map(b => <div className={styles.toolbar} key={b.id}><span>{b.value_date} · {time(b.created_at)}</span><button disabled={busy || !canEdit} onClick={() => act('bank_file', b)}>Download existing file</button></div>)}</details> : null}
      {detail?.events.length ? <details><summary>Review history</summary>{detail.events.map((e, i) => <p key={i}>{e.action} · {time(e.created_at)} · {e.reason}</p>)}</details> : null}
    </section>}
    {!!batches.length && <details><summary>Combined download history</summary>{batches.map(b => <div className={styles.toolbar} key={b.id}><span><strong>{b.value_date} · {b.request_ids?.length} locations · {money((b.amount_paise ?? 0) / 100)}</strong><small>{b.line_count} payments · {time(b.created_at)}</small></span><button disabled={busy || !canEdit} onClick={() => act('bank_file_combined', b)}>Download same file</button></div>)}</details>}
  </div>;
}
