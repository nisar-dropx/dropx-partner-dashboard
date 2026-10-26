import type { ReviewAttendanceHistory } from "./review-attendance-history";

export function summarizeAssistantAttendance(histories: ReviewAttendanceHistory[], from: string, to: string, filters: { role?: string; person?: string } = {}) {
  const role = filters.role?.trim().toLowerCase(), personQuery = filters.person?.trim().toLowerCase();
  const rows = histories.flatMap(history => history.people.filter(person =>
    (!role || person.role.toLowerCase().includes(role)) && (!personQuery || `${person.name} ${person.code}`.toLowerCase().includes(personQuery))
  ).map(person => {
    const days = person.days.filter(day => day.date >= from && day.date <= to && day.status !== "outside_station");
    const count = (...statuses: string[]) => days.filter(day => statuses.includes(day.status)).length;
    const onTime = count("on_time"), late = count("late"), reported = onTime + late, confirmedAbsent = count("unplanned_absence");
    const unresolved = count("absence_unconfirmed", "attendance_conflict", "leave_pending", "no_shift");
    const assessedDays = reported + confirmedAbsent;
    return { stationCode: history.station, personId: person.id, employeeCode: person.code, name: person.name, role: person.role,
      assessedDays, reported, onTime, late, confirmedAbsent, unresolved,
      approvedLeave: count("leave"), offDays: count("week_off", "holiday"), offDaysWorked: count("week_off_worked", "holiday_worked"),
      openShifts: count("not_reported", "upcoming"),
      attendancePct: assessedDays ? Math.round(reported / assessedDays * 1000) / 10 : null,
      punctualityPct: reported ? Math.round(onTime / reported * 1000) / 10 : null,
      lateMinutes: days.reduce((total, day) => total + (day.status === "late" ? day.lateMinutes ?? 0 : 0), 0),
      evidenceDays: days.length,
      rankingEligible: assessedDays >= 3 && unresolved === 0,
      recentExceptions: days.filter(day => ["late", "unplanned_absence", "absence_unconfirmed", "attendance_conflict"].includes(day.status)).slice(-5).map(day => ({ date: day.date, status: day.status, lateMinutes: day.lateMinutes, note: day.note }))
    };
  }));
  const eligible = rows.filter(row => row.rankingEligible);
  const rank = (key: "attendancePct" | "punctualityPct") => [...eligible].filter(row => row[key] !== null)
    .sort((a,b) => (b[key] ?? -1) - (a[key] ?? -1) || b.assessedDays - a.assessedDays || a.name.localeCompare(b.name)).slice(0,5);
  return { source: "People punches, approved rosters, leave and holiday records", from, to,
    cohort: "Staff assigned at the period end; only their days within each selected store are included.",
    definitions: { attendance: "Reported / (reported + confirmed absent). Approved leave, off days, holidays, open shifts and unresolved records excluded.", punctuality: "On-time / reported working shifts, after approved grace. Missing or ambiguous punches are unresolved, not absence.", ranking: "At least 3 assessed days and no unresolved days. Compare sample sizes; ties are not proof of a better employee." },
    totals: { people: rows.length, assessedDays: rows.reduce((n,r)=>n+r.assessedDays,0), reported: rows.reduce((n,r)=>n+r.reported,0), late: rows.reduce((n,r)=>n+r.late,0), confirmedAbsent: rows.reduce((n,r)=>n+r.confirmedAbsent,0), unresolved: rows.reduce((n,r)=>n+r.unresolved,0) },
    topAttendance: rank("attendancePct"), topPunctuality: rank("punctualityPct"),
    rows, truncated: false };
}
