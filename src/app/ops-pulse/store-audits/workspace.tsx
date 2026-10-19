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
  requiredEvidence,
  score,
  statusLabels,
  type StoreAudit,
  type Proof,
  type Answer,
  type Question,
} from "@/lib/ops-pulse/store-audits/model";
import type { AuditAssignee } from "@/lib/ops-pulse/station-audit-people";
import { EvidencePreview } from "@/components/evidence-preview";
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
const localTime = (v: string) =>
  v
    ? new Date(new Date(v).getTime() + 330 * 60000).toISOString().slice(0, 16)
    : "";
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
}: {
  audit: StoreAudit;
  q: Question;
  phase: "audit" | "response";
  proofs: Proof[];
  setProofs: Dispatch<SetStateAction<Proof[]>>;
  editable: boolean;
  userId: string;
  onError: (e: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const existing = proofs.filter(
    (p) => p.question_id === q.id && p.phase === phase,
  );
  const rule = phase === "audit" ? q.evidence : q.responseEvidence;
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
  return (
    <div className={styles.proof}>
      <small>
        {phase === "audit" ? "Inspection evidence" : "Closure evidence"} ·{" "}
        {rule.when === "optional"
          ? "optional"
          : `${rule.min} required${rule.when === "gap" ? " for gaps" : ""}`}{" "}
        · up to {rule.max} files
      </small>
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
      {editable && rule.max > existing.length && (
        <label className={styles.upload}>
          {busy ? "Uploading…" : "＋ Attach photo or PDF"}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf"
            multiple
            disabled={busy}
            onChange={async (e) => {
              const files = Array.from(e.target.files || []);
              e.target.value = "";
              if (files.length + existing.length > rule.max) {
                onError(`Use up to ${rule.max} files for this question.`);
                return;
              }
              setBusy(true);
              try {
                for (const file of files) {
                  if (!supabase) throw Error("Upload service unavailable.");
                  const extension =
                    file.name.split(".").pop()?.toLowerCase() || "";
                  const mime =
                    file.type ||
                    {
                      jpg: "image/jpeg",
                      jpeg: "image/jpeg",
                      png: "image/png",
                      webp: "image/webp",
                      heic: "image/heic",
                      heif: "image/heif",
                      pdf: "application/pdf",
                    }[extension];
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
                  setProofs((current) => [...current, done.proof]);
                }
              } catch (e) {
                onError(e instanceof Error ? e.message : "Upload failed.");
              } finally {
                setBusy(false);
              }
            }}
          />
        </label>
      )}
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
    [rescheduling, setRescheduling] = useState(false);
  const [audit, setAudit] = useState(p.focused),
    [answers, setAnswers] = useState(p.focused?.answers || {}),
    [summary, setSummary] = useState(p.focused?.summary || ""),
    [proof, setProof] = useState(p.evidence),
    [section, setSection] = useState(p.focused?.template.sections[0]?.id || ""),
    [dirty, setDirty] = useState(false),
    [notes, setNotes] = useState<Record<string, string>>({});
  const dirtyRef = useRef(dirty);
  const focusedIdRef = useRef<string | null>(p.focused?.id ?? null);
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
    setSection((current) =>
      p.focused!.template.sections.some((s) => s.id === current)
        ? current
        : p.focused!.template.sections[0]?.id || "",
    );
  }, [p.focused?.id, p.focused?.version, p.evidence]);
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
              owner: old.owner || audit?.store_name || "",
              dueAt:
                old.dueAt ||
                new Date(Date.now() + q.hours * 3600000).toISOString(),
            }
          : {}),
      },
    });
    setDirty(true);
  };
  const visible = p.audits.filter(
    (a) =>
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
    const current = audit.template.sections.find((s) => s.id === section)!;
    const completed = Boolean(audit.completed_at);
    const inspection = p.canInspect && !completed;
    const answered = questions(audit.template).filter(
      (q) => answers[q.id]?.outcome,
    ).length;
    return (
      <div className={styles.page}>
        <header className={styles.header}>
          <div>
            <Link
              href="/store-audits"
              onClick={(e) => {
                if (
                  dirty &&
                  !confirm("Leave without saving your inspection changes?")
                )
                  e.preventDefault();
              }}
            >
              ← Store audits
            </Link>
            <h1>{audit.store_name}</h1>
            <p>
              {audit.number} · {audit.template.name} · Version{" "}
              {audit.template_version}
            </p>
          </div>
          <span className={styles.badge} data-state={audit.status}>
            {statusLabels[audit.status]}
          </span>
        </header>
        <div className={styles.card}>
          <div className={styles.facts}>
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
            {completed && (
              <span>
                Checklist compliance<b>{score(audit) ?? "—"}%</b>
              </span>
            )}
          </div>
          <div className={styles.inline}>
            {audit.status === "scheduled" &&
              p.canEdit &&
              audit.assigned_to === p.userId && (
                <button
                  className={styles.primary}
                  disabled={blocked}
                  onClick={() =>
                    run(() => startStoreAudit(audit.id, audit.version))
                  }
                >
                  Start inspection
                </button>
              )}
            {audit.status === "scheduled" && p.canEdit && (
              <button
                onClick={() => {
                  setRescheduling(true);
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
            {p.canDelete && (
              <button
                className={styles.danger}
                disabled={blocked}
                onClick={async () => {
                  const reason = prompt(
                    "Reason for deleting this audit (history will be retained):",
                  );
                  if (
                    reason &&
                    (await run(() =>
                      deleteStoreAudit(audit.id, audit.version, reason),
                    ))
                  )
                    router.push("/store-audits");
                }}
              >
                Delete audit
              </button>
            )}
          </div>
          {!completed && (
            <p className={styles.notice}>
              Private audit · the store cannot see this schedule or inspection.
              Results become visible after completion.
            </p>
          )}
          {completed && (
            <p className={styles.muted}>
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
        {message && (
          <p className={styles.notice} role="status">
            {message}
          </p>
        )}
        {schedule && scheduleForm()}
        {!completed && audit.status === "scheduled" ? (
          <div className={styles.card}>
            <h2>Ready for the visit</h2>
            <p>
              {questions(audit.template).length} checks in{" "}
              {audit.template.sections.length} sections. The assigned auditor
              can start the inspection when ready.
            </p>
            <p className={styles.muted}>
              The checklist and evidence settings are saved with this audit.
            </p>
          </div>
        ) : (
          <>
            <div className={styles.toolbar}>
              <span>
                {completed
                  ? `${audit.findings.filter((f) => f.state !== "closed").length} open findings`
                  : `${answered} / ${questions(audit.template).length} answered${dirty ? " · Unsaved changes" : ""}`}
              </span>
              {inspection && (
                <button
                  disabled={blocked || !dirty}
                  onClick={() =>
                    run(
                      () =>
                        saveStoreInspection(
                          audit.id,
                          audit.version,
                          answers,
                          summary,
                        ),
                      { answers, summary },
                    )
                  }
                >
                  Save draft
                </button>
              )}
            </div>
            <div className={styles.editor}>
              <nav className={styles.sectionNav} aria-label="Audit sections">
                {audit.template.sections.map((s, i) => (
                  <button
                    type="button"
                    key={s.id}
                    aria-current={section === s.id ? "step" : undefined}
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
                    return (
                      <article className={styles.question} key={q.id}>
                        <div className={styles.questionBody}>
                          <div className={styles.toolbar}>
                            <h3>
                              {i + 1}. {q.label}
                              {q.required ? " *" : ""}
                            </h3>
                            {a.outcome === "gap" && (
                              <span
                                className={styles.badge}
                                data-state="awaiting_response"
                              >
                                {q.severity}
                              </span>
                            )}
                          </div>
                          {q.guidance && (
                            <p className={styles.muted}>{q.guidance}</p>
                          )}
                          <div className={styles.outcomes}>
                            {(
                              [
                                "pass",
                                "gap",
                                ...(q.allowNA ? ["na"] : []),
                              ] as Answer["outcome"][]
                            ).map((value) => (
                              <button
                                type="button"
                                key={value}
                                disabled={!inspection || blocked}
                                aria-pressed={a.outcome === value}
                                data-outcome={value}
                                onClick={() => setAnswer(q, { outcome: value })}
                              >
                                {value === "pass"
                                  ? "Meets standard"
                                  : value === "gap"
                                    ? "Gap found"
                                    : "Not applicable"}
                              </button>
                            ))}
                          </div>
                          {inspection ? (
                            <label>
                              Observation
                              {a.outcome === "gap" || a.outcome === "na"
                                ? " *"
                                : ""}
                              <textarea
                                value={a.observation}
                                onChange={(e) =>
                                  setAnswer(q, { observation: e.target.value })
                                }
                                placeholder="What did you see? Add readings, sample locations or details."
                              />
                            </label>
                          ) : (
                            a.observation && <p>{a.observation}</p>
                          )}
                          {a.outcome === "gap" && (
                            <div className={styles.finding}>
                              <h4>Corrective action</h4>
                              {inspection ? (
                                <>
                                  <label>
                                    What needs to be done *
                                    <textarea
                                      value={a.action}
                                      onChange={(e) =>
                                        setAnswer(q, { action: e.target.value })
                                      }
                                    />
                                  </label>
                                  <div className={styles.formGrid}>
                                    <label>
                                      Responsible person / team *
                                      <input
                                        value={a.owner}
                                        onChange={(e) =>
                                          setAnswer(q, {
                                            owner: e.target.value,
                                          })
                                        }
                                      />
                                    </label>
                                    <label>
                                      Due by (IST) *
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
                                  <small>
                                    Master target: {q.hours} hours. Adjust for
                                    the action required.
                                  </small>
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
                          <ProofFiles
                            audit={audit}
                            q={q}
                            phase="audit"
                            proofs={proof}
                            setProofs={setProof}
                            editable={inspection}
                            userId={p.userId}
                            onError={setMessage}
                          />
                          {f && (
                            <div className={styles.finding}>
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
                  {inspection && (
                    <div className={styles.inline}>
                      <button
                        disabled={blocked || !dirty}
                        onClick={() =>
                          run(
                            () =>
                              saveStoreInspection(
                                audit.id,
                                audit.version,
                                answers,
                                summary,
                              ),
                            { answers, summary },
                          )
                        }
                      >
                        Save draft
                      </button>
                      <button
                        disabled={blocked}
                        className={styles.primary}
                        onClick={() => {
                          if (
                            confirm(
                              "Complete this audit and release its report and findings to the store?",
                            )
                          )
                            run(
                              () =>
                                saveStoreInspection(
                                  audit.id,
                                  audit.version,
                                  answers,
                                  summary,
                                  true,
                                ),
                              { answers, summary },
                            );
                        }}
                      >
                        Complete & release to store
                      </button>
                    </div>
                  )}
                </div>
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
        </div>
        <p className={styles.muted}>
          The store will not see the schedule or receive advance email. Only the
          assigned auditor can complete the inspection.
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
        </div>
        <span className={styles.muted}>
          {visible.length} audits · All times IST
        </span>
      </div>
      {!visible.length ? (
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
                      <small>{statusLabels[a.status]}</small>
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
                <th>Scheduled</th>
                <th>Auditor</th>
                <th>Status</th>
                <th>Open actions</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((a) => (
                <tr key={a.id}>
                  <td>
                    <b>{a.store_name}</b>
                    <small>{a.number}</small>
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
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
