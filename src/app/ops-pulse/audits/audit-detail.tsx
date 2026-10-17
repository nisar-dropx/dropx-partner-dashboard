"use client";
import {
  auditEvidenceSubmitError,
  isAuditEvidenceFolder,
  isAuditDriveLink,
} from "@/lib/ops-pulse/station-audit-evidence";
import {
  AuditScore,
  ResponsibilityAssessment,
  ScoreReview,
} from "./audit-score";
import { AuditDownloads } from "./audit-downloads";
import {
  ShipmentResponses,
  clearShipmentResponseDraft,
} from "./shipment-responses";
import {
  applyAuditDraft,
  clearAuditDraft,
  loadAuditDraft,
  parseAuditDraft,
  preferAuditDraft,
  readAuditDraftText,
  saveAuditDraft,
} from "./audit-draft";
import { EvidencePreview } from "@/components/evidence-preview";
import { AuditEmailDelivery } from "./audit-email-delivery";
import {
  uploadAuditFiles,
  type UploadedAuditFile,
} from "@/lib/ops-pulse/station-audit-upload";
import { SearchableSelect } from "@/components/searchable-select";
import {
  auditMonthRange,
  auditResponseLabel,
} from "@/lib/ops-pulse/station-audit-planning";
import {
  ShipmentInspection,
  EmployeePicker,
} from "./shipment-inspection";
import {
  auditKeyCustodianPeople,
  type AuditEmployee,
} from "@/lib/ops-pulse/station-audit-reconciliation";
import { useEffect, useRef, useState, useTransition } from "react";
import {
  loadAuditInspectionContext,
  addAuditManagerComment,
  beginStationAudit,
  closeStationAudit,
  respondToStationAudit,
  submitStationAudit,
  saveStationAuditDraft,
  loadStationAuditDraft,
  clearStationAuditDraft,
  rescheduleStationAudit,
  changeStationAudit,
  manageAuditAssignment,
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
  isUnscheduledAudit,
  auditStatusLabel,
  addAuditDays,
  auditSlots,
} from "@/lib/ops-pulse/station-audit-planning";
import { StationSnapshot } from "./audit-station-snapshot";
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
const selectedProofCount = (form: HTMLFormElement) => {
  let count = 0;
  for (const element of Array.from(form.elements)) {
    if (!(element instanceof HTMLInputElement) || element.type !== "file")
      continue;
    count += Array.from(element.files || []).filter((file) => file.size > 0)
      .length;
  }
  return count;
};
const formHasFeedback = (data: FormData) => {
  if (value(data.get("overall_summary")).trim()) return true;
  if (value(data.get("manager_summary")).trim()) return true;
  if (value(data.get("evidence_caption")).trim()) return true;
  for (const [key, entry] of data.entries())
    if (key.startsWith("check_note_") && value(entry).trim()) return true;
  return false;
};
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
  const [draftEvidence, setDraftEvidence] = useState<
    StationAuditWorkspace["evidence"]
  >([]);
  const [draftUploading, setDraftUploading] = useState(false);
  const editable =
    canPerform && (audit.status_code === "in_progress" || editing);
  const type = workspace.auditTypes.find(
    (row) => row.id === audit.audit_type_id,
  );
  const station =
    workspace.stations.find((row) => row.id === audit.location_id) ||
    workspace.crossStations.find((row) => row.id === audit.location_id);
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
      dueAt: row.due_at ? auditDay(row.due_at) : "",
    })),
  );
  const submit = useAction();
  const lifecycle = useAction();
  // Entries are kept on this device while the audit is in progress.
  const formRef = useRef<HTMLFormElement>(null);
  const shipmentsRef = useRef(shipments);
  shipmentsRef.current = shipments;
  const draftReady = useRef(false);
  const submitting = useRef(false);
  const draftEpoch = useRef(0);
  const draftTimer = useRef<number | null>(null);
  const [draftNotice, setDraftNotice] = useState("");
  const [restoredNotes, setRestoredNotes] = useState<Record<
    string,
    string
  > | null>(null);
  const draftTime = (iso: string) =>
    new Date(iso).toLocaleTimeString("en-IN", {
      hour: "2-digit",
      minute: "2-digit",
    });
  // The server copy lets the auditor continue on another device. It is sent at
  // most once every 20 seconds, and straight away from the Save draft button.
  const serverTimer = useRef<number | null>(null);
  const serverDirty = useRef(false);
  const pushDraftToServer = async (announce: boolean) => {
    if (serverTimer.current) {
      window.clearTimeout(serverTimer.current);
      serverTimer.current = null;
    }
    const epoch = draftEpoch.current;
    const text = readAuditDraftText(audit.id);
    if (!text || !serverDirty.current || submitting.current) return;
    serverDirty.current = false;
    try {
      const result = await saveStationAuditDraft(audit.id, text);
      if (
        !draftReady.current ||
        submitting.current ||
        epoch !== draftEpoch.current
      )
        return;
      if (result.ok && announce)
        setDraftNotice(
          `Draft saved to your account at ${draftTime(new Date().toISOString())}. You can continue on another device. Attached files are saved to the audit.`,
        );
      else {
        serverDirty.current = true;
        if (announce)
          setDraftNotice(
            `Draft saved on this device only. ${result.message}`,
          );
      }
    } catch {
      serverDirty.current = true;
      if (announce && draftReady.current)
        setDraftNotice(
          "Draft saved on this device only. The server could not be reached; it will retry.",
        );
    }
  };
  const saveDraft = (announce: boolean) => {
    if (submitting.current || !formRef.current || !draftReady.current) return;
    const remarks = formRef.current.elements.namedItem("tid_remarks");
    const savedAt = saveAuditDraft(audit.id, formRef.current, {
      shipments: shipmentsRef.current,
      tidRemarks: remarks instanceof HTMLInputElement ? remarks.value : "",
    });
    if (!savedAt) {
      if (announce)
        setDraftNotice("The draft could not be saved on this device.");
      return;
    }
    serverDirty.current = true;
    if (announce) {
      setDraftNotice("Saving draft…");
      void pushDraftToServer(true);
      return;
    }
    setDraftNotice(
      `Draft saved on this device at ${draftTime(savedAt)}. Click Save draft to keep attached files.`,
    );
    if (!serverTimer.current)
      serverTimer.current = window.setTimeout(
        () => void pushDraftToServer(false),
        20000,
      );
  };
  // Save draft also uploads any attached check, cash and evidence files to the
  // audit, so they stay saved instead of having to be chosen again later.
  const draftFileFields = (name: string) =>
    name.startsWith("check_photo_") ||
    ["evidence_files", "erp_evidence", "variance_evidence"].includes(name);
  const saveDraftWithFiles = async () => {
    const form = formRef.current;
    if (!form || submitting.current || !draftReady.current) return;
    const inputs = (
      Array.from(form.elements).filter(
        (element) =>
          element instanceof HTMLInputElement &&
          element.type === "file" &&
          draftFileFields(element.name) &&
          (element.files?.length ?? 0) > 0,
      ) as HTMLInputElement[]
    );
    if (!inputs.length) {
      saveDraft(true);
      return;
    }
    const data = new FormData();
    data.set("audit_id", audit.id);
    for (const input of inputs)
      for (const file of Array.from(input.files ?? []))
        data.append(input.name, file);
    setDraftUploading(true);
    const uploaded: UploadedAuditFile[] = [];
    try {
      await uploadAuditFiles(
        data,
        (done, total) =>
          setDraftNotice(total ? `Saving files ${done} / ${total}…` : ""),
        (file) => uploaded.push(file),
      );
      for (const input of inputs) input.value = "";
      saveDraft(true);
    } catch (error) {
      setDraftNotice(
        `${error instanceof Error ? error.message : "Files could not be saved."} Your typed entries are kept; try Save draft again.`,
      );
      saveDraft(false);
    } finally {
      // Files that finished before any failure are saved on the audit either way.
      if (uploaded.length) {
        const now = new Date().toISOString();
        setDraftEvidence((current) => [
          ...current,
          ...uploaded.map((file) => ({
            id: file.evidenceId,
            audit_id: audit.id,
            file_name: file.fileName,
            media_url: "",
            caption: null,
            evidence_kind_code: file.evidenceKind,
            checklist_item_id: file.checklistItemId,
            content_type: file.contentType,
            uploaded_at: now,
          })),
        ]);
      }
      setDraftUploading(false);
    }
  };
  const formReady = editable && !!inspection;
  useEffect(() => {
    if (!formReady || draftReady.current) return;
    if (audit.status_code !== "in_progress") {
      // A submitted audit reopened for correction starts from the saved record.
      clearAuditDraft(audit.id);
      draftReady.current = true;
      return;
    }
    type Extra = { shipments?: ShipmentDraft[]; tidRemarks?: string };
    let cancelled = false;
    let timers: number[] = [];
    void (async () => {
      const local = loadAuditDraft<Extra>(audit.id);
      // Whichever copy is newer wins: this device's, or the one saved to the account.
      let remote: ReturnType<typeof parseAuditDraft<Extra>> = null;
      try {
        remote = parseAuditDraft<Extra>(
          (await loadStationAuditDraft(audit.id)).draft,
        );
      } catch {
        remote = null;
      }
      if (cancelled) return;
      const draft = preferAuditDraft(local, remote);
      const fromServer = draft != null && draft === remote;
      if (!draft) {
        draftReady.current = true;
        return;
      }
      if (Array.isArray(draft.extra?.shipments))
        setShipments(draft.extra.shipments);
      try {
        const notes = JSON.parse(draft.extra?.tidRemarks || "{}");
        if (notes && typeof notes === "object") setRestoredNotes(notes);
      } catch {
        // An unreadable observation list is ignored; the rest of the draft still applies.
      }
      // Fields that depend on other entries (a variance reason, an exception row)
      // only exist after the first pass, so apply the draft again shortly after.
      timers = [0, 250, 800].map((delay, pass) =>
        window.setTimeout(() => {
          if (cancelled) return;
          if (formRef.current) applyAuditDraft(formRef.current, draft);
          if (pass === 2) {
            draftReady.current = true;
            setDraftNotice(
              `Your draft from ${new Date(draft.savedAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} was restored${fromServer ? " from your account" : ""}. Attach files again before submitting.`,
            );
          }
        }, delay),
      );
    })();
    return () => {
      cancelled = true;
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [formReady, audit.id, audit.status_code]);
  useEffect(
    () => () => {
      if (draftTimer.current) window.clearTimeout(draftTimer.current);
      if (serverTimer.current) window.clearTimeout(serverTimer.current);
      // Closing the audit sends any unsent draft so it is not left on this device only.
      const text = serverDirty.current ? readAuditDraftText(audit.id) : null;
      if (text) void saveStationAuditDraft(audit.id, text).catch(() => undefined);
    },
    [audit.id],
  );
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
  const savedEvidence = workspace.evidence.filter(
    (row) => row.audit_id === audit.id,
  );
  // Files uploaded by Save draft count as saved proof straight away, before the
  // workspace is next reloaded.
  const evidence = [
    ...savedEvidence,
    ...draftEvidence.filter(
      (row) => !savedEvidence.some((saved) => saved.id === row.id),
    ),
  ];
  const supportingEvidence = evidence.filter(
    (row) => row.evidence_kind_code === "document" && !row.checklist_item_id,
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
  const recordingRequired = Boolean(
    type.requires_video_link || audit.ops_audit_types?.requires_video_link,
  );
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
            {isUnscheduledAudit(audit) ? " · Unscheduled" : ""}
            {audit.cross_station ? " · Cross-station auditor" : ""}
          </p>
        </div>
        <div className={styles.actions}>
          {audit.completed_at && (
            <AuditDownloads auditId={audit.id} disabled={false} />
          )}
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
      {canManage && audit.status_code !== "closed" && (
        <StationSnapshot auditId={audit.id} />
      )}
      {canManage && (
        <AuditControls
          audit={audit}
          workspace={workspace}
          canPerform={canPerform}
        />
      )}
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
          {canManage && (
            <AuditEmailDelivery
              auditId={audit.id}
              sent={audit.email_status === "sent"}
            />
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
            ref={formRef}
            noValidate
            // Buttons inside the form (bulk fill, scan, add a row) change entries
            // without a field event, so a click schedules the draft save as well.
            onClickCapture={(event) => {
              const button = (event.target as HTMLElement | null)?.closest(
                "button",
              );
              // Submit must not be recorded as another draft save.
              if (
                button instanceof HTMLButtonElement &&
                button.type === "submit"
              )
                return;
              if (draftTimer.current) window.clearTimeout(draftTimer.current);
              draftTimer.current = window.setTimeout(() => saveDraft(false), 1500);
            }}
            onChange={(event) => {
              if (draftTimer.current) window.clearTimeout(draftTimer.current);
              draftTimer.current = window.setTimeout(() => saveDraft(false), 1500);
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
              draftEpoch.current += 1;
              submitting.current = true;
              if (draftTimer.current) window.clearTimeout(draftTimer.current);
              draftTimer.current = null;
              if (serverTimer.current) window.clearTimeout(serverTimer.current);
              serverTimer.current = null;
              setDraftNotice("");
              const form = event.currentTarget;
              const data = new FormData(form);
              const due = form.elements.namedItem("action_due_at");
              if (
                due instanceof HTMLInputElement &&
                due.value &&
                !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(due.value)
              )
                data.delete("action_due_at");
              const proofs = selectedProofCount(form);
              data.set("attached_evidence_count", String(proofs));
              data.set("shipments_json", JSON.stringify(shipments));
              const link = value(data.get("video_call_url")).trim();
              const block = auditEvidenceSubmitError(
                recordingRequired,
                link,
                value(data.get("video_access_confirmed")),
                proofs > 0 || evidence.length > 0,
                formHasFeedback(data),
              );
              if (block) {
                submitting.current = false;
                const field = form.elements.namedItem(
                  link && isAuditEvidenceFolder(link)
                    ? "video_access_confirmed"
                    : "video_call_url",
                );
                if (field instanceof HTMLElement) {
                  const details = field.closest("details");
                  if (details) details.open = true;
                  field.scrollIntoView({ block: "center" });
                  field.focus();
                }
                submit.run(async () => ({ ok: false, message: block }));
                return;
              }
              submit.run(async () => {
                try {
                  await uploadAuditFiles(data, (done, total) =>
                    setUploadProgress(
                      total ? `Uploading proof ${done} / ${total}…` : "",
                    ),
                  );
                  setUploadProgress("Saving audit…");
                  const result = await submitStationAudit(data);
                  if (result.ok) {
                    if (draftTimer.current)
                      window.clearTimeout(draftTimer.current);
                    if (serverTimer.current)
                      window.clearTimeout(serverTimer.current);
                    serverTimer.current = null;
                    serverDirty.current = false;
                    draftReady.current = false;
                    clearAuditDraft(audit.id);
                    void clearStationAuditDraft(audit.id).catch(
                      () => undefined,
                    );
                    setDraftNotice("");
                  }
                  return result;
                } finally {
                  submitting.current = false;
                }
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
              </div>
            </details>
            {type?.shipment_reconciliation_enabled ? (
              inspection ? (
                <ShipmentInspection
                  onDifferences={setDifferenceKeys}
                  restoredNotes={restoredNotes}
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
                    <input
                      type="file"
                      name="evidence_files"
                      multiple
                      accept="image/*,application/pdf,.xlsx,.xls,.csv"
                    />
                    <small>Images, PDF, Excel or CSV · up to 30 MB each</small>
                    {supportingEvidence.length ? (
                      <ChecklistPhotos photos={supportingEvidence} />
                    ) : null}
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
                        audit.completed_at && audit.response_due_at
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
                {recordingRequired ? (
                  <div className={styles.twoCol} style={{ marginTop: 12 }}>
                    <label className={styles.inputLabel}>
                      Google Drive evidence folder
                      <small>
                        {type.video_link_help ||
                          audit.ops_audit_types?.video_link_help ||
                          "Upload the video-call screen recording and audit photos to one Google Drive folder. Set General access to Anyone with the link and role to Viewer, then paste the folder link here."}{" "}
                        Attached evidence files plus written feedback can be
                        submitted without this folder.
                      </small>
                      <input
                        name="video_call_url"
                        type="url"
                        defaultValue={audit.video_call_url ?? ""}
                        placeholder="https://drive.google.com/drive/folders/..."
                      />
                    </label>
                    <label className={styles.inputLabel}>
                      Recording, photos & viewing access
                      <select name="video_access_confirmed" defaultValue="">
                        <option value="">Not using a Drive folder</option>
                        <option value="yes">
                          Confirmed — uploaded and shared for viewing
                        </option>
                      </select>
                    </label>
                  </div>
                ) : null}
                <div className={styles.actions} style={{ marginTop: 12 }}>
                  <button
                    type="submit"
                    formNoValidate
                    className="button"
                    disabled={submit.pending || draftUploading || !inspection}
                  >
                    {submit.pending
                      ? uploadProgress || "Submitting…"
                      : "Submit audit for review"}
                  </button>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={submit.pending || draftUploading || !inspection}
                    onClick={() => void saveDraftWithFiles()}
                  >
                    {draftUploading ? "Saving files…" : "Save draft"}
                  </button>
                  {submit.notice ? (
                    <span className={styles.notice}>{submit.notice}</span>
                  ) : null}
                </div>
                {draftNotice ? (
                  <p className={styles.checkHelp} role="status">
                    {draftNotice}
                  </p>
                ) : null}
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
                    <EvidencePreview
                      key={item.id}
                      className={styles.photoLink}
                      href={`/api/ops-pulse/audits/evidence/${item.id}`}
                      label={item.file_name || item.evidence_kind_code || "Evidence"}
                      fileName={item.file_name}
                      contentType={item.content_type}
                    />
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
            people={auditKeyCustodianPeople(people)}
            multiple={item.employee_selection === "multiple"}
            required={
              options.find((o) => o.value === outcome)?.is_compliant === true
            }
            initial={
              (response?.response_value as { employees?: AuditEmployee[] })
                ?.employees || []
            }
            placeholder="Search SSA, TL, SM or other UTR staff"
            emptyHint="No station UTR staff (SSA, TL, SM…) are linked to this station. Update People station mapping — delivery associates are not listed as key custodians."
            maxOptions={200}
          />
          <small>
            Select known UTR custodians (SSA, TL, SM…). Delivery associates (DA /
            DSA) are not listed here. Explain any unidentified custodian in
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
              accept="image/*,application/pdf,.xlsx,.xls,.csv"
              multiple
              required={!photos.length}
            />
            <small>
              {photos.length
                ? `${photos.length} saved file(s). Add more if needed.`
                : "Attach photos, PDF, Excel or CSV for this check. Up to 30 MB each."}
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
  // The overall response text is kept on this device alongside the shipment answers.
  const responseTextKey = `station-audit-response-text:${audit.id}`;
  const [responseText, setResponseText] = useState("");
  useEffect(() => {
    try {
      setResponseText(window.localStorage.getItem(responseTextKey) || "");
    } catch {
      // Storage is unavailable; start with an empty response.
    }
  }, [responseTextKey]);
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
            // The shipment list is paged, so its answers arrive as one field.
            let answers: Array<{
              id: string;
              tracking_id: string;
              status: string;
              remarks: string;
              employee_ref: string;
              complete: boolean;
            }> = [];
            try {
              answers = JSON.parse(
                String(data.get("shipment_responses_state") || "[]"),
              );
            } catch {
              answers = [];
            }
            data.delete("shipment_responses_state");
            data.delete("bulk_shipment_employee");
            for (const key of Array.from(data.keys()))
              if (key.startsWith("shipment_employee_view_")) data.delete(key);
            const pending = answers.filter((answer) => !answer.complete);
            if (pending.length) {
              run(async () => ({
                ok: false,
                message: `${pending.length} of ${answers.length} shipments still need a status and remarks${pending.length <= 3 ? ` (${pending.map((p) => p.tracking_id).join(", ")})` : ""}. Choose "Not answered" in the list to see them. Your answers so far are saved on this device.`,
              }));
              return;
            }
            data.set(
              "shipment_responses",
              JSON.stringify(
                answers.map(({ id, status, remarks, employee_ref }) => ({
                  id,
                  status,
                  remarks,
                  employee_ref,
                })),
              ),
            );
            run(async () => {
              await uploadAuditFiles(data);
              const result = await respondToStationAudit(data);
              if (result.ok) {
                clearShipmentResponseDraft(audit.id);
                try {
                  window.localStorage.removeItem(responseTextKey);
                } catch {
                  // Storage is unavailable; nothing to clear.
                }
              }
              return result;
            });
          }}
        >
          <input type="hidden" name="audit_id" value={audit.id} />
          <input type="hidden" name="updated_at" value={audit.updated_at} />
          <ShipmentResponses
            auditId={audit.id}
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
              value={responseText}
              onChange={(event) => {
                setResponseText(event.target.value);
                try {
                  window.localStorage.setItem(
                    responseTextKey,
                    event.target.value,
                  );
                } catch {
                  // Storage is unavailable; the text stays on screen.
                }
              }}
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
                defaultValue={
                  audit.response_due_at
                    ? `${auditDay(audit.response_due_at)}T${auditLocalTime(audit.response_due_at)}`
                    : ""
                }
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
  const unscheduled = isUnscheduledAudit(audit);
  const end = auditMonthRange(original.slice(0, 7)).to;
  // Earlier dates are open, up to 31 days back for a visit already made.
  const min = addAuditDays(auditDay(), -31);
  const max = unscheduled
    ? undefined
    : `${original.slice(0, 7)}-${String(Math.min(slot?.endDay || 31, Number(end.slice(-2)))).padStart(2, "0")}`;
  // A date input whose minimum is after its maximum can never be submitted.
  if (max && min > max)
    return (
      <details className={styles.reschedule}>
        <summary>Change audit date</summary>
        <p className={styles.muted}>
          {slot?.label || "This slot"} ended on {max}, more than 31 days ago,
          so this audit’s date can no longer be changed. Start it now or
          schedule the station’s next audit.
        </p>
      </details>
    );
  return (
    <details className={styles.reschedule}>
      <summary>Change audit date · earlier, later or a past visit</summary>
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
            min={min}
            max={max}
            defaultValue={original < min ? min : original}
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
          {unscheduled
            ? "Any date, up to 31 days back for a visit already made."
            : `Bring it forward to any earlier date, up to 31 days back for a visit already made. It can be postponed only until ${max} (${slot?.label || "its window"}). To begin today without changing the date, use Start audit.`}
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
              {(audit.video_call_url ||
                audit.ops_audit_types?.requires_video_link) && (
                <section
                  style={{
                    padding: 16,
                    marginTop: 16,
                    border: "1px solid #cbd5e1",
                    borderRadius: 10,
                    background: "#f8fafc",
                  }}
                  aria-label="COD recording and photo evidence"
                >
                  <strong>Video-call recording &amp; audit photos</strong>
                  {audit.video_call_url &&
                  isAuditDriveLink(audit.video_call_url) ? (
                    <>
                      <p>
                        <a
                          className="button secondary compact"
                          href={audit.video_call_url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {isAuditEvidenceFolder(audit.video_call_url)
                            ? "Open Google Drive evidence folder"
                            : "Open saved audit recording"}{" "}
                          ↗
                        </a>
                      </p>
                      <small>
                        {isAuditEvidenceFolder(audit.video_call_url)
                          ? "Folder for the screen recording and audit photos. Auditor confirms Anyone with the link — Viewer access."
                          : "This older audit has an individual recording link. New submissions require one shared Drive folder containing the recording and photos."}
                      </small>
                    </>
                  ) : (
                    <p className="fin-negative">
                      Required evidence folder has not been recorded for this
                      audit.
                    </p>
                  )}
                </section>
              )}
            </>
          )}
        </div>
      </section>
      {!audit.completed_at && (
        <details className={styles.section}>
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
                {row.event_type === "type_changed" && (
                  <p>
                    {String(row.before_data.type_name || "Audit")} →{" "}
                    {String(row.after_data.type_name || "Audit")}
                    <br />
                    {String(row.after_data.reason || "")}
                  </p>
                )}
                {row.event_type === "reassigned" &&
                  Boolean(row.after_data.assigned_name) && (
                    <p>
                      {String(row.before_data.assigned_name || "Unassigned")} →{" "}
                      {String(row.after_data.assigned_name)}
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

/**
 * Change the audit type, the auditor, or both in one save. The auditor can be
 * changed until the audit starts; the type until it is submitted, and once
 * fieldwork has begun only by the auditor doing it.
 */
function AuditControls({
  audit,
  workspace,
  canPerform,
}: {
  audit: StationAudit;
  workspace: StationAuditWorkspace;
  canPerform: boolean;
}) {
  const state = useAction();
  const [typeId, setTypeId] = useState(audit.audit_type_id);
  const unstarted = audit.status_code === "scheduled";
  const editable =
    !audit.completed_at &&
    (unstarted || (audit.status_code === "in_progress" && canPerform));
  if (!editable) return <div className={styles.controlRow} />;
  const types = workspace.auditTypes.filter(
    (type) => type.is_active || type.id === audit.audit_type_id,
  );
  return (
    <div className={styles.controlRow}>
      <details className={styles.reschedule}>
        <summary>
          {unstarted ? "Change audit · type or auditor" : "Change audit type"}
        </summary>
        <form
          className={styles.compactForm}
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            state.run(() => changeStationAudit(data));
          }}
        >
          <input type="hidden" name="audit_id" value={audit.id} />
          <input type="hidden" name="updated_at" value={audit.updated_at} />
          <label className={styles.inputLabel}>
            Audit type
            <select
              name="audit_type_id"
              value={typeId}
              onChange={(e) => setTypeId(e.target.value)}
            >
              {types.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                </option>
              ))}
            </select>
          </label>
          {unstarted && (
            <div className={styles.inputLabel}>
              Auditor
              <SearchableSelect
                name="assigned_to"
                required
                defaultValue={
                  audit.assignment_verified ? audit.assigned_to : ""
                }
                placeholder="Search authorized auditor"
                maxOptions={200}
                options={workspace.assignees
                  .filter(
                    (p) =>
                      workspace.anyStation ||
                      p.stationIds.includes(audit.location_id),
                  )
                  .map((p) => ({
                    value: p.id,
                    label: p.name,
                    helper: p.stationIds.includes(audit.location_id)
                      ? p.role
                      : `${p.role} · another station’s team`,
                  }))}
              />
            </div>
          )}
          <label className={styles.inputLabel}>
            Reason
            <input
              name="reason"
              required
              maxLength={500}
              placeholder="Why is this changing?"
            />
          </label>
          <button className="button compact" disabled={state.pending}>
            {state.pending ? "Saving…" : "Save changes"}
          </button>
          <p role="status">
            {state.notice ||
              (typeId !== audit.audit_type_id
                ? "The checklist switches to the new type. Station, auditor, time and shared entries are kept; answers that belong only to the old checklist are not carried over."
                : "Both changes are saved together and recorded in the audit history.")}
          </p>
        </form>
      </details>
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
        <EvidencePreview
          key={photo.id}
          className={styles.photoLink}
          href={`/api/ops-pulse/audits/evidence/${photo.id}`}
          label={`View file · ${photo.file_name || "Inspection proof"}`}
          fileName={photo.file_name}
          contentType={photo.content_type}
        />
      ))}
    </div>
  );
}
