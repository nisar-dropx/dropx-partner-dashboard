"use client";

import { CalendarDays, Clock3, Home, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { AppAccount } from "./connect-profile-app";

type WfhTab = "request" | "history";
type WfhRequest = {
  id: string;
  requestNo: string;
  fromDate: string;
  toDate: string;
  days: number;
  reason: string;
  status: string;
  managerName?: string | null;
  managerNote?: string | null;
  hrNote?: string | null;
  hrReviewerName?: string | null;
};
type WfhData = {
  policy: { enabled: boolean; maxRequestDays: number; allowBackdated: boolean; requiresHrFinalization: boolean };
  requests: WfhRequest[];
  summary: { pending: number };
};

function displayDate(value: string) {
  return value.split("-").reverse().join("/");
}
function todayInIndia() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}
function inclusiveDays(fromDate: string, toDate: string) {
  if (!fromDate || !toDate) return 0;
  const difference = Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`);
  return Number.isFinite(difference) && difference >= 0 ? Math.floor(difference / 86_400_000) + 1 : 0;
}
function statusLabel(status: string) {
  switch (status) {
    case "pending_manager": return "Pending manager";
    case "pending_hr": return "Pending HR";
    case "approved": return "Approved · Present WFH";
    case "returned": return "Returned";
    case "rejected": return "Rejected";
    case "cancelled": return "Withdrawn";
    default: return status;
  }
}

export function ConnectWfh({ account }: { account: AppAccount }) {
  const [tab, setTab] = useState<WfhTab>("request");
  const [data, setData] = useState<WfhData | null>(null);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const resetForm = useCallback(() => {
    setFromDate("");
    setToDate("");
    setReason("");
  }, []);

  const loadWfh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const query = new URLSearchParams({ accountId: account.id, profileType: account.profileType });
      const response = await fetch(`/api/connect/wfh?${query}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to load work from home.");
      setData(payload);
    } catch (reasonValue) {
      setError(reasonValue instanceof Error ? reasonValue.message : "Unable to load work from home.");
    } finally {
      setLoading(false);
    }
  }, [account.id, account.profileType]);

  useEffect(() => { void loadWfh(); }, [loadWfh]);

  const minimumDate = data?.policy.allowBackdated ? undefined : todayInIndia();
  const requestedDays = inclusiveDays(fromDate, toDate);
  const maxDays = data?.policy.maxRequestDays ?? 30;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!fromDate || !toDate || reason.trim().length < 3) return;
    if (requestedDays > maxDays) {
      setError(`A WFH request can cover at most ${maxDays} day(s).`);
      return;
    }
    setSubmitting(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/connect/wfh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: account.id,
          profileType: account.profileType,
          fromDate,
          toDate,
          reason
        })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to submit work from home.");
      setNotice(payload.notice || "WFH request submitted.");
      resetForm();
      setTab("history");
      await loadWfh();
    } catch (reasonValue) {
      setError(reasonValue instanceof Error ? reasonValue.message : "Unable to submit work from home.");
    } finally {
      setSubmitting(false);
    }
  }

  async function withdraw(requestId: string) {
    setSubmitting(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/connect/wfh", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: account.id,
          profileType: account.profileType,
          requestId
        })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to withdraw work from home.");
      setNotice(payload.notice || "WFH request withdrawn.");
      await loadWfh();
    } catch (reasonValue) {
      setError(reasonValue instanceof Error ? reasonValue.message : "Unable to withdraw work from home.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="dx-leave">
      <header className="dx-page-intro">
        <small>Attendance</small>
        <h1>Work from home</h1>
        <p>Request a date range. After manager approval, HR marks working days Present · WFH.</p>
      </header>
      <div className="dx-leave-summary">
        <div><i><Home /></i><span><small>Max days / request</small><strong>{loading ? "—" : data?.policy.maxRequestDays ?? "—"}</strong></span></div>
        <div><i><Clock3 /></i><span><small>Pending</small><strong>{loading ? "—" : data?.summary.pending ?? 0}</strong></span></div>
      </div>

      <div className="dx-leave-card">
        <nav>
          <button className={tab === "request" ? "active" : ""} onClick={() => { setTab("request"); setError(""); }}>Request WFH</button>
          <button className={tab === "history" ? "active" : ""} onClick={() => { setTab("history"); resetForm(); }}>My requests</button>
        </nav>
        {loading ? <div className="dx-loader"><span /><small>Loading WFH policy…</small></div> : null}
        {error ? <div className="dx-alert error">{error}<button onClick={() => void loadWfh()}>Retry</button></div> : null}
        {notice ? <div className="dx-alert success" aria-live="polite">{notice}</div> : null}

        {!loading && tab === "request" ? <form onSubmit={submit}>
          <div className="dx-leave-dates">
            <label>From date<input min={minimumDate} onChange={(event) => setFromDate(event.target.value)} type="date" value={fromDate} /></label>
            <label>To date<input min={fromDate || minimumDate} onChange={(event) => setToDate(event.target.value)} type="date" value={toDate} /></label>
          </div>
          {requestedDays ? <p className="dx-leave-balance">{requestedDays} calendar day(s) · weekly offs and holidays are skipped when HR applies attendance</p> : null}
          <label>Reason<textarea onChange={(event) => setReason(event.target.value)} placeholder="Why do you need to work from home?" rows={4} value={reason} /></label>
          <div className="dx-leave-actions">
            <button className="dx-save" disabled={submitting || !fromDate || !toDate || reason.trim().length < 3 || requestedDays > maxDays} type="submit">
              {submitting ? "Saving…" : "Submit request"}
            </button>
          </div>
        </form> : null}

        {!loading && tab === "history" ? <div className="dx-leave-history">
          {(data?.requests ?? []).length ? data?.requests.map((request) => (
            <article key={request.id}>
              <header>
                <strong>{request.requestNo}</strong>
                <span>{statusLabel(request.status)}</span>
              </header>
              <p><CalendarDays />{displayDate(request.fromDate)} – {displayDate(request.toDate)} · {request.days} day(s)</p>
              <p>{request.reason}</p>
              {request.managerNote ? <p>Manager: {request.managerNote}</p> : null}
              {request.hrNote ? <p>HR: {request.hrNote}</p> : null}
              {["pending_manager", "returned"].includes(request.status) ? (
                <button className="secondary" disabled={submitting} onClick={() => void withdraw(request.id)} type="button">
                  <RotateCcw />Withdraw
                </button>
              ) : null}
            </article>
          )) : <p>No WFH requests yet.</p>}
        </div> : null}
      </div>
    </section>
  );
}
