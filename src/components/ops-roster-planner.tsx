"use client";

import { useMemo, useState, useTransition } from "react";
import { CalendarDays, Check, PencilLine, Search, Send, UsersRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { prepareOpsRoster, saveOpsRosterAssignments, submitOpsRoster } from "@/app/ops-pulse/rostering/actions";
import type { OpsRosterEntry, OpsRosterPerson, OpsRosterPlan, OpsRosterShift } from "@/lib/ops-pulse/rostering";
import styles from "./ops-roster-planner.module.css";

type Assignment = {
  dayType: "working" | "weekly_off";
  shiftId: string | null;
  notes: string | null;
};

function addDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function personKey(person: Pick<OpsRosterPerson, "workerType" | "id">) {
  return `${person.workerType}:${person.id}`;
}

function cellKey(person: Pick<OpsRosterPerson, "workerType" | "id">, date: string) {
  return `${personKey(person)}:${date}`;
}

function dayLabel(value: string) {
  return new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "2-digit", month: "short", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
}

function compactTime(value: string) {
  return String(value ?? "").slice(0, 5);
}

function initialAssignments(entries: OpsRosterEntry[]) {
  return new Map(entries.map((entry) => [
    `${entry.workerType}:${entry.workerId}:${entry.rosterDate}`,
    { dayType: entry.dayType, shiftId: entry.shiftId, notes: entry.notes } satisfies Assignment
  ]));
}

export function OpsRosterPlanner({
  stationId,
  stationCode,
  plan,
  blankPeriodStart,
  people,
  shifts,
  canStart,
  editable,
  approvalSummary,
  routeReady
}: {
  stationId: string;
  stationCode: string;
  plan: OpsRosterPlan | null;
  blankPeriodStart: string;
  people: OpsRosterPerson[];
  shifts: OpsRosterShift[];
  canStart: boolean;
  editable: boolean;
  approvalSummary: string;
  routeReady: boolean;
}) {
  const router = useRouter();
  const [assignments, setAssignments] = useState(() => initialAssignments(plan?.entries ?? []));
  const [dirtyKeys, setDirtyKeys] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [workerType, setWorkerType] = useState("all");
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();
  const periodStart = plan?.periodStart ?? blankPeriodStart;
  const dates = useMemo(() => Array.from({ length: 7 }, (_, index) => addDays(periodStart, index)), [periodStart]);
  const shiftById = useMemo(() => new Map(shifts.map((shift) => [shift.id, shift])), [shifts]);
  const visiblePeople = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return people.filter((person) => (workerType === "all" || person.workerType === workerType)
      && (!needle || `${person.name} ${person.code} ${person.designation}`.toLowerCase().includes(needle)));
  }, [people, query, workerType]);
  const assignedCount = people.reduce((count, person) => count + dates.filter((date) => assignments.has(cellKey(person, date))).length, 0);
  const expectedCount = people.length * 7;
  const complete = expectedCount > 0 && assignedCount === expectedCount;

  function beginEditing() {
    startTransition(async () => {
      const result = await prepareOpsRoster(stationId);
      setMessage({ tone: result.ok ? "success" : "error", text: result.message });
      if (result.ok) {
        router.replace(`/rostering?station=${encodeURIComponent(stationCode)}`);
        router.refresh();
      }
    });
  }

  function updateCell(person: OpsRosterPerson, date: string, value: string) {
    const key = cellKey(person, date);
    setAssignments((current) => {
      const next = new Map(current);
      if (!value) next.delete(key);
      else if (value === "weekly_off") next.set(key, { dayType: "weekly_off", shiftId: null, notes: null });
      else next.set(key, { dayType: "working", shiftId: value, notes: null });
      return next;
    });
    setDirtyKeys((current) => new Set(current).add(key));
    setMessage(null);
  }

  function save() {
    if (!plan || !dirtyKeys.size) return;
    const changes = [...dirtyKeys].map((key) => {
      const [workerTypeValue, workerId, date] = key.split(":");
      const assignment = assignments.get(key);
      return assignment
        ? { workerType: workerTypeValue as "employee" | "contractor", workerId, date, dayType: assignment.dayType, shiftId: assignment.shiftId, notes: assignment.notes }
        : { workerType: workerTypeValue as "employee" | "contractor", workerId, date, remove: true as const };
    });
    startTransition(async () => {
      const result = await saveOpsRosterAssignments({ planId: plan.id, changes });
      setMessage({ tone: result.ok ? "success" : "error", text: result.message });
      if (result.ok) {
        setDirtyKeys(new Set());
        router.refresh();
      }
    });
  }

  function submit() {
    if (!plan) return;
    startTransition(async () => {
      const result = await submitOpsRoster(plan.id);
      setMessage({ tone: result.ok ? "success" : "error", text: result.message });
      if (result.ok) router.refresh();
    });
  }

  return <section className={styles.workspace}>
    <header className={styles.hero}>
      <div>
        <span>{plan?.status === "approved" ? "Current approved roster" : plan ? "Roster change in progress" : "No roster configured"}</span>
        <h2>{stationCode} · Monday to Sunday</h2>
        <p>{plan ? `Effective ${dayLabel(plan.effectiveFrom ?? plan.periodStart)} · version ${plan.revisionNo}` : "Start editing to prepare the station’s first recurring roster."}</p>
      </div>
      <div className={styles.heroActions}>
        {canStart ? <button className="button primary compact" type="button" onClick={beginEditing} disabled={isPending}><PencilLine size={14} /> {plan ? "Edit roster" : "Start roster"}</button> : null}
        <div className={styles.stats}>
          <span><UsersRound size={15} /><strong>{people.length}</strong><small>people</small></span>
          <span><CalendarDays size={15} /><strong>{assignedCount}</strong><small>assigned</small></span>
          <em className={`${styles.status} ${styles[String(plan?.status ?? "blank").replaceAll("_", "")] ?? ""}`}>{plan?.status?.replaceAll("_", " ") ?? "blank"}</em>
        </div>
      </div>
    </header>

    <div className={styles.toolbar}>
      <label><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search person, ID or designation" /></label>
      <select aria-label="Workforce type" value={workerType} onChange={(event) => setWorkerType(event.target.value)}>
        <option value="all">Employees & contractors</option>
        <option value="employee">Employees</option>
        <option value="contractor">Independent contractors</option>
      </select>
      {editable ? <span className={styles.editHint}>Change only the required cells, then save.</span> : <span className={styles.editHint}>View only</span>}
    </div>

    {message ? <div className={`message-panel ${message.tone === "error" ? "error" : "success"}`} role="status">{message.text}</div> : null}
    <div className={styles.tableWrap}>
      <table className={styles.rosterTable}>
        <thead><tr><th>Person</th>{dates.map((date) => <th key={date}>{dayLabel(date)}</th>)}</tr></thead>
        <tbody>
          {visiblePeople.map((person) => <tr key={personKey(person)}>
            <th><strong>{person.name}</strong><small>{person.code} · {person.designation}</small></th>
            {dates.map((date) => {
              const assignment = assignments.get(cellKey(person, date));
              const shift = assignment?.shiftId ? shiftById.get(assignment.shiftId) : null;
              const value = assignment?.dayType === "weekly_off" ? "weekly_off" : assignment?.shiftId ?? "";
              return <td key={date} className={dirtyKeys.has(cellKey(person, date)) ? styles.dirty : ""}>
                {editable ? <select aria-label={`${person.name}, ${dayLabel(date)}`} value={value} onChange={(event) => updateCell(person, date, event.target.value)} style={shift ? { borderLeftColor: shift.color } : undefined}>
                  <option value="">Unassigned</option>
                  {shifts.map((option) => <option key={option.id} value={option.id}>{option.code} · {compactTime(option.startTime)}–{compactTime(option.endTime)}</option>)}
                  <option value="weekly_off">Week Off</option>
                </select> : <span className={`${styles.assignment} ${assignment?.dayType === "weekly_off" ? styles.weekOff : !assignment ? styles.unassigned : ""}`} style={shift ? { borderLeftColor: shift.color } : undefined}>
                  <strong>{assignment?.dayType === "weekly_off" ? "Week Off" : shift?.code ?? "Open"}</strong>
                  <small>{shift ? `${compactTime(shift.startTime)}–${compactTime(shift.endTime)}` : assignment?.dayType === "weekly_off" ? "Rest day" : "Not assigned"}</small>
                </span>}
              </td>;
            })}
          </tr>)}
          {!visiblePeople.length ? <tr><td colSpan={8} className={styles.empty}>No active people match this view.</td></tr> : null}
        </tbody>
      </table>
    </div>

    <footer className={styles.footer}>
      <span><Check size={14} /><strong>{assignedCount}/{expectedCount}</strong> roster cells complete</span>
      {editable && plan ? <div>
        <button type="button" className="button secondary compact" onClick={save} disabled={!dirtyKeys.size || isPending}>{isPending ? "Saving…" : `Save${dirtyKeys.size ? ` ${dirtyKeys.size}` : ""} changes`}</button>
        <button type="button" className="button primary compact" onClick={submit} disabled={Boolean(dirtyKeys.size || !complete || !routeReady || isPending)}><Send size={14} /> Send for approval</button>
      </div> : null}
    </footer>
    {editable && plan ? <div className={styles.approvalLine}><strong>{routeReady ? (complete ? "Ready to submit" : `${expectedCount - assignedCount} cells still open`) : "Approval setup required"}</strong><span>{dirtyKeys.size ? "Save pending changes before submission." : approvalSummary}</span></div> : null}
  </section>;
}
