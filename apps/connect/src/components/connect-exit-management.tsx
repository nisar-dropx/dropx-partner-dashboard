"use client";

import {
  ArrowLeft,
  Check,
  ChevronRight,
  Circle,
  FileText,
  Route
} from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";

type Account = {
  id: string;
  name: string | null;
  email: string | null;
  reference: string | null;
  companyName: string;
  profileType: string;
};

type ExitTimelineItem = {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  actorName?: string | null;
  note?: string | null;
};

type ExitCase = {
  id: string;
  caseNumber: string;
  scenario: string;
  status: string;
  stage: string;
  reason: string;
  comments: string;
  requestedLastWorkingDate: string | null;
  approvedLastWorkingDate: string | null;
  submittedAt: string;
  settlementStatus: string;
  timeline: ExitTimelineItem[];
  tasks: Array<{ id: string; category: string; name: string; due_date: string | null; status: string; is_required: boolean }>;
  documents: Array<{ id: string; type: string; name: string; status: string; generatedAt: string; downloadUrl: string }>;
};

type Payload = {
  flow: "people" | "workforce";
  destination: string;
  policy: { resignation_notice_days: number; withdrawal_allowed: boolean };
  reasons: Array<{ id: string; name: string; comment_required: boolean }>;
  approvalRoute: Array<{ stepOrder: number; stepName: string; approverName: string; detail: string }>;
  approvalRouteReady: boolean;
  approvalRouteError: string;
  exitCase: ExitCase | null;
};

function label(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function displayDate(value?: string | null) {
  if (!value) return "Pending";
  const date = new Date(`${value.slice(0, 10)}T00:00:00`);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(date);
}

function endpoint(account: Account) {
  const peopleFlow = ["employee", "user", "contractor"].includes(account.profileType);
  return peopleFlow ? "/api/connect/exit" : "/api/connect/workforce-resignation";
}

function timelineState(items: ExitTimelineItem[], index: number) {
  if (["completed", "approved", "skipped"].includes(items[index]?.status)) return "complete";
  if (items[index]?.status === "rejected") return "rejected";
  const firstOpenIndex = items.findIndex((item) => !["completed", "approved", "skipped"].includes(item.status));
  return index === firstOpenIndex ? "current" : "upcoming";
}

export function ConnectExitManagement({ account, onBack }: { account: Account; onBack: () => void }) {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const api = endpoint(account);

  const load = useCallback(async () => {
    setPending(true);
    setError("");
    try {
      const query = new URLSearchParams({ accountId: account.id, profileType: account.profileType });
      const response = await fetch(`${api}?${query}`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Unable to load exit details.");
      setData(body);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Unable to load exit details.");
    } finally {
      setPending(false);
    }
  }, [account.id, account.profileType, api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    setNotice("");
    const form = new FormData(event.currentTarget);
    const peopleFlow = data?.flow === "people";
    try {
      const response = await fetch(api, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId: account.id,
          profileType: account.profileType,
          action: "submit",
          reasonId: form.get("reason_id"),
          reasonDetails: form.get("reason_details"),
          comments: form.get("comments"),
          requestedLastWorkingDate: form.get("requested_last_working_date"),
          effectiveDate: form.get("requested_last_working_date"),
          personalEmail: peopleFlow ? form.get("personal_email") : undefined,
          personalMobile: peopleFlow ? form.get("personal_mobile") : undefined
        })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Unable to submit resignation.");
      setNotice(body.notice || "Resignation submitted.");
      await load();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Unable to submit resignation.");
    } finally {
      setPending(false);
    }
  }

  async function withdraw() {
    if (!window.confirm("Send a request to withdraw this resignation?")) return;
    setPending(true);
    setError("");
    try {
      const response = await fetch(api, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId: account.id, profileType: account.profileType, action: "withdraw" })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Unable to request withdrawal.");
      setNotice(body.notice);
      await load();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Unable to request withdrawal.");
    } finally {
      setPending(false);
    }
  }

  const exitCase = data?.exitCase;
  const canStart = !exitCase || ["rejected", "withdrawn", "cancelled", "settled"].includes(exitCase.status);
  const canWithdraw = Boolean(
    data?.flow === "people" &&
    exitCase &&
    data.policy.withdrawal_allowed &&
    !["withdrawal_requested", "documents_ready", "closed", "rejected", "withdrawn", "cancelled"].includes(exitCase.status)
  );
  const minDate = new Date().toISOString().slice(0, 10);
  const suggested = new Date();
  suggested.setDate(suggested.getDate() + (data?.policy.resignation_notice_days ?? 0));

  return <section className="connect-exit-page">
    <header className="dx-exit-page-heading">
      <button aria-label="Back to profile" onClick={onBack} type="button"><ArrowLeft /></button>
      <div><small>{data?.destination || "Exit workflow"}</small><h1>Resignation & exit</h1><p>Submit your request and track every stage in one place.</p></div>
    </header>

    {error ? <div className="dx-alert error">{error}</div> : null}
    {notice ? <div className="dx-alert success">{notice}</div> : null}
    {pending && !data ? <div className="connect-exit-card"><p className="connect-help">Loading exit details...</p></div> : null}

    {canStart && data ? <form className="connect-exit-card dx-exit-form" onSubmit={submit}>
      <div className="dx-exit-card-heading"><span className="connect-exit-eyebrow">New request</span><h2>Plan your last working day</h2><p>This request will enter the configured {data.flow === "people" ? "People approval" : "Workforce lifecycle"} workflow.</p></div>
      {data.flow === "people" ? <label>Reason *<select name="reason_id" required defaultValue=""><option value="" disabled>Select a reason</option>{data.reasons.map((reason) => <option key={reason.id} value={reason.id}>{reason.name}</option>)}</select></label> : null}
      <label>Requested last working date *<input name="requested_last_working_date" type="date" min={minDate} max={new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10)} defaultValue={suggested.toISOString().slice(0, 10)} required />{data.policy.resignation_notice_days ? <small>Configured notice period: {data.policy.resignation_notice_days} days</small> : null}</label>
      {data.flow === "people" ? <label>Comments<textarea name="comments" placeholder="Share any details the reviewers should know" /></label> : <label>Reason *<textarea minLength={5} name="reason_details" placeholder="Briefly explain your reason" required /></label>}
      {data.flow === "people" ? <div className="dx-exit-contact-grid"><label>Personal email<input name="personal_email" type="email" defaultValue={account.email ?? ""} placeholder="For exit communication" /></label><label>Personal mobile<input name="personal_mobile" inputMode="tel" placeholder="For exit communication" /></label></div> : null}
      {data.flow === "people" ? <div className="dx-exit-route-preview" aria-label="Configured approval route">
        <div><span className="connect-exit-eyebrow">Approval route</span><strong>{data.approvalRouteReady ? `${data.approvalRoute.length} stage${data.approvalRoute.length === 1 ? "" : "s"}` : "Setup required"}</strong></div>
        {data.approvalRouteReady ? <ol>{data.approvalRoute.map((step) => <li key={`${step.stepOrder}-${step.stepName}`}><i>{step.stepOrder}</i><span><strong>{step.stepName}</strong><small>{step.approverName} · {step.detail}</small></span></li>)}</ol> : <p role="alert">{data.approvalRouteError || "No approver could be resolved for this profile. Ask the People team to review the reporting hierarchy or Offboarding Masters."}</p>}
      </div> : null}
      <div className="connect-exit-warning"><strong>Before submitting</strong><span>Your requested date becomes final only after the configured approval and clearance stages are complete.</span></div>
      <button className="connect-primary" disabled={pending || (data.flow === "people" && (!data.reasons.length || !data.approvalRouteReady))} type="submit">{pending ? "Submitting..." : "Submit resignation"}</button>
    </form> : null}

    {exitCase && !canStart ? <div className="connect-exit-stack">
      <article className="connect-exit-card status-card">
        <div className="connect-exit-status-head"><div><span className="connect-exit-eyebrow">{exitCase.caseNumber}</span><h2>{label(exitCase.status)}</h2></div><span className={`connect-status-badge ${exitCase.status}`}>{label(exitCase.stage)}</span></div>
        <div className="connect-exit-facts"><div><span>Reason</span><strong>{exitCase.reason || "Resignation"}</strong></div><div><span>Requested last day</span><strong>{displayDate(exitCase.requestedLastWorkingDate)}</strong></div><div><span>Approved last day</span><strong>{displayDate(exitCase.approvedLastWorkingDate)}</strong></div><div><span>Settlement</span><strong>{label(exitCase.settlementStatus || "not started")}</strong></div></div>
        {canWithdraw ? <button className="connect-secondary danger" disabled={pending} onClick={withdraw} type="button">Request withdrawal</button> : null}
      </article>

      <article className="connect-exit-card">
        <div className="dx-exit-card-heading"><span className="connect-exit-eyebrow">Live tracker</span><h3>Request progress</h3><p>Updates appear here as managers and teams complete their actions.</p></div>
        <div className="dx-exit-timeline">{exitCase.timeline.length ? exitCase.timeline.map((item, index) => {
          const state = timelineState(exitCase.timeline, index);
          return <div className={state} key={item.id}><i>{state === "complete" ? <Check /> : <Circle />}</i><span><strong>{item.title}</strong><small>{item.actorName ? `${item.actorName} · ` : ""}{item.createdAt ? new Date(item.createdAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : label(item.status)}</small>{item.note ? <em>{item.note}</em> : null}</span></div>;
        }) : <div className="current"><i><Route /></i><span><strong>Submitted for review</strong><small>The receiving team will update this request.</small></span></div>}</div>
      </article>

      {exitCase.tasks.length ? <article className="connect-exit-card"><div className="dx-exit-card-heading"><span className="connect-exit-eyebrow">Checklist</span><h3>Handover and clearance</h3></div><div className="connect-exit-list">{exitCase.tasks.map((task) => <div key={task.id}><span className={`connect-task-dot ${task.status}`} /><div><strong>{task.name}</strong><small>{task.category} · due {task.due_date ?? "not set"}</small></div><em>{label(task.status)}</em></div>)}</div></article> : null}

      <article className="connect-exit-card"><div className="dx-exit-card-heading"><span className="connect-exit-eyebrow">Documents</span><h3>Your exit documents</h3><p>Available documents will appear after the required clearance stages.</p></div>{exitCase.documents.length ? <div className="connect-document-list">{exitCase.documents.map((document) => <a href={document.downloadUrl || undefined} key={document.id} target="_blank" rel="noreferrer"><span><FileText /></span><div><strong>{document.name}</strong><small>{label(document.type)}</small></div><b>Download</b><ChevronRight /></a>)}</div> : <p className="connect-empty-note">No documents are ready yet.</p>}</article>
    </div> : null}
  </section>;
}
