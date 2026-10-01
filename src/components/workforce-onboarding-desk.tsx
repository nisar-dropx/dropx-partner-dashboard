"use client";

import { useMemo, useState } from "react";
import { ExternalLink, Search } from "lucide-react";
import { queueAmazonInvitationFromOpsPulse } from "@/app/field-executive/actions";
import { PartnerProgressNote } from "@/components/partner-progress-note";
import { PendingLink } from "@/components/pending-link";
import { StatusPill } from "@/components/status-pill";
import type { FieldExecutiveListRow } from "@/components/field-executive-list";
import {
  workforceNextAction,
  workforceRegistrationLabel,
  type WorkforceRegisterView
} from "@/lib/workforce-onboarding-queues";

type WorkforceDeskRow = FieldExecutiveListRow & {
  onboardingStatus?: string | null;
  dateOfJoin?: string | null;
  registrationDraftAt?: string | null;
};

function shortDate(value: string | null | undefined) {
  if (!value) return "—";
  const parsed = new Date(`${value.length === 10 ? `${value}T00:00:00` : value}`);
  if (Number.isNaN(parsed.getTime())) return "—";
  return new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" }).format(parsed);
}

function workflowTone(row: WorkforceDeskRow) {
  const stage = row.partnerOnboarding?.stage;
  if (stage === "active") return "good";
  if (stage === "exception" || stage === "invitation_failed" || row.partnerOnboarding?.due_kind) return "bad";
  if (stage === "registration_pending") return "warn";
  return "neutral";
}

function stageLabel(row: WorkforceDeskRow) {
  const state = row.partnerOnboarding;
  if (!state) return workforceRegistrationLabel(row);
  if (!state.reported_on) return "Training not started";
  return state.label;
}

function latestActivity(row: WorkforceDeskRow) {
  const state = row.partnerOnboarding;
  if (row.registrationDraftAt && !state?.registration_ready) return `In-app draft · ${shortDate(row.registrationDraftAt)}`;
  if (state?.invited_on) return `Amazon invite sent · ${shortDate(state.invited_on)}`;
  if (state?.reported_on) return `Reported · ${shortDate(state.reported_on)}`;
  return `Joining date · ${shortDate(row.dateOfJoin)}`;
}

function Journey({ row }: { row: WorkforceDeskRow }) {
  const state = row.partnerOnboarding;
  const registrationDone = Boolean(state?.registration_ready);
  const amazonDone = Boolean(state?.mapping_confirmed);
  return (
    <div className="workforce-journey" aria-label="Onboarding journey">
      <span className={state?.reported_on ? "done" : "current"}>Training</span>
      <span className={registrationDone ? "done" : !state?.reported_on ? "" : "current"}>Registration</span>
      <span className={amazonDone ? "done" : registrationDone ? "current" : ""}>Amazon ID</span>
      <span className={amazonDone ? "done" : ""}>Active</span>
    </div>
  );
}

export function WorkforceOnboardingDesk({
  basePath,
  canEdit,
  emptyLabel,
  rows,
  title,
  view
}: {
  basePath: string;
  canEdit: boolean;
  emptyLabel: string;
  rows: WorkforceDeskRow[];
  title: string;
  view: WorkforceRegisterView;
}) {
  const [query, setQuery] = useState("");
  const [station, setStation] = useState("");
  const stations = useMemo(() => [...new Set(rows.map((row) => row.location).filter((value) => value && value !== "-"))].sort(), [rows]);
  const visibleRows = useMemo(() => {
    const text = query.trim().toLowerCase();
    return rows.filter((row) => {
      const matchesText = !text || [row.fullName, row.dropxId, row.location, row.designation, row.email]
        .join(" ").toLowerCase().includes(text);
      return matchesText && (!station || row.location === station);
    });
  }, [query, rows, station]);

  return (
    <section className="panel workforce-onboarding-desk">
      <div className="panel-head workforce-onboarding-desk-head">
        <div>
          <h2>{title}</h2>
          <p className="subtle">One next action per associate. Open the profile only when more detail is needed.</p>
        </div>
        <div className="workforce-desk-filters">
          <label className="workforce-desk-search"><Search size={16} aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search associate, ID or station" /></label>
          <select aria-label="Filter by station" value={station} onChange={(event) => setStation(event.target.value)}>
            <option value="">All stations</option>
            {stations.map((code) => <option key={code} value={code}>{code}</option>)}
          </select>
        </div>
      </div>
      <div className="table-wrap workforce-onboarding-table-wrap">
        <table className="workforce-onboarding-table">
          <thead><tr><th>Associate</th><th>Station</th><th>Journey</th><th>Next action</th><th>Last activity</th><th>Action</th></tr></thead>
          <tbody>
            {visibleRows.map((row) => {
              const state = row.partnerOnboarding;
              const canQueue = Boolean(canEdit && row.canQueueAmazonId);
              return <tr key={row.id}>
                <td><strong>{row.fullName}</strong><small>{row.dropxId === "-" ? "DropX ID pending" : row.dropxId} · {row.designation}</small></td>
                <td><strong>{row.location}</strong><small>{row.provider !== "-" ? row.provider : "Provider not mapped"}</small></td>
                <td><Journey row={row} /><StatusPill status={stageLabel(row)} tone={workflowTone(row)} /></td>
                <td className="workforce-next-action"><strong>{workforceNextAction(row)}</strong>{state?.due_kind ? <small className="workforce-attention-note">Follow-up due {shortDate(state.due_since)}</small> : null}</td>
                <td><small>{latestActivity(row)}</small></td>
                <td className="workforce-onboarding-actions">
                  {canQueue ? <form action={queueAmazonInvitationFromOpsPulse}><input name="workforce_id" type="hidden" value={row.id} /><input name="return_status" type="hidden" value={view} /><button className="button compact" type="submit">Queue Amazon invite</button></form> : null}
                  {state && canEdit && !state.mapping_confirmed ? <PartnerProgressNote state={state} workforceId={row.id} returnStatus={view} canEdit /> : null}
                  <PendingLink className="button secondary compact" href={`${basePath}?view=${row.id}&status=${view}`} scroll={false}>View <ExternalLink size={14} aria-hidden="true" /></PendingLink>
                </td>
              </tr>;
            })}
            {!visibleRows.length ? <tr><td className="empty-cell" colSpan={6}>{emptyLabel}</td></tr> : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
