"use client";

import { Check, ChevronDown, Clock3, FileText, IndianRupee, Plus, ReceiptText, RotateCcw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { AppAccount } from "./connect-profile-app";

type Category = { id: string; code: string; name: string; description?: string | null; receipt_required: boolean; receipt_threshold: number; per_item_limit?: number | null; per_day_limit?: number | null };
type ExpenseItem = { id: string; categoryId: string; expenseDate: string; merchant: string; description: string; amount: string; receipt?: File | null };
type Claim = {
  id: string; claim_no: string; purpose: string; trip_from?: string | null; trip_to?: string | null; total_claimed: number; total_approved?: number | null; status: string; return_reason?: string | null; rejection_reason?: string | null;
  items: Array<{ id: string; expense_date: string; merchant?: string | null; description: string; amount: number; approved_amount?: number | null; hr_expense_categories?: { id: string; name: string; code: string } | Array<{ id: string; name: string; code: string }> | null }>;
  steps: Array<{ id: string; step_order: number; step_name: string; status: string; decision_note?: string | null; decided_at?: string | null }>;
  events: Array<{ id: string; event_type: string; actor_name?: string | null; actor_role?: string | null; comments?: string | null; created_at: string; metadata?: Record<string, unknown> }>;
  attachments: Array<{ id: string; item_id?: string | null; file_name: string; content_type?: string | null; url?: string | null }>;
  payment?: { request_no: string; status: string; approval_status?: string | null; utr_cin?: string | null; bank_status?: string | null; bank_processing_remarks?: string | null; processed_at?: string | null } | null;
};
type Approval = { id: string; step_order: number; step_name: string; claim: { id: string; claim_no: string; purpose: string; total_claimed: number; trip_from?: string | null; trip_to?: string | null; requesterName: string; requesterCode: string; hr_expense_items?: Claim["items"]; attachments?: Claim["attachments"] } };
type Payload = { categories: Category[]; payout: { ready: boolean; message?: string | null }; claims: Claim[]; approvals: Approval[] };

function uid() { return typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`; }
function newItem(): ExpenseItem { return { id: uid(), categoryId: "", expenseDate: new Date().toISOString().slice(0, 10), merchant: "", description: "", amount: "", receipt: null }; }
function money(value: number | string | null | undefined) { return `₹${Number(value ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`; }
function dateTime(value: string) { return new Date(value).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }); }
function first<T>(value: T | T[] | null | undefined) { return Array.isArray(value) ? value[0] : value; }
function statusLabel(status: string) { return status.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }

export function ConnectReimbursements({ account }: { account: AppAccount }) {
  const [data, setData] = useState<Payload | null>(null);
  const [tab, setTab] = useState<"new" | "claims" | "approvals">("new");
  const [purpose, setPurpose] = useState("");
  const [tripFrom, setTripFrom] = useState("");
  const [tripTo, setTripTo] = useState("");
  const [items, setItems] = useState<ExpenseItem[]>([newItem()]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editingClaimId, setEditingClaimId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const query = new URLSearchParams({ accountId: account.id, profileType: account.profileType });
      const response = await fetch(`/api/connect/reimbursements?${query}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to load reimbursements.");
      setData(payload);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to load reimbursements."); }
    finally { setLoading(false); }
  }, [account.id, account.profileType]);

  useEffect(() => { void load(); }, [load]);
  const total = useMemo(() => items.reduce((sum, item) => sum + (Number(item.amount) || 0), 0), [items]);

  function changeItem(id: string, changes: Partial<ExpenseItem>) { setItems((current) => current.map((item) => item.id === id ? { ...item, ...changes } : item)); }

  async function submit(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError(""); setNotice("");
    try {
      const form = new FormData();
      form.set("accountId", account.id); form.set("profileType", account.profileType); form.set("purpose", purpose); form.set("tripFrom", tripFrom); form.set("tripTo", tripTo);
      if (editingClaimId) form.set("claimId", editingClaimId);
      form.set("items", JSON.stringify(items.map(({ receipt: _receipt, ...item }) => ({ ...item, amount: Number(item.amount) }))));
      for (const item of items) if (item.receipt) form.set(`receipt:${item.id}`, item.receipt);
      const response = await fetch("/api/connect/reimbursements", { method: "POST", body: form });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to submit reimbursement.");
      setNotice(payload.notice); setPurpose(""); setTripFrom(""); setTripTo(""); setItems([newItem()]); setEditingClaimId(null); setTab("claims"); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to submit reimbursement."); }
    finally { setSaving(false); }
  }

  function correctReturnedClaim(claim: Claim) {
    setEditingClaimId(claim.id);
    setPurpose(claim.purpose);
    setTripFrom(claim.trip_from ?? "");
    setTripTo(claim.trip_to ?? "");
    setItems(claim.items.map((item) => ({ id: uid(), categoryId: first(item.hr_expense_categories)?.id ?? "", expenseDate: item.expense_date, merchant: item.merchant ?? "", description: item.description, amount: String(item.amount), receipt: null })));
    setExpanded(null);
    setTab("new");
    setNotice("Correct the returned report, attach the receipts again, and resubmit it through the current approval policy.");
  }

  async function decide(claimId: string, action: "approved" | "returned" | "rejected") {
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/connect/reimbursements", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountId: account.id, profileType: account.profileType, claimId, action, note: notes[claimId] ?? "" }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to update reimbursement.");
      setNotice(payload.notice); setNotes((current) => ({ ...current, [claimId]: "" })); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to update reimbursement."); }
    finally { setSaving(false); }
  }

  return <section className="dx-expenses">
    <header className="dx-page-intro"><small>Payments</small><h1>Reimbursements</h1><p>Submit one report with all expenses, then track approvals and payment in one place.</p></header>
    {error ? <div className="dx-alert error">{error}</div> : null}{notice ? <div className="dx-alert success">{notice}</div> : null}
    {data && !data.payout.ready ? <div className="dx-alert error">{data.payout.message}</div> : null}
    <nav className="dx-expense-tabs">
      <button className={tab === "new" ? "active" : ""} onClick={() => setTab("new")}>New claim</button>
      <button className={tab === "claims" ? "active" : ""} onClick={() => setTab("claims")}>My claims <b>{data?.claims.length ?? 0}</b></button>
      <button className={tab === "approvals" ? "active" : ""} onClick={() => setTab("approvals")}>Approvals <b>{data?.approvals.length ?? 0}</b></button>
    </nav>
    {loading ? <div className="dx-loader"><span /><small>Loading reimbursements…</small></div> : null}
    {!loading && tab === "new" ? <form className="dx-expense-form" onSubmit={submit}>
      {editingClaimId ? <div className="dx-alert warning">You are correcting a returned reimbursement. Its previous decisions remain in the audit timeline.</div> : null}
      <section className="dx-expense-summary"><div><ReceiptText /><span><small>Report total</small><strong>{money(total)}</strong></span></div><div><FileText /><span><small>Expense lines</small><strong>{items.length}</strong></span></div></section>
      <section className="dx-expense-card"><h2>Business purpose</h2><label>Purpose<textarea maxLength={500} onChange={(event) => setPurpose(event.target.value)} placeholder="Example: Seven-day station visit across Kozhikode cluster" required rows={3} value={purpose} /></label><div className="dx-expense-dates"><label>Assignment from<input onChange={(event) => setTripFrom(event.target.value)} type="date" value={tripFrom} /></label><label>Assignment to<input min={tripFrom || undefined} onChange={(event) => setTripTo(event.target.value)} type="date" value={tripTo} /></label></div></section>
      <section className="dx-expense-card"><header><div><h2>Expense lines</h2><p>Add every bill to the same report.</p></div><button className="dx-small-action" onClick={() => setItems((current) => [...current, newItem()])} type="button"><Plus /> Add line</button></header>
        <div className="dx-expense-lines">{items.map((item, index) => { const category = data?.categories.find((entry) => entry.id === item.categoryId); const receiptRequired = Boolean(category?.receipt_required && Number(item.amount || 0) >= Number(category.receipt_threshold ?? 0)); return <article key={item.id}>
          <header><strong>#{index + 1}</strong><span>{category?.name ?? "Select category"}</span><em>{money(item.amount)}</em>{items.length > 1 ? <button aria-label="Remove expense line" onClick={() => setItems((current) => current.filter((entry) => entry.id !== item.id))} type="button"><Trash2 /></button> : null}</header>
          <div className="dx-expense-line-grid"><label>Category<select onChange={(event) => changeItem(item.id, { categoryId: event.target.value })} required value={item.categoryId}><option value="">Select</option>{data?.categories.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label><label>Date<input onChange={(event) => changeItem(item.id, { expenseDate: event.target.value })} required type="date" value={item.expenseDate} /></label><label>Amount<input min="0.01" onChange={(event) => changeItem(item.id, { amount: event.target.value })} required step="0.01" type="number" value={item.amount} /></label><label>Merchant<input maxLength={160} onChange={(event) => changeItem(item.id, { merchant: event.target.value })} placeholder="Vendor / hotel" value={item.merchant} /></label><label className="wide">Description<input maxLength={500} onChange={(event) => changeItem(item.id, { description: event.target.value })} placeholder="What was this expense for?" required value={item.description} /></label><label className="wide">Receipt {receiptRequired ? <b>Required</b> : <small>Optional</small>}<input accept="application/pdf,image/jpeg,image/png,image/webp" onChange={(event) => changeItem(item.id, { receipt: event.target.files?.[0] ?? null })} required={receiptRequired} type="file" /></label></div>
        </article>; })}</div>
      </section>
      <button className="dx-save" disabled={saving || total <= 0 || !data?.payout.ready} type="submit">{saving ? "Submitting…" : `${editingClaimId ? "Resubmit" : "Submit"} ${money(total)} claim`}</button>
    </form> : null}
    {!loading && tab === "claims" ? <div className="dx-expense-list">{data?.claims.length ? data.claims.map((claim) => <article className="dx-expense-claim" key={claim.id}>
      <button className="dx-expense-claim-head" onClick={() => setExpanded((current) => current === claim.id ? null : claim.id)}><span><small>{claim.claim_no}</small><strong>{claim.purpose}</strong><em>{statusLabel(claim.status)}</em></span><b>{money(claim.total_approved ?? claim.total_claimed)}</b><ChevronDown className={expanded === claim.id ? "open" : ""} /></button>
      {expanded === claim.id ? <div className="dx-expense-claim-body"><section><h3>Items</h3>{claim.items.map((item) => <div className="dx-expense-row" key={item.id}><span><strong>{first(item.hr_expense_categories)?.name ?? "Expense"}</strong><small>{item.expense_date} · {item.merchant || item.description}</small>{claim.attachments.filter((attachment) => attachment.item_id === item.id && attachment.url).map((attachment) => <a href={attachment.url ?? "#"} key={attachment.id} rel="noreferrer" target="_blank"><FileText /> {attachment.file_name}</a>)}</span><b>{money(item.approved_amount ?? item.amount)}</b></div>)}</section>
        <section><h3>Tracking</h3><div className="dx-expense-timeline">{claim.events.map((event) => <div key={event.id}><i>{event.event_type.includes("reject") ? <X /> : event.event_type.includes("return") ? <RotateCcw /> : event.event_type.includes("payment") ? <IndianRupee /> : <Check />}</i><span><strong>{statusLabel(event.event_type)}</strong><small>{event.actor_name || "System"}{event.actor_role ? ` · ${event.actor_role}` : ""} · {dateTime(event.created_at)}</small>{event.comments ? <p>{event.comments}</p> : null}</span></div>)}</div></section>
        {claim.payment ? <section className="dx-payment-track"><h3>Payment</h3><div><span><small>Request</small><strong>{claim.payment.request_no}</strong></span><span><small>Status</small><strong>{statusLabel(claim.payment.status)}</strong></span><span><small>UTR / CIN</small><strong>{claim.payment.utr_cin || "Pending"}</strong></span><span><small>Bank status</small><strong>{claim.payment.bank_status || "Pending"}</strong></span></div>{claim.payment.bank_processing_remarks ? <p>{claim.payment.bank_processing_remarks}</p> : null}</section> : null}
        {claim.status === "returned" ? <button className="dx-save" onClick={() => correctReturnedClaim(claim)} type="button"><RotateCcw /> Correct and resubmit</button> : null}
      </div> : null}
    </article>) : <div className="dx-empty"><ReceiptText /><strong>No reimbursement claims yet</strong><small>Your submitted reports will appear here.</small></div>}</div> : null}
    {!loading && tab === "approvals" ? <div className="dx-expense-list">{data?.approvals.length ? data.approvals.map((approval) => <article className="dx-expense-approval" key={approval.id}><header><span><small>{approval.claim.claim_no} · {approval.step_name}</small><strong>{approval.claim.requesterName}</strong><em>{approval.claim.purpose}</em></span><b>{money(approval.claim.total_claimed)}</b></header><div>{approval.claim.hr_expense_items?.map((item) => <span key={item.id}>{first(item.hr_expense_categories)?.name ?? "Expense"} · {item.expense_date}{approval.claim.attachments?.filter((attachment) => attachment.item_id === item.id && attachment.url).map((attachment) => <a href={attachment.url ?? "#"} key={attachment.id} rel="noreferrer" target="_blank"><FileText />{attachment.file_name}</a>)}<b>{money(item.amount)}</b></span>)}</div><label>Decision note<textarea onChange={(event) => setNotes((current) => ({ ...current, [approval.claim.id]: event.target.value }))} placeholder="Required when returning or rejecting" rows={2} value={notes[approval.claim.id] ?? ""} /></label><footer><button disabled={saving} onClick={() => void decide(approval.claim.id, "returned")}><RotateCcw />Return</button><button className="danger" disabled={saving} onClick={() => void decide(approval.claim.id, "rejected")}><X />Reject</button><button className="primary" disabled={saving} onClick={() => void decide(approval.claim.id, "approved")}><Check />Approve</button></footer></article>) : <div className="dx-empty"><Clock3 /><strong>No approvals waiting</strong><small>Assigned reimbursement approvals will appear here.</small></div>}</div> : null}
  </section>;
}
