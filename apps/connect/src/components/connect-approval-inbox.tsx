"use client";

import { Camera, Check, ClipboardCheck, Clock3, FileText, LocateFixed, MapPin, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { AppAccount } from "./connect-profile-app";

type ExpenseItem = {
  id: string;
  expense_date: string;
  amount: number;
  hr_expense_categories?: { name: string } | Array<{ name: string }> | null;
};

type Attachment = { id: string; item_id?: string | null; file_name: string; url?: string | null };

type ReimbursementApproval = {
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

type LeaveApproval = {
  id: string;
  requestId: string;
  stepName: string;
  stepOrder: number;
  leaveType: string;
  startDate: string;
  endDate: string;
  days: number;
  reason: string;
  requesterName: string;
  requesterCode: string;
  profileType: "employee" | "contractor";
};

type LocationSupportPackage = {
  id: string;
  punchDate: string;
  status: string;
  remarks: string | null;
  lat: number;
  lng: number;
  accuracyM: number | null;
  receivedAt: string | null;
  selfieUrl: string | null;
  workerName: string;
  workerCode: string | null;
  profileType: "employee" | "contractor";
};

type ApprovalSection = "time-off" | "location-integrity" | "reimbursements";

function first<T>(value: T | T[] | null | undefined) { return Array.isArray(value) ? value[0] : value; }
function money(value: number | null | undefined) { return `₹${Number(value ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`; }
function displayDate(value: string) { return value.split("-").reverse().join("/"); }
function dateTime(value: string | null) {
  return value ? new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }).format(new Date(value)) : "—";
}

export function ConnectApprovalInbox({ account }: { account: AppAccount }) {
  const [section, setSection] = useState<ApprovalSection>("time-off");
  const [reimbursements, setReimbursements] = useState<ReimbursementApproval[]>([]);
  const [leaveApprovals, setLeaveApprovals] = useState<LeaveApproval[]>([]);
  const [supportPackages, setSupportPackages] = useState<LocationSupportPackage[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const query = new URLSearchParams({ accountId: account.id, profileType: account.profileType });
      const [reimbursementResponse, leaveResponse] = await Promise.all([
        fetch(`/api/connect/reimbursements?${query}`, { cache: "no-store" }),
        fetch(`/api/connect/approvals?${query}`, { cache: "no-store" })
      ]);
      const reimbursementPayload = await reimbursementResponse.json();
      const leavePayload = await leaveResponse.json();
      if (!reimbursementResponse.ok) throw new Error(reimbursementPayload.error || "Unable to load approvals.");
      if (!leaveResponse.ok) throw new Error(leavePayload.error || "Unable to load time-off approvals.");
      setReimbursements(reimbursementPayload.approvals ?? []);
      setLeaveApprovals(leavePayload.leaveApprovals ?? []);
      setSupportPackages(leavePayload.locationSupportPackages ?? []);
      setSection((current) => {
        if (current === "time-off" && !(leavePayload.leaveApprovals ?? []).length) {
          if ((leavePayload.locationSupportPackages ?? []).length) return "location-integrity";
          if ((reimbursementPayload.approvals ?? []).length) return "reimbursements";
        }
        return current;
      });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to load approvals."); }
    finally { setLoading(false); }
  }, [account.id, account.profileType]);

  useEffect(() => { void load(); }, [load]);

  async function decideReimbursement(claimId: string, action: "approved" | "returned" | "rejected") {
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

  async function decideLeave(requestId: string, decision: "approved" | "rejected") {
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/connect/approvals", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account.id, profileType: account.profileType, requestId, decision, note: notes[requestId] ?? "" })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to update time-off approval.");
      setNotice(payload.notice); setNotes((current) => ({ ...current, [requestId]: "" })); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to update time-off approval."); }
    finally { setSaving(false); }
  }

  async function decideSupportPackage(reviewId: string, decision: "approved" | "returned" | "rejected") {
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/connect/approvals", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account.id, profileType: account.profileType, reviewId, decision, note: notes[reviewId] ?? "" })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to update support package.");
      setNotice(payload.notice); setNotes((current) => ({ ...current, [reviewId]: "" })); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to update support package."); }
    finally { setSaving(false); }
  }

  return <section className="dx-expenses dx-approval-inbox">
    <header className="dx-page-intro"><small>Manager workspace</small><h1>Approval inbox</h1><p>Review only the workflow steps assigned to you.</p></header>
    {error ? <div className="dx-alert error">{error}</div> : null}
    {notice ? <div className="dx-alert success">{notice}</div> : null}
    <nav className="dx-expense-tabs" aria-label="Approval sections">
      <button className={section === "time-off" ? "active" : ""} onClick={() => setSection("time-off")}>Time off <b>{leaveApprovals.length}</b></button>
      <button className={section === "location-integrity" ? "active" : ""} onClick={() => setSection("location-integrity")}>Location integrity <b>{supportPackages.length}</b></button>
      <button className={section === "reimbursements" ? "active" : ""} onClick={() => setSection("reimbursements")}>Reimbursements <b>{reimbursements.length}</b></button>
    </nav>
    {loading ? <div className="dx-loader"><span /><small>Loading approvals…</small></div> : null}
    {!loading && section === "time-off" ? <div className="dx-expense-list">
      {leaveApprovals.length ? leaveApprovals.map((approval) => <article className="dx-expense-approval" key={approval.id}>
        <header><span><small>{approval.leaveType} · {approval.stepName}</small><strong>{approval.requesterName}</strong><em>{approval.requesterCode || "—"} · {approval.profileType === "contractor" ? "Independent contractor" : "Employee"}</em></span><b>{approval.days} day{approval.days === 1 ? "" : "s"}</b></header>
        <div><span>{displayDate(approval.startDate)}{approval.endDate !== approval.startDate ? ` – ${displayDate(approval.endDate)}` : ""}</span><span>{approval.reason}</span></div>
        <label>Decision note<textarea onChange={(event) => setNotes((current) => ({ ...current, [approval.requestId]: event.target.value }))} placeholder="Optional reviewer note" rows={2} value={notes[approval.requestId] ?? ""} /></label>
        <footer><button className="danger" disabled={saving} onClick={() => void decideLeave(approval.requestId, "rejected")}><X />Reject</button><button className="primary" disabled={saving} onClick={() => void decideLeave(approval.requestId, "approved")}><Check />Approve</button></footer>
      </article>) : <div className="dx-empty"><Clock3 /><strong>No time-off approvals waiting</strong><small>Assigned time-off approvals will appear here.</small></div>}
    </div> : null}
    {!loading && section === "location-integrity" ? <div className="dx-expense-list">
      {supportPackages.length ? supportPackages.map((item) => <article className="dx-expense-approval" key={item.id}>
        <header><span><small>Support package · {displayDate(item.punchDate)}</small><strong>{item.workerName}</strong><em>{item.workerCode || "—"} · {item.profileType === "contractor" ? "Independent contractor" : "Employee"}</em></span><b>{item.status.replaceAll("_", " ")}</b></header>
        <div className="dx-support-evidence">
          <figure className="dx-support-selfie">
            {item.selfieUrl ? (
              <>
                <img alt={`Support selfie for ${item.workerName}`} src={item.selfieUrl} />
                <a href={item.selfieUrl} rel="noreferrer" target="_blank"><Camera />Open full photo</a>
              </>
            ) : (
              <div className="dx-support-selfie-missing"><Camera /><span>Selfie unavailable</span></div>
            )}
          </figure>
          <div className="dx-support-location">
            <span><LocateFixed /> {item.lat.toFixed(5)}, {item.lng.toFixed(5)}{item.accuracyM == null ? "" : ` · ±${Math.round(item.accuracyM)}m`}</span>
            <span>{item.remarks || "Selfie and GPS submitted outside station"}</span>
            <span>{item.receivedAt ? `Received ${dateTime(item.receivedAt)}` : "Awaiting server receipt"}</span>
            <a href={`https://www.google.com/maps?q=${item.lat},${item.lng}`} rel="noreferrer" target="_blank"><MapPin />Open map</a>
          </div>
        </div>
        <label>Review note<textarea onChange={(event) => setNotes((current) => ({ ...current, [item.id]: event.target.value }))} placeholder="Optional note" rows={2} value={notes[item.id] ?? ""} /></label>
        <footer>
          <button disabled={saving} onClick={() => void decideSupportPackage(item.id, "returned")}><RotateCcw />Return</button>
          <button className="danger" disabled={saving} onClick={() => void decideSupportPackage(item.id, "rejected")}><X />Reject</button>
          <button className="primary" disabled={saving} onClick={() => void decideSupportPackage(item.id, "approved")}><Check />Approve</button>
        </footer>
      </article>) : <div className="dx-empty"><LocateFixed /><strong>No support packages waiting</strong><small>Assigned location verification packages will appear here.</small></div>}
    </div> : null}
    {!loading && section === "reimbursements" ? <div className="dx-expense-list">{reimbursements.length ? reimbursements.map((approval) => <article className="dx-expense-approval" key={approval.id}>
      <header><span><small>{approval.claim.claim_no} · {approval.step_name}</small><strong>{approval.claim.requesterName}</strong><em>{approval.claim.purpose}</em></span><b>{money(approval.claim.total_claimed)}</b></header>
      <div>{approval.claim.hr_expense_items?.map((item) => <span key={item.id}>{first(item.hr_expense_categories)?.name ?? "Expense"} · {item.expense_date}{approval.claim.attachments?.filter((attachment) => attachment.item_id === item.id && attachment.url).map((attachment) => <a href={attachment.url ?? "#"} key={attachment.id} rel="noreferrer" target="_blank"><FileText />{attachment.file_name}</a>)}<b>{money(item.amount)}</b></span>)}</div>
      <label>Decision note<textarea onChange={(event) => setNotes((current) => ({ ...current, [approval.claim.id]: event.target.value }))} placeholder="Required when returning or rejecting" rows={2} value={notes[approval.claim.id] ?? ""} /></label>
      <footer><button disabled={saving} onClick={() => void decideReimbursement(approval.claim.id, "returned")}><RotateCcw />Return</button><button className="danger" disabled={saving} onClick={() => void decideReimbursement(approval.claim.id, "rejected")}><X />Reject</button><button className="primary" disabled={saving} onClick={() => void decideReimbursement(approval.claim.id, "approved")}><Check />Approve</button></footer>
    </article>) : <div className="dx-empty"><Clock3 /><strong>No approvals waiting</strong><small>Assigned reimbursement approvals will appear here.</small></div>}</div> : null}
    <div className="dx-approval-note"><ClipboardCheck /><span><strong>Master-driven routing</strong><small>Each approval follows the active policy and reporting hierarchy before it reaches the next step or Payments.</small></span></div>
  </section>;
}
