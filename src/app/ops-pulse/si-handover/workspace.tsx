"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import {
  CLOCK_OUT_MODES,
  LINE_ITEMS_MAX,
  canAccept,
  canDeleteDraft,
  canFill,
  currentShift,
  emptyAnswer,
  emptyLine,
  escalationLevel,
  progress,
  statusLabels,
  taskUnlocked,
  tasks,
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
  deleteDraftChecklist,
  rejectHandover,
  saveAnswers,
  startShift,
  submitHandover,
} from "./actions";
import { ProofPanel } from "./si-handover-proof";
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

function TaskCard({
  task,
  answer,
  setAnswer,
  checklist,
  proofs,
  setProofs,
  editable,
  shiftStartMs,
  view,
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
  view: WorkspaceView;
  onError: (m: string) => void;
}) {
  const lock = taskUnlocked(task, shiftStartMs, Date.now(), view);
  const disabled = !editable || !lock.unlocked;
  const outcomes =
    task.answerType === "yes_no_na"
      ? (["yes", "no", "na"] as const)
      : task.answerType === "yes_no"
        ? (["yes", "no"] as const)
        : null;

  return (
    <article
      className={`${styles.task}${lock.overdue ? ` ${styles.overdue}` : ""}${!lock.unlocked ? ` ${styles.locked}` : ""}`}
    >
      <div className={styles.taskTop}>
        <div className={styles.taskTitle}>
          <strong>
            {task.id}. {task.label}
          </strong>
          <span>
            {task.when.replaceAll("_", " ")}
            {!lock.unlocked ? " · later" : ""}
            {lock.overdue ? " · overdue" : ""}
          </span>
        </div>
        {outcomes ? (
          <div className={styles.outcomeRow} role="group" aria-label="Answer">
            {outcomes.map((value) => (
              <button
                key={value}
                type="button"
                disabled={disabled}
                className={answer.outcome === value ? styles.outcomeOn : styles.outcome}
                onClick={() => setAnswer({ ...answer, outcome: value })}
              >
                {value === "na" ? "N/A" : value === "yes" ? "Yes" : "No"}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {task.guidance ? <small className={styles.taskHint}>{task.guidance}</small> : null}
      {task.answerType === "text" ? (
        <textarea
          disabled={disabled}
          value={answer.text}
          placeholder="Each issue + owner"
          onChange={(e) => setAnswer({ ...answer, text: e.target.value })}
        />
      ) : (
        <div className={styles.taskBody}>
          <div className={styles.taskMain}>
            {task.answerType === "line_items" ? (
              <div className={styles.lineItems}>
                {(() => {
                  const lines = answer.lines?.length
                    ? answer.lines
                    : [emptyLine(task.numberFields)];
                  const setLines = (next: Array<Record<string, string>>) =>
                    setAnswer({
                      ...answer,
                      outcome: next.some((row) =>
                        Object.values(row).some((v) => String(v ?? "").trim()),
                      )
                        ? answer.outcome || "yes"
                        : "",
                      lines: next,
                    });
                  const filled = lines.filter((row) =>
                    Object.values(row).some((v) => String(v ?? "").trim()),
                  ).length;
                  return (
                    <>
                      <div className={styles.lineMeta}>
                        <span>
                          {filled} vehicle{filled === 1 ? "" : "s"} entered
                          {filled
                            ? ` · ${lines.filter((r) => String(r.checked_in || "").trim()).length} in · ${lines.filter((r) => String(r.checked_out || "").trim()).length} out`
                            : ""}
                        </span>
                        {!disabled && lines.length < LINE_ITEMS_MAX ? (
                          <button
                            type="button"
                            className={styles.lineAdd}
                            onClick={() =>
                              setLines([...lines, emptyLine(task.numberFields)])
                            }
                          >
                            + Add vehicle
                          </button>
                        ) : null}
                      </div>
                      {lines.map((line, index) => (
                        <div key={index} className={styles.lineRow}>
                          <span className={styles.lineIndex}>#{index + 1}</span>
                          <div className={styles.fields}>
                            {task.numberFields.map((f) => (
                              <label key={f.key} className={styles.field}>
                                {f.label}
                                {f.options?.length ? (
                                  <select
                                    disabled={disabled}
                                    value={line[f.key] || ""}
                                    onChange={(e) => {
                                      const next = [...lines];
                                      next[index] = {
                                        ...emptyLine(task.numberFields),
                                        ...next[index],
                                        [f.key]: e.target.value,
                                      };
                                      setLines(next);
                                    }}
                                  >
                                    <option value="">Select</option>
                                    {f.options.map((opt) => (
                                      <option key={opt} value={opt}>
                                        {opt}
                                      </option>
                                    ))}
                                  </select>
                                ) : (
                                  <input
                                    disabled={disabled}
                                    value={line[f.key] || ""}
                                    placeholder={f.placeholder || f.label}
                                    onChange={(e) => {
                                      const next = [...lines];
                                      next[index] = {
                                        ...emptyLine(task.numberFields),
                                        ...next[index],
                                        [f.key]: e.target.value,
                                      };
                                      setLines(next);
                                    }}
                                  />
                                )}
                              </label>
                            ))}
                          </div>
                          {!disabled && lines.length > 1 ? (
                            <button
                              type="button"
                              className={styles.lineRemove}
                              onClick={() => {
                                const next = [...lines];
                                next.splice(index, 1);
                                setLines(next);
                              }}
                            >
                              Remove
                            </button>
                          ) : null}
                        </div>
                      ))}
                      {!disabled && lines.length < LINE_ITEMS_MAX ? (
                        <button
                          type="button"
                          className={styles.lineAddWide}
                          onClick={() =>
                            setLines([...lines, emptyLine(task.numberFields)])
                          }
                        >
                          + Add another vehicle
                        </button>
                      ) : null}
                    </>
                  );
                })()}
              </div>
            ) : task.numberFields.length ? (
              <div className={styles.fields}>
                {task.numberFields.map((f) => (
                  <label key={f.key} className={styles.field}>
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
              <div className={styles.fieldsWide}>
                <label className={styles.field}>
                  Reason
                  <input
                    disabled={disabled}
                    value={answer.text}
                    onChange={(e) => setAnswer({ ...answer, text: e.target.value })}
                  />
                </label>
                {answer.outcome === "no" ? (
                  <label className={styles.field}>
                    Informed
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
          </div>
          <ProofPanel
            checklist={checklist}
            task={task}
            proofs={proofs}
            editable={!disabled}
            onChange={setProofs}
            onError={onError}
          />
        </div>
      )}
      {task.answerType === "text" ? (
        <ProofPanel
          checklist={checklist}
          task={task}
          proofs={proofs}
          editable={!disabled}
          onChange={setProofs}
          onError={onError}
        />
      ) : null}
    </article>
  );
}

export function SiHandoverWorkspace(props: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState(props.error || "");
  const [savedNote, setSavedNote] = useState("");
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
    CLOCK_OUT_MODES.find((m) => m.value === props.settings.clockOutMode)
      ?.label || props.settings.clockOutMode;

  const focused = props.focused;
  const store = props.stores.find(
    (s) => s.id === (focused?.location_id || locationId),
  );
  const editable = Boolean(
    focused && canFill(props.actor, props.settings, focused),
  );
  const deletable = Boolean(
    focused && canDeleteDraft(props.actor, props.settings, focused),
  );
  const acceptable = Boolean(
    focused && canAccept(props.actor, props.settings, focused),
  );
  const viewTasks = useMemo(
    () => (focused ? tasksForView(props.view, focused.template) : []),
    [focused, props.view],
  );
  const sections = useMemo(() => {
    if (!focused) return [];
    const ids = new Set(viewTasks.map((t) => t.id));
    return focused.template.sections
      .map((s) => ({
        ...s,
        tasks: s.tasks.filter((t) => ids.has(t.id)),
      }))
      .filter((s) => s.tasks.length);
  }, [focused, viewTasks]);
  const liveProgress = useMemo(() => {
    if (!focused) return null;
    return progress(
      { template: focused.template, answers },
      { city: store?.city, settings: props.settings },
    );
  }, [answers, focused, props.settings, store?.city]);
  const esc =
    focused?.status === "submitted"
      ? escalationLevel(focused.submitted_at, props.settings)
      : "none";
  const shiftStartMs = focused
    ? Date.parse(`${focused.shift_date}T${focused.shift_slot}:00+05:30`)
    : cur.startMs;
  const emptyTemplate = Boolean(focused && !tasks(focused.template).length);
  const mineRows = props.rows.filter(
    (r) => r.outgoing_user_id === props.actor.userId,
  );
  const otherRows = props.rows.filter(
    (r) =>
      r.outgoing_user_id !== props.actor.userId &&
      ["open", "rejected", "submitted"].includes(r.status),
  );

  const run = (
    work: () => Promise<{
      ok: boolean;
      error?: string;
      id?: string;
      nextId?: string | null;
      version?: number;
    }>,
    opts?: { stay?: boolean; saved?: string },
  ) => {
    setMessage("");
    setSavedNote("");
    startTransition(async () => {
      const r = await work();
      if (!r.ok) {
        setMessage(r.error || "Request failed.");
        return;
      }
      if (r.version) setVersion(r.version);
      if (opts?.saved) setSavedNote(opts.saved);
      if (opts?.stay) {
        router.refresh();
        return;
      }
      if (r.id) router.push(`/si-handover?view=${props.view}&id=${r.id}`);
      else if (r.nextId)
        router.push(`/si-handover?view=start&id=${r.nextId}`);
      else router.push(`/si-handover?view=${props.view}`);
    });
  };

  const titles: Record<WorkspaceView, string> = {
    start: "Start activities",
    during: "During shift",
    handover: "Handover",
    accept: "Accept handover",
  };

  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <p className={styles.eyebrow}>Dark Store · Activities & Handover</p>
        <h1>{titles[props.view]}</h1>
        <p>
          Compact shift checklist — live camera proofs where required, screenshots for
          dashboards. Clock-out: <strong>{modeLabel}</strong>
          {props.canMaster ? (
            <>
              {" "}
              · <Link href="/master/si-handover">Master</Link>
            </>
          ) : null}
          .
        </p>
      </header>

      <nav className={styles.tabBar} aria-label="Activity stages">
        {(
          [
            ["start", "Start"],
            ["during", "During"],
            ["handover", "Handover"],
            ["accept", "Accept"],
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

      {message ? <p className={styles.error}>{message}</p> : null}
      {savedNote ? <p className={styles.banner}>{savedNote}</p> : null}

      {props.view !== "accept" && !focused ? (
        <section className={styles.panel}>
          <div className={styles.startGrid}>
            <label className={styles.field}>
              Store
              <select
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
              >
                {!props.stores.length ? (
                  <option value="">No stores in scope</option>
                ) : null}
                {props.stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.station_code} · {s.station_name || s.station_code}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className={styles.btnAccent}
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
              Start {cur.shiftSlot}
            </button>
          </div>
          <p className={styles.meta}>
            <span className={styles.chipOk}>
              {cur.shiftDate} {cur.shiftSlot} IST
            </span>
            <span className={styles.chip}>
              {props.stores.length} store{props.stores.length === 1 ? "" : "s"}
            </span>
          </p>

          {mineRows.length ? (
            <>
              <h2 className={styles.sectionTitle}>Your open shifts</h2>
              <div className={styles.list}>
                {mineRows
                  .filter((r) =>
                    ["open", "rejected", "submitted"].includes(r.status),
                  )
                  .map((r) => (
                    <Link
                      key={r.id}
                      prefetch={false}
                      className={`${styles.card} ${styles.cardMine}`}
                      href={`/si-handover?view=${props.view}&id=${r.id}`}
                    >
                      <strong>
                        {r.store_code} · {r.shift_date} {r.shift_slot}
                      </strong>
                      <small>{statusLabels[r.status]} · continue</small>
                    </Link>
                  ))}
              </div>
            </>
          ) : (
            <div className={styles.empty}>
              No open shift yet — pick a store and start the current window.
            </div>
          )}

          {otherRows.length ? (
            <>
              <h2 className={styles.sectionTitle}>Other stores</h2>
              <div className={styles.list}>
                {otherRows.slice(0, 12).map((r) => (
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
            </>
          ) : null}
        </section>
      ) : null}

      {props.view === "accept" && !focused ? (
        <section className={styles.panel}>
          <p className={styles.banner}>
            Accept a submitted handover to open your next shift with carried issues.
          </p>
          <div className={styles.list}>
            {props.rows.filter((r) => r.status === "submitted").length === 0 ? (
              <div className={styles.empty}>No handovers waiting.</div>
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
                        From {r.outgoing_name} · {stamp(r.submitted_at)}
                        {level !== "none" ? ` · escalate ${level}` : ""}
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
            <span className={styles.chipOk}>
              {focused.store_code} · {focused.shift_date} {focused.shift_slot}
            </span>
            <span className={styles.chip}>{statusLabels[focused.status]}</span>
            <span className={styles.chip}>Out · {focused.outgoing_name}</span>
            {focused.incoming_name ? (
              <span className={styles.chip}>In · {focused.incoming_name}</span>
            ) : null}
          </div>

          {liveProgress ? (
            <div className={styles.progressWrap}>
              <div className={styles.progressTrack}>
                <div
                  className={styles.progressFill}
                  style={{ width: `${liveProgress.pct}%` }}
                />
              </div>
              <div className={styles.progressLabel}>
                {liveProgress.answered}/{liveProgress.total} mandatory ({liveProgress.pct}%)
              </div>
            </div>
          ) : null}

          {emptyTemplate ? (
            <div className={styles.warn}>
              Task list missing — start the shift again, or open Master once to refresh the catalogue.
            </div>
          ) : null}

          {!editable && props.view !== "accept" ? (
            <div className={styles.readOnly}>
              {focused.outgoing_user_id === props.actor.userId
                ? "Locked (submitted or closed)."
                : `Read-only · ${focused.outgoing_name}. Start your own store to edit.`}
            </div>
          ) : null}

          {focused.open_issues ? (
            <div className={styles.notice}>
              <strong>Carried issues</strong>
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
              Escalation:{" "}
              <strong>{esc === "store" ? "Store Manager" : "City / Cluster"}</strong>
            </div>
          ) : null}

          <div className={styles.section}>
            {sections.map((section) => (
              <div key={section.id} className={styles.section}>
                <h2 className={styles.sectionTitle}>{section.name}</h2>
                {section.tasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    answer={answers[task.id] || emptyAnswer()}
                    setAnswer={(a) =>
                      setAnswers((prev) => ({ ...prev, [task.id]: a }))
                    }
                    checklist={focused}
                    proofs={proofs}
                    setProofs={setProofs}
                    editable={editable && props.view !== "accept"}
                    shiftStartMs={shiftStartMs}
                    view={props.view}
                    onError={setMessage}
                  />
                ))}
              </div>
            ))}
            {!sections.length && !emptyTemplate ? (
              <div className={styles.empty}>
                No tasks for this stage — try During or Handover.
              </div>
            ) : null}
          </div>

          {(editable || acceptable || deletable) && (
            <div className={styles.stickyBar}>
              {editable && props.view !== "accept" ? (
                <>
                  <button
                    type="button"
                    className={styles.btnGhost}
                    disabled={pending}
                    onClick={() =>
                      run(
                        () =>
                          saveAnswers({
                            checklistId: focused.id,
                            version,
                            answers,
                          }),
                        { stay: true, saved: "Draft saved." },
                      )
                    }
                  >
                    Save
                  </button>
                  {props.view === "handover" ? (
                    <button
                      type="button"
                      className={styles.btnAccent}
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
                  ) : (
                    <Link
                      prefetch={false}
                      className={styles.btn}
                      href={`/si-handover?view=handover&id=${focused.id}`}
                    >
                      Handover →
                    </Link>
                  )}
                </>
              ) : null}
              {deletable ? (
                <button
                  type="button"
                  className={styles.btnDanger}
                  disabled={pending}
                  onClick={() => {
                    if (!confirm("Delete this unsubmitted draft?")) return;
                    run(() =>
                      deleteDraftChecklist({
                        checklistId: focused.id,
                        version,
                      }),
                    );
                  }}
                >
                  Delete
                </button>
              ) : null}
              {acceptable ? (
                <>
                  <button
                    type="button"
                    className={styles.btnAccent}
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
                    Accept
                  </button>
                  <div className={styles.rejectRow}>
                    <input
                      placeholder="Reject reason"
                      value={rejectReason}
                      onChange={(e) => setRejectReason(e.target.value)}
                    />
                    <input
                      placeholder="Task IDs"
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
                  </div>
                </>
              ) : null}
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}
