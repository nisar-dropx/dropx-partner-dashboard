"use client";

import { ArrowLeftRight, CalendarClock, CalendarDays, Check, ChevronLeft, ChevronRight, ClipboardList, DoorOpen, FileText, LocateFixed, ReceiptText, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { AppAccount } from "./connect-profile-app";

type RequestKind = "attendance" | "location_flag" | "leave" | "reimbursement" | "roster_swap" | "exit";

type StepTrail = { name: string; status: string; note?: string | null };

type UnifiedRequest = {
  id: string;
  kind: RequestKind;
  title: string;
  eyebrow: string;
  submittedAt: string;
  status: string;
  facts: Array<{ label: string; value: string }>;
  steps: StepTrail[];
};

function displayDate(value: string) {
  if (!value) return "—";
  const isoDate = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(isoDate) ? isoDate.split("-").reverse().join("/") : value;
}
function dateTime(value: string | null | undefined) {
  return value ? new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }).format(new Date(value)) : "—";
}
function statusLabel(status: string) {
  return status.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
function statusBadgeClass(status: string) {
  if (["approved", "fulfilled", "completed", "accepted"].includes(status)) return "status-approved";
  if (["rejected", "cancelled", "withdrawn"].includes(status)) return "status-rejected";
  if (status === "returned") return "status-returned";
  return "status-pending";
}
function money(value: number | null | undefined) {
  return `₹${Number(value ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}
function reviewNoteLabel(status: string) {
  if (status === "returned") return "Return reason";
  if (status === "rejected") return "Rejection reason";
  return "Reviewer note";
}
function currentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}
function monthLabel(value: string) {
  const [year, month] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("en", { month: "long", year: "numeric" }).format(new Date(year, month - 1, 1));
}
function shiftMonth(value: string, amount: number) {
  const [year, month] = value.split("-").map(Number);
  const next = new Date(year, month - 1 + amount, 1);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`;
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

const kindMeta: Record<RequestKind, { label: string; icon: ReactNode }> = {
  attendance: { label: "Attendance", icon: <CalendarClock /> },
  location_flag: { label: "Location check", icon: <LocateFixed /> },
  leave: { label: "Time off", icon: <CalendarDays /> },
  reimbursement: { label: "Reimbursement", icon: <ReceiptText /> },
  roster_swap: { label: "Shift swap", icon: <ArrowLeftRight /> },
  exit: { label: "Exit", icon: <DoorOpen /> }
};

async function safeJson(response: Response) {
  try { return await response.json(); } catch { return null; }
}

export function ConnectMyRequests({ account }: { account: AppAccount }) {
  const [requests, setRequests] = useState<UnifiedRequest[]>([]);
  const [filter, setFilter] = useState<"all" | RequestKind>("all");
  const [month, setMonth] = useState(currentMonthKey());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const query = new URLSearchParams({ accountId: account.id, profileType: account.profileType });
    const [attendanceResult, flagResult, leaveResult, reimbursementResult, rosterResult, exitResult] = await Promise.allSettled([
      // These two are answered locally (not proxied to the dashboard app) so they
      // don't depend on that separate deployment being up to date.
      fetch(`/api/connect/attendance/requests?${query}`, { cache: "no-store" }).then(async (r) => (r.ok ? safeJson(r) : null)),
      fetch(`/api/connect/attendance/flags?${query}`, { cache: "no-store" }).then(async (r) => (r.ok ? safeJson(r) : null)),
      fetch(`/api/connect/leave?${query}`, { cache: "no-store" }).then(async (r) => (r.ok ? safeJson(r) : null)),
      fetch(`/api/connect/reimbursements?${query}`, { cache: "no-store" }).then(async (r) => (r.ok ? safeJson(r) : null)),
      fetch(`/api/connect/roster?${query}`, { cache: "no-store" }).then(async (r) => (r.ok ? safeJson(r) : null)),
      fetch(`/api/connect/exit?${query}`, { cache: "no-store" }).then(async (r) => (r.ok ? safeJson(r) : null))
    ]);

    const unified: UnifiedRequest[] = [];

    const attendance = attendanceResult.status === "fulfilled" ? attendanceResult.value : null;
    for (const item of attendance?.requests ?? []) {
      unified.push({
        id: `attendance:${item.id}`,
        kind: "attendance",
        title: `${displayDate(item.attendanceDate)} attendance correction`,
        eyebrow: regularizationReasonLabel(item.reasonCode),
        submittedAt: item.createdAt,
        status: item.status,
        facts: [
          { label: "Requested IN", value: item.requestedInTime || "—" },
          { label: "Requested OUT", value: item.requestedOutTime || "—" },
          ...(item.reviewRemarks ? [{ label: reviewNoteLabel(item.status), value: item.reviewRemarks }] : [])
        ],
        steps: (item.steps ?? []).map((step: { stepName: string; status: string }) => ({ name: step.stepName, status: step.status }))
      });
    }

    const flags = flagResult.status === "fulfilled" ? flagResult.value : null;
    for (const item of flags?.flags ?? []) {
      unified.push({
        id: `location_flag:${item.id}`,
        kind: "location_flag",
        title: `${displayDate(item.punchDate)} location check`,
        eyebrow: "Punch outside station geofence",
        submittedAt: item.createdAt,
        status: item.status,
        facts: [
          ...(item.remarks ? [{ label: "Note", value: item.remarks }] : []),
          ...(item.reviewRemarks ? [{ label: reviewNoteLabel(item.status), value: item.reviewRemarks }] : [])
        ],
        steps: []
      });
    }

    const leave = leaveResult.status === "fulfilled" ? leaveResult.value : null;
    for (const item of leave?.requests ?? []) {
      unified.push({
        id: `leave:${item.id}`,
        kind: "leave",
        title: `${item.leaveType} – ${item.days} day${item.days === 1 ? "" : "s"}`,
        eyebrow: `${displayDate(item.fromDate)}${item.toDate !== item.fromDate ? ` – ${displayDate(item.toDate)}` : ""}`,
        submittedAt: item.requestedAt,
        status: item.status,
        facts: [
          { label: "Reason", value: item.reason || "—" },
          ...(item.reviewerNote ? [{ label: reviewNoteLabel(item.status), value: item.reviewerNote }] : [])
        ],
        steps: []
      });
    }

    const reimbursement = reimbursementResult.status === "fulfilled" ? reimbursementResult.value : null;
    for (const claim of reimbursement?.claims ?? []) {
      unified.push({
        id: `reimbursement:${claim.id}`,
        kind: "reimbursement",
        title: `${claim.claim_no} – ${money(claim.total_claimed)}`,
        eyebrow: claim.purpose,
        submittedAt: claim.submitted_at ?? claim.created_at,
        status: claim.status,
        facts: [
          ...(claim.return_reason ? [{ label: "Return reason", value: claim.return_reason }] : []),
          ...(claim.rejection_reason ? [{ label: "Rejection reason", value: claim.rejection_reason }] : []),
          ...(claim.payment?.utr_cin ? [{ label: "UTR", value: claim.payment.utr_cin }] : [])
        ],
        steps: (claim.steps ?? []).map((step: { step_name: string; status: string; decision_note?: string | null }) => ({
          name: step.step_name,
          status: step.status,
          note: step.decision_note
        }))
      });
    }

    const roster = rosterResult.status === "fulfilled" ? rosterResult.value : null;
    for (const item of roster?.requests ?? []) {
      if (!item.isRequester) continue;
      unified.push({
        id: `roster_swap:${item.id}`,
        kind: "roster_swap",
        title: `Shift swap – ${displayDate(item.date)}`,
        eyebrow: `With ${item.counterpart?.name || "colleague"}`,
        submittedAt: item.requestedAt,
        status: item.status,
        facts: item.note ? [{ label: "Note", value: item.note }] : [],
        steps: []
      });
    }

    const exit = exitResult.status === "fulfilled" ? exitResult.value : null;
    if (exit?.exitCase) {
      const exitCase = exit.exitCase;
      unified.push({
        id: `exit:case`,
        kind: "exit",
        title: "Exit request",
        eyebrow: exit.destination || "Exit workflow",
        submittedAt: exitCase.submittedAt,
        status: exitCase.status,
        facts: [],
        steps: (exitCase.timeline ?? []).map((item: { title: string; status: string; note?: string | null }) => ({
          name: item.title,
          status: item.status === "completed" ? "approved" : item.status,
          note: item.note
        }))
      });
    }

    unified.sort((left, right) => new Date(right.submittedAt || 0).getTime() - new Date(left.submittedAt || 0).getTime());
    setRequests(unified);
    const failedAll = [attendanceResult, flagResult, leaveResult, reimbursementResult, rosterResult, exitResult].every((result) => result.status === "rejected");
    if (failedAll) setError("Unable to load your requests.");
    setLoading(false);
  }, [account.id, account.profileType]);

  useEffect(() => { void load(); }, [load]);

  const monthRequests = useMemo(
    () => requests.filter((request) => String(request.submittedAt ?? "").slice(0, 7) === month),
    [requests, month]
  );

  const counts = useMemo(() => {
    const tally: Record<string, number> = { all: monthRequests.length };
    for (const request of monthRequests) tally[request.kind] = (tally[request.kind] ?? 0) + 1;
    return tally;
  }, [monthRequests]);

  const visible = filter === "all" ? monthRequests : monthRequests.filter((request) => request.kind === filter);
  const activeKinds = (Object.keys(kindMeta) as RequestKind[]).filter((kind) => counts[kind]);

  return (
    <section className="dx-approval-inbox">
      <header className="dx-page-intro">
        <small>Your submissions</small>
        <h1>My requests</h1>
        <p>Every request you have submitted, with its current status and approval flow.</p>
      </header>
      {error ? <div className="dx-alert error">{error}</div> : null}
      <div aria-label="Choose month" className="dx-requests-month" role="group">
        <button aria-label="Previous month" onClick={() => setMonth((current) => shiftMonth(current, -1))} type="button"><ChevronLeft /></button>
        <strong>{monthLabel(month)}</strong>
        <button aria-label="Next month" disabled={month >= currentMonthKey()} onClick={() => setMonth((current) => shiftMonth(current, 1))} type="button"><ChevronRight /></button>
      </div>
      <nav aria-label="Request type" className="dx-approval-tabs">
        <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")} type="button">
          All<span>{counts.all ?? 0}</span>
        </button>
        {activeKinds.map((kind) => (
          <button className={filter === kind ? "active" : ""} key={kind} onClick={() => setFilter(kind)} type="button">
            {kindMeta[kind].label}<span>{counts[kind] ?? 0}</span>
          </button>
        ))}
      </nav>
      {loading ? <div className="dx-loader"><span /><small>Loading your requests…</small></div> : null}
      {!loading ? (
        <div className="dx-approval-list">
          {visible.length ? visible.map((request) => (
            <article className="dx-approval-card" key={request.id}>
              <div className="dx-approval-card-head">
                <div>
                  <p className="dx-approval-eyebrow">{kindMeta[request.kind].label} · {request.eyebrow}</p>
                  <h2>{request.title}</h2>
                  <p className="dx-approval-sub">Submitted {dateTime(request.submittedAt)}</p>
                </div>
                <span className={`dx-approval-badge ${statusBadgeClass(request.status)}`}>{statusLabel(request.status)}</span>
              </div>
              {request.facts.length ? (
                <dl className="dx-approval-facts">
                  {request.facts.map((fact) => (
                    <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>
                  ))}
                </dl>
              ) : null}
              {request.steps.length ? (
                <div className="dx-expense-timeline">
                  {request.steps.map((step, index) => (
                    <div key={`${request.id}:${index}`}>
                      <i>{step.status === "rejected" ? <X /> : step.status === "pending" ? <ClipboardList /> : <Check />}</i>
                      <span>
                        <strong>{step.name}</strong>
                        <small>{statusLabel(step.status)}{step.note ? ` · ${step.note}` : ""}</small>
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
            </article>
          )) : (
            <div className="dx-empty">
              <FileText />
              <strong>{requests.length ? `No requests in ${monthLabel(month)}` : "No requests yet"}</strong>
              <small>{requests.length
                ? "Try another month, or the All tab, to see other requests."
                : "Leave, attendance corrections, location checks, reimbursements, shift swaps and exit requests you submit will show up here."}</small>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}
