"use client";
import {
  useState,
  useEffect,
  useRef,
  useTransition,
  type Dispatch,
  type SetStateAction,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import {
  questions,
  emptyAnswer,
  applyResponse,
  auditTypeLabels,
  isCount,
  isScored,
  scoreSnapshot,
  scoreBand,
  statusLabels,
  collectInspectionGaps,
  requiredEvidence,
  type AuditType,
  type StoreAudit,
  type Proof,
  type Answer,
  type Question,
  type ExtraField,
} from "@/lib/ops-pulse/store-audits/model";
import {
  auditScore,
  auditBand,
  readiness,
  topFailedQuestions,
  openActions,
  mockVsAmazon,
  repeatFailures,
} from "@/lib/ops-pulse/store-audits/reports";
import type { AuditAssignee } from "@/lib/ops-pulse/station-audit-people";
import { EvidencePreview } from "@/components/evidence-preview";
import { OpsConfirmDialog } from "@/components/ops-confirm-dialog";
import { OpsLiveCamera } from "@/components/ops-live-camera";
import {
  prepareProofFile,
  readProofGps,
} from "@/lib/ops-pulse/proof-media";
import {
  scheduleStoreAudit,
  startStoreAudit,
  saveStoreInspection,
  respondStoreFinding,
  reviewStoreFinding,
  deleteStoreAudit,
  resendStoreAudit,
} from "./actions";
import styles from "./store-audits.module.css";
const date = (v: string | null) =>
  v
    ? new Date(v).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        dateStyle: "medium",
        timeStyle: "short",
      }) + " IST"
    : "—";
const localTime = (v: string) => {
  if (!v) return "";
  const d = new Date(v);
  if (!Number.isFinite(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value || "";
  const hour = g("hour") === "24" ? "00" : g("hour");
  return `${g("year")}-${g("month")}-${g("day")}T${hour}:${g("minute")}`;
};
const extraFieldInputType = (f: ExtraField) =>
  f.id === "expiry_date" ? "date" : f.type === "number" ? "number" : "text";
const responseLabel = (a: Answer) => {
  if (a.response === "yes") return "Yes";
  if (a.response === "no") return "No";
  if (a.response === "na" || a.outcome === "na") return "N/A";
  if (a.outcome === "pass") return "Compliant";
  if (a.outcome === "gap") return "Non-compliant";
  return "—";
};
type Props = {
  locations: {
    id: string;
    station_code: string;
    station_name: string | null;
  }[];
  audits: StoreAudit[];
  assignees: AuditAssignee[];
  manager: boolean;
  focused: StoreAudit | null;
  evidence: Proof[];
  error: string;
  from: string;
  to: string;
  userId: string;
  canSchedule: boolean;
  canEdit: boolean;
  canInspect: boolean;
  canRespond: boolean;
  canDelete: boolean;
  canDeleteDraft: boolean;
  isMasterOwner: boolean;
  canMaster: boolean;
};
function ProofFiles({
  audit,
  q,
  phase,
  proofs,
  setProofs,
  editable,
  userId,
  onError,
  storeLabel,
}: {
  audit: StoreAudit;
  q: Question;
  phase: "audit" | "response";
  proofs: Proof[];
  setProofs: Dispatch<SetStateAction<Proof[]>>;
  editable: boolean;
  userId: string;
  onError: (e: string) => void;
  storeLabel?: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [liveOpen, setLiveOpen] = useState(false);
  const camInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const existing = proofs.filter(
    (p) => p.question_id === q.id && p.phase === phase,
  );
  const rule = phase === "audit" ? q.evidence : q.responseEvidence;
  const room = Math.max(0, rule.max - existing.length);
  const call = async (data: Record<string, unknown>) => {
    const r = await fetch("/api/ops-pulse/store-audits/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        auditId: audit.id,
        questionId: q.id,
        kind: phase,
        ...data,
      }),
    });
    const j = await r.json();
    if (!r.ok) throw Error(j.error || "Upload failed.");
    return j;
  };
  const inferMime = (file: File) => {
    const extension = file.name.split(".").pop()?.toLowerCase() || "";
    return (
      file.type ||
      (
        {
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          png: "image/png",
          webp: "image/webp",
          heic: "image/heic",
          heif: "image/heif",
          pdf: "application/pdf",
        } as Record<string, string>
      )[extension] ||
      "image/jpeg"
    );
  };
  const uploadFiles = async (files: FileList | File[]) => {
    const list = Array.from(files).slice(0, room);
    if (!list.length) {
      onError("No file was selected. Try Take, Live, or Attach again.");
      return;
    }
    if (list.length + existing.length > rule.max) {
      onError(`Use up to ${rule.max} files for this question.`);
      return;
    }
    setBusy(true);
    setStatus("Getting location…");
    onError("");
    try {
      if (!supabase) throw Error("Upload service unavailable.");
      const gps = await readProofGps(4500);
      let index = 0;
      for (const raw of list) {
        index += 1;
        setStatus(
          list.length > 1
            ? `Processing ${index}/${list.length}…`
            : "Compressing & stamping…",
        );
        const capturedAt = new Date().toISOString();
        const prepared = await prepareProofFile(raw, {
          capturedAt,
          latitude: gps.latitude,
          longitude: gps.longitude,
          accuracyM: gps.accuracyM,
          storeLabel: storeLabel || null,
        });
        const mime = (prepared.type || inferMime(raw)).toLowerCase();
        const file =
          prepared.type === mime
            ? prepared
            : new File(
                [prepared],
                prepared.name || raw.name || `proof-${Date.now()}.jpg`,
                {
                  type: mime,
                  lastModified: prepared.lastModified || Date.now(),
                },
              );
        if (file.size < 1) throw Error("Captured file was empty. Try again.");
        setStatus(
          list.length > 1 ? `Uploading ${index}/${list.length}…` : "Uploading…",
        );
        const signed = await call({
          phase: "prepare",
          fileName: file.name,
          size: file.size,
          contentType: mime,
        });
        const uploaded = await supabase.storage
          .from(signed.bucket)
          .uploadToSignedUrl(signed.path, signed.token, file, {
            contentType: mime,
          });
        if (uploaded.error) throw Error(uploaded.error.message);
        const done = await call({ phase: "complete", id: signed.id });
        setProofs((current) => [...current, done.proof as Proof]);
      }
      setStatus("");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Upload failed.");
      setStatus("");
      throw e;
    } finally {
      setBusy(false);
    }
  };
  const pickFromInput = (input: HTMLInputElement | null) => {
    if (!input?.files?.length) return;
    const files = Array.from(input.files);
    input.value = "";
    void uploadFiles(files).catch(() => undefined);
  };
  const pillKind =
    rule.when === "optional" ? "optional" : rule.when === "gap" ? "gap" : "always";
  const pillText =
    rule.when === "optional"
      ? "Optional"
      : rule.when === "gap"
        ? `${rule.min} required for gaps`
        : `${rule.min} required`;
  return (
    <div className={styles.proof}>
      <div className={styles.inline} style={{ gap: 8, marginBottom: 4 }}>
        <span className={styles.blockLabel} style={{ margin: 0 }}>
          {phase === "audit" ? "Inspection evidence" : "Closure evidence"}
        </span>
        <span className={styles.reqPill} data-kind={pillKind}>
          {pillText} · max {rule.max}
        </span>
      </div>
      <div className={styles.fileList}>
        {existing.map((p) => (
          <span key={p.id}>
            <EvidencePreview
              className={styles.fileLink}
              href={`/api/ops-pulse/store-audits/evidence/${p.id}`}
              label={p.file_name}
              fileName={p.file_name}
              contentType={p.content_type}
            />
            {editable && p.uploaded_by === userId && (
              <button
                type="button"
                aria-label={`Remove ${p.file_name}`}
                disabled={busy}
                onClick={async () => {
                  try {
                    setBusy(true);
                    await call({ phase: "remove", id: p.id });
                    setProofs((current) =>
                      current.filter((x) => x.id !== p.id),
                    );
                  } catch (e) {
                    onError(String(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                ×
              </button>
            )}
          </span>
        ))}
      </div>
      {status ? <small className={styles.proofStatus}>{status}</small> : null}
      {editable && room > 0 ? (
        <div className={styles.proofActions}>
          <input
            ref={camInputRef}
            className={styles.proofFileInput}
            type="file"
            accept="image/*"
            capture="environment"
            disabled={busy}
            onChange={() => pickFromInput(camInputRef.current)}
          />
          <button
            type="button"
            className={styles.proofAdd}
            disabled={busy}
            onClick={() => camInputRef.current?.click()}
          >
            {busy ? "…" : "Take"}
          </button>
          <button
            type="button"
            className={styles.proofAdd}
            disabled={busy}
            onClick={() => setLiveOpen(true)}
          >
            Live
          </button>
          <input
            ref={fileInputRef}
            className={styles.proofFileInput}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf"
            multiple={room > 1}
            disabled={busy}
            onChange={() => pickFromInput(fileInputRef.current)}
          />
          <button
            type="button"
            className={styles.proofAdd}
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
          >
            {busy ? "…" : "Attach"}
          </button>
        </div>
      ) : null}
      {liveOpen ? (
        <OpsLiveCamera
          busy={busy}
          onClose={() => setLiveOpen(false)}
          onCapture={async (file) => {
            await uploadFiles([file]);
          }}
        />
      ) : null}
    </div>
  );
}
export function StoreAuditWorkspace(p: Props) {
  const router = useRouter();
  const [transition, startTransition] = useTransition();
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(p.error),
    [search, setSearch] = useState(""),
    [status, setStatus] = useState("all"),
    [location, setLocation] = useState(""),
    [view, setView] = useState("register"),
    [schedule, setSchedule] = useState(false),
    [scheduleLocation, setScheduleLocation] = useState(
      p.focused?.location_id || p.locations[0]?.id || "",
    ),
    [auditor, setAuditor] = useState(p.focused?.assigned_to || ""),
    [when, setWhen] = useState(
      p.focused ? localTime(p.focused.scheduled_for) : "",
    ),
    [rescheduling, setRescheduling] = useState(false),
    [scheduleAuditType, setScheduleAuditType] = useState<AuditType>(
      p.focused?.audit_type || "mock",
    ),
    [scheduleAmazonScore, setScheduleAmazonScore] = useState(
      p.focused?.amazon_score != null ? String(p.focused.amazon_score) : "",
    ),
    [scheduleAmazonAuditor, setScheduleAmazonAuditor] = useState(
      p.focused?.amazon_auditor || "",
    ),
    [auditTypeFilter, setAuditTypeFilter] = useState("");
  const [audit, setAudit] = useState(p.focused),
    [answers, setAnswers] = useState(p.focused?.answers || {}),
    [summary, setSummary] = useState(p.focused?.summary || ""),
    [proof, setProof] = useState(p.evidence),
    [section, setSection] = useState(p.focused?.template.sections[0]?.id || ""),
    [dirty, setDirty] = useState(false),
    [notes, setNotes] = useState<Record<string, string>>({}),
    [presentSmName, setPresentSmName] = useState(
      p.focused?.present_sm_name || "",
    ),
    [completeAmazonScore, setCompleteAmazonScore] = useState(
      p.focused?.amazon_score != null ? String(p.focused.amazon_score) : "",
    ),
    [completeAmazonAuditor, setCompleteAmazonAuditor] = useState(
      p.focused?.amazon_auditor || "",
    ),
    [startModalOpen, setStartModalOpen] = useState(false),
    [startOverlay, setStartOverlay] = useState(false),
    [startModalName, setStartModalName] = useState(""),
    [completeConfirmOpen, setCompleteConfirmOpen] = useState(false),
    [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false),
    [deleteStep, setDeleteStep] = useState<null | "warn" | "confirm">(null),
    [deleteReason, setDeleteReason] = useState("");
  const dirtyRef = useRef(dirty);
  const focusedIdRef = useRef<string | null>(p.focused?.id ?? null);
  const startingRef = useRef(false);
  dirtyRef.current = dirty;
  // Adopt server props when the focused audit or its saved version changes.
  // Never key this off `dirty` alone: Save draft used to set dirty=false and
  // immediately reload stale page props (often {}), wiping the just-saved form.
  useEffect(() => {
    if (!p.focused) {
      focusedIdRef.current = null;
      setAudit(null);
      setAnswers({});
      setSummary("");
      setProof(p.evidence);
      setDirty(false);
      return;
    }
    const switched = focusedIdRef.current !== p.focused.id;
    focusedIdRef.current = p.focused.id;
    if (!switched && dirtyRef.current) {
      setAudit((current) =>
        current && current.id === p.focused!.id
          ? { ...p.focused!, answers: current.answers, summary: current.summary }
          : p.focused!,
      );
      setProof(p.evidence);
      return;
    }
    setAudit(p.focused);
    setAnswers(p.focused.answers || {});
    setSummary(p.focused.summary || "");
    setProof(p.evidence);
    setDirty(false);
    setPresentSmName(p.focused.present_sm_name || "");
    setCompleteAmazonScore(
      p.focused.amazon_score != null ? String(p.focused.amazon_score) : "",
    );
    setCompleteAmazonAuditor(p.focused.amazon_auditor || "");
    setSection((current) =>
      p.focused!.template.sections.some((s) => s.id === current)
        ? current
        : p.focused!.template.sections[0]?.id || "",
    );
  }, [p.focused?.id, p.focused?.version, p.evidence]);
  useEffect(() => {
    if (!schedule || rescheduling) return;
    if (
      scheduleAuditType === "self" &&
      p.assignees.some(
        (a) => a.id === p.userId && a.stationIds.includes(scheduleLocation),
      )
    )
      setAuditor(p.userId);
  }, [
    schedule,
    rescheduling,
    scheduleAuditType,
    scheduleLocation,
    p.assignees,
    p.userId,
  ]);
  useEffect(() => {
    if (!dirty) return;
    const before = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  }, [dirty]);
  const run = async (
    work: () => Promise<{ ok: boolean; message: string; version?: number }>,
    saved?: { answers: Record<string, Answer>; summary: string },
  ) => {
    setBusy(true);
    setMessage("");
    try {
      const r = await work();
      setMessage(r.message);
      if (r.ok) {
        // Keep the just-saved answers on screen until refresh brings the new version.
        if (audit && r.version) {
          setAudit({
            ...audit,
            version: r.version,
            ...(saved
              ? { answers: saved.answers, summary: saved.summary }
              : {}),
          });
        }
        setDirty(false);
        startTransition(() => router.refresh());
      }
      return r.ok;
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Unable to save.");
      return false;
    } finally {
      setBusy(false);
    }
  };
  const setAnswer = (q: Question, patch: Partial<Answer>) => {
    const old = answers[q.id] || emptyAnswer();
    setAnswers({
      ...answers,
      [q.id]: {
        ...old,
        ...patch,
        ...(patch.outcome === "gap"
          ? {
              action: old.action || q.action,
              owner: old.owner || q.defaultOwner || audit?.store_name || "",
              dueAt:
                old.dueAt ||
                new Date(Date.now() + q.hours * 3600000).toISOString(),
            }
          : {}),
      },
    });
    setDirty(true);
  };
  const setResponse = (q: Question, response: NonNullable<Answer["response"]>) => {
    const old = answers[q.id] || emptyAnswer();
    const next = applyResponse(q, response, old);
    setAnswers({
      ...answers,
      [q.id]: {
        ...next,
        observation: old.observation,
        extras: { ...(old.extras || {}), ...(next.extras || {}) },
      },
    });
    setDirty(true);
  };
  const setCount = (q: Question, count: string) => {
    const old = answers[q.id] || emptyAnswer();
    const ok =
      count.trim() !== "" &&
      Number.isFinite(Number(count)) &&
      Number(count) >= 0;
    setAnswers({
      ...answers,
      [q.id]: {
        ...old,
        extras: { ...(old.extras || {}), count },
        outcome: ok ? "pass" : "",
      },
    });
    setDirty(true);
  };
  const setExtra = (q: Question, fieldId: string, value: string) => {
    const old = answers[q.id] || emptyAnswer();
    setAnswers({
      ...answers,
      [q.id]: {
        ...old,
        extras: { ...(old.extras || {}), [fieldId]: value },
      },
    });
    setDirty(true);
  };
  const fieldVisible = (f: ExtraField, outcome: Answer["outcome"]) =>
    f.when === "always" || (f.when === "gap" && outcome === "gap");
  const inspectionMeta = () => ({
    presentSmName: presentSmName.trim() || undefined,
    amazonScore:
      completeAmazonScore.trim() === ""
        ? null
        : Number(completeAmazonScore),
    amazonAuditor: completeAmazonAuditor.trim() || undefined,
  });
  const canRemoveAudit = (row: StoreAudit) => {
    if (row.completed_at) return p.canDelete;
    return (
      !row.completed_at &&
      ["scheduled", "in_progress"].includes(row.status) &&
      (row.assigned_to === p.userId || p.manager || p.isMasterOwner) &&
      (p.canEdit || p.canSchedule || p.canDelete)
    );
  };
  const runStartInspection = async (smName?: string) => {
    if (!audit || startingRef.current || busy) return;
    const needsGps =
      audit.audit_type === "self" || audit.audit_type === "mock";
    startingRef.current = true;
    setStartOverlay(true);
    setStartModalOpen(false);
    setMessage("");
    try {
      let lat: number | null = null;
      let lng: number | null = null;
      if (needsGps) {
        if (!navigator.geolocation) {
          setMessage(
            "Turn on location services, then try Start again — GPS is required at the store.",
          );
          if (audit.audit_type === "mock") setStartModalOpen(true);
          return;
        }
        try {
          const pos = await new Promise<GeolocationPosition>(
            (resolve, reject) =>
              navigator.geolocation.getCurrentPosition(resolve, reject, {
                enableHighAccuracy: true,
                timeout: 20000,
              }),
          );
          lat = pos.coords.latitude;
          lng = pos.coords.longitude;
        } catch {
          setMessage(
            "Could not read GPS. Stay on site, allow location access, and try again.",
          );
          if (audit.audit_type === "mock") setStartModalOpen(true);
          return;
        }
      }
      if (smName) setPresentSmName(smName);
      await run(() =>
        startStoreAudit(audit.id, audit.version, {
          lat,
          lng,
          presentSmName: smName,
        }),
      );
    } finally {
      startingRef.current = false;
      setStartOverlay(false);
    }
  };
  const startInspection = () => {
    if (!audit) return;
    if (audit.audit_type === "mock") {
      setStartModalName(presentSmName.trim() || audit.present_sm_name || "");
      setStartModalOpen(true);
      return;
    }
    void runStartInspection();
  };
  const confirmDeleteAudit = async () => {
    if (!audit || busy) return;
    const draft = !audit.completed_at;
    const reason = deleteReason.trim() || (draft ? "Draft audit removed" : "");
    if (!reason) {
      setMessage("Add a short reason before deleting.");
      return;
    }
    const ok = await run(() =>
      deleteStoreAudit(audit.id, audit.version, reason),
    );
    if (ok) {
      setDeleteStep(null);
      setDeleteReason("");
      router.push("/store-audits");
    }
  };
  const visible = p.audits.filter(
    (a) =>
      (!auditTypeFilter || a.audit_type === auditTypeFilter) &&
      (!location || a.location_id === location) &&
      (status === "all" || status === "overdue"
        ? status !== "overdue" ||
          a.findings?.some(
            (f) =>
              f.state !== "closed" &&
              Date.parse(a.answers?.[f.questionId]?.dueAt) < Date.now(),
          )
        : a.status === status) &&
      `${a.number} ${a.store_name} ${a.assigned_name}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const blocked = busy || transition;
  if (audit) {
    const sections = audit.template?.sections || [];
    if (!sections.length) {
      return (
        <div className={styles.page}>
          <header className={styles.header}>
            <div>
              <Link href="/store-audits">← Store audits</Link>
              <h1>{audit.store_name}</h1>
              <p>{audit.number}</p>
            </div>
          </header>
          <div className={styles.card}>
            <h2>Checklist unavailable</h2>
            <p className={styles.muted}>
              This audit snapshot has no sections. Open Store Audit Master or
              schedule a new audit from the current checklist.
            </p>
            <Link className={styles.button} href="/store-audits">
              Back to register
            </Link>
          </div>
        </div>
      );
    }
    const current =
      sections.find((s) => s.id === section) || sections[0];
    const completed = Boolean(audit.completed_at);
    const inspection = p.canInspect && !completed;
    const allQs = questions(audit.template);
    const answered = allQs.filter((q) => answers[q.id]?.outcome).length;
    const progressTotal = allQs.length;
    const progressPct =
      progressTotal > 0 ? Math.round((100 * answered) / progressTotal) : 0;
    const inspectionGaps = inspection
      ? collectInspectionGaps(audit, answers, proof, {
          summary,
          presentSmName,
          amazonScore: completeAmazonScore,
          amazonAuditor: completeAmazonAuditor,
        })
      : [];
    const sectionDone = (s: (typeof sections)[number]) =>
      s.questions.every((q) => {
        if (answers[q.id]?.outcome) return true;
        if (audit.audit_type === "amazon" && isScored(q)) return true;
        return !q.required;
      });
    const snap =
      audit.score_snapshot ||
      (completed
        ? scoreSnapshot({ template: audit.template, answers: audit.answers })
        : null);
    const livePct = completed
      ? (audit.score ?? snap?.percentage)
      : scoreSnapshot({ template: audit.template, answers }).percentage;
    const liveBand =
      audit.score_band ??
      scoreBand(typeof livePct === "number" ? livePct : null);
    const saveDraft = () =>
      run(
        () =>
          saveStoreInspection(
            audit.id,
            audit.version,
            answers,
            summary,
            false,
            inspectionMeta(),
          ),
        { answers, summary },
      );
    const releaseAudit = () =>
      run(
        () =>
          saveStoreInspection(
            audit.id,
            audit.version,
            answers,
            summary,
            true,
            inspectionMeta(),
          ),
        { answers, summary },
      );
    return (
      <div className={styles.page}>
        <div className={styles.hero}>
          <p className={styles.eyebrow}>Store audit</p>
          <div className={styles.heroTop}>
            <div>
              <Link
                href="/store-audits"
                onClick={(e) => {
                  if (dirty) {
                    e.preventDefault();
                    setLeaveConfirmOpen(true);
                  }
                }}
              >
                ← Store audits
              </Link>
              <h1>{audit.store_name}</h1>
              <p className={styles.heroMeta}>
                {audit.number} · {audit.template.name} · v
                {audit.template_version}
              </p>
            </div>
            <div className={styles.heroChips}>
              <span className={styles.badge}>
                {auditTypeLabels[audit.audit_type || "mock"]}
              </span>
              <span className={styles.badge} data-state={audit.status}>
                {statusLabels[audit.status]}
              </span>
              {(completed || inspection) && livePct != null ? (
                <span>
                  <span className={styles.band} data-band={liveBand || undefined}>
                    {livePct}%{liveBand ? ` · ${liveBand}` : ""}
                  </span>
                </span>
              ) : null}
            </div>
          </div>
          <div className={styles.heroFacts}>
            <span>
              Auditor<b>{audit.assigned_name}</b>
            </span>
            <span>
              Scheduled<b>{date(audit.scheduled_for)}</b>
            </span>
            <span>
              Started<b>{date(audit.started_at)}</b>
            </span>
            <span>
              Completed<b>{date(audit.completed_at)}</b>
            </span>
            {audit.audit_type === "amazon" &&
              (audit.amazon_score != null || completeAmazonScore) && (
                <span>
                  Amazon score
                  <b>
                    {audit.amazon_score ?? completeAmazonScore}%
                    {audit.amazon_auditor || completeAmazonAuditor
                      ? ` · ${audit.amazon_auditor || completeAmazonAuditor}`
                      : ""}
                  </b>
                </span>
              )}
            {(audit.present_sm_name || presentSmName) && (
              <span>
                SM / SI present
                <b>{audit.present_sm_name || presentSmName}</b>
              </span>
            )}
          </div>
          {completed && snap?.sections?.length ? (
            <div className={styles.sectionScores}>
              {snap.sections.map((s) => (
                <span key={s.id}>
                  {s.name}
                  <b>{s.percentage != null ? `${s.percentage}%` : "—"}</b>
                </span>
              ))}
            </div>
          ) : null}
          <div className={styles.inline} style={{ marginTop: 8 }}>
            {audit.status === "scheduled" &&
              p.canEdit &&
              audit.assigned_to === p.userId && (
                <button
                  className={styles.primary}
                  disabled={blocked}
                  onClick={() => startInspection()}
                >
                  Start inspection
                </button>
              )}
            {audit.status === "scheduled" &&
              p.canEdit &&
              (p.manager ||
                (audit.audit_type === "self" &&
                  audit.assigned_to === p.userId)) && (
              <button
                onClick={() => {
                  setRescheduling(true);
                  setScheduleAuditType(audit.audit_type || "mock");
                  setScheduleAmazonScore(
                    audit.amazon_score != null
                      ? String(audit.amazon_score)
                      : "",
                  );
                  setScheduleAmazonAuditor(audit.amazon_auditor || "");
                  setSchedule(true);
                }}
              >
                Reschedule / reassign
              </button>
            )}
            {completed && (
              <a
                className={styles.button}
                href={`/api/ops-pulse/store-audits/report/${audit.id}`}
              >
                Download PDF
              </a>
            )}
            {completed && p.canEdit && (
              <button
                disabled={blocked}
                onClick={() => run(() => resendStoreAudit(audit.id))}
              >
                Send report again
              </button>
            )}
            {(p.canDeleteDraft || p.canDelete || canRemoveAudit(audit)) && (
              <button
                className={styles.danger}
                disabled={blocked}
                onClick={() => {
                  setDeleteReason("");
                  setDeleteStep("warn");
                }}
              >
                {audit.completed_at ? "Delete audit" : "Delete draft"}
              </button>
            )}
          </div>
          {!completed && (
            <p className={styles.notice} style={{ marginTop: 10, marginBottom: 0 }}>
              Private audit · the store cannot see this until you complete &amp;
              release.
            </p>
          )}
          {completed && (
            <p className={styles.muted} style={{ marginBottom: 0 }}>
              Email:{" "}
              {audit.email_sent_at
                ? `sent ${date(audit.email_sent_at)}`
                : audit.email_error
                  ? "needs attention"
                  : "not sent"}
              {audit.email_error ? ` · ${audit.email_error}` : ""}
              {audit.email_recipients.length
                ? ` · ${audit.email_recipients.join(", ")}`
                : ""}
            </p>
          )}
        </div>
        {audit.audit_type === "amazon" && !completed ? (
          <p className={styles.callout} role="note">
            Log Scout failures only. Unanswered scored questions auto-pass when
            you complete and release.
          </p>
        ) : null}
        {message && (
          <p
            className={
              /saved|updated|sent/i.test(message)
                ? styles.noticeOk
                : styles.notice
            }
            role="status"
          >
            {message}
          </p>
        )}
        {schedule && scheduleForm()}
        {!completed && audit.status === "scheduled" ? (
          <div className={styles.card}>
            <h2>Ready for the visit</h2>
            <p>
              {auditTypeLabels[audit.audit_type || "mock"]} ·{" "}
              {questions(audit.template).length} checks in{" "}
              {audit.template.sections.length} sections. The assigned auditor
              can start the inspection when ready.
            </p>
            {audit.audit_type === "mock" &&
              p.canEdit &&
              audit.assigned_to === p.userId && (
                <p className={styles.muted}>
                  You will confirm who from store leadership is on site when you
                  start. GPS is captured at the store.
                </p>
              )}
            <p className={styles.muted}>
              The checklist and evidence settings are saved with this audit.
              {(audit.audit_type === "self" || audit.audit_type === "mock") &&
                " Starting takes a moment while location is verified."}
            </p>
          </div>
        ) : (
          <>
            {!completed ? (
              <div className={styles.progressWrap}>
                <div
                  className={styles.progressTrack}
                  role="progressbar"
                  aria-valuenow={progressPct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label="Checklist progress"
                >
                  <div
                    className={styles.progressFill}
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
                <div className={styles.progressLabel}>
                  {answered} / {progressTotal} answered
                  {dirty ? " · Unsaved changes" : ""}
                  {inspectionGaps.length
                    ? ` · ${inspectionGaps.length} item${inspectionGaps.length === 1 ? "" : "s"} left before release`
                    : inspection
                      ? " · Ready to complete"
                      : ""}
                </div>
              </div>
            ) : (
              <div className={styles.toolbar}>
                <span>
                  {
                    audit.findings.filter((f) => f.state !== "closed").length
                  }{" "}
                  open findings
                </span>
              </div>
            )}
            <div className={styles.editor}>
              <nav className={styles.sectionNav} aria-label="Audit sections">
                {audit.template.sections.map((s, i) => (
                  <button
                    type="button"
                    key={s.id}
                    aria-current={section === s.id ? "step" : undefined}
                    data-complete={sectionDone(s) ? "true" : undefined}
                    onClick={() => setSection(s.id)}
                  >
                    {i + 1}. {s.name}
                    <span>
                      {s.questions.filter((q) => answers[q.id]?.outcome).length}{" "}
                      / {s.questions.length} answered
                    </span>
                  </button>
                ))}
              </nav>
              <div>
                <div className={styles.card}>
                  <h2>{current.name}</h2>
                  <p className={styles.muted}>{current.guidance}</p>
                  {current.questions.map((q, i) => {
                    const a = answers[q.id] || emptyAnswer(),
                      f = audit.findings.find((f) => f.questionId === q.id);
                    const needsNote =
                      a.outcome === "gap" || a.outcome === "na";
                    return (
                      <article
                        className={styles.question}
                        key={q.id}
                        data-outcome={a.outcome || "empty"}
                      >
                        <div className={styles.questionBody}>
                          <div className={styles.qHead}>
                            <h3>
                              <span className={styles.qId}>{q.id}</span>
                              {q.label}
                              {q.required ? (
                                <span className={styles.req}>*</span>
                              ) : null}
                            </h3>
                            <div className={styles.qMeta}>
                              {(a.outcome === "gap" ||
                                q.severity === "critical" ||
                                q.severity === "high") && (
                                <span
                                  className={styles.badge}
                                  data-state={
                                    a.outcome === "gap"
                                      ? "awaiting_response"
                                      : undefined
                                  }
                                >
                                  {q.severity}
                                </span>
                              )}
                              {a.outcome === "pass" ? (
                                <span className={styles.chip}>Compliant</span>
                              ) : null}
                              {a.outcome === "na" ? (
                                <span className={styles.chip}>N/A</span>
                              ) : null}
                            </div>
                          </div>
                          {q.guidance ? (
                            <details className={styles.qHint}>
                              <summary>Guidance</summary>
                              <p>{q.guidance}</p>
                            </details>
                          ) : null}
                          {isCount(q) ? (
                            inspection ? (
                              <label className={styles.compactField}>
                                Count *
                                <input
                                  type="number"
                                  min={0}
                                  step={1}
                                  value={a.extras?.count ?? ""}
                                  onChange={(e) => setCount(q, e.target.value)}
                                />
                              </label>
                            ) : (
                              a.extras?.count && (
                                <p className={styles.muted}>
                                  Count: <b>{a.extras.count}</b>
                                </p>
                              )
                            )
                          ) : inspection ? (
                            <div
                              className={styles.outcomes}
                              role="group"
                              aria-label={`Answer for ${q.id}`}
                            >
                              {(
                                [
                                  "yes",
                                  "no",
                                  ...(q.allowNA || q.kind === "yes_no_na"
                                    ? (["na"] as const)
                                    : []),
                                ] as const
                              ).map((value) => {
                                const pressed =
                                  a.response === value ||
                                  (!a.response &&
                                    value === "na" &&
                                    a.outcome === "na");
                                const outcomeForStyle =
                                  value === "na"
                                    ? "na"
                                    : applyResponse(q, value, emptyAnswer())
                                        .outcome || "pass";
                                return (
                                  <button
                                    type="button"
                                    key={value}
                                    disabled={blocked}
                                    aria-pressed={pressed}
                                    data-outcome={outcomeForStyle}
                                    onClick={() => setResponse(q, value)}
                                  >
                                    {value === "yes"
                                      ? "Yes"
                                      : value === "no"
                                        ? "No"
                                        : "N/A"}
                                  </button>
                                );
                              })}
                            </div>
                          ) : (
                            a.outcome && (
                              <p className={styles.muted}>
                                Response: <b>{responseLabel(a)}</b>
                              </p>
                            )
                          )}
                          {(needsNote ||
                            (inspection && a.observation) ||
                            (!inspection && a.observation)) &&
                            (inspection ? (
                              <label className={styles.compactField}>
                                {needsNote
                                  ? a.outcome === "na"
                                    ? "Why N/A *"
                                    : "Observation *"
                                  : "Note (optional)"}
                                <textarea
                                  rows={needsNote ? 2 : 1}
                                  value={a.observation}
                                  onChange={(e) =>
                                    setAnswer(q, {
                                      observation: e.target.value,
                                    })
                                  }
                                  placeholder={
                                    needsNote
                                      ? "What did you see?"
                                      : "Optional note"
                                  }
                                />
                              </label>
                            ) : (
                              a.observation && (
                                <p className={styles.muted}>{a.observation}</p>
                              )
                            ))}
                          {a.outcome === "gap" && isScored(q) && (
                            inspection ? (
                              <div className={styles.compactGrid}>
                                <label className={styles.compactField}>
                                  Instances *
                                  <input
                                    type="number"
                                    min={1}
                                    step={1}
                                    value={a.instances ?? ""}
                                    onChange={(e) =>
                                      setAnswer(q, {
                                        instances: e.target.value
                                          ? Number(e.target.value)
                                          : null,
                                      })
                                    }
                                  />
                                </label>
                                {(q.extraFields || [])
                                  .filter(
                                    (f) =>
                                      f.id !== "count" &&
                                      f.id !== "instances" &&
                                      fieldVisible(f, a.outcome),
                                  )
                                  .map((f) => (
                                    <label
                                      key={f.id}
                                      className={styles.compactField}
                                    >
                                      {f.label} *
                                      <input
                                        type={extraFieldInputType(f)}
                                        value={a.extras?.[f.id] ?? ""}
                                        onChange={(e) =>
                                          setExtra(q, f.id, e.target.value)
                                        }
                                      />
                                    </label>
                                  ))}
                              </div>
                            ) : (
                              <>
                                {a.instances != null && (
                                  <p className={styles.muted}>
                                    Instances: {a.instances}
                                  </p>
                                )}
                                {(q.extraFields || [])
                                  .filter(
                                    (f) =>
                                      f.id !== "count" &&
                                      f.id !== "instances" &&
                                      a.extras?.[f.id],
                                  )
                                  .map((f) => (
                                    <p key={f.id} className={styles.muted}>
                                      {f.label}: {a.extras?.[f.id]}
                                    </p>
                                  ))}
                              </>
                            )
                          )}
                          {a.outcome !== "gap" &&
                            (q.extraFields || [])
                              .filter(
                                (f) =>
                                  f.id !== "count" &&
                                  f.id !== "instances" &&
                                  fieldVisible(f, a.outcome),
                              )
                              .map((f) =>
                                inspection ? (
                                  <label
                                    key={f.id}
                                    className={styles.compactField}
                                  >
                                    {f.label}
                                    {f.when === "always" ? " *" : ""}
                                    <input
                                      type={extraFieldInputType(f)}
                                      value={a.extras?.[f.id] ?? ""}
                                      onChange={(e) =>
                                        setExtra(q, f.id, e.target.value)
                                      }
                                    />
                                  </label>
                                ) : (
                                  a.extras?.[f.id] && (
                                    <p key={f.id} className={styles.muted}>
                                      {f.label}: {a.extras[f.id]}
                                    </p>
                                  )
                                ),
                              )}
                          {a.outcome === "gap" && (
                            <div className={styles.subBlock}>
                              <span className={styles.blockLabel}>
                                Fix plan
                              </span>
                              {inspection ? (
                                <>
                                  <label className={styles.compactField}>
                                    Action *
                                    <textarea
                                      rows={2}
                                      value={a.action}
                                      onChange={(e) =>
                                        setAnswer(q, { action: e.target.value })
                                      }
                                    />
                                  </label>
                                  <div className={styles.compactGrid}>
                                    <label className={styles.compactField}>
                                      Owner *
                                      <input
                                        value={a.owner}
                                        onChange={(e) =>
                                          setAnswer(q, {
                                            owner: e.target.value,
                                          })
                                        }
                                      />
                                    </label>
                                    <label className={styles.compactField}>
                                      Due (IST) *
                                      <input
                                        type="datetime-local"
                                        value={localTime(a.dueAt)}
                                        onChange={(e) =>
                                          setAnswer(q, {
                                            dueAt: e.target.value
                                              ? new Date(
                                                  e.target.value + ":00+05:30",
                                                ).toISOString()
                                              : "",
                                          })
                                        }
                                      />
                                    </label>
                                  </div>
                                  <small>Target {q.hours}h</small>
                                </>
                              ) : (
                                <>
                                  <p>{a.action}</p>
                                  <p className={styles.muted}>
                                    Owner: {a.owner} · Due: {date(a.dueAt)}
                                    {f?.state !== "closed" &&
                                    Date.parse(a.dueAt) < Date.now()
                                      ? " · OVERDUE"
                                      : ""}
                                  </p>
                                </>
                              )}
                            </div>
                          )}
                          {(inspection ||
                            requiredEvidence(q.evidence, a.outcome || "pass") >
                              0 ||
                            proof.some(
                              (pr) =>
                                pr.question_id === q.id && pr.phase === "audit",
                            )) && (
                            <div className={styles.subBlock}>
                              <ProofFiles
                                audit={audit}
                                q={q}
                                phase="audit"
                                proofs={proof}
                                setProofs={setProof}
                                editable={inspection}
                                userId={p.userId}
                                onError={setMessage}
                                storeLabel={audit.store_name}
                              />
                            </div>
                          )}
                          {f && (
                            <div className={styles.storeResponse}>
                              <h4>
                                Store response ·{" "}
                                {f.state === "open"
                                  ? "awaiting action"
                                  : f.state === "submitted"
                                    ? "review pending"
                                    : "verified closed"}
                              </h4>
                              {f.note && (
                                <>
                                  <p>{f.note}</p>
                                  <small>
                                    {f.respondedBy} ·{" "}
                                    {date(f.respondedAt || null)}
                                  </small>
                                </>
                              )}
                              {f.reviewNote && (
                                <p className={styles.notice}>
                                  Leadership review: {f.reviewNote}
                                </p>
                              )}
                              <ProofFiles
                                audit={audit}
                                q={q}
                                phase="response"
                                proofs={proof}
                                setProofs={setProof}
                                editable={p.canRespond && f.state === "open"}
                                userId={p.userId}
                                onError={setMessage}
                                storeLabel={audit.store_name}
                              />
                              {p.canRespond && f.state === "open" && (
                                <>
                                  <label>
                                    What was done to close this gap?
                                    <textarea
                                      value={notes[q.id] || ""}
                                      onChange={(e) =>
                                        setNotes({
                                          ...notes,
                                          [q.id]: e.target.value,
                                        })
                                      }
                                    />
                                  </label>
                                  <button
                                    className={styles.primary}
                                    disabled={blocked}
                                    onClick={() =>
                                      run(() =>
                                        respondStoreFinding(
                                          audit.id,
                                          audit.version,
                                          q.id,
                                          notes[q.id] || "",
                                        ),
                                      )
                                    }
                                  >
                                    Submit response
                                  </button>
                                </>
                              )}
                              {p.canEdit && f.state === "submitted" && (
                                <>
                                  <label>
                                    Review note
                                    <textarea
                                      value={notes[q.id] || ""}
                                      onChange={(e) =>
                                        setNotes({
                                          ...notes,
                                          [q.id]: e.target.value,
                                        })
                                      }
                                    />
                                  </label>
                                  <div className={styles.inline}>
                                    <button
                                      disabled={blocked}
                                      className={styles.primary}
                                      onClick={() =>
                                        run(() =>
                                          reviewStoreFinding(
                                            audit.id,
                                            audit.version,
                                            q.id,
                                            true,
                                            notes[q.id] || "",
                                          ),
                                        )
                                      }
                                    >
                                      Accept & close finding
                                    </button>
                                    <button
                                      disabled={blocked}
                                      onClick={() =>
                                        run(() =>
                                          reviewStoreFinding(
                                            audit.id,
                                            audit.version,
                                            q.id,
                                            false,
                                            notes[q.id] || "",
                                          ),
                                        )
                                      }
                                    >
                                      Return for more information
                                    </button>
                                  </div>
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
                <div className={styles.card}>
                  <h2>Overall observations</h2>
                  {inspection ? (
                    <label>
                      Audit summary *
                      <textarea
                        value={summary}
                        onChange={(e) => {
                          setSummary(e.target.value);
                          setDirty(true);
                        }}
                        placeholder="Main risks, good practices and priorities for the store."
                      />
                    </label>
                  ) : (
                    <p>{audit.summary}</p>
                  )}
                  {inspection && audit.audit_type === "mock" && (
                    <label>
                      Store Manager / Store In-charge present *
                      <input
                        value={presentSmName}
                        onChange={(e) => {
                          setPresentSmName(e.target.value);
                          setDirty(true);
                        }}
                        placeholder="Name of SM or SI on site"
                      />
                      <small className={styles.muted}>
                        Captured at start — edit here if the person on site
                        changed.
                      </small>
                    </label>
                  )}
                  {inspection && audit.audit_type === "amazon" && (
                    <div className={styles.formGrid}>
                      <label>
                        Amazon score % (Scout alert) *
                        <input
                          type="number"
                          min={0}
                          max={100}
                          step={0.1}
                          value={completeAmazonScore}
                          onChange={(e) => {
                            setCompleteAmazonScore(e.target.value);
                            setDirty(true);
                          }}
                        />
                      </label>
                      <label>
                        Amazon auditor *
                        <input
                          value={completeAmazonAuditor}
                          onChange={(e) => {
                            setCompleteAmazonAuditor(e.target.value);
                            setDirty(true);
                          }}
                        />
                      </label>
                    </div>
                  )}
                </div>
                {inspection ? (
                  <>
                    {inspectionGaps.length ? (
                      <div className={styles.gapPanel} role="status">
                        <strong>
                          Finish these before complete &amp; release
                        </strong>
                        <ul>
                          {inspectionGaps.slice(0, 8).map((g, i) => (
                            <li key={`${i}-${g}`}>{g}</li>
                          ))}
                          {inspectionGaps.length > 8 ? (
                            <li key="more">
                              +{inspectionGaps.length - 8} more…
                            </li>
                          ) : null}
                        </ul>
                      </div>
                    ) : null}
                    <div className={styles.stickyBar}>
                      <span className={styles.stickyMeta}>
                        {answered}/{progressTotal}
                        {dirty ? " · Unsaved" : ""}
                        {inspectionGaps.length
                          ? ` · ${inspectionGaps.length} left`
                          : " · Ready"}
                      </span>
                      <button
                        type="button"
                        disabled={blocked || !dirty}
                        onClick={() => saveDraft()}
                      >
                        Save draft
                      </button>
                      <button
                        type="button"
                        disabled={blocked || inspectionGaps.length > 0}
                        className={styles.primary}
                        onClick={() => setCompleteConfirmOpen(true)}
                      >
                        Complete &amp; release
                      </button>
                    </div>
                  </>
                ) : null}
              </div>
            </div>
          </>
        )}
        <details className={styles.card}>
          <summary>Audit history</summary>
          {audit.events
            .filter(
              (e) =>
                p.manager ||
                ![
                  "scheduled",
                  "rescheduled",
                  "draft_saved",
                  "started",
                ].includes(e.kind),
            )
            .map((e, i) => (
              <p key={i}>
                <b>{e.kind.replaceAll("_", " ")}</b> · {e.actor} · {date(e.at)}
                <br />
                {e.note}
              </p>
            ))}
        </details>
        {startOverlay ? (
          <div className={styles.startOverlay} role="status" aria-live="polite">
            <div className={styles.startOverlayCard}>
              <div className={styles.spinner} aria-hidden />
              <strong>Starting inspection…</strong>
              <p>
                {(audit.audit_type === "self" || audit.audit_type === "mock") &&
                  "Getting your GPS at the store, then opening the checklist."}
                {audit.audit_type === "amazon" &&
                  "Opening the Amazon audit log."}
              </p>
            </div>
          </div>
        ) : null}
        <OpsConfirmDialog
          open={startModalOpen}
          title="Who is on site?"
          description={
            <>
              <p>
                Record the Store Manager or Store In-charge present for this
                mock audit. Their name is saved on the report.
              </p>
              <p>Next we will capture GPS at the store — this can take a few seconds.</p>
            </>
          }
          confirmLabel="Start with GPS"
          cancelLabel="Not yet"
          busy={startOverlay}
          confirmDisabled={!startModalName.trim()}
          onCancel={() => setStartModalOpen(false)}
          onConfirm={() => {
            const name = startModalName.trim();
            if (!name) return;
            void runStartInspection(name);
          }}
        >
          <label>
            Name of SM / SI on site
            <input
              autoFocus
              value={startModalName}
              onChange={(e) => setStartModalName(e.target.value)}
              placeholder="e.g. Priya Sharma"
              onKeyDown={(e) => {
                if (e.key === "Enter" && startModalName.trim()) {
                  e.preventDefault();
                  void runStartInspection(startModalName.trim());
                }
              }}
            />
          </label>
        </OpsConfirmDialog>
        <OpsConfirmDialog
          open={completeConfirmOpen}
          title="Complete & release to store?"
          description={
            <p>
              The report and open findings become visible to the store. You
              cannot edit inspection answers after release.
            </p>
          }
          confirmLabel="Complete & release"
          cancelLabel="Keep editing"
          busy={blocked}
          onCancel={() => setCompleteConfirmOpen(false)}
          onConfirm={() => {
            setCompleteConfirmOpen(false);
            void releaseAudit();
          }}
        />
        <OpsConfirmDialog
          open={leaveConfirmOpen}
          title="Leave without saving?"
          description={
            <p>
              You have unsaved inspection changes. Leave anyway, or stay and
              save draft first.
            </p>
          }
          confirmLabel="Leave"
          cancelLabel="Stay"
          danger
          onCancel={() => setLeaveConfirmOpen(false)}
          onConfirm={() => {
            setLeaveConfirmOpen(false);
            setDirty(false);
            router.push("/store-audits");
          }}
        />
        <OpsConfirmDialog
          open={deleteStep === "warn"}
          title={
            audit.completed_at
              ? "Delete this audit?"
              : "Delete this draft audit?"
          }
          description={
            audit.completed_at ? (
              <p>
                The audit will leave the register. History is retained for
                named deletion users.
              </p>
            ) : (
              <p>
                This removes the scheduled or in-progress draft for{" "}
                <b>{audit.store_name}</b>. Answers and photos on this draft will
                no longer appear in the register.
              </p>
            )
          }
          confirmLabel="Continue"
          cancelLabel="Keep audit"
          danger
          onCancel={() => setDeleteStep(null)}
          onConfirm={() => setDeleteStep("confirm")}
        />
        <OpsConfirmDialog
          open={deleteStep === "confirm"}
          title="Confirm deletion"
          description={
            <p>
              This cannot be undone from the register. Type a short reason, then
              confirm.
            </p>
          }
          confirmLabel="Yes, delete"
          cancelLabel="Back"
          secondaryLabel="Cancel"
          danger
          busy={blocked}
          confirmDisabled={
            Boolean(audit.completed_at) && !deleteReason.trim()
          }
          onCancel={() => setDeleteStep("warn")}
          onSecondary={() => {
            setDeleteStep(null);
            setDeleteReason("");
          }}
          onConfirm={() => void confirmDeleteAudit()}
        >
          <label>
            Reason{audit.completed_at ? " *" : " (optional)"}
            <textarea
              value={deleteReason}
              onChange={(e) => setDeleteReason(e.target.value)}
              placeholder={
                audit.completed_at
                  ? "Why this audit is being removed"
                  : "Optional note, e.g. created by mistake"
              }
            />
          </label>
        </OpsConfirmDialog>
      </div>
    );
  }
  function scheduleForm() {
    return (
      <form
        className={styles.card}
        onSubmit={async (e) => {
          e.preventDefault();
          const ok = await run(() =>
            scheduleStoreAudit({
              locationId: scheduleLocation,
              auditorId: auditor,
              scheduledFor: when
                ? new Date(when + ":00+05:30").toISOString()
                : "",
              auditType: scheduleAuditType,
              amazonScore:
                scheduleAuditType === "amazon" && scheduleAmazonScore.trim()
                  ? Number(scheduleAmazonScore)
                  : null,
              amazonAuditor:
                scheduleAuditType === "amazon"
                  ? scheduleAmazonAuditor.trim() || null
                  : null,
              ...(rescheduling && audit
                ? { id: audit.id, version: audit.version }
                : {}),
            }),
          );
          if (ok) setSchedule(false);
        }}
      >
        <h2>{rescheduling ? "Reschedule audit" : "Schedule a store audit"}</h2>
        <div className={styles.formGrid}>
          <label>
            Store
            <select
              required
              value={scheduleLocation}
              onChange={(e) => {
                setScheduleLocation(e.target.value);
                setAuditor("");
              }}
            >
              {p.locations.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.station_code} · {s.station_name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Assigned auditor
            <select
              required
              value={auditor}
              onChange={(e) => setAuditor(e.target.value)}
            >
              <option value="">Choose auditor</option>
              {p.assignees
                .filter((a) => a.stationIds.includes(scheduleLocation))
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} · {a.role}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Date and time (IST)
            <input
              required
              type="datetime-local"
              value={when}
              onChange={(e) => setWhen(e.target.value)}
            />
          </label>
          <label>
            Audit type
            <select
              value={scheduleAuditType}
              onChange={(e) => {
                const next = e.target.value as AuditType;
                setScheduleAuditType(next);
                if (
                  next === "self" &&
                  p.assignees.some(
                    (a) =>
                      a.id === p.userId &&
                      a.stationIds.includes(scheduleLocation),
                  )
                )
                  setAuditor(p.userId);
              }}
            >
              {(
                (p.manager
                  ? (["self", "mock", "amazon"] as AuditType[])
                  : (["self"] as AuditType[]))
              ).map((t) => (
                <option key={t} value={t}>
                  {auditTypeLabels[t]}
                </option>
              ))}
            </select>
          </label>
          {scheduleAuditType === "amazon" && (
            <>
              <label>
                Amazon score % (optional now)
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={0.1}
                  value={scheduleAmazonScore}
                  onChange={(e) => setScheduleAmazonScore(e.target.value)}
                />
              </label>
              <label>
                Amazon auditor
                <input
                  value={scheduleAmazonAuditor}
                  onChange={(e) => setScheduleAmazonAuditor(e.target.value)}
                />
              </label>
            </>
          )}
        </div>
        <p className={styles.muted}>
          {scheduleAuditType === "amazon"
            ? "Log an Amazon Scout audit. Enter failed checklist items during the inspection."
            : "The store will not see the schedule or receive advance email. Only the assigned auditor can complete the inspection."}
        </p>
        <div className={styles.inline}>
          <button className={styles.primary} disabled={blocked}>
            Save schedule
          </button>
          <button type="button" onClick={() => setSchedule(false)}>
            Cancel
          </button>
        </div>
      </form>
    );
  }
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>DARK STORE · AMAZON NOW</span>
          <h1>Store audits</h1>
          <p>
            {p.manager
              ? "Plan store visits, complete inspections and follow corrective actions."
              : "Review completed audits and respond to findings with closure evidence."}
          </p>
        </div>
        <div className={styles.inline}>
          {p.canMaster && (
            <Link className={styles.button} href="/master/store-audits">
              Audit Master
            </Link>
          )}
          {p.canSchedule && (
            <button
              className={styles.primary}
              onClick={() => {
                setRescheduling(false);
                setScheduleAuditType(p.manager ? "mock" : "self");
                setScheduleAmazonScore("");
                setScheduleAmazonAuditor("");
                if (
                  !p.manager &&
                  p.assignees.some(
                    (a) =>
                      a.id === p.userId &&
                      a.stationIds.includes(
                        scheduleLocation || p.locations[0]?.id || "",
                      ),
                  )
                )
                  setAuditor(p.userId);
                setSchedule(!schedule);
              }}
            >
              ＋ Schedule audit
            </button>
          )}
        </div>
      </header>
      {message && (
        <p role="status" className={styles.notice}>
          {message}
        </p>
      )}
      {schedule && scheduleForm()}
      <div className={styles.stats}>
        {[
          ["all", "All audits"],
          ...(p.manager
            ? [
                ["scheduled", "Scheduled"],
                ["in_progress", "In progress"],
              ]
            : []),
          ["awaiting_response", "Awaiting response"],
          ["under_review", "Review pending"],
          ["closed", "Closed"],
        ].map(([key, label]) => (
          <button
            key={key}
            aria-pressed={status === key}
            onClick={() => setStatus(status === key ? "all" : key)}
          >
            <b>
              {p.audits.filter((a) => key === "all" || a.status === key).length}
            </b>
            {label}
          </button>
        ))}
      </div>
      <div className={`${styles.card} ${styles.filterPanel}`}>
        <form className={styles.filters} action="/store-audits">
          <label>
            From
            <input type="date" name="from" defaultValue={p.from} required />
          </label>
          <label>
            To
            <input type="date" name="to" defaultValue={p.to} required />
          </label>
          <button>Apply dates</button>
        </form>
        <div className={styles.filters}>
          <label>
            Search
            <input
              placeholder="Store, auditor or audit ID"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <label>
            Store
            <select
              value={location}
              onChange={(e) => setLocation(e.target.value)}
            >
              <option value="">All permitted stores</option>
              {p.locations.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.station_code} · {s.station_name}
                </option>
              ))}
            </select>
          </label>
          {p.manager && (
            <label>
              Audit type
              <select
                value={auditTypeFilter}
                onChange={(e) => setAuditTypeFilter(e.target.value)}
              >
                <option value="">All types</option>
                {(Object.keys(auditTypeLabels) as AuditType[]).map((t) => (
                  <option key={t} value={t}>
                    {auditTypeLabels[t]}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Status
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="all">All statuses</option>
              {Object.entries(statusLabels)
                .filter(
                  ([key]) =>
                    p.manager ||
                    !["scheduled", "in_progress", "cancelled"].includes(key),
                )
                .map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              <option value="overdue">Overdue actions</option>
            </select>
          </label>
        </div>
      </div>
      <div className={styles.toolbar}>
        <div className={styles.inline}>
          <button
            aria-pressed={view === "register"}
            onClick={() => setView("register")}
          >
            Audit register
          </button>
          <button
            aria-pressed={view === "calendar"}
            onClick={() => setView("calendar")}
          >
            Calendar
          </button>
          {p.manager && (
            <button
              aria-pressed={view === "reports"}
              onClick={() => setView("reports")}
            >
              Reports
            </button>
          )}
        </div>
        <span className={styles.muted}>
          {visible.length} audits · All times IST
        </span>
      </div>
      {view === "reports" && p.manager ? (
        reportsView()
      ) : !visible.length ? (
        <div className={styles.empty}>
          <h2>
            {p.manager
              ? "No audits in this view"
              : "No completed audits to respond to"}
          </h2>
          <p>
            {p.manager
              ? "Choose another date range or schedule a store visit."
              : "Completed store audit reports will appear here."}
          </p>
        </div>
      ) : view === "calendar" ? (
        <div className={styles.calendar}>
          {[
            ...new Set(
              visible.map((a) => localTime(a.scheduled_for).slice(0, 10)),
            ),
          ]
            .sort()
            .map((day) => (
              <section className={styles.card} key={day}>
                <h3>{day}</h3>
                {visible
                  .filter((a) => localTime(a.scheduled_for).startsWith(day))
                  .map((a) => (
                    <Link
                      className={styles.calendarEntry}
                      key={a.id}
                      href={`/store-audits?audit=${a.id}`}
                    >
                      <b>{a.store_name}</b>
                      <span>
                        {localTime(a.scheduled_for).slice(11)} ·{" "}
                        {a.assigned_name}
                      </span>
                      <small>
                        {auditTypeLabels[a.audit_type || "mock"]} ·{" "}
                        {statusLabels[a.status]}
                      </small>
                    </Link>
                  ))}
              </section>
            ))}
        </div>
      ) : (
        <div className={styles.tableWrap}>
          <table>
            <thead>
              <tr>
                <th>Store / audit</th>
                <th>Type</th>
                <th>Score</th>
                <th>Scheduled</th>
                <th>Auditor</th>
                <th>Status</th>
                <th>Open actions</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((a) => {
                const pct = auditScore(a);
                const band = auditBand(a);
                return (
                <tr key={a.id}>
                  <td>
                    <b>{a.store_name}</b>
                    <small>{a.number}</small>
                  </td>
                  <td>{auditTypeLabels[a.audit_type || "mock"]}</td>
                  <td>
                    {a.completed_at && pct != null ? (
                      <>
                        {pct}%
                        {band ? (
                          <>
                            {" "}
                            <span className={styles.band} data-band={band}>
                              {band}
                            </span>
                          </>
                        ) : null}
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>{date(a.scheduled_for)}</td>
                  <td>{a.assigned_name}</td>
                  <td>
                    <span className={styles.badge} data-state={a.status}>
                      {statusLabels[a.status]}
                    </span>
                    {a.email_error && <small>Email needs attention</small>}
                  </td>
                  <td>
                    {a.completed_at
                      ? a.findings.filter((f) => f.state !== "closed").length
                      : "—"}
                  </td>
                  <td>
                    <Link
                      className={styles.button}
                      href={`/store-audits?audit=${a.id}`}
                    >
                      Open audit →
                    </Link>
                  </td>
                </tr>
              );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
  function reportsView() {
    const rows = p.audits;
    const ready = readiness(rows);
    const failed = topFailedQuestions(rows, 30);
    const actions = openActions(rows);
    const compare = mockVsAmazon(rows);
    const repeats = repeatFailures(rows);
    return (
      <div className={styles.reportGrid}>
        <section className={styles.card}>
          <h2>Self-audit readiness</h2>
          <p className={styles.muted}>
            Stores with no completed self-audit in the last 7 days are flagged.
          </p>
          <div className={styles.tableWrap}>
            <table>
              <thead>
                <tr>
                  <th>Store</th>
                  <th>Last self</th>
                  <th>Last mock</th>
                  <th>Flag</th>
                </tr>
              </thead>
              <tbody>
                {ready.slice(0, 20).map((r) => (
                  <tr key={r.locationId}>
                    <td>{r.store}</td>
                    <td>
                      {r.daysSinceSelf == null ? "—" : `${r.daysSinceSelf}d ago`}
                    </td>
                    <td>
                      {r.daysSinceMock == null ? "—" : `${r.daysSinceMock}d ago`}
                    </td>
                    <td>
                      {r.flagNoSelf7d ? (
                        <span className={styles.band} data-band="Risk">
                          No self 7d
                        </span>
                      ) : (
                        "OK"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className={styles.card}>
          <h2>Top failed questions (30d)</h2>
          <div className={styles.tableWrap}>
            <table>
              <thead>
                <tr>
                  <th>Question</th>
                  <th>Stores</th>
                  <th>Fails</th>
                  <th>Instances</th>
                </tr>
              </thead>
              <tbody>
                {failed.slice(0, 15).map((r) => (
                  <tr key={r.id}>
                    <td>{r.label}</td>
                    <td>{r.storesFailed}</td>
                    <td>{r.fails}</td>
                    <td>{r.instances}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className={styles.card}>
          <h2>Open corrective actions</h2>
          <div className={styles.tableWrap}>
            <table>
              <thead>
                <tr>
                  <th>Store</th>
                  <th>Action</th>
                  <th>Owner</th>
                  <th>Due</th>
                </tr>
              </thead>
              <tbody>
                {actions.slice(0, 20).map((r) => (
                  <tr key={`${r.auditId}-${r.questionId}`}>
                    <td>{r.store}</td>
                    <td>{r.label}</td>
                    <td>{r.owner}</td>
                    <td>
                      {date(r.dueAt || null)}
                      {r.overdue ? " · overdue" : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className={styles.card}>
          <h2>Mock vs Amazon (lenient &gt;10 pts)</h2>
          <div className={styles.tableWrap}>
            <table>
              <thead>
                <tr>
                  <th>Store</th>
                  <th>Mock</th>
                  <th>Amazon</th>
                  <th>Gap</th>
                </tr>
              </thead>
              <tbody>
                {compare.slice(0, 15).map((r) => (
                  <tr key={r.locationId}>
                    <td>
                      {r.store}
                      {r.lenient ? (
                        <>
                          {" "}
                          <span className={styles.band} data-band="Watch">
                            Lenient
                          </span>
                        </>
                      ) : null}
                    </td>
                    <td>{r.mockScore ?? "—"}</td>
                    <td>{r.amazonScore ?? "—"}</td>
                    <td>{r.gap ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className={styles.card}>
          <h2>Repeat failures (last 3 audits)</h2>
          <div className={styles.tableWrap}>
            <table>
              <thead>
                <tr>
                  <th>Store</th>
                  <th>Question</th>
                  <th>Times failed</th>
                </tr>
              </thead>
              <tbody>
                {repeats.slice(0, 15).map((r) => (
                  <tr key={`${r.locationId}-${r.questionId}`}>
                    <td>{r.store}</td>
                    <td>{r.label}</td>
                    <td>{r.fails}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    );
  }
}
