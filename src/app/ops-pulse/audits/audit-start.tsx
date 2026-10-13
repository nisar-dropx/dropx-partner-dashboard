"use client";

import { useState } from "react";
import { SearchableSelect } from "@/components/searchable-select";
import type {
  AuditRequest,
  StationAuditWorkspace,
} from "@/lib/ops-pulse/station-audits";
import { auditDay } from "@/lib/ops-pulse/station-audit-planning";
import {
  decideAuditRequest,
  loadAuditReach,
  requestCrossAudit,
  startStationAudit,
} from "./actions";
import styles from "./audit-workspace.module.css";

const pendingUpdate =
  "Cross-station requests need a database update that has not been applied yet.";
const requestStatus: Record<string, string> = {
  pending: "Waiting for approval",
  approved: "Approved",
  declined: "Declined",
  cancelled: "Withdrawn",
};

/**
 * Starts an audit outside the monthly plan. In the viewer's own stations it begins
 * at once; for any other station it becomes a request, unless the viewer holds a
 * cross-audit role or is approving a request.
 */
export function StartAudit({
  workspace,
  viewerId,
  request,
  defaultTypeId,
  onCreated,
  onRequested,
}: {
  workspace: StationAuditWorkspace;
  viewerId: string;
  /** Set when a manager is approving this cross-station request. */
  request?: AuditRequest;
  defaultTypeId?: string;
  onCreated: (auditId?: string) => void;
  onRequested: () => void;
}) {
  const types = workspace.auditTypes.filter((type) => type.is_active);
  const [other, setOther] = useState(false);
  const [reach, setReach] = useState<{ id: string; label: string }[] | null>(
    null,
  );
  const [stationId, setStationId] = useState(request?.location_id || "");
  const [auditor, setAuditor] = useState(request?.requested_by || viewerId);
  const [later, setLater] = useState(
    Boolean(request?.preferred_date && request.preferred_date > auditDay()),
  );
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const own = new Set(workspace.stations.map((station) => station.id));
  // A manager approving for their own team assigns the person who asked.
  const fixedAuditor = Boolean(request) && !workspace.anyStation;
  const auditors = workspace.assignees
    .filter((p) => workspace.anyStation || p.stationIds.includes(stationId))
    .map((p) => ({
      value: p.id,
      label: p.id === viewerId ? `${p.name} (you)` : p.name,
      helper: p.stationIds.includes(stationId)
        ? p.role
        : `${p.role} · another station’s team`,
    }));
  const showOther = async (next: boolean) => {
    setOther(next);
    setStationId("");
    setNotice("");
    if (!next || reach) return;
    const loaded = await loadAuditReach();
    if (loaded.ok) setReach(loaded.stations.filter((s) => !own.has(s.id)));
    else setNotice(loaded.message);
  };
  const submit = async (data: FormData) => {
    if (pending) return;
    setPending(true);
    try {
      if (other) {
        const result = await requestCrossAudit(data);
        setNotice(result.message);
        if (result.ok) onRequested();
      } else {
        const result = await startStationAudit(data);
        setNotice(result.message);
        if (result.ok) onCreated("auditId" in result ? result.auditId : undefined);
      }
    } catch {
      setNotice("Unable to save. Please try again.");
    } finally {
      setPending(false);
    }
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit(new FormData(event.currentTarget));
      }}
    >
      {request ? (
        <p className={styles.notice}>
          <strong>
            {request.requested_name || "An auditor"} asked to audit{" "}
            {request.station_code}.
          </strong>{" "}
          {request.reason}
          {request.preferred_date
            ? ` · Preferred date ${request.preferred_date}`
            : ""}
        </p>
      ) : (
        <p className={styles.muted}>
          An audit outside the monthly plan. It is recorded as unscheduled and
          does not use a planned slot. The station is not told beforehand.
        </p>
      )}
      {!request && !workspace.anyStation && (
        <div className={styles.typeSwitch} aria-label="Which station">
          <button
            type="button"
            aria-pressed={!other}
            onClick={() => void showOther(false)}
          >
            My stations
          </button>
          <button
            type="button"
            aria-pressed={other}
            onClick={() => void showOther(true)}
          >
            Another station · needs approval
          </button>
        </div>
      )}
      {other && !workspace.programmeSettings.cross_audit_ready && (
        <p role="alert" className={styles.notice}>
          {pendingUpdate}
        </p>
      )}
      <div className={styles.compactForm}>
        {request ? (
          <>
            <input type="hidden" name="request_id" value={request.id} />
            <input type="hidden" name="location_id" value={request.location_id} />
            <input
              type="hidden"
              name="audit_type_id"
              value={request.audit_type_id}
            />
            <div className={styles.inputLabel}>
              Station · audit type
              <strong>
                {request.station_code} ·{" "}
                {types.find((type) => type.id === request.audit_type_id)
                  ?.name || "Audit"}
              </strong>
              <small>{request.station_name}</small>
            </div>
          </>
        ) : (
          <>
            <div className={styles.inputLabel}>
              Station
              <SearchableSelect
                key={other ? "other" : "own"}
                name="location_id"
                required
                value={stationId}
                onValueChange={(next) => {
                  setStationId(next);
                  if (!workspace.anyStation) setAuditor(viewerId);
                }}
                placeholder={
                  other && !reach ? "Loading stations…" : "Search station"
                }
                disabled={other && !reach}
                maxOptions={500}
                options={
                  other
                    ? (reach || []).map((s) => ({ value: s.id, label: s.label }))
                    : workspace.stations.map((station) => ({
                        value: station.id,
                        label: `${station.station_code} · ${station.station_name || station.city || ""}`,
                      }))
                }
              />
            </div>
            <label className={styles.inputLabel}>
              Audit type
              <select
                name="audit_type_id"
                defaultValue={defaultTypeId || types[0]?.id || ""}
                required
              >
                {types.map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        {other ? (
          <label className={styles.inputLabel}>
            Preferred date
            <input name="preferred_date" type="date" min={auditDay()} />
            <small>Optional. The manager sets the final date.</small>
          </label>
        ) : (
          <>
            {fixedAuditor ? (
              <div className={styles.inputLabel}>
                Auditor
                <input
                  type="hidden"
                  name="assigned_to"
                  value={request!.requested_by}
                />
                <strong>{request!.requested_name || "Requester"}</strong>
                <small>The person who asked performs this audit.</small>
              </div>
            ) : (
              <div className={styles.inputLabel}>
                Auditor
                <SearchableSelect
                  key={`${stationId}:${workspace.anyStation}`}
                  name="assigned_to"
                  required
                  value={auditor}
                  onValueChange={setAuditor}
                  placeholder={stationId ? "Search auditor" : "Select station first"}
                  disabled={!stationId}
                  maxOptions={200}
                  options={auditors}
                />
              </div>
            )}
            <label className={styles.inputLabel}>
              When
              <select
                name="when"
                value={later ? "later" : "now"}
                onChange={(event) => setLater(event.target.value === "later")}
              >
                <option value="now">
                  {auditor === viewerId ? "Start now" : "Available now"}
                </option>
                <option value="later">On a later date</option>
              </select>
            </label>
            {later && (
              <>
                <label className={styles.inputLabel}>
                  Date
                  <input
                    name="scheduled_date"
                    type="date"
                    min={auditDay()}
                    defaultValue={
                      request?.preferred_date &&
                      request.preferred_date > auditDay()
                        ? request.preferred_date
                        : auditDay()
                    }
                    required
                  />
                </label>
                <label className={styles.inputLabel}>
                  Time (IST)
                  <input
                    name="scheduled_time"
                    type="time"
                    defaultValue="09:00"
                    required
                  />
                </label>
              </>
            )}
          </>
        )}
        <label className={styles.inputLabel}>
          Reason
          <input
            name="reason"
            required
            maxLength={500}
            defaultValue={request?.reason || ""}
            placeholder={
              other ? "Why do you need to audit this station?" : "Why now?"
            }
          />
        </label>
      </div>
      <div className={styles.actions}>
        <button
          className="button"
          disabled={
            pending ||
            (other && !workspace.programmeSettings.cross_audit_ready) ||
            (!request && !stationId)
          }
        >
          {pending
            ? "Saving…"
            : other
              ? "Request approval"
              : request
                ? "Approve and create audit"
                : later || auditor !== viewerId
                  ? "Create audit"
                  : "Start audit now"}
        </button>
        <p role="status">{notice}</p>
      </div>
    </form>
  );
}

/** Cross-station requests: what the viewer asked for, and what waits for their decision. */
export function AuditRequests({
  workspace,
  viewerId,
  canCreate,
  onApprove,
  onCreate,
  onOpen,
}: {
  workspace: StationAuditWorkspace;
  viewerId: string;
  canCreate: boolean;
  onApprove: (request: AuditRequest) => void;
  onCreate: () => void;
  onOpen: (auditId: string) => void;
}) {
  const [declining, setDeclining] = useState("");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const waiting = workspace.requests.filter((request) => request.canDecide);
  const decide = async (operation: string, id: string, note = "") => {
    if (pending) return;
    setPending(true);
    try {
      const data = new FormData();
      data.set("operation", operation);
      data.set("request_id", id);
      data.set("note", note);
      const result = await decideAuditRequest(data);
      setNotice(result.message);
      if (result.ok) setDeclining("");
    } catch {
      setNotice("Unable to save. Please try again.");
    } finally {
      setPending(false);
    }
  };
  return (
    <section className={styles.reportPanel} aria-label="Cross-station requests">
      <div className={styles.reportHeader}>
        <div>
          <h2>Cross-station requests</h2>
          <p>
            {waiting.length
              ? `${waiting.length} waiting for your decision.`
              : "Nothing is waiting for your decision."}{" "}
            Approving creates the audit and assigns the auditor.
          </p>
        </div>
        {canCreate && workspace.anyStation && (
          <button className="button compact" onClick={onCreate}>
            Create audit for any station
          </button>
        )}
      </div>
      {!workspace.programmeSettings.cross_audit_ready && (
        <p role="alert" className={styles.notice}>
          {pendingUpdate}
        </p>
      )}
      {notice && (
        <p role="status" className={styles.notice}>
          {notice}
        </p>
      )}
      <div className={styles.tableScroll}>
        <table className={styles.reportTable}>
          <thead>
            <tr>
              <th>Requested by</th>
              <th>Station · audit</th>
              <th>Reason</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {workspace.requests.map((request) => (
              <tr key={request.id}>
                <td>
                  <strong>
                    {request.requested_by === viewerId
                      ? "You"
                      : request.requested_name || "Auditor"}
                  </strong>
                  <small>{auditDay(request.created_at)}</small>
                </td>
                <td>
                  <strong>{request.station_code}</strong>
                  <small>
                    {workspace.auditTypes.find(
                      (type) => type.id === request.audit_type_id,
                    )?.name || "Audit"}
                    {request.preferred_date
                      ? ` · preferred ${request.preferred_date}`
                      : ""}
                  </small>
                </td>
                <td>{request.reason}</td>
                <td>
                  <strong>{requestStatus[request.status] || request.status}</strong>
                  {request.status !== "pending" && (
                    <small>
                      {request.decided_name
                        ? `By ${request.decided_name}`
                        : ""}
                      {request.decision_note
                        ? ` · ${request.decision_note}`
                        : ""}
                    </small>
                  )}
                </td>
                <td>
                  {request.canDecide && declining !== request.id && (
                    <div className={styles.actions}>
                      <button
                        className="button compact"
                        disabled={pending || !canCreate}
                        onClick={() => onApprove(request)}
                      >
                        Approve
                      </button>
                      <button
                        className="button secondary compact"
                        disabled={pending}
                        onClick={() => setDeclining(request.id)}
                      >
                        Decline
                      </button>
                    </div>
                  )}
                  {declining === request.id && (
                    <form
                      className={styles.actions}
                      onSubmit={(event) => {
                        event.preventDefault();
                        void decide(
                          "decline",
                          request.id,
                          String(new FormData(event.currentTarget).get("note") || ""),
                        );
                      }}
                    >
                      <input
                        name="note"
                        required
                        maxLength={500}
                        placeholder="Why is it declined?"
                        aria-label="Reason for declining"
                      />
                      <button className="button compact" disabled={pending}>
                        Confirm
                      </button>
                      <button
                        type="button"
                        className={styles.textButton}
                        onClick={() => setDeclining("")}
                      >
                        Cancel
                      </button>
                    </form>
                  )}
                  {request.status === "pending" &&
                    request.requested_by === viewerId && (
                      <button
                        className="button secondary compact"
                        disabled={pending}
                        onClick={() => void decide("cancel", request.id)}
                      >
                        Withdraw
                      </button>
                    )}
                  {request.audit_id &&
                    workspace.audits.some((a) => a.id === request.audit_id) && (
                      <button
                        className="button secondary compact"
                        onClick={() => onOpen(request.audit_id!)}
                      >
                        Open audit
                      </button>
                    )}
                </td>
              </tr>
            ))}
            {!workspace.requests.length && (
              <tr>
                <td colSpan={5} className={styles.empty}>
                  No cross-station requests in the last 30 days.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
