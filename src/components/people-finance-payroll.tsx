"use client";
import { useEffect, useState } from "react";
import { PaymentReleaseReviewPanel } from "./payment-release-review";
import styles from "./payment-release.module.css";
type Submission = { id: string; station_id: string; station: string; run_id: string; status: string; version: number; submitted_at: string; review_note: string; run: { label: string; period_start: string } };
type Batch = { id: string; bank_id: string; value_date: string; created_at: string };
type Detail = { changed: boolean; people: { name: string; status: string; net: number; paid: number; remaining: number; processing: number; bankLast4: string; items: { code: string; amount: number; type: string }[] }[]; batches: Batch[]; events: { action: string; reason: string; actor_id: string; created_at: string }[] };
const money = (v: number) => '₹'+Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 });
export function PeopleFinancePayroll() {
  const [rows, setRows] = useState<Submission[]>([]);
  const [banks, setBanks] = useState<{ id: string; display_name: string }[]>([]);
  const [selected, setSelected] = useState<Submission | null>(null);
  const [reason, setReason] = useState("");
  const [bank, setBank] = useState("");
  const [date, setDate] = useState(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()));
  const [operation, setOperation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<Detail | null>(null);
  async function loadDetail(id: string) {
    const response = await fetch('/api/payments/people-payroll?request='+id); const data = await response.json();
    if (!response.ok) throw Error(data.error); setDetail(data);
  }
  useEffect(() => { setDetail(null); if (selected) loadDetail(selected.id).catch(e => setError(e.message)); }, [selected?.id]);
  async function load() {
    const response = await fetch("/api/payments/people-payroll"); const data = await response.json();
    if (!response.ok) throw Error(data.error);
    setRows(data.requests); setBanks(data.banks);
    setSelected(current => current ? data.requests.find((r: Submission) => r.id === current.id) ?? null : null);
  }
  useEffect(() => { load().catch(e => setError(e.message)); }, []);
  useEffect(() => { setOperation(crypto.randomUUID()); }, [selected?.id, bank, date]);
  async function act(action: string, batch?: Batch) {
    if (!selected) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/payments/people-payroll", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, requestId: selected.id, version: selected.version, reason, bankId: batch?.bank_id ?? bank, valueDate: batch?.value_date ?? date, operationId: batch?.id ?? operation }) });
      if (!response.ok) throw Error((await response.json()).error);
      if (action === "bank_file") {
        const url = URL.createObjectURL(await response.blob()); const link = document.createElement("a"); link.href = url; link.download = `people-payroll-${selected.station}-${date}.xlsx`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      await load(); await loadDetail(selected.id);
    } catch (e) { setError(e instanceof Error ? e.message : "Action failed."); }
    finally { setBusy(false); }
  }
  return <div className={styles.workspace}><p>Review payroll submitted by People, confirm station loss clearance, then approve and generate the bank file.</p>
    {error && <p role="alert">{error}</p>}
    <button disabled={busy} onClick={() => load().catch(e => setError(e.message))}>Refresh submissions</button>
    <table><thead><tr><th>Station</th><th>Salary month</th><th>Submitted</th><th>Finance status</th><th>Action</th></tr></thead><tbody>{rows.map(r => <tr key={r.id}><td>{r.station}</td><td>{r.run?.label || r.run?.period_start?.slice(0, 7)}</td><td>{new Date(r.submitted_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</td><td>{r.status}</td><td><button disabled={busy} onClick={() => { setSelected(r); setReason(""); setError(""); }}>Review payroll</button></td></tr>)}</tbody></table>
    {!rows.length && <p>No payroll has been sent from People yet.</p>}
    {selected && <section style={{ marginTop: 24 }}>
      <h2>{selected.station} · {selected.run?.label}</h2>
      {detail && <div style={{ overflowX: 'auto' }}>
        {detail.changed && <p role="alert">Payroll or bank details changed. People must resubmit the revised payroll.</p>}
        <table><thead><tr><th>Person</th><th>Net salary</th><th>Salary hold</th><th>Loss deduction</th><th>Paid</th><th>Unpaid balance</th><th>Bank ending</th><th>Calculation</th></tr></thead><tbody>{detail.people.map((p,i) => <tr key={i}><td>{p.name}</td><td>{money(p.net)}</td><td>{money(p.items.filter(x=>x.code==='SALARY_HOLD').reduce((a,x)=>a+Number(x.amount),0))}</td><td>{money(p.items.filter(x=>x.code==='OPS_LOSS_RECOVERY').reduce((a,x)=>a+Number(x.amount),0))}</td><td>{money(p.paid)}</td><td>{money(p.remaining)}{p.processing > 0 && " · Processing"}</td><td>{p.bankLast4 ? '•••• '+p.bankLast4 : 'Missing'}</td><td>{p.status}</td></tr>)}</tbody></table>
      </div>}
      <PaymentReleaseReviewPanel key={selected.id} initialStation={selected.station_id} initialMonth={selected.run.period_start.slice(0, 7)} initialScope={`people:${selected.run_id}`} />
      <p>{selected.review_note}</p>
      {selected.status === "submitted" && detail && !detail.changed && <div style={{ display: "grid", gap: 12, marginTop: 20 }}><label>Finance review note<textarea value={reason} onChange={e => setReason(e.target.value)} disabled={busy} /></label><div><button disabled={busy || reason.trim().length < 10} onClick={() => act("approve")}>Approve payroll for payment</button> <button disabled={busy || reason.trim().length < 10} onClick={() => act("return")}>Return to People</button></div></div>}
      {selected.status === "approved" && detail && !detail.changed && <div style={{ display: "flex", gap: 14, marginTop: 20, alignItems: "end" }}><label>Debit bank<select value={bank} onChange={e => setBank(e.target.value)} disabled={busy}><option value="">Choose bank</option>{banks.map(b => <option key={b.id} value={b.id}>{b.display_name}</option>)}</select></label><label>Value date<input type="date" value={date} onChange={e => setDate(e.target.value)} disabled={busy} /></label><button disabled={busy || !bank || !date} onClick={() => act("bank_file")}>{busy ? "Creating file…" : "Generate bank file"}</button></div>}
      {detail?.batches.length ? <details><summary>Previously generated files</summary><p>Downloads recheck loss clearance and payment status. Settled or cancelled instructions cannot be downloaded again.</p>{detail.batches.map(b => <p key={b.id}>{b.value_date} · {new Date(b.created_at).toLocaleString("en-IN")} <button disabled={busy} onClick={() => act("bank_file", b)}>Download existing file</button></p>)}</details> : null}
      {detail?.events.length ? <details><summary>Review history</summary>{detail.events.map((e,i)=><p key={i}>{e.action} · {new Date(e.created_at).toLocaleString("en-IN")} · {e.reason}</p>)}</details> : null}
    </section>}
  </div>;
}
