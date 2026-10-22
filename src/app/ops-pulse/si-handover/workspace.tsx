"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { supabase } from "@/lib/supabase";
import {
  CLOCK_OUT_MODES,
  canAccept,
  canFill,
  currentShift,
  emptyAnswer,
  escalationLevel,
  progress,
  statusLabels,
  taskUnlocked,
  tasksForView,
  type Actor,
  type Evidence,
  type Settings,
  type SiChecklist,
  type Task,
  type TaskAnswer,
  type WorkspaceView,
} from "@/lib/ops-pulse/si-handover/model";
import {
  acceptHandover,
  rejectHandover,
  saveAnswers,
  startShift,
  submitHandover,
} from "./actions";
import styles from "./si-handover.module.css";

type Store = {
  id: string;
  station_code: string;
  station_name: string | null;
  city: string | null;
};

type Props = {
  view: WorkspaceView;
  stores: Store[];
  rows: SiChecklist[];
  focused: SiChecklist | null;
  evidence: Evidence[];
  actor: Actor;
  settings: Settings;
  error: string;
  canMaster: boolean;
};

const stamp = (v: string | null | undefined) =>
  v
    ? new Date(v).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        dateStyle: "medium",
        timeStyle: "short",
      }) + " IST"
    : "—";

async function readGps(): Promise<{ latitude: number | null; longitude: number | null }> {
  if (typeof navigator === "undefined" || !navigator.geolocation)
    return { latitude: null, longitude: null };
  try {
    const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 8000,
        maximumAge: 60000,
      }),
    );
    return { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
  } catch {
    return { latitude: null, longitude: null };
  }
}

function ProofPanel({
  checklist,
  task,
  proofs,
  editable,
  onChange,
  onError,
}: {
  checklist: SiChecklist;
  task: Task;
  proofs: Evidence[];
  editable: boolean;
  onChange: (next: Evidence[]) => void;
  onError: (msg: string) => void;
}) {
  const mine = proofs.filter((p) => p.task_id === task.id);
  if (task.proof.kind === "none") return null;
  return (
    <div className={styles.proofs}>
      {mine.map((p) => (
        <span key={p.id} className={styles.proofChip}>
          <a href={`/api/ops-pulse/si-handover/evidence/${p.id}`} target="_blank" rel="noreferrer">
            {p.file_name}
          </a>
          <span className={styles.stamp}>{stamp(p.captured_at)}</span>
          {editable ? (
            <button
              type="button"
              className={styles.btnGhost}
              onClick={async () => {
                const r = await fetch("/api/ops-pulse/si-handover/upload", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    phase: "delete",
                    checklistId: checklist.id,
                    taskId: task.id,
                    id: p.id,
                  }),
                });
                const j = await r.json();
                if (!r.ok) return onError(j.error || "Could not remove proof.");
                onChange(proofs.filter((x) => x.id !== p.id));
              }}
            >
              Remove
            </button>
          ) : null}
        </span>
      ))}
      {editable && mine.length < task.proof.max ? (
        <label className={styles.btnGhost}>
          Upload proof
          <input
            type="file"
            accept="image/*,application/pdf"
            hidden
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              try {
                const gps = await readGps();
                const capturedAt = new Date().toISOString();
                const prep = await fetch("/api/ops-pulse/si-handover/upload", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    phase: "prepare",
                    checklistId: checklist.id,
                    taskId: task.id,
                    fileName: file.name,
                    size: file.size,
                    contentType: file.type || "image/jpeg",
                    capturedAt,
                    latitude: gps.latitude,
                    longitude: gps.longitude,
                  }),
                });
                const prepared = await prep.json();
                if (!prep.ok) throw Error(prepared.error || "Prepare failed.");
                if (!supabase) throw Error("Upload client unavailable.");
                const up = await supabase.storage
                  .from("ops-pulse-documents")
                  .uploadToSignedUrl(prepared.path, prepared.token, file);
                if (up.error) throw Error(up.error.message);
                const done = await fetch("/api/ops-pulse/si-handover/upload", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    phase: "complete",
                    checklistId: checklist.id,
                    taskId: task.id,
                    id: prepared.id,
                  }),
                });
                const body = await done.json();
                if (!done.ok) throw Error(body.error || "Confirm failed.");
                onChange([...proofs, body.proof as Evidence]);
              } catch (err) {
                onError(err instanceof Error ? err.message : "Upload failed.");
              }
            }}
          />
        </label>
      ) : null}
      <span className={styles.stamp}>
        {task.proof.kind === "screenshot" ? "Screenshot OK" : "Photo / file"} · timestamp required
        {task.proof.min ? ` · min ${task.proof.min}` : ""}
      </span>
    </div>
  );
}

function TaskCard({
  task,
  answer,
  setAnswer,
  checklist,
  proofs,
  setProofs,
  editable,
  shiftStartMs,
  onError,
}: {
  task: Task;
  answer: TaskAnswer;
  setAnswer: (a: TaskAnswer) => void;
  checklist: SiChecklist;
  proofs: Evidence[];
  setProofs: (p: Evidence[]) => void;
  editable: boolean;
  shiftStartMs: number;
  onError: (m: string) => void;
}) {
  const lock = taskUnlocked(task, shiftStartMs);
  const disabled = !editable || !lock.unlocked;
  return (
    <article
      className={`${styles.task}${lock.overdue ? ` ${styles.overdue}` : ""}${!lock.unlocked ? ` ${styles.locked}` : ""}`}
    >
      <div className={styles.taskHead}>
        <strong>
          {task.id}. {task.label}
        </strong>
        <span>
          {task.when.replaceAll("_", " ")}
          {!lock.unlocked ? " · unlocks later" : ""}
          {lock.overdue ? " · overdue" : ""}
        </span>
      </div>
      {task.guidance ? <small>{task.guidance}</small> : null}
      {task.answerType === "text" ? (
        <textarea
          disabled={disabled}
          value={answer.text}
          placeholder="Each issue + owner"
          onChange={(e) => setAnswer({ ...answer, text: e.target.value })}
        />
      ) : (
        <>
          {task.answerType !== "number" && task.answerType !== "number_x4" ? (
            <div className={styles.fields}>
              <label>
                Answer
                <select
                  disabled={disabled}
                  value={answer.outcome}
                  onChange={(e) =>
                    setAnswer({
                      ...answer,
                      outcome: e.target.value as TaskAnswer["outcome"],
                    })
                  }
                >
                  <option value="">Select</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                  {task.answerType === "yes_no_na" ? (
                    <option value="na">Not applicable</option>
                  ) : null}
                </select>
              </label>
            </div>
          ) : null}
          {task.numberFields.length ? (
            <div className={styles.fields}>
              {task.numberFields.map((f) => (
                <label key={f.key}>
                  {f.label}
                  <input
                    disabled={disabled}
                    inputMode="decimal"
                    value={answer.numbers[f.key] || ""}
                    onChange={(e) =>
                      setAnswer({
                        ...answer,
                        outcome: answer.outcome || "yes",
                        numbers: { ...answer.numbers, [f.key]: e.target.value },
                      })
                    }
                  />
                </label>
              ))}
            </div>
          ) : null}
          {answer.outcome === "no" || answer.outcome === "na" ? (
            <div className={styles.fields}>
              <label>
                Reason
                <input
                  disabled={disabled}
                  value={answer.text}
                  onChange={(e) => setAnswer({ ...answer, text: e.target.value })}
                />
              </label>
              {answer.outcome === "no" ? (
                <label>
                  Escalated / informed
                  <input
                    disabled={disabled}
                    value={answer.informed}
                    onChange={(e) =>
                      setAnswer({ ...answer, informed: e.target.value })
                    }
                  />
                </label>
              ) : null}
            </div>
          ) : null}
        </>
      )}
      <ProofPanel
        checklist={checklist}
        task={task}
        proofs={proofs}
        editable={!disabled}
        onChange={setProofs}
        onError={onError}
      />
    </article>
  );
}

export function SiHandoverWorkspace(props: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState(props.error || "");
  const [locationId, setLocationId] = useState(
    props.focused?.location_id || props.stores[0]?.id || "",
  );
  const [answers, setAnswers] = useState<Record<string, TaskAnswer>>(
    () => props.focused?.answers || {},
  );
  const [proofs, setProofs] = useState(props.evidence);
  const [version, setVersion] = useState(props.focused?.version || 1);
  const [rejectReason, setRejectReason] = useState("");
  const [rejectTasks, setRejectTasks] = useState("");
  const cur = currentShift(new Date(), props.settings.shiftSlots);
  const modeLabel =
    CLOCK_OUT_MODES.find((m) => m.value === props.settings.clockOutMode)?.label ||
    props.settings.clockOutMode;

  const focused = props.focused;
  const store = props.stores.find((s) => s.id === (focused?.location_id || locationId));
  const editable = Boolean(
    focused && canFill(props.actor, props.settings, focused),
  );
  const acceptable = Boolean(
    focused && canAccept(props.actor, props.settings, focused),
  );
  const viewTasks = useMemo(
    () => (focused ? tasksForView(props.view, focused.template) : []),
    [focused, props.view],
  );
  const prog = focused
    ? progress(focused, { city: store?.city, settings: props.settings })
    : null;
  const esc =
    focused?.status === "submitted"
      ? escalationLevel(focused.submitted_at, props.settings)
      : "none";
  const shiftStartMs = focused
    ? Date.parse(`${focused.shift_date}T${focused.shift_slot}:00+05:30`)
    : cur.startMs;

  const run = (work: () => Promise<{ ok: boolean; error?: string; id?: string; nextId?: string | null; version?: number }>) => {
    setMessage("");
    startTransition(async () => {
      const r = await work();
      if (!r.ok) {
        setMessage(r.error || "Request failed.");
        return;
      }
      if (r.version) setVersion(r.version);
      if (r.id) router.push(`/si-handover?view=${props.view}&id=${r.id}`);
      else if (r.nextId)
        router.push(`/si-handover?view=start&id=${r.nextId}`);
      else router.refresh();
    });
  };

  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>Dark Store · Shift Incharge</p>
          <h1>
            {props.view === "start"
              ? "Start shift"
              : props.view === "during"
                ? "During shift"
                : props.view === "handover"
                  ? "Station handover"
                  : "Acceptance"}
          </h1>
          <p>
            One checklist per store per shift (6 AM / 2 PM / 10 PM). Outgoing SI
            completes and submits; incoming SI reviews and accepts. Clock-out
            policy: <strong>{modeLabel}</strong>
            {props.canMaster ? (
              <>
                {" "}
                · <Link href="/master/si-handover">change in Master</Link>
              </>
            ) : null}
            .
          </p>
        </div>
        <nav className={styles.tabs}>
          {(
            [
              ["start", "Start shift"],
              ["during", "During shift"],
              ["handover", "Handover"],
              ["accept", "Acceptance"],
            ] as const
          ).map(([v, label]) => (
            <Link
              key={v}
              prefetch={false}
              className={props.view === v ? styles.tabActive : styles.tab}
              href={`/si-handover?view=${v}${focused ? `&id=${focused.id}` : ""}`}
            >
              {label}
            </Link>
          ))}
        </nav>
      </header>

      {message ? <p className={styles.error}>{message}</p> : null}

      {props.view !== "accept" && !focused ? (
        <section className={styles.panel}>
          <div className={styles.row}>
            <label>
              Store
              <select
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
              >
                {props.stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.station_code} · {s.station_name || s.station_code}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className={styles.btn}
              disabled={pending || !locationId}
              onClick={() =>
                run(() =>
                  startShift({
                    locationId,
                    shiftDate: cur.shiftDate,
                    shiftSlot: cur.shiftSlot,
                  }),
                )
              }
            >
              Start / open current shift ({cur.shiftSlot})
            </button>
          </div>
          <p className={styles.meta}>
            Current window · {cur.shiftDate} {cur.shiftSlot} IST
          </p>
          <div className={styles.list}>
            {props.rows
              .filter((r) => ["open", "rejected", "submitted"].includes(r.status))
              .slice(0, 12)
              .map((r) => (
                <Link
                  key={r.id}
                  prefetch={false}
                  className={styles.card}
                  href={`/si-handover?view=${props.view}&id=${r.id}`}
                >
                  <strong>
                    {r.store_code} · {r.shift_date} {r.shift_slot}
                  </strong>
                  <small>
                    {statusLabels[r.status]} · {r.outgoing_name}
                  </small>
                </Link>
              ))}
          </div>
        </section>
      ) : null}

      {props.view === "accept" && !focused ? (
        <section className={styles.panel}>
          <p className={styles.banner}>
            Review submitted handovers for your stores. Accept opens your next
            shift checklist with carried open issues.
          </p>
          <div className={styles.list}>
            {props.rows.filter((r) => r.status === "submitted").length === 0 ? (
              <p className={styles.meta}>No handovers waiting for acceptance.</p>
            ) : (
              props.rows
                .filter((r) => r.status === "submitted")
                .map((r) => {
                  const level = escalationLevel(r.submitted_at, props.settings);
                  return (
                    <Link
                      key={r.id}
                      prefetch={false}
                      className={styles.card}
                      href={`/si-handover?view=accept&id=${r.id}`}
                    >
                      <strong>
                        {r.store_code} · {r.shift_date} {r.shift_slot}
                      </strong>
                      <small>
                        From {r.outgoing_name} · submitted {stamp(r.submitted_at)}
                        {level !== "none" ? ` · escalate to ${level}` : ""}
                      </small>
                    </Link>
                  );
                })
            )}
          </div>
        </section>
      ) : null}

      {focused ? (
        <section className={styles.panel}>
          <div className={styles.meta}>
            <span>
              {focused.store_code} · {focused.shift_date} {focused.shift_slot}
            </span>
            <span>{statusLabels[focused.status]}</span>
            <span>Outgoing · {focused.outgoing_name}</span>
            {focused.incoming_name ? (
              <span>Incoming · {focused.incoming_name}</span>
            ) : null}
            {prog ? (
              <span className={styles.progress}>
                {prog.answered}/{prog.total} mandatory ({prog.pct}%)
              </span>
            ) : null}
          </div>
          {focused.open_issues ? (
            <div className={styles.notice}>
              <strong>Open issues from prior / this shift</strong>
              <div>{focused.open_issues}</div>
            </div>
          ) : null}
          {focused.status === "rejected" && focused.rejection ? (
            <div className={styles.warn}>
              Returned by {focused.rejection.byName}: {focused.rejection.reason}
              {focused.rejection.taskIds.length
                ? ` · ${focused.rejection.taskIds.join(", ")}`
                : ""}
            </div>
          ) : null}
          {esc !== "none" ? (
            <div className={styles.warn}>
              Not accepted within escalation window — alert level:{" "}
              <strong>{esc === "store" ? "Store Manager" : "Cluster Manager"}</strong>
            </div>
          ) : null}

          <div className={styles.section}>
            {viewTasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                answer={answers[task.id] || emptyAnswer()}
                setAnswer={(a) => setAnswers((prev) => ({ ...prev, [task.id]: a }))}
                checklist={focused}
                proofs={proofs}
                setProofs={setProofs}
                editable={editable && props.view !== "accept"}
                shiftStartMs={shiftStartMs}
                onError={setMessage}
              />
            ))}
          </div>

          <div className={styles.actions}>
            {editable && props.view !== "accept" ? (
              <>
                <button
                  type="button"
                  className={styles.btnGhost}
                  disabled={pending}
                  onClick={() =>
                    run(async () => {
                      const r = await saveAnswers({
                        checklistId: focused.id,
                        version,
                        answers,
                      });
                      return r;
                    })
                  }
                >
                  Save draft
                </button>
                {props.view === "handover" ? (
                  <button
                    type="button"
                    className={styles.btn}
                    disabled={pending}
                    onClick={() =>
                      run(() =>
                        submitHandover({
                          checklistId: focused.id,
                          version,
                          answers,
                        }),
                      )
                    }
                  >
                    Submit handover
                  </button>
                ) : null}
              </>
            ) : null}
            {acceptable ? (
              <>
                <button
                  type="button"
                  className={styles.btn}
                  disabled={pending}
                  onClick={() =>
                    run(() =>
                      acceptHandover({
                        checklistId: focused.id,
                        version,
                      }),
                    )
                  }
                >
                  Accept shift
                </button>
                <input
                  placeholder="Reject reason"
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                />
                <input
                  placeholder="Task IDs (optional, comma)"
                  value={rejectTasks}
                  onChange={(e) => setRejectTasks(e.target.value)}
                />
                <button
                  type="button"
                  className={styles.btnDanger}
                  disabled={pending || !rejectReason.trim()}
                  onClick={() =>
                    run(() =>
                      rejectHandover({
                        checklistId: focused.id,
                        version,
                        reason: rejectReason,
                        taskIds: rejectTasks
                          .split(",")
                          .map((x) => x.trim())
                          .filter(Boolean),
                      }),
                    )
                  }
                >
                  Reject
                </button>
              </>
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}
