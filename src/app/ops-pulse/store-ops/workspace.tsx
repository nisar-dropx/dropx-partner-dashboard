"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import {
  proofKindHint,
} from "@/lib/ops-pulse/si-handover/model";
import { ProofPanel } from "@/app/ops-pulse/si-handover/si-handover-proof";
import {
  canDeleteDraft,
  canFill,
  collectSubmitGaps,
  disposalDone,
  emptyAnswer,
  isFiller,
  isManager,
  isTaskMandatory,
  progress,
  statusLabels,
  tasks,
  tasksForView,
  todayIst,
  type Actor,
  type Evidence,
  type Settings,
  type StoreOpsChecklist,
  type Task,
  type TaskAnswer,
  type WorkspaceView,
} from "@/lib/ops-pulse/store-ops/model";
import { OpsConfirmDialog } from "@/components/ops-confirm-dialog";
import { ActivitiesHub } from "../si-handover/activities-hub";
import {
  deleteDraft,
  saveAnswers,
  startDay,
  submitDay,
} from "./actions";
import styles from "../si-handover/si-handover.module.css";

type Store = {
  id: string;
  station_code: string;
  station_name: string | null;
  city: string | null;
};

type Props = {
  view: WorkspaceView;
  stores: Store[];
  rows: StoreOpsChecklist[];
  focused: StoreOpsChecklist | null;
  evidence: Evidence[];
  actor: Actor;
  settings: Settings;
  error: string;
  weeklyDoneIds: string[];
  monthlyDoneIds: string[];
  showShiftOps?: boolean;
};

function TaskCard({
  task,
  answer,
  setAnswer,
  checklist,
  proofs,
  setProofs,
  editable,
  alreadyDone,
  onError,
  storeLabel,
  showRequired,
}: {
  task: Task;
  answer: TaskAnswer;
  setAnswer: (a: TaskAnswer) => void;
  checklist: StoreOpsChecklist;
  proofs: Evidence[];
  setProofs: (p: Evidence[]) => void;
  editable: boolean;
  alreadyDone: boolean;
  onError: (m: string) => void;
  storeLabel?: string | null;
  showRequired?: boolean;
}) {
  const disabled = !editable || alreadyDone;
  const outcomes =
    task.answerType === "yes_no_na"
      ? (["yes", "no", "na"] as const)
      : task.answerType === "yes_no"
        ? (["yes", "no"] as const)
        : null;

  return (
    <article
      className={`${styles.task}${alreadyDone ? ` ${styles.locked}` : ""}`}
    >
      <div className={styles.taskTop}>
        <div className={styles.taskTitle}>
          <strong>
            {task.id}. {task.label}
            {showRequired && !alreadyDone ? (
              <>
                {" "}
                <span className={styles.requiredTag}>Required</span>
              </>
            ) : null}
          </strong>
          <span>
            {task.frequency.replaceAll("_", " ")}
            {alreadyDone ? " · done earlier this period" : ""}
            {task.proof.kind !== "none"
              ? ` · ${proofKindHint(task.proof.kind)}`
              : ""}
          </span>
        </div>
        {outcomes && !alreadyDone ? (
          <div className={styles.outcomeRow} role="group" aria-label="Answer">
            {outcomes.map((value) => (
              <button
                key={value}
                type="button"
                disabled={disabled}
                className={
                  answer.outcome === value ? styles.outcomeOn : styles.outcome
                }
                onClick={() => setAnswer({ ...answer, outcome: value })}
              >
                {value === "na" ? "N/A" : value === "yes" ? "Yes" : "No"}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {task.guidance ? (
        <small className={styles.taskHint}>{task.guidance}</small>
      ) : null}
      {alreadyDone ? (
        <small className={styles.taskHint}>
          Completed earlier this {task.frequency === "weekly" ? "week" : "month"} —
          not required again.
        </small>
      ) : task.answerType === "text" ? (
        <textarea
          disabled={disabled}
          value={answer.text}
          placeholder="Top issues, escalations, help needed"
          onChange={(e) => setAnswer({ ...answer, text: e.target.value })}
        />
      ) : (
        <div className={styles.taskBody}>
          <div className={styles.taskMain}>
            {task.numberFields.length ? (
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
                          numbers: {
                            ...answer.numbers,
                            [f.key]: e.target.value,
                          },
                        })
                      }
                    />
                  </label>
                ))}
              </div>
            ) : null}
            {answer.outcome === "no" || answer.outcome === "na" ? (
              <label className={styles.field}>
                Reason
                <input
                  disabled={disabled}
                  value={answer.text}
                  onChange={(e) =>
                    setAnswer({ ...answer, text: e.target.value })
                  }
                />
              </label>
            ) : null}
          </div>
          <ProofPanel
            checklist={checklist}
            task={task}
            proofs={proofs}
            editable={!disabled}
            onChange={setProofs}
            onError={onError}
            apiBase="/api/ops-pulse/store-ops"
            storeLabel={storeLabel}
          />
        </div>
      )}
      {task.answerType === "text" && !alreadyDone ? (
        <ProofPanel
          checklist={checklist}
          task={task}
          proofs={proofs}
          editable={!disabled}
          onChange={setProofs}
          onError={onError}
          apiBase="/api/ops-pulse/store-ops"
          storeLabel={storeLabel}
        />
      ) : null}
    </article>
  );
}

export function StoreOpsWorkspace(props: Props) {
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
  const [deleteStep, setDeleteStep] = useState<null | "warn" | "confirm">(
    null,
  );
  const focused = props.focused;
  const store = props.stores.find((s) => s.id === focused?.location_id);
  const weekly = useMemo(
    () => new Set(props.weeklyDoneIds),
    [props.weeklyDoneIds],
  );
  const monthly = useMemo(
    () => new Set(props.monthlyDoneIds),
    [props.monthlyDoneIds],
  );
  const viewTasks = useMemo(
    () => (focused ? tasksForView(props.view, focused.template) : []),
    [focused, props.view],
  );
  const sections = useMemo(() => {
    if (!focused) return [];
    const ids = new Set(viewTasks.map((t) => t.id));
    return focused.template.sections
      .map((s) => ({ ...s, tasks: s.tasks.filter((t) => ids.has(t.id)) }))
      .filter((s) => s.tasks.length);
  }, [focused, viewTasks]);
  const liveProgress = useMemo(() => {
    if (!focused) return null;
    return progress(
      { template: focused.template, answers },
      {
        city: store?.city,
        settings: props.settings,
        weeklyDoneIds: weekly,
        monthlyDoneIds: monthly,
      },
    );
  }, [answers, focused, monthly, props.settings, store?.city, weekly]);
  const editable = focused
    ? canFill(props.actor, props.settings, focused)
    : false;
  const deletable = focused
    ? canDeleteDraft(props.actor, props.settings, focused)
    : false;
  const storeLabel = store
    ? `${store.station_code}${store.station_name ? ` · ${store.station_name}` : ""}`
    : focused?.store_code || null;
  const disposalDoneNow = disposalDone(answers);
  const submitGaps = useMemo(() => {
    if (!focused || props.view !== "close" || !editable) return [];
    return collectSubmitGaps(focused, answers, proofs, {
      city: store?.city,
      settings: props.settings,
      weeklyDoneIds: weekly,
      monthlyDoneIds: monthly,
    });
  }, [
    answers,
    editable,
    focused,
    monthly,
    proofs,
    props.settings,
    props.view,
    store?.city,
    weekly,
  ]);
  const filler = isFiller(props.actor, props.settings);
  const manager = isManager(props.actor, props.settings);
  const today = todayIst();
  const openRows = props.rows.filter((r) => r.status === "open");
  const recentRows = props.rows.filter((r) => r.status === "submitted").slice(0, 20);

  const run = (
    work: () => Promise<{
      ok: boolean;
      error?: string;
      id?: string;
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
      if (r.id) router.push(`/store-ops?view=${props.view}&id=${r.id}`);
      else router.push(`/store-ops?view=${props.view}`);
    });
  };

  const titles: Record<WorkspaceView, string> = {
    start: "Start of shift",
    midday: "After D-1 reports",
    compliance: "Compliance",
    close: "Day close & submit",
  };

  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <p className={styles.eyebrow}>Dark Store · Store operations</p>
        <h1>{titles[props.view]}</h1>
        <p>
          Daily Store Manager / Store In-charge checklist — one per store per day.
          Submit seals it; there is no accept or reject.
        </p>
      </header>

      <ActivitiesHub
        active="store"
        showShift={Boolean(props.showShiftOps)}
        showReport={manager}
      />

      <nav className={styles.tabBar} aria-label="Store operations stages">
        {(
          [
            ["start", "Start"],
            ["midday", "D-1 reports"],
            ["compliance", "Compliance"],
            ["close", "Close & submit"],
          ] as const
        ).map(([v, label]) => (
          <Link
            key={v}
            prefetch={false}
            className={props.view === v ? styles.tabActive : styles.tab}
            href={`/store-ops?view=${v}${focused ? `&id=${focused.id}` : ""}`}
          >
            {label}
          </Link>
        ))}
      </nav>

      {message ? <p className={styles.error}>{message}</p> : null}
      {savedNote ? <p className={styles.banner}>{savedNote}</p> : null}

      {!focused ? (
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
                disabled={pending || !locationId || !filler}
                onClick={() =>
                  run(() => startDay({ locationId, workDate: today }))
                }
              >
                Start today
              </button>
            </div>
            <p className={styles.meta}>
              <span className={styles.chipOk}>{today} IST · one checklist per store</span>
              <span className={styles.chip}>
                {props.stores.length} store{props.stores.length === 1 ? "" : "s"} in
                scope
              </span>
            </p>
          </div>

          <h2 className={styles.sectionTitle}>Open today</h2>
          <div className={styles.list}>
            {!openRows.length ? (
              <div className={styles.empty}>
                No open day checklist — pick a store and start.
              </div>
            ) : (
              openRows.map((r) => {
                const p = progress(
                  { template: r.template, answers: r.answers },
                  {
                    city: props.stores.find((s) => s.id === r.location_id)?.city,
                    settings: props.settings,
                  },
                );
                return (
                  <Link
                    key={r.id}
                    prefetch={false}
                    className={`${styles.card} ${styles.cardMine}`}
                    href={`/store-ops?view=${props.view}&id=${r.id}`}
                  >
                    <div className={styles.cardTop}>
                      <strong>
                        {r.store_code} · {r.work_date}
                      </strong>
                      <span
                        className={
                          p.pct >= 80
                            ? styles.pctOk
                            : p.pct >= 40
                              ? styles.pctMid
                              : styles.pctLow
                        }
                      >
                        {p.pct}%
                      </span>
                    </div>
                    <small>
                      {statusLabels[r.status]} · {r.owner_name}
                    </small>
                    <div className={styles.cardProgress}>
                      <div
                        className={styles.cardProgressFill}
                        style={{ width: `${p.pct}%` }}
                      />
                    </div>
                  </Link>
                );
              })
            )}
          </div>

          {recentRows.length ? (
            <>
              <h2 className={styles.sectionTitle}>Recently submitted</h2>
              <div className={styles.list}>
                {recentRows.map((r) => (
                  <Link
                    key={r.id}
                    prefetch={false}
                    className={styles.card}
                    href={`/store-ops?view=close&id=${r.id}`}
                  >
                    <strong>
                      {r.store_code} · {r.work_date}
                    </strong>
                    <small>
                      Submitted · {r.owner_name}
                    </small>
                  </Link>
                ))}
              </div>
            </>
          ) : null}
        </section>
      ) : (
        <section className={styles.panel}>
          <div className={styles.meta}>
            <span className={styles.chipOk}>
              {focused.store_code} · {focused.work_date}
            </span>
            <span className={styles.chip}>{statusLabels[focused.status]}</span>
            <span className={styles.chip}>Owner · {focused.owner_name}</span>
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
                {liveProgress.answered}/{liveProgress.total} due ({liveProgress.pct}
                %)
              </div>
            </div>
          ) : null}

          {!tasks(focused.template).length ? (
            <div className={styles.warn}>Task catalogue missing — refresh.</div>
          ) : null}

          {sections.map((section) => (
            <div key={section.id} className={styles.section}>
              <h2 className={styles.sectionTitle}>{section.name}</h2>
              {section.guidance ? (
                <small className={styles.taskHint}>{section.guidance}</small>
              ) : null}
              {section.tasks.map((task) => {
                const alreadyDone =
                  (task.frequency === "weekly" && weekly.has(task.id)) ||
                  (task.frequency === "monthly" && monthly.has(task.id));
                return (
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
                    editable={editable}
                    alreadyDone={alreadyDone}
                    onError={setMessage}
                    storeLabel={storeLabel}
                    showRequired={isTaskMandatory(task, {
                      city: store?.city,
                      disposalDone: disposalDoneNow,
                      settings: props.settings,
                      weeklyDone: weekly.has(task.id),
                      monthlyDone: monthly.has(task.id),
                    })}
                  />
                );
              })}
            </div>
          ))}

          {editable && props.view === "close" && submitGaps.length ? (
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

          <div className={styles.actions}>
            {editable ? (
              <>
                <button
                  type="button"
                  className={styles.btn}
                  disabled={pending}
                  onClick={() =>
                    run(
                      () =>
                        saveAnswers({
                          checklistId: focused.id,
                          version,
                          answers,
                        }),
                      { stay: true, saved: "Saved." },
                    )
                  }
                >
                  Save
                </button>
                {props.view === "close" ? (
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
                        submitDay({
                          checklistId: focused.id,
                          version,
                          answers,
                        }),
                      );
                    }}
                  >
                    Submit day
                  </button>
                ) : (
                  <Link
                    className={styles.btnAccent}
                    href={`/store-ops?view=close&id=${focused.id}`}
                  >
                    Go to submit →
                  </Link>
                )}
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
              </>
            ) : (
              <>
                <p className={styles.banner}>
                  {focused.status === "submitted"
                    ? "Submitted — read only. No accept / reject step."
                    : "This checklist is not editable for your role."}
                </p>
                {deletable ? (
                  <button
                    type="button"
                    className={styles.btnDanger}
                    disabled={pending}
                    onClick={() => setDeleteStep("warn")}
                  >
                    Delete draft
                  </button>
                ) : null}
              </>
            )}
          </div>
        </section>
      )}
      <OpsConfirmDialog
        open={Boolean(focused && deleteStep === "warn")}
        title="Delete this draft checklist?"
        description={
          <p>
            This removes the unsubmitted store-ops day for{" "}
            <b>{focused?.store_code || "this store"}</b>. Saved answers and
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
            Only the owner, a programme manager, or a company owner can delete
            this draft. This cannot be undone from the list.
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
            deleteDraft({
              checklistId: focused.id,
              version,
            }),
          );
        }}
      />
    </div>
  );
}
