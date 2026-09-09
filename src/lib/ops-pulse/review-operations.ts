import type { StationEddSummary } from "./station-edd";
import type { OpsStationManpowerPerson } from "./station-manpower";

export type ReviewEddCounts = Pick<StationEddSummary, "todayTotal" | "todayAtStation" | "todayOnRoad" | "todayDelivered" | "todayHfr" | "todayAttempted" | "todayUnverified" | "todayOther" | "missingDate" | "hasSnapshot">;
export type ReviewEddPoint = { observedAt: string; sourceAt: string | null; backlogAt: string | null; performanceAt: string | null; counts: ReviewEddCounts };
export type ReviewEddTimeline = ReturnType<typeof buildReviewEddTimeline>;
const minute = 60_000;
const stamp = (value: string | null) => value ? Date.parse(value) : NaN;
export function reviewClock(value: string | null) {
  return value && Number.isFinite(stamp(value)) ? new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }).format(new Date(value)) : "—";
}
export function reviewEddSourceFresh(point: ReviewEddPoint, day: string) {
  const start = stamp(`${day}T00:00:00+05:30`), at = stamp(point.observedAt);
  // Both stock and outcomes must be available. A recent lookup of one TID is
  // not evidence that the whole station's source is fresh.
  return point.counts.hasSnapshot && [point.backlogAt, point.performanceAt].every(value => {
    const time = stamp(value);
    return time >= start && time <= at && at - time <= 90 * minute;
  });
}
export function buildReviewEddTimeline(day: string, input: ReviewEddPoint[], now = new Date()) {
  const start = stamp(`${day}T06:00:00+05:30`), end = stamp(`${day}T23:59:59.999+05:30`);
  const until = Math.min(now.getTime(), end);
  const points = input.filter(p => stamp(p.observedAt) >= start && stamp(p.observedAt) <= until)
    .sort((a, b) => stamp(a.observedAt) - stamp(b.observedAt));
  const latest = points.at(-1) ?? null;
  // Never label the first afternoon sample as the 06:00 day-start baseline.
  const baseline = points.find(p => stamp(p.observedAt) < start + 10 * minute && reviewEddSourceFresh(p, day)) ?? null;
  const dayStart = baseline ? baseline.counts.todayTotal - baseline.counts.todayHfr : null;
  const validClear = (p: ReviewEddPoint) => reviewEddSourceFresh(p, day) && p.counts.todayTotal > p.counts.todayHfr
    && p.counts.todayAtStation === 0 && p.counts.todayUnverified === 0 && p.counts.missingDate === 0 && p.counts.todayOther === 0;
  const current = latest && until - stamp(latest.observedAt) <= 10 * minute;
  let clearedAt: string | null = null;
  if (latest && current && validClear(latest)) {
    clearedAt = latest.observedAt;
    // A later arrival/pending TID, uncertainty or capture gap resets clearance.
    for (let i = points.length - 2; i >= 0; i--) {
      if (!validClear(points[i]) || stamp(points[i + 1].observedAt) - stamp(points[i].observedAt) > 10 * minute) break;
      clearedAt = points[i].observedAt;
    }
  }
  const summary = !latest ? "History not recorded" : !latest.counts.hasSnapshot ? "Source unavailable" : latest.counts.todayAtStation > 0
    ? `Not cleared · ${latest.counts.todayAtStation.toLocaleString("en-IN")} pending`
    : clearedAt ? `Cleared by ${reviewClock(clearedAt)}`
    : latest.counts.todayUnverified > 0 ? `Not confirmed · ${latest.counts.todayUnverified.toLocaleString("en-IN")} unchecked`
    : "Clearance not confirmed";
  const rows = Array.from({ length: 37 }, (_, index) => {
    const target = index === 36 ? end : start + index * 30 * minute;
    const future = target > now.getTime();
    // Scheduled jobs can start seconds late. Show the actual observation time;
    // do not carry a morning count forward across an unrecorded interval.
    const cutoff = Math.min(target + (index === 36 ? 0 : 5 * minute), until);
    const point = future ? null : points.filter(p => stamp(p.observedAt) <= cutoff && stamp(p.observedAt) >= target - 5 * minute).at(-1) ?? null;
    return { label: index === 36 ? "EOD" : new Date(target + 330 * minute).toISOString().slice(11, 16),
      dayStart, point, state: future ? "Upcoming" : !point ? "Not recorded" : !reviewEddSourceFresh(point, day) ? "Source stale" : "Recorded" };
  });
  return { day, summary, clearedAt, dayStart, baselineAt: baseline?.observedAt ?? null, latest, current: Boolean(current), rows };
}

export type UtrDisciplineRow = { id: string; name: string; code: string; role: string; shift: string | null; inTime: string | null; outTime: string | null; workMinutes: number | null; status: string; lateMinutes: number; locationNote: string | null };
export function buildUtrDiscipline(people: OpsStationManpowerPerson[]) {
  let scheduled = 0, onTime = 0, late = 0, notReported = 0, noShift = 0, excluded = 0;
  const rows: UtrDisciplineRow[] = [...new Map(people.map(p => [`${p.workerType}:${p.id}`, p])).values()].map(person => {
    const p = person.today;
    const exempt = person.availability === "On leave" || Boolean(p.rosterDayType && p.rosterDayType !== "working");
    const hasShift = p.rosterDayType === "working" && Boolean(p.shiftStartTime && p.shiftEndTime);
    let status: string;
    if (exempt) { excluded++; status = person.availability === "On leave" ? "On leave" : "Roster off"; }
    else if (!hasShift) { noShift++; status = "Shift not linked"; }
    else {
      scheduled++;
      if (!p.reported || !p.inTime) { notReported++; status = "Not reported"; }
      else if (p.lateMinutes > 0) { late++; status = `${p.lateMinutes} min late`; }
      else { onTime++; status = "On time"; }
    }
    return { id: `${person.workerType}:${person.id}`, name: person.name, code: person.code, role: person.designation,
      shift: p.shiftName, inTime: p.inTime, outTime: p.outTime,
      workMinutes: p.inTime && p.outTime && p.workMinutesRecorded !== false && p.workMinutes >= 0 ? p.workMinutes : null,
      status, lateMinutes: p.lateMinutes,
      locationNote: p.hasLocationMismatch ? `Punch location differs: ${p.inLocation?.code ?? "unknown"} → ${p.outLocation?.code ?? "unknown"}` : null };
  }).sort((a, b) => a.name.localeCompare(b.name));
  return { scheduled, onTime, late, notReported, noShift, excluded, rows };
}
export type UtrDiscipline = ReturnType<typeof buildUtrDiscipline>;
