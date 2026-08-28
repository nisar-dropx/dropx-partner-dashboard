"use client";

import { Check, ClipboardCheck, Clock3, FileText, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { AppAccount } from "./connect-profile-app";

type ExpenseItem = {
  id: string;
  expense_date: string;
  amount: number;
  hr_expense_categories?: { name: string } | Array<{ name: string }> | null;
};

type Attachment = { id: string; item_id?: string | null; file_name: string; url?: string | null };

type Approval = {
  id: string;
  step_name: string;
  claim: {
    id: string;
    claim_no: string;
    purpose: string;
    total_claimed: number;
    requesterName: string;
    requesterCode: string;
    hr_expense_items?: ExpenseItem[];
    attachments?: Attachment[];
  };
};

function first<T>(value: T | T[] | null | undefined) { return Array.isArray(value) ? value[0] : value; }
function money(value: number | null | undefined) { return `₹${Number(value ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`; }

export function ConnectApprovalInbox({ account }: { account: AppAccount }) {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const query = new URLSearchParams({ accountId: account.id, profileType: account.profileType });
      const response = await fetch(`/api/connect/reimbursements?${query}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to load approvals.");
      setApprovals(payload.approvals ?? []);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to load approvals."); }
    finally { setLoading(false); }
  }, [account.id, account.profileType]);

  useEffect(() => { void load(); }, [load]);

  async function decide(claimId: string, action: "approved" | "returned" | "rejected") {
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/connect/reimbursements", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account.id, profileType: account.profileType, claimId, action, note: notes[claimId] ?? "" })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to update reimbursement.");
      setNotice(payload.notice); setNotes((current) => ({ ...current, [claimId]: "" })); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to update reimbursement."); }
    finally { setSaving(false); }
  }

  return <section className="dx-expenses dx-approval-inbox">
    <header className="dx-page-intro"><small>Manager workspace</small><h1>Approval inbox</h1><p>Review only the workflow steps assigned to you.</p></header>
    {error ? <div className="dx-alert error">{error}</div> : null}
    {notice ? <div className="dx-alert success">{notice}</div> : null}
    <nav className="dx-expense-tabs" aria-label="Approval sections"><button className="active">Reimbursements <b>{approvals.length}</b></button></nav>
    {loading ? <div className="dx-loader"><span /><small>Loading approvals…</small></div> : null}
    {!loading ? <div className="dx-expense-list">{approvals.length ? approvals.map((approval) => <article className="dx-expense-approval" key={approval.id}>
      <header><span><small>{approval.claim.claim_no} · {approval.step_name}</small><strong>{approval.claim.requesterName}</strong><em>{approval.claim.purpose}</em></span><b>{money(approval.claim.total_claimed)}</b></header>
      <div>{approval.claim.hr_expense_items?.map((item) => <span key={item.id}>{first(item.hr_expense_categories)?.name ?? "Expense"} · {item.expense_date}{approval.claim.attachments?.filter((attachment) => attachment.item_id === item.id && attachment.url).map((attachment) => <a href={attachment.url ?? "#"} key={attachment.id} rel="noreferrer" target="_blank"><FileText />{attachment.file_name}</a>)}<b>{money(item.amount)}</b></span>)}</div>
      <label>Decision note<textarea onChange={(event) => setNotes((current) => ({ ...current, [approval.claim.id]: event.target.value }))} placeholder="Required when returning or rejecting" rows={2} value={notes[approval.claim.id] ?? ""} /></label>
      <footer><button disabled={saving} onClick={() => void decide(approval.claim.id, "returned")}><RotateCcw />Return</button><button className="danger" disabled={saving} onClick={() => void decide(approval.claim.id, "rejected")}><X />Reject</button><button className="primary" disabled={saving} onClick={() => void decide(approval.claim.id, "approved")}><Check />Approve</button></footer>
    </article>) : <div className="dx-empty"><Clock3 /><strong>No approvals waiting</strong><small>Assigned reimbursement approvals will appear here.</small></div>}</div> : null}
    <div className="dx-approval-note"><ClipboardCheck /><span><strong>Master-driven routing</strong><small>Each approval follows the active reimbursement policy and reporting hierarchy before it reaches Payments.</small></span></div>
  </section>;
}
