"use client";
import {
  AuditScore,
  ResponsibilityAssessment,
  ScoreReview,
} from "./audit-score";
import { uploadAuditFiles } from "@/lib/ops-pulse/station-audit-upload";
import { SearchableSelect } from "@/components/searchable-select";
import {
  auditMonthRange,
  auditResponseLabel,
} from "@/lib/ops-pulse/station-audit-planning";
import {
  ShipmentInspection,
  ShipmentResponses,
  EmployeePicker,
} from "./shipment-inspection";
import type { AuditEmployee } from "@/lib/ops-pulse/station-audit-reconciliation";
import { useEffect, useState, useTransition } from "react";
import {
  loadAuditInspectionContext,
  addAuditManagerComment,
  beginStationAudit,
  closeStationAudit,
  respondToStationAudit,
  submitStationAudit,
  rescheduleStationAudit,
  manageAuditAssignment,
  retryStationAuditEmail,
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
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const run = (action: () => Promise<Result>) =>
    (async () => {
      if (pending) return;
      setPending(true);
      try {
        const result = await action();
        setNotice(result.message);
      } catch (error) {
        setNotice(
          error instanceof Error
            ? error.message
            : "Unable to save. Please try again.",
        );
      } finally {
        setPending(false);
      }
    })();
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
  canDelete,
  canPerform,
  onDeleted,
}: {
  audit: StationAudit;
  workspace: StationAuditWorkspace;
  canManage: boolean;
  canRespond: boolean;
  canDelete: boolean;
  canPerform: boolean;
  onDeleted: () => void;
}) {
  const [inspection, setInspection] = useState<Awaited<
    ReturnType<typeof loadAuditInspectionContext>
  > | null>(null);
  const [inspectionError, setInspectionError] = useState("");
  useEffect(() => {
    let active = true;
    loadAuditInspectionContext(audit.id)
      .then((data) => {
        if (active) setInspection(data);
      })
      .catch((e) => {
        if (active)
          setInspectionError(
            e instanceof Error
              ? e.message
              : "Unable to load station people and shipment lists.",
          );
      });
    return () => {
      active = false;
    };
  }, [audit.id]);
  const [editing, setEditing] = useState(false);
  const [differenceKeys, setDifferenceKeys] = useState<string[]>([]);
  const [checkDifferenceKeys, setCheckDifferenceKeys] = useState<string[]>(() =>
    workspace.responses
      .filter((r) => r.audit_id === audit.id && r.is_compliant === false)
      .map((r) => `check:${r.checklist_item_id}`),
  );
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [uploadProgress, setUploadProgress] = useState("");
  const editable =
    canPerform && (audit.status_code === "in_progress" || editing);
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
  const [expectedCash, setExpectedCash] = useState(
    audit.system_cash_amount == null ? "" : String(audit.system_cash_amount),
  );
  const [counts, setCounts] = useState<Record<string, number>>(() =>
    Object.fromEntries(
      [...cash].map(([id, row]) => [id || "", row.note_count]),
    ),
  );
  const actualCash = denominations.reduce(
    (sum, d) => sum + (counts[d.id] || 0) * Number(d.metadata.value || d.code),
    0,
  );
  const variance =
    expectedCash === ""
      ? null
      : Math.round((actualCash - Number(expectedCash)) * 100) / 100;
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
          {canDelete && (
            <button
              type="button"
              className={styles.deleteButton}
              aria-expanded={deleteOpen}
              aria-controls={`delete-${audit.id}`}
              onClick={() => setDeleteOpen(!deleteOpen)}
            >
              Delete audit
            </button>
          )}
          <span className={statusClass(audit.status_code)}>
            {auditStatusLabel(audit.status_code)}
          </span>
          {canPerform && audit.status_code === "scheduled" ? (
            <button
              className="button compact"
              disabled={lifecycle.pending}
              onClick={() => lifecycle.run(() => beginStationAudit(audit.id))}
            >
              Start audit
            </button>
          ) : null}
          {canPerform &&
          audit.completed_at &&
          audit.status_code !== "closed" ? (
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
      {canDelete && deleteOpen && (
        <DeleteAuditForm
          audit={audit}
          onDeleted={onDeleted}
          onCancel={() => setDeleteOpen(false)}
        />
      )}
      {inspectionError && (
        <p role="alert" className={styles.notice}>
          {inspectionError} Reopen this audit to retry.
        </p>
      )}
      <AuditIdentity audit={audit} workspace={workspace} />
      {canManage && <AuditControls audit={audit} workspace={workspace} />}
      {audit.completed_at && (
        <div className={styles.identity}>
          <span>
            Station response<strong>{auditResponseLabel(audit)}</strong>
          </span>
          <span>
            Report email
            <strong>
              {audit.email_status === "sent"
                ? "Sent"
                : audit.email_status === "failed"
                  ? "Failed"
                  : "Not sent"}
            </strong>
            <small>
              {audit.email_sent_at ? formatDateTime(audit.email_sent_at) : ""}
            </small>
            {audit.email_error && <small>{audit.email_error}</small>}
          </span>
          <span>
            Recipients
            <strong>
              {(audit.email_recipients || []).join(", ") || "Not sent yet"}
            </strong>
          </span>
          {canManage && audit.email_status !== "sent" && (
            <button
              className="button secondary compact"
              disabled={lifecycle.pending}
              onClick={() =>
                lifecycle.run(() => retryStationAuditEmail(audit.id))
              }
            >
              Retry report email
            </button>
          )}
        </div>
      )}

      {canManage && audit.status_code === "scheduled" ? (
        <Reschedule audit={audit} workspace={workspace} />
      ) : null}
      <div
        className={`${styles.detailGrid} ${canPerform && (audit.status_code === "in_progress" || editing) ? styles.editingAudit : ""}`}
      >
        {canPerform && (audit.status_code === "in_progress" || editing) ? (
          <form
            onChange={(event) => {
              const target = event.target as HTMLInputElement;
              if (!target.name?.startsWith("check_")) return;
              const data = new FormData(event.currentTarget);
              setCheckDifferenceKeys(
                items
                  .filter(
                    (i) =>
                      i.response_options.find(
                        (o) => o.value === data.get(`check_${i.id}`),
                      )?.is_compliant === false,
                  )
                  .map((i) => `check:${i.id}`),
              );
            }}
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              data.set("shipments_json", JSON.stringify(shipments));
              submit.run(async () => {
                await uploadAuditFiles(data, (done, total) =>
                  setUploadProgress(
                    total ? `Uploading proof ${done} / ${total}…` : "",
                  ),
                );
                setUploadProgress("Saving audit…");
                return submitStationAudit(data);
              });
            }}
          >
            <input type="hidden" name="audit_id" value={audit.id} />
            <input type="hidden" name="updated_at" value={audit.updated_at} />
            <details className={styles.section} open>
              <summary>
                Cash check <span>expected · counted · difference</span>
              </summary>
              <div className={styles.sectionBody}>
                <div className={styles.twoCol}>
                  <label className={styles.inputLabel}>
                    Expected cash as per ERP (₹)
                    <input
                      name="system_cash_amount"
                      type="number"
                      min="0"
                      step="0.01"
                      value={expectedCash}
                      onChange={(e) => setExpectedCash(e.target.value)}
                      required
                    />
                  </label>
                  <label className={styles.inputLabel}>
                    ERP screenshot / proof
                    <input
                      name="erp_evidence"
                      type="file"
                      accept="image/*,application/pdf"
                      required={
                        !evidence.some(
                          (e) => e.evidence_kind_code === "erp_screenshot",
                        )
                      }
                    />
                    <small>
                      {evidence.some(
                        (e) => e.evidence_kind_code === "erp_screenshot",
                      )
                        ? "Saved ERP proof is available below. Attach a replacement only if needed."
                        : "Attach the ERP cash balance used for this comparison."}
                    </small>
                  </label>
                </div>
                <div style={{ marginTop: 16 }}>
                  <div className={styles.checkTitle}>
                    Cash in hand · enter the number of notes / coins
                  </div>
                  <div className={styles.denoms}>
                    {denominations.map((option) => (
                      <label className={styles.denom} key={option.id}>
                        <span>{option.label}</span>
                        <input
                          name={`denomination_${option.id}`}
                          aria-label={`${option.label} count`}
                          type="number"
                          min="0"
                          step="1"
                          value={counts[option.id] ?? 0}
                          onChange={(e) =>
                            setCounts((v) => ({
                              ...v,
                              [option.id]: Number(e.target.value),
                            }))
                          }
                        />
                        <small>
                          ₹
                          {(
                            (counts[option.id] || 0) *
                            Number(option.metadata.value || option.code)
                          ).toLocaleString("en-IN")}
                        </small>
                      </label>
                    ))}
                  </div>
                </div>
                <div className={styles.cashTotals} aria-live="polite">
                  <div>
                    <span>Actual cash · calculated</span>
                    <strong>₹{actualCash.toLocaleString("en-IN")}</strong>
                  </div>
                  <div>
                    <span>
                      {variance === null
                        ? "Difference"
                        : variance === 0
                          ? "Cash matches"
                          : variance < 0
                            ? "Shortage"
                            : "Excess cash"}
                    </span>
                    <strong className={variance ? styles.fast : ""}>
                      {variance === null
                        ? "Enter expected cash"
                        : `₹${Math.abs(variance).toLocaleString("en-IN")}`}
                    </strong>
                  </div>
                </div>
                <input
                  type="hidden"
                  name="physical_cash_amount"
                  value={actualCash}
                />
                {variance !== null && variance !== 0 && (
                  <div className={styles.varianceBox}>
                    <strong>Cash difference requires a station response</strong>
                    <p>
                      The station will receive this finding and can explain or
                      attach proof in OpsPulse.
                    </p>
                    <label className={styles.inputLabel}>
                      Reason / finding
                      <input
                        name="cash_variance_reason"
                        defaultValue={audit.cash_variance_reason || ""}
                        placeholder="What explains the shortage or excess? Record what is known."
                        required
                        maxLength={1500}
                      />
                    </label>
                    <label className={styles.inputLabel}>
                      Supporting proof (optional)
                      <input
                        type="file"
                        name="variance_evidence"
                        accept="image/*,application/pdf"
                      />
                    </label>
                  </div>
                )}
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
            {type?.shipment_reconciliation_enabled ? (
              inspection ? (
                <ShipmentInspection
                  onDifferences={setDifferenceKeys}
                  lists={inspection.lists}
                  exceptions={existingShipments}
                />
              ) : (
                <p role="status">
                  {inspectionError || "Loading shipment reconciliation…"}
                </p>
              )
            ) : (
              <>
                {" "}
                <details className={styles.section} style={{ marginTop: 12 }}>
                  <summary>
                    Shipment exceptions <span>{shipments.length} recorded</span>
                  </summary>
                  <div className={styles.sectionBody}>
                    {shipments.map((row, index) => (
                      <div className={styles.shipment} key={index}>
                        <input
                          value={row.trackingId}
                          onChange={(event) =>
                            changeShipment(
                              index,
                              "trackingId",
                              event.target.value,
                            )
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
              </>
            )}
            {type?.scoring_enabled && (
              <ResponsibilityAssessment
                keys={[
                  ...(variance ? ["cash"] : []),
                  ...differenceKeys,
                  ...checkDifferenceKeys,
                ]}
                labels={Object.fromEntries(
                  items.map((i) => [`check:${i.id}`, i.label]),
                )}
                initial={audit.score_snapshot?.assessments}
                options={workspace.options.filter(
                  (o) => o.option_group === "audit_responsibility",
                )}
                evidence={evidence}
              />
            )}
            {sections
              .filter((section) =>
                items.some((item) => item.section_id === section.id),
              )
              .map((section) => (
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
                      {type?.scoring_enabled
                        ? ` · ${section.score_weight || 0}% weight`
                        : ""}
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
                          people={inspection?.people || []}
                          response={responses.get(item.id)}
                          photos={evidence.filter(
                            (e) =>
                              e.checklist_item_id === item.id &&
                              e.evidence_kind_code === "checklist_photo",
                          )}
                        />
                      ))}
                  </div>
                </details>
              ))}
            <details className={styles.section} open style={{ marginTop: 12 }}>
              <summary>
                Evidence and submission{" "}
                <span>files, remarks and response deadline</span>
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
                    Station response due
                    <input
                      name="action_due_at"
                      type="datetime-local"
                      defaultValue={
                        audit.completed_at &&
                        audit.response_due_at &&
                        Date.parse(audit.response_due_at) > Date.now()
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
                    placeholder="Optional observations or context"
                  />
                </label>
                <label className={styles.inputLabel} style={{ marginTop: 10 }}>
                  Manager note
                  <textarea
                    name="manager_summary"
                    defaultValue={audit.manager_summary ?? ""}
                    placeholder="Private note for audit managers"
                  />
                </label>
                <div className={styles.actions} style={{ marginTop: 12 }}>
                  <button
                    className="button"
                    disabled={submit.pending || !inspection}
                  >
                    {submit.pending
                      ? uploadProgress || "Submitting…"
                      : "Submit audit for review"}
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
            lists={inspection?.lists || null}
          />
        )}
        <aside className={styles.timeline}>
          {(actions.length > 0 || !editable) && (
            <section className={styles.section}>
              <div className={styles.sectionHeader}>
                Corrective actions{" "}
                <span>
                  {
                    actions.filter(
                      (action) => action.status_code !== "completed",
                    ).length
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
          )}
          {canRespond && audit.status_code === "awaiting_station_response" ? (
            <StationResponse
              audit={audit}
              actions={actions}
              workspace={workspace}
              people={inspection?.people || []}
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
          {(comments.length > 0 || !editable) && (
            <section className={styles.section}>
              <div className={styles.sectionHeader}>
                Conversation <span>{comments.length}</span>
              </div>
              <div className={styles.sectionBody}>
                {comments.length ? (
                  comments.map((comment) => (
                    <div className={styles.timelineItem} key={comment.id}>
                      <strong>
                        {comment.author_name ||
                          comment.author_email ||
                          "System"}
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
          )}
          {(evidence.length > 0 || !editable) && (
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
          )}
        </aside>
      </div>
    </section>
  );
}

function AuditCheck({
  item,
  response,
  photos,
  people,
}: {
  item: AuditChecklistItem;
  people: AuditEmployee[];
  photos: StationAuditWorkspace["evidence"];
  response?: { response_value: unknown; remarks: string | null };
}) {
  const options = item.response_options;
  const defaultValue = responseValue(response?.response_value);
  const [outcome, setOutcome] = useState(defaultValue);
  const needsAction = options.find((o) => o.value === outcome)?.requires_action;
  const needsNote =
    item.remarks_required ||
    options.find((o) => o.value === outcome)?.is_compliant === false ||
    outcome === "na";
  if (item.score_source && item.score_source !== "checklist")
    return (
      <div className={styles.check}>
        <strong>{item.label}</strong>
        <span className={styles.photoBadge}>Calculated automatically</span>
        <p className={styles.checkHelp}>{item.guidance}</p>
      </div>
    );
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
              value={outcome}
              onChange={(e) => setOutcome(e.target.value)}
              required={item.is_required}
            >
              <option value="">Select outcome</option>
              {options.map((option) => (
                <option value={option.value} key={option.value}>
                  {option.label}
                  {option.score != null ? ` · ${option.score}/100` : ""}
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
            required={Boolean(needsNote)}
            placeholder={
              item.remarks_required
                ? "Record the verification details requested above"
                : needsNote
                  ? "Explain the finding or why this does not apply"
                  : "Optional observations"
            }
          />
        </label>
      </div>
      {item.employee_selection && item.employee_selection !== "none" && (
        <div className={styles.inputLabel}>
          Employee / key custodian{" "}
          <EmployeePicker
            name={`check_employee_${item.id}`}
            people={people}
            multiple={item.employee_selection === "multiple"}
            required={
              options.find((o) => o.value === outcome)?.is_compliant === true
            }
            initial={
              (response?.response_value as { employees?: AuditEmployee[] })
                ?.employees || []
            }
          />
          <small>
            Select known custodians. Explain any unidentified custodian in
            observations.
          </small>
        </div>
      )}
      {(item.photo_required ||
        (item.photo_on_non_compliance &&
          options.find((o) => o.value === outcome)?.is_compliant ===
            false)) && (
        <div className={styles.checkPhotos}>
          <label className={styles.inputLabel}>
            Photos ·{" "}
            {item.photo_required
              ? "mandatory for every outcome"
              : "evidence of this finding"}
            <input
              type="file"
              name={`check_photo_${item.id}`}
              aria-label={`Photos for ${item.label}`}
              accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
              multiple
              required={!photos.length}
            />
            <small>
              {photos.length
                ? `${photos.length} saved photo(s). Add more if needed.`
                : "Attach clear photos for this check. Up to 30 MB per photo."}
            </small>
          </label>
          <ChecklistPhotos photos={photos} />
        </div>
      )}
      {needsAction && (
        <div className={styles.twoCol}>
          <label className={styles.inputLabel}>
            Corrective action{" "}
            <small>
              Required only when the selected master outcome requires CAPA.
            </small>
            <input
              name={`check_action_${item.id}`}
              placeholder="Owner action / resolution"
              required
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
      )}
    </div>
  );
}

function StationResponse({
  audit,
  actions,
  workspace,
  people,
  run,
  pending,
  notice,
}: {
  audit: StationAudit;
  workspace: StationAuditWorkspace;
  people: AuditEmployee[];
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
            data.set(
              "shipment_responses",
              JSON.stringify(
                workspace.shipments
                  .filter((s) => s.audit_id === audit.id && !s.is_resolved)
                  .map((s) => ({
                    id: s.id,
                    status: data.get(`shipment_status_${s.id}`),
                    remarks: data.get(`shipment_note_${s.id}`),
                    employee_ref: data.get(`shipment_employee_${s.id}`),
                  })),
              ),
            );
            run(async () => {
              await uploadAuditFiles(data);
              return respondToStationAudit(data);
            });
          }}
        >
          <input type="hidden" name="audit_id" value={audit.id} />
          <input type="hidden" name="updated_at" value={audit.updated_at} />
          <ShipmentResponses
            shipments={workspace.shipments.filter(
              (s) => s.audit_id === audit.id,
            )}
            options={workspace.options.filter(
              (o) => o.option_group === "shipment_response_status",
            )}
            people={people}
          />
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
        {!audit.assignment_verified && (
          <small className={styles.fast}>
            Confirm the user in Assign / reassign
          </small>
        )}
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
  const original = auditDay(audit.scheduled_for);
  const slot = auditSlots(type).find(
    (s) =>
      Number(original.slice(-2)) >= s.startDay &&
      Number(original.slice(-2)) <= s.endDay,
  );
  const end = auditMonthRange(original.slice(0, 7)).to;
  const min = `${original.slice(0, 7)}-${String(slot?.startDay || 1).padStart(2, "0")}`;
  const max = `${original.slice(0, 7)}-${String(Math.min(slot?.endDay || 31, Number(end.slice(-2)))).padStart(2, "0")}`;
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
            min={min > auditDay() ? min : auditDay()}
            max={max}
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
        <p className={styles.muted}>
          {slot?.label || "Current slot"}: {min} – {max}. Stay in this month and
          date window.
        </p>
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
  lists,
}: {
  audit: StationAudit;
  workspace: StationAuditWorkspace;
  canManage: boolean;
  lists: { expected: string[]; scanned: string[] } | null;
}) {
  const checks = workspace.responses.filter((row) => row.audit_id === audit.id);
  const money = (value: number | null) =>
    value == null
      ? "Not recorded"
      : `₹${Number(value).toLocaleString("en-IN")}`;
  return (
    <div className={styles.timeline}>
      {audit.score_snapshot && (
        <AuditScore
          snapshot={audit.score_snapshot}
          evidence={workspace.evidence.filter((e) => e.audit_id === audit.id)}
          responses={checks}
        />
      )}
      {canManage && audit.completed_at && audit.status_code !== "closed" && (
        <ScoreReview
          audit={audit}
          options={workspace.options.filter(
            (o) => o.option_group === "audit_responsibility",
          )}
          evidence={workspace.evidence.filter((e) => e.audit_id === audit.id)}
        />
      )}
      {audit.completed_at && (
        <a
          className="button secondary"
          href={`/api/ops-pulse/audits/report/${audit.id}`}
          target="_blank"
          rel="noreferrer"
        >
          Download illustrated audit report (PDF)
        </a>
      )}
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
      {!audit.completed_at && (
        <details className={styles.section} open>
          <summary>
            Read checklist & entry guide <span>Prepare before starting</span>
          </summary>
          <div className={styles.sectionBody}>
            <p className={styles.checkHelp}>
              The assigned auditor selects <b>Start audit</b> to enable data
              entry. Both COD and shipment reconciliation are part of the
              physical audit. This preparation view does not change the audit.
            </p>
            {workspace.auditTypes.find((t) => t.id === audit.audit_type_id)
              ?.shipment_reconciliation_enabled && (
              <div className={styles.preparationGrid}>
                <div>
                  <b>1 · ERP ageing TIDs</b>
                  <p>
                    Paste the tracking-ID column from the system ageing report.
                  </p>
                  <textarea
                    disabled
                    rows={3}
                    placeholder="Paste one system tracking ID per line"
                  />
                </div>
                <div>
                  <b>2 · Physical scan</b>
                  <p>
                    Scan each parcel using a barcode scanner, or paste the scan
                    export.
                  </p>
                  <textarea
                    disabled
                    rows={3}
                    placeholder="Physically scanned tracking IDs"
                  />
                </div>
                <div>
                  <b>3 · Missing / excess</b>
                  <p>
                    Differences appear automatically. Record the finding,
                    station responsibility and evidence for any exclusion.
                  </p>
                  <span className={styles.photoBadge}>
                    Station investigates and responds after submission
                  </span>
                </div>
              </div>
            )}
            <div className={styles.preparationGrid}>
              <div>
                <b>COD · System amount</b>
                <p>Enter the ERP cash balance and attach the ERP screenshot.</p>
              </div>
              <div>
                <b>COD · Available cash</b>
                <p>
                  Count ₹500, ₹200, ₹100 and smaller denominations. The total
                  updates automatically.
                </p>
              </div>
              <div>
                <b>COD · Difference</b>
                <p>
                  Compare expected and counted cash. Record a reason and
                  responsibility assessment if they differ.
                </p>
              </div>
            </div>
            <p className={styles.checkHelp}>
              Expand an area below to read its checks. Weights reflect cash and
              inventory risk first, then hygiene, security and operational
              controls. Scores and photos appear together in the submitted
              report.
            </p>
            {workspace.sections
              .filter(
                (section) =>
                  section.audit_type_id === audit.audit_type_id &&
                  workspace.checklistItems.some(
                    (i) => i.section_id === section.id,
                  ),
              )
              .map((section) => (
                <details className={styles.section} key={section.id}>
                  <summary>
                    {section.name}
                    <span>
                      {section.score_weight
                        ? `${section.score_weight}% weight`
                        : "Checklist"}
                    </span>
                  </summary>
                  <div className={styles.sectionBody}>
                    <p className={styles.checkHelp}>{section.guidance}</p>
                    {workspace.checklistItems
                      .filter((i) => i.section_id === section.id)
                      .map((item) => (
                        <div className={styles.check} key={item.id}>
                          <strong>{item.label}</strong>
                          <p className={styles.checkHelp}>{item.guidance}</p>
                          {item.employee_selection &&
                            item.employee_selection !== "none" && (
                              <span className={styles.photoBadge}>
                                Select station-linked key custodian(s)
                              </span>
                            )}
                          {item.photo_required && (
                            <span className={styles.photoBadge}>
                              Photo required · every outcome
                            </span>
                          )}
                        </div>
                      ))}
                  </div>
                </details>
              ))}
          </div>
        </details>
      )}
      {lists && (
        <details className={styles.section}>
          <summary>
            Shipment lists{" "}
            <span>
              {lists.expected.length} ERP · {lists.scanned.length} physical
            </span>
          </summary>
          <div className={styles.sectionBody}>
            <div className={styles.twoCol}>
              <label className={styles.inputLabel}>
                ERP ageing
                <textarea readOnly rows={8} value={lists.expected.join("\n")} />
              </label>
              <label className={styles.inputLabel}>
                Physically scanned
                <textarea readOnly rows={8} value={lists.scanned.join("\n")} />
              </label>
            </div>
          </div>
        </details>
      )}
      {checks.length > 0 && !audit.score_snapshot && (
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
                  {(
                    (check.response_value as { employees?: AuditEmployee[] })
                      ?.employees || []
                  ).map((p) => (
                    <p key={p.ref}>
                      Key custodian / employee:{" "}
                      <b>
                        {p.employee_code} · {p.full_name}
                      </b>{" "}
                      · {p.designation}
                    </p>
                  ))}
                  <ChecklistPhotos
                    photos={workspace.evidence.filter(
                      (e) =>
                        e.audit_id === audit.id &&
                        e.checklist_item_id === check.checklist_item_id &&
                        e.evidence_kind_code === "checklist_photo",
                    )}
                  />
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
                  {row.station_response ? (
                    <div>
                      <strong>Station: {row.station_response.label}</strong>
                      <p>{row.station_response.remarks}</p>
                      {row.station_response.employee && (
                        <p>
                          {row.station_response.employee.employee_code} ·{" "}
                          {row.station_response.employee.full_name}
                        </p>
                      )}
                      <small>
                        Updated by {row.station_response.responded_name} ·{" "}
                        {formatDateTime(row.station_response.responded_at)}
                      </small>
                    </div>
                  ) : (
                    <span className={styles.photoBadge}>
                      Station response pending
                    </span>
                  )}
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

function AuditControls({
  audit,
  workspace,
}: {
  audit: StationAudit;
  workspace: StationAuditWorkspace;
}) {
  const state = useAction();
  return (
    <div className={styles.controlRow}>
      {audit.status_code === "scheduled" && (
        <details className={styles.reschedule}>
          <summary>Assign / reassign auditor</summary>
          <form
            className={styles.compactForm}
            onSubmit={(e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              state.run(() => manageAuditAssignment(data));
            }}
          >
            <input type="hidden" name="audit_id" value={audit.id} />
            <input type="hidden" name="updated_at" value={audit.updated_at} />
            <input type="hidden" name="operation" value="reassign" />
            <div className={styles.inputLabel}>
              Auditor
              <SearchableSelect
                name="assigned_to"
                required
                defaultValue={
                  audit.assignment_verified ? audit.assigned_to : ""
                }
                placeholder="Search authorized auditor"
                options={workspace.assignees
                  .filter((p) => p.stationIds.includes(audit.location_id))
                  .map((p) => ({ value: p.id, label: p.name, helper: p.role }))}
              />
            </div>
            <label className={styles.inputLabel}>
              Reason
              <input name="reason" required maxLength={500} />
            </label>
            <button className="button compact" disabled={state.pending}>
              Assign auditor
            </button>
            <p role="status">{state.notice}</p>
          </form>
        </details>
      )}
    </div>
  );
}

function DeleteAuditForm({
  audit,
  onDeleted,
  onCancel,
}: {
  audit: StationAudit;
  onDeleted: () => void;
  onCancel: () => void;
}) {
  const state = useAction();
  return (
    <section
      className={styles.deletePanel}
      id={`delete-${audit.id}`}
      aria-label="Confirm audit deletion"
    >
      <strong>Delete this audit?</strong>
      <form
        className={styles.compactForm}
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          state.run(async () => {
            const result = await manageAuditAssignment(data);
            if (result.ok) onDeleted();
            return result;
          });
        }}
      >
        <input type="hidden" name="audit_id" value={audit.id} />
        <input type="hidden" name="updated_at" value={audit.updated_at} />
        <input type="hidden" name="operation" value="delete" />
        <p>
          Remove {audit.audit_number} from the schedule and tracker. Saved
          history and evidence are retained for traceability.
        </p>
        <label className={styles.inputLabel}>
          Reason for deletion
          <input name="reason" required maxLength={500} />
        </label>
        <label>
          <input type="checkbox" required /> Confirm deletion of this audit
        </label>
        <button className="button compact" disabled={state.pending}>
          Confirm delete
        </button>
        <button
          type="button"
          className="button secondary compact"
          onClick={onCancel}
          disabled={state.pending}
        >
          Cancel
        </button>
        <p role="status">{state.notice}</p>
      </form>
    </section>
  );
}
function ChecklistPhotos({
  photos,
}: {
  photos: StationAuditWorkspace["evidence"];
}) {
  if (!photos.length) return null;
  return (
    <div className={styles.photoLinks}>
      {photos.map((photo) => (
        <a
          key={photo.id}
          href={`/api/ops-pulse/audits/evidence/${photo.id}`}
          target="_blank"
          rel="noreferrer"
        >
          View photo · {photo.file_name || "Inspection proof"}
        </a>
      ))}
    </div>
  );
}
