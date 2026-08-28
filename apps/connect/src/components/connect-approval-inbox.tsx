"use client";

import { Camera, Check, ClipboardCheck, Clock3, FileText, LocateFixed, MapPin, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
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
function statusLabel(status: string) {
  return status.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
function profileLabel(profileType: "employee" | "contractor") {
  return profileType === "contractor" ? "Contractor" : "Employee";
}

function ApprovalHead({
  eyebrow,
  name,
  meta,
  badge
}: {
  eyebrow: string;
  name: string;
  meta: string;
  badge: ReactNode;
}) {
  return (
    <div className="dx-approval-card-head">
      <div>
        <p className="dx-approval-eyebrow">{eyebrow}</p>
        <h2>{name}</h2>
        <p className="dx-approval-sub">{meta}</p>
      </div>
      {badge}
    </div>
  );
}

function ApprovalNote({
  id,
  notes,
  onChange,
  placeholder
}: {
  id: string;
  notes: Record<string, string>;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <textarea
      className="dx-approval-note-input"
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      rows={2}
      value={notes[id] ?? ""}
    />
  );
}

function ApprovalToolbar({
  saving,
  onReturn,
  onReject,
  onApprove,
  showReturn = true
}: {
  saving: boolean;
  onReturn?: () => void;
  onReject: () => void;
  onApprove: () => void;
  showReturn?: boolean;
}) {
  return (
    <div className={`dx-approval-toolbar${showReturn ? "" : " duo"}`}>
      {showReturn && onReturn ? (
        <button className="toolbar-return" disabled={saving} onClick={onReturn} type="button">
          <RotateCcw />Return
        </button>
      ) : null}
      <button className="toolbar-reject" disabled={saving} onClick={onReject} type="button">
        <X />Reject
      </button>
      <button className="toolbar-approve" disabled={saving} onClick={onApprove} type="button">
        <Check />Approve
      </button>
    </div>
  );
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

  function setNote(id: string, value: string) {
    setNotes((current) => ({ ...current, [id]: value }));
  }

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

  return (
    <section className="dx-approval-inbox">
      <header className="dx-page-intro">
        <small>Manager workspace</small>
        <h1>Approval inbox</h1>
        <p>Review workflow steps assigned to you.</p>
      </header>
      {error ? <div className="dx-alert error">{error}</div> : null}
      {notice ? <div className="dx-alert success">{notice}</div> : null}
      <nav aria-label="Approval sections" className="dx-approval-tabs">
        <button className={section === "time-off" ? "active" : ""} onClick={() => setSection("time-off")} type="button">
          Time off<span>{leaveApprovals.length}</span>
        </button>
        <button className={section === "location-integrity" ? "active" : ""} onClick={() => setSection("location-integrity")} type="button">
          Location<span>{supportPackages.length}</span>
        </button>
        <button className={section === "reimbursements" ? "active" : ""} onClick={() => setSection("reimbursements")} type="button">
          Claims<span>{reimbursements.length}</span>
        </button>
      </nav>
      {loading ? <div className="dx-loader"><span /><small>Loading approvals…</small></div> : null}

      {!loading && section === "time-off" ? (
        <div className="dx-approval-list">
          {leaveApprovals.length ? leaveApprovals.map((approval) => (
            <article className="dx-approval-card" key={approval.id}>
              <ApprovalHead
                badge={<span className="dx-approval-badge">{approval.days} day{approval.days === 1 ? "" : "s"}</span>}
                eyebrow={`${approval.leaveType} · ${approval.stepName}`}
                meta={`${approval.requesterCode || "—"} · ${profileLabel(approval.profileType)}`}
                name={approval.requesterName}
              />
              <dl className="dx-approval-facts">
                <div><dt>Dates</dt><dd>{displayDate(approval.startDate)}{approval.endDate !== approval.startDate ? ` – ${displayDate(approval.endDate)}` : ""}</dd></div>
                <div><dt>Reason</dt><dd>{approval.reason}</dd></div>
              </dl>
              <ApprovalNote id={approval.requestId} notes={notes} onChange={(value) => setNote(approval.requestId, value)} placeholder="Note for worker (optional)" />
              <ApprovalToolbar
                onApprove={() => void decideLeave(approval.requestId, "approved")}
                onReject={() => void decideLeave(approval.requestId, "rejected")}
                saving={saving}
                showReturn={false}
              />
            </article>
          )) : (
            <div className="dx-empty"><Clock3 /><strong>No time-off approvals</strong><small>Assigned leave requests will appear here.</small></div>
          )}
        </div>
      ) : null}

      {!loading && section === "location-integrity" ? (
        <div className="dx-approval-list">
          {supportPackages.length ? supportPackages.map((item) => (
            <article className="dx-approval-card" key={item.id}>
              <ApprovalHead
                badge={<span className={`dx-approval-badge status-${item.status}`}>{statusLabel(item.status)}</span>}
                eyebrow={`Location check · ${displayDate(item.punchDate)}`}
                meta={`${item.workerCode || "—"} · ${profileLabel(item.profileType)}`}
                name={item.workerName}
              />
              <div className="dx-evidence-row">
                {item.selfieUrl ? (
                  <a aria-label="View support selfie" className="dx-evidence-photo" href={item.selfieUrl} rel="noreferrer" target="_blank">
                    <img alt="" src={item.selfieUrl} />
                    <Camera />
                  </a>
                ) : (
                  <div aria-hidden="true" className="dx-evidence-photo missing"><Camera /></div>
                )}
                <div className="dx-evidence-info">
                  <span className="dx-evidence-kicker"><LocateFixed />GPS</span>
                  <strong>{item.lat.toFixed(5)}, {item.lng.toFixed(5)}{item.accuracyM == null ? "" : ` · ±${Math.round(item.accuracyM)}m`}</strong>
                  <p>{item.remarks || "Selfie and GPS submitted outside station"}</p>
                  <div className="dx-evidence-links">
                    <small>{item.receivedAt ? dateTime(item.receivedAt) : "Awaiting receipt"}</small>
                    <a href={`https://www.google.com/maps?q=${item.lat},${item.lng}`} rel="noreferrer" target="_blank"><MapPin />Map</a>
                  </div>
                </div>
              </div>
              <ApprovalNote id={item.id} notes={notes} onChange={(value) => setNote(item.id, value)} placeholder="Note for worker (optional)" />
              <ApprovalToolbar
                onApprove={() => void decideSupportPackage(item.id, "approved")}
                onReject={() => void decideSupportPackage(item.id, "rejected")}
                onReturn={() => void decideSupportPackage(item.id, "returned")}
                saving={saving}
              />
            </article>
          )) : (
            <div className="dx-empty"><LocateFixed /><strong>No location checks</strong><small>Support packages from your team will appear here.</small></div>
          )}
        </div>
      ) : null}

      {!loading && section === "reimbursements" ? (
        <div className="dx-approval-list">
          {reimbursements.length ? reimbursements.map((approval) => (
            <article className="dx-approval-card" key={approval.id}>
              <ApprovalHead
                badge={<span className="dx-approval-badge">{money(approval.claim.total_claimed)}</span>}
                eyebrow={`${approval.claim.claim_no} · ${approval.step_name}`}
                meta={approval.claim.purpose}
                name={approval.claim.requesterName}
              />
              <dl className="dx-approval-facts">
                {approval.claim.hr_expense_items?.map((item) => (
                  <div key={item.id}>
                    <dt>{first(item.hr_expense_categories)?.name ?? "Expense"}</dt>
                    <dd>
                      {item.expense_date} · {money(item.amount)}
                      {approval.claim.attachments?.filter((attachment) => attachment.item_id === item.id && attachment.url).map((attachment) => (
                        <a href={attachment.url ?? "#"} key={attachment.id} rel="noreferrer" target="_blank"><FileText />{attachment.file_name}</a>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
              <ApprovalNote id={approval.claim.id} notes={notes} onChange={(value) => setNote(approval.claim.id, value)} placeholder="Required when returning or rejecting" />
              <ApprovalToolbar
                onApprove={() => void decideReimbursement(approval.claim.id, "approved")}
                onReject={() => void decideReimbursement(approval.claim.id, "rejected")}
                onReturn={() => void decideReimbursement(approval.claim.id, "returned")}
                saving={saving}
              />
            </article>
          )) : (
            <div className="dx-empty"><Clock3 /><strong>No claims waiting</strong><small>Reimbursement approvals will appear here.</small></div>
          )}
        </div>
      ) : null}

      <p className="dx-approval-footnote"><ClipboardCheck /> Routed by active policy and reporting hierarchy.</p>
    </section>
  );
}
