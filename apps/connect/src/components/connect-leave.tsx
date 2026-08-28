"use client";

import { CalendarDays, Clock3, Pencil, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { AppAccount } from "./connect-profile-app";

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
};
type LeaveData = {
  year: number;
  types: LeaveType[];
  requests: LeaveRequest[];
  lopOnly?: boolean;
  summary: { available: number; pending: number };
};

function displayDate(value: string) { return value.split("-").reverse().join("/"); }
function todayInIndia() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()); }

export function ConnectLeave({ account, lopOnly = account.profileType === "contractor" }: { account: AppAccount; lopOnly?: boolean }) {
  const [tab, setTab] = useState<LeaveTab>("request");
  const [data, setData] = useState<LeaveData | null>(null);
  const [leaveTypeId, setLeaveTypeId] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [reason, setReason] = useState("");
  const [editingRequestId, setEditingRequestId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const resetForm = useCallback(() => {
    setEditingRequestId(null);
    setFromDate("");
    setToDate("");
    setReason("");
  }, []);

  const loadLeave = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const query = new URLSearchParams({ accountId: account.id, profileType: account.profileType });
      const response = await fetch(`/api/connect/leave?${query}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to load time off.");
      setData(payload);
      setLeaveTypeId((current) => current && payload.types.some((item: LeaveType) => item.id === current) ? current : payload.types[0]?.id ?? "");
    } catch (reasonValue) {
      setError(reasonValue instanceof Error ? reasonValue.message : "Unable to load time off.");
    } finally {
      setLoading(false);
    }
  }, [account.id, account.profileType]);

  useEffect(() => { void loadLeave(); }, [loadLeave]);
  const selectedType = data?.types.find((item) => item.id === leaveTypeId) ?? null;
  const leaveMasterReady = Boolean(data?.types.length);
  const minimumDate = todayInIndia();
  const isLop = lopOnly || data?.lopOnly;

  function startEdit(request: LeaveRequest) {
    const typeMatch = data?.types.find((type) => type.name === request.leaveType || type.code === request.leaveTypeCode);
    setEditingRequestId(request.id);
    setLeaveTypeId(typeMatch?.id ?? data?.types[0]?.id ?? "");
    setFromDate(request.fromDate);
    setToDate(request.toDate);
    setReason(request.reason);
    setTab("request");
    setNotice("");
    setError("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!leaveTypeId || !fromDate || !toDate || !reason.trim()) return;
    setSubmitting(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/connect/leave", {
        method: editingRequestId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: account.id,
          profileType: account.profileType,
          requestId: editingRequestId ?? undefined,
          leaveTypeId,
          fromDate,
          toDate,
          reason
        })
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
        <small>{isLop ? "Unpaid time off" : "Time off"}</small>
        <h1>{isLop ? "LOP" : "Leave"}</h1>
        <p>{isLop ? "Request loss-of-pay days and track approval." : "Plan time away and follow every request."}</p>
      </header>
      <div className="dx-leave-summary">
        <div><i><CalendarDays /></i><span><small>{isLop ? "LOP type" : "Available"}</small><strong>{loading ? "—" : isLop ? (data?.types[0]?.name ?? "LOP") : data?.summary.available ?? 0}</strong></span></div>
        <div><i><Clock3 /></i><span><small>Pending</small><strong>{loading ? "—" : data?.summary.pending ?? 0}</strong></span></div>
      </div>

      <div className="dx-leave-card">
        <nav>
          <button className={tab === "request" ? "active" : ""} onClick={() => { setTab("request"); setError(""); }}>{editingRequestId ? "Edit request" : isLop ? "Request LOP" : "Request leave"}</button>
          <button className={tab === "history" ? "active" : ""} onClick={() => { setTab("history"); resetForm(); }}>My requests</button>
        </nav>
        {loading ? <div className="dx-loader"><span /><small>Loading leave policy…</small></div> : null}
        {error ? <div className="dx-alert error">{error}<button onClick={() => void loadLeave()}>Retry</button></div> : null}
        {notice ? <div className="dx-alert success" aria-live="polite">{notice}</div> : null}

        {!loading && tab === "request" ? <form onSubmit={submit}>
          {!isLop ? <label>
            Leave type
            <select disabled={!leaveMasterReady || submitting || Boolean(editingRequestId && data?.types.length === 1)} onChange={(event) => setLeaveTypeId(event.target.value)} value={leaveTypeId}>
              <option value="">{leaveMasterReady ? "Select leave type" : "No active leave types"}</option>
              {(data?.types ?? []).map((type) => <option key={type.id} value={type.id}>{type.name} · {type.balanceMode === "unlimited_unpaid" ? "Unpaid" : `${type.available} available`}</option>)}
            </select>
          </label> : leaveMasterReady ? <p className="dx-leave-balance">Loss of pay · Unpaid · No balance limit</p> : null}
          {selectedType && !isLop ? <p className="dx-leave-balance">{selectedType.balanceMode === "unlimited_unpaid"
            ? `Unpaid leave · No balance limit · ${selectedType.pending} pending`
            : `${selectedType.allowance} yearly · ${selectedType.used} used · ${selectedType.pending} pending`}</p> : null}
          {!leaveMasterReady ? <p>{isLop ? "LOP is not configured for your profile. Contact HR." : "No active leave type is available. HR can enable one in Leave Policy."}</p> : null}
          <div className="dx-leave-dates">
            <label>From date<input min={minimumDate} onChange={(event) => setFromDate(event.target.value)} type="date" value={fromDate} /></label>
            <label>To date<input min={fromDate || minimumDate} onChange={(event) => setToDate(event.target.value)} type="date" value={toDate} /></label>
          </div>
          <label>Reason<textarea onChange={(event) => setReason(event.target.value)} placeholder={isLop ? "Enter reason for LOP" : "Enter reason for leave"} rows={4} value={reason} /></label>
          <div className="dx-leave-form-actions">
            {editingRequestId ? <button className="dx-leave-secondary" disabled={submitting} onClick={() => { resetForm(); setTab("history"); }} type="button">Cancel edit</button> : null}
            <button className="dx-save" disabled={submitting || !leaveMasterReady || !leaveTypeId || !fromDate || !toDate || reason.trim().length < 3} type="submit">{submitting ? "Saving…" : editingRequestId ? "Save changes" : "Submit request"}</button>
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
            {request.reviewerNote ? <small>{request.reviewerNote}</small> : null}
            {request.status === "pending" ? <footer className="dx-leave-history-actions">
              <button disabled={submitting} onClick={() => startEdit(request)} type="button"><Pencil />Edit</button>
              <button className="danger" disabled={submitting} onClick={() => void withdraw(request.id)} type="button"><RotateCcw />Withdraw</button>
            </footer> : null}
          </article>)}
        </div> : null}
      </div>
    </section>
  );
}
