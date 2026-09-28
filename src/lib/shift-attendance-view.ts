/** Shared presentation contract for People and OpsPulse shift attendance. */
export type ShiftAttendance = {
  availability: string;
  name: string;
  code: string;
  today: {
    reported: boolean; lateMinutes: number; earlyMinutes?: number; missingPunch: boolean;
    workMinutes: number; shiftName: string | null; rosterDayType: string | null;
    inTime: string | null; outTime: string | null;
    workMode?: string | null; wfhState?: string | null; approvedLeave?: boolean;
    shiftStartsAt?: string | null; shiftEndsAt?: string | null;
  };
};
export const shiftFilters = [
  ["all", "All"], ["present", "Punched"], ["late", "Late in"], ["early", "Early out"],
  ["single", "Missing punch"], ["wfh", "WFH"], ["leave", "Approved leave"],
  ["off", "Week off"], ["trip", "Business trip"], ["missing", "Not reported"], ["upcoming", "Upcoming"], ["unassigned", "No roster"]
] as const;
export type ShiftFilter = typeof shiftFilters[number][0];
export function shiftCategory(p: ShiftAttendance, now = Date.now()) {
  const t = p.today;
  if (t.approvedLeave || p.availability === "On leave") return "leave";
  if (t.workMode === "wfh") return "wfh";
  if (t.workMode === "business_trip") return "trip";
  if (t.rosterDayType === "weekly_off") return "off";
  if (!t.shiftName && !t.rosterDayType) return "unassigned";
  if (!t.reported && t.shiftStartsAt && Date.parse(t.shiftStartsAt) > now) return "upcoming";
  if (t.lateMinutes > 0) return "late";
  if (t.reported) return "present";
  return "missing";
}
export function matchesShift(p: ShiftAttendance, filter: string, search = "", now = Date.now()) {
  if (!`${p.name} ${p.code}`.toLowerCase().includes(search.trim().toLowerCase())) return false;
  const category = shiftCategory(p, now), t = p.today;
  const regular = !["leave", "off", "wfh", "trip"].includes(category);
  if (filter === "all") return true;
  if (filter === "off") return t.rosterDayType === "weekly_off";
  if (filter === "leave") return Boolean(t.approvedLeave || p.availability === "On leave");
  if (filter === "wfh") return t.workMode === "wfh";
  if (filter === "present") return t.reported;
  if (filter === "early") return regular && (t.earlyMinutes ?? 0) > 0;
  if (filter === "single") return t.missingPunch && (!t.shiftEndsAt || Date.parse(t.shiftEndsAt) <= now);
  if (filter === "late") return regular && t.lateMinutes > 0;
  return category === filter;
}
export function shiftLabel(p: ShiftAttendance, now = Date.now()) {
  const t = p.today, category = shiftCategory(p, now);
  if (category === "leave") return t.reported ? "Approved leave · punched" : "Approved leave";
  if (category === "off") return t.reported ? "Week off · worked" : "Week off";
  if (category === "wfh") return t.reported ? "WFH · punched" : ({
    upcoming: "WFH · upcoming", in_progress: "WFH · in progress",
    awaiting_finalization: "WFH · credit pending", credited: "WFH · credited"
  }[t.wfhState ?? ""] ?? "WFH");
  if (category === "trip") return t.reported ? "Business trip · punched" : "Business trip";
  if (category === "unassigned") return t.reported ? "No roster · punched" : "No approved roster";
  if (category === "upcoming") return "Upcoming shift";
  if (!t.reported) return "Not reported";
  const labels = [
    t.lateMinutes > 0 ? `Late in ${t.lateMinutes}m` : "",
    (t.earlyMinutes ?? 0) > 0 ? `Early out ${t.earlyMinutes}m` : "",
    t.missingPunch ? matchesShift(p, "single", "", now) ? "Missing OUT" : "OUT pending" : ""
  ].filter(Boolean);
  return labels.join(" · ") || "On time · completed";
}
export function shiftPunchMinute(value: string | null, day: string) {
  if (!value) return null;
  const timestamp = Date.parse(value), start = Date.parse(`${day}T00:00:00+05:30`);
  return Number.isFinite(timestamp) && Number.isFinite(start) ? Math.floor((timestamp - start) / 60000) : null;
}
export function shiftBounds(day: string, start?: string | null, end?: string | null) {
  if (!start || !end) return { shiftStartsAt: null, shiftEndsAt: null };
  const a = Date.parse(`${day}T${start}+05:30`), b = Date.parse(`${day}T${end}+05:30`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return { shiftStartsAt: null, shiftEndsAt: null };
  return { shiftStartsAt: new Date(a).toISOString(), shiftEndsAt: new Date(b <= a ? b + 86400000 : b).toISOString() };
}
