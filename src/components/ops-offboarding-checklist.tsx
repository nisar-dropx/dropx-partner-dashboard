"use client";
import { useMemo, useState, useTransition } from "react";
import { actOnOffboardingTaskApproval } from "@/app/ops-pulse/attendance/offboarding/actions";
import type { OffboardingApprovalGate, OffboardingCase, OffboardingChecklistWorkspace, OffboardingTask } from "@/lib/ops-pulse/offboarding-checklist-data";
import styles from "./ops-offboarding-checklist.module.css";
import { ListPager, usePaged } from "./list-pager";

const DONE = new Set(["completed", "waived"]);
const label = (v: string) => v.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const dateLabel = (value: string | null) =>
  value ? new Date(`${value}T12:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "Not set";
const todayIst = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
const daysTo = (date: string | null) => (date ? Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${todayIst()}T00:00:00Z`)) / 86400000) : null);
const tone = (status: string) =>
  ["approved", "completed"].includes(status) ? styles.good : ["rejected", "blocked"].includes(status) ? styles.bad : ["skipped", "waived"].includes(status) ? styles.muted : styles.warn;

function Gate({ gate, onActed }: { gate: OffboardingApprovalGate; onActed: () => void }) {
  const [note, setNote] = useState("");
  const [busy, start] = useTransition();
  const [error, setError] = useState("");
  function act(decision: "approved" | "rejected" | "skipped") {
    if (decision === "approved" && !note.trim()) return setError("Add a proof note before approving.");
    if (decision !== "approved" && note.trim().length < 5) return setError("Add a reason (at least 5 characters).");
    const form = new FormData();
    form.set("approvalId", gate.approvalId);
    form.set("decision", decision);
    form.set("proofNote", note.trim());
    setError("");
    start(async () => {
      const result = await actOnOffboardingTaskApproval(form);
      if (!result.ok) return setError(result.message);
      onActed();
    });
  }
  return (
    <li className={`${styles.gate} ${gate.viewerCanAct ? styles.gateMine : ""}`}>
      <span className={`${styles.dot} ${tone(gate.status)}`} aria-hidden />
      <div className={styles.gateBody}>
        <div className={styles.gateHead}>
          <b>{gate.levelName}</b>
          <span className={`${styles.pill} ${tone(gate.status)}`}>{gate.viewerCanAct ? "Your approval" : label(gate.status)}</span>
        </div>
        {gate.status !== "pending" ? (
          <small>{gate.proofNote ? `“${gate.proofNote}”` : "No note"}{gate.actedAt ? ` · ${new Date(gate.actedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}` : ""}</small>
        ) : !gate.unlockedByPriorLevels ? (
          <small>Waits for the earlier step.</small>
        ) : !gate.viewerCanAct ? (
          <small>Waiting for {gate.levelName}.</small>
        ) : (
          <div className={styles.act}>
            <input value={note} onChange={(e) => setNote(e.target.value)} disabled={busy} maxLength={500} placeholder="Proof note — what was checked or handed over" aria-label={`Proof note for ${gate.levelName}`} />
            <div className={styles.actButtons}>
              <button className={styles.primary} disabled={busy} onClick={() => act("approved")}>{busy ? "Saving…" : "Approve"}</button>
              <button className={styles.secondary} disabled={busy} onClick={() => act("rejected")}>Reject</button>
              <button className={styles.ghost} disabled={busy} onClick={() => act("skipped")}>Skip</button>
            </div>
            {error ? <p className={styles.error} role="alert">{error}</p> : null}
          </div>
        )}
      </div>
    </li>
  );
}

function Task({ task, onActed }: { task: OffboardingTask; onActed: () => void }) {
  const mine = task.approvals.some((g) => g.viewerCanAct);
  return (
    <details className={styles.task} open={mine}>
      <summary>
        <span className={`${styles.check} ${DONE.has(task.status) ? styles.checkDone : ""}`} aria-hidden>{DONE.has(task.status) ? "✓" : ""}</span>
        <span className={styles.taskTitle}>
          <b>{task.name}</b>
          <small>{label(task.ownerRole)}{task.dueDate ? ` · due ${dateLabel(task.dueDate)}` : ""}{task.isRequired ? " · required" : ""}</small>
        </span>
        {mine ? <span className={`${styles.pill} ${styles.mine}`}>Needs you</span> : <span className={`${styles.pill} ${tone(task.status)}`}>{label(task.status)}</span>}
      </summary>
      <div className={styles.taskBody}>
        {task.instructions ? <p>{task.instructions}</p> : null}
        {task.mandatoryProof ? <p className={styles.proof}>Proof needed: {task.mandatoryProof}</p> : null}
        {task.approvals.length ? <ol className={styles.gates}>{task.approvals.map((g) => <Gate key={g.approvalId} gate={g} onActed={onActed} />)}</ol> : <small className={styles.mutedText}>No approval steps on this task.</small>}
      </div>
    </details>
  );
}

function CaseCard({ c, onActed, defaultOpen }: { c: OffboardingCase; onActed: () => void; defaultOpen: boolean }) {
  const done = c.tasks.filter((t) => DONE.has(t.status)).length;
  const pct = c.tasks.length ? Math.round((done / c.tasks.length) * 100) : 0;
  const lwd = c.approvedLastWorkingDate || c.requestedLastWorkingDate;
  const left = daysTo(lwd);
  const groups = useMemo(() => {
    const m = new Map<string, OffboardingTask[]>();
    for (const t of c.tasks) m.set(t.category, [...(m.get(t.category) ?? []), t]);
    return [...m];
  }, [c.tasks]);
  return (
    <details className={styles.case} open={defaultOpen}>
      <summary className={styles.caseHead}>
        <span className={styles.avatar} aria-hidden>{c.displayName.slice(0, 1)}</span>
        <span className={styles.who}>
          <b>{c.displayName}</b>
          <small>{[c.designationName, c.stationCode, c.relation === "direct" ? "Direct report" : "Your station", c.caseNumber].filter(Boolean).join(" · ")}</small>
        </span>
        <span className={styles.lwd}>
          <small>Last working day</small>
          <b>{dateLabel(lwd)}</b>
          {left != null ? <em className={left < 0 ? styles.bad : left <= 7 ? styles.warn : styles.muted}>{left < 0 ? `${-left} days ago` : left === 0 ? "Today" : `in ${left} days`}</em> : null}
        </span>
        <span className={styles.progressWrap}>
          <span className={styles.progress}><i style={{ width: `${pct}%` }} /></span>
          <small>{done}/{c.tasks.length} tasks</small>
        </span>
        {c.actionable ? <span className={`${styles.pill} ${styles.mine}`}>{c.actionable} for you</span> : <span className={`${styles.pill} ${tone(c.status)}`}>{label(c.status)}</span>}
      </summary>
      <div className={styles.caseBody}>
        {groups.length ? groups.map(([category, tasks]) => (
          <section key={category} className={styles.group}>
            <h3>{label(category)}</h3>
            {tasks.map((t) => <Task key={t.taskId} task={t} onActed={onActed} />)}
          </section>
        )) : <p className={styles.mutedText}>HR has not generated the checklist for this exit yet.</p>}
      </div>
    </details>
  );
}

const FILTERS = [["all", "All"], ["mine", "Needs you"], ["soon", "Leaving in 7 days"], ["direct", "Direct reports"]] as const;

export function OpsOffboardingChecklist({ initial }: { initial: OffboardingChecklistWorkspace }) {
  const [data, setData] = useState(initial);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>(initial.cases.some((c) => c.actionable) ? "mine" : "all");
  const [query, setQuery] = useState("");
  const [station, setStation] = useState("");
  async function refresh() {
    setRefreshing(true);
    setError("");
    try {
      const response = await fetch("/api/ops-pulse/offboarding-checklist", { cache: "no-store" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Offboarding could not be refreshed.");
      setData(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Offboarding could not be refreshed.");
    } finally {
      setRefreshing(false);
    }
  }
  const soon = (c: OffboardingCase) => { const d = daysTo(c.approvedLastWorkingDate || c.requestedLastWorkingDate); return d != null && d <= 7; };
  const counts = { all: data.cases.length, mine: data.cases.filter((c) => c.actionable).length, soon: data.cases.filter(soon).length, direct: data.cases.filter((c) => c.relation === "direct").length };
  const q = query.trim().toLowerCase();
  const stationCodes = useMemo(() => [...new Set(data.cases.map((c) => c.stationCode).filter(Boolean) as string[])].sort(), [data.cases]);
  const shown = data.cases.filter((c) =>
    (filter === "all" || (filter === "mine" ? c.actionable > 0 : filter === "soon" ? soon(c) : c.relation === "direct")) &&
    (!station || c.stationCode === station) &&
    (!q || [c.displayName, c.caseNumber, c.stationCode, c.designationName].join(" ").toLowerCase().includes(q)));
  const paged = usePaged(shown, 25, `${filter}|${station}|${q}`);
  const openTasks = data.cases.reduce((n, c) => n + c.tasks.filter((t) => !DONE.has(t.status)).length, 0);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>Team Ops · Offboarding</span>
          <h1>Offboarding checklist</h1>
          <p>Everyone leaving from {data.scopeLabel.toLowerCase()}: the HR clearance checklist, who must sign each step, and the steps waiting for you.</p>
        </div>
        <button className={styles.secondary} disabled={refreshing} onClick={refresh}>{refreshing ? "Refreshing…" : "Refresh"}</button>
      </header>
      <div className={styles.kpis}>
        <div><span>Open exits</span><strong>{counts.all}</strong></div>
        <div className={counts.mine ? styles.kpiAlert : undefined}><span>Waiting for you</span><strong>{data.cases.reduce((n, c) => n + c.actionable, 0)}</strong><small>{counts.mine} people</small></div>
        <div><span>Leaving in 7 days</span><strong>{counts.soon}</strong></div>
        <div><span>Open checklist tasks</span><strong>{openTasks}</strong></div>
      </div>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      <div className={styles.toolbar}>
        <div className={styles.chips} role="tablist">
          {FILTERS.map(([k, v]) => (
            <button key={k} role="tab" aria-selected={filter === k} className={filter === k ? styles.chipOn : styles.chip} onClick={() => setFilter(k)}>{v}<em>{counts[k]}</em></button>
          ))}
        </div>
        <div className={styles.searchRow}>
          <select aria-label="Station" value={station} onChange={(e) => setStation(e.target.value)}>
            <option value="">All stations</option>
            {stationCodes.map((code) => <option key={code} value={code}>{code}</option>)}
          </select>
          <input aria-label="Search exits" placeholder="Search name, case or designation" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      </div>
      {shown.length ? (
        <div className={styles.list}>
          {paged.rows.map((c, i) => <CaseCard key={c.caseId} c={c} onActed={refresh} defaultOpen={paged.page === 1 && i === 0 && c.actionable > 0} />)}
          <ListPager page={paged.page} pages={paged.pages} size={paged.size} total={paged.total} onPage={paged.setPage} onSize={paged.setSize} label="exits" />
        </div>
      ) : (
        <div className={styles.empty}>
          <b>{data.cases.length ? "No exits match this view." : "No one is leaving right now."}</b>
          <p>{data.cases.length ? "Try another filter." : `Exits raised in People for ${data.scopeLabel.toLowerCase()} appear here with their clearance checklist.`}</p>
        </div>
      )}
      <p className={styles.footnote}>Checklist steps come from HR&apos;s exit setup in People. Each approval needs a proof note and follows the step order; you can act only on steps you hold.</p>
    </div>
  );
}
