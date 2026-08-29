"use client";

import { ArrowLeftRight, CalendarClock, CalendarDays, Camera, Check, ClipboardCheck, Clock3, FileText, LocateFixed, MapPin, RotateCcw, X } from "lucide-react";
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

type AttendanceApproval = {
  id: string;
  requestId: string;
  stepName: string;
  stepOrder: number;
  workerName: string;
  workerCode: string;
  profileType: "employee" | "contractor";
  attendanceDate: string;
  currentInTime: string | null;
  currentOutTime: string | null;
  requestedInTime: string | null;
  requestedOutTime: string | null;
  reasonCode: string;
  remarks: string | null;
  evidenceUrl: string | null;
  createdAt: string;
  queue?: "manager" | "hr";
};

type RosterApproval = {
  id: string;
  planId: string;
  stepId: string | null;
  stageType: string;
  stageNumber: number;
  name: string;
  stationCode: string;
  stationName: string;
  effectiveFrom: string;
  periodEnd: string;
  revision: number;
  rowCount: number;
};

type RosterSwapApproval = {
  id: string;
  rosterDate: string;
  requestedAt: string;
  requesterName: string;
  requesterCode: string;
  partnerName: string;
  partnerCode: string;
  requesterDayType: string;
  partnerDayType: string;
  requesterShift: { id: string; name: string; code: string; start_time: string; end_time: string } | null;
  partnerShift: { id: string; name: string; code: string; start_time: string; end_time: string } | null;
  requesterNote: string | null;
  partnerNote: string | null;
};

type ApprovalSection = "time-off" | "attendance" | "rosters" | "location-integrity" | "reimbursements";
type ReporteeScope = "immediate" | "team";

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
function displayTime(value: string | null) {
  if (!value) return "—";
  const match = value.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return value;
  const hours = Number(match[1]);
  const minutes = match[2];
  const hour12 = hours % 12 || 12;
  const period = hours >= 12 ? "PM" : "AM";
  return `${hour12}:${minutes} ${period}`;
}
function regularizationReasonLabel(reasonCode: string) {
  switch (reasonCode) {
    case "missed_in": return "Missed IN punch";
    case "missed_out": return "Missed OUT punch";
    case "missed_both": return "Missed both punches";
    case "incorrect_in": return "Incorrect IN time";
    case "incorrect_out": return "Incorrect OUT time";
    default: return "Other correction";
  }
}
function rosterStageLabel(stageType: string) {
  switch (stageType) {
    case "level_1": return "Level 1 approval";
    case "level_2": return "Level 2 approval";
    case "hr": return "HR approval";
    default: return "Roster approval";
  }
}
function rosterSwapShiftLabel(shift: RosterSwapApproval["requesterShift"], dayType: string) {
  if (dayType === "weekly_off") return "Weekly off";
  if (!shift) return "Shift not assigned";
  return `${shift.start_time.slice(0, 5)}–${shift.end_time.slice(0, 5)}`;
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
  const [reporteeScope, setReporteeScope] = useState<ReporteeScope>("immediate");
  const [reimbursements, setReimbursements] = useState<ReimbursementApproval[]>([]);
  const [leaveApprovals, setLeaveApprovals] = useState<LeaveApproval[]>([]);
  const [attendanceApprovals, setAttendanceApprovals] = useState<AttendanceApproval[]>([]);
  const [attendanceHrApprovals, setAttendanceHrApprovals] = useState<AttendanceApproval[]>([]);
  const [rosterApprovals, setRosterApprovals] = useState<RosterApproval[]>([]);
  const [rosterSwapApprovals, setRosterSwapApprovals] = useState<RosterSwapApproval[]>([]);
  const [supportPackages, setSupportPackages] = useState<LocationSupportPackage[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const query = new URLSearchParams({ accountId: account.id, profileType: account.profileType, reporteeScope });
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
      setAttendanceApprovals(leavePayload.attendanceApprovals ?? []);
      setAttendanceHrApprovals(leavePayload.attendanceHrApprovals ?? []);
      setRosterApprovals(leavePayload.rosterApprovals ?? []);
      setRosterSwapApprovals(leavePayload.rosterSwapApprovals ?? []);
      setSupportPackages(leavePayload.locationSupportPackages ?? []);
      setSection((current) => {
        if (current === "time-off" && !(leavePayload.leaveApprovals ?? []).length) {
          if ((leavePayload.attendanceApprovals ?? []).length || (leavePayload.attendanceHrApprovals ?? []).length) return "attendance";
          if ((leavePayload.rosterSwapApprovals ?? []).length || (leavePayload.rosterApprovals ?? []).length) return "rosters";
          if ((leavePayload.locationSupportPackages ?? []).length) return "location-integrity";
          if ((reimbursementPayload.approvals ?? []).length) return "reimbursements";
        }
        return current;
      });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to load approvals."); }
    finally { setLoading(false); }
  }, [account.id, account.profileType, reporteeScope]);

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

  async function decideAttendance(requestId: string, decision: "approved" | "rejected" | "returned", queue: "manager" | "hr" = "manager") {
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/connect/approvals", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: account.id,
          profileType: account.profileType,
          attendanceRequestId: requestId,
          attendanceQueue: queue,
          decision,
          note: notes[requestId] ?? ""
        })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to update attendance approval.");
      setNotice(payload.notice); setNotes((current) => ({ ...current, [requestId]: "" })); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to update attendance approval."); }
    finally { setSaving(false); }
  }

  async function decideSupportPackage(reviewId: string, decision: "approved" | "returned" | "rejected") {
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/connect/approvals", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account.id, profileType: account.profileType, reporteeScope, reviewId, decision, note: notes[reviewId] ?? "" })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to update support package.");
      setNotice(payload.notice); setNotes((current) => ({ ...current, [reviewId]: "" })); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to update support package."); }
    finally { setSaving(false); }
  }

  async function decideRoster(approval: RosterApproval, decision: "approved" | "returned" | "rejected") {
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/connect/approvals", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: account.id,
          profileType: account.profileType,
          rosterPlanId: approval.planId,
          rosterStepId: approval.stepId,
          decision,
          note: notes[approval.id] ?? ""
        })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to update roster approval.");
      setNotice(payload.notice); setNotes((current) => ({ ...current, [approval.id]: "" })); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to update roster approval."); }
    finally { setSaving(false); }
  }

  async function decideRosterSwap(requestId: string, decision: "approved" | "rejected") {
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/connect/approvals", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: account.id,
          profileType: account.profileType,
          rosterSwapRequestId: requestId,
          decision,
          note: notes[requestId] ?? ""
        })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to update shift swap.");
      setNotice(payload.notice); setNotes((current) => ({ ...current, [requestId]: "" })); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to update shift swap."); }
    finally { setSaving(false); }
  }

  const attendanceCount = attendanceApprovals.length + attendanceHrApprovals.length;
  const rosterCount = rosterApprovals.length + rosterSwapApprovals.length;
  const scopeName = reporteeScope === "immediate" ? "immediate reportees" : "entire reporting team";

  function selectReporteeScope(scope: ReporteeScope) {
    if (scope === reporteeScope) return;
    setError("");
    setNotice("");
    setReporteeScope(scope);
  }

  function renderAttendanceCard(approval: AttendanceApproval, queue: "manager" | "hr") {
    const noteRequired = queue === "hr";
    return (
      <article className="dx-approval-card" key={`${queue}:${approval.id}`}>
        <ApprovalHead
          badge={<span className="dx-approval-badge">{displayDate(approval.attendanceDate)}</span>}
          eyebrow={`${regularizationReasonLabel(approval.reasonCode)} · ${approval.stepName}`}
          meta={`${approval.workerCode || "—"} · ${profileLabel(approval.profileType)}`}
          name={approval.workerName}
        />
        <div className="dx-approval-time-grid">
          <div>
            <small>Current record</small>
            <p><span>IN</span><strong>{displayTime(approval.currentInTime)}</strong></p>
            <p><span>OUT</span><strong>{displayTime(approval.currentOutTime)}</strong></p>
          </div>
          <div className="requested">
            <small>Requested</small>
            <p><span>IN</span><strong>{displayTime(approval.requestedInTime)}</strong></p>
            <p><span>OUT</span><strong>{displayTime(approval.requestedOutTime)}</strong></p>
          </div>
        </div>
        {approval.remarks ? <p className="dx-approval-inline-note">{approval.remarks}</p> : null}
        {approval.evidenceUrl ? (
          <div className="dx-approval-evidence compact">
            <a aria-label="View CCTV proof" className="dx-approval-evidence-photo" href={approval.evidenceUrl} rel="noreferrer" target="_blank">
              <img alt="" src={approval.evidenceUrl} />
              <Camera />
            </a>
            <div className="dx-approval-evidence-copy">
              <p className="dx-approval-evidence-note">Workplace CCTV proof attached</p>
              <div className="dx-approval-evidence-foot">
                <small>Submitted {dateTime(approval.createdAt)}</small>
                <a href={approval.evidenceUrl} rel="noreferrer" target="_blank"><FileText />Open proof</a>
              </div>
            </div>
          </div>
        ) : (
          <p className="dx-approval-inline-note warn">Proof missing — approval will be blocked until evidence is available.</p>
        )}
        <ApprovalNote
          id={approval.requestId}
          notes={notes}
          onChange={(value) => setNote(approval.requestId, value)}
          placeholder={noteRequired ? "Required when returning or rejecting" : "Note for worker (optional)"}
        />
        {queue === "hr" ? (
          <ApprovalToolbar
            onApprove={() => void decideAttendance(approval.requestId, "approved", "hr")}
            onReject={() => void decideAttendance(approval.requestId, "rejected", "hr")}
            onReturn={() => void decideAttendance(approval.requestId, "returned", "hr")}
            saving={saving}
          />
        ) : (
          <ApprovalToolbar
            onApprove={() => void decideAttendance(approval.requestId, "approved", "manager")}
            onReject={() => void decideAttendance(approval.requestId, "rejected", "manager")}
            saving={saving}
            showReturn={false}
          />
        )}
      </article>
    );
  }

  return (
    <section className="dx-approval-inbox">
      <header className="dx-page-intro">
        <small>Manager workspace</small>
        <h1>Approval inbox</h1>
        <p>Review workflow steps from your reporting hierarchy.</p>
      </header>
      <div className="dx-approval-scope">
        <div aria-label="Choose reportee view" className="dx-approval-scope-switch" role="group">
          <button
            aria-pressed={reporteeScope === "immediate"}
            className={reporteeScope === "immediate" ? "active" : ""}
            onClick={() => selectReporteeScope("immediate")}
            type="button"
          >
            Immediate reportees
          </button>
          <button
            aria-pressed={reporteeScope === "team"}
            className={reporteeScope === "team" ? "active" : ""}
            onClick={() => selectReporteeScope("team")}
            type="button"
          >
            Entire team
          </button>
        </div>
        <p>{reporteeScope === "immediate"
          ? "Showing only people who report directly to you."
          : "Showing everyone below you in the active Org Chart tree."}</p>
      </div>
      {error ? <div className="dx-alert error">{error}</div> : null}
      {notice ? <div className="dx-alert success">{notice}</div> : null}
      <nav aria-label="Approval sections" className="dx-approval-tabs">
        <button className={section === "time-off" ? "active" : ""} onClick={() => setSection("time-off")} type="button">
          Time off<span>{leaveApprovals.length}</span>
        </button>
        <button className={section === "attendance" ? "active" : ""} onClick={() => setSection("attendance")} type="button">
          Attendance<span>{attendanceCount}</span>
        </button>
        <button className={section === "rosters" ? "active" : ""} onClick={() => setSection("rosters")} type="button">
          Rosters<span>{rosterCount}</span>
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
            <div className="dx-empty"><Clock3 /><strong>No time-off approvals</strong><small>No requests from your {scopeName} are waiting.</small></div>
          )}
        </div>
      ) : null}

      {!loading && section === "attendance" ? (
        <div className="dx-approval-list">
          {attendanceApprovals.length ? (
            <>
              <header className="dx-approval-section-head">
                <strong>Reporting manager</strong>
                <span>{attendanceApprovals.length} pending</span>
              </header>
              {attendanceApprovals.map((approval) => renderAttendanceCard(approval, "manager"))}
            </>
          ) : null}
          {attendanceHrApprovals.length ? (
            <>
              <header className="dx-approval-section-head">
                <strong>HR finalization</strong>
                <span>{attendanceHrApprovals.length} pending</span>
              </header>
              {attendanceHrApprovals.map((approval) => renderAttendanceCard(approval, "hr"))}
            </>
          ) : null}
          {!attendanceApprovals.length && !attendanceHrApprovals.length ? (
            <div className="dx-empty"><CalendarClock /><strong>No attendance regularizations</strong><small>No requests from your {scopeName} are waiting.</small></div>
          ) : null}
        </div>
      ) : null}

      {!loading && section === "rosters" ? (
        <div className="dx-approval-list">
          {rosterSwapApprovals.length ? rosterSwapApprovals.map((approval) => (
            <article className="dx-approval-card" key={`swap:${approval.id}`}>
              <ApprovalHead
                badge={<span className="dx-approval-badge">Swap</span>}
                eyebrow={`Shift swap · ${displayDate(approval.rosterDate)}`}
                meta={`${approval.requesterCode || "—"} ↔ ${approval.partnerCode || "—"}`}
                name={`${approval.requesterName} ↔ ${approval.partnerName}`}
              />
              <dl className="dx-approval-facts">
                <div><dt>Exchange</dt><dd>{rosterSwapShiftLabel(approval.requesterShift, approval.requesterDayType)} ↔ {rosterSwapShiftLabel(approval.partnerShift, approval.partnerDayType)}</dd></div>
                <div><dt>Requested</dt><dd>{dateTime(approval.requestedAt)}</dd></div>
                {approval.requesterNote ? <div><dt>Requester note</dt><dd>{approval.requesterNote}</dd></div> : null}
                {approval.partnerNote ? <div><dt>Partner note</dt><dd>{approval.partnerNote}</dd></div> : null}
              </dl>
              <ApprovalNote id={approval.id} notes={notes} onChange={(value) => setNote(approval.id, value)} placeholder="Note for colleagues (optional)" />
              <ApprovalToolbar
                onApprove={() => void decideRosterSwap(approval.id, "approved")}
                onReject={() => void decideRosterSwap(approval.id, "rejected")}
                saving={saving}
                showReturn={false}
              />
            </article>
          )) : null}
          {rosterApprovals.length ? rosterApprovals.map((approval) => (
            <article className="dx-approval-card" key={approval.id}>
              <ApprovalHead
                badge={<span className="dx-approval-badge">Rev {approval.revision}</span>}
                eyebrow={`${approval.stationCode} · ${rosterStageLabel(approval.stageType)}`}
                meta={`${approval.rowCount} roster cell${approval.rowCount === 1 ? "" : "s"} · Step ${approval.stageNumber}`}
                name={approval.name || `${approval.stationName || approval.stationCode} weekly roster`}
              />
              <dl className="dx-approval-facts">
                <div><dt>Station</dt><dd>{approval.stationCode}{approval.stationName ? ` · ${approval.stationName}` : ""}</dd></div>
                <div><dt>Effective week</dt><dd>{displayDate(approval.effectiveFrom)} – {displayDate(approval.periodEnd)}</dd></div>
                <div><dt>Pattern</dt><dd>Recurring Monday–Sunday roster change</dd></div>
              </dl>
              <ApprovalNote
                id={approval.id}
                notes={notes}
                onChange={(value) => setNote(approval.id, value)}
                placeholder="Required when returning or rejecting"
              />
              <ApprovalToolbar
                onApprove={() => void decideRoster(approval, "approved")}
                onReject={() => void decideRoster(approval, "rejected")}
                onReturn={() => void decideRoster(approval, "returned")}
                saving={saving}
              />
            </article>
          )) : null}
          {!rosterSwapApprovals.length && !rosterApprovals.length ? (
            <div className="dx-empty"><ArrowLeftRight /><strong>No roster approvals</strong><small>Shift swaps and weekly roster changes assigned to you will appear here.</small></div>
          ) : null}
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
              <div className="dx-approval-evidence">
                {item.selfieUrl ? (
                  <a aria-label="View support selfie" className="dx-approval-evidence-photo" href={item.selfieUrl} rel="noreferrer" target="_blank">
                    <img alt="" src={item.selfieUrl} />
                    <Camera />
                  </a>
                ) : (
                  <div aria-hidden="true" className="dx-approval-evidence-photo missing"><Camera /></div>
                )}
                <div className="dx-approval-evidence-copy">
                  <p className="dx-approval-evidence-coords">
                    <LocateFixed />
                    <span>{item.lat.toFixed(5)}, {item.lng.toFixed(5)}{item.accuracyM == null ? "" : ` · ±${Math.round(item.accuracyM)}m`}</span>
                  </p>
                  <p className="dx-approval-evidence-note">{item.remarks || "Selfie and GPS submitted outside station"}</p>
                  <div className="dx-approval-evidence-foot">
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
            <div className="dx-empty"><LocateFixed /><strong>No location checks</strong><small>No support packages from your {scopeName} are waiting.</small></div>
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
            <div className="dx-empty"><Clock3 /><strong>No claims waiting</strong><small>No claims from your {scopeName} are waiting.</small></div>
          )}
        </div>
      ) : null}

      <p className="dx-approval-footnote"><ClipboardCheck /> Scope follows active primary reporting lines in the Org Chart.</p>
    </section>
  );
}
