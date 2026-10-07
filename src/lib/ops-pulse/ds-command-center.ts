import type { OpsStationManpowerPerson } from './station-manpower';

export function summarizeStorePeople(people: OpsStationManpowerPerson[], now: number) {
  const summary = { active: people.length, reported: 0, working: 0, completed: 0, due: 0, dueReported: 0, notReported: 0, upcoming: 0, off: 0, leave: 0, unplanned: 0, missingOut: 0 };
  for (const p of people) {
    const t = p.today;
    if (t.reported) summary.reported++;
    if (p.availability === 'Working') summary.working++;
    if (p.availability === 'Completed') summary.completed++;
    if (t.approvedLeave || p.availability === 'On leave') { summary.leave++; continue; }
    if (p.availability === 'Roster off') { summary.off++; continue; }
    const start = t.shiftStartsAt ? Date.parse(t.shiftStartsAt) : NaN;
    if (!Number.isFinite(start)) { summary.unplanned++; continue; }
    if (start > now) { summary.upcoming++; continue; }
    summary.due++;
    if (t.reported) summary.dueReported++; else summary.notReported++;
    // An open punch during the shift is normal, not a missing punch-out.
    if (t.reported && t.missingPunch && t.shiftEndsAt && Date.parse(t.shiftEndsAt) < now) summary.missingOut++;
  }
  return summary;
}

export type DsUnitRecord = { station_code: string; month: string; through_date: string; units: number | string };
export function summarizeStoreUnits(record: DsUnitRecord | undefined, through: string) {
  if (!record) return { units: null, through: null, upd: null, status: 'missing' as const };
  const units = Number(record.units), days = Number(record.through_date.slice(8));
  if (!Number.isFinite(units) || units < 0 || days < 1) return { units: null, through: null, upd: null, status: 'missing' as const };
  return { units, through: record.through_date, upd: units / days, status: record.through_date < through ? 'behind' as const : 'current' as const };
}
