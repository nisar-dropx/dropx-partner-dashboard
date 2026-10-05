"use client";
import { useState, useTransition } from "react";
import {
  addAuditManagerComment,
  beginStationAudit,
  closeStationAudit,
  respondToStationAudit,
  submitStationAudit,
  rescheduleStationAudit,
} from "./actions";
import type {
  AuditChecklistItem,
  StationAudit,
  StationAuditWorkspace,
} from "@/lib/ops-pulse/station-audits";
import {
  auditDay,
  auditLocalTime,
  auditDuration,
  isFastAudit,
  auditStatusLabel,
  auditSlots,
} from "@/lib/ops-pulse/station-audit-planning";
import styles from "./audit-workspace.module.css";
type Result = { ok: boolean; message: string };
const value = (input: unknown) => String(input ?? "");
const formatDateTime = (input: string) =>
  new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(input));
const statusClass = (status: string) =>
  `${styles.status} ${styles[status] ?? ""}`;
const responseValue = (raw: unknown) =>
  raw && typeof raw === "object" && "value" in raw
    ? value((raw as { value?: unknown }).value)
    : value(raw);
function useAction() {
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState("");
  const run = (action: () => Promise<Result>) =>
    startTransition(async () => {
      try {
        const result = await action();
        setNotice(result.message);
      } catch {
        setNotice("Unable to save. Please try again.");
      }
    });
  return { pending, notice, run };
}
type ShipmentDraft = {
  trackingId: string;
  systemStatusCode: string;
  physicalStatusCode: string;
  discrepancyCode: string;
  requiredAction: string;
  remarks: string;
  dueAt: string;
};
export function AuditDetail({
  audit,
  workspace,
  canManage,
  canRespond,
}: {
  audit: StationAudit;
  workspace: StationAuditWorkspace;
  canManage: boolean;
  canRespond: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const type = workspace.auditTypes.find(
    (row) => row.id === audit.audit_type_id,
  );
  const station = workspace.stations.find(
    (row) => row.id === audit.location_id,
  );
  const items = workspace.checklistItems.filter(
    (item) => item.audit_type_id === audit.audit_type_id,
  );
  const sections = workspace.sections.filter(
    (section) => section.audit_type_id === audit.audit_type_id,
  );
  const responses = new Map(
    workspace.responses
      .filter((row) => row.audit_id === audit.id)
      .map((row) => [row.checklist_item_id, row]),
  );
  const cash = new Map(
    workspace.cashCounts
      .filter(
        (row) => row.audit_id === audit.id && row.cash_side === "physical",
      )
      .map((row) => [row.denomination_option_id, row]),
  );
  const existingShipments = workspace.shipments.filter(
    (row) => row.audit_id === audit.id,
  );
  const [shipments, setShipments] = useState<ShipmentDraft[]>(
    existingShipments.map((row) => ({
      trackingId: row.tracking_id,
      systemStatusCode: row.system_status_code || "",
      physicalStatusCode: row.physical_status_code || "",
      discrepancyCode: row.discrepancy_code || "",
      requiredAction: row.required_action || "",
      remarks: row.remarks || "",
      dueAt: row.due_at?.slice(0, 10) || "",
    })),
  );
  const submit = useAction();
  const lifecycle = useAction();
  const denominations = workspace.options.filter(
    (option) => option.option_group === "cash_denomination",
  );
  const physicalStatuses = workspace.options.filter(
    (option) => option.option_group === "shipment_physical_status",
  );
  const discrepancies = workspace.options.filter(
    (option) => option.option_group === "shipment_discrepancy",
  );
  const actions = workspace.actions.filter((row) => row.audit_id === audit.id);
  const comments = workspace.comments.filter(
    (row) => row.audit_id === audit.id,
  );
  const evidence = workspace.evidence.filter(
    (row) => row.audit_id === audit.id,
  );
  const addShipment = () =>
    setShipments((rows) => [
      ...rows,
      {
        trackingId: "",
        systemStatusCode: "",
        physicalStatusCode: "",
        discrepancyCode: "",
        requiredAction: "",
        remarks: "",
        dueAt: "",
      },
    ]);
  const changeShipment = (
    index: number,
    field: keyof ShipmentDraft,
    next: string,
  ) =>
    setShipments((rows) =>
      rows.map((row, rowIndex) =>
        rowIndex === index ? { ...row, [field]: next } : row,
      ),
    );
  if (!type || !station) return null;
  return (
    <section className={styles.detail} id={`audit-${audit.id}`}>
      <div className={styles.detailHead}>
        <div>
          <h2>
            {station.station_code} · {type.name}
          </h2>
          <p>
            {audit.audit_number} · Scheduled{" "}
            {formatDateTime(audit.scheduled_for)}{" "}
            {audit.assigned_name ? `· ${audit.assigned_name}` : ""}
          </p>
        </div>
        <div className={styles.actions}>
          <span className={statusClass(audit.status_code)}>
            {auditStatusLabel(audit.status_code)}
          </span>
          {canManage && audit.status_code === "scheduled" ? (
            <button
              className="button compact"
              disabled={lifecycle.pending}
              onClick={() => lifecycle.run(() => beginStationAudit(audit.id))}
            >
              Start audit
            </button>
          ) : null}
          {canManage && audit.completed_at && audit.status_code !== "closed" ? (
            <button
              className="button secondary compact"
              onClick={() => setEditing(!editing)}
            >
              {editing ? "View saved findings" : "Edit findings"}
            </button>
          ) : null}
          {canManage && audit.status_code === "under_review" ? (
            <button
              className="button compact"
              disabled={lifecycle.pending}
              onClick={() => lifecycle.run(() => closeStationAudit(audit.id))}
            >
              Close audit
            </button>
          ) : null}
        </div>
      </div>
      {lifecycle.notice ? (
        <div className={styles.notice} style={{ margin: "12px 18px 0" }}>
          {lifecycle.notice}
        </div>
      ) : null}
      <AuditIdentity audit={audit} workspace={workspace} />
      {canManage && audit.status_code === "scheduled" ? (
        <Reschedule audit={audit} workspace={workspace} />
      ) : null}
      <div className={styles.detailGrid}>
        {canManage && (audit.status_code === "in_progress" || editing) ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              data.set("shipments_json", JSON.stringify(shipments));
              submit.run(() => submitStationAudit(data));
            }}
          >
            <input type="hidden" name="audit_id" value={audit.id} />
            <details className={styles.section} open>
              <summary>
                Reconciliation snapshot{" "}
                <span>cash, shipment and video evidence</span>
              </summary>
              <div className={styles.sectionBody}>
                <div className={styles.twoCol}>
                  <label className={styles.inputLabel}>
                    Cash as per system
                    <input
                      name="system_cash_amount"
                      type="number"
                      min="0"
                      step="0.01"
                      defaultValue={audit.system_cash_amount ?? ""}
                    />
                  </label>
                  <label className={styles.inputLabel}>
                    Physical cash total{" "}
                    <small>Must equal denominations below</small>
                    <input
                      name="physical_cash_amount"
                      type="number"
                      min="0"
                      step="0.01"
                      defaultValue={audit.physical_cash_amount ?? ""}
                    />
                  </label>
                  <label className={styles.inputLabel}>
                    Shipments as per system
                    <input
                      name="system_shipment_count"
                      type="number"
                      min="0"
                      defaultValue={audit.system_shipment_count ?? ""}
                    />
                  </label>
                  <label className={styles.inputLabel}>
                    Physical shipment count
                    <input
                      name="physical_shipment_count"
                      type="number"
                      min="0"
                      defaultValue={audit.physical_shipment_count ?? ""}
                    />
                  </label>
                </div>
                <div style={{ marginTop: 12 }}>
                  <div className={styles.checkTitle}>
                    Physical cash denomination count
                  </div>
                  <div className={styles.denoms}>
                    {denominations.map((option) => (
                      <label className={styles.denom} key={option.id}>
                        <span>{option.label}</span>
                        <input
                          name={`denomination_${option.id}`}
                          type="number"
                          min="0"
                          step="1"
                          defaultValue={cash.get(option.id)?.note_count ?? 0}
                        />
                      </label>
                    ))}
                  </div>
                </div>
                {type.requires_video_link ? (
                  <div className={styles.twoCol} style={{ marginTop: 12 }}>
                    <label className={styles.inputLabel}>
                      Google Drive recording link{" "}
                      <small>{type.video_link_help}</small>
                      <input
                        name="video_call_url"
                        type="url"
                        defaultValue={audit.video_call_url ?? ""}
                        placeholder="https://drive.google.com/..."
                        required
                      />
                    </label>
                    <label className={styles.inputLabel}>
                      Viewing access
                      <select name="video_access_confirmed" defaultValue="">
                        <option value="" disabled>
                          Confirm access
                        </option>
                        <option value="yes">
                          Anyone with the link can view
                        </option>
                      </select>
                    </label>
                  </div>
                ) : null}
              </div>
            </details>
            <details className={styles.section} open style={{ marginTop: 12 }}>
              <summary>
                Shipment exceptions <span>{shipments.length} recorded</span>
              </summary>
              <div className={styles.sectionBody}>
                {shipments.map((row, index) => (
                  <div className={styles.shipment} key={index}>
                    <input
                      value={row.trackingId}
                      onChange={(event) =>
                        changeShipment(index, "trackingId", event.target.value)
                      }
                      placeholder="Tracking ID"
                    />
                    <input
                      value={row.systemStatusCode}
                      onChange={(event) =>
                        changeShipment(
                          index,
                          "systemStatusCode",
                          event.target.value,
                        )
                      }
                      placeholder="System status"
                    />
                    <select
                      value={row.physicalStatusCode}
                      onChange={(event) =>
                        changeShipment(
                          index,
                          "physicalStatusCode",
                          event.target.value,
                        )
                      }
                    >
                      <option value="">Physical status</option>
                      {physicalStatuses.map((option) => (
                        <option value={option.code} key={option.id}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <select
                      value={row.discrepancyCode}
                      onChange={(event) =>
                        changeShipment(
                          index,
                          "discrepancyCode",
                          event.target.value,
                        )
                      }
                    >
                      <option value="">Discrepancy</option>
                      {discrepancies.map((option) => (
                        <option value={option.code} key={option.id}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className={styles.miniButton}
                      onClick={() =>
                        setShipments((rows) =>
                          rows.filter((_, rowIndex) => rowIndex !== index),
                        )
                      }
                    >
                      Remove
                    </button>
                    <input
                      value={row.requiredAction}
                      onChange={(event) =>
                        changeShipment(
                          index,
                          "requiredAction",
                          event.target.value,
                        )
                      }
                      placeholder="Corrective action"
                    />
                    <input
                      value={row.dueAt}
                      onChange={(event) =>
                        changeShipment(index, "dueAt", event.target.value)
                      }
                      type="date"
                    />
                    <input
                      value={row.remarks}
                      onChange={(event) =>
                        changeShipment(index, "remarks", event.target.value)
                      }
                      placeholder="Observation"
                    />
                  </div>
                ))}
                <button
                  type="button"
                  className={styles.miniButton}
                  onClick={addShipment}
                >
                  + Add shipment exception
                </button>
              </div>
            </details>
            {sections.map((section) => (
              <details
                className={styles.section}
                open
                key={section.id}
                style={{ marginTop: 12 }}
              >
                <summary>
                  {section.name}
                  <span>
                    {
                      items.filter((item) => item.section_id === section.id)
                        .length
                    }{" "}
                    checks
                  </span>
                </summary>
                <div className={styles.sectionBody}>
                  {section.guidance ? (
                    <p className={styles.checkHelp}>{section.guidance}</p>
                  ) : null}
                  {items
                    .filter((item) => item.section_id === section.id)
                    .map((item) => (
                      <AuditCheck
                        key={item.id}
                        item={item}
                        response={responses.get(item.id)}
                      />
                    ))}
                </div>
              </details>
            ))}
            <details className={styles.section} open style={{ marginTop: 12 }}>
              <summary>
                Evidence and submission{" "}
                <span>files, summary and CAPA date</span>
              </summary>
              <div className={styles.sectionBody}>
                <div className={styles.twoCol}>
                  <label className={styles.inputLabel}>
                    Evidence files
                    <input type="file" name="evidence_files" multiple />
                  </label>
                  <label className={styles.inputLabel}>
                    Evidence caption
                    <input
                      name="evidence_caption"
                      placeholder="What does this evidence show?"
                    />
                  </label>
                  <label className={styles.inputLabel}>
                    CAPA response due
                    <input
                      name="action_due_at"
                      type="datetime-local"
                      defaultValue={
                        audit.response_due_at
                          ? `${auditDay(audit.response_due_at)}T${auditLocalTime(audit.response_due_at)}`
                          : ""
                      }
                    />
                  </label>
                </div>
                <label className={styles.inputLabel} style={{ marginTop: 10 }}>
                  Audit summary
                  <textarea
                    name="overall_summary"
                    defaultValue={audit.overall_summary ?? ""}
                    placeholder="Key reconciliation result, exceptions and operational findings"
                    required
                  />
                </label>
                <label className={styles.inputLabel} style={{ marginTop: 10 }}>
                  Manager note
                  <textarea
                    name="manager_summary"
                    defaultValue={audit.manager_summary ?? ""}
                    placeholder="Instructions for station and leadership"
                  />
                </label>
                <div className={styles.actions} style={{ marginTop: 12 }}>
                  <button className="button" disabled={submit.pending}>
                    {submit.pending ? "Submitting…" : "Submit audit for review"}
                  </button>
                  {submit.notice ? (
                    <span className={styles.notice}>{submit.notice}</span>
                  ) : null}
                </div>
              </div>
            </details>
          </form>
        ) : (
          <SavedAudit
            audit={audit}
            workspace={workspace}
            canManage={canManage}
          />
        )}
        <aside className={styles.timeline}>
          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              Corrective actions{" "}
              <span>
                {
                  actions.filter((action) => action.status_code !== "completed")
                    .length
                }{" "}
                open
              </span>
            </div>
            <div className={styles.sectionBody}>
              {actions.length ? (
                actions.map((action) => (
                  <div className={styles.timelineItem} key={action.id}>
                    <strong>{action.title}</strong>
                    <span>{action.corrective_action}</span>
                    <span>
                      {action.due_at
                        ? ` · due ${formatDateTime(action.due_at)}`
                        : ""}{" "}
                      · {action.status_code.replaceAll("_", " ")}
                    </span>
                  </div>
                ))
              ) : (
                <p className={styles.checkHelp}>
                  No corrective action has been raised.
                </p>
              )}
            </div>
          </section>
          {canRespond && audit.status_code === "awaiting_station_response" ? (
            <StationResponse
              audit={audit}
              actions={actions}
              run={submit.run}
              pending={submit.pending}
              notice={submit.notice}
            />
          ) : null}
          {canManage && audit.completed_at ? (
            <ManagerFollowUp
              audit={audit}
              run={lifecycle.run}
              pending={lifecycle.pending}
              notice={lifecycle.notice}
            />
          ) : null}
          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              Conversation <span>{comments.length}</span>
            </div>
            <div className={styles.sectionBody}>
              {comments.length ? (
                comments.map((comment) => (
                  <div className={styles.timelineItem} key={comment.id}>
                    <strong>
                      {comment.author_name || comment.author_email || "System"}
                    </strong>
                    <span>{comment.body}</span>
                    <span>
                      {formatDateTime(comment.created_at)}
                      {comment.requests_station_response
                        ? " · station response requested"
                        : ""}
                    </span>
                  </div>
                ))
              ) : (
                <p className={styles.checkHelp}>No follow-up messages yet.</p>
              )}
            </div>
          </section>
          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              Evidence <span>{evidence.length}</span>
            </div>
            <div className={`${styles.sectionBody} ${styles.evidence}`}>
              {evidence.length ? (
                evidence.map((item) => (
                  <a
                    href={`/api/ops-pulse/audits/evidence/${item.id}`}
                    key={item.id}
                    target="_blank"
                  >
                    {item.file_name || item.evidence_kind_code || "Evidence"}
                  </a>
                ))
              ) : (
                <p className={styles.checkHelp}>No files attached yet.</p>
              )}
            </div>
          </section>
        </aside>
      </div>
    </section>
  );
}

function AuditCheck({
  item,
  response,
}: {
  item: AuditChecklistItem;
  response?: { response_value: unknown; remarks: string | null };
}) {
  const options = item.response_options;
  const defaultValue = responseValue(response?.response_value);
  return (
    <div className={styles.check}>
      <div className={styles.checkTitle}>
        {item.label}
        {item.is_required ? <span className="fin-negative"> *</span> : null}
      </div>
      {item.guidance ? (
        <div className={styles.checkHelp}>{item.guidance}</div>
      ) : null}
      <div className={styles.twoCol}>
        {options.length ? (
          <label className={styles.inputLabel}>
            Outcome
            <select
              name={`check_${item.id}`}
              defaultValue={defaultValue}
              required={item.is_required}
            >
              <option value="">Select outcome</option>
              {options.map((option) => (
                <option value={option.value} key={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className={styles.inputLabel}>
            Response
            <input
              name={`check_${item.id}`}
              defaultValue={defaultValue}
              required={item.is_required}
            />
          </label>
        )}
        <label className={styles.inputLabel}>
          Observation
          <input
            name={`check_note_${item.id}`}
            defaultValue={response?.remarks ?? ""}
            placeholder="Optional when the selected outcome is compliant"
          />
        </label>
      </div>
      <div className={styles.twoCol}>
        <label className={styles.inputLabel}>
          Corrective action{" "}
          <small>
            Required only when the selected master outcome requires CAPA.
          </small>
          <input
            name={`check_action_${item.id}`}
            placeholder="Owner action / resolution"
          />
        </label>
        <label className={styles.inputLabel}>
          Preventive action
          <input
            name={`check_preventive_${item.id}`}
            placeholder="Avoid recurrence"
          />
        </label>
      </div>
    </div>
  );
}

function StationResponse({
  audit,
  actions,
  run,
  pending,
  notice,
}: {
  audit: StationAudit;
  actions: Array<{ id: string; title: string; status_code: string }>;
  run: (action: () => Promise<Result>) => void;
  pending: boolean;
  notice: string;
}) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        Station response <span>action required</span>
      </div>
      <div className={styles.sectionBody}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            run(() => respondToStationAudit(data));
          }}
        >
          <input type="hidden" name="audit_id" value={audit.id} />
          <label className={styles.inputLabel}>
            Action completed
            <select name="action_id">
              <option value="">General response / no action closed</option>
              {actions
                .filter((action) => action.status_code !== "completed")
                .map((action) => (
                  <option value={action.id} key={action.id}>
                    {action.title}
                  </option>
                ))}
            </select>
          </label>
          <label className={styles.inputLabel} style={{ marginTop: 8 }}>
            Response / proof
            <textarea
              name="response"
              required
              placeholder="What was corrected? Include the operational status and evidence reference."
            />
          </label>
          <label className={styles.inputLabel} style={{ marginTop: 8 }}>
            Attachments
            <input type="file" name="response_evidence" multiple />
          </label>
          <div className={styles.actions} style={{ marginTop: 10 }}>
            <button className="button compact" disabled={pending}>
              {pending ? "Sending…" : "Submit response"}
            </button>
            {notice ? <span className={styles.notice}>{notice}</span> : null}
          </div>
        </form>
      </div>
    </section>
  );
}

function ManagerFollowUp({
  audit,
  run,
  pending,
  notice,
}: {
  audit: StationAudit;
  run: (action: () => Promise<Result>) => void;
  pending: boolean;
  notice: string;
}) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        Manager follow-up <span>request another reply</span>
      </div>
      <div className={styles.sectionBody}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            run(() => addAuditManagerComment(data));
          }}
        >
          <input type="hidden" name="audit_id" value={audit.id} />
          <label className={styles.inputLabel}>
            Note
            <textarea
              name="comment"
              required
              placeholder="Ask for a clarification or record a manager note"
            />
          </label>
          <div className={styles.twoCol} style={{ marginTop: 8 }}>
            <label className={styles.inputLabel}>
              Station reply required
              <select name="request_station_response" defaultValue="no">
                <option value="no">No</option>
                <option value="yes">Yes</option>
              </select>
            </label>
            <label className={styles.inputLabel}>
              Reply due
              <input
                name="response_due_at"
                type="datetime-local"
                defaultValue={audit.response_due_at?.slice(0, 16) ?? ""}
              />
            </label>
          </div>
          <div className={styles.actions} style={{ marginTop: 10 }}>
            <button className="button secondary compact" disabled={pending}>
              {pending ? "Sending…" : "Add follow-up"}
            </button>
            {notice ? <span className={styles.notice}>{notice}</span> : null}
          </div>
        </form>
      </div>
    </section>
  );
}

export function auditActor(
  audit: StationAudit,
  workspace: StationAuditWorkspace,
  event: string,
) {
  const entries = workspace.events.filter(
    (row) => row.audit_id === audit.id && row.event_type === event,
  );
  const row = entries[entries.length - 1];
  return (
    row?.actor_name ||
    row?.actor_email ||
    (event === "started" ||
    (event === "submitted" && audit.completed_by === audit.assigned_to)
      ? audit.assigned_name
      : null) ||
    "Not recorded"
  );
}
function AuditIdentity({
  audit,
  workspace,
}: {
  audit: StationAudit;
  workspace: StationAuditWorkspace;
}) {
  const duration = auditDuration(audit);
  return (
    <div className={styles.identity}>
      <span>
        Assigned auditor <strong>{audit.assigned_name || "Unassigned"}</strong>
      </span>
      <span>
        Scheduled by{" "}
        <strong>{auditActor(audit, workspace, "scheduled")}</strong>
      </span>
      {audit.started_at && (
        <span>
          {audit.completed_at ? "Started by" : "Currently auditing"}{" "}
          <strong>{auditActor(audit, workspace, "started")}</strong>
          <small>{formatDateTime(audit.started_at)}</small>
        </span>
      )}
      {audit.completed_at && (
        <span>
          Completed by{" "}
          <strong>{auditActor(audit, workspace, "submitted")}</strong>
          <small>{formatDateTime(audit.completed_at)}</small>
        </span>
      )}
      {audit.completed_at && (
        <span>
          Audit duration{" "}
          <strong>
            {duration === null
              ? "Not recorded"
              : `${Number(duration.toFixed(1))} minutes`}
          </strong>
          {isFastAudit(audit) && (
            <mark className={styles.fast}>≤10 min · Quality review</mark>
          )}
        </span>
      )}
    </div>
  );
}
function Reschedule({
  audit,
  workspace,
}: {
  audit: StationAudit;
  workspace: StationAuditWorkspace;
}) {
  const state = useAction();
  const type = workspace.auditTypes.find(
    (row) => row.id === audit.audit_type_id,
  )!;
  return (
    <details className={styles.reschedule}>
      <summary>Postpone / reschedule audit</summary>
      <form
        className={styles.compactForm}
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          state.run(() => rescheduleStationAudit(data));
        }}
      >
        <input type="hidden" name="audit_id" value={audit.id} />
        <input
          type="hidden"
          name="original_scheduled_for"
          value={audit.scheduled_for}
        />
        <label className={styles.inputLabel}>
          New date
          <input
            name="scheduled_date"
            type="date"
            min={auditDay()}
            defaultValue={
              auditDay(audit.scheduled_for) < auditDay()
                ? auditDay()
                : auditDay(audit.scheduled_for)
            }
            required
          />
        </label>
        <label className={styles.inputLabel}>
          Time (IST)
          <input
            name="scheduled_time"
            type="time"
            defaultValue={auditLocalTime(audit.scheduled_for)}
            required
          />
        </label>
        <label className={styles.inputLabel}>
          Programme slot
          <select name="period_slot" defaultValue={audit.period_slot}>
            {auditSlots(type).map((slot) => (
              <option key={slot.code} value={slot.code}>
                {slot.label}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.inputLabel}>
          Reason
          <input
            name="reason"
            required
            maxLength={500}
            placeholder="Why is this moving?"
          />
        </label>
        <button className="button compact" disabled={state.pending}>
          {state.pending ? "Saving…" : "Save new date"}
        </button>
        <p role="status">
          {state.notice ||
            "The original date and the user making this change remain in the audit history."}
        </p>
      </form>
    </details>
  );
}
function SavedAudit({
  audit,
  workspace,
  canManage,
}: {
  audit: StationAudit;
  workspace: StationAuditWorkspace;
  canManage: boolean;
}) {
  const checks = workspace.responses.filter((row) => row.audit_id === audit.id);
  const money = (value: number | null) =>
    value == null
      ? "Not recorded"
      : `₹${Number(value).toLocaleString("en-IN")}`;
  return (
    <div className={styles.timeline}>
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          {audit.completed_at ? "Audit findings" : "Scheduled audit"}
        </div>
        <div className={styles.sectionBody}>
          {!audit.completed_at ? (
            <p>
              {audit.scheduled_reason ||
                "Start the audit to record findings, checks and evidence."}
            </p>
          ) : (
            <>
              <div className={styles.identity}>
                <span>
                  System cash<strong>{money(audit.system_cash_amount)}</strong>
                </span>
                <span>
                  Physical cash
                  <strong>{money(audit.physical_cash_amount)}</strong>
                </span>
                <span>
                  Cash variance
                  <strong>{money(audit.cash_variance_amount)}</strong>
                </span>
                <span>
                  System / physical shipments
                  <strong>
                    {audit.system_shipment_count ?? "—"} /{" "}
                    {audit.physical_shipment_count ?? "—"}
                  </strong>
                </span>
              </div>
              <p>{audit.overall_summary || "No summary recorded."}</p>
              {audit.station_summary && (
                <p>
                  <b>Station response:</b> {audit.station_summary}
                </p>
              )}
              {canManage && audit.manager_summary && (
                <p>
                  <b>Manager note:</b> {audit.manager_summary}
                </p>
              )}
              {audit.video_call_url && (
                <a href={audit.video_call_url} target="_blank" rel="noreferrer">
                  Open audit recording
                </a>
              )}
            </>
          )}
        </div>
      </section>
      {checks.length > 0 && (
        <details className={styles.section} open>
          <summary>
            Checklist findings <span>{checks.length} checks</span>
          </summary>
          <div className={styles.sectionBody}>
            {checks.map((check) => {
              const item = workspace.checklistItems.find(
                (row) => row.id === check.checklist_item_id,
              );
              return (
                <div key={check.id} className={styles.check}>
                  <strong>{item?.label || "Archived checklist item"}</strong>
                  <span>
                    {item?.response_options.find(
                      (row) =>
                        row.value === responseValue(check.response_value),
                    )?.label || responseValue(check.response_value)}
                  </span>
                  {check.remarks && <p>{check.remarks}</p>}
                </div>
              );
            })}
          </div>
        </details>
      )}
      {workspace.cashCounts.some((row) => row.audit_id === audit.id) && (
        <details className={styles.section}>
          <summary>Cash denominations</summary>
          <div className={styles.sectionBody}>
            {workspace.cashCounts
              .filter((row) => row.audit_id === audit.id)
              .map((row) => (
                <p key={row.id}>
                  ₹{row.denomination_value} × {row.note_count} ={" "}
                  {money(row.computed_amount)}
                </p>
              ))}
          </div>
        </details>
      )}
      {workspace.shipments.some((row) => row.audit_id === audit.id) && (
        <details className={styles.section}>
          <summary>Shipment exceptions</summary>
          <div className={styles.sectionBody}>
            {workspace.shipments
              .filter((row) => row.audit_id === audit.id)
              .map((row) => (
                <div className={styles.check} key={row.id}>
                  <strong>{row.tracking_id}</strong>
                  <span>
                    System: {row.system_status_code || "—"} · Physical:{" "}
                    {row.physical_status_code || "—"} · {row.discrepancy_code}
                  </span>
                  <span>
                    {row.remarks} {row.required_action}
                  </span>
                </div>
              ))}
          </div>
        </details>
      )}
      <details className={styles.section}>
        <summary>Audit history</summary>
        <div className={styles.sectionBody}>
          {workspace.events
            .filter((row) => row.audit_id === audit.id)
            .map((row) => (
              <div className={styles.timelineItem} key={row.id}>
                <strong>
                  {row.event_type.replaceAll("_", " ")} ·{" "}
                  {row.actor_name || row.actor_email || "System"}
                </strong>
                <span>{formatDateTime(row.created_at)}</span>
                {row.event_type === "rescheduled" && (
                  <p>
                    {formatDateTime(String(row.before_data.scheduled_for))} →{" "}
                    {formatDateTime(String(row.after_data.scheduled_for))}
                    <br />
                    {String(row.after_data.reason || "")}
                  </p>
                )}
              </div>
            ))}
        </div>
      </details>
    </div>
  );
}
