export type RosterAssignmentValue = {
  dayType: "working" | "weekly_off";
  shiftId: string | null;
  notes: string | null;
};

export type RosterTool =
  | { kind: "shift"; shiftId: string }
  | { kind: "weekly_off" }
  | { kind: "clear" };

export type RosterDragPayload = {
  tool: RosterTool;
  sourceKey?: string;
};

export type RosterCoverage = {
  working: number;
  weeklyOff: number;
  unassigned: number;
};

function validIsoDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

export function moveIsoDate(value: string, days: number) {
  if (!validIsoDate(value)) throw new Error("A valid roster date is required.");
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Sunday ending the week that contains the last day of `today`'s month (YYYY-MM-DD). */
export function rosterMonthEnd(today: string) {
  if (!validIsoDate(today)) throw new Error("A valid roster date is required.");
  const [year, month] = today.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0));
  // Extend to the Sunday closing the month's final week so that week is always shown in full.
  lastDay.setUTCDate(lastDay.getUTCDate() + ((7 - lastDay.getUTCDay()) % 7));
  return lastDay.toISOString().slice(0, 10);
}

/** Monday on or before the given date. */
export function rosterMondayOnOrBefore(value: string) {
  const weekday = new Date(`${value}T00:00:00Z`).getUTCDay() || 7;
  return moveIsoDate(value, 1 - weekday);
}

/**
 * Latest week Monday that may be opened in the station roster week view.
 * Navigation stays a normal week strip, but cannot leave the current calendar month.
 */
export function rosterMonthMaxWeekStart(today: string) {
  return rosterMondayOnOrBefore(rosterMonthEnd(today));
}

/** Week dates for the planner, dropping any day that falls after the current month. */
export function rosterWeekInCurrentMonth(weekStart: string, today: string) {
  const monthEnd = rosterMonthEnd(today);
  return rosterWeek(weekStart).filter((date) => date <= monthEnd);
}

/** Map a displayed calendar date onto the stored weekday in a recurring template week (display only). */
export function recurringTemplateDate(templateMonday: string, displayedDate: string) {
  if (![templateMonday, displayedDate].every(validIsoDate)) throw new Error("A valid recurring roster date is required.");
  const weekday = new Date(`${displayedDate}T00:00:00Z`).getUTCDay() || 7;
  return moveIsoDate(templateMonday, weekday - 1);
}

/** Next calendar occurrence of a template weekday on or after `onOrAfter` (for 24h change cutoffs). */
export function nextRosterOccurrenceOnOrAfter(date: string, onOrAfter: string) {
  if (![date, onOrAfter].every(validIsoDate)) throw new Error("A valid roster occurrence date is required.");
  let cursor = date;
  while (cursor < onOrAfter) cursor = moveIsoDate(cursor, 7);
  return cursor;
}

export function rosterWeek(start: string) {
  if (!validIsoDate(start)) throw new Error("A valid roster week is required.");
  return Array.from({ length: 7 }, (_, index) => moveIsoDate(start, index));
}

export function rosterCoverage(personKeys: string[], dates: string[], assignments: Map<string, RosterAssignmentValue>) {
  return new Map(dates.map((date) => {
    const coverage: RosterCoverage = { working: 0, weeklyOff: 0, unassigned: 0 };
    for (const personKey of personKeys) {
      const assignment = assignments.get(`${personKey}:${date}`);
      if (!assignment) coverage.unassigned += 1;
      else if (assignment.dayType === "weekly_off") coverage.weeklyOff += 1;
      else coverage.working += 1;
    }
    return [date, coverage] as const;
  }));
}

export function encodeRosterDragPayload(payload: RosterDragPayload) {
  return JSON.stringify(payload);
}

export function decodeRosterDragPayload(raw: string): RosterDragPayload | null {
  if (raw === "weekly_off") return { tool: { kind: "weekly_off" } };
  if (raw === "clear") return { tool: { kind: "clear" } };
  if (raw.startsWith("shift:")) return { tool: { kind: "shift", shiftId: raw.slice(6) } };
  try {
    const parsed = JSON.parse(raw) as Partial<RosterDragPayload> & Partial<RosterAssignmentValue>;
    if (parsed.tool?.kind === "shift" && parsed.tool.shiftId) return { tool: { kind: "shift", shiftId: parsed.tool.shiftId }, sourceKey: parsed.sourceKey };
    if (parsed.tool?.kind === "weekly_off" || parsed.tool?.kind === "clear") return { tool: { kind: parsed.tool.kind }, sourceKey: parsed.sourceKey };
    if (parsed.dayType === "weekly_off") return { tool: { kind: "weekly_off" } };
    if (parsed.shiftId) return { tool: { kind: "shift", shiftId: parsed.shiftId } };
  } catch {
    return null;
  }
  return null;
}

export function rosterAssignmentToDragPayload(value: RosterAssignmentValue, sourceKey: string): RosterDragPayload | null {
  if (value.dayType === "weekly_off") return { tool: { kind: "weekly_off" }, sourceKey };
  if (value.shiftId) return { tool: { kind: "shift", shiftId: value.shiftId }, sourceKey };
  return null;
}

export function applyRosterDrop(current: Map<string, RosterAssignmentValue>, targetKey: string, payload: RosterDragPayload) {
  if (payload.sourceKey === targetKey) return { assignments: current, dirtyKeys: new Set<string>() };
  const assignments = new Map(current);
  const dirtyKeys = new Set<string>([targetKey]);
  if (payload.sourceKey) {
    assignments.delete(payload.sourceKey);
    dirtyKeys.add(payload.sourceKey);
  }
  if (payload.tool.kind === "clear") assignments.delete(targetKey);
  else if (payload.tool.kind === "weekly_off") assignments.set(targetKey, { dayType: "weekly_off", shiftId: null, notes: null });
  else assignments.set(targetKey, { dayType: "working", shiftId: payload.tool.shiftId, notes: null });
  return { assignments, dirtyKeys };
}

/**
 * Ops roster rule: at most one Week Off per person per Monday-Sunday week.
 * Simulates `drops` exactly as applyRosterDrop would, so moving an existing
 * Week Off (its source cell is cleared) or bulk-applying Week Off to several
 * days is judged on the end result, and returns the first person/week that
 * would end up with more than one. Only drops that place a Week Off are
 * checked, so replacing an extra Week Off with a shift is always allowed.
 * Mirrors findWeekOffCapViolation in lib/ops-pulse/rostering.ts, which stays
 * the server-side backstop on save and Excel import.
 */
export function findRosterWeekOffCapBreach(
  current: Map<string, RosterAssignmentValue>,
  drops: Array<{ targetKey: string; payload: RosterDragPayload }>
): { personKey: string; weekStart: string } | null {
  if (!drops.some((drop) => drop.payload.tool.kind === "weekly_off")) return null;
  let next = current;
  for (const drop of drops) next = applyRosterDrop(next, drop.targetKey, drop.payload).assignments;
  const checked = new Set<string>();
  for (const drop of drops) {
    if (drop.payload.tool.kind !== "weekly_off") continue;
    const separator = drop.targetKey.lastIndexOf(":");
    const personKey = drop.targetKey.slice(0, separator);
    const weekStart = rosterMondayOnOrBefore(drop.targetKey.slice(separator + 1));
    const id = `${personKey}|${weekStart}`;
    if (checked.has(id)) continue;
    checked.add(id);
    const weekOffs = rosterWeek(weekStart).filter((date) => next.get(`${personKey}:${date}`)?.dayType === "weekly_off").length;
    if (weekOffs > 1) return { personKey, weekStart };
  }
  return null;
}
