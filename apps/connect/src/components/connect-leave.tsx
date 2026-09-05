"use client";

import { CalendarDays, Clock3, FileCheck2, Info, Laptop, Paperclip, Pencil, RotateCcw, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { AppAccount } from "./connect-profile-app";
import { ConnectWfh } from "./connect-wfh";

type LeaveSection = "leave" | "wfh";
type LeaveTab = "request" | "history";
type LeaveType = {
  id: string;
  name: string;
  code: string;
  allowance: number | null;
  used: number;
  pending: number;
  available: number | null;
  isPaid: boolean;
  balanceMode: "annual_balance" | "unlimited_unpaid";
};
type LeaveApprovalStep = {
  stepOrder: number;
  stepName: string;
  status: string;
};
type LeaveApprovalRouteStep = {
  stepOrder: number;
  stepName: string;
  approverName: string;
  detail: string;
};
type LeaveRequest = {
  id: string;
  leaveType: string;
  leaveTypeCode?: string;
  fromDate: string;
  toDate: string;
  days: number;
  reason: string;
  status: string;
  reviewerNote?: string | null;
  hasProof?: boolean;
  proofFileName?: string | null;
  proofUrl?: string | null;
  steps?: LeaveApprovalStep[];
};
type LeaveData = {
  year: number;
  types: LeaveType[];
  requests: LeaveRequest[];
  approvalRoute?: {
    ready: boolean;
    direct: boolean;
    policyName: string;
    steps: LeaveApprovalRouteStep[];
    error: string;
  };
  summary: { available: number; pending: number };
};

function stepStatusLabel(status: string) {
  switch (status) {
    case "pending": return "Pending";
    case "approved": return "Approved";
    case "rejected": return "Rejected";
    case "skipped": return "Skipped";
    default: return status;
  }
}

function displayDate(value: string) { return value.split("-").reverse().join("/"); }
function todayInIndia() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()); }
function inclusiveDays(fromDate: string, toDate: string) {
  if (!fromDate || !toDate) return 0;
  const difference = Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`);
  return Number.isFinite(difference) && difference >= 0 ? Math.floor(difference / 86_400_000) + 1 : 0;
}

export function ConnectLeave({
  account,
  initialSection = "leave"
}: {
  account: AppAccount;
  initialSection?: LeaveSection;
}) {
  const wfhEligible = (account.pageAccess ?? []).includes("wfh");
  const leaveEligible = (account.pageAccess ?? []).includes("leave") || account.profileType === "contractor";
  const [section, setSection] = useState<LeaveSection>(
    initialSection === "wfh" && wfhEligible ? "wfh" : leaveEligible ? "leave" : "wfh"
  );
  const [tab, setTab] = useState<LeaveTab>("request");
  const [data, setData] = useState<LeaveData | null>(null);
  const [leaveTypeId, setLeaveTypeId] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [reason, setReason] = useState("");
  const [proof, setProof] = useState<File | null>(null);
  const [existingProofName, setExistingProofName] = useState("");
  const [editingRequestId, setEditingRequestId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const proofInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (initialSection === "wfh" && wfhEligible) setSection("wfh");
    else if (initialSection === "leave" && leaveEligible) setSection("leave");
  }, [initialSection, leaveEligible, wfhEligible]);

  const resetForm = useCallback(() => {
    setEditingRequestId(null);
    setFromDate("");
    setToDate("");
    setReason("");
    setProof(null);
    setExistingProofName("");
    if (proofInput.current) proofInput.current.value = "";
  }, []);

  const loadLeave = useCallback(async (previewDays = 1, options?: { silent?: boolean }) => {
    if (!leaveEligible) {
      setLoading(false);
      return;
    }
    if (!options?.silent) {
      setLoading(true);
      setError("");
    }
    try {
      const query = new URLSearchParams({
        accountId: account.id,
        profileType: account.profileType,
        days: String(Math.max(1, previewDays))
      });
      const response = await fetch(`/api/connect/leave?${query}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to load time off.");
      setData(payload);
      setLeaveTypeId((current) => current && payload.types.some((item: LeaveType) => item.id === current) ? current : payload.types[0]?.id ?? "");
      if (options?.silent) setError("");
    } catch (reasonValue) {
      setError(reasonValue instanceof Error ? reasonValue.message : "Unable to load time off.");
    } finally {
      if (!options?.silent) setLoading(false);
    }
  }, [account.id, account.profileType, leaveEligible]);

  useEffect(() => { void loadLeave(1); }, [loadLeave]);
  const selectedType = data?.types.find((item) => item.id === leaveTypeId) ?? null;
  const leaveMasterReady = Boolean(data?.types.length);
  const minimumDate = todayInIndia();
  const requestedDays = inclusiveDays(fromDate, toDate);
  const isSickLeave = selectedType?.code.toUpperCase() === "SICK";
  const medicalProofRequired = isSickLeave && requestedDays > 1;
  const approvalRoute = data?.approvalRoute;
  const previewDays = Math.max(1, requestedDays || 1);

  useEffect(() => {
    if (!leaveEligible || section !== "leave" || tab !== "request" || !fromDate || !toDate) return;
    const handle = window.setTimeout(() => { void loadLeave(previewDays, { silent: true }); }, 250);
    return () => window.clearTimeout(handle);
  }, [fromDate, leaveEligible, loadLeave, previewDays, section, tab, toDate]);

  function startEdit(request: LeaveRequest) {
    const typeMatch = data?.types.find((type) => type.name === request.leaveType || type.code === request.leaveTypeCode);
    setEditingRequestId(request.id);
    setLeaveTypeId(typeMatch?.id ?? data?.types[0]?.id ?? "");
    setFromDate(request.fromDate);
    setToDate(request.toDate);
    setReason(request.reason);
    setProof(null);
    setExistingProofName(request.proofFileName ?? "");
    if (proofInput.current) proofInput.current.value = "";
    setTab("request");
    setNotice("");
    setError("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!leaveTypeId || !fromDate || !toDate || !reason.trim() || (medicalProofRequired && !proof && !existingProofName)) return;
    setSubmitting(true); setError(""); setNotice("");
    try {
      const body = new FormData();
      body.set("accountId", account.id);
      body.set("profileType", account.profileType);
      if (editingRequestId) body.set("requestId", editingRequestId);
      body.set("leaveTypeId", leaveTypeId);
      body.set("fromDate", fromDate);
      body.set("toDate", toDate);
      body.set("reason", reason);
      if (proof) body.set("proof", proof);
      const response = await fetch("/api/connect/leave", {
        method: editingRequestId ? "PATCH" : "POST",
        body
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to submit time off.");
      setNotice(payload.notice || (editingRequestId ? "Time-off request updated." : "Time-off request submitted."));
      resetForm();
      await loadLeave();
      setTab("history");
    } catch (reasonValue) {
      setError(reasonValue instanceof Error ? reasonValue.message : "Unable to submit time off.");
    } finally {
      setSubmitting(false);
    }
  }

  async function withdraw(requestId: string) {
    if (!window.confirm("Withdraw this pending request?")) return;
    setSubmitting(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/connect/leave", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account.id, profileType: account.profileType, requestId })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to withdraw time off.");
      setNotice(payload.notice || "Time-off request withdrawn.");
      if (editingRequestId === requestId) resetForm();
      await loadLeave();
    } catch (reasonValue) {
      setError(reasonValue instanceof Error ? reasonValue.message : "Unable to withdraw time off.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="dx-leave">
      <header className="dx-page-intro">
        <small>Time off</small>
        <h1>Leave</h1>
        <p>{wfhEligible
          ? "Plan time away or request work from home."
          : "Plan time away and follow every request."}</p>
      </header>

      {wfhEligible && leaveEligible ? (
        <nav className="dx-leave-section-nav" aria-label="Leave options">
          <button className={section === "leave" ? "active" : ""} onClick={() => setSection("leave")} type="button">
            <CalendarDays />Leave
          </button>
          <button className={section === "wfh" ? "active" : ""} onClick={() => setSection("wfh")} type="button">
            <Laptop />Work from home
          </button>
        </nav>
      ) : null}

      {section === "wfh" && wfhEligible ? <ConnectWfh account={account} embedded /> : null}

      {section === "leave" && leaveEligible ? <>
      <div className="dx-leave-summary">
        <div><i><CalendarDays /></i><span><small>Available</small><strong>{loading ? "—" : data?.summary.available ?? 0}</strong></span></div>
        <div><i><Clock3 /></i><span><small>Pending</small><strong>{loading ? "—" : data?.summary.pending ?? 0}</strong></span></div>
      </div>

      <div className="dx-leave-card">
        <nav>
          <button className={tab === "request" ? "active" : ""} onClick={() => { setTab("request"); setError(""); }}>{editingRequestId ? "Edit request" : "Request leave"}</button>
          <button className={tab === "history" ? "active" : ""} onClick={() => { setTab("history"); resetForm(); }}>My requests</button>
        </nav>
        {loading ? <div className="dx-loader"><span /><small>Loading leave policy…</small></div> : null}
        {error ? <div className="dx-alert error">{error}<button onClick={() => void loadLeave()}>Retry</button></div> : null}
        {notice ? <div className="dx-alert success" aria-live="polite">{notice}</div> : null}

        {!loading && tab === "request" ? <form onSubmit={submit}>
          <label>
            Leave type
            <select disabled={!leaveMasterReady || submitting || Boolean(editingRequestId && data?.types.length === 1)} onChange={(event) => setLeaveTypeId(event.target.value)} value={leaveTypeId}>
              <option value="">{leaveMasterReady ? "Select leave type" : "No active leave types"}</option>
              {(data?.types ?? []).map((type) => <option key={type.id} value={type.id}>{type.name} · {type.balanceMode === "unlimited_unpaid" ? "Unpaid" : `${type.available} available`}</option>)}
            </select>
          </label>
          {selectedType ? <p className="dx-leave-balance">{selectedType.balanceMode === "unlimited_unpaid"
            ? `Unpaid leave · No balance limit · ${selectedType.pending} pending`
            : `${selectedType.allowance} yearly · ${selectedType.used} used · ${selectedType.pending} pending`}</p> : null}
          {!leaveMasterReady ? <p>No active leave type is available. HR can enable one in Leave Policy.</p> : null}
          <div className="dx-leave-dates">
            <label>From date<input min={minimumDate} onChange={(event) => setFromDate(event.target.value)} type="date" value={fromDate} /></label>
            <label>To date<input min={fromDate || minimumDate} onChange={(event) => setToDate(event.target.value)} type="date" value={toDate} /></label>
          </div>
          <label>Reason<textarea onChange={(event) => setReason(event.target.value)} placeholder="Enter reason for leave" rows={4} value={reason} /></label>
          {isSickLeave ? <section className={`dx-leave-proof${medicalProofRequired ? " required" : ""}`}>
            <div className="dx-leave-proof-head"><span><Paperclip /><strong>Medical proof</strong></span><em>{medicalProofRequired ? "Required" : "Optional for 1 day"}</em></div>
            <p><Info />A doctor&apos;s note, prescription, or medical certificate is required when sick leave is longer than one day.</p>
            <label className="dx-leave-proof-upload">
              <Upload />
              <span><strong>{proof?.name || existingProofName || "Choose proof"}</strong><small>PDF, JPG, PNG or WebP · max 10 MB</small></span>
              <input accept="application/pdf,image/jpeg,image/png,image/webp" onChange={(event) => setProof(event.target.files?.[0] ?? null)} ref={proofInput} required={medicalProofRequired && !existingProofName} type="file" />
            </label>
          </section> : null}
          {approvalRoute ? <div className="dx-exit-route-preview" aria-label="Configured leave approval route">
            <div>
              <span className="connect-exit-eyebrow">Approval route</span>
              <strong>{approvalRoute.direct
                ? "Direct record"
                : approvalRoute.ready
                  ? `${approvalRoute.steps.length} stage${approvalRoute.steps.length === 1 ? "" : "s"}`
                  : "Setup required"}</strong>
            </div>
            {approvalRoute.policyName ? <small className="dx-leave-route-policy">{approvalRoute.policyName}</small> : null}
            {approvalRoute.direct ? <small>No manager approval is required for your assignment.</small> : null}
            {approvalRoute.ready && !approvalRoute.direct ? (
              <ol>{approvalRoute.steps.map((step) => (
                <li key={`${step.stepOrder}-${step.stepName}`}>
                  <i>{step.stepOrder}</i>
                  <span><strong>{step.stepName}</strong><small>{step.approverName} · {step.detail}</small></span>
                </li>
              ))}</ol>
            ) : null}
            {!approvalRoute.ready ? <p role="alert">{approvalRoute.error || "No leave approval workflow is configured for your designation in People."}</p> : null}
          </div> : null}
          <div className="dx-leave-form-actions">
            {editingRequestId ? <button className="dx-leave-secondary" disabled={submitting} onClick={() => { resetForm(); setTab("history"); }} type="button">Cancel edit</button> : null}
            <button className="dx-save" disabled={submitting || !leaveMasterReady || !leaveTypeId || !fromDate || !toDate || reason.trim().length < 3 || (medicalProofRequired && !proof && !existingProofName) || (approvalRoute ? !approvalRoute.ready : false)} type="submit">{submitting ? "Saving…" : editingRequestId ? "Save changes" : "Submit request"}</button>
          </div>
        </form> : null}

        {!loading && tab === "history" && !data?.requests.length ? <div className="dx-leave-empty">
          <CalendarDays /><strong>No leave requests yet</strong><small>Submitted requests will appear here.</small>
        </div> : null}
        {!loading && tab === "history" && data?.requests.length ? <div className="dx-leave-history">
          {data.requests.map((request) => <article key={request.id}>
            <header><strong>{request.leaveType}</strong><em className={request.status}>{request.status}</em></header>
            <div><span>{displayDate(request.fromDate)}{request.toDate !== request.fromDate ? ` – ${displayDate(request.toDate)}` : ""}</span><b>{request.days} day{request.days === 1 ? "" : "s"}</b></div>
            <p>{request.reason}</p>
            {request.steps?.length ? (
              <ol className="dx-leave-steps">
                {request.steps.map((step) => (
                  <li key={`${request.id}:${step.stepOrder}`}>
                    <strong>{step.stepName}</strong>
                    <em className={step.status}>{stepStatusLabel(step.status)}</em>
                  </li>
                ))}
              </ol>
            ) : null}
            {request.hasProof && request.proofUrl ? <a className="dx-leave-proof-link" href={request.proofUrl}><FileCheck2 />{request.proofFileName || "View medical proof"}</a> : null}
            {request.reviewerNote ? <small>{request.reviewerNote}</small> : null}
            {request.status === "pending" ? <footer className="dx-leave-history-actions">
              <button disabled={submitting} onClick={() => startEdit(request)} type="button"><Pencil />Edit</button>
              <button className="danger" disabled={submitting} onClick={() => void withdraw(request.id)} type="button"><RotateCcw />Withdraw</button>
            </footer> : null}
          </article>)}
        </div> : null}
      </div>
      </> : null}
    </section>
  );
}
