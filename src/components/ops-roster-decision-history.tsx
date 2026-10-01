"use client";

import { useMemo, useState } from "react";
import { ChevronDown, History } from "lucide-react";
import type { OpsRosterDecision, OpsRosterPerson, OpsRosterShift } from "@/lib/ops-pulse/rostering";
import { rosterWeek } from "@/lib/ops-pulse/roster-interactions";
import styles from "./ops-roster-planner.module.css";

function personKey(workerType: string, workerId: string) {
  return `${workerType}:${workerId}`;
}

function dayLabel(date: string) {
  return new Intl.DateTimeFormat("en-IN", { weekday: "short", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
}

function dateLabel(date: string) {
  return new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
}

function statusLabel(status: string) {
  if (status === "approved") return "Approved";
  if (status === "returned") return "Returned";
  if (status === "rejected") return "Rejected";
  return status.replaceAll("_", " ");
}

export function OpsRosterDecisionHistory({
  weekStart,
  decisions,
  people,
  shifts
}: {
  weekStart: string;
  decisions: OpsRosterDecision[];
  people: OpsRosterPerson[];
  shifts: OpsRosterShift[];
}) {
  const [open, setOpen] = useState(false);
  const week = useMemo(() => rosterWeek(weekStart), [weekStart]);
  const weekEnd = week[week.length - 1] ?? weekStart;
  const personByKey = useMemo(() => new Map(people.map((person) => [personKey(person.workerType, person.id), person])), [people]);
  const shiftById = useMemo(() => new Map(shifts.map((shift) => [shift.id, shift])), [shifts]);
  const visible = useMemo(() => decisions
    .filter((decision) => decision.periodStart <= weekEnd && decision.periodEnd >= weekStart)
    .sort((left, right) => String(right.decidedAt ?? right.periodStart).localeCompare(String(left.decidedAt ?? left.periodStart))),
  [decisions, weekEnd, weekStart]);

  return <section className={styles.history} aria-label="Roster decision history">
    <button type="button" className={styles.historyToggle} aria-expanded={open} onClick={() => setOpen((current) => !current)}>
      <History size={15} />
      <span><strong>Roster history</strong><small>{dateLabel(weekStart)} to {dateLabel(weekEnd)} · approved, returned and rejected</small></span>
      <ChevronDown size={16} className={open ? styles.historyChevronOpen : undefined} />
    </button>
    {open ? <div className={styles.historyBody}>
      {visible.length ? visible.map((decision) => {
        const dates = week.filter((date) => date >= decision.periodStart && date <= decision.periodEnd);
        const rows = new Map<string, { name: string; code: string; cells: Map<string, string> }>();
        for (const entry of decision.entries) {
          if (!dates.includes(entry.rosterDate)) continue;
          const key = personKey(entry.workerType, entry.workerId);
          const person = personByKey.get(key);
          const row = rows.get(key) ?? { name: person?.name ?? "Team member", code: person?.code ?? "", cells: new Map<string, string>() };
          const shift = entry.shiftId ? shiftById.get(entry.shiftId) : null;
          row.cells.set(entry.rosterDate, entry.dayType === "weekly_off" ? "Week off" : shift?.code ?? "Working");
          rows.set(key, row);
        }
        const peopleRows = [...rows.values()].sort((left, right) => left.name.localeCompare(right.name));
        return <article key={decision.id} className={styles.historyCard}>
          <header>
            <em className={styles.historyStatus} data-status={decision.status}>{statusLabel(decision.status)}</em>
            <strong>{dateLabel(decision.periodStart)} to {dateLabel(decision.periodEnd)}</strong>
          </header>
          <p>{decision.reason ?? "No reason recorded."}</p>
          {decision.rounds.length ? <ul>{decision.rounds.map((round) => <li key={`${decision.id}:${round.round}`}>Round {round.round}{round.status ? ` · ${statusLabel(round.status)}` : ""}{round.reason ? ` · ${round.reason}` : ""}</li>)}</ul> : null}
          {peopleRows.length ? <div className={styles.historyGridWrap}>
            <table className={styles.historyGrid}>
              <thead><tr><th>Person</th>{dates.map((date) => <th key={date}>{dayLabel(date)}<small>{dateLabel(date)}</small></th>)}</tr></thead>
              <tbody>{peopleRows.map((row) => <tr key={`${decision.id}:${row.code}:${row.name}`}>
                <th><strong>{row.name}</strong>{row.code ? <small>{row.code}</small> : null}</th>
                {dates.map((date) => <td key={date}>{row.cells.get(date) ?? "—"}</td>)}
              </tr>)}</tbody>
            </table>
          </div> : <p className={styles.historyEmpty}>This decision has no saved days for this week.</p>}
        </article>;
      }) : <p className={styles.historyEmpty}>No approved, returned or rejected roster for this week.</p>}
    </div> : null}
  </section>;
}
