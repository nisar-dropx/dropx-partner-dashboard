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
  collectSubmitGaps,
  currentShift,
  disposalDone,
  emptyAnswer,
  emptyLine,
  escalationLevel,
  isManager,
  isSi,
  isTaskMandatory,
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
import { enrichChecklistRows } from "@/lib/ops-pulse/si-handover/report";
import {
  acceptHandover,
  deleteDraftChecklist,
  rejectHandover,
  saveAnswers,
  startShift,
  submitHandover,
} from "./actions";
import { OpsConfirmDialog } from "@/components/ops-confirm-dialog";
import { ActivitiesHub } from "./activities-hub";
import { ProofPanel } from "./si-handover-proof";
import { ShiftList } from "./shift-list";
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
  showStoreOps?: boolean;
};

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
  storeLabel,
  showRequired,
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
  storeLabel?: string | null;
  showRequired?: boolean;
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
            {showRequired ? (
              <>
                {" "}
                <span className={styles.requiredTag}>Required</span>
              </>
            ) : null}
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
            storeLabel={storeLabel}
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
          storeLabel={storeLabel}
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
  const [deleteStep, setDeleteStep] = useState<null | "warn" | "confirm">(
    null,
  );
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
  const canCoverShift = isSi(props.actor, props.settings);
  const manager = isManager(props.actor, props.settings);
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
  const storeLabel = store
    ? `${store.station_code}${store.station_name ? ` · ${store.station_name}` : ""}`
    : focused?.store_code || null;
  const disposalDoneNow = disposalDone(answers);
  const submitGaps = useMemo(() => {
    if (!focused || props.view !== "handover" || !editable) return [];
    return collectSubmitGaps(focused, answers, proofs, {
      city: store?.city,
      settings: props.settings,
    });
  }, [
    answers,
    editable,
    focused,
    proofs,
    props.settings,
    props.view,
    store?.city,
  ]);
  const esc =
    focused?.status === "submitted"
      ? escalationLevel(focused.submitted_at, props.settings)
      : "none";
  const shiftStartMs = focused
    ? Date.parse(`${focused.shift_date}T${focused.shift_slot}:00+05:30`)
    : cur.startMs;
  const emptyTemplate = Boolean(focused && !tasks(focused.template).length);
  const progressRows = useMemo(
    () => enrichChecklistRows(props.rows, props.stores, props.settings),
    [props.rows, props.stores, props.settings],
  );
  const mineRows = progressRows.filter(
    (r) =>
      r.outgoing_user_id === props.actor.userId &&
      ["open", "rejected", "submitted"].includes(r.status),
  );
  const otherRows = progressRows.filter(
    (r) =>
      r.outgoing_user_id !== props.actor.userId &&
      ["open", "rejected", "submitted"].includes(r.status),
  );
  const acceptRows = progressRows.filter((r) => r.status === "submitted");

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
        <p className={styles.eyebrow}>Dark Store · Shift operations</p>
        <h1>{titles[props.view]}</h1>
        <p>
          Work through the shift stages below. Proofs use the live camera where
          required. Clock-out mode: <strong>{modeLabel}</strong>
          {props.canMaster ? (
            <>
              {" "}
              · <Link href="/master/si-handover">Master</Link>
            </>
          ) : null}
          .
        </p>
      </header>

      <ActivitiesHub
        active="shift"
        showStore={Boolean(props.showStoreOps)}
        showReport={manager}
      />

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
          <div className={styles.startDock}>
            <div className={styles.startGrid}>
              <label className={styles.field}>
                Store to work
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
                disabled={pending || !locationId || !canCoverShift}
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
                Start {cur.shiftSlot} shift
              </button>
            </div>
            <p className={styles.meta}>
              <span className={styles.chipOk}>
                Current window · {cur.shiftDate} {cur.shiftSlot} IST
              </span>
              <span className={styles.chip}>
                {props.stores.length} store{props.stores.length === 1 ? "" : "s"} in
                scope
              </span>
            </p>
            {canCoverShift && manager ? (
              <p className={styles.banner}>
                You can cover an absent SI at any store in your city — start here,
                then accept the next handover when ready.
              </p>
            ) : null}
          </div>

          {mineRows.length ? (
            <ShiftList
              title="Your shifts"
              rows={mineRows}
              view={props.view}
              highlightMine
              pageSize={10}
            />
          ) : (
            <div className={styles.empty}>
              No open shift of yours yet — choose a store above and start this
              window.
            </div>
          )}

          {otherRows.length ? (
            <ShiftList
              title="Team activity"
              rows={otherRows}
              view={props.view}
              pageSize={12}
            />
          ) : null}
        </section>
      ) : null}

      {props.view === "accept" && !focused ? (
        <section className={styles.panel}>
          <p className={styles.banner}>
            Accept a submitted handover to open your next shift with carried issues.
          </p>
          <ShiftList
            title="Awaiting acceptance"
            rows={acceptRows}
            view="accept"
            empty="No handovers waiting."
            pageSize={15}
          />
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
                    storeLabel={storeLabel}
                    showRequired={isTaskMandatory(task, {
                      city: store?.city,
                      disposalDone: disposalDoneNow,
                      settings: props.settings,
                    })}
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

          {editable && props.view === "handover" && submitGaps.length ? (
            <div className={styles.submitGaps} role="status">
              <strong>
                {submitGaps.length} item{submitGaps.length === 1 ? "" : "s"} still
                needed before submit
              </strong>
              <ul>
                {submitGaps.slice(0, 8).map((g) => (
                  <li key={g}>{g}</li>
                ))}
                {submitGaps.length > 8 ? (
                  <li>+{submitGaps.length - 8} more…</li>
                ) : null}
              </ul>
            </div>
          ) : null}

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
                      onClick={() => {
                        if (submitGaps.length) {
                          setMessage(
                            `Still needed: ${submitGaps.slice(0, 3).join(" · ")}${
                              submitGaps.length > 3
                                ? ` (+${submitGaps.length - 3} more)`
                                : ""
                            }`,
                          );
                          return;
                        }
                        run(() =>
                          submitHandover({
                            checklistId: focused.id,
                            version,
                            answers,
                          }),
                        );
                      }}
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
                  onClick={() => setDeleteStep("warn")}
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
      <OpsConfirmDialog
        open={Boolean(focused && deleteStep === "warn")}
        title="Delete this draft checklist?"
        description={
          <p>
            This removes the unsubmitted shift checklist for{" "}
            <b>{focused?.store_name || "this store"}</b>. Saved answers and
            photos on the draft will leave the register.
          </p>
        }
        confirmLabel="Continue"
        cancelLabel="Keep draft"
        danger
        onCancel={() => setDeleteStep(null)}
        onConfirm={() => setDeleteStep("confirm")}
      />
      <OpsConfirmDialog
        open={Boolean(focused && deleteStep === "confirm")}
        title="Confirm deletion"
        description={
          <p>
            Only the person who created this draft, a programme manager, or a
            company owner can delete it. This cannot be undone from the list.
          </p>
        }
        confirmLabel="Yes, delete draft"
        cancelLabel="Back"
        secondaryLabel="Cancel"
        danger
        busy={pending}
        onCancel={() => setDeleteStep("warn")}
        onSecondary={() => setDeleteStep(null)}
        onConfirm={() => {
          if (!focused || pending) return;
          // Keep the confirm step open while pending; navigate away on success.
          run(() =>
            deleteDraftChecklist({
              checklistId: focused.id,
              version,
            }),
          );
        }}
      />
    </div>
  );
}
