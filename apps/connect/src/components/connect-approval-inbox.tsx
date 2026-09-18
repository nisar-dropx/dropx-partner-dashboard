"use client";

import type { ConnectApprovalSection } from "@/lib/connect-approval-links";
import type { PayAdvanceApproval } from "@/lib/connect-pay-advance-approval";

import { ArrowLeftRight, CalendarClock, CalendarDays, Camera, Check, ChevronDown, ChevronRight, ClipboardCheck, Clock3, DoorOpen, Eye, FileText, Home, LocateFixed, MapPin, MapPinned, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ConnectDialog } from "./connect-dialog";
import type { AppAccount } from "./connect-profile-app";
import { ConnectAttachmentViewer } from "./connect-attachment-viewer";
import { TimeOffAttachmentLink, type TimeOffAttachment } from "./time-off-attachment";
import { ConnectReturnedRosterEditor } from "./connect-returned-roster-editor";
import { userFacingError } from "@/lib/user-facing-error";
import { useKeepAliveRefresh } from "@/lib/use-keep-alive-refresh";
import { expensePolicyMessage, type ExpensePolicyQuote } from "@/lib/reimbursement-policy";

type ApprovalJourney = {
  submittedAt: string | null;
  submittedBy: string;
  currentStep: string;
  approvedCount: number;
  totalSteps: number;
  steps: Array<{
    id: string;
    order: number;
    label: string;
    status: string;
    actorName: string | null;
    actedAt: string | null;
    note: string | null;
  }>;
};

type ExpenseItem = {
  id: string;
  expense_date: string;
  amount: number;
  merchant?: string | null;
  description?: string | null;
  approved_amount?: number | null;
  finance_policy_snapshot?: ExpensePolicyQuote | null;
  hr_expense_categories?: { name: string } | Array<{ name: string }> | null;
};

type Attachment = { id: string; item_id?: string | null; file_name: string; url?: string | null };

type ReimbursementApproval = {
  id: string;
  step_name: string;
  stage_code?: "manager" | "policy_exception" | "finance" | null;
  claim: {
    id: string;
    claim_no: string;
    purpose: string;
    total_claimed: number;
    submitted_at?: string | null;
    requesterName: string;
    requesterCode: string;
    hr_expense_items?: ExpenseItem[];
    attachments?: Attachment[];
  };
  journey?: ApprovalJourney;
};

type ReimbursementOversightSummary = {
  id: string;
  claim_no: string;
  purpose: string;
  total_claimed: number;
  total_approved?: number | null;
  status: string;
  submitted_at?: string | null;
  requesterName: string;
  requesterCode: string;
};

type PreRequestOversightSummary = {
  id: string;
  request_no: string;
  purpose: string;
  estimated_amount?: number | null;
  status: string;
  created_at: string;
  requesterName: string;
  requesterCode: string;
};

type PaymentApproval = {
  id: string;
  requestNo: string;
  locationCode: string | null;
  paymentHeadName: string;
  amount: number | null;
  amountRequested: number | null;
  requesterName: string | null;
  remarks: string | null;
  createdAt: string;
  attachmentCount: number;
};

type ReimbursementOversightDetail = ReimbursementOversightSummary & {
  items: ExpenseItem[];
  attachments: Attachment[];
  steps: Array<{ id: string; step_order: number; step_name: string; stage_code?: string | null; status: string; decision_note?: string | null; decided_at?: string | null; approver_name: string }>;
};

type PreRequestApproval = {
  id: string;
  request_id: string;
  assignee_role: string;
  request: {
    id: string;
    request_no: string;
    purpose: string;
    estimated_amount?: number | null;
    trip_from?: string | null;
    trip_to?: string | null;
    notes?: string | null;
    created_at: string;
    requesterName: string;
    requesterCode: string;
  };
  journey?: ApprovalJourney;
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
  requestedAt?: string | null;
  journey?: ApprovalJourney;
};

type WfhApproval = {
  attachment?: TimeOffAttachment | null;
  id: string;
  requestId: string;
  requestNo: string;
  stepName: string;
  stepOrder: number;
  startDate: string;
  endDate: string;
  days: number;
  reason: string;
  requesterName: string;
  requesterCode: string;
  profileType: "employee" | "contractor";
  managerName?: string | null;
  managerNote?: string | null;
  queue?: "manager" | "hr";
  requestedAt?: string | null;
  managerDecidedAt?: string | null;
  journey?: ApprovalJourney;
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
  journey?: ApprovalJourney;
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
  journey?: ApprovalJourney;
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
  submittedAt?: string | null;
  preview: {
    status: "ready" | "unavailable";
    baselineRevision: number | null;
    changedCells: number | null;
    affectedPeople: number | null;
    days: Array<{ weekday: number; date: string; working: number; weeklyOff: number }>;
    people: Array<{
      workerId: string;
      workerType: string;
      name: string;
      code: string;
      changes: Array<{
        weekday: number;
        date: string;
        before: { kind: "shift" | "weekly_off" | "not_rostered"; label: string; shiftCode: string | null };
        after: { kind: "shift" | "weekly_off" | "not_rostered"; label: string; shiftCode: string | null };
      }>;
    }>;
  };
  journey?: ApprovalJourney;
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
  journey?: ApprovalJourney;
};

type ReturnedRoster = {
  planId: string;
  name: string;
  stationCode: string;
  stationName: string;
  revisionNo: number;
  periodStart: string;
  periodEnd: string;
  returnedNote: string;
  updatedAt: string;
};

type ExitApproval = {
  id: string;
  caseId: string;
  caseNumber: string;
  stepName: string;
  stepOrder: number;
  requesterName: string;
  requesterCode: string;
  profileType: "employee" | "contractor";
  requestedLastWorkingDate: string;
  reason: string;
  submittedAt: string | null;
  journey?: ApprovalJourney;
};

type ExitWithdrawalApproval = {
  id: string;
  caseId: string;
  caseNumber: string;
  requesterName: string;
  requesterCode: string;
  profileType: "employee" | "contractor";
  requestedLastWorkingDate: string;
  reason: string;
  requestedAt: string | null;
  journey?: ApprovalJourney;
};

type ApprovalSection = ConnectApprovalSection;
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
function expensePolicyState(quote?: ExpensePolicyQuote | null) {
  if (!quote || quote.limit_amount == null) return { label: "Policy not configured", tone: "neutral" };
  if (quote.expense_allowed === false) return { label: "Not allowed", tone: "danger" };
  if (quote.excess_amount <= 0) return { label: "Within policy", tone: "success" };
  if (quote.excess_action === "cap") return { label: "Capped to policy", tone: "warning" };
  return { label: "Exception approval", tone: "danger" };
}
function profileLabel(profileType: "employee" | "contractor") {
  return profileType === "contractor" ? "Contractor" : "Employee";
}
function displayTime(value: string | null) {
  if (!value) return "—";
  const match = value.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return value;
  return `${String(Number(match[1])).padStart(2, "0")}:${match[2]}`;
}
function regularizationReasonLabel(reasonCode: string) {
  switch (reasonCode) {
    case "missed_in": return "Missed IN punch";
    case "missed_out": return "Missed OUT punch";
    case "missed_both": return "Missed both punches";
    case "incorrect_in": return "Incorrect IN time";
    case "incorrect_out": return "Incorrect OUT time";
    case "late_in_permission": return "Permission – late IN";
    case "early_out_permission": return "Permission – early OUT";
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
  const start = String(shift.start_time ?? "").match(/^(\d{1,2}):(\d{2})/);
  const end = String(shift.end_time ?? "").match(/^(\d{1,2}):(\d{2})/);
  if (!start || !end) return "Shift not assigned";
  return `${String(Number(start[1])).padStart(2, "0")}:${start[2]}–${String(Number(end[1])).padStart(2, "0")}:${end[2]}`;
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
    <label className="dx-approval-note-field">
      <span>Review note</span>
      <textarea
        aria-label="Review note"
        className="dx-approval-note-input"
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        rows={2}
        value={notes[id] ?? ""}
      />
    </label>
  );
}

function ApprovalToolbar({
  saving,
  onReturn,
  onReject,
  onApprove,
  showReturn = true,
  approveLabel = "Approve",
  rejectLabel = "Reject",
  approveDisabled = false
}: {
  saving: boolean;
  onReturn?: () => void;
  onReject: () => void;
  onApprove: () => void;
  showReturn?: boolean;
  approveLabel?: string;
  rejectLabel?: string;
  approveDisabled?: boolean;
}) {
  return (
    <div className={`dx-approval-toolbar${showReturn ? "" : " duo"}`}>
      {showReturn && onReturn ? (
        <button className="toolbar-return" disabled={saving} onClick={onReturn} type="button">
          <RotateCcw />Return
        </button>
      ) : null}
      <button className="toolbar-reject" disabled={saving} onClick={onReject} type="button">
        <X />{rejectLabel}
      </button>
      <button className="toolbar-approve" disabled={saving || approveDisabled} onClick={onApprove} type="button">
        <Check />{approveLabel}
      </button>
    </div>
  );
}

function ApprovalRow({
  eyebrow,
  name,
  meta,
  badge,
  onReview,
  onApprove,
  approveLabel = "Approve",
  saving,
  readOnly = false
}: {
  eyebrow: string;
  name: string;
  meta: string;
  badge: ReactNode;
  onReview?: () => void;
  onApprove?: () => void;
  approveLabel?: string;
  saving: boolean;
  readOnly?: boolean;
}) {
  const info = (
    <>
      <span aria-hidden="true" className="dx-approval-avatar">{name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("") || "?"}</span>
      <div className="dx-approval-row-main">
        <div className="dx-approval-row-top">
          <p className="dx-approval-row-eyebrow">{eyebrow}</p>
        </div>
        <strong>{name}</strong>
        <p className="dx-approval-row-meta">{meta}</p>
      </div>
    </>
  );
  return (
    <div className="dx-approval-row">
      {readOnly || !onReview ? <div className="dx-approval-row-info">{info}</div> : (
        <button className="dx-approval-row-info" onClick={onReview} type="button">{info}</button>
      )}
      <div className="dx-approval-row-footer">
        <span className="dx-approval-row-badge">{badge}</span>
        <div className="dx-approval-row-actions">
          {readOnly || !onReview ? null : (
            <button aria-label="Review details" className="dx-approval-row-view" onClick={onReview} title="Review details" type="button">
              <span>Review</span><ChevronRight />
            </button>
          )}
          {onApprove ? (
            <button aria-label={approveLabel} className="dx-approval-row-approve" disabled={saving} onClick={onApprove} title={approveLabel} type="button">
              <Check /><span>{approveLabel}</span>
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ApprovalModal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return <ConnectDialog className={`dx-approval-modal${wide ? " dx-approval-modal-wide" : ""}`} eyebrow={`Approval inbox · ${title}`} onClose={onClose} title="Review request">
    <div className="dx-approval-modal-body">{children}</div>
  </ConnectDialog>;
}

function journeyStatus(status: string, isCurrent: boolean) {
  if (status === "pending") return isCurrent ? "Current" : "Upcoming";
  if (["waiting", "queued"].includes(status)) return "Upcoming";
  return statusLabel(status);
}

function ApprovalJourneyCell({
  journey,
  submittedAt,
  submittedBy,
  currentStep
}: {
  journey?: ApprovalJourney;
  submittedAt?: string | null;
  submittedBy: string;
  currentStep: string;
}) {
  const value = journey ?? { submittedAt: submittedAt ?? null, submittedBy, currentStep, approvedCount: 0, totalSteps: 1, steps: [] };
  return (
    <details className="dx-approval-journey">
      <summary>
        <span><Clock3 /><span><small>Journey · {dateTime(value.submittedAt)}</small><strong>{value.currentStep}</strong></span></span>
        <span><b>{value.approvedCount ? `${value.approvedCount} approved` : "New request"}</b><ChevronDown /></span>
      </summary>
      <div className="dx-approval-journey-body">
        <div className="dx-approval-journey-step submitted">
          <i><Check /></i>
          <span><strong>Submitted</strong><small>{value.submittedBy}</small></span>
          <time>{dateTime(value.submittedAt)}</time>
        </div>
        {(() => {
          const firstPendingIndex = value.steps.findIndex((step) => step.status === "pending");
          return value.steps.map((step, index) => {
            const isCurrent = step.status === "pending" && index === firstPendingIndex;
            return (
              <div className={`dx-approval-journey-step status-${step.status}${isCurrent ? " is-current" : ""}`} key={step.id}>
                <i>{step.status === "approved" ? <Check /> : step.status === "rejected" ? <X /> : <Clock3 />}</i>
                <span>
                  <strong>{statusLabel(step.label)}</strong>
                  <small>{step.actorName || (step.status === "pending" ? "Awaiting assigned approver" : "No approver assigned")}{step.note ? ` · ${step.note}` : ""}</small>
                </span>
                <time><b>{journeyStatus(step.status, isCurrent)}</b>{step.actedAt ? dateTime(step.actedAt) : ""}</time>
              </div>
            );
          });
        })()}
      </div>
    </details>
  );
}

const rosterDayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function RosterAssignment({ value, side }: {
  value: RosterApproval["preview"]["people"][number]["changes"][number]["before"];
  side: "before" | "after";
}) {
  return (
    <span className={`dx-roster-assignment ${value.kind} ${side}`}>
      <strong>{value.label}</strong>
      {value.shiftCode ? <small>{value.shiftCode}</small> : null}
    </span>
  );
}

function RosterApprovalPreview({ approval }: { approval: RosterApproval }) {
  const preview = approval.preview;
  if (!preview || preview.status !== "ready") {
    return (
      <div className="dx-roster-preview-unavailable" role="alert">
        <strong>Roster comparison unavailable</strong>
        <span>Reload this approval before approving. You can still return or reject it with a note.</span>
      </div>
    );
  }
  return (
    <section className="dx-roster-preview" aria-label="Updated roster comparison">
      <header>
        <div>
          <small>Updated roster</small>
          <strong>{preview.changedCells} changed day{preview.changedCells === 1 ? "" : "s"} · {preview.affectedPeople} {preview.affectedPeople === 1 ? "person" : "people"}</strong>
        </div>
        <span>{preview.baselineRevision ? `Compared with Rev ${preview.baselineRevision}` : "New roster"}</span>
      </header>
      <div className="dx-roster-coverage" aria-label="Proposed daily staffing">
        {preview.days.map((day) => (
          <div key={day.weekday}>
            <strong>{rosterDayLabels[day.weekday - 1]}</strong>
            <span>{day.working} working</span>
            <small>{day.weeklyOff} off</small>
          </div>
        ))}
      </div>
      {preview.people.length ? (
        <div className="dx-roster-change-list">
          {preview.people.map((person) => (
            <article key={`${person.workerType}:${person.workerId}`}>
              <header>
                <div><strong>{person.name}</strong><small>{person.code}</small></div>
                <span>{person.changes.length} change{person.changes.length === 1 ? "" : "s"}</span>
              </header>
              <div className="dx-roster-person-changes">
                {person.changes.map((change) => (
                  <div key={change.weekday}>
                    <time dateTime={change.date}><strong>{rosterDayLabels[change.weekday - 1]}</strong><small>{displayDate(change.date).slice(0, 5)}</small></time>
                    <RosterAssignment side="before" value={change.before} />
                    <span className="dx-roster-change-arrow" aria-label="changed to">→</span>
                    <RosterAssignment side="after" value={change.after} />
                  </div>
                ))}
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="dx-roster-no-changes"><Check /><span><strong>No assignment differences</strong><small>The submitted pattern matches the previous approved revision.</small></span></div>
      )}
    </section>
  );
}

export function ConnectApprovalInbox({ account, active = true, initialSection }: { account: AppAccount; active?: boolean; initialSection?: ApprovalSection | null }) {
  const { markLoaded, setReload } = useKeepAliveRefresh(active);
  const [section, setSection] = useState<ApprovalSection>(initialSection ?? "time-off");
  useEffect(() => { if (initialSection) setSection(initialSection); }, [initialSection]);
  const [reporteeScope, setReporteeScope] = useState<ReporteeScope>("immediate");
  const [reimbursements, setReimbursements] = useState<ReimbursementApproval[]>([]);
  const [preRequestApprovals, setPreRequestApprovals] = useState<PreRequestApproval[]>([]);
  const [payAdvanceApprovals, setPayAdvanceApprovals] = useState<PayAdvanceApproval[]>([]);
  const [paymentApprovals, setPaymentApprovals] = useState<PaymentApproval[]>([]);
  const [payAdvanceError, setPayAdvanceError] = useState("");
  const [payAdvanceTerms, setPayAdvanceTerms] = useState<Record<string, { amount: string; installments: string }>>({});
  const [expenseOversight, setExpenseOversight] = useState<ReimbursementOversightSummary[]>([]);
  const [preRequestOversight, setPreRequestOversight] = useState<PreRequestOversightSummary[]>([]);
  const [expenseOversightDetail, setExpenseOversightDetail] = useState<ReimbursementOversightDetail | null>(null);
  const [expenseOversightLoadingId, setExpenseOversightLoadingId] = useState<string | null>(null);
  const [leaveApprovals, setLeaveApprovals] = useState<LeaveApproval[]>([]);
  const [wfhApprovals, setWfhApprovals] = useState<WfhApproval[]>([]);
  const [wfhHrApprovals, setWfhHrApprovals] = useState<WfhApproval[]>([]);
  const [businessTripApprovals, setBusinessTripApprovals] = useState<WfhApproval[]>([]);
  const [businessTripHrApprovals, setBusinessTripHrApprovals] = useState<WfhApproval[]>([]);
  const [attendanceApprovals, setAttendanceApprovals] = useState<AttendanceApproval[]>([]);
  const [attendanceHrApprovals, setAttendanceHrApprovals] = useState<AttendanceApproval[]>([]);
  const [rosterApprovals, setRosterApprovals] = useState<RosterApproval[]>([]);
  const [rosterSwapApprovals, setRosterSwapApprovals] = useState<RosterSwapApproval[]>([]);
  const [returnedRosters, setReturnedRosters] = useState<ReturnedRoster[]>([]);
  const [editingReturnedRosterId, setEditingReturnedRosterId] = useState<string | null>(null);
  const [exitApprovals, setExitApprovals] = useState<ExitApproval[]>([]);
  const [exitWithdrawalApprovals, setExitWithdrawalApprovals] = useState<ExitWithdrawalApproval[]>([]);
  const [supportPackages, setSupportPackages] = useState<LocationSupportPackage[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [othersOpen, setOthersOpen] = useState(false);
  const othersRef = useRef<HTMLDivElement | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  function closeModal() { setActiveKey(null); setExpenseOversightDetail(null); }
  async function act(fn: () => Promise<void>) { await fn(); closeModal(); }

  useEffect(() => {
    if (!othersOpen) return;
    function onPointerDown(event: MouseEvent | TouchEvent) {
      const target = event.target as Node | null;
      if (othersRef.current && target && !othersRef.current.contains(target)) {
        setOthersOpen(false);
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOthersOpen(false);
      othersRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
    };
  }, [othersOpen]);

  const load = useCallback(async (background = false) => {
    if (!background) setLoading(true);
    setError("");
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
      const nextClaims = reimbursementPayload.approvals ?? [];
      const nextPreRequests = reimbursementPayload.preRequestApprovals ?? [];
      setReimbursements(nextClaims);
      setPreRequestApprovals(nextPreRequests);
      const actionableClaimIds = new Set(nextClaims.map((entry: ReimbursementApproval) => entry.claim.id));
      setExpenseOversight((reimbursementPayload.expenseOversight ?? []).filter((entry: ReimbursementOversightSummary) => !actionableClaimIds.has(entry.id)));
      const actionablePreRequestIds = new Set(nextPreRequests.map((entry: PreRequestApproval) => entry.request.id));
      setPreRequestOversight((reimbursementPayload.preRequestOversight ?? []).filter((entry: PreRequestOversightSummary) => !actionablePreRequestIds.has(entry.id)));
      setLeaveApprovals(leavePayload.leaveApprovals ?? []);
      setWfhApprovals(leavePayload.wfhApprovals ?? []);
      setWfhHrApprovals(leavePayload.wfhHrApprovals ?? []);
      setBusinessTripApprovals(leavePayload.businessTripApprovals ?? []);
      setBusinessTripHrApprovals(leavePayload.businessTripHrApprovals ?? []);
      setAttendanceApprovals(leavePayload.attendanceApprovals ?? []);
      setAttendanceHrApprovals(leavePayload.attendanceHrApprovals ?? []);
      setRosterApprovals(leavePayload.rosterApprovals ?? []);
      setRosterSwapApprovals(leavePayload.rosterSwapApprovals ?? []);
      setReturnedRosters(leavePayload.returnedRosters ?? []);
      setExitApprovals(leavePayload.exitApprovals ?? []);
      setExitWithdrawalApprovals(leavePayload.exitWithdrawalApprovals ?? []);
      setPayAdvanceApprovals(leavePayload.payAdvanceApprovals ?? []);
      setPaymentApprovals(leavePayload.paymentApprovals ?? []);
      setSupportPackages(leavePayload.locationSupportPackages ?? []);
      setSection((current) => {
        if (!initialSection && current === "time-off" && !(leavePayload.leaveApprovals ?? []).length) {
          if (nextClaims.length || nextPreRequests.length) return "reimbursements";
          if ((leavePayload.attendanceApprovals ?? []).length || (leavePayload.attendanceHrApprovals ?? []).length) return "attendance";
          if ((leavePayload.rosterSwapApprovals ?? []).length || (leavePayload.rosterApprovals ?? []).length) return "rosters";
          if ((leavePayload.exitApprovals ?? []).length || (leavePayload.exitWithdrawalApprovals ?? []).length) return "exits";
          if ((leavePayload.locationSupportPackages ?? []).length) return "location-integrity";
          if ((leavePayload.wfhApprovals ?? []).length || (leavePayload.wfhHrApprovals ?? []).length) return "wfh";
          if ((leavePayload.businessTripApprovals ?? []).length || (leavePayload.businessTripHrApprovals ?? []).length) return "business-trip";
          if ((leavePayload.payAdvanceApprovals ?? []).length) return "pay-advances";
        }
        return current;
      });
    } catch (reason) { setError(userFacingError(reason, "Unable to load approvals.")); }
    finally { if (!background) setLoading(false); markLoaded(); }
  }, [account.id, account.profileType, reporteeScope, markLoaded, initialSection]);
  setReload(() => load(true));

  useEffect(() => { void load(); }, [load]);

  function setNote(id: string, value: string) {
    setNotes((current) => ({ ...current, [id]: value }));
  }

  async function decidePayAdvance(approval: PayAdvanceApproval, decision: "approved" | "rejected") {
    setSaving(true); setPayAdvanceError("");
    try {
      const response = await fetch("/api/connect/approvals", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account.id, profileType: account.profileType,
          payAdvanceRequestId: approval.requestId, decision, note: notes[approval.id] ?? "",
          approvedAmount: payAdvanceTerms[approval.id]?.amount ?? approval.approvedAmount ?? approval.requestedAmount,
          approvedInstallments: payAdvanceTerms[approval.id]?.installments ?? approval.installments })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to record the pay advance decision.");
      setNotice(payload.notice); closeModal(); await load();
    } catch (reason) { setPayAdvanceError(userFacingError(reason, "Unable to record the pay advance decision.")); }
    finally { setSaving(false); }
  }

  async function decidePayment(paymentRequestId: string, decision: "approved" | "returned" | "rejected") {
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/connect/approvals", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account.id, profileType: account.profileType,
          paymentRequestId, decision, comments: notes[paymentRequestId] ?? "" })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to record the payment decision.");
      setNotice(payload.notice); closeModal(); await load();
    } catch (reason) { setError(userFacingError(reason, "Unable to record the payment decision.")); }
    finally { setSaving(false); }
  }

  async function openExpenseOversight(claimId: string) {
    setExpenseOversightLoadingId(claimId);
    setExpenseOversightDetail(null);
    setError("");
    try {
      const query = new URLSearchParams({
        kind: "oversight_claim",
        claimId,
        accountId: account.id,
        profileType: account.profileType
      });
      const response = await fetch(`/api/connect/reimbursements?${query}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to load reimbursement details.");
      setExpenseOversightDetail(payload.claim);
      setActiveKey(`reimbursement-oversight:${claimId}`);
    } catch (reason) {
      setError(userFacingError(reason, "Unable to load reimbursement details."));
    } finally {
      setExpenseOversightLoadingId(null);
    }
  }

  async function decideReimbursement(claimId: string, action: "approved" | "returned" | "rejected") {
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/connect/reimbursements", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account.id, profileType: account.profileType, kind: "claim", claimId, action, note: notes[claimId] ?? "" })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to update reimbursement.");
      setNotice(payload.notice); setNotes((current) => ({ ...current, [claimId]: "" })); await load();
    } catch (reason) { setError(userFacingError(reason, "Unable to update reimbursement.")); }
    finally { setSaving(false); }
  }

  async function decidePreRequest(requestId: string, action: "approved" | "rejected") {
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/connect/reimbursements", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: account.id,
          profileType: account.profileType,
          kind: "pre_request",
          requestId,
          action,
          note: notes[`pre:${requestId}`] ?? ""
        })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to update reimbursement request.");
      setNotice(payload.notice); setNotes((current) => ({ ...current, [`pre:${requestId}`]: "" })); await load();
    } catch (reason) { setError(userFacingError(reason, "Unable to update reimbursement request.")); }
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
    } catch (reason) { setError(userFacingError(reason, "Unable to update time-off approval.")); }
    finally { setSaving(false); }
  }

  async function decideWfh(requestId: string, decision: "approved" | "rejected" | "returned", queue: "manager" | "hr" = "manager") {
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/connect/approvals", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: account.id,
          profileType: account.profileType,
          wfhRequestId: requestId,
          wfhQueue: queue,
          decision,
          note: notes[`wfh:${requestId}`] ?? "",
          ...(queue === "hr" ? { defaultIn: "09:00", defaultOut: "18:00" } : {})
        })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to update WFH approval.");
      setNotice(payload.notice); setNotes((current) => ({ ...current, [`wfh:${requestId}`]: "" })); await load();
    } catch (reason) { setError(userFacingError(reason, "Unable to update WFH approval.")); }
    finally { setSaving(false); }
  }

  async function decideBusinessTrip(requestId: string, decision: "approved" | "rejected" | "returned", queue: "manager" | "hr" = "manager") {
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/connect/approvals", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: account.id,
          profileType: account.profileType,
          businessTripRequestId: requestId,
          businessTripQueue: queue,
          decision,
          note: notes[`business-trip:${requestId}`] ?? "",
          ...(queue === "hr" ? { defaultIn: "09:00", defaultOut: "18:00" } : {})
        })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to update business trip approval.");
      setNotice(payload.notice); setNotes((current) => ({ ...current, [`business-trip:${requestId}`]: "" })); await load();
    } catch (reason) { setError(userFacingError(reason, "Unable to update business trip approval.")); }
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
    } catch (reason) { setError(userFacingError(reason, "Unable to update attendance approval.")); }
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
    } catch (reason) { setError(userFacingError(reason, "Unable to update support package.")); }
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
    } catch (reason) { setError(userFacingError(reason, "Unable to update roster approval.")); }
    finally { setSaving(false); }
  }

  async function resubmitReturnedRoster(planId: string) {
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/connect/approvals", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account.id, profileType: account.profileType, resubmitRosterPlanId: planId, note: notes[planId] ?? "" })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to resubmit roster.");
      setNotice(payload.notice); setNotes((current) => ({ ...current, [planId]: "" })); await load();
    } catch (reason) { setError(userFacingError(reason, "Unable to resubmit roster.")); }
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
    } catch (reason) { setError(userFacingError(reason, "Unable to update shift swap.")); }
    finally { setSaving(false); }
  }

  async function decideExit(approvalId: string, decision: "approved" | "rejected") {
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/connect/approvals", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: account.id,
          profileType: account.profileType,
          exitApprovalId: approvalId,
          decision,
          note: notes[`exit:${approvalId}`] ?? ""
        })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to update exit approval.");
      setNotice(payload.notice); setNotes((current) => ({ ...current, [`exit:${approvalId}`]: "" })); await load();
    } catch (reason) { setError(userFacingError(reason, "Unable to update exit approval.")); }
    finally { setSaving(false); }
  }

  async function decideExitWithdrawal(caseId: string, decision: "approved" | "rejected") {
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/connect/approvals", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: account.id,
          profileType: account.profileType,
          exitWithdrawalCaseId: caseId,
          decision,
          note: notes[`exit-withdraw:${caseId}`] ?? ""
        })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to update exit withdrawal.");
      setNotice(payload.notice); setNotes((current) => ({ ...current, [`exit-withdraw:${caseId}`]: "" })); await load();
    } catch (reason) { setError(userFacingError(reason, "Unable to update exit withdrawal.")); }
    finally { setSaving(false); }
  }

  const attendanceCount = attendanceApprovals.length + attendanceHrApprovals.length;
  const rosterCount = rosterApprovals.length + rosterSwapApprovals.length + returnedRosters.length;
  const reimbursementCount = reimbursements.length + preRequestApprovals.length;
  const exitCount = exitApprovals.length + exitWithdrawalApprovals.length;
  const businessTripCount = businessTripApprovals.length + businessTripHrApprovals.length;
  const wfhCount = wfhApprovals.length + wfhHrApprovals.length;
  const scopeName = reporteeScope === "immediate" ? "immediate reportees" : "entire reporting team";
  const othersCount = leaveApprovals.length + reimbursementCount + wfhCount + businessTripCount + exitCount + payAdvanceApprovals.length + paymentApprovals.length;
  const pendingCount = attendanceCount + rosterCount + supportPackages.length + othersCount;
  const othersActive = section === "time-off" || section === "reimbursements" || section === "wfh" || section === "business-trip" || section === "exits" || section === "pay-advances" || section === "payments";
  const othersLabel = section === "time-off"
    ? "Time off"
    : section === "reimbursements"
      ? "Expenses"
      : section === "wfh"
        ? "WFH"
        : section === "business-trip"
          ? "Business trip"
          : section === "exits"
            ? "Exits"
            : section === "pay-advances"
              ? "Pay advances"
              : section === "payments" ? "Payments" : "More";

  function selectSection(next: ApprovalSection) {
    setSection(next);
    setOthersOpen(false);
  }

  function selectReporteeScope(scope: ReporteeScope) {
    if (scope === reporteeScope) return;
    setError("");
    setNotice("");
    setReporteeScope(scope);
  }

  function attendanceKey(approval: AttendanceApproval, queue: "manager" | "hr") { return `attendance:${queue}:${approval.id}`; }

  function renderAttendanceRow(approval: AttendanceApproval, queue: "manager" | "hr") {
    return (
      <ApprovalRow
        badge={<span className="dx-approval-badge">{displayDate(approval.attendanceDate)}</span>}
        eyebrow={`${regularizationReasonLabel(approval.reasonCode)} · ${approval.stepName}`}
        key={attendanceKey(approval, queue)}
        meta={`${approval.workerCode || "—"} · ${profileLabel(approval.profileType)}`}
        name={approval.workerName}
        onReview={() => setActiveKey(attendanceKey(approval, queue))}
        saving={saving}
      />
    );
  }

  function renderAttendanceCard(approval: AttendanceApproval, queue: "manager" | "hr") {
    const noteRequired = queue === "hr";
    return (
      <ApprovalModal onClose={closeModal} title={approval.workerName}>
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
            <ConnectAttachmentViewer
              files={[{ label: "CCTV proof", url: approval.evidenceUrl }]}
              title={`${approval.workerName} · CCTV proof`}
              trigger={<span className="dx-approval-evidence-photo" aria-label="View CCTV proof"><img alt="" src={approval.evidenceUrl} /><Camera /></span>}
            />
            <div className="dx-approval-evidence-copy">
              <p className="dx-approval-evidence-note">Workplace CCTV proof attached</p>
              <div className="dx-approval-evidence-foot">
                <small>Submitted {dateTime(approval.createdAt)}</small>
                <ConnectAttachmentViewer
                  files={[{ label: "CCTV proof", url: approval.evidenceUrl }]}
                  title={`${approval.workerName} · CCTV proof`}
                  trigger={<><FileText />Open proof</>}
                />
              </div>
            </div>
          </div>
        ) : (
          <p className="dx-approval-inline-note warn">Proof missing — approval will be blocked until evidence is available.</p>
        )}
        <ApprovalJourneyCell journey={approval.journey} submittedAt={approval.createdAt} submittedBy={approval.workerName} currentStep={approval.stepName} />
        <ApprovalNote
          id={approval.requestId}
          notes={notes}
          onChange={(value) => setNote(approval.requestId, value)}
          placeholder={noteRequired ? "Required when returning or rejecting" : "Note for worker (required when returning)"}
        />
        {queue === "hr" ? (
          <ApprovalToolbar
            onApprove={() => void act(() => decideAttendance(approval.requestId, "approved", "hr"))}
            onReject={() => void act(() => decideAttendance(approval.requestId, "rejected", "hr"))}
            onReturn={() => void act(() => decideAttendance(approval.requestId, "returned", "hr"))}
            saving={saving}
          />
        ) : (
          <ApprovalToolbar
            onApprove={() => void act(() => decideAttendance(approval.requestId, "approved", "manager"))}
            onReject={() => void act(() => decideAttendance(approval.requestId, "rejected", "manager"))}
            onReturn={() => void act(() => decideAttendance(approval.requestId, "returned", "manager"))}
            saving={saving}
          />
        )}
      </ApprovalModal>
    );
  }

  return (
    <section className="dx-approval-inbox">
      <header className="dx-approval-header">
        <div className="dx-page-intro">
          <small>Team requests</small>
          <h1>Approval inbox</h1>
          <p>Review requests, check the details, and keep your team moving.</p>
        </div>
        <div className="dx-approval-header-actions">
          <span className="dx-approval-pending"><span aria-hidden="true" />{loading ? "Updating inbox" : `${pendingCount} awaiting review`}</span>
          <button aria-label="Refresh approvals" className="dx-approval-refresh" disabled={loading || saving} onClick={() => void load()} type="button"><RotateCcw /></button>
        </div>
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
          ? "Direct reports, plus requests assigned to you."
          : "Your full reporting team, plus requests assigned to you."}</p>
      </div>
    {error ? <div className="dx-alert error">{error}</div> : null}
    {notice ? <div className="dx-alert success">{notice}</div> : null}
      <nav aria-label="Approval sections" className="dx-approval-tabs">
        <div className="dx-approval-tabs-primary">
          <button aria-pressed={section === "attendance"} className={section === "attendance" ? "active" : ""} onClick={() => selectSection("attendance")} type="button">
            <CalendarClock />Attendance<span>{attendanceCount}</span>
          </button>
          <button aria-pressed={section === "rosters"} className={section === "rosters" ? "active" : ""} onClick={() => selectSection("rosters")} type="button">
            <CalendarDays />Rosters<span>{rosterCount}</span>
          </button>
          <button aria-pressed={section === "location-integrity"} className={section === "location-integrity" ? "active" : ""} onClick={() => selectSection("location-integrity")} type="button">
            <MapPin />Location<span>{supportPackages.length}</span>
          </button>
          <div className={`dx-approval-others${othersOpen ? " open" : ""}`} ref={othersRef}>
            <button
              aria-expanded={othersOpen}
              className={othersActive ? "active" : ""}
              onClick={() => setOthersOpen((current) => !current)}
              type="button"
            >
              <span className="dx-approval-other-label">{othersLabel}</span><span>{othersCount}</span><ChevronDown />
            </button>
            {othersOpen ? (
              <div aria-label="More approval categories" className="dx-approval-others-menu" role="group">
                <button aria-pressed={section === "time-off"} className={section === "time-off" ? "active" : ""} onClick={() => selectSection("time-off")} type="button">
                  Time off<span>{leaveApprovals.length}</span>
                </button>
                <button aria-pressed={section === "reimbursements"} className={section === "reimbursements" ? "active" : ""} onClick={() => selectSection("reimbursements")} type="button">
                  Reimbursements<span>{reimbursementCount}</span>
                </button>
                <button aria-pressed={section === "wfh"} className={section === "wfh" ? "active" : ""} onClick={() => selectSection("wfh")} type="button">
                  WFH<span>{wfhCount}</span>
                </button>
                <button aria-pressed={section === "business-trip"} className={section === "business-trip" ? "active" : ""} onClick={() => selectSection("business-trip")} type="button">
                  Business trip<span>{businessTripCount}</span>
                </button>
                <button aria-pressed={section === "exits"} className={section === "exits" ? "active" : ""} onClick={() => selectSection("exits")} type="button">
                  Exits<span>{exitCount}</span>
                </button>
                <button aria-pressed={section === "pay-advances"} className={section === "pay-advances" ? "active" : ""} onClick={() => selectSection("pay-advances")} type="button">
                  Pay advances<span>{payAdvanceApprovals.length}</span>
                </button>
                <button aria-pressed={section === "payments"} className={section === "payments" ? "active" : ""} onClick={() => selectSection("payments")} type="button">
                  Payments<span>{paymentApprovals.length}</span>
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </nav>
    {loading ? <div className="dx-loader"><span /><small>Loading approvals…</small></div> : null}

      {!loading && section === "time-off" ? (
        <div className="dx-approval-list">
          {leaveApprovals.length ? leaveApprovals.map((approval) => (
            <ApprovalRow
              badge={<span className="dx-approval-badge">{approval.days} day{approval.days === 1 ? "" : "s"}</span>}
              eyebrow={`${approval.leaveType} · ${approval.stepName}`}
              key={approval.id}
              meta={`${approval.requesterCode || "—"} · ${profileLabel(approval.profileType)}`}
              name={approval.requesterName}
              onReview={() => setActiveKey(`time-off:${approval.id}`)}
              saving={saving}
            />
          )) : (
            <div className="dx-empty"><Clock3 /><strong>No time-off approvals</strong><small>No time-off steps assigned to you are waiting.</small></div>
          )}
          {(() => {
            const id = activeKey?.match(/^time-off:(.+)$/)?.[1];
            const approval = id ? leaveApprovals.find((item) => item.id === id) : undefined;
            if (!approval) return null;
            return (
              <ApprovalModal onClose={closeModal} title={approval.requesterName}>
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
                <ApprovalJourneyCell journey={approval.journey} submittedAt={approval.requestedAt} submittedBy={approval.requesterName} currentStep={approval.stepName} />
                <ApprovalNote id={approval.requestId} notes={notes} onChange={(value) => setNote(approval.requestId, value)} placeholder="Note for worker (optional)" />
                <ApprovalToolbar
                  onApprove={() => void act(() => decideLeave(approval.requestId, "approved"))}
                  onReject={() => void act(() => decideLeave(approval.requestId, "rejected"))}
                  saving={saving}
                  showReturn={false}
                />
              </ApprovalModal>
            );
          })()}
        </div>
      ) : null}

      {!loading && section === "wfh" ? (
        <div className="dx-approval-list">
          {wfhApprovals.length ? (
            <>
              <header className="dx-approval-section-head">
                <strong>Reporting manager</strong>
                <span>{wfhApprovals.length} pending</span>
              </header>
              {wfhApprovals.map((approval) => (
                <ApprovalRow
                  badge={<span className="dx-approval-badge">{approval.days} day{approval.days === 1 ? "" : "s"}</span>}
                  eyebrow={`${approval.requestNo} · ${approval.stepName}`}
                  key={approval.id}
                  meta={`${approval.requesterCode || "—"} · ${profileLabel(approval.profileType)}`}
                  name={approval.requesterName}
                  onReview={() => setActiveKey(`wfh:manager:${approval.id}`)}
                  saving={saving}
                />
              ))}
            </>
          ) : null}
          {wfhHrApprovals.length ? (
            <>
              <header className="dx-approval-section-head">
                <strong>HR finalization</strong>
                <span>{wfhHrApprovals.length} pending</span>
              </header>
              {wfhHrApprovals.map((approval) => (
                <ApprovalRow
                  badge={<span className="dx-approval-badge">{approval.days} day{approval.days === 1 ? "" : "s"}</span>}
                  eyebrow={`${approval.requestNo} · WFH request`}
                  key={`hr:${approval.id}`}
                  meta={`${approval.requesterCode || "—"} · ${profileLabel(approval.profileType)}`}
                  name={approval.requesterName}
                  onReview={() => setActiveKey(`wfh:hr:${approval.id}`)}
                  saving={saving}
                />
              ))}
            </>
          ) : null}
          {!wfhApprovals.length && !wfhHrApprovals.length ? (
            <div className="dx-empty"><Home /><strong>No WFH approvals</strong><small>No work-from-home steps or HR finalizations in your reporting scope are waiting.</small></div>
          ) : null}
          {(() => {
            const match = activeKey?.match(/^wfh:(manager|hr):(.+)$/);
            if (!match) return null;
            const [, queue, id] = match;
            const approval = (queue === "hr" ? wfhHrApprovals : wfhApprovals).find((item) => item.id === id);
            if (!approval) return null;
            return (
              <ApprovalModal onClose={closeModal} title={approval.requesterName}>
                <ApprovalHead
                  badge={<span className="dx-approval-badge">{approval.days} day{approval.days === 1 ? "" : "s"}</span>}
                  eyebrow={queue === "hr" ? `${approval.requestNo} · WFH request` : `${approval.requestNo} · ${approval.stepName}`}
                  meta={`${approval.requesterCode || "—"} · ${profileLabel(approval.profileType)}`}
                  name={approval.requesterName}
                />
                <dl className="dx-approval-facts">
                  <div><dt>Dates</dt><dd>{displayDate(approval.startDate)}{approval.endDate !== approval.startDate ? ` – ${displayDate(approval.endDate)}` : ""}</dd></div>
                  <div><dt>Reason</dt><dd>{approval.reason}</dd></div>
                  {queue === "hr" && approval.managerName ? <div><dt>Manager</dt><dd>{approval.managerName}{approval.managerNote ? ` · ${approval.managerNote}` : ""}</dd></div> : null}
                </dl>
                <ApprovalJourneyCell journey={approval.journey} submittedAt={approval.requestedAt} submittedBy={approval.requesterName} currentStep={approval.stepName} />
                <TimeOffAttachmentLink attachment={approval.attachment} />
                <ApprovalNote id={`wfh:${approval.requestId}`} notes={notes} onChange={(value) => setNote(`wfh:${approval.requestId}`, value)} placeholder="Note for worker (required when returning)" />
                {queue === "hr" ? (
                  <ApprovalToolbar
                    onApprove={() => void act(() => decideWfh(approval.requestId, "approved", "hr"))}
                    onReject={() => void act(() => decideWfh(approval.requestId, "rejected", "hr"))}
                    onReturn={() => void act(() => decideWfh(approval.requestId, "returned", "hr"))}
                    saving={saving}
                  />
                ) : (
                  <ApprovalToolbar
                    onApprove={() => void act(() => decideWfh(approval.requestId, "approved", "manager"))}
                    onReject={() => void act(() => decideWfh(approval.requestId, "rejected", "manager"))}
                    onReturn={() => void act(() => decideWfh(approval.requestId, "returned", "manager"))}
                    saving={saving}
                  />
                )}
              </ApprovalModal>
            );
          })()}
        </div>
      ) : null}

      {!loading && section === "business-trip" ? (
        <div className="dx-approval-list">
          {businessTripApprovals.length ? (
            <>
              <header className="dx-approval-section-head">
                <strong>Reporting manager</strong>
                <span>{businessTripApprovals.length} pending</span>
              </header>
              {businessTripApprovals.map((approval) => (
                <ApprovalRow
                  badge={<span className="dx-approval-badge">{approval.days} day{approval.days === 1 ? "" : "s"}</span>}
                  eyebrow={`${approval.requestNo} · ${approval.stepName}`}
                  key={approval.id}
                  meta={`${approval.requesterCode || "—"} · ${profileLabel(approval.profileType)}`}
                  name={approval.requesterName}
                  onReview={() => setActiveKey(`business-trip:manager:${approval.id}`)}
                  saving={saving}
                />
              ))}
            </>
          ) : null}
          {businessTripHrApprovals.length ? (
            <>
              <header className="dx-approval-section-head">
                <strong>HR finalization</strong>
                <span>{businessTripHrApprovals.length} pending</span>
              </header>
              {businessTripHrApprovals.map((approval) => (
                <ApprovalRow
                  badge={<span className="dx-approval-badge">{approval.days} day{approval.days === 1 ? "" : "s"}</span>}
                  eyebrow={`${approval.requestNo} · Present · Business trip`}
                  key={`hr:${approval.id}`}
                  meta={`${approval.requesterCode || "—"} · ${profileLabel(approval.profileType)}`}
                  name={approval.requesterName}
                  onReview={() => setActiveKey(`business-trip:hr:${approval.id}`)}
                  saving={saving}
                />
              ))}
            </>
          ) : null}
          {!businessTripApprovals.length && !businessTripHrApprovals.length ? (
            <div className="dx-empty"><MapPinned /><strong>No business trip approvals</strong><small>No business-trip steps or HR finalizations in your reporting scope are waiting.</small></div>
          ) : null}
          {(() => {
            const match = activeKey?.match(/^business-trip:(manager|hr):(.+)$/);
            if (!match) return null;
            const [, queue, id] = match;
            const approval = (queue === "hr" ? businessTripHrApprovals : businessTripApprovals).find((item) => item.id === id);
            if (!approval) return null;
            return (
              <ApprovalModal onClose={closeModal} title={approval.requesterName}>
                <ApprovalHead
                  badge={<span className="dx-approval-badge">{approval.days} day{approval.days === 1 ? "" : "s"}</span>}
                  eyebrow={queue === "hr" ? `${approval.requestNo} · Present · Business trip` : `${approval.requestNo} · ${approval.stepName}`}
                  meta={`${approval.requesterCode || "—"} · ${profileLabel(approval.profileType)}`}
                  name={approval.requesterName}
                />
                <dl className="dx-approval-facts">
                  <div><dt>Dates</dt><dd>{displayDate(approval.startDate)}{approval.endDate !== approval.startDate ? ` – ${displayDate(approval.endDate)}` : ""}</dd></div>
                  <div><dt>Reason</dt><dd>{approval.reason}</dd></div>
                  {queue === "hr" && approval.managerName ? <div><dt>Manager</dt><dd>{approval.managerName}{approval.managerNote ? ` · ${approval.managerNote}` : ""}</dd></div> : null}
                </dl>
                <ApprovalJourneyCell journey={approval.journey} submittedAt={approval.requestedAt} submittedBy={approval.requesterName} currentStep={approval.stepName} />
                <TimeOffAttachmentLink attachment={approval.attachment} />
                <ApprovalNote id={`business-trip:${approval.requestId}`} notes={notes} onChange={(value) => setNote(`business-trip:${approval.requestId}`, value)} placeholder="Note for worker (required when returning)" />
                {queue === "hr" ? (
                  <ApprovalToolbar
                    onApprove={() => void act(() => decideBusinessTrip(approval.requestId, "approved", "hr"))}
                    onReject={() => void act(() => decideBusinessTrip(approval.requestId, "rejected", "hr"))}
                    onReturn={() => void act(() => decideBusinessTrip(approval.requestId, "returned", "hr"))}
                    saving={saving}
                  />
                ) : (
                  <ApprovalToolbar
                    onApprove={() => void act(() => decideBusinessTrip(approval.requestId, "approved", "manager"))}
                    onReject={() => void act(() => decideBusinessTrip(approval.requestId, "rejected", "manager"))}
                    onReturn={() => void act(() => decideBusinessTrip(approval.requestId, "returned", "manager"))}
                    saving={saving}
                  />
                )}
              </ApprovalModal>
            );
          })()}
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
              {attendanceApprovals.map((approval) => renderAttendanceRow(approval, "manager"))}
            </>
          ) : null}
          {attendanceHrApprovals.length ? (
            <>
              <header className="dx-approval-section-head">
                <strong>HR finalization</strong>
                <span>{attendanceHrApprovals.length} pending</span>
              </header>
              {attendanceHrApprovals.map((approval) => renderAttendanceRow(approval, "hr"))}
            </>
          ) : null}
          {!attendanceApprovals.length && !attendanceHrApprovals.length ? (
            <div className="dx-empty"><CalendarClock /><strong>No attendance regularizations</strong><small>No manager steps or HR finalizations in your attendance scope are waiting.</small></div>
          ) : null}
          {(() => {
            const match = activeKey?.match(/^attendance:(manager|hr):(.+)$/);
            if (!match) return null;
            const [, queue, id] = match;
            const list = queue === "hr" ? attendanceHrApprovals : attendanceApprovals;
            const approval = list.find((item) => item.id === id);
            return approval ? renderAttendanceCard(approval, queue as "manager" | "hr") : null;
          })()}
        </div>
      ) : null}

      {!loading && section === "rosters" ? (
        <div className="dx-approval-list">
          {rosterSwapApprovals.length ? rosterSwapApprovals.map((approval) => (
            <ApprovalRow
              badge={<span className="dx-approval-badge">Swap</span>}
              eyebrow={`Shift swap · ${displayDate(approval.rosterDate)}`}
              key={`swap:${approval.id}`}
              meta={`${approval.requesterCode || "—"} ↔ ${approval.partnerCode || "—"}`}
              name={`${approval.requesterName} ↔ ${approval.partnerName}`}
              onReview={() => setActiveKey(`roster-swap:${approval.id}`)}
              saving={saving}
            />
          )) : null}
          {rosterApprovals.length ? rosterApprovals.map((approval) => (
            <ApprovalRow
              badge={<span className="dx-approval-badge">Rev {approval.revision}</span>}
              eyebrow={`${approval.stationCode} · ${rosterStageLabel(approval.stageType)}`}
              key={approval.id}
              meta={approval.preview?.status === "ready" ? `${approval.preview.changedCells} changed day${approval.preview.changedCells === 1 ? "" : "s"} · ${approval.preview.affectedPeople} ${approval.preview.affectedPeople === 1 ? "person" : "people"} · Step ${approval.stageNumber}` : `${approval.rowCount} roster cell${approval.rowCount === 1 ? "" : "s"} · Step ${approval.stageNumber}`}
              name={approval.name || `${approval.stationName || approval.stationCode} weekly roster`}
              onReview={() => setActiveKey(`roster:${approval.id}`)}
              saving={saving}
            />
          )) : null}
          {returnedRosters.length ? returnedRosters.map((item) => (
            <ApprovalRow
              badge={<span className="dx-approval-badge status-returned">Returned</span>}
              eyebrow={`${item.stationCode} · v${item.revisionNo}`}
              key={item.planId}
              meta={`Updated ${dateTime(item.updatedAt)} · edit shifts here, then resubmit`}
              name={item.name || `${item.stationName || item.stationCode} weekly roster`}
              onReview={() => setActiveKey(`roster-returned:${item.planId}`)}
              saving={saving}
            />
          )) : null}
          {!rosterSwapApprovals.length && !rosterApprovals.length && !returnedRosters.length ? (
            <div className="dx-empty"><ArrowLeftRight /><strong>No roster approvals</strong><small>Shift swaps and weekly roster changes assigned to you will appear here.</small></div>
          ) : null}
          {(() => {
            const swapId = activeKey?.match(/^roster-swap:(.+)$/)?.[1];
            const approval = swapId ? rosterSwapApprovals.find((item) => item.id === swapId) : undefined;
            if (!approval) return null;
            return (
              <ApprovalModal onClose={closeModal} title={`${approval.requesterName} ↔ ${approval.partnerName}`}>
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
                <ApprovalJourneyCell journey={approval.journey} submittedAt={approval.requestedAt} submittedBy={approval.requesterName} currentStep="Manager approval" />
                <ApprovalNote id={approval.id} notes={notes} onChange={(value) => setNote(approval.id, value)} placeholder="Note for colleagues (optional)" />
                <ApprovalToolbar
                  onApprove={() => void act(() => decideRosterSwap(approval.id, "approved"))}
                  onReject={() => void act(() => decideRosterSwap(approval.id, "rejected"))}
                  saving={saving}
                  showReturn={false}
                />
              </ApprovalModal>
            );
          })()}
          {(() => {
            const rosterId = activeKey?.match(/^roster:(.+)$/)?.[1];
            const approval = rosterId ? rosterApprovals.find((item) => item.id === rosterId) : undefined;
            if (!approval) return null;
            return (
              <ApprovalModal onClose={closeModal} title={approval.name || `${approval.stationName || approval.stationCode} weekly roster`} wide>
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
                <ApprovalJourneyCell journey={approval.journey} submittedAt={approval.submittedAt} submittedBy={approval.journey?.submittedBy || "Roster owner"} currentStep={rosterStageLabel(approval.stageType)} />
                <RosterApprovalPreview approval={approval} />
                <ApprovalNote
                  id={approval.id}
                  notes={notes}
                  onChange={(value) => setNote(approval.id, value)}
                  placeholder="Required when returning or rejecting"
                />
                <ApprovalToolbar
                  onApprove={() => void act(() => decideRoster(approval, "approved"))}
                  onReject={() => void act(() => decideRoster(approval, "rejected"))}
                  onReturn={() => void act(() => decideRoster(approval, "returned"))}
                  approveDisabled={!approval.preview || approval.preview.status !== "ready"}
                  saving={saving}
                />
              </ApprovalModal>
            );
          })()}
          {(() => {
            const planId = activeKey?.match(/^roster-returned:(.+)$/)?.[1];
            const item = planId ? returnedRosters.find((entry) => entry.planId === planId) : undefined;
            if (!item) return null;
            return (
              <ApprovalModal onClose={closeModal} title={item.name || `${item.stationName || item.stationCode} weekly roster`}>
                <ApprovalHead
                  badge={<span className="dx-approval-badge status-returned">Returned</span>}
                  eyebrow={`${item.stationCode} · v${item.revisionNo}`}
                  meta={`Updated ${dateTime(item.updatedAt)} · edit shifts here, then resubmit`}
                  name={item.name || `${item.stationName || item.stationCode} weekly roster`}
                />
                <dl className="dx-approval-facts">
                  <div><dt>Week</dt><dd>{displayDate(item.periodStart)} – {displayDate(item.periodEnd)}</dd></div>
                  <div><dt>Return note</dt><dd>{item.returnedNote || "No note provided"}</dd></div>
                </dl>
                <ApprovalNote
                  id={item.planId}
                  notes={notes}
                  onChange={(value) => setNote(item.planId, value)}
                  placeholder="Optional resubmit note for approvers"
                />
                <div className="dx-approval-toolbar">
                  <button className="toolbar-return" disabled={saving} onClick={() => setEditingReturnedRosterId(item.planId)} type="button">
                    <CalendarDays />Edit shifts
                  </button>
                  <button className="toolbar-approve" disabled={saving} onClick={() => void act(() => resubmitReturnedRoster(item.planId))} type="button">
                    <Check />Send for approval
                  </button>
                </div>
                {editingReturnedRosterId === item.planId ? <ConnectReturnedRosterEditor account={account} planId={item.planId} onClose={() => { setEditingReturnedRosterId(null); void load(); }} /> : null}
              </ApprovalModal>
            );
          })()}
        </div>
      ) : null}

      {!loading && section === "location-integrity" ? (
        <div className="dx-approval-list">
          {supportPackages.length ? supportPackages.map((item) => (
            <ApprovalRow
              badge={<span className={`dx-approval-badge status-${item.status}`}>{statusLabel(item.status)}</span>}
              eyebrow={`Location check · ${displayDate(item.punchDate)}`}
              key={item.id}
              meta={`${item.workerCode || "—"} · ${profileLabel(item.profileType)}`}
              name={item.workerName}
              onReview={() => setActiveKey(`location:${item.id}`)}
              saving={saving}
            />
          )) : (
            <div className="dx-empty"><LocateFixed /><strong>No location checks</strong><small>No support packages from your {scopeName} are waiting.</small></div>
          )}
          {(() => {
            const id = activeKey?.match(/^location:(.+)$/)?.[1];
            const item = id ? supportPackages.find((entry) => entry.id === id) : undefined;
            if (!item) return null;
            return (
              <ApprovalModal onClose={closeModal} title={item.workerName}>
                <ApprovalHead
                  badge={<span className={`dx-approval-badge status-${item.status}`}>{statusLabel(item.status)}</span>}
                  eyebrow={`Location check · ${displayDate(item.punchDate)}`}
                  meta={`${item.workerCode || "—"} · ${profileLabel(item.profileType)}`}
                  name={item.workerName}
                />
                <div className="dx-approval-evidence">
                  {item.selfieUrl ? (
                    <ConnectAttachmentViewer
                      files={[{ label: "Support selfie", url: item.selfieUrl }]}
                      title={`${item.workerName} · Support selfie`}
                      trigger={<span className="dx-approval-evidence-photo" aria-label="View support selfie"><img alt="" src={item.selfieUrl} /><Camera /></span>}
                    />
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
                <ApprovalJourneyCell journey={item.journey} submittedAt={item.receivedAt} submittedBy={item.workerName} currentStep="Location review" />
                <ApprovalNote id={item.id} notes={notes} onChange={(value) => setNote(item.id, value)} placeholder="Note for worker (optional)" />
                <ApprovalToolbar
                  onApprove={() => void act(() => decideSupportPackage(item.id, "approved"))}
                  onReject={() => void act(() => decideSupportPackage(item.id, "rejected"))}
                  onReturn={() => void act(() => decideSupportPackage(item.id, "returned"))}
                  saving={saving}
                />
              </ApprovalModal>
            );
          })()}
        </div>
      ) : null}

      {!loading && section === "pay-advances" ? (
        <div className="dx-approval-list">
          {payAdvanceApprovals.map(approval => <ApprovalRow key={approval.id}
            badge={<span className="dx-approval-badge">{money(approval.requestedAmount)}</span>}
            eyebrow={`${approval.requestNumber} · ${approval.stepName}`} name={approval.workerName}
            meta={approval.workerCode || "Pay advance"} saving={saving}
            onReview={() => { setPayAdvanceError(""); setActiveKey(`pay-advance:${approval.id}`); }} />)}
          {!payAdvanceApprovals.length ? <div className="dx-empty"><Clock3 /><strong>No pay advances waiting</strong><small>No pay advance approval steps are assigned to you right now.</small></div> : null}
          {(() => {
            const approval = payAdvanceApprovals.find(item => activeKey === `pay-advance:${item.id}`);
            if (!approval) return null;
            return <ApprovalModal onClose={closeModal} title={approval.workerName}>
              <ApprovalHead eyebrow={`Pay advance · ${approval.stepName}`} name={approval.workerName}
                meta={`${approval.requestNumber} · ${approval.workerCode}`} badge={<span className="dx-approval-badge">{money(approval.requestedAmount)}</span>} />
              <dl className="dx-approval-facts">
                <div><dt>Requested amount</dt><dd>{money(approval.requestedAmount)}</dd></div>
                {approval.approvedAmount != null ? <div><dt>Amount from previous review</dt><dd>{money(approval.approvedAmount)}</dd></div> : null}
                <div><dt>Recovery</dt><dd>{statusLabel(approval.recoveryMode)}{approval.recoveryMode === "installments" ? ` · ${approval.installments} installments` : ""}</dd></div>
                {approval.neededBy ? <div><dt>Needed by</dt><dd>{displayDate(approval.neededBy)}</dd></div> : null}
                <div><dt>Reason</dt><dd>{approval.reason}</dd></div>
              </dl>
              {approval.stepType === "finance" ? <div className="dx-approval-finance-terms">
                <label className="dx-approval-note-field">Approved amount
                  <input aria-label="Approved amount" type="number" min="0.01" step="0.01" max={approval.requestedAmount}
                    value={payAdvanceTerms[approval.id]?.amount ?? approval.approvedAmount ?? approval.requestedAmount}
                    onChange={event => setPayAdvanceTerms(current => ({ ...current, [approval.id]: { amount: event.target.value, installments: current[approval.id]?.installments ?? String(approval.installments) } }))} />
                </label>
                <label className="dx-approval-note-field">Recovery installments
                  <input aria-label="Recovery installments" type="number" min="1" max="12" step="1"
                    value={payAdvanceTerms[approval.id]?.installments ?? approval.installments}
                    onChange={event => setPayAdvanceTerms(current => ({ ...current, [approval.id]: { amount: current[approval.id]?.amount ?? String(approval.approvedAmount ?? approval.requestedAmount), installments: event.target.value } }))} />
                </label>
              </div> : null}
              <ApprovalNote id={approval.id} notes={notes} onChange={value => setNote(approval.id, value)} placeholder="Add a reason when rejecting" />
              {payAdvanceError ? <p className="dx-error" role="alert">{payAdvanceError}</p> : null}
              <ApprovalToolbar saving={saving} showReturn={false}
                onApprove={() => void decidePayAdvance(approval, "approved")}
                onReject={() => void decidePayAdvance(approval, "rejected")} />
            </ApprovalModal>;
          })()}
        </div>
      ) : null}

      {!loading && section === "payments" ? (
        <div className="dx-approval-list">
          {paymentApprovals.map(approval => <ApprovalRow key={approval.id}
            badge={<span className="dx-approval-badge">{money(approval.amountRequested ?? approval.amount)}</span>}
            eyebrow={`${approval.requestNo} · ${approval.paymentHeadName}`} name={approval.requesterName || "Team member"}
            meta={approval.locationCode || "Payment request"} saving={saving}
            onReview={() => { setError(""); setActiveKey(`payment:${approval.id}`); }} />)}
          {!paymentApprovals.length ? <div className="dx-empty"><Clock3 /><strong>No payments waiting</strong><small>No payment requests are assigned to you right now.</small></div> : null}
          {(() => {
            const approval = paymentApprovals.find(item => activeKey === `payment:${item.id}`);
            if (!approval) return null;
            return <ApprovalModal onClose={closeModal} title={approval.requesterName || "Payment request"}>
              <ApprovalHead eyebrow={`Payment · ${approval.paymentHeadName}`} name={approval.requesterName || "Team member"}
                meta={`${approval.requestNo} · ${approval.locationCode || "-"}`} badge={<span className="dx-approval-badge">{money(approval.amountRequested ?? approval.amount)}</span>} />
              <dl className="dx-approval-facts">
                <div><dt>Amount</dt><dd>{money(approval.amountRequested ?? approval.amount)}</dd></div>
                <div><dt>Location</dt><dd>{approval.locationCode || "-"}</dd></div>
                <div><dt>Payment head</dt><dd>{approval.paymentHeadName}</dd></div>
                {approval.remarks ? <div><dt>Remarks</dt><dd>{approval.remarks}</dd></div> : null}
                {approval.attachmentCount ? <div><dt>Attachments</dt><dd>{approval.attachmentCount} file{approval.attachmentCount === 1 ? "" : "s"} - view in Ops for details</dd></div> : null}
              </dl>
              <ApprovalNote id={approval.id} notes={notes} onChange={value => setNote(approval.id, value)} placeholder="Add remarks (required for return or reject)" />
              <ApprovalToolbar saving={saving}
                onApprove={() => void decidePayment(approval.id, "approved")}
                onReturn={() => void decidePayment(approval.id, "returned")}
                onReject={() => void decidePayment(approval.id, "rejected")} />
            </ApprovalModal>;
          })()}
        </div>
      ) : null}

      {!loading && section === "reimbursements" ? (
        <div className="dx-approval-list">
          {preRequestApprovals.map((approval) => (
            <ApprovalRow
              badge={<span className="dx-approval-badge">{approval.request.estimated_amount != null ? money(approval.request.estimated_amount) : "Request"}</span>}
              eyebrow={`${approval.request.request_no} · Pre-request · ${statusLabel(approval.assignee_role)}`}
              key={`pre-${approval.id}`}
              meta={approval.request.requesterCode || "—"}
              name={approval.request.requesterName}
              onReview={() => setActiveKey(`reimbursement-pre:${approval.request.id}`)}
              saving={saving}
            />
          ))}
          {reimbursements.map((approval) => (
            <ApprovalRow
              badge={<span className="dx-approval-badge">{money(approval.claim.total_claimed)}</span>}
              eyebrow={`${approval.claim.claim_no} · Claim · ${approval.step_name}`}
              key={approval.id}
              meta={approval.claim.purpose}
              name={approval.claim.requesterName}
              onReview={() => setActiveKey(`reimbursement-claim:${approval.claim.id}`)}
              saving={saving}
            />
          ))}
          {expenseOversight.length ? <section className="dx-expense-oversight">
            <header><span><strong>Organisation reimbursement visibility</strong><small>Read-only access · approval is available only when you are the assigned reporting-manager layer.</small></span><em>{expenseOversight.length} recent</em></header>
            <div>
              {expenseOversight.map((claim) => <ApprovalRow
                badge={<span className="dx-approval-badge">{money(claim.total_approved ?? claim.total_claimed)}</span>}
                eyebrow={`${claim.claim_no} · ${statusLabel(claim.status)}`}
                key={`oversight-${claim.id}`}
                meta={`${claim.requesterCode || "—"} · ${claim.purpose}`}
                name={claim.requesterName}
                onReview={() => void openExpenseOversight(claim.id)}
                saving={saving || expenseOversightLoadingId === claim.id}
              />)}
            </div>
          </section> : null}
          {preRequestOversight.length ? <section className="dx-expense-oversight">
            <header><span><strong>All team · pre-request visibility</strong><small>Read-only here · approval happens only when you are this requester's reporting manager.</small></span><em>{preRequestOversight.length} recent</em></header>
            <div>
              {preRequestOversight.map((request) => <ApprovalRow
                badge={<span className="dx-approval-badge">{request.estimated_amount != null ? money(request.estimated_amount) : "Request"}</span>}
                eyebrow={`${request.request_no} · Pre-request · ${statusLabel(request.status)}`}
                key={`pre-oversight-${request.id}`}
                meta={`${request.requesterCode || "—"} · ${request.purpose}`}
                name={request.requesterName}
                readOnly
                saving={saving}
              />)}
            </div>
          </section> : null}
          {!preRequestApprovals.length && !reimbursements.length && !expenseOversight.length && !preRequestOversight.length ? (
            <div className="dx-empty"><Clock3 /><strong>No reimbursements waiting</strong><small>No reimbursement requests or claims are assigned to you right now.</small></div>
          ) : null}
          {(() => {
            const id = activeKey?.match(/^reimbursement-pre:(.+)$/)?.[1];
            const approval = id ? preRequestApprovals.find((entry) => entry.request.id === id) : undefined;
            if (!approval) return null;
            return (
              <ApprovalModal onClose={closeModal} title={approval.request.requesterName}>
                <ApprovalHead
                  badge={<span className="dx-approval-badge">{approval.request.estimated_amount != null ? money(approval.request.estimated_amount) : "Request"}</span>}
                  eyebrow={`${approval.request.request_no} · Pre-request · ${statusLabel(approval.assignee_role)}`}
                  meta={approval.request.requesterCode || "—"}
                  name={approval.request.requesterName}
                />
                <dl className="dx-approval-facts">
                  <div><dt>Purpose</dt><dd>{approval.request.purpose}</dd></div>
                  {(approval.request.trip_from || approval.request.trip_to) ? (
                    <div><dt>Dates</dt><dd>{approval.request.trip_from || "—"} → {approval.request.trip_to || "—"}</dd></div>
                  ) : null}
                  {approval.request.notes ? <div><dt>Notes</dt><dd>{approval.request.notes}</dd></div> : null}
                </dl>
                <ApprovalJourneyCell journey={approval.journey} submittedAt={approval.request.created_at} submittedBy={approval.request.requesterName} currentStep={statusLabel(approval.assignee_role)} />
                <ApprovalNote id={`pre:${approval.request.id}`} notes={notes} onChange={(value) => setNote(`pre:${approval.request.id}`, value)} placeholder="Required when rejecting" />
                <ApprovalToolbar
                  onApprove={() => void act(() => decidePreRequest(approval.request.id, "approved"))}
                  onReject={() => void act(() => decidePreRequest(approval.request.id, "rejected"))}
                  saving={saving}
                  showReturn={false}
                />
              </ApprovalModal>
            );
          })()}
          {(() => {
            const id = activeKey?.match(/^reimbursement-claim:(.+)$/)?.[1];
            const approval = id ? reimbursements.find((entry) => entry.claim.id === id) : undefined;
            if (!approval) return null;
            const financeReview = approval.stage_code === "finance" || approval.step_name === "Finance approval";
            const items = approval.claim.hr_expense_items ?? [];
            const payableTotal = items.reduce((sum, item) => sum + Number(item.finance_policy_snapshot?.eligible_amount ?? item.amount), 0);
            const cappedCount = items.filter((item) => item.finance_policy_snapshot?.excess_action === "cap" && Number(item.finance_policy_snapshot.excess_amount) > 0).length;
            const exceptionCount = items.filter((item) => item.finance_policy_snapshot?.excess_action === "special_approval" && Number(item.finance_policy_snapshot.excess_amount) > 0).length;
            return (
              <ApprovalModal onClose={closeModal} title={approval.claim.requesterName} wide={financeReview}>
                <ApprovalHead
                  badge={<span className="dx-approval-badge">{money(approval.claim.total_claimed)}</span>}
                  eyebrow={`${approval.claim.claim_no} · Claim · ${approval.step_name}`}
                  meta={approval.claim.purpose}
                  name={approval.claim.requesterName}
                />
                {financeReview ? <section className="dx-finance-review">
                  <header>
                    <span><small>Claimed</small><strong>{money(approval.claim.total_claimed)}</strong></span>
                    <span><small>Policy payable</small><strong>{money(payableTotal)}</strong></span>
                    <span className={cappedCount ? "warning" : ""}><small>Capped lines</small><strong>{cappedCount}</strong></span>
                    <span className={exceptionCount ? "danger" : ""}><small>Exceptions</small><strong>{exceptionCount}</strong></span>
                  </header>
                  <div className="dx-finance-review-table" role="table" aria-label="Finance policy review by expense head">
                    <div className="head" role="row"><span>Expense head</span><span>Claimed</span><span>Policy rule</span><span>Payable</span><span>Assessment</span></div>
                    {items.map((item) => {
                      const quote = item.finance_policy_snapshot;
                      const state = expensePolicyState(quote);
                      return <div className="row" key={item.id} role="row">
                        <span><b>{first(item.hr_expense_categories)?.name ?? "Expense"}</b><small>{displayDate(item.expense_date)}{item.merchant ? ` · ${item.merchant}` : ""}</small>{item.description ? <small>{item.description}</small> : null}</span>
                        <span data-label="Claimed">{money(item.amount)}</span>
                        <span data-label="Policy rule">{quote?.limit_amount == null ? "Not set" : `${money(quote.limit_amount)} ${quote.limit_basis === "per_day" ? "/ day" : quote.limit_basis === "per_km" ? "/ km" : "/ item"}`}</span>
                        <span data-label="Payable"><b>{money(quote?.eligible_amount ?? item.amount)}</b></span>
                        <span data-label="Assessment"><em className={state.tone}>{state.label}</em>{quote?.policy_note ? <small title={quote.policy_note}>{quote.policy_note}</small> : null}</span>
                      </div>;
                    })}
                  </div>
                  <p>Finance must verify the receipt, expense head, business-policy limit, eligible payable amount, and exception status before deciding.</p>
                </section> : <dl className="dx-approval-facts">
                  {items.map((item) => (
                    <div key={item.id}><dt>{first(item.hr_expense_categories)?.name ?? "Expense"}</dt><dd>{item.expense_date} · {money(item.amount)}{item.finance_policy_snapshot ? <small>{expensePolicyMessage(item.finance_policy_snapshot)}</small> : null}</dd></div>
                  ))}
                </dl>}
                <dl className="dx-approval-facts">
                  {approval.claim.attachments?.filter((attachment) => attachment.url).map((attachment) => (
                    <div key={attachment.id}>
                      <dt>Receipt pack</dt>
                      <dd>
                        <ConnectAttachmentViewer
                          files={[{ label: attachment.file_name || "Receipt", url: attachment.url as string, fileName: attachment.file_name }]}
                          title={`${approval.claim.requesterName} · ${attachment.file_name || "Receipt"}`}
                          trigger={<><FileText />{attachment.file_name}</>}
                        />
                      </dd>
                    </div>
                  ))}
                </dl>
                <ApprovalJourneyCell journey={approval.journey} submittedAt={approval.claim.submitted_at} submittedBy={approval.claim.requesterName} currentStep={approval.step_name} />
                <ApprovalNote id={approval.claim.id} notes={notes} onChange={(value) => setNote(approval.claim.id, value)} placeholder={financeReview && exceptionCount ? "Required: record the policy-exception decision" : approval.step_name.includes("Policy excess") ? "Required: reason for approving this excess" : "Required when returning or rejecting"} />
                <ApprovalToolbar
                  onApprove={() => void act(() => decideReimbursement(approval.claim.id, "approved"))}
                  onReject={() => void act(() => decideReimbursement(approval.claim.id, "rejected"))}
                  onReturn={() => void act(() => decideReimbursement(approval.claim.id, "returned"))}
                  saving={saving}
                />
              </ApprovalModal>
            );
          })()}
          {(() => {
            const claimId = activeKey?.match(/^reimbursement-oversight:(.+)$/)?.[1];
            const claim = claimId && expenseOversightDetail?.id === claimId ? expenseOversightDetail : null;
            if (!claim) return null;
            return <ApprovalModal onClose={closeModal} title={claim.requesterName} wide>
              <ApprovalHead
                badge={<span className="dx-approval-badge">{money(claim.total_approved ?? claim.total_claimed)}</span>}
                eyebrow={`${claim.claim_no} · Read-only visibility`}
                meta={`${claim.requesterCode || "—"} · ${claim.purpose}`}
                name={claim.requesterName}
              />
              <div className="dx-oversight-status"><span><small>Status</small><strong>{statusLabel(claim.status)}</strong></span><span><small>Submitted</small><strong>{dateTime(claim.submitted_at ?? null)}</strong></span><span><small>Claimed</small><strong>{money(claim.total_claimed)}</strong></span><span><small>Approved / payable</small><strong>{claim.total_approved == null ? "Pending" : money(claim.total_approved)}</strong></span></div>
              <dl className="dx-approval-facts">
                {claim.items.map((item) => <div key={item.id}><dt>{first(item.hr_expense_categories)?.name ?? "Expense"}</dt><dd>{displayDate(item.expense_date)} · {money(item.amount)}{item.finance_policy_snapshot ? <small>{expensePolicyMessage(item.finance_policy_snapshot)}</small> : null}</dd></div>)}
                {claim.attachments.filter((attachment) => attachment.url).map((attachment) => <div key={attachment.id}><dt>Receipt</dt><dd><ConnectAttachmentViewer files={[{ label: attachment.file_name || "Receipt", url: attachment.url as string, fileName: attachment.file_name }]} title={`${claim.requesterName} · ${attachment.file_name || "Receipt"}`} trigger={<><FileText />{attachment.file_name}</>} /></dd></div>)}
              </dl>
              <section className="dx-oversight-route">
                <h3>Approval route</h3>
                {claim.steps.map((step) => <div key={step.id}><i className={`status-${step.status}`}>{step.status === "approved" ? <Check /> : <Clock3 />}</i><span><strong>{step.approver_name} · {step.step_name}</strong><small>{statusLabel(step.status)}{step.decided_at ? ` · ${dateTime(step.decided_at)}` : ""}{step.decision_note ? ` · ${step.decision_note}` : ""}</small></span></div>)}
              </section>
              <p className="dx-approval-inline-note">Visibility does not make you an approver. Actions remain available only to the person assigned to the current step.</p>
            </ApprovalModal>;
          })()}
        </div>
      ) : null}

      {!loading && section === "exits" ? (
        <div className="dx-approval-list">
          {exitWithdrawalApprovals.map((approval) => (
            <ApprovalRow
              badge={<span className="dx-approval-badge">Withdraw</span>}
              eyebrow={`${approval.caseNumber} · Withdrawal review`}
              key={`exit-withdraw:${approval.caseId}`}
              meta={`${approval.requesterCode || "—"} · ${profileLabel(approval.profileType)}`}
              name={approval.requesterName}
              approveLabel="Accept withdrawal"
              onReview={() => setActiveKey(`exit-withdraw:${approval.caseId}`)}
              saving={saving}
            />
          ))}
          {exitApprovals.map((approval) => (
            <ApprovalRow
              badge={<span className="dx-approval-badge">Step {approval.stepOrder}</span>}
              eyebrow={`${approval.caseNumber} · ${approval.stepName}`}
              key={approval.id}
              meta={`${approval.requesterCode || "—"} · ${profileLabel(approval.profileType)}`}
              name={approval.requesterName}
              onReview={() => setActiveKey(`exit:${approval.id}`)}
              saving={saving}
            />
          ))}
          {!exitApprovals.length && !exitWithdrawalApprovals.length ? (
            <div className="dx-empty"><DoorOpen /><strong>No exit approvals</strong><small>Exit and withdrawal steps assigned to you will appear here.</small></div>
          ) : null}
          {(() => {
            const caseId = activeKey?.match(/^exit-withdraw:(.+)$/)?.[1];
            const approval = caseId ? exitWithdrawalApprovals.find((entry) => entry.caseId === caseId) : undefined;
            if (!approval) return null;
            return (
              <ApprovalModal onClose={closeModal} title={approval.requesterName}>
                <ApprovalHead
                  badge={<span className="dx-approval-badge">Withdraw</span>}
                  eyebrow={`${approval.caseNumber} · Withdrawal review`}
                  meta={`${approval.requesterCode || "—"} · ${profileLabel(approval.profileType)}`}
                  name={approval.requesterName}
                />
                <dl className="dx-approval-facts">
                  <div><dt>Last working day</dt><dd>{displayDate(approval.requestedLastWorkingDate)}</dd></div>
                  <div><dt>Exit reason</dt><dd>{approval.reason}</dd></div>
                  <div><dt>Requested</dt><dd>{dateTime(approval.requestedAt)}</dd></div>
                </dl>
                <ApprovalJourneyCell journey={approval.journey} submittedAt={approval.requestedAt} submittedBy={approval.requesterName} currentStep="Withdrawal review" />
                <ApprovalNote id={`exit-withdraw:${approval.caseId}`} notes={notes} onChange={(value) => setNote(`exit-withdraw:${approval.caseId}`, value)} placeholder="Required when keeping the exit open" />
                <ApprovalToolbar
                  approveLabel="Accept withdrawal"
                  onApprove={() => void act(() => decideExitWithdrawal(approval.caseId, "approved"))}
                  onReject={() => void act(() => decideExitWithdrawal(approval.caseId, "rejected"))}
                  rejectLabel="Keep exit open"
                  saving={saving}
                  showReturn={false}
                />
              </ApprovalModal>
            );
          })()}
          {(() => {
            const id = activeKey?.match(/^exit:(.+)$/)?.[1];
            const approval = id ? exitApprovals.find((entry) => entry.id === id) : undefined;
            if (!approval) return null;
            return (
              <ApprovalModal onClose={closeModal} title={approval.requesterName}>
                <ApprovalHead
                  badge={<span className="dx-approval-badge">Step {approval.stepOrder}</span>}
                  eyebrow={`${approval.caseNumber} · ${approval.stepName}`}
                  meta={`${approval.requesterCode || "—"} · ${profileLabel(approval.profileType)}`}
                  name={approval.requesterName}
                />
                <dl className="dx-approval-facts">
                  <div><dt>Last working day</dt><dd>{displayDate(approval.requestedLastWorkingDate)}</dd></div>
                  <div><dt>Reason</dt><dd>{approval.reason}</dd></div>
                  <div><dt>Submitted</dt><dd>{dateTime(approval.submittedAt)}</dd></div>
                </dl>
                <ApprovalJourneyCell journey={approval.journey} submittedAt={approval.submittedAt} submittedBy={approval.requesterName} currentStep={approval.stepName} />
                <ApprovalNote id={`exit:${approval.id}`} notes={notes} onChange={(value) => setNote(`exit:${approval.id}`, value)} placeholder="Required when rejecting" />
                <ApprovalToolbar
                  onApprove={() => void act(() => decideExit(approval.id, "approved"))}
                  onReject={() => void act(() => decideExit(approval.id, "rejected"))}
                  saving={saving}
                  showReturn={false}
                />
              </ApprovalModal>
            );
          })()}
        </div>
      ) : null}

      <p className="dx-approval-footnote"><ClipboardCheck /> Only requests you are authorised to review appear here. Open a request to see the details and approval history.</p>
    </section>
  );
}
